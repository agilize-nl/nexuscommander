// Browser-download plan §3.2 — server-side zip bundling for a directory or a
// multi-item selection. Own route file, not folded into fs.js: streaming
// semantics (SSE progress, a bearer-capability bundleId, an in-flight zip)
// don't fit fs.js's JSON-in/JSON-out shape, mirroring how upload.js is its
// own file for the same reason.
//
// Read-only: this route never writes to the server filesystem (createReadStream,
// readdir, lstat only), so root-CLAUDE.md's commit-engine rule for mutations
// does not apply here — same as /api/fs/raw today.

import express from 'express';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { ZipFile } from 'yazl';
import { resolveSafePath, sanitizeRelPath } from '../lib/security.js';
import { buildContentDisposition } from '../lib/contentDisposition.js';

const router = express.Router();

// §3.2.1 — explicit request limits so a scan can't be asked to walk an
// unbounded selection.
const MAX_ITEMS_PER_REQUEST = 500;
const MAX_ENTRIES = 50000;
const MAX_RECURSION_DEPTH = 64;

// §3.2.3 — TTL for a prepared bundle; §8 risk table accepts this as a
// single-instance limitation, not a shared-state guarantee.
const BUNDLE_TTL_MS = 5 * 60 * 1000;

// §3.2.3 — bearer-capability entries. Keyed by bundleId, not by session (this
// backend has no session identity — see security.js's header comment).
const bundles = new Map();

function sweepExpired() {
    const now = Date.now();
    for (const [id, bundle] of bundles) {
        if (bundle.state === 'active') continue;
        if (now - bundle.createdAt > BUNDLE_TTL_MS) {
            bundles.delete(id);
        }
    }
}

/** Resolves and validates one selection item against `resolvedDir`, returning its absolute path and clean relative path. */
function resolveItem(resolvedDir, item) {
    const cleanRel = sanitizeRelPath(item);
    const finalPath = path.join(resolvedDir, ...cleanRel.split('/'));
    if (finalPath !== resolvedDir && !finalPath.startsWith(resolvedDir + path.sep)) {
        const err = new Error(`Item escapes selection directory: ${item}`);
        err.statusCode = 400;
        throw err;
    }
    return { rel: cleanRel, abs: finalPath };
}

/**
 * Recursively walks `abs` (never following symlinks — §3.4), accumulating
 * total bytes / file / directory counts and the flat entry list needed to
 * build the zip later. Throws a 400-flagged error if limits are exceeded.
 */
async function walk(abs, relPrefix, depth, acc) {
    if (depth > MAX_RECURSION_DEPTH) {
        const err = new Error(`Selection exceeds maximum recursion depth (${MAX_RECURSION_DEPTH})`);
        err.statusCode = 400;
        throw err;
    }
    const st = await fsp.lstat(abs);
    if (st.isSymbolicLink()) {
        acc.skipped.push(relPrefix);
        return;
    }
    if (acc.entries.length + 1 > MAX_ENTRIES) {
        const err = new Error(`Selection exceeds maximum entry count (${MAX_ENTRIES})`);
        err.statusCode = 400;
        throw err;
    }
    if (st.isDirectory()) {
        acc.directoryCount += 1;
        acc.entries.push({ rel: relPrefix, abs, isDirectory: true });
        const children = await fsp.readdir(abs);
        for (const child of children.sort()) {
            await walk(path.join(abs, child), `${relPrefix}/${child}`, depth + 1, acc);
        }
    } else if (st.isFile()) {
        acc.fileCount += 1;
        acc.totalBytes += st.size;
        acc.entries.push({ rel: relPrefix, abs, isDirectory: false, size: st.size });
    } else {
        // Sockets, FIFOs, devices — not meaningfully "downloadable"; skip
        // rather than error the whole selection out.
        acc.skipped.push(relPrefix);
    }
}

// Endpoint A — POST /api/download/prepare
router.post('/prepare', express.json({ limit: '1mb' }), async (req, res) => {
    try {
        sweepExpired();
        const { dir, items } = req.body || {};
        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: 'items must be a non-empty array' });
        }
        if (items.length > MAX_ITEMS_PER_REQUEST) {
            return res.status(400).json({ error: `Too many items (max ${MAX_ITEMS_PER_REQUEST})` });
        }

        const resolvedDir = resolveSafePath(dir);
        const dirStat = await fsp.stat(resolvedDir);
        if (!dirStat.isDirectory()) {
            return res.status(400).json({ error: 'dir is not a directory' });
        }

        // Dedupe by relative path.
        const seen = new Map();
        for (const item of items) {
            const resolved = resolveItem(resolvedDir, item);
            seen.set(resolved.rel, resolved);
        }

        const acc = { totalBytes: 0, fileCount: 0, directoryCount: 0, entries: [], skipped: [] };
        for (const { rel, abs } of seen.values()) {
            await walk(abs, rel, 0, acc);
        }

        if (acc.fileCount === 0 && acc.directoryCount === 0) {
            return res.status(400).json({ error: 'Nothing to download (selection is empty or entirely symlinks)' });
        }

        const bundleId = crypto.randomBytes(16).toString('hex');
        const topLevelNames = Array.from(seen.values()).map((s) => path.basename(s.abs));
        bundles.set(bundleId, {
            dir: resolvedDir,
            entries: acc.entries,
            topLevelNames,
            totalBytes: acc.totalBytes,
            fileCount: acc.fileCount,
            directoryCount: acc.directoryCount,
            skipped: acc.skipped,
            createdAt: Date.now(),
            state: 'prepared',
            listeners: new Set(),
        });

        res.json({
            bundleId,
            totalBytes: acc.totalBytes,
            fileCount: acc.fileCount,
            directoryCount: acc.directoryCount,
            skipped: acc.skipped,
        });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

function archiveNameFor(bundle) {
    if (bundle.topLevelNames.length === 1) {
        const only = bundle.topLevelNames[0];
        return `${only}.zip`;
    }
    return `${bundle.topLevelNames.length}-bestanden.zip`;
}

function emitSSE(bundle, event, data) {
    for (const res of bundle.listeners) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
}

function closeSSE(bundle) {
    for (const res of bundle.listeners) {
        res.end();
    }
    bundle.listeners.clear();
}

// Endpoint B — GET /api/download/bundle?bundleId=...
router.get('/bundle', async (req, res) => {
    sweepExpired();
    const { bundleId } = req.query;
    const bundle = typeof bundleId === 'string' ? bundles.get(bundleId) : null;
    if (!bundle || bundle.state !== 'prepared') {
        return res.status(404).json({ error: 'Unknown or expired bundleId' });
    }
    // Atomic prepared -> active transition so a second concurrent GET 404s
    // instead of starting a second zip build, while existing SSE listeners
    // stay attached to the same entry.
    bundle.state = 'active';

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', buildContentDisposition(archiveNameFor(bundle)));
    // No Content-Length: unknown ahead of time under streaming compression.

    const zipfile = new ZipFile();
    const openStreams = new Set();
    let bytesRead = 0;
    let lastEmit = 0;
    let finished = false;

    const throttledProgress = () => {
        const now = Date.now();
        if (now - lastEmit < 250) return; // throttle to max 4/s
        lastEmit = now;
        emitSSE(bundle, 'progress', { bytesRead, totalBytes: bundle.totalBytes });
    };

    const cleanup = () => {
        for (const stream of openStreams) {
            stream.destroy();
        }
        openStreams.clear();
    };

    const fail = (message) => {
        if (finished) return;
        finished = true;
        cleanup();
        emitSSE(bundle, 'error', { message });
        closeSSE(bundle);
        bundles.delete(bundleId);
        if (!res.headersSent || !res.writableEnded) {
            res.destroy();
        }
    };

    req.on('close', () => {
        if (finished) return;
        finished = true;
        cleanup();
        emitSSE(bundle, 'aborted', {});
        closeSSE(bundle);
        bundles.delete(bundleId);
    });

    zipfile.outputStream.on('error', (err) => fail(err.message));
    zipfile.outputStream.pipe(res);

    try {
        for (const entry of bundle.entries) {
            if (finished) return;
            if (entry.isDirectory) {
                zipfile.addEmptyDirectory(entry.rel.replace(/^\//, '').normalize('NFC'));
                continue;
            }
            const zipName = entry.rel.replace(/^\//, '').normalize('NFC');
            // Lazy: yazl only calls this once it is actually ready to pump
            // this entry's bytes. Opening eagerly (addReadStream on an
            // already-flowing stream) races yazl's own consumption — the data
            // drains into our own progress listener before yazl's internal
            // queue reaches that entry, producing a truncated/empty member.
            // Lazy opening is also what keeps memory bounded to one open fd
            // at a time rather than one per entry in the selection.
            zipfile.addReadStreamLazy(zipName, (cb) => {
                if (finished) return;
                // Re-stat right before opening — narrows, but does not close,
                // the TOCTOU window documented in §3.2/§8. A path-based Node
                // walk has no sandbox guarantee against a hostile concurrent
                // writer; the existing local-origin trust boundary is what
                // actually holds. A file that turned into a symlink (or
                // vanished) between prepare and stream fails the whole
                // transfer via one terminal error event (§7 item 7) rather
                // than silently producing a truncated zip.
                fsp.lstat(entry.abs).then((st) => {
                    if (st.isSymbolicLink() || !st.isFile()) {
                        fail(`${entry.rel} changed since prepare (no longer a regular file)`);
                        return;
                    }
                    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
                    return fsp.open(entry.abs, flags).then((fd) => {
                        const stream = fd.createReadStream();
                        openStreams.add(stream);
                        stream.on('data', (chunk) => {
                            bytesRead += chunk.length;
                            throttledProgress();
                        });
                        stream.on('error', (err) => fail(`Failed to read ${entry.rel}: ${err.message}`));
                        stream.on('close', () => openStreams.delete(stream));
                        cb(null, stream);
                    });
                }).catch((err) => {
                    if (!finished) fail(`Failed to read ${entry.rel}: ${err.message}`);
                });
            });
        }
        zipfile.end();
    } catch (err) {
        fail(err.message);
        return;
    }

    zipfile.outputStream.on('end', () => {
        if (finished) return;
        finished = true;
        emitSSE(bundle, 'complete', { bytesRead, totalBytes: bundle.totalBytes, skipped: bundle.skipped });
        closeSSE(bundle);
        bundles.delete(bundleId);
    });
});

// Endpoint C — GET /api/download/:bundleId/progress (SSE)
router.get('/:bundleId/progress', (req, res) => {
    sweepExpired();
    const { bundleId } = req.params;
    const bundle = bundles.get(bundleId);
    if (!bundle) {
        return res.status(404).json({ error: 'Unknown or expired bundleId' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    // At most one listener per bundle — replace a stale one rather than
    // fan out to two.
    for (const existing of bundle.listeners) {
        existing.end();
    }
    bundle.listeners.clear();
    bundle.listeners.add(res);

    res.write(`event: status\ndata: ${JSON.stringify({ state: bundle.state, totalBytes: bundle.totalBytes })}\n\n`);

    const heartbeat = setInterval(() => {
        res.write(': heartbeat\n\n');
    }, 15000);

    req.on('close', () => {
        clearInterval(heartbeat);
        bundle.listeners.delete(res);
    });
});

export default router;
