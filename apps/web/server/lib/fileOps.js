import fs from 'fs/promises';
import path from 'path';

import { copyFileStaged, moveEntryStaged, keepBothName, CommitError, Replace } from './commit.js';

export async function pathExists(p) {
    try {
        await fs.access(p);
        return true;
    } catch {
        return false;
    }
}

/**
 * Recursively flattens a source path (file or directory) into a list of jobs,
 * each with a path relative to the source's own basename - e.g. copying
 * "/a/photos" yields entries like { rel: "photos/2024/a.jpg", ... } so the
 * caller can join `rel` onto a target directory directly. Empty directories
 * are included as their own job (isDir: true) so they get recreated.
 */
export async function collectEntries(rootPath) {
    const results = [];
    const rootName = path.basename(rootPath);

    async function walk(current, rel) {
        const st = await fs.lstat(current);
        if (st.isDirectory()) {
            const children = await fs.readdir(current);
            if (children.length === 0) {
                results.push({ abs: current, rel, isDir: true, size: 0 });
            } else {
                for (const child of children) {
                    await walk(path.join(current, child), `${rel}/${child}`);
                }
            }
        } else {
            results.push({ abs: current, rel, isDir: false, size: st.size });
        }
    }

    await walk(rootPath, rootName);
    return results;
}

/**
 * Streams a single file from src to dest through the staging protocol
 * (`lib/commit.js`), reporting bytes copied via onChunk. Fase 1b P1b.3: this
 * used to be `createWriteStream(dest)`, which truncates the destination the
 * moment it opens — QSF-001 in three lines, since a read error, cancellation,
 * or a crash mid-copy then left neither the old file nor a complete new one.
 * Every caller here reaches the destination only through a staged rename now.
 */
export async function copyOneFile(src, dest, onChunk) {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await copyFileStaged(src, dest, {
        onProgress: onChunk ? async (n) => onChunk(n) : undefined
    });
}

/** Removes now-empty directories under (and including) rootPath, bottom-up. Leaves non-empty ones alone. */
export async function pruneEmptyDirs(rootPath) {
    if (!(await pathExists(rootPath))) return;
    const st = await fs.lstat(rootPath);
    if (!st.isDirectory()) return;
    const children = await fs.readdir(rootPath);
    for (const child of children) {
        await pruneEmptyDirs(path.join(rootPath, child));
    }
    const remaining = await fs.readdir(rootPath);
    if (remaining.length === 0) {
        await fs.rmdir(rootPath).catch(() => {});
    }
}

/**
 * Resolves a same-named conflict at `destPath` per `conflictPolicy`:
 * `'refuse'` (default) leaves it to the caller — the staged commit below
 * throws `destination_exists` and the caller turns that into its own
 * response; `'skip'` returns `null` (nothing to do); `'replace'` proceeds at
 * the same path; `'keep_both'` picks a free name next to it via
 * `keepBothName`. Not a conflict *policy engine* — no per-item round trip —
 * just the one-shot choice these synchronous whole-source helpers need.
 */
async function resolvedDestPath(destPath, conflictPolicy) {
    if (conflictPolicy === 'skip' && (await pathExists(destPath))) return null;
    if (conflictPolicy === 'keep_both' && (await pathExists(destPath))) {
        const freeName = await keepBothName(path.dirname(destPath), path.basename(destPath));
        return path.join(path.dirname(destPath), freeName);
    }
    return destPath;
}

function replaceFor(conflictPolicy) {
    return conflictPolicy === 'replace' || conflictPolicy === 'keep_both' ? Replace.IfFile : Replace.Never;
}

/**
 * Copies a single top-level source (file or directory) into targetDir, one
 * job at a time. `conflictPolicy` — `'refuse'` (default), `'skip'`,
 * `'replace'`, or `'keep_both'` — governs what happens when a destination
 * file already exists; a conflicting *directory* is always merged into,
 * regardless of policy, matching the behavior this replaces.
 */
export async function copySourceSync(src, targetDir, conflictPolicy = 'refuse') {
    const jobs = await collectEntries(src);
    for (const job of jobs) {
        const destPath = path.join(targetDir, job.rel);
        if (job.isDir) {
            await fs.mkdir(destPath, { recursive: true });
            continue;
        }

        const resolved = await resolvedDestPath(destPath, conflictPolicy);
        if (resolved === null) continue; // skipped

        // `collectEntries` only ever emits a job for a directory when it is
        // *empty* — a populated one is never its own job, only its children
        // are. So the parent here may not exist yet even though its sibling
        // files do; unlike `copyFileStaged`, staging is not expected to
        // create it.
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        try {
            await copyFileStaged(job.abs, resolved, { replace: replaceFor(conflictPolicy) });
        } catch (e) {
            if (e instanceof CommitError && e.kind === 'destination_exists') {
                return { success: false, message: `Destination already exists: ${destPath}` };
            }
            throw e;
        }
    }
    return { success: true, message: 'OK' };
}

/** Same contract as copySourceSync, but moves (rename with cross-device fallback via moveEntryStaged). */
export async function moveSourceSync(src, targetDir, conflictPolicy = 'refuse') {
    const jobs = await collectEntries(src);
    for (const job of jobs) {
        const destPath = path.join(targetDir, job.rel);
        if (job.isDir) {
            await fs.mkdir(destPath, { recursive: true });
            continue;
        }

        const resolved = await resolvedDestPath(destPath, conflictPolicy);
        if (resolved === null) continue; // skipped

        await fs.mkdir(path.dirname(resolved), { recursive: true });
        try {
            await moveEntryStaged(job.abs, resolved, { replace: replaceFor(conflictPolicy) });
        } catch (e) {
            if (e instanceof CommitError && e.kind === 'destination_exists') {
                return { success: false, message: `Destination already exists: ${destPath}` };
            }
            throw e;
        }
    }
    await pruneEmptyDirs(src);
    return { success: true, message: 'OK' };
}
