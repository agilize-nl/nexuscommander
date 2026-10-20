// Fase 1b, item 2 (P1b.1) — the staging, verification and atomic-commit
// protocol for the web backend. Node port of `engine/commit.rs`.
//
// The five steps every mutation converges on:
//
//   1. Stage in the *destination directory* — never `os.tmpdir()`, which would
//      make the final rename cross-filesystem and defeat the whole protocol.
//   2. Create the staging file with `wx` (O_CREAT | O_EXCL | O_WRONLY), so the
//      staging name can never adopt an existing file.
//   3. Verify per policy: byte count always available, a digest readback
//      where the caller asks for one.
//   4. Sync per durability tier.
//   5. `rename()` onto the target — the one atomic step — then optionally
//      sync the directory entry.
//
// Any failure before step 5 leaves the destination exactly as it was and
// removes the staging file. A failure *at* step 5 (the rename itself) is the
// one case that does not clean up: the staged content is complete and
// verified, and deleting it would destroy the user's only copy of data that
// was never published. That is `CommitError.kind === 'commit_failed'`, and
// every call site here checks for it before invoking `disposeIfNotPublished`.
//
// Node has no `openat`, so unlike `engine/path_policy.rs` this module trusts
// the directory path it is given — component-wise symlink resolution is
// P1b.2's job, applied by callers before a path reaches here. What survives
// unconditionally: a destination symlink is replaced by `rename()`, never
// written through, because the staged file is never opened at the
// destination's name in the first place.
//
// # What verification and durability actually prove
//
// A byte count proves as much as a byte count proves. A digest readback
// proves the page cache agrees with what was written — not that the data
// reached the platter. Only `Durability.SyncFile` and above make a durability
// claim, and `durabilityClaim()` is what callers must phrase their message
// from, never "saved".

import fs from 'fs/promises';
import crypto from 'crypto';
import os from 'os';
import path from 'path';

import { entryKind } from './pathPolicy.js';

export const Durability = Object.freeze({
    None: 'none',
    FlushOnly: 'flush_only',
    SyncFile: 'sync_file',
    SyncFileAndDirectory: 'sync_file_and_directory'
});

const DURABILITY_ORDER = [
    Durability.None,
    Durability.FlushOnly,
    Durability.SyncFile,
    Durability.SyncFileAndDirectory
];

export function durabilityAtLeast(tier, min) {
    return DURABILITY_ORDER.indexOf(tier) >= DURABILITY_ORDER.indexOf(min);
}

export const Replace = Object.freeze({
    /** Fail with `destination_exists` if anything is there. */
    Never: 'never',
    /** Replace an existing file or symlink. A directory is still refused. */
    IfFile: 'if_file'
});

/** The vocabulary `ipc-contract.ts:147` and `engine/outcome.rs` define. P1b.4 wires this onto routes; it lives here because every factory below is derived from a `CommitError`. */
export const CommitOutcome = {
    committed: () => ({ state: 'committed' }),
    skipped: (reason) => ({ state: 'skipped', reason }),
    cancelledBeforeCommit: () => ({ state: 'cancelled_before_commit' }),
    rolledBack: (reason) => ({ state: 'rolled_back', reason }),
    copiedSourceRetained: (source, reason) => ({ state: 'copied_source_retained', source, reason }),
    partiallyCommitted: (journal) => ({ state: 'partially_committed', journal }),
    manualRecoveryRequired: (detail, paths) => ({ state: 'manual_recovery_required', detail, paths })
};

/**
 * Why a commit could not be completed.
 *
 * `destinationPreserved()` is true for every kind except the one that isn't
 * meant to be: `commit_failed`, where the rename itself failed and the
 * staged content is kept on purpose.
 */
export class CommitError extends Error {
    constructor(kind, message, details = {}) {
        super(message);
        this.name = 'CommitError';
        this.kind = kind;
        Object.assign(this, details);
    }

    /**
     * Whether the previous destination content is still intact. True for
     * every kind, including `commit_failed` — the rename step is what did
     * not complete, but the *old* destination was never touched to get
     * there. Stated as code rather than as a comment because it is the
     * property this whole module exists to provide.
     */
    destinationPreserved() {
        return true;
    }

    asOutcome() {
        if (this.kind === 'commit_failed') {
            return CommitOutcome.manualRecoveryRequired(this.message, [this.staged, this.target].filter(Boolean));
        }
        if (this.kind === 'cancelled') {
            return CommitOutcome.cancelledBeforeCommit();
        }
        return CommitOutcome.rolledBack(this.message);
    }
}

// --- fault injection -------------------------------------------------------
//
// Test-only, mirroring `engine/commit.rs`'s `#[cfg(test)] mod faults`. Node
// has no compile-time `cfg(test)`, so this is a module-level switch instead —
// armed and disarmed by the test itself, never by production code. Tests run
// sequentially within a file by default, which is what makes a single mutable
// flag safe here.

export const FaultPoint = Object.freeze({
    AfterStagingCreated: 'after_staging_created',
    MidWrite: 'mid_write',
    BeforeSync: 'before_sync',
    AfterSync: 'after_sync',
    BeforeRename: 'before_rename'
});

let armedFault = null;

/** Arms a fault point for the next commit. Returns a disarm function — call it in a `finally` so a failed assertion cannot leak the fault into the next test. */
export function _armFault(at) {
    armedFault = at;
    return function disarm() {
        armedFault = null;
    };
}

function checkFault(at) {
    if (armedFault === at) {
        const err = new Error(`injected fault at ${at}`);
        err.injectedFault = at;
        throw err;
    }
}

// --- staging name -----------------------------------------------------------

/**
 * A staging name that cannot be guessed and cannot collide with a user's
 * file. QSF-011 was `batch_rename` staging through a fully predictable
 * `{source}.nc_rename_tmp_{index}`, so a file that happened to carry that name
 * was destroyed without a word. The leading dot keeps it out of ordinary
 * listings; the random suffix keeps concurrent operations in one directory
 * apart.
 */
function stagingName(targetName) {
    const hint = targetName.replace(/[^A-Za-z0-9.\-_]/g, '').slice(0, 40);
    const unique = crypto.randomBytes(8).toString('hex');
    return `.nc-staging-${hint}-${unique}`;
}

const MAX_NAME_ATTEMPTS = 3;
const CHUNK_BYTES = 512 * 1024;

async function syncDirectory(dir) {
    let handle;
    try {
        handle = await fs.open(dir, 'r');
        await handle.sync();
        return true;
    } catch {
        // Some platforms/filesystems cannot fsync a directory descriptor. The
        // commit happened; it is just not power-cut durable — never silently
        // rounded up to `directorySynced: true`.
        return false;
    } finally {
        await handle?.close().catch(() => {});
    }
}

function digestUpdate(hash, buf) {
    hash.update(buf);
}

async function digestOfFile(filePath) {
    const buf = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
}

/** What a completed commit actually achieved. */
class CommitReport {
    constructor({ bytes, replacedExisting, durability, directorySynced, verifiedDigest }) {
        this.bytes = bytes;
        this.replacedExisting = replacedExisting;
        this.durability = durability;
        this.directorySynced = directorySynced;
        this.verifiedDigest = verifiedDigest;
    }

    durabilityClaim() {
        return durabilityClaim(this);
    }
}

/** The strongest thing that may honestly be said about a commit. UI copy must come from here, never from "saved" or "the operation succeeded". */
export function durabilityClaim(report) {
    switch (report.durability) {
        case Durability.None:
            return 'written (not flushed)';
        case Durability.FlushOnly:
            return 'written (survives the app closing, not a power cut)';
        case Durability.SyncFile:
            return report.directorySynced
                ? 'written and flushed to disk'
                : 'written and flushed to disk (this platform cannot sync the folder entry)';
        case Durability.SyncFileAndDirectory:
            return report.directorySynced
                ? 'written and durable'
                : 'written and flushed to disk (this platform cannot sync the folder entry)';
        default:
            return 'written';
    }
}

/**
 * A staged replacement, not yet published.
 *
 * Node has no `Drop`, so there is no free equivalent of the Rust type's "an
 * early return is a rollback" guarantee — every caller must route through
 * `withStaging`, whose `finally` is the manual substitute.
 */
class Staged {
    constructor(dir, tempName, targetName, handle, verification, replace) {
        this.dir = dir;
        this.tempName = tempName;
        this.targetName = targetName;
        this.handle = handle;
        this.bytes = 0;
        this.hash = crypto.createHash('sha256');
        this.verification = verification;
        this.replace = replace;
        this.published = false;
        this.closed = false;
    }

    get stagedPath() {
        return path.join(this.dir, this.tempName);
    }

    get targetPath() {
        return path.join(this.dir, this.targetName);
    }

    static async create(dir, targetName, verification, replace) {
        const existing = await entryKind(dir, targetName);
        if (existing === 'dir') {
            throw new CommitError(
                'target_is_directory',
                `'${path.join(dir, targetName)}' is a directory; it cannot be replaced by a file.`,
                { target: path.join(dir, targetName) }
            );
        }
        if (existing !== null && replace === Replace.Never) {
            throw new CommitError(
                'destination_exists',
                `'${path.join(dir, targetName)}' already exists and replacing it was not requested.`,
                { target: path.join(dir, targetName), existingKind: existing }
            );
        }

        let lastErr;
        for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt++) {
            const tempName = stagingName(targetName);
            const tempPath = path.join(dir, tempName);
            let handle;
            try {
                handle = await fs.open(tempPath, 'wx', 0o600);
            } catch (e) {
                if (e.code === 'EEXIST') {
                    lastErr = e;
                    continue;
                }
                throw new CommitError(
                    'staging',
                    `Could not create a temporary file in '${dir}': ${e.message}. Nothing was changed.`,
                    { dir }
                );
            }

            try {
                checkFault(FaultPoint.AfterStagingCreated);
            } catch (e) {
                await handle.close().catch(() => {});
                await fs.unlink(tempPath).catch(() => {});
                throw new CommitError(
                    'staging',
                    `Could not create a temporary file in '${dir}': ${e.message}. Nothing was changed.`,
                    { dir }
                );
            }

            return new Staged(dir, tempName, targetName, handle, verification, replace);
        }
        throw new CommitError(
            'staging',
            `Could not create a temporary file in '${dir}': ${lastErr?.message ?? 'no staging name available'}. Nothing was changed.`,
            { dir }
        );
    }

    async write(buf) {
        try {
            checkFault(FaultPoint.MidWrite);
        } catch (e) {
            throw new CommitError('write', `Failed while writing '${this.stagedPath}': ${e.message}. The original is unchanged.`, {
                staged: this.stagedPath
            });
        }
        try {
            await this.handle.write(buf);
        } catch (e) {
            throw new CommitError('write', `Failed while writing '${this.stagedPath}': ${e.message}. The original is unchanged.`, {
                staged: this.stagedPath
            });
        }
        this.bytes += buf.length;
        if (this.verification.digest) digestUpdate(this.hash, buf);
    }

    async #close() {
        if (this.closed) return;
        this.closed = true;
        await this.handle.close();
    }

    /**
     * Publish the staged content over the target.
     *
     * `expectedBytes` is the source's size, compared against what was written
     * when `verification.byteCount` is set — catches a truncated read before
     * it replaces anything.
     */
    async commit(expectedBytes) {
        const staged = this.stagedPath;
        const target = this.targetPath;

        if (this.verification.byteCount && expectedBytes !== undefined && expectedBytes !== this.bytes) {
            throw new CommitError(
                'verification_failed',
                `Refused to publish '${staged}': expected ${expectedBytes} bytes but staged ${this.bytes}. The original is unchanged.`,
                { staged }
            );
        }

        try {
            checkFault(FaultPoint.BeforeSync);
        } catch (e) {
            throw new CommitError('sync', `Could not flush '${staged}' to disk: ${e.message}. The original is unchanged.`, { staged });
        }

        // `flush()` on an unbuffered file is a no-op on the Rust side too —
        // every write here is already a direct syscall, so `FlushOnly` is
        // documented as weaker than `SyncFile`, not implemented differently
        // from `None`.
        if (this.verification.durability === Durability.SyncFile || this.verification.durability === Durability.SyncFileAndDirectory) {
            try {
                await this.handle.sync();
            } catch (e) {
                throw new CommitError('sync', `Could not flush '${staged}' to disk: ${e.message}. The original is unchanged.`, { staged });
            }
        }

        await this.#close();

        let verifiedDigest = false;
        if (this.verification.digest) {
            const expectedDigest = this.hash.digest('hex');
            let actual;
            try {
                actual = await digestOfFile(staged);
            } catch (e) {
                throw new CommitError('sync', `Could not flush '${staged}' to disk: ${e.message}. The original is unchanged.`, { staged });
            }
            if (actual !== expectedDigest) {
                throw new CommitError(
                    'verification_failed',
                    `Refused to publish '${staged}': the readback does not match what was written. The original is unchanged.`,
                    { staged }
                );
            }
            verifiedDigest = true;
        }

        try {
            checkFault(FaultPoint.AfterSync);
        } catch (e) {
            throw new CommitError('sync', `Could not flush '${staged}' to disk: ${e.message}. The original is unchanged.`, { staged });
        }

        const replacedExisting = (await entryKind(this.dir, this.targetName)) !== null;
        if (replacedExisting && this.replace === Replace.Never) {
            throw new CommitError('destination_exists', `'${target}' already exists and replacing it was not requested.`, {
                target,
                existingKind: 'file'
            });
        }

        try {
            checkFault(FaultPoint.BeforeRename);
        } catch (e) {
            // The staged file is complete and verified; keep it rather than
            // clean it up, and say so — the one outcome worth reporting
            // distinctly, because the user's new data exists and is
            // recoverable by hand.
            throw new CommitError(
                'commit_failed',
                `Could not replace '${target}': ${e.message}. The original is intact and your new content is complete in '${staged}' — move it into place manually or retry.`,
                { staged, target }
            );
        }

        try {
            await fs.rename(staged, target);
        } catch (e) {
            throw new CommitError(
                'commit_failed',
                `Could not replace '${target}': ${e.message}. The original is intact and your new content is complete in '${staged}' — move it into place manually or retry.`,
                { staged, target }
            );
        }
        this.published = true;

        let directorySynced = false;
        if (this.verification.durability === Durability.SyncFileAndDirectory) {
            directorySynced = await syncDirectory(this.dir);
        }

        return new CommitReport({
            bytes: this.bytes,
            replacedExisting,
            durability: this.verification.durability,
            directorySynced,
            verifiedDigest
        });
    }

    /** The manual substitute for Rust's `Drop`. No-op once published. Returns the staged path if it could not be removed (an orphan for the journal to name), or null. */
    async disposeIfNotPublished() {
        if (this.published) return null;
        await this.#close().catch(() => {});
        try {
            await fs.unlink(this.stagedPath);
            return null;
        } catch (e) {
            if (e.code === 'ENOENT') return null;
            return this.stagedPath;
        }
    }
}

/**
 * Begins staging, runs `fn(staged)`, and guarantees cleanup: any throw from
 * `fn` (or from the staged `commit()` it presumably calls) removes the
 * staging file — except `commit_failed`, where the file is kept on purpose.
 * An orphan that could not be removed is attached to the thrown error as
 * `orphanedStaging` rather than swallowed.
 */
export async function withStaging(dir, targetName, { verification, replace = Replace.IfFile }, fn) {
    const staged = await Staged.create(dir, targetName, verification, replace);
    try {
        return await fn(staged);
    } catch (e) {
        if (!(e instanceof CommitError && e.kind === 'commit_failed')) {
            const orphaned = await staged.disposeIfNotPublished();
            if (orphaned) e.orphanedStaging = orphaned;
        }
        throw e;
    }
}

// --- public operations -------------------------------------------------------

export function defaultWriteVerification() {
    return { byteCount: true, digest: false, durability: Durability.SyncFileAndDirectory };
}

export function defaultCopyVerification() {
    return { byteCount: true, digest: false, durability: Durability.FlushOnly };
}

export function defaultCopyMetadata() {
    return { timestamps: true, permissions: true, onUnsupported: 'warn' };
}

/** Write `contents` to `path` through the staging protocol. The whole-file convenience for the in-app text editor, settings and bookmarks. */
export async function writeFileAtomically(targetPath, contents, verification = defaultWriteVerification()) {
    const dir = path.dirname(targetPath);
    const targetName = path.basename(targetPath);
    const buf = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);

    return withStaging(dir, targetName, { verification, replace: Replace.IfFile }, async (staged) => {
        await staged.write(buf);
        return staged.commit(buf.length);
    });
}

/**
 * Copy one regular file to `dst` through the staging protocol.
 *
 * `onProgress`, if given, is called with the size of each chunk written;
 * throwing from it aborts the copy, which rolls the staging file back and
 * leaves the destination untouched — this is how cancellation stops being
 * able to destroy an existing destination (QSF-001's ordering, the other way
 * around).
 */
export async function copyFileStaged(src, dst, opts = {}) {
    const {
        verification = defaultCopyVerification(),
        metadata = defaultCopyMetadata(),
        replace = Replace.IfFile,
        onProgress
    } = opts;
    const dir = path.dirname(dst);
    const targetName = path.basename(dst);

    const source = await fs.open(src, 'r');
    try {
        let sourceLen;
        try {
            const st = await source.stat();
            // `st_size` is not a byte count for a FIFO, socket or device —
            // it is typically 0 regardless of how much data actually flows
            // through it. Byte-count verification against that would refuse
            // to publish a perfectly good copy, so only a regular file's
            // size is trusted; anything else verifies with no expectation.
            sourceLen = st.isFile() ? st.size : undefined;
        } catch {
            sourceLen = undefined;
        }

        return await withStaging(dir, targetName, { verification, replace }, async (staged) => {
            const buf = Buffer.alloc(CHUNK_BYTES);
            for (;;) {
                const { bytesRead } = await source.read(buf, 0, CHUNK_BYTES);
                if (bytesRead === 0) break;
                await staged.write(buf.subarray(0, bytesRead));
                if (onProgress) await onProgress(bytesRead);
            }

            if (metadata.timestamps || metadata.permissions) {
                // Stamped on the *staged* file, before the rename — so the
                // committed file carries the source's mode and mtime the
                // instant it appears. Setting either after the rename would
                // leave a window where the published file has the wrong
                // attributes.
                try {
                    const st = await fs.lstat(src);
                    if (metadata.permissions) await fs.chmod(staged.stagedPath, st.mode & 0o7777);
                    if (metadata.timestamps) await fs.utimes(staged.stagedPath, st.atime, st.mtime);
                } catch (e) {
                    if (metadata.onUnsupported === 'fail') {
                        throw new CommitError('write', `Failed while writing '${staged.stagedPath}': ${e.message}. The original is unchanged.`, {
                            staged: staged.stagedPath
                        });
                    }
                    // Best-effort attribute/timestamp preservation; not fatal
                    // on `warn` — reported by neither succeeding nor throwing,
                    // matching today's behavior until P1b.4 puts it on the wire.
                }
            }

            return staged.commit(sourceLen);
        });
    } finally {
        await source.close().catch(() => {});
    }
}

/**
 * Move `src` to `dst`: rename where possible, staged copy where not. The
 * source is released only after the destination commit — QSF-002 was the
 * opposite ordering, deleting the destination outright before attempting the
 * rename.
 *
 * Returns `{ kind: 'renamed' }`, `{ kind: 'copied_then_source_removed', bytes }`
 * or `{ kind: 'copied_source_retained', bytes, reason }`.
 */
export async function moveEntryStaged(src, dst, opts = {}) {
    const {
        verification = defaultCopyVerification(),
        metadata = defaultCopyMetadata(),
        replace = Replace.IfFile,
        onProgress
    } = opts;
    const dir = path.dirname(dst);
    const targetName = path.basename(dst);

    const srcStat = await fs.lstat(src);
    const srcIsDir = srcStat.isDirectory();

    const existing = await entryKind(dir, targetName);
    if (existing === 'dir' && !srcIsDir) {
        throw new CommitError('target_is_directory', `'${dst}' is a directory; it cannot be replaced by a file.`, { target: dst });
    }
    if (existing !== null && replace === Replace.Never) {
        throw new CommitError('destination_exists', `'${dst}' already exists and replacing it was not requested.`, {
            target: dst,
            existingKind: existing
        });
    }

    try {
        await fs.rename(src, dst);
        return { kind: 'renamed' };
    } catch (e) {
        if (e.code !== 'EXDEV') {
            if (srcIsDir) {
                throw new CommitError('commit_failed', `Could not replace '${dst}': ${e.message}.`, { staged: src, target: dst });
            }
            // A non-EXDEV failure on a plain file still falls through to the
            // staged-copy fallback below, matching the reference port: only a
            // directory source short-circuits immediately, because copying a
            // whole tree is not this module's job (P1.5/journal territory).
        }
    }

    if (srcIsDir) {
        throw new CommitError(
            'commit_failed',
            `'${src}' and '${dst}' are on different filesystems, so the folder must be copied entry by entry rather than moved.`,
            { staged: src, target: dst }
        );
    }

    const report = await copyFileStaged(src, dst, { verification, metadata, replace, onProgress });

    try {
        await fs.unlink(src);
        return { kind: 'copied_then_source_removed', bytes: report.bytes };
    } catch (e) {
        return { kind: 'copied_source_retained', bytes: report.bytes, reason: e.message };
    }
}

/**
 * A free name next to `targetName`, for `ConflictPolicy::KeepBoth`.
 * `report.pdf` becomes `report (2).pdf`, then `report (3).pdf`. The extension
 * is preserved because it decides how the file opens; dotfiles (`.bashrc`)
 * have no extension to preserve and become `.bashrc (2)`.
 */
export async function keepBothName(dir, targetName) {
    if ((await entryKind(dir, targetName)) === null) return targetName;

    const ext = path.extname(targetName);
    const stem = ext ? targetName.slice(0, -ext.length) : targetName;

    for (let n = 2; n <= MAX_KEEP_BOTH_ATTEMPTS; n++) {
        const candidate = ext ? `${stem} (${n})${ext}` : `${stem} (${n})`;
        if ((await entryKind(dir, candidate)) === null) return candidate;
    }

    throw new CommitError('destination_exists', `Could not find a free name for '${path.join(dir, targetName)}'.`, {
        target: path.join(dir, targetName),
        existingKind: 'file'
    });
}

/** Give up rather than loop forever in a directory with thousands of copies. */
const MAX_KEEP_BOTH_ATTEMPTS = 10_000;

// ---------------------------------------------------------------------------
// Trash (freedesktop.org Trash specification v1.0)
// ---------------------------------------------------------------------------
//
// The delete dialog offers "move to trash" and "delete permanently" as two
// different promises. The web backend used to keep only one of them: every
// delete went to `fs.rm(..., { recursive: true, force: true })` while the
// dialog said "move to trash". That is the worst possible pairing — the user
// picks the recoverable option and gets the unrecoverable one.
//
// This is the recoverable one. It lives here, in the commit engine, because
// trashing *is* a rename onto a path the user can get back to, and because
// `rename` is not available anywhere else in the backend by design.
//
// The one deliberate simplification against the spec: a file on a volume whose
// top-level `.Trash-$uid` cannot be created is refused rather than copied.
// Copying gigabytes to make "delete" feel instant is a worse lie than saying
// it did not work; the desktop shell refuses the same case (vfs.rs) instead of
// silently falling back to a permanent delete.

/** Percent-encode a path for the `Path=` line of a `.trashinfo` file. */
function encodeTrashInfoPath(absPath) {
    return absPath
        .split('/')
        .map((seg) => encodeURIComponent(seg))
        .join('/');
}

/** `2026-08-10T02:00:10`, the spec's local-time format (no zone suffix). */
function trashInfoDate(now = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return (
        `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}` +
        `T${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`
    );
}

/** The mount point `absPath` lives on: walk up while the device id is unchanged. */
async function mountPointOf(absPath) {
    let current = path.resolve(absPath);
    let dev;
    try {
        dev = (await fs.lstat(current)).dev;
    } catch {
        return null;
    }
    while (true) {
        const parent = path.dirname(current);
        if (parent === current) return current;
        let parentDev;
        try {
            parentDev = (await fs.stat(parent)).dev;
        } catch {
            return current;
        }
        if (parentDev !== dev) return current;
        current = parent;
    }
}

async function ensureTrashDirs(root, mode) {
    await fs.mkdir(path.join(root, 'files'), { recursive: true, mode });
    await fs.mkdir(path.join(root, 'info'), { recursive: true, mode });
    return root;
}

function homeTrashRoot(env = process.env) {
    const dataHome = env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    return path.join(dataHome, 'Trash');
}

/**
 * Claim a free name in `<trashRoot>/info` by creating the `.trashinfo` file
 * with `wx`, which is the spec's own reservation mechanism: the info file
 * exists before the data moves, so two deletes of `report.pdf` cannot collide
 * and a crash mid-way leaves an orphan info file rather than an unrecoverable
 * file in `files/`.
 */
async function claimTrashName(trashRoot, baseName, originalPath) {
    const ext = path.extname(baseName);
    const stem = ext ? baseName.slice(0, -ext.length) : baseName;
    const body =
        `[Trash Info]\nPath=${encodeTrashInfoPath(originalPath)}\n` +
        `DeletionDate=${trashInfoDate()}\n`;

    for (let n = 1; n <= MAX_KEEP_BOTH_ATTEMPTS; n++) {
        const candidate = n === 1 ? baseName : ext ? `${stem}.${n}${ext}` : `${stem}.${n}`;
        const infoPath = path.join(trashRoot, 'info', `${candidate}.trashinfo`);
        let handle;
        try {
            handle = await fs.open(infoPath, 'wx', 0o600);
        } catch (e) {
            if (e.code === 'EEXIST') continue;
            throw e;
        }
        try {
            await handle.writeFile(body);
        } finally {
            await handle.close();
        }
        return { name: candidate, infoPath, filesPath: path.join(trashRoot, 'files', candidate) };
    }

    throw new CommitError('destination_exists', `Could not find a free trash name for '${originalPath}'.`, {
        target: originalPath
    });
}

/**
 * Move `srcPath` to the trash.
 *
 * Returns `{ trashedTo }` — the path inside the trash, which is what makes the
 * claim "recoverable" checkable rather than assumed. Throws (never falls back
 * to a permanent delete) when no trash directory on the right volume can be
 * used.
 */
export async function trashEntry(srcPath) {
    const abs = path.resolve(srcPath);
    await fs.lstat(abs); // ENOENT here is the caller's error to report.

    const srcMount = await mountPointOf(abs);
    const home = homeTrashRoot();
    const homeMount = await mountPointOf(path.dirname(home));

    const candidates = [];
    if (srcMount !== null && homeMount !== null && srcMount === homeMount) {
        candidates.push({ root: home, mode: 0o700 });
    } else {
        // Spec: the volume's own top-level trash, per uid.
        if (srcMount) {
            const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
            candidates.push({ root: path.join(srcMount, `.Trash-${uid}`), mode: 0o700 });
        }
        candidates.push({ root: home, mode: 0o700 });
    }

    const failures = [];
    for (const { root, mode } of candidates) {
        let claim;
        try {
            await ensureTrashDirs(root, mode);
            claim = await claimTrashName(root, path.basename(abs), abs);
        } catch (e) {
            failures.push(`${root}: ${e.message}`);
            continue;
        }
        try {
            await fs.rename(abs, claim.filesPath);
            return { trashedTo: claim.filesPath };
        } catch (e) {
            // Roll the reservation back so the info directory does not fill up
            // with entries pointing at files that were never moved.
            await fs.unlink(claim.infoPath).catch(() => {});
            failures.push(`${root}: ${e.message}`);
        }
    }

    throw new CommitError(
        'commit_failed',
        `Could not move '${abs}' to the trash (${failures.join('; ')}). ` +
            'Nothing was deleted — deleting permanently needs to be chosen explicitly.',
        { target: abs }
    );
}
