import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pauseTask, resumeTask, cancelTask, runTask } from '../lib/taskExecutor.js';
import { tmpDir, writeFile, read, exists, makeTask } from './helpers.js';

test('pausing and resuming running work preserves its running state', () => {
    const task = { id: 'running-lifecycle', status: 'Running' };
    assert.equal(pauseTask(task), true);
    assert.equal(pauseTask(task), false);
    assert.equal(resumeTask(task), true);
    assert.equal(task.status, 'Running');
});

for (const status of ['Completed', 'Failed', 'Cancelled']) {
    test(`late cancellation preserves a ${status} result`, () => {
        const task = { id: 'finished-lifecycle', status, error: 'retained detail' };
        cancelTask(task);
        assert.equal(task.status, status);
        assert.equal(task.error, 'retained detail');
    });
}

for (const action of ['resume', 'cancel']) {
    test(`${action} wakes a paused copy worker without losing its source`, { timeout: 5000 }, async (t) => {
        const dir = await tmpDir(t, `paused-${action}`);
        const source = await writeFile(dir, 'source.txt', 'keep this content');
        const target = path.join(dir, 'destination');
        const task = makeTask({ id: `paused-${action}`, taskType: 'Copy', sources: [source], target });
        const running = runTask(task);
        t.after(() => cancelTask(task));
        assert.equal(pauseTask(task), true);
        await delay(25);
        assert.equal(task.status, 'Paused');
        assert.equal(await exists(path.join(target, 'source.txt')), false);
        if (action === 'resume') assert.equal(resumeTask(task), true);
        else cancelTask(task);
        await running;
        assert.equal(task.status, action === 'resume' ? 'Completed' : 'Cancelled');
        assert.equal(await read(source), 'keep this content');
        if (action === 'resume') {
            assert.equal(await read(path.join(target, 'source.txt')), 'keep this content');
        } else {
            assert.equal(await exists(path.join(target, 'source.txt')), false);
            assert.equal(resumeTask(task), false);
        }
    });
}
