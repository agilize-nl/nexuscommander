import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { runTask, resolveConflict, cancelTask } from '../lib/taskExecutor.js';

const router = express.Router();
const tasks = new Map();
const speedTrackers = new Map(); // taskId -> { lastBytes, lastTime, interval }

const TERMINAL_STATUSES = new Set(["Completed", "Failed", "Cancelled"]);

function capitalize(s) {
    return typeof s === 'string' && s.length > 0 ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s;
}

router.post('/create', (req, res) => {
    const { taskType, sources, target } = req.body;
    const id = uuidv4();
    const task = {
        id,
        task_type: capitalize(taskType),
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
        error: null
    };
    tasks.set(id, task);
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

router.post('/:id/execute', (req, res) => {
    const { id } = req.params;
    const task = tasks.get(id);
    if (!task) return res.status(404).json({ error: "Task not found" });

    startSpeedTracking(task);
    runTask(task).catch((e) => {
        task.status = "Failed";
        task.error = e.message;
    });
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

router.get('/', (req, res) => res.json(Array.from(tasks.values())));

router.get('/:id/status', (req, res) => {
    res.json(tasks.get(req.params.id) || null);
});

router.post('/:id/cancel', (req, res) => {
    const task = tasks.get(req.params.id);
    if (task) cancelTask(task);
    res.json(true);
});

router.post('/:id/resolve-conflict', (req, res) => {
    const { resolution } = req.body;
    res.json(resolveConflict(req.params.id, resolution));
});

router.post('/clear-finished', (req, res) => {
    for (const [id, task] of tasks) {
        if (TERMINAL_STATUSES.has(task.status)) tasks.delete(id);
    }
    res.json({ success: true });
});

export default router;
