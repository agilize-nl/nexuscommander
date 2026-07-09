import fs from 'fs/promises';
import fssync from 'fs';
import path from 'path';

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

/** Streams a single file from src to dest, reporting bytes copied via onChunk. */
export async function copyOneFile(src, dest, onChunk) {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await new Promise((resolve, reject) => {
        const rs = fssync.createReadStream(src);
        const ws = fssync.createWriteStream(dest);
        rs.on('data', (chunk) => onChunk?.(chunk.length));
        rs.on('error', reject);
        ws.on('error', reject);
        ws.on('close', resolve);
        rs.pipe(ws);
    });
    try {
        const st = await fs.lstat(src);
        await fs.chmod(dest, st.mode);
        await fs.utimes(dest, st.atime, st.mtime);
    } catch {
        // Best-effort attribute/timestamp preservation; not fatal if it fails.
    }
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
 * Copies a single top-level source (file or directory) into targetDir,
 * one job at a time, with no interactive conflict handling: the first
 * destination that already exists aborts the whole source with a clear
 * failure message rather than silently overwriting anything.
 */
export async function copySourceSync(src, targetDir) {
    const jobs = await collectEntries(src);
    for (const job of jobs) {
        const destPath = path.join(targetDir, job.rel);
        if (await pathExists(destPath)) {
            if (job.isDir) continue; // merging into an existing directory is fine
            return { success: false, message: `Destination already exists: ${destPath}` };
        }
        if (job.isDir) {
            await fs.mkdir(destPath, { recursive: true });
        } else {
            await copyOneFile(job.abs, destPath);
        }
    }
    return { success: true, message: 'OK' };
}

/** Same contract as copySourceSync, but moves (rename with cross-device fallback). */
export async function moveSourceSync(src, targetDir) {
    const jobs = await collectEntries(src);
    for (const job of jobs) {
        const destPath = path.join(targetDir, job.rel);
        if (await pathExists(destPath)) {
            if (job.isDir) continue;
            return { success: false, message: `Destination already exists: ${destPath}` };
        }
        if (job.isDir) {
            await fs.mkdir(destPath, { recursive: true });
            continue;
        }
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        try {
            await fs.rename(job.abs, destPath);
        } catch (e) {
            if (e.code === 'EXDEV') {
                await copyOneFile(job.abs, destPath);
                await fs.unlink(job.abs);
            } else {
                throw e;
            }
        }
    }
    await pruneEmptyDirs(src);
    return { success: true, message: 'OK' };
}
