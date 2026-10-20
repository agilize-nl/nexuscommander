// Fase 1b, item 3 (P1b.2) — resolve a destination directory without
// traversing a symlink, as far as Node allows. Node port of
// `engine/path_policy.rs`, deliberately weaker than its Unix half.
//
// # What this adapter can and cannot promise
//
// `engine/path_policy.rs`'s Unix adapter opens each path component from its
// parent's *descriptor* with `O_NOFOLLOW` (`openat`), so once the walk
// begins nothing is ever resolved by name again — a swap after the check
// cannot redirect the write. Node has no `openat` without a native addon, so
// every lookup here is `lstat` **by path**. That is exactly the situation the
// Rust project's own Windows adapter is in, even though this runs on Linux:
// the gap is in the runtime, not the kernel. `platformGuarantee()` returns
// `advisory` unconditionally and `resolveForMutation` refuses outright — never
// silently downgrades — when a caller passes `requireRaceFree: true`.
//
// What this module *does* still provide, and what makes it worth having
// rather than skipping straight to `fs.rename`:
//
//   - component-wise resolution with `..` resolved against the real tree,
//     never rewritten away lexically (`a/link/../b` must mean whatever the
//     *filesystem* says it means, or the checker and the eventual write
//     disagree about what path they touched);
//   - a symlink anywhere in the path is refused by default, with an explicit,
//     depth-bounded opt-in to follow;
//   - a cycle terminates at the depth bound rather than looping until Node's
//     own limits kick in somewhere unpredictable;
//   - the answer is honest about not being race-free, so a caller that needs
//     that property finds out immediately rather than trusting a promise this
//     runtime cannot keep.
//
// What it does *not* close: the gap between this function returning and the
// caller's actual write. `lib/commit.js` closes the *destination-symlink*
// half of that gap on its own — every write here goes through a random
// staging name plus `rename()`, and `rename()` replaces whatever is at the
// target name without following it, so a symlink swapped in at the final
// name is replaced, not written through. What is not closed is a symlink
// swapped into an *intermediate* directory component between this call and
// the write; closing that needs `openat`, and there is no portable way to
// get it from Node.

import fs from 'fs/promises';
import path from 'path';

export const Guarantee = Object.freeze({
    /** Checks are by path and cannot exclude a swap between check and use. */
    Advisory: 'advisory',
    /**
     * Every component opened from its parent's descriptor with `O_NOFOLLOW`.
     * Race-free. Kept here only as a named constant this adapter compares
     * against — `platformGuarantee()` never returns it, because Node cannot
     * provide it without a native addon.
     */
    ComponentwiseNoFollow: 'componentwise_no_follow'
});

/** What this runtime can promise. Always `advisory` — see the module header. */
export function platformGuarantee() {
    return Guarantee.Advisory;
}

export function isRaceFree(guarantee) {
    return guarantee === Guarantee.ComponentwiseNoFollow;
}

export const SymlinkPolicy = Object.freeze({
    /** Refuse the operation if any component is a link. The default. */
    Preserve: 'preserve',
    /** Follow links deliberately, bounded by `maxDepth`. Never a default. */
    Follow: 'follow'
});

export class PathError extends Error {
    constructor(kind, message, details = {}) {
        super(message);
        this.name = 'PathError';
        this.kind = kind;
        Object.assign(this, details);
    }
}

/** null | 'file' | 'dir' | 'symlink'. Never follows — this is the no-follow lookup `Path.exists()`-style checks cannot do. */
async function entryKindAt(fullPath) {
    try {
        const st = await fs.lstat(fullPath);
        if (st.isSymbolicLink()) return 'symlink';
        return st.isDirectory() ? 'dir' : 'file';
    } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
        throw e;
    }
}

/**
 * The kind of the entry named `name` inside `dir`, without following links —
 * the question `fs.existsSync`-style checks cannot answer, since they follow
 * a symlink and report a dangling one as "nothing here". Shared with
 * `lib/commit.js` rather than duplicated: a hard link has no separate kind of
 * its own (both names are the same file, reported as `'file'`), which is the
 * one case worth pinning in a test against a *shared* implementation rather
 * than two that could quietly drift apart.
 *
 * `name` must be a single component — a separator in it would reintroduce
 * exactly the multi-component resolution this module exists to control.
 */
export async function entryKind(dir, name) {
    if (!name || name.length === 0 || name.includes(path.sep)) {
        throw new PathError('invalid_component', `'${name}' is not a single path component`, { path: name });
    }
    return entryKindAt(path.join(dir, name));
}

/** Path components with the root and `.` dropped. `..` is kept — see the module header on why it is never rewritten away lexically. */
function normalizedComponents(absPath) {
    return absPath.split(path.sep).filter((p) => p.length > 0 && p !== '.');
}

const DEFAULT_MAX_COMPONENTS = 256;
const DEFAULT_MAX_DEPTH = 8;

/**
 * Resolve `dirPath` as a directory to mutate inside, component by component.
 *
 * Refuses any component that is a symlink unless `symlinkPolicy` is
 * `SymlinkPolicy.Follow`, in which case following is bounded by `maxDepth` —
 * the same bound that catches a cycle, since a cycle is just a chain that
 * never stops.
 *
 * Returns `{ path, guarantee }`. `guarantee` is always `advisory` here; it is
 * threaded through rather than hardcoded at the call site so a result can be
 * logged or surfaced without every caller re-deriving it.
 */
export async function resolveForMutation(dirPath, options = {}) {
    const {
        symlinkPolicy = SymlinkPolicy.Preserve,
        maxDepth = DEFAULT_MAX_DEPTH,
        maxComponents = DEFAULT_MAX_COMPONENTS,
        requireRaceFree = false
    } = options;

    if (requireRaceFree) {
        // Section 6.1: refuse rather than degrade silently. Unconditional here
        // because this adapter can never provide the stronger guarantee, not
        // just "not right now".
        throw new PathError(
            'guarantee_unavailable',
            'Refused: this operation needs a componentwise_no_follow path guarantee and this platform provides only advisory.',
            { requested: Guarantee.ComponentwiseNoFollow, provided: Guarantee.Advisory }
        );
    }
    if (!path.isAbsolute(dirPath)) {
        throw new PathError('not_absolute', `'${dirPath}' is not an absolute path`, { path: dirPath });
    }

    const originalComponents = normalizedComponents(dirPath);
    if (originalComponents.length > maxComponents) {
        throw new PathError('too_many_components', `'${dirPath}' has more than ${maxComponents} path components.`, {
            path: dirPath,
            limit: maxComponents
        });
    }

    const queue = [...originalComponents];
    let walked = path.parse(dirPath).root || path.sep;
    let linksFollowed = 0;
    // A cycle re-queues components forever without exceeding maxDepth *links*
    // followed per se if depth accounting were wrong; bound total steps too,
    // strictly tighter than maxDepth would allow, as a second, independent
    // guard against ever looping unboundedly.
    let steps = 0;
    const maxSteps = (maxComponents + maxDepth) * 4;

    while (queue.length > 0) {
        steps += 1;
        if (steps > maxSteps || linksFollowed > maxDepth) {
            throw new PathError(
                'too_deep',
                `Refused: resolving '${dirPath}' exceeded the symlink depth limit of ${maxDepth} — the links may form a cycle.`,
                { path: dirPath, maxDepth }
            );
        }

        const name = queue.shift();
        if (name === '..') {
            walked = path.dirname(walked);
            continue;
        }

        const next = path.join(walked, name);
        const kind = await entryKindAt(next);

        if (kind === null) {
            throw new PathError('io', `Could not open '${next}': no such file or directory`, { path: next, code: 'ENOENT' });
        }

        if (kind === 'symlink') {
            if (symlinkPolicy !== SymlinkPolicy.Follow) {
                throw new PathError(
                    'symlink_rejected',
                    `Refused: '${dirPath}' passes through the symlink '${next}'. Following it would write outside the directory you selected.`,
                    { path: dirPath, component: next }
                );
            }
            linksFollowed += 1;
            if (linksFollowed > maxDepth) {
                throw new PathError(
                    'too_deep',
                    `Refused: resolving '${dirPath}' exceeded the symlink depth limit of ${maxDepth} — the links may form a cycle.`,
                    { path: dirPath, maxDepth }
                );
            }
            const linkTarget = await fs.readlink(next);
            if (path.isAbsolute(linkTarget)) {
                queue.unshift(...normalizedComponents(linkTarget));
                walked = path.sep;
            } else {
                queue.unshift(...normalizedComponents(linkTarget));
            }
            continue;
        }

        if (kind === 'file') {
            // Whether this was mid-path or the final component being pinned,
            // this module only ever pins a *directory* — a plain file here
            // means the caller's destination path is wrong, not that it needs
            // a different resolver.
            throw new PathError('not_a_directory', `'${next}' is not a directory`, { path: next });
        }

        walked = next;
    }

    return { path: walked, guarantee: platformGuarantee() };
}
