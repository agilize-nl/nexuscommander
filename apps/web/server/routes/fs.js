import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { resolveSafePath, assertNotProtectedRoot } from '../lib/security.js';
import { copySourceSync, moveSourceSync } from '../lib/fileOps.js';
import { writeFileAtomically, copyFileStaged, moveEntryStaged, durabilityClaim, CommitError, Replace, trashEntry } from '../lib/commit.js';
import { MAX_EDIT_BYTES, sniffBinary } from '../lib/file-preview.js';
import { buildContentDisposition } from '../lib/contentDisposition.js';
import { ACTIVE_CONTENT_EXTENSIONS, ACTIVE_CONTENT_CSP } from '../lib/csp.js';

const router = express.Router();

const PSEUDO_FSTYPES = new Set([
    'proc', 'sysfs', 'devtmpfs', 'tmpfs', 'cgroup', 'cgroup2', 'devpts',
    'securityfs', 'pstore', 'bpf', 'tracefs', 'debugfs', 'mqueue',
    'hugetlbfs', 'fusectl', 'configfs', 'binfmt_misc', 'autofs',
    'fuse.lxcfs',
    'rpc_pipefs', 'overlay', 'squashfs', 'efivarfs', 'ramfs'
]);
const NETWORK_FSTYPES = new Set(['nfs', 'nfs4', 'cifs', 'smbfs', 'smb3', 'fuse.sshfs', 'fuse.gvfsd-fuse']);

let passwdCache = null;
let groupCache = null;

function isHiddenGvfsMount(device, mountpoint, fstype) {
    return device === 'gvfsd-fuse'
        || fstype === 'fuse.gvfsd-fuse'
        || /^\/run\/user\/\d+\/gvfs\/?$/.test(mountpoint);
}

async function readColonFile(filePath, valueIndex, idIndex) {
    const map = new Map();
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        for (const line of raw.split('\n')) {
            if (!line || line.startsWith('#')) continue;
            const parts = line.split(':');
            const id = Number(parts[idIndex]);
            const value = parts[valueIndex];
            if (Number.isFinite(id) && value) map.set(id, value);
        }
    } catch {
        // Keep numeric uid/gid fallback if system account files are unavailable.
    }
    return map;
}

async function resolveUserName(uid) {
    passwdCache ??= readColonFile('/etc/passwd', 0, 2);
    const map = await passwdCache;
    return map.get(uid) || uid.toString();
}

async function resolveGroupName(gid) {
    groupCache ??= readColonFile('/etc/group', 0, 2);
    const map = await groupCache;
    return map.get(gid) || gid.toString();
}

async function listDrives() {
    let mountsRaw;
    try {
        mountsRaw = await fs.readFile('/proc/mounts', 'utf8');
    } catch {
        return [{ name: 'Root', path: '/', label: '/', drive_type: 'Fixed', total_space: 0, available_space: 0 }];
    }

    const seen = new Set();
    const drives = [];
    for (const line of mountsRaw.split('\n')) {
        const parts = line.split(' ');
        if (parts.length < 3) continue;
        const [device, mountRaw, fstype] = parts;
        const mountpoint = mountRaw.replace(/\\040/g, ' ');
        if (isHiddenGvfsMount(device, mountpoint, fstype)) continue;
        if (mountpoint.startsWith('/proc/')) continue;
        if (mountpoint.startsWith('/run/')) {
            const isUserMount = mountpoint.startsWith('/run/media/') || mountpoint.includes('/gvfs');
            if (!isUserMount) continue;
        }
        if (mountpoint === '/boot/efi') continue;
        if (PSEUDO_FSTYPES.has(fstype)) continue;
        if (fstype === 'fuse' && !device.includes(':')) continue;
        if (seen.has(mountpoint)) continue;
        seen.add(mountpoint);

        let total_space = 0;
        let available_space = 0;
        try {
            const stat = await fs.statfs(mountpoint);
            total_space = stat.blocks * stat.bsize;
            available_space = stat.bavail * stat.bsize;
        } catch {
            // Mount may be inaccessible/stale; report zeroes rather than failing the whole list.
        }

        const isNetwork = NETWORK_FSTYPES.has(fstype) || device.includes(':') || device.startsWith('//');
        const isRemovable = mountpoint.startsWith('/media/') || mountpoint.startsWith('/run/media/') || mountpoint.startsWith('/mnt/');
        
        let name = mountpoint === '/' ? 'Root' : path.basename(mountpoint);
        if (name.includes(':') && (name.includes('host=') || name.includes('server='))) {
            const shareMatch = name.match(/share=([^,]+)/);
            if (shareMatch) {
                name = shareMatch[1];
            } else {
                const hostMatch = name.match(/(?:host|server)=([^,]+)/);
                if (hostMatch) name = hostMatch[1];
            }
        }

        drives.push({
            name,
            path: mountpoint,
            label: mountpoint,
            drive_type: isNetwork ? 'Network' : isRemovable ? 'Removable' : 'Fixed',
            total_space,
            available_space
        });
    }
    return drives.length > 0 ? drives : [{ name: 'Root', path: '/', label: '/', drive_type: 'Fixed', total_space: 0, available_space: 0 }];
}

// Helper to map fs.lstat/stat to a FileEntry. Uses lstat first so symlinks are
// reported correctly, then stats through the link (if it resolves) to get an
// accurate is_dir for navigation purposes.
async function mapToFileEntry(filePath) {
    const lstat = await fs.lstat(filePath);
    const isSymlink = lstat.isSymbolicLink();
    const stats = isSymlink ? await fs.stat(filePath).catch(() => lstat) : lstat;
    const name = path.basename(filePath);
    const [owner, group] = await Promise.all([
        resolveUserName(lstat.uid),
        resolveGroupName(lstat.gid)
    ]);
    return {
        name,
        path: filePath,
        is_dir: stats.isDirectory(),
        size: stats.size,
        modified: Math.floor(stats.mtimeMs),
        is_symlink: isSymlink,
        permissions: (lstat.mode & 0o7777).toString(8),
        extension: stats.isDirectory() ? "" : path.extname(name).substring(1),
        owner,
        group,
        created: Math.floor(lstat.birthtimeMs),
        accessed: Math.floor(lstat.atimeMs),
        changed: Math.floor(lstat.ctimeMs)
    };
}

router.get('/read', async (req, res) => {
    try {
        const dirPath = resolveSafePath(req.query.path);
        const entries = await fs.readdir(dirPath);
        const result = await Promise.all(
            entries.map(async (name) => {
                const fullPath = path.join(dirPath, name);
                try {
                    return await mapToFileEntry(fullPath);
                } catch (e) {
                    // Ignore inaccessible files
                    return null;
                }
            })
        );
        res.json(result.filter(Boolean));
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

router.get('/home', async (req, res) => {
    res.json(os.homedir());
});

router.get('/parent', async (req, res) => {
    try {
        const childPath = resolveSafePath(req.query.path);
        res.json(path.dirname(childPath));
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

router.get('/info', async (req, res) => {
    try {
        const filePath = resolveSafePath(req.query.path);
        res.json(await mapToFileEntry(filePath));
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

// The shared contract's PathInfo — `{ exists, is_dir, canonical }` — which is
// a different shape from /info's FileEntry. `getPathInfo` used to cast /info's
// answer to PathInfo, so `exists` was always undefined and FileList's
// stale-path recovery (which tests `info.exists === false`) could never fire:
// a panel whose directory was deleted underneath it just kept showing the old
// listing, because /info's 500 on ENOENT was swallowed as a transient error.
router.get('/path-info', async (req, res) => {
    try {
        const filePath = resolveSafePath(req.query.path);
        try {
            const stats = await fs.stat(filePath);
            res.json({
                exists: true,
                is_dir: stats.isDirectory(),
                canonical: await fs.realpath(filePath).catch(() => filePath)
            });
        } catch (e) {
            if (e.code === 'ENOENT' || e.code === 'ENOTDIR') {
                // "Not there" is an answer, not a failure — it is the answer
                // the caller asked the question to get.
                return res.json({ exists: false, is_dir: false, canonical: filePath });
            }
            throw e;
        }
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

router.get('/drives', async (req, res) => {
    try {
        res.json(await listDrives());
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

const COMPARE_HASH_LIMIT = 50 * 1024 * 1024; // above this, fall back to size+mtime rather than hashing

async function filesAreIdentical(a, b, size) {
    if (size > COMPARE_HASH_LIMIT) {
        const [sa, sb] = await Promise.all([fs.lstat(a), fs.lstat(b)]);
        return Math.abs(sa.mtimeMs - sb.mtimeMs) < 2000;
    }
    const [bufA, bufB] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
    return bufA.equals(bufB);
}

router.get('/compare', async (req, res) => {
    try {
        const left = resolveSafePath(req.query.left, 'left');
        const right = resolveSafePath(req.query.right, 'right');
        const [leftNames, rightNames] = await Promise.all([fs.readdir(left), fs.readdir(right)]);
        const leftSet = new Set(leftNames);
        const rightSet = new Set(rightNames);

        const only_in_left = leftNames.filter(n => !rightSet.has(n));
        const only_in_right = rightNames.filter(n => !leftSet.has(n));
        const different = [];
        const identical = [];

        for (const name of leftNames) {
            if (!rightSet.has(name)) continue;
            try {
                const leftPath = path.join(left, name);
                const rightPath = path.join(right, name);
                const [lstat, rstat] = await Promise.all([
                    fs.lstat(leftPath),
                    fs.lstat(rightPath)
                ]);
                const sameKind = lstat.isDirectory() === rstat.isDirectory();
                const sameContent = lstat.isDirectory()
                    || (lstat.size === rstat.size && await filesAreIdentical(leftPath, rightPath, lstat.size));
                (sameKind && sameContent ? identical : different).push(name);
            } catch {
                different.push(name);
            }
        }

        res.json({ only_in_left, only_in_right, different, identical });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

// Fast path: a single native `du` process is far cheaper than per-file stat()
// calls from Node, especially over network shares (NFS/CIFS) where each stat
// is a round-trip. Falls back to a bounded-concurrency JS walk if `du` is
// unavailable or fails outright.
function duSize(dirPath, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new Error('aborted'));
        const child = spawn('du', ['-sb', '--', dirPath]);
        let stdout = '';
        const onAbort = () => child.kill('SIGTERM');
        signal?.addEventListener('abort', onAbort, { once: true });
        child.stdout.on('data', (d) => { stdout += d; });
        child.on('error', (err) => {
            signal?.removeEventListener('abort', onAbort);
            reject(err);
        });
        child.on('close', () => {
            signal?.removeEventListener('abort', onAbort);
            if (signal?.aborted) return reject(new Error('aborted'));
            // `du` exits non-zero when it hits permission-denied subdirs, but
            // still prints the accumulated total for whatever it could read.
            const match = stdout.match(/^(\d+)/);
            if (match) resolve(Number(match[1]));
            else reject(new Error('du produced no output'));
        });
    });
}

// Bounds how many fs syscalls (readdir/lstat) are in flight at once. Without
// this, a Promise.all over an entire directory tree fans out unboundedly and
// starves libuv's threadpool on large trees, freezing the whole server.
const WALK_CONCURRENCY = 24;

async function walkSizeBounded(rootPath, signal, concurrency = WALK_CONCURRENCY) {
    let total = 0;
    let inflight = 0;
    const waiters = [];

    function acquire() {
        if (inflight < concurrency) { inflight++; return Promise.resolve(); }
        return new Promise((resolve) => waiters.push(resolve));
    }
    function release() {
        inflight--;
        const next = waiters.shift();
        if (next) { inflight++; next(); }
    }

    async function visit(dir) {
        if (signal?.aborted) throw new Error('aborted');
        await acquire();
        let children;
        try {
            children = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            children = [];
        } finally {
            release();
        }

        await Promise.all(children.map(async (child) => {
            if (signal?.aborted) throw new Error('aborted');
            const full = path.join(dir, child.name);
            if (child.isDirectory()) {
                await visit(full);
                return;
            }
            await acquire();
            try {
                const st = await fs.lstat(full);
                total += st.size;
            } catch {
                // ignore unreadable entries
            } finally {
                release();
            }
        }));
    }

    await visit(rootPath);
    if (signal?.aborted) throw new Error('aborted');
    return total;
}

async function computeDirSize(dirPath, signal) {
    try {
        return await duSize(dirPath, signal);
    } catch (err) {
        if (signal?.aborted || err.message === 'aborted') throw err;
        return await walkSizeBounded(dirPath, signal);
    }
}

router.get('/dirsize', async (req, res) => {
    const controller = new AbortController();
    // res 'close' (not req 'close') fires only when the connection ends before
    // the response finished - req 'close' fires as soon as the (empty) request
    // body is consumed, i.e. almost immediately, which would abort every call.
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
        const dirPath = resolveSafePath(req.query.path);
        const total = await computeDirSize(dirPath, controller.signal);
        res.json(total);
    } catch (error) {
        if (controller.signal.aborted) return; // client navigated away; nothing to send
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

// Batched variant: computes sizes for many directories over a single HTTP
// request instead of several parallel GETs, which otherwise exhaust the
// browser's per-origin connection pool and make unrelated requests (like
// navigation) queue up behind them.
const DIRSIZES_CONCURRENCY = 4;

router.post('/dirsizes', async (req, res) => {
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
        const paths = req.body?.paths;
        if (!Array.isArray(paths) || paths.length === 0) {
            return res.status(400).json({ error: 'paths must be a non-empty array' });
        }

        const results = new Array(paths.length);
        let nextIndex = 0;

        async function worker() {
            while (nextIndex < paths.length) {
                if (controller.signal.aborted) return;
                const i = nextIndex++;
                try {
                    const dirPath = resolveSafePath(paths[i]);
                    results[i] = { path: paths[i], size: await computeDirSize(dirPath, controller.signal) };
                } catch (err) {
                    if (controller.signal.aborted) return;
                    results[i] = { path: paths[i], error: err.message };
                }
            }
        }

        const workers = Array.from({ length: Math.min(DIRSIZES_CONCURRENCY, paths.length) }, worker);
        await Promise.all(workers);
        if (controller.signal.aborted) return;
        res.json(results);
    } catch (error) {
        if (controller.signal.aborted) return;
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

const MAX_SEARCH_RESULTS = 2000;
const MAX_CONTENT_SEARCH_BYTES = 20 * 1024 * 1024;

function globToRegex(glob) {
    const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`, 'i');
}

async function fileContainsText(filePath, needle, useRegex) {
    try {
        const stat = await fs.stat(filePath);
        if (stat.size > MAX_CONTENT_SEARCH_BYTES) return false;
        const content = await fs.readFile(filePath, 'utf8');
        return useRegex ? new RegExp(needle, 'i').test(content) : content.toLowerCase().includes(needle.toLowerCase());
    } catch {
        return false;
    }
}

router.post('/search', async (req, res) => {
    try {
        const { query, start_dir, use_regex, content_query } = req.body.params || {};
        if (!query) return res.status(400).json({ error: 'Missing search query' });
        const startDir = resolveSafePath(start_dir, 'start_dir');

        const nameMatcher = use_regex
            ? new RegExp(query, 'i')
            : globToRegex(/[*?]/.test(query) ? query : `*${query}*`);

        const results = [];

        async function walk(dir) {
            if (results.length >= MAX_SEARCH_RESULTS) return;
            let children;
            try {
                children = await fs.readdir(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const child of children) {
                if (results.length >= MAX_SEARCH_RESULTS) return;
                const full = path.join(dir, child.name);
                const isDir = child.isDirectory();
                if (nameMatcher.test(child.name)) {
                    let include = true;
                    if (content_query && !isDir) {
                        include = await fileContainsText(full, content_query, !!use_regex);
                    }
                    if (include) {
                        const st = await fs.lstat(full).catch(() => null);
                        if (st) {
                            results.push({ name: child.name, path: full, is_dir: isDir, size: st.size, modified: Math.floor(st.mtimeMs) });
                        }
                    }
                }
                if (isDir) await walk(full);
            }
        }

        await walk(startDir);
        res.json(results);
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

// `ipc-contract.ts`'s ConflictPolicy is "ask" | "skip" | "replace" |
// "keep_both" | "merge". This route has no per-file round trip to resolve
// "ask" with (that is taskExecutor.js's WaitingForInput dance, for queued
// tasks) and "merge" is already unconditional for directories regardless of
// policy — so only the three policies fileOps.js can actually act on
// synchronously are passed through; anything else keeps today's default of
// stopping at the first conflict and reporting it as a failure.
const ACTIONABLE_CONFLICT_POLICIES = new Set(['skip', 'replace', 'keep_both']);

function conflictPolicyFrom(body) {
    return ACTIONABLE_CONFLICT_POLICIES.has(body?.conflictPolicy) ? body.conflictPolicy : undefined;
}

router.post('/copy', async (req, res) => {
    try {
        if (Array.isArray(req.body.sources)) {
            const sources = req.body.sources.map(s => resolveSafePath(s, 'source'));
            const targetDir = resolveSafePath(req.body.targetDir, 'targetDir');
            const conflictPolicy = conflictPolicyFrom(req.body);
            const results = [];
            for (const src of sources) {
                try {
                    results.push(await copySourceSync(src, targetDir, conflictPolicy));
                } catch (e) {
                    results.push({ success: false, message: e.message });
                }
            }
            res.json(results);
        } else {
            const src = resolveSafePath(req.body.src, 'src');
            const dst = resolveSafePath(req.body.dst, 'dst');
            await fs.mkdir(path.dirname(dst), { recursive: true });
            try {
                await copyFileStaged(src, dst, { replace: Replace.Never });
                res.json({ success: true, message: 'OK' });
            } catch (e) {
                if (e instanceof CommitError && e.kind === 'destination_exists') {
                    return res.json({ success: false, message: `Destination already exists: ${dst}` });
                }
                throw e;
            }
        }
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

router.post('/move', async (req, res) => {
    try {
        const sources = req.body.sources.map(s => resolveSafePath(s, 'source'));
        const targetDir = resolveSafePath(req.body.targetDir, 'targetDir');
        const conflictPolicy = conflictPolicyFrom(req.body);
        const results = [];
        for (const src of sources) {
            try {
                assertNotProtectedRoot(src);
                results.push(await moveSourceSync(src, targetDir, conflictPolicy));
            } catch (e) {
                results.push({ success: false, message: e.message });
            }
        }
        res.json(results);
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

router.post('/mkdir', async (req, res) => {
    try {
        const dirPath = resolveSafePath(req.body.path);
        await fs.mkdir(dirPath, { recursive: true });
        res.json({ success: true });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

// `mode` matches the shared IPC contract's third `deleteEntry` argument and the
// desktop shell's DeleteMode: "trash" (default, recoverable) or "permanent".
// Defaulting to permanent here would make the safe-sounding call the
// destructive one for any caller that forgets the argument.
router.post('/delete', async (req, res) => {
    try {
        const targetPath = resolveSafePath(req.body.path);
        assertNotProtectedRoot(targetPath);
        const permanent = req.body.mode === 'permanent';
        if (permanent) {
            await fs.rm(targetPath, { recursive: !!req.body.recursive });
            res.json({ success: true, message: `Deleted permanently: ${targetPath}` });
        } else {
            const { trashedTo } = await trashEntry(targetPath);
            res.json({ success: true, message: `Moved to trash: ${trashedTo}` });
        }
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

/** Same dev+inode: a case-only rename on a case-insensitive filesystem. */
async function sameEntry(a, b) {
    const [sa, sb] = await Promise.all([fs.lstat(a).catch(() => null), fs.lstat(b).catch(() => null)]);
    return !!sa && !!sb && sa.dev === sb.dev && sa.ino === sb.ino;
}

router.post('/rename', async (req, res) => {
    try {
        const from = resolveSafePath(req.body.from, 'from');
        const to = resolveSafePath(req.body.to, 'to');
        assertNotProtectedRoot(from);

        // rename(2) onto the same inode does nothing, so a case-only rename on
        // vfat/exFAT goes through a temporary name in the same directory.
        if (from !== to && await sameEntry(from, to)) {
            const via = path.join(path.dirname(from), `.nc-rename-${crypto.randomUUID()}`);
            await fs.rename(from, via);
            await fs.rename(via, to);
            return res.json({ success: true });
        }

        // Never replace. This is the inline rename, and it used to take
        // moveEntryStaged's default (replace a file): renaming `a.txt` to an
        // existing `b.txt` destroyed `b.txt` without a question. moveEntryStaged
        // still provides the staged-copy fallback for EXDEV.
        await moveEntryStaged(from, to, { replace: Replace.Never });
        res.json({ success: true });
    } catch (error) {
        if (error instanceof CommitError && error.kind === 'destination_exists') {
            return res.status(409).json({ error: `Destination already exists: ${error.target ?? req.body.to}`, kind: 'destination_exists' });
        }
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

router.put('/text', async (req, res) => {
    try {
        const filePath = resolveSafePath(req.query.path);
        const text = req.body?.text;
        if (typeof text !== 'string') {
            return res.status(400).json({ error: 'Missing text content.' });
        }

        try {
            const stats = await fs.stat(filePath);
            if (stats.size > MAX_EDIT_BYTES) {
                return res.status(413).json({ error: `File too large to edit (${stats.size} bytes, limit ${MAX_EDIT_BYTES})` });
            }
            if (await sniffBinary(filePath, stats.size)) {
                return res.status(400).json({ error: 'Binary files cannot be edited as text.' });
            }
        } catch {
            // New or missing files are okay; they will be created below.
        }

        const report = await writeFileAtomically(filePath, text);
        res.json({ success: true, message: durabilityClaim(report) });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

router.get('/raw', async (req, res) => {
    try {
        const filePath = resolveSafePath(req.query.path);
        res.setHeader('Cache-Control', 'no-transform');
        // This route serves arbitrary files *inline, on the app's own origin*.
        // Without these, an HTML or SVG file opened through it (the viewer's
        // "open raw") ran its scripts with full access to this API.
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (ACTIVE_CONTENT_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
            res.setHeader('Content-Security-Policy', ACTIVE_CONTENT_CSP);
        }
        // Only set Content-Disposition behind ?download=1 — this route also
        // serves inline preview (images/PDF in HeadlessFileModal/FileViewer),
        // where the header would force a download instead of rendering inline.
        if (req.query.download === '1') {
            res.setHeader('Content-Disposition', buildContentDisposition(path.basename(filePath)));
        }
        res.sendFile(filePath, { acceptRanges: true }, (error) => {
            if (error && !res.headersSent) {
                res.status(error.statusCode || 404).json({ error: error.message });
            }
        });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

router.get('/users-groups', async (req, res) => {
    try {
        const passwd = await readColonFile('/etc/passwd', 0, 2);
        const grp = await readColonFile('/etc/group', 0, 2);
        const currentGroup = typeof process.getgid === 'function' ? (grp.get(process.getgid()) || null) : null;
        res.json({
            users: Array.from(passwd.values()),
            groups: Array.from(grp.values()),
            currentUser: os.userInfo().username,
            currentGroup
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const OCTAL_MODE_RE = /^[0-7]{3,4}$/;
const ACCOUNT_NAME_RE = /^[a-zA-Z0-9._][a-zA-Z0-9._-]*$/;

router.post('/set-properties', async (req, res) => {
    try {
        const filePath = resolveSafePath(req.body.path);
        const { permissions, owner, group } = req.body;

        // 1. Chmod if permissions are provided (as octal string, e.g. "755")
        if (typeof permissions === 'string' && permissions) {
            if (!OCTAL_MODE_RE.test(permissions)) {
                return res.status(400).json({ error: `Invalid permissions mode: ${permissions}` });
            }
            await fs.chmod(filePath, parseInt(permissions, 8));
        }
        
        // 2. Chown if owner or group is provided
        if (owner || group) {
            let uid = -1;
            let gid = -1;
            
            if (owner) {
                const passwd = await readColonFile('/etc/passwd', 0, 2);
                for (const [id, name] of passwd.entries()) {
                    if (name === owner) {
                        uid = id;
                        break;
                    }
                }
                if (uid === -1 && !isNaN(Number(owner))) {
                    uid = Number(owner);
                }
            }
            
            if (group) {
                const grp = await readColonFile('/etc/group', 0, 2);
                for (const [id, name] of grp.entries()) {
                    if (name === group) {
                        gid = id;
                        break;
                    }
                }
                if (gid === -1 && !isNaN(Number(group))) {
                    gid = Number(group);
                }
            }
            
            // On Unix, -1 means keep original UID/GID, but we only call if at least one is valid
            if (uid !== -1 || gid !== -1) {
                // If one is -1, fs.chown keeps it as is
                await fs.chown(filePath, uid, gid);
            }
        }
        
        res.json({ success: true });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

function runAsSudo(args, password) {
    return new Promise((resolve, reject) => {
        const child = spawn('sudo', ['-S', '-p', '', ...args]);

        let stderr = '';
        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        child.on('error', (err) => {
            reject(new Error(`Failed to run sudo: ${err.message}`));
        });

        child.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                const lowered = stderr.toLowerCase();
                if (lowered.includes('incorrect password') || lowered.includes('sorry, try again') || lowered.includes('no password was provided')) {
                    reject(new Error('Incorrect password. Please try again.'));
                } else {
                    reject(new Error(stderr.trim() || `Command failed with code ${code}`));
                }
            }
        });

        // sudo may exit before reading stdin (e.g. cached credentials); ignore the broken pipe.
        child.stdin.on('error', () => {});
        child.stdin.write(password + '\n');
        child.stdin.end();
    });
}

function validateElevationMode(permissions) {
    if (!OCTAL_MODE_RE.test(permissions)) {
        const err = new Error(`Invalid permissions mode: ${permissions}`);
        err.statusCode = 400;
        throw err;
    }
}

function buildChownTarget(owner, group) {
    for (const name of [owner, group]) {
        if (name && !ACCOUNT_NAME_RE.test(name)) {
            const err = new Error(`Invalid owner/group name: ${name}`);
            err.statusCode = 400;
            throw err;
        }
    }
    return owner && group ? `${owner}:${group}` : (owner ? owner : `:${group}`);
}

/**
 * Executes a file system operation as root using sudo.
 * 
 * NOTE: This path is NOT transactional. A JavaScript commit engine cannot
 * supervise a root subprocess. A minimal privileged helper (as planned in P4.2)
 * is the real fix.
 */
router.post('/elevate-operation', async (req, res) => {
    try {
        const { action, path: targetPath, target, password, permissions, owner, group } = req.body;
        if (!password) {
            return res.status(400).json({ error: 'Password is required for elevation.' });
        }

        const filePath = resolveSafePath(targetPath);
        let cmdArgs = [];

        switch (action) {
            case 'mkdir':
                cmdArgs = ['mkdir', '-p', filePath];
                break;
            case 'delete':
                assertNotProtectedRoot(filePath);
                cmdArgs = ['rm', '-rf', filePath];
                break;
            case 'move':
            case 'rename':
                if (!target) {
                    return res.status(400).json({ error: 'Target path is required for move/rename.' });
                }
                assertNotProtectedRoot(filePath);
                
                // Prevent clobbering: check target existence and return conflict if present
                const targetResolved = resolveSafePath(target);
                const targetExists = await fs.access(targetResolved).then(() => true).catch(() => false);
                if (targetExists) {
                    return res.status(409).json({ error: 'Target path already exists.' });
                }
                
                cmdArgs = ['mv', '-n', filePath, targetResolved];
                break;
            case 'chmod':
                if (!permissions) {
                    return res.status(400).json({ error: 'Permissions are required for chmod.' });
                }
                validateElevationMode(permissions);
                cmdArgs = ['chmod', permissions, filePath];
                break;
            case 'chown':
                if (!owner && !group) {
                    return res.status(400).json({ error: 'Owner or group is required for chown.' });
                }
                cmdArgs = ['chown', buildChownTarget(owner, group), filePath];
                break;
            case 'set-properties':
                if (permissions) {
                    validateElevationMode(permissions);
                    await runAsSudo(['chmod', permissions, filePath], password);
                }
                if (owner || group) {
                    await runAsSudo(['chown', buildChownTarget(owner, group), filePath], password);
                }
                return res.json({ success: true });
            default:
                return res.status(400).json({ error: `Unknown elevation action: ${action}` });
        }

        await runAsSudo(cmdArgs, password);
        res.json({ success: true });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

router.get('/size-on-disk', async (req, res) => {
    try {
        const filePath = resolveSafePath(req.query.path);
        const stats = await fs.stat(filePath);
        const sizeOnDisk = (stats.blocks || 0) * 512 || stats.size;
        res.json(sizeOnDisk);
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

export default router;
