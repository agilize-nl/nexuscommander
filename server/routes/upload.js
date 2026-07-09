import express from 'express';
import fs from 'fs/promises';
import fssync from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { resolveSafePath, sanitizeRelPath } from '../lib/security.js';

const router = express.Router();

// Endpoint A — POST /api/upload/preflight
// Use local parser with higher limit
router.post('/preflight', express.json({ limit: '10mb' }), async (req, res) => {
    try {
        const { dir, files = [], dirs = [] } = req.body;
        
        const resolvedDir = resolveSafePath(dir);
        
        // Ensure destination dir exists and is a directory
        const dirStat = await fs.stat(resolvedDir);
        if (!dirStat.isDirectory()) {
            return res.status(400).json({ error: 'Target path is not a directory' });
        }
        
        // Check write permission
        await fs.access(resolvedDir, fssync.constants.W_OK);
        
        // Free space check
        let free = null;
        try {
            const stats = await fs.statfs(resolvedDir);
            // GVFS-SMB mounts might report 0/onzin; only use if > 0
            if (stats.bavail && stats.bsize) {
                free = Number(stats.bavail) * Number(stats.bsize);
            }
        } catch (e) {
            // Ignore statfs errors per plan
        }
        
        let totalSize = 0;
        const conflicts = [];
        const invalid = [];
        
        // 1. Validate files
        for (const file of files) {
            const { rel, size } = file;
            totalSize += (Number(size) || 0);
            
            try {
                const cleanRel = sanitizeRelPath(rel);
                const finalPath = path.join(resolvedDir, ...cleanRel.split('/'));
                
                // Jail check
                if (!finalPath.startsWith(resolvedDir + path.sep) && finalPath !== resolvedDir) {
                    invalid.push(rel);
                    continue;
                }
                
                // Check if target file/directory exists
                try {
                    const targetStat = await fs.lstat(finalPath);
                    conflicts.push({
                        rel,
                        is_dir: targetStat.isDirectory(),
                        size: targetStat.size,
                        modified: targetStat.mtimeMs
                    });
                } catch (e) {
                    // File does not exist, no conflict
                }
            } catch (e) {
                invalid.push(rel);
            }
        }
        
        // 2. Validate dirs
        for (const d of dirs) {
            try {
                const cleanRel = sanitizeRelPath(d);
                const finalPath = path.join(resolvedDir, ...cleanRel.split('/'));
                
                // Jail check
                if (!finalPath.startsWith(resolvedDir + path.sep) && finalPath !== resolvedDir) {
                    invalid.push(d);
                    continue;
                }
                
                // Check if target directory exists as a file (conflict)
                try {
                    const targetStat = await fs.lstat(finalPath);
                    if (!targetStat.isDirectory()) {
                        conflicts.push({
                            rel: d,
                            is_dir: false,
                            size: targetStat.size,
                            modified: targetStat.mtimeMs
                        });
                    }
                } catch (e) {
                    // Does not exist, no conflict
                }
            } catch (e) {
                invalid.push(d);
            }
        }
        
        res.json({
            free,
            needed: totalSize,
            conflicts,
            invalid
        });
        
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

// Endpoint B — PUT /api/upload/file
router.put('/file', async (req, res) => {
    let tmpPath = null;
    try {
        const { dir, rel, size, mtime, overwrite } = req.query;
        
        const resolvedDir = resolveSafePath(dir);
        const cleanRel = sanitizeRelPath(rel);
        const finalPath = path.join(resolvedDir, ...cleanRel.split('/'));
        
        // Prefix-jailcheck
        if (!finalPath.startsWith(resolvedDir + path.sep) && finalPath !== resolvedDir) {
            return res.status(400).json({ error: 'Path traversal detected' });
        }
        
        const targetDir = path.dirname(finalPath);
        
        // Check if finalPath already exists (race guard)
        let exists = false;
        try {
            await fs.lstat(finalPath);
            exists = true;
        } catch (e) {}
        
        if (exists && overwrite !== '1') {
            res.set('Connection', 'close');
            res.status(409).json({ error: 'exists', rel });
            req.destroy();
            return;
        }
        
        // Ensure subdirectories exist
        await fs.mkdir(targetDir, { recursive: true });
        
        // Create temp file in target directory
        const basename = path.basename(finalPath);
        const rand = crypto.randomBytes(4).toString('hex');
        tmpPath = path.join(targetDir, `.${basename}.nctmp-${rand}`);
        
        // Stream request body to temp file
        const writeStream = fssync.createWriteStream(tmpPath, {
            flags: 'wx',
            highWaterMark: 4 * 1024 * 1024
        });
        
        await pipeline(req, writeStream);
        
        // Verify size
        const tmpStat = await fs.stat(tmpPath);
        if (size !== undefined && tmpStat.size !== Number(size)) {
            throw new Error('File size verification failed: uploaded bytes do not match expected size');
        }
        
        // Re-check overwrite target (final race guard)
        if (overwrite !== '1') {
            let existsAgain = false;
            try {
                await fs.lstat(finalPath);
                existsAgain = true;
            } catch (e) {}
            if (existsAgain) {
                res.status(409).json({ error: 'exists', rel });
                req.destroy();
                throw new Error('Destination file created during upload');
            }
        }
        
        // Atomic rename within same folder
        await fs.rename(tmpPath, finalPath);
        tmpPath = null; // Prevent unlink in catch
        
        // Best-effort utimes
        const mtimeMs = Number(mtime);
        if (mtimeMs) {
            const now = new Date();
            await fs.utimes(finalPath, now, new Date(mtimeMs)).catch(() => {});
        }
        
        res.json({ success: true });
        
    } catch (error) {
        if (tmpPath) {
            await fs.unlink(tmpPath).catch(() => {});
        }
        
        if (!res.writableEnded && !req.destroyed) {
            const status = error.statusCode || (error.code === 'ENOSPC' ? 507 : 500);
            res.status(status).json({ error: error.message });
        }
    }
});

export default router;
