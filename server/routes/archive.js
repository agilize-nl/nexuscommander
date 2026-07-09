import express from 'express';
import AdmZip from 'adm-zip';
import path from 'path';
import fs from 'fs/promises';
import fssync from 'fs';
import zlib from 'zlib';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolveSafePath } from '../lib/security.js';
import { splitVirtualPath, archiveKind } from '../lib/archivePaths.js';

const execFileAsync = promisify(execFile);
const router = express.Router();

router.get('/check', async (req, res) => {
    try {
        const result = splitVirtualPath(req.query.path);
        if (result) {
            return res.json(true);
        }
        const filePath = resolveSafePath(req.query.path);
        res.json(archiveKind(filePath) !== null);
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

function parseTarListing(output, archivePath) {
    return output.split('\n').filter(Boolean).map(line => {
        const m = line.match(/^(\S+)\s+\S+\s+(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.+)$/);
        if (!m) return null;
        const [, perms, size, date, time] = m;
        let name = m[5];
        const isDir = perms.startsWith('d') || name.endsWith('/');
        name = name.replace(/\/$/, '');
        const base = name.split('/').pop() || name;
        const ts = new Date(`${date}T${time}`).getTime();
        return {
            name: base,
            is_dir: isDir,
            size: parseInt(size, 10),
            modified: ts,
            path: `${archivePath}::${name}`,
            is_symlink: false,
            permissions: "644",
            extension: isDir ? "" : (base.includes('.') ? base.split('.').pop() : ""),
            owner: "0",
            group: "0",
            created: ts,
            accessed: ts,
            changed: ts
        };
    }).filter(Boolean);
}

function parse7zListing(output, archivePath) {
    return output.split('\n').filter(Boolean).map(line => {
        const m = line.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+(\S+)\s+(\d+)\s+(\d+)\s+(.+)$/);
        if (!m) return null;
        const [, date, time, attr, size, , name] = m;
        const isDir = attr.includes('D');
        const base = name.split('/').pop() || name;
        const ts = new Date(`${date}T${time}`).getTime();
        return {
            name: base,
            is_dir: isDir,
            size: parseInt(size, 10),
            modified: ts,
            path: `${archivePath}::${name}`,
            is_symlink: false,
            permissions: "644",
            extension: isDir ? "" : (base.includes('.') ? base.split('.').pop() : ""),
            owner: "0",
            group: "0",
            created: ts,
            accessed: ts,
            changed: ts
        };
    }).filter(Boolean);
}

router.get('/read', async (req, res) => {
    try {
        const result = splitVirtualPath(req.query.path);
        if (!result) {
            return res.status(400).json({ error: `Not an archive path: ${req.query.path}` });
        }
        const { archivePath, innerPath } = result;
        const kind = archiveKind(archivePath);

        let allEntries = [];

        if (kind === 'zip') {
            const zip = new AdmZip(archivePath);
            allEntries = zip.getEntries().map(entry => {
                const cleanEntryName = entry.entryName.replace(/\/$/, '');
                const name = cleanEntryName.split('/').pop() || cleanEntryName;
                return {
                    name,
                    is_dir: entry.isDirectory,
                    size: entry.header.size,
                    modified: entry.header.time.getTime(),
                    path: `${archivePath}::${cleanEntryName}`,
                    is_symlink: false,
                    permissions: "644",
                    extension: entry.isDirectory ? "" : path.extname(name).substring(1),
                    owner: "0",
                    group: "0",
                    created: entry.header.time.getTime(),
                    accessed: entry.header.time.getTime(),
                    changed: entry.header.time.getTime()
                };
            });
        } else if (kind === 'tar') {
            const { stdout } = await execFileAsync('tar', ['tvf', archivePath]);
            allEntries = parseTarListing(stdout, archivePath);
        } else if (kind === '7z') {
            const { stdout } = await execFileAsync('7z', ['l', '-ba', archivePath]);
            allEntries = parse7zListing(stdout, archivePath);
        } else if (kind === 'gz') {
            const stat = await fs.stat(archivePath);
            const base = path.basename(archivePath).replace(/\.gz$/, '');
            allEntries = [{
                name: base,
                is_dir: false,
                size: stat.size,
                modified: Math.floor(stat.mtimeMs),
                path: `${archivePath}::${base}`,
                is_symlink: false,
                permissions: "644",
                extension: base.includes('.') ? base.split('.').pop() : "",
                owner: "0",
                group: "0",
                created: Math.floor(stat.mtimeMs),
                accessed: Math.floor(stat.mtimeMs),
                changed: Math.floor(stat.mtimeMs)
            }];
        } else if (kind === 'rar') {
            const { stdout } = await execFileAsync('7z', ['l', '-ba', archivePath]);
            allEntries = parse7zListing(stdout, archivePath);
        } else {
            return res.status(400).json({ error: `Unsupported archive format: ${archivePath}` });
        }

        const filtered = [];
        const seenDirs = new Set();
        
        for (const entry of allEntries) {
            const entryParts = entry.path.split('::');
            const entryInnerPath = entryParts.slice(1).join('::').replace(/^\//, '').replace(/\/$/, '');
            
            if (!entryInnerPath) continue;
            
            if (innerPath) {
                if (entryInnerPath.startsWith(innerPath + '/')) {
                    const relativePath = entryInnerPath.substring(innerPath.length + 1);
                    const relativeParts = relativePath.split('/');
                    const directName = relativeParts[0];
                    
                    if (relativeParts.length === 1) {
                        filtered.push(entry);
                    } else {
                        const dirPath = `${innerPath}/${directName}`;
                        if (!seenDirs.has(dirPath)) {
                            seenDirs.add(dirPath);
                            filtered.push({
                                name: directName,
                                is_dir: true,
                                size: 0,
                                modified: entry.modified,
                                path: `${archivePath}::${dirPath}`,
                                is_symlink: false,
                                permissions: "755",
                                extension: "",
                                owner: "0",
                                group: "0",
                                created: entry.created,
                                accessed: entry.accessed,
                                changed: entry.changed
                            });
                        }
                    }
                }
            } else {
                const relativeParts = entryInnerPath.split('/');
                const directName = relativeParts[0];
                
                if (relativeParts.length === 1) {
                    filtered.push(entry);
                } else {
                    const dirPath = directName;
                    if (!seenDirs.has(dirPath)) {
                        seenDirs.add(dirPath);
                        filtered.push({
                            name: directName,
                            is_dir: true,
                            size: 0,
                            modified: entry.modified,
                            path: `${archivePath}::${dirPath}`,
                            is_symlink: false,
                            permissions: "755",
                            extension: "",
                            owner: "0",
                            group: "0",
                            created: entry.created,
                            accessed: entry.accessed,
                            changed: entry.changed
                        });
                    }
                }
            }
        }
        
        const finalResult = [];
        const finalPaths = new Set();
        for (const item of filtered) {
            const itemPath = item.path;
            if (!finalPaths.has(itemPath)) {
                finalPaths.add(itemPath);
                finalResult.push(item);
            }
        }

        res.json(finalResult);
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

router.post('/pack', async (req, res) => {
    try {
        const destPath = resolveSafePath(req.body.destPath, 'destPath');
        const sources = (req.body.sources || []).map(s => resolveSafePath(s, 'source'));
        const zip = new AdmZip();
        for (const source of sources) {
            const stat = await fs.stat(source);
            if (stat.isDirectory()) {
                zip.addLocalFolder(source, path.basename(source));
            } else {
                zip.addLocalFile(source);
            }
        }
        zip.writeZip(destPath);
        res.json({ success: true });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

router.post('/unpack', async (req, res) => {
    try {
        const srcPath = resolveSafePath(req.body.srcPath, 'srcPath');
        const destDir = resolveSafePath(req.body.destDir, 'destDir');
        const kind = archiveKind(srcPath);
        await fs.mkdir(destDir, { recursive: true });

        if (kind === 'zip') {
            new AdmZip(srcPath).extractAllTo(destDir, true);
        } else if (kind === 'tar') {
            await execFileAsync('tar', ['xf', srcPath, '-C', destDir]);
        } else if (kind === '7z') {
            await execFileAsync('7z', ['x', srcPath, `-o${destDir}`, '-y']);
        } else if (kind === 'gz') {
            const compressed = await fs.readFile(srcPath);
            const decompressed = zlib.gunzipSync(compressed);
            const outName = path.basename(srcPath).replace(/\.gz$/, '');
            await fs.writeFile(path.join(destDir, outName), decompressed);
        } else {
            return res.status(400).json({ error: `Unsupported archive format: ${srcPath}` });
        }
        res.json({ success: true });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

router.get('/test', async (req, res) => {
    try {
        const filePath = resolveSafePath(req.query.path);
        const kind = archiveKind(filePath);

        if (kind === 'zip') {
            const zip = new AdmZip(filePath);
            zip.getEntries().forEach(e => { if (!e.isDirectory) e.getData(); });
            return res.json(true);
        }
        if (kind === 'tar') {
            await execFileAsync('tar', ['tf', filePath]);
            return res.json(true);
        }
        if (kind === '7z') {
            await execFileAsync('7z', ['t', filePath]);
            return res.json(true);
        }
        if (kind === 'gz') {
            zlib.gunzipSync(await fs.readFile(filePath));
            return res.json(true);
        }
        res.json(false);
    } catch {
        res.json(false);
    }
});

router.post('/split', async (req, res) => {
    try {
        const srcPath = resolveSafePath(req.body.path, 'path');
        const destDir = resolveSafePath(req.body.destDir, 'destDir');
        const chunkSize = Number(req.body.chunkSize);
        if (!Number.isFinite(chunkSize) || chunkSize <= 0) {
            return res.status(400).json({ error: 'Invalid chunkSize' });
        }
        await fs.mkdir(destDir, { recursive: true });
        const baseName = path.basename(srcPath);
        const handle = await fs.open(srcPath, 'r');
        try {
            const buffer = Buffer.alloc(chunkSize);
            let partIndex = 1;
            while (true) {
                const { bytesRead } = await handle.read(buffer, 0, chunkSize, null);
                if (bytesRead === 0) break;
                const partName = `${baseName}.${String(partIndex).padStart(3, '0')}`;
                await fs.writeFile(path.join(destDir, partName), buffer.subarray(0, bytesRead));
                partIndex++;
            }
        } finally {
            await handle.close();
        }
        res.json({ success: true, message: 'OK' });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

router.post('/combine', async (req, res) => {
    try {
        const destPath = resolveSafePath(req.body.destPath, 'destPath');
        const sources = (req.body.sources || []).map(s => resolveSafePath(s, 'source'));
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        const out = fssync.createWriteStream(destPath);
        try {
            for (const src of sources) {
                await new Promise((resolve, reject) => {
                    const rs = fssync.createReadStream(src);
                    rs.on('error', reject);
                    rs.on('end', resolve);
                    rs.pipe(out, { end: false });
                });
            }
        } finally {
            out.end();
        }
        res.json({ success: true, message: 'OK' });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

export default router;
