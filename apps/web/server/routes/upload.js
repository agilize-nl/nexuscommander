import express from 'express';
import fs from 'fs/promises';
import fssync from 'fs';
import path from 'path';
import { resolveSafePath, sanitizeRelPath } from '../lib/security.js';
import { withStaging, defaultCopyVerification, Replace, CommitError } from '../lib/commit.js';

const router = express.Router();

// How long an upload may go without receiving a single byte. There is no
// overall request deadline (index.js), so without this a client that stalls
// mid-upload held its socket and its staging file for as long as the server ran.
const UPLOAD_IDLE_TIMEOUT_MS = 2 * 60 * 1000;

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
//
// P1b.3: this already staged into the destination directory before renaming
// (the plan's "correct precedent already in tree" note) — it just hand-rolled
// the naming, verification and cleanup that lib/commit.js's withStaging now
// does once for every mutation. The `.${basename}.nctmp-${rand}` name and its
// unlink-in-catch are gone in favor of the shared `.nc-staging-*` protocol;
// the overwrite race guard becomes `Replace.Never`/`Replace.IfFile`, checked
// atomically at commit time rather than by two separate lstat calls with a
// whole upload's worth of streaming in between them.
router.put('/file', async (req, res) => {
    try {
        const { dir, rel, size, mtime, overwrite } = req.query;
        // Destroying the request makes the `for await` below throw, which
        // rolls the staging file back through withStaging.
        req.setTimeout(UPLOAD_IDLE_TIMEOUT_MS, () => {
            req.destroy(new Error('Upload stalled: no data received'));
        });

        const resolvedDir = resolveSafePath(dir);
        const cleanRel = sanitizeRelPath(rel);
        const finalPath = path.join(resolvedDir, ...cleanRel.split('/'));

        // Prefix-jailcheck
        if (!finalPath.startsWith(resolvedDir + path.sep) && finalPath !== resolvedDir) {
            return res.status(400).json({ error: 'Path traversal detected' });
        }

        const targetDir = path.dirname(finalPath);
        const basename = path.basename(finalPath);
        const expectedSize = size !== undefined ? Number(size) : undefined;

        // Fast-path race guard: refuse before reading a single body byte
        // rather than discovering the conflict only after the whole upload
        // has streamed through. `Replace.Never` below is the atomic guard
        // for the (much narrower) race between this check and the commit.
        if (overwrite !== '1' && (await fs.lstat(finalPath).then(() => true).catch(() => false))) {
            res.set('Connection', 'close');
            res.status(409).json({ error: 'exists', rel });
            req.destroy();
            return;
        }

        // Ensure subdirectories exist
        await fs.mkdir(targetDir, { recursive: true });

        await withStaging(
            targetDir,
            basename,
            { verification: defaultCopyVerification(), replace: overwrite === '1' ? Replace.IfFile : Replace.Never },
            async (staged) => {
                for await (const chunk of req) {
                    await staged.write(chunk);
                }

                if (expectedSize !== undefined && staged.bytes !== expectedSize) {
                    throw new Error('File size verification failed: uploaded bytes do not match expected size');
                }

                // Stamped on the staged file, before the rename — see
                // lib/commit.js's copyFileStaged for why setting it after
                // would leave a window with the wrong mtime.
                const mtimeMs = Number(mtime);
                if (mtimeMs) {
                    await fs.utimes(staged.stagedPath, new Date(), new Date(mtimeMs)).catch(() => {});
                }

                return staged.commit(expectedSize);
            }
        );

        res.json({ success: true });
    } catch (error) {
        // Not `!req.destroyed`: a request stream this route fully consumed
        // via `for await (const chunk of req)` auto-destroys once it ends,
        // whether or not anything later failed — that is unrelated to
        // whether a response can still be written on `res`. Guarding on it
        // here meant a late failure (a size mismatch, a full disk) after a
        // completed upload never got a response at all; the client hung
        // until its own timeout. `res.writableEnded` alone is the only thing
        // that actually needs guarding against — the fast-path conflict
        // check above calls `req.destroy()` itself and returns immediately,
        // without ever reaching this catch.
        if (error instanceof CommitError && error.kind === 'destination_exists') {
            if (!res.writableEnded) {
                res.status(409).json({ error: 'exists', rel: req.query.rel });
            }
            return;
        }

        if (!res.writableEnded) {
            const status = error.statusCode || (error.code === 'ENOSPC' ? 507 : 500);
            res.status(status).json({ error: error.message });
        }
    }
});

export default router;
