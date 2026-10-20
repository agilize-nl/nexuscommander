// Shared fixtures for the Fase 1b characterization suite.
//
// Deliberately dependency-free: Node 24 ships `node:test`, and the express
// instance the route tests mount is the one apps/web already depends on. A test
// suite that needs an install step is a test suite that stops being run.

import fs from 'fs/promises';
import fssync from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import express from 'express';

const execFileAsync = promisify(execFile);

/**
 * A temporary directory that removes itself. Every test gets its own, because
 * these tests write real files and a shared fixture directory turns an ordering
 * bug into a mystery.
 */
export async function tmpDir(t, name) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `nc-web-${name}-`));
    t.after(async () => {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    });
    return dir;
}

/** Writes a file and returns its absolute path. */
export async function writeFile(dir, rel, contents) {
    const target = path.join(dir, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
    return target;
}

export async function read(target) {
    return fs.readFile(target, 'utf8');
}

export async function exists(target) {
    try {
        await fs.lstat(target);
        return true;
    } catch {
        return false;
    }
}

export async function sizeOf(target) {
    return (await fs.stat(target)).size;
}

/**
 * Polls until `predicate` returns truthy, or throws after `timeoutMs`.
 *
 * Used for the task-executor tests, where the only observable handoff is a
 * status field mutated by an in-flight promise. The timeout is what keeps a
 * broken expectation from hanging the run instead of failing it.
 */
export async function waitFor(predicate, description, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await predicate();
        if (value) return value;
        if (Date.now() > deadline) {
            throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

/**
 * The task shape `routes/tasks.js` builds, so the executor tests drive the same
 * object the HTTP layer does rather than a convenient subset.
 */
export function makeTask({ id = 'test-task', taskType, sources, target }) {
    return {
        id,
        task_type: taskType,
        status: 'Queued',
        sources,
        target,
        total_bytes: 0,
        transferred_bytes: 0,
        total_files: sources.length,
        processed_files: 0,
        current_file: '',
        current_file_total_bytes: 0,
        current_file_transferred_bytes: 0,
        current_file_source: '',
        current_file_target: '',
        speed_bytes_per_sec: 0,
        eta_seconds: 0,
        pending_conflict: null,
        error: null
    };
}

/**
 * Mounts a router the way `server/index.js` does — `express.json()` in front,
 * same mount path — and listens on an ephemeral port.
 *
 * `originGuard` is deliberately left out: it is an origin check, not part of the
 * mutation contract these tests characterize, and requests from `fetch` here
 * carry no Origin header anyway.
 */
export async function mountRouter(t, mountPath, router) {
    const app = express();
    app.use(express.json());
    app.use(mountPath, router);

    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));

    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    return {
        base,
        async get(url, headers = {}) {
            const res = await fetch(base + url, { headers });
            return { status: res.status, body: await res.json() };
        },
        async post(url, body, headers = {}) {
            const res = await fetch(base + url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...headers },
                body: JSON.stringify(body)
            });
            return { status: res.status, body: await res.json() };
        },
        async put(url, body, headers = {}) {
            const res = await fetch(base + url, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', ...headers },
                body: JSON.stringify(body)
            });
            return { status: res.status, body: await res.json() };
        }
    };
}

/**
 * A FIFO source: `createReadStream` on it blocks until something opens the
 * write end, which is what makes "the destination was already truncated before
 * a single source byte was read" observable without polling for a race.
 *
 * Returns null when `mkfifo` is unavailable, so the caller can skip rather than
 * fail — this backend runs on Linux, but the suite should not lie about why it
 * did not run.
 */
export async function makeFifo(dir, name) {
    const fifo = path.join(dir, name);
    try {
        await execFileAsync('mkfifo', [fifo]);
    } catch {
        return null;
    }
    return fifo;
}

/** Opens the write end of a FIFO, writes, and closes — unblocking a reader. */
export async function feedFifo(fifo, contents) {
    const handle = await fs.open(fifo, fssync.constants.O_WRONLY);
    await handle.write(contents);
    await handle.close();
}

/**
 * Opens the write end of a FIFO without writing anything yet.
 *
 * Opening a FIFO for read-only blocks until *some* process has it open for
 * write, and vice versa — call this concurrently with (never awaited before)
 * the read-side open, or both ends deadlock waiting on each other. Once both
 * are in flight the rendezvous completes and the reader's open resolves, but
 * its first *read* still blocks until the returned handle actually writes —
 * which is what makes a staging file's mid-copy existence observable instead
 * of the write simply completing before anyone can look.
 */
export async function openFifoWriter(fifo) {
    return fs.open(fifo, fssync.constants.O_WRONLY);
}
