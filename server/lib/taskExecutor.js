import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import zlib from 'zlib';
import AdmZip from 'adm-zip';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { collectEntries, copyOneFile, pruneEmptyDirs, pathExists } from './fileOps.js';
import { assertNotProtectedRoot } from './security.js';
import { splitVirtualPath, archiveKind } from './archivePaths.js';

const execFileAsync = promisify(execFile);

const CANCEL_SIGNAL = '__cancel__';

// Tracks in-flight conflict pauses per task id. Kept out of the task object
// itself so it never leaks into a JSON response.
const pendingConflicts = new Map();

export function resolveConflict(taskId, resolution) {
    const pending = pendingConflicts.get(taskId);
    if (!pending) return false;
    pending.resolve(resolution);
    return true;
}

export function cancelTask(task) {
    task.status = 'Cancelled';
    const pending = pendingConflicts.get(task.id);
    if (pending) pending.resolve(CANCEL_SIGNAL);
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
        task.status = 'Failed';
        task.error = e.message;
    }
}

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

    for (const src of task.sources) {
        if (task.status === 'Cancelled') return;
        task.current_file = path.basename(src);
        await fs.rm(src, { recursive: true, force: true });
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

                const kind = archiveKind(vparts.archivePath);
                
                const checkZipSlip = (dest, entryName) => {
                    const resolved = path.resolve(dest, entryName);
                    if (resolved !== dest && !resolved.startsWith(dest + path.sep)) {
                        throw new Error('Zip slip detected! Extraction path leads outside of temporary directory.');
                    }
                };

                if (kind === 'zip') {
                    const zip = new AdmZip(vparts.archivePath);
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
                    const args = ['xf', vparts.archivePath, '-C', extractTargetDir];
                    if (vparts.innerPath) args.push(vparts.innerPath);
                    await execFileAsync('tar', args);
                } else if (kind === '7z' || kind === 'rar') {
                    const args = ['x', vparts.archivePath, `-o${extractTargetDir}`, '-y'];
                    if (vparts.innerPath) args.push(vparts.innerPath);
                    await execFileAsync('7z', args);
                } else if (kind === 'gz') {
                    const finalDest = path.join(extractTargetDir, vparts.innerPath || archiveName);
                    checkZipSlip(extractTargetDir, vparts.innerPath || archiveName);
                    await fs.mkdir(path.dirname(finalDest), { recursive: true });
                    const compressed = await fs.readFile(vparts.archivePath);
                    const decompressed = await promisify(zlib.gunzip)(compressed);
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

        for (const job of jobs) {
            if (task.status === 'Cancelled') return;

            const destPath = path.join(targetDir, job.rel);
            task.current_file = job.rel;
            task.current_file_source = job.abs;
            task.current_file_target = destPath;
            task.current_file_total_bytes = job.size;
            task.current_file_transferred_bytes = 0;

            if (await pathExists(destPath) && !job.isDir) {
                let policy = overwriteAll ? 'overwrite' : skipAll ? 'skip' : null;
                if (!policy) {
                    policy = await waitForConflictResolution(task, job.rel);
                    if (policy === CANCEL_SIGNAL) return;
                    if (policy === 'overwrite_all') { overwriteAll = true; policy = 'overwrite'; }
                    if (policy === 'skip_all') { skipAll = true; policy = 'skip'; }
                }
                if (policy === 'skip') {
                    task.processed_files++;
                    continue;
                }
            }

            if (job.isDir) {
                await fs.mkdir(destPath, { recursive: true });
            } else if (isMove) {
                await fs.mkdir(path.dirname(destPath), { recursive: true });
                try {
                    await fs.rename(job.abs, destPath);
                    task.transferred_bytes += job.size;
                    task.current_file_transferred_bytes = job.size;
                } catch (e) {
                    if (e.code !== 'EXDEV') throw e;
                    await copyOneFile(job.abs, destPath, (n) => {
                        task.current_file_transferred_bytes += n;
                        task.transferred_bytes += n;
                    });
                    await fs.unlink(job.abs);
                }
            } else {
                await copyOneFile(job.abs, destPath, (n) => {
                    task.current_file_transferred_bytes += n;
                    task.transferred_bytes += n;
                });
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
