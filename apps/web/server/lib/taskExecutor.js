import fs from 'fs/promises';
import { constants as fsConstants } from 'fs';
import path from 'path';
import os from 'os';
import zlib from 'zlib';
import AdmZip from 'adm-zip';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { collectEntries, copyOneFile, pruneEmptyDirs, pathExists } from './fileOps.js';
import { moveEntryStaged, keepBothName, trashEntry } from './commit.js';
import { assertNotProtectedRoot } from './security.js';
import { splitVirtualPath, archiveKind, assertSafeArchiveOperand } from './archivePaths.js';
import { assertZipWithinLimits, gunzipOptions, readerKind } from './archiveLimits.js';

const execFileAsync = promisify(execFile);

const CANCEL_SIGNAL = '__cancel__';

/**
 * Thrown from a copy's `onProgress` to stop it mid-file.
 *
 * `copyFileStaged` documents that throwing from `onProgress` rolls the staging
 * file back and leaves the destination untouched — that is the only way to
 * cancel *during* a file rather than between two of them. Cancelling a 64 MiB
 * copy used to flip the status to `Cancelled` and then finish writing the
 * whole file anyway, and for a cross-device move it went on to delete the
 * source afterwards.
 */
class TaskCancelled extends Error {
    constructor() {
        super('Task cancelled');
        this.name = 'TaskCancelled';
    }
}

// Tracks in-flight conflict pauses per task id. Kept out of the task object
// itself so it never leaks into a JSON response.
const pendingConflicts = new Map();
const pendingPauses = new Map();
// A queued task has no worker to wake up. Restore its original state so that
// /execute can still start it after a pause/resume round trip.
const pausedStates = new WeakMap();

export function resolveConflict(taskId, resolution) {
    const pending = pendingConflicts.get(taskId);
    if (!pending) return false;
    pending.resolve(resolution);
    return true;
}

export function pauseTask(task) {
    if (task && (task.status === 'Running' || task.status === 'Queued')) {
        pausedStates.set(task, task.status);
        task.status = 'Paused';
        return true;
    }
    return false;
}

export function resumeTask(task) {
    if (task && task.status === 'Paused') {
        task.status = pausedStates.get(task) ?? 'Running';
        pausedStates.delete(task);
        const pending = pendingPauses.get(task.id);
        if (pending) {
            pending.resolve();
            pendingPauses.delete(task.id);
        }
        return true;
    }
    return false;
}

export function cancelTask(task) {
    // A request can arrive after the worker finished. Keep the actual outcome,
    // particularly failures that automatic cleanup must not silently discard.
    if (['Completed', 'Failed', 'Cancelled'].includes(task.status)) return;
    pausedStates.delete(task);
    task.status = 'Cancelled';
    const pendingConflict = pendingConflicts.get(task.id);
    if (pendingConflict) pendingConflict.resolve(CANCEL_SIGNAL);
    const pendingPause = pendingPauses.get(task.id);
    if (pendingPause) {
        pendingPause.resolve();
        pendingPauses.delete(task.id);
    }
}

async function checkPauseState(task) {
    while (task.status === 'Paused') {
        await new Promise((resolve) => {
            pendingPauses.set(task.id, { resolve });
        });
    }
}

async function waitForConflictResolution(task, relPath) {
    task.status = 'WaitingForInput';
    task.pending_conflict = relPath;
    const resolution = await new Promise((resolve) => {
        pendingConflicts.set(task.id, { resolve });
    });
    pendingConflicts.delete(task.id);
    task.pending_conflict = null;
    if (task.status !== 'Cancelled') task.status = 'Running';
    return resolution;
}

export async function runTask(task) {
    task.status = 'Running';
    try {
        if (task.task_type === 'Delete') {
            await runDelete(task);
        } else {
            await runCopyOrMove(task);
        }
        if (task.status !== 'Cancelled') task.status = 'Completed';
    } catch (e) {
        if (e instanceof TaskCancelled) {
            task.status = 'Cancelled';
            return;
        }
        failTask(task, e);
    }
}

/**
 * Mirror of the desktop's `TaskErrorKind`: `error` alone is a raw English
 * message the UI can only print, the kind lets it explain the failure and
 * offer elevation where that is the fix. Node's errno codes map directly.
 */
const ERROR_KINDS = {
    EACCES: 'permission_denied',
    EPERM: 'permission_denied',
    ENOENT: 'not_found',
    ENOSPC: 'no_space',
    EDQUOT: 'no_space',
    EROFS: 'read_only',
    EBUSY: 'busy',
    ETXTBSY: 'busy',
};

export function failTask(task, e) {
    task.status = 'Failed';
    task.error = e?.message ?? String(e);
    task.error_kind = ERROR_KINDS[e?.code] ?? 'other';
    task.error_path = e?.path ?? null;
}

/**
 * Find the first directory that would stop a permanent delete of `src`
 * part-way through.
 *
 * `fs.rm({ recursive: true })` deletes depth-first and stops at the first
 * entry it cannot unlink — for a folder in a read-only parent, that is the
 * folder itself, after all of its contents are already gone. Checking every
 * directory before touching anything turns that into "nothing was deleted".
 * Best effort: ACLs, immutable flags and races can still fail later.
 */
async function removalBlocker(src) {
    const euid = process.geteuid?.();
    const stickyDenies = async (dir, entry) => {
        if (euid === undefined || euid === 0) return false;
        try {
            const [d, e] = await Promise.all([fs.stat(dir), fs.lstat(entry)]);
            return (d.mode & 0o1000) !== 0 && e.uid !== euid && d.uid !== euid;
        } catch {
            return false;
        }
    };
    const denied = (p, cause) => {
        const err = new Error(`${cause?.code ?? 'EACCES'}: permission denied, cannot delete inside '${p}'`);
        err.code = cause?.code ?? 'EACCES';
        err.path = p;
        return err;
    };
    const walk = async (dir) => {
        try {
            await fs.access(dir, fsConstants.W_OK | fsConstants.X_OK);
        } catch (e) {
            return denied(dir, e);
        }
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch (e) {
            return denied(dir, e);
        }
        for (const entry of entries) {
            const p = path.join(dir, entry.name);
            if (await stickyDenies(dir, p)) return denied(p);
            if (entry.isDirectory()) {
                const blocker = await walk(p);
                if (blocker) return blocker;
            }
        }
        return null;
    };

    const parent = path.dirname(src);
    try {
        await fs.access(parent, fsConstants.W_OK | fsConstants.X_OK);
    } catch (e) {
        return denied(parent, e);
    }
    if (await stickyDenies(parent, src)) return denied(src);
    const stat = await fs.lstat(src).catch(() => null);
    return stat?.isDirectory() ? walk(src) : null;
}

/**
 * Delete, in whichever of its two meanings the caller asked for.
 *
 * `task.target === 'trash'` is the desktop shell's existing convention
 * (`task_queue.rs::execute_delete`), so both backends now read the mode the
 * same way. It matters because the dialog offers "move to trash" and "delete
 * permanently" as different promises: this used to run `fs.rm(force)` for both
 * of them, which turned the recoverable choice into the unrecoverable one.
 *
 * A trash move that fails is *not* retried as a permanent delete. The user
 * asked for the recoverable option; deleting anyway would answer a question
 * they were never asked.
 */
async function runDelete(task) {
    const jobs = [];
    for (const src of task.sources) {
        jobs.push(...await collectEntries(src));
    }
    task.total_files = jobs.length;
    task.total_bytes = jobs.reduce((sum, j) => sum + j.size, 0);

    for (const src of task.sources) {
        assertNotProtectedRoot(src);
    }

    const toTrash = task.target === 'trash';

    for (const src of task.sources) {
        await checkPauseState(task);
        if (task.status === 'Cancelled') return;
        task.current_file = path.basename(src);
        if (toTrash) {
            await trashEntry(src);
        } else {
            const blocker = await removalBlocker(src);
            if (blocker) throw blocker;
            await fs.rm(src, { recursive: true, force: true });
        }
        const removed = jobs.filter(j => j.abs === src || j.abs.startsWith(src + '/'));
        task.processed_files += removed.length || 1;
        task.transferred_bytes += removed.reduce((sum, j) => sum + j.size, 0);
    }
}

async function runCopyOrMove(task) {
    const isMove = task.task_type === 'Move';
    const targetDir = task.target;

    const diskSources = [];
    let stagingDir = null;

    try {
        for (const src of task.sources) {
            const vparts = splitVirtualPath(src);
            // A source that just *is* an archive file (innerPath === ''), selected
            // directly from a normal folder rather than reached by navigating inside
            // it, is a plain file — not a source living inside an archive. Extracting
            // whole archives is handled separately by the dedicated Unpack feature;
            // treating it as "inside" here would hijack ordinary copy/move of any
            // .zip/.tar/.7z/.rar file into a silent extract (and reject every such
            // move with a read-only error).
            if (vparts && vparts.innerPath) {
                if (isMove) {
                    throw new Error("Cannot move files out of a read-only archive.");
                }
                if (!stagingDir) {
                    stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-extract-'));
                }

                task.status = 'Extracting';
                task.current_file = `Extracting ${path.basename(vparts.archivePath)}...`;

                const archiveName = path.basename(vparts.archivePath).replace(/\.[^.]+$/, '');
                const extractTargetDir = vparts.innerPath ? stagingDir : path.join(stagingDir, archiveName);
                await fs.mkdir(extractTargetDir, { recursive: true });

                const kind = await readerKind(archiveKind(vparts.archivePath), vparts.archivePath);
                
                const checkZipSlip = (dest, entryName) => {
                    const resolved = path.resolve(dest, entryName);
                    if (resolved !== dest && !resolved.startsWith(dest + path.sep)) {
                        throw new Error('Zip slip detected! Extraction path leads outside of temporary directory.');
                    }
                };

                if (kind === 'zip') {
                    const zip = new AdmZip(vparts.archivePath);
                    assertZipWithinLimits(zip.getEntries());
                    if (!vparts.innerPath) {
                        zip.extractAllTo(extractTargetDir, true);
                    } else {
                        const entries = zip.getEntries();
                        for (const entry of entries) {
                            if (entry.entryName === vparts.innerPath || entry.entryName.startsWith(vparts.innerPath + '/')) {
                                checkZipSlip(extractTargetDir, entry.entryName);
                                zip.extractEntryTo(entry, extractTargetDir, true, true);
                            }
                        }
                    }
                } else if (kind === 'tar') {
                    // `--` ends option parsing, and assertSafeArchiveOperand
                    // refuses a leading dash outright: an entry name is
                    // attacker-chosen (it comes out of the archive), and
                    // `--checkpoint-action=exec=…` reaching GNU tar as an
                    // operand runs a command as the backend user.
                    const args = ['-x', '-f', vparts.archivePath, '-C', extractTargetDir];
                    if (vparts.innerPath) args.push('--', assertSafeArchiveOperand(vparts.innerPath));
                    await execFileAsync('tar', args);
                } else if (kind === '7z' || kind === 'rar') {
                    const args = ['x', vparts.archivePath, `-o${extractTargetDir}`, '-y'];
                    if (vparts.innerPath) args.push('--', assertSafeArchiveOperand(vparts.innerPath));
                    await execFileAsync('7z', args);
                } else if (kind === 'gz') {
                    const finalDest = path.join(extractTargetDir, vparts.innerPath || archiveName);
                    checkZipSlip(extractTargetDir, vparts.innerPath || archiveName);
                    await fs.mkdir(path.dirname(finalDest), { recursive: true });
                    const compressed = await fs.readFile(vparts.archivePath);
                    const decompressed = await promisify(zlib.gunzip)(compressed, gunzipOptions());
                    await fs.writeFile(finalDest, decompressed);
                } else {
                    throw new Error(`Unsupported archive format: ${vparts.archivePath}`);
                }

                const stagedPath = vparts.innerPath ? path.join(stagingDir, vparts.innerPath) : path.join(stagingDir, archiveName);
                diskSources.push(stagedPath);
            } else {
                diskSources.push(src);
            }
        }

        task.status = 'Running';

        const jobs = [];
        for (const src of diskSources) {
            jobs.push(...await collectEntries(src));
        }
        task.total_files = jobs.length;
        task.total_bytes = jobs.reduce((sum, j) => sum + j.size, 0);

        let overwriteAll = false;
        let skipAll = false;
        let keepBothAll = false;

        // Cancellation has to be observable *inside* a file, not only between
        // two of them: `copyFileStaged` rolls its staging file back when this
        // throws, so the destination is left exactly as it was.
        const progress = (n) => {
            if (task.status === 'Cancelled') throw new TaskCancelled();
            task.current_file_transferred_bytes += n;
            task.transferred_bytes += n;
        };

        for (const job of jobs) {
            await checkPauseState(task);
            if (task.status === 'Cancelled') return;

            let destPath = path.join(targetDir, job.rel);
            task.current_file = job.rel;
            task.current_file_source = job.abs;
            task.current_file_target = destPath;
            task.current_file_total_bytes = job.size;
            task.current_file_transferred_bytes = 0;

            if (await pathExists(destPath) && !job.isDir) {
                let policy = overwriteAll ? 'overwrite' : skipAll ? 'skip' : keepBothAll ? 'keep_both' : null;
                if (!policy) {
                    policy = await waitForConflictResolution(task, job.rel);
                    if (policy === CANCEL_SIGNAL) return;
                    if (policy === 'overwrite_all') { overwriteAll = true; policy = 'overwrite'; }
                    if (policy === 'skip_all') { skipAll = true; policy = 'skip'; }
                    if (policy === 'keep_both_all') { keepBothAll = true; policy = 'keep_both'; }
                }
                if (policy === 'skip') {
                    task.processed_files++;
                    continue;
                }
                // The dialog has offered keep-both since P1.6 and this loop
                // understood only overwrite/skip, so anything else fell through
                // to the default Replace.IfFile commit — i.e. the one
                // resolution that exists to *not* lose data destroyed the
                // existing file.
                if (policy === 'keep_both') {
                    const dir = path.dirname(destPath);
                    const freeName = await keepBothName(dir, path.basename(destPath));
                    destPath = path.join(dir, freeName);
                    task.current_file_target = destPath;
                } else if (policy !== 'overwrite') {
                    throw new Error(`Unknown conflict resolution: ${policy}`);
                }
            }

            if (job.isDir) {
                await fs.mkdir(destPath, { recursive: true });
            } else if (isMove) {
                await fs.mkdir(path.dirname(destPath), { recursive: true });
                // moveEntryStaged renames where possible and falls back to a
                // staged, verified copy plus unlink on EXDEV — the source is
                // released only after the destination commit, replacing the
                // fs.rename/copyOneFile/unlink dance that used to hand-roll
                // the same fallback with no verification in between.
                const result = await moveEntryStaged(job.abs, destPath, { onProgress: progress });
                if (result.kind === 'renamed') {
                    task.transferred_bytes += job.size;
                    task.current_file_transferred_bytes = job.size;
                }
                // 'copied_then_source_removed' and 'copied_source_retained'
                // already accounted their bytes via onProgress during the
                // staged copy; a retained source is not yet surfaced on the
                // wire — that is P1b.4's job.
            } else {
                await copyOneFile(job.abs, destPath, progress);
            }

            task.processed_files++;
        }

        if (isMove && task.status !== 'Cancelled') {
            for (const src of task.sources) {
                await pruneEmptyDirs(src);
            }
        }
    } finally {
        if (stagingDir) {
            try {
                await fs.rm(stagingDir, { recursive: true, force: true });
            } catch (e) {
                console.error("Failed to clean up staging directory:", e);
            }
        }
    }
}
