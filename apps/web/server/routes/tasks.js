import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { runTask, resolveConflict, cancelTask, failTask, pauseTask, resumeTask } from '../lib/taskExecutor.js';
import { parseClientId } from '../lib/profiles.js';
import { resolveSafePath } from '../lib/security.js';
import { splitVirtualPath, assertSafeArchiveOperand } from '../lib/archivePaths.js';

const router = express.Router();
const tasks = new Map();
const speedTrackers = new Map(); // taskId -> { lastBytes, lastTime, interval }

const TERMINAL_STATUSES = new Set(["Completed", "Failed", "Cancelled"]);

// Which browser started a task (`X-NC-Client-Id`), kept off the task object so
// it never appears in a response. Every open tab of every device polled the
// same global list, so one device's failed delete popped up on all the others.
const taskOwners = new Map();
// When a task was first seen finished — the clock `pruneTasks` runs on.
const finishedAt = new Map();

// Same bounds as the desktop queue (`task_queue.rs`): this map grew for as long
// as the server ran, and a failed task — which the UI deliberately keeps — was
// only ever dropped by a restart.
const MAX_TRACKED_TASKS = 500;
const FINISHED_TASK_TTL_MS = 60 * 60 * 1000;

function pruneTasks(now = Date.now()) {
    for (const [id, task] of tasks) {
        if (!TERMINAL_STATUSES.has(task.status)) {
            finishedAt.delete(id);
        } else if (!finishedAt.has(id)) {
            finishedAt.set(id, now);
        } else if (now - finishedAt.get(id) >= FINISHED_TASK_TTL_MS) {
            forgetTask(id);
        }
    }
    if (tasks.size > MAX_TRACKED_TASKS) {
        const oldest = [...finishedAt.entries()].sort((a, b) => a[1] - b[1]);
        for (const [id] of oldest.slice(0, tasks.size - MAX_TRACKED_TASKS)) forgetTask(id);
    }
}

function forgetTask(id) {
    tasks.delete(id);
    taskOwners.delete(id);
    finishedAt.delete(id);
}

function requestClientId(req) {
    try {
        return parseClientId(req.get('X-NC-Client-Id'));
    } catch {
        return null;
    }
}

/** A task with no recorded owner, or a request without an id, sees everything. */
function visibleTo(clientId, id) {
    const owner = taskOwners.get(id);
    return !clientId || !owner || owner === clientId;
}

function capitalize(s) {
    return typeof s === 'string' && s.length > 0 ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s;
}

const TASK_TYPES = new Set(["Copy", "Move", "Delete"]);

/**
 * Normalize the paths a task will act on.
 *
 * These used to be taken from the request body verbatim, which is how a
 * relative or dash-leading string could travel all the way into an
 * `execFile('tar', …)` operand. A virtual archive path (`<archive>::<inner>`)
 * has to keep its inner half intact, so only the archive half is resolved.
 */
function normalizeTaskSource(src) {
    if (typeof src !== 'string' || src.length === 0) {
        const err = new Error('Missing or invalid source path');
        err.statusCode = 400;
        throw err;
    }
    const parts = splitVirtualPath(src);
    if (parts && parts.innerPath) {
        assertSafeArchiveOperand(parts.innerPath);
        return `${resolveSafePath(parts.archivePath, 'archive path')}::${parts.innerPath}`;
    }
    return resolveSafePath(src, 'source path');
}

router.post('/create', (req, res) => {
    let { taskType, sources, target } = req.body;
    const type = capitalize(taskType);
    if (!TASK_TYPES.has(type)) {
        return res.status(400).json({ error: `Unknown task type: ${taskType}` });
    }
    if (!Array.isArray(sources) || sources.length === 0) {
        return res.status(400).json({ error: 'A task needs at least one source' });
    }

    try {
        sources = sources.map(normalizeTaskSource);
        // Delete encodes its mode in `target` ("trash" | "permanent"); copy and
        // move need a real destination directory.
        if (type === 'Delete') {
            target = target === 'permanent' ? 'permanent' : 'trash';
        } else {
            target = resolveSafePath(target, 'target path');
        }
    } catch (e) {
        return res.status(e.statusCode || 400).json({ error: e.message });
    }

    const id = uuidv4();
    const task = {
        id,
        task_type: type,
        status: "Queued",
        sources,
        target,
        total_bytes: 0,
        transferred_bytes: 0,
        total_files: sources.length,
        processed_files: 0,
        current_file: "",
        current_file_total_bytes: 0,
        current_file_transferred_bytes: 0,
        current_file_source: "",
        current_file_target: "",
        speed_bytes_per_sec: 0,
        eta_seconds: 0,
        pending_conflict: null,
        error: null,
        error_kind: null,
        error_path: null
    };
    pruneTasks();
    tasks.set(id, task);
    const owner = requestClientId(req);
    if (owner) taskOwners.set(id, owner);
    res.json(id);
});

function startSpeedTracking(task) {
    const state = { lastBytes: task.transferred_bytes, lastTime: Date.now() };
    const interval = setInterval(() => {
        if (TERMINAL_STATUSES.has(task.status)) {
            clearInterval(interval);
            speedTrackers.delete(task.id);
            task.speed_bytes_per_sec = 0;
            task.eta_seconds = 0;
            return;
        }
        const now = Date.now();
        const elapsedSec = (now - state.lastTime) / 1000;
        if (elapsedSec <= 0) return;
        const deltaBytes = task.transferred_bytes - state.lastBytes;
        task.speed_bytes_per_sec = task.status === 'Running' ? Math.max(0, deltaBytes / elapsedSec) : 0;
        const remaining = task.total_bytes - task.transferred_bytes;
        task.eta_seconds = task.speed_bytes_per_sec > 0 ? Math.round(remaining / task.speed_bytes_per_sec) : 0;
        state.lastBytes = task.transferred_bytes;
        state.lastTime = now;
    }, 500);
    speedTrackers.set(task.id, interval);
}

// Execute is not idempotent and must not be concurrent: two workers on one
// task share a single `pendingConflicts` entry keyed by task id, so the second
// one silently replaces the first's resolver and the first waits forever while
// the task reports `Completed`. A queued task is the only one there is
// anything to start.
router.post('/:id/execute', (req, res) => {
    const { id } = req.params;
    const task = tasks.get(id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (task.status !== "Queued") {
        // The task is spread first: it carries its own `error` field (null on a
        // healthy task), which would otherwise overwrite the one explaining the
        // 409.
        return res.status(409).json({
            ...task,
            error: `Task ${id} is already ${task.status.toLowerCase()}; execute only starts a queued task.`
        });
    }

    startSpeedTracking(task);
    runTask(task).catch((e) => failTask(task, e));
    res.json(task);
});

router.get('/:id/progress', (req, res) => {
    const { id } = req.params;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const update = () => {
        const task = tasks.get(id);
        if (!task) {
            clearInterval(interval);
            return res.end();
        }
        res.write(`data: ${JSON.stringify(task)}\n\n`);
        if (TERMINAL_STATUSES.has(task.status)) {
            clearInterval(interval);
            res.end();
        }
    };

    const interval = setInterval(update, 500);
    req.on('close', () => clearInterval(interval));
});

router.get('/', (req, res) => {
    pruneTasks();
    const clientId = requestClientId(req);
    res.json(Array.from(tasks.values()).filter((task) => visibleTo(clientId, task.id)));
});

router.get('/:id/status', (req, res) => {
    res.json(tasks.get(req.params.id) || null);
});

router.post('/:id/cancel', (req, res) => {
    const task = tasks.get(req.params.id);
    if (task) cancelTask(task);
    res.json(true);
});

router.post('/:id/pause', (req, res) => {
    const task = tasks.get(req.params.id);
    res.json(task ? pauseTask(task) : false);
});

router.post('/:id/resume', (req, res) => {
    const task = tasks.get(req.params.id);
    res.json(task ? resumeTask(task) : false);
});

router.post('/:id/resolve-conflict', (req, res) => {
    const { resolution } = req.body;
    res.json(resolveConflict(req.params.id, resolution));
});

// A failed task is the only record of *why* it failed, and the UI auto-clears
// as soon as anything finishes — so clearing on "Failed" too threw the error
// away before the user could read it, which is what made a failed operation
// look like it had simply done nothing. Only successful and cancelled tasks are
// cleared automatically; a failed one is removed when it is superseded or when
// the session ends.
//
// `includeFailed` is the user's own "Clear finished": by then the error has been
// read, and refusing to drop it left a failure that could not be dismissed.
const AUTO_CLEARABLE_STATUSES = new Set(["Completed", "Cancelled"]);

router.post('/clear-finished', (req, res) => {
    const includeFailed = req.body?.includeFailed === true;
    const clientId = requestClientId(req);
    for (const [id, task] of tasks) {
        if (!visibleTo(clientId, id)) continue;
        if (AUTO_CLEARABLE_STATUSES.has(task.status) || (includeFailed && task.status === 'Failed')) {
            forgetTask(id);
        }
    }
    res.json({ success: true });
});

export default router;
