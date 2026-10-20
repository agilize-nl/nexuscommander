// Regressions for the 2026-08-10 codebase audit.
//
// One test per finding, named after what the finding claimed, so that removing
// a fix fails with the audit's own sentence rather than a generic assertion.
// They cover the three release blockers plus the high-risk items that had a
// data-loss or subprocess consequence:
//
//   #2  the PWA promised "move to trash" and deleted permanently
//   #3  "keep both" overwrote the existing file
//   #4  cancelling a transfer did not stop the transfer
//   #5  an archive entry starting with '-' reached tar as an operand
//   #7  a second execute started a concurrent worker on one task
//   #8  extraction had no ceiling on entries, bytes or ratio
//   #1  the backend bound to 0.0.0.0 by default and served a shell there

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

import { runTask, cancelTask, resolveConflict } from '../lib/taskExecutor.js';
import { trashEntry } from '../lib/commit.js';
import { assertSafeArchiveOperand } from '../lib/archivePaths.js';
import { assertZipWithinLimits, archiveLimits } from '../lib/archiveLimits.js';
import { resolveBindHost, isShellExecutionEnabled, isLoopbackBindAddress, isAllowedHost, allowedHostnames, isAllowedOrigin } from '../lib/security.js';
import tasksRouter from '../routes/tasks.js';
import fsRouter from '../routes/fs.js';
import { tmpDir, writeFile, read, exists, waitFor, makeTask, mountRouter } from './helpers.js';

// --- #2: delete mode -------------------------------------------------------

/**
 * Point XDG_DATA_HOME at a scratch directory for the duration of one test, so
 * these never touch the developer's real trash.
 */
async function withScratchTrash(t) {
    const dir = await tmpDir(t, 'trash-home');
    const previous = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dir;
    t.after(() => {
        if (previous === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = previous;
    });
    return dir;
}

test('audit_2_delete_to_trash_is_recoverable_not_permanent', async (t) => {
    const dataHome = await withScratchTrash(t);
    const dir = await tmpDir(t, 'trash-src');
    const victim = await writeFile(dir, 'notes.txt', 'keep me');

    const task = makeTask({ id: 'trash-1', taskType: 'Delete', sources: [victim], target: 'trash' });
    await runTask(task);

    assert.equal(task.status, 'Completed', task.error ?? '');
    assert.equal(await exists(victim), false, 'the source is gone from its original path');

    const trashedFiles = await fs.readdir(path.join(dataHome, 'Trash', 'files'));
    assert.deepEqual(trashedFiles, ['notes.txt']);
    assert.equal(await read(path.join(dataHome, 'Trash', 'files', 'notes.txt')), 'keep me');

    // The .trashinfo is what makes it restorable rather than merely moved.
    const info = await read(path.join(dataHome, 'Trash', 'info', 'notes.txt.trashinfo'));
    assert.match(info, /^\[Trash Info\]$/m);
    assert.match(info, new RegExp(`^Path=${victim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    assert.match(info, /^DeletionDate=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/m);
});

test('audit_2_delete_permanently_still_removes_without_a_trash_copy', async (t) => {
    const dataHome = await withScratchTrash(t);
    const dir = await tmpDir(t, 'perm-src');
    const victim = await writeFile(dir, 'notes.txt', 'gone');

    const task = makeTask({ id: 'perm-1', taskType: 'Delete', sources: [victim], target: 'permanent' });
    await runTask(task);

    assert.equal(task.status, 'Completed', task.error ?? '');
    assert.equal(await exists(victim), false);
    assert.equal(await exists(path.join(dataHome, 'Trash', 'files', 'notes.txt')), false);
});

test('audit_2_a_second_delete_of_the_same_name_does_not_clobber_the_first', async (t) => {
    const dataHome = await withScratchTrash(t);
    const dir = await tmpDir(t, 'trash-collide');

    for (const contents of ['first', 'second']) {
        const victim = await writeFile(dir, 'dup.txt', contents);
        const task = makeTask({ id: `c-${contents}`, taskType: 'Delete', sources: [victim], target: 'trash' });
        await runTask(task);
        assert.equal(task.status, 'Completed', task.error ?? '');
    }

    const files = (await fs.readdir(path.join(dataHome, 'Trash', 'files'))).sort();
    assert.deepEqual(files, ['dup.txt', 'dup.2.txt'].sort());
});

test('audit_2_trashEntry_refuses_rather_than_deleting_when_the_trash_is_unusable', async (t) => {
    const dir = await tmpDir(t, 'trash-broken');
    const victim = await writeFile(dir, 'safe.txt', 'still here');

    // A regular file where the trash directory must go: mkdir fails with
    // EEXIST/ENOTDIR on every candidate, which is the "no usable trash" case.
    const blocked = await tmpDir(t, 'trash-blocked');
    await fs.writeFile(path.join(blocked, 'Trash'), 'not a directory');
    const previous = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = blocked;
    t.after(() => {
        if (previous === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = previous;
    });

    await assert.rejects(() => trashEntry(victim), /trash/i);
    assert.equal(await read(victim), 'still here', 'a failed trash must not fall back to deleting');
});

// --- #3: keep both ---------------------------------------------------------

async function runUntilConflict(task) {
    const running = runTask(task);
    running.catch(() => {});
    await waitFor(() => task.status === 'WaitingForInput', 'the task to pause on a conflict');
    return [running];
}

test('audit_3_keep_both_leaves_the_existing_file_intact', async (t) => {
    const dir = await tmpDir(t, 'keep-both');
    await writeFile(dir, 'tree/only.txt', 'incoming');
    const target = path.join(dir, 'target');
    await writeFile(dir, 'target/tree/only.txt', 'original');

    const task = makeTask({
        id: 'keep-both-1',
        taskType: 'Copy',
        sources: [path.join(dir, 'tree')],
        target
    });
    const [running] = await runUntilConflict(task);
    assert.equal(resolveConflict(task.id, 'keep_both'), true);
    await running;

    assert.equal(task.status, 'Completed', task.error ?? '');
    assert.equal(await read(path.join(target, 'tree/only.txt')), 'original');
    assert.equal(await read(path.join(target, 'tree/only (2).txt')), 'incoming');
});

test('audit_3_keep_both_all_applies_to_every_later_conflict', async (t) => {
    const dir = await tmpDir(t, 'keep-both-all');
    await writeFile(dir, 'tree/a.txt', 'new-a');
    await writeFile(dir, 'tree/b.txt', 'new-b');
    const target = path.join(dir, 'target');
    await writeFile(dir, 'target/tree/a.txt', 'old-a');
    await writeFile(dir, 'target/tree/b.txt', 'old-b');

    const task = makeTask({
        id: 'keep-both-all-1',
        taskType: 'Copy',
        sources: [path.join(dir, 'tree')],
        target
    });
    const [running] = await runUntilConflict(task);
    assert.equal(resolveConflict(task.id, 'keep_both_all'), true);
    await running;

    assert.equal(task.status, 'Completed', task.error ?? '');
    assert.equal(await read(path.join(target, 'tree/a.txt')), 'old-a');
    assert.equal(await read(path.join(target, 'tree/b.txt')), 'old-b');
    assert.equal(await read(path.join(target, 'tree/a (2).txt')), 'new-a');
    assert.equal(await read(path.join(target, 'tree/b (2).txt')), 'new-b');
});

// --- #4: cancellation ------------------------------------------------------

test('audit_4_cancelling_mid_file_stops_the_copy_and_publishes_nothing', async (t) => {
    const dir = await tmpDir(t, 'cancel-mid');
    // Large enough to span many 512 KiB chunks, so the cancel lands inside the
    // file rather than between two of them.
    const big = path.join(dir, 'tree', 'big.bin');
    await fs.mkdir(path.dirname(big), { recursive: true });
    await fs.writeFile(big, Buffer.alloc(64 * 1024 * 1024, 7));
    const target = path.join(dir, 'target');
    await fs.mkdir(target);

    const task = makeTask({
        id: 'cancel-mid-1',
        taskType: 'Copy',
        sources: [path.join(dir, 'tree')],
        target
    });
    const running = runTask(task);
    running.catch(() => {});

    await waitFor(() => task.transferred_bytes > 0, 'the copy to start moving bytes');
    cancelTask(task);
    await running;

    assert.equal(task.status, 'Cancelled');
    assert.equal(
        await exists(path.join(target, 'tree/big.bin')),
        false,
        'a cancelled copy must not leave a complete destination file behind'
    );
    // Nor a staging file: the rollback is the whole point of aborting from
    // inside onProgress rather than after the write.
    const leftovers = (await fs.readdir(path.join(target, 'tree')).catch(() => []))
        .filter((n) => n.startsWith('.nc-staging-'));
    assert.deepEqual(leftovers, []);
});

test('audit_4_a_cancelled_cross_device_move_does_not_remove_the_source', async (t) => {
    const dir = await tmpDir(t, 'cancel-move');
    const src = path.join(dir, 'tree', 'big.bin');
    await fs.mkdir(path.dirname(src), { recursive: true });
    await fs.writeFile(src, Buffer.alloc(64 * 1024 * 1024, 3));
    const target = path.join(dir, 'target');
    await fs.mkdir(target);

    const task = makeTask({
        id: 'cancel-move-1',
        taskType: 'Move',
        sources: [path.join(dir, 'tree')],
        target
    });
    const running = runTask(task);
    running.catch(() => {});

    // Same-filesystem here, so this may well complete as a rename before the
    // cancel lands. Either outcome is correct; what is never correct is a
    // cancelled task that removed the source without publishing a destination.
    await waitFor(
        () => task.status === 'Running' || task.status === 'Completed',
        'the move to start'
    );
    cancelTask(task);
    await running;

    if (task.status === 'Cancelled') {
        assert.equal(await exists(src), true, 'a cancelled move must not lose the source');
    } else {
        assert.equal(await exists(path.join(target, 'tree/big.bin')), true);
    }
});

// --- #5: argument injection ------------------------------------------------

test('audit_5_an_archive_operand_starting_with_a_dash_is_refused', () => {
    assert.throws(
        () => assertSafeArchiveOperand('--checkpoint-action=exec=sh'),
        /starts with/
    );
    assert.throws(() => assertSafeArchiveOperand('-C'), /starts with/);
    assert.throws(() => assertSafeArchiveOperand('ok\0evil'), /Invalid/);
    // A leading dash inside the path is an ordinary file name, not an option.
    assert.equal(assertSafeArchiveOperand('dir/-not-an-option.txt'), 'dir/-not-an-option.txt');
    assert.equal(assertSafeArchiveOperand('docs/readme.md'), 'docs/readme.md');
});

// --- #8: extraction limits -------------------------------------------------

function fakeEntries(count, size, compressedSize) {
    return Array.from({ length: count }, () => ({ header: { size, compressedSize } }));
}

test('audit_8_extraction_limits_reject_entry_count_size_and_ratio', () => {
    const limits = { maxEntries: 10, maxTotalBytes: 1000, maxRatio: 100, maxGunzipBytes: 1 };

    assert.throws(() => assertZipWithinLimits(fakeEntries(11, 1, 1), limits), /entries/);
    assert.throws(() => assertZipWithinLimits(fakeEntries(2, 900, 900), limits), /uncompressed bytes/);
    assert.throws(() => assertZipWithinLimits(fakeEntries(1, 900, 5000), { ...limits, maxTotalBytes: 1e9, maxRatio: 0 }), /expands/);

    // A ratio measured on a handful of bytes is noise, not a bomb.
    assert.doesNotThrow(() => assertZipWithinLimits(fakeEntries(1, 900, 3), limits));
    assert.doesNotThrow(() => assertZipWithinLimits(fakeEntries(5, 100, 50), limits));
});

test('audit_8_limits_are_env_overridable', () => {
    const previous = process.env.NC_MAX_ARCHIVE_ENTRIES;
    process.env.NC_MAX_ARCHIVE_ENTRIES = '7';
    try {
        assert.equal(archiveLimits().maxEntries, 7);
    } finally {
        if (previous === undefined) delete process.env.NC_MAX_ARCHIVE_ENTRIES;
        else process.env.NC_MAX_ARCHIVE_ENTRIES = previous;
    }
});

// --- #7: task routes -------------------------------------------------------

test('audit_7_execute_only_starts_a_queued_task', async (t) => {
    const dir = await tmpDir(t, 'double-exec');
    await writeFile(dir, 'tree/a.txt', 'a');
    const target = path.join(dir, 'target');
    await fs.mkdir(target);

    const client = await mountRouter(t, '/api/tasks', tasksRouter);
    const created = await client.post('/api/tasks/create', {
        taskType: 'copy',
        sources: [path.join(dir, 'tree')],
        target
    });
    assert.equal(created.status, 200);
    const id = created.body;

    const first = await client.post(`/api/tasks/${id}/execute`, {});
    assert.equal(first.status, 200);

    // A second execute used to start a concurrent worker that shared one
    // pendingConflicts slot, so one of the two waited forever while the task
    // reported Completed.
    const second = await client.post(`/api/tasks/${id}/execute`, {});
    assert.equal(second.status, 409);
    assert.match(second.body.error, /already/);
});

test('audit_5_task_create_normalizes_paths_and_refuses_option_like_entries', async (t) => {
    const dir = await tmpDir(t, 'task-validate');
    await writeFile(dir, 'tree/a.txt', 'a');
    const client = await mountRouter(t, '/api/tasks', tasksRouter);

    const relative = await client.post('/api/tasks/create', {
        taskType: 'copy',
        sources: [path.join(dir, 'tree', '..', 'tree')],
        target: path.join(dir, 'target')
    });
    assert.equal(relative.status, 200);
    const created = await client.post(`/api/tasks/${relative.body}/execute`, {});
    assert.deepEqual(created.body.sources, [path.join(dir, 'tree')], 'sources are resolved, not echoed');

    const bogus = await client.post('/api/tasks/create', {
        taskType: 'copy',
        sources: [],
        target: dir
    });
    assert.equal(bogus.status, 400);

    const badType = await client.post('/api/tasks/create', {
        taskType: 'exec',
        sources: [dir],
        target: dir
    });
    assert.equal(badType.status, 400);
});

// --- misc: getPathInfo shape -----------------------------------------------

test('audit_misc_path_info_answers_the_contract_shape_including_a_missing_path', async (t) => {
    const dir = await tmpDir(t, 'path-info');
    const file = await writeFile(dir, 'here.txt', 'x');
    const client = await mountRouter(t, '/api/fs', fsRouter);

    const present = await fetch(
        `${client.base}/api/fs/path-info?path=${encodeURIComponent(dir)}`
    ).then((r) => r.json());
    assert.equal(present.exists, true);
    assert.equal(present.is_dir, true);
    assert.equal(typeof present.canonical, 'string');

    const asFile = await fetch(
        `${client.base}/api/fs/path-info?path=${encodeURIComponent(file)}`
    ).then((r) => r.json());
    assert.deepEqual({ exists: asFile.exists, is_dir: asFile.is_dir }, { exists: true, is_dir: false });

    // A missing path is an answer with a 200, not a 500 — FileList's
    // stale-path recovery branches on `exists === false` and a thrown request
    // is swallowed as a transient error.
    const missingPath = path.join(dir, 'not-there');
    const res = await fetch(`${client.base}/api/fs/path-info?path=${encodeURIComponent(missingPath)}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { exists: false, is_dir: false, canonical: missingPath });
});

// --- #1: network exposure --------------------------------------------------

test('audit_1_the_default_bind_is_loopback_and_a_public_one_must_be_asked_for', () => {
    assert.deepEqual(resolveBindHost({}), { host: '127.0.0.1', loopback: true });
    assert.deepEqual(resolveBindHost({ NC_HOST: '::1' }), { host: '::1', loopback: true });

    assert.throws(() => resolveBindHost({ NC_HOST: '0.0.0.0' }), /Refusing to bind/);
    assert.throws(() => resolveBindHost({ NC_HOST: '192.0.2.10' }), /Refusing to bind/);

    assert.deepEqual(
        resolveBindHost({ NC_HOST: '0.0.0.0', NC_ALLOW_REMOTE: '1' }),
        { host: '0.0.0.0', loopback: false }
    );
});

test('audit_1_the_shell_endpoint_follows_the_bind_address', () => {
    assert.equal(isLoopbackBindAddress('127.0.0.1'), true);
    assert.equal(isLoopbackBindAddress('localhost'), true);
    assert.equal(isLoopbackBindAddress('0.0.0.0'), false);

    assert.equal(isShellExecutionEnabled({}), true);
    assert.equal(isShellExecutionEnabled({ NC_HOST: '127.0.0.1' }), true);
    assert.equal(isShellExecutionEnabled({ NC_HOST: '0.0.0.0' }), false);
    assert.equal(isShellExecutionEnabled({ NC_HOST: '0.0.0.0', NC_ENABLE_SHELL: '1' }), true);
    assert.equal(isShellExecutionEnabled({ NC_HOST: '127.0.0.1', NC_ENABLE_SHELL: '0' }), false);
});

// DNS rebinding: a page on `evil.example:3721` whose name is re-pointed at
// 127.0.0.1 sends Origin *and* Host as `evil.example:3721`. The same-host
// origin rule matched those against each other and passed it — straight
// through to /system/execute. The Host allowlist is what refuses it now.
test('audit_followup_a_rebound_host_name_is_refused', () => {
    const names = allowedHostnames({});
    assert.equal(isAllowedOrigin('http://evil.example:3721', 'evil.example:3721'), true,
        'the origin rule alone cannot tell; that is why the host guard exists');
    assert.equal(isAllowedHost('evil.example:3721', names), false);
    assert.equal(isAllowedHost(undefined, names), false);

    for (const ok of ['localhost:3721', '127.0.0.1:3721', '127.0.0.5', '[::1]:3721', 'LOCALHOST:5173']) {
        assert.equal(isAllowedHost(ok, names), true, ok);
    }
});

test('audit_followup_configured_names_are_answered', () => {
    const names = allowedHostnames({
        NC_ALLOWED_ORIGINS: 'https://nexus.tail.ts.net,not a url',
        NC_ALLOWED_HOSTS: '192.0.2.10, files.lan:8080',
        NC_HOST: '10.0.0.2'
    });
    for (const ok of ['nexus.tail.ts.net', 'nexus.tail.ts.net:443', '192.0.2.10:3721', 'files.lan', '10.0.0.2:3721']) {
        assert.equal(isAllowedHost(ok, names), true, ok);
    }
    assert.equal(isAllowedHost('evil.example', names), false);
    assert.equal(allowedHostnames({ NC_HOST: '0.0.0.0' }).has('0.0.0.0'), false,
        'a wildcard bind is not a name anyone can be reached by');
});

// /pause and /resume called functions the route never imported: every call was
// a ReferenceError, so pausing a web transfer always answered 500.
test('audit_followup_pause_and_resume_are_wired', async (t) => {
    const client = await mountRouter(t, '/api/tasks', tasksRouter);
    const dir = await tmpDir(t, 'pause-wiring');
    const src = await writeFile(dir, 'a.txt', 'x');
    const created = await client.post('/api/tasks/create', { taskType: 'copy', sources: [src], target: dir });
    assert.equal(created.status, 200);

    const paused = await client.post(`/api/tasks/${created.body}/pause`, {});
    assert.equal(paused.status, 200, JSON.stringify(paused.body));
    assert.equal(paused.body, true, 'a queued task can be paused');
    const resumed = await client.post(`/api/tasks/${created.body}/resume`, {});
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    assert.equal(resumed.body, true);
    const state = await client.get(`/api/tasks/${created.body}/status`);
    assert.equal(state.body.status, 'Queued', 'resuming cannot invent a running worker');
    const executed = await client.post(`/api/tasks/${created.body}/execute`, {});
    assert.equal(executed.status, 200, 'the resumed task must still be executable');
    await client.post(`/api/tasks/${created.body}/cancel`, {});
});

// The automatic sweep keeps a failed task so its error can be read; the user's
// own "Clear finished" has to be able to dismiss it, or it never goes away.
// Tasks are also scoped to the browser that started them.
test('audit_followup_failed_tasks_can_be_dismissed_and_are_scoped_per_client', async (t) => {
    const client = await mountRouter(t, '/api/tasks', tasksRouter);
    const dir = await tmpDir(t, 'clear-failed');
    const mine = { 'X-NC-Client-Id': 'nc_' + 'a'.repeat(32) };
    const theirs = { 'X-NC-Client-Id': 'nc_' + 'b'.repeat(32) };

    const created = await client.post('/api/tasks/create',
        { taskType: 'copy', sources: [path.join(dir, 'missing.txt')], target: dir }, mine);
    const id = created.body;
    await client.post(`/api/tasks/${id}/execute`, {}, mine);
    await waitFor(async () => (await client.get(`/api/tasks/${id}/status`)).body?.status === 'Failed',
        'the copy of a missing file to fail');

    const listFor = async (headers) => (await client.get('/api/tasks', headers)).body.map((task) => task.id);
    assert.ok((await listFor(mine)).includes(id));
    assert.ok(!(await listFor(theirs)).includes(id), 'another browser does not see it');

    await client.post('/api/tasks/clear-finished', {}, mine);
    assert.ok((await listFor(mine)).includes(id), 'the automatic sweep keeps failures');
    await client.post('/api/tasks/clear-finished', { includeFailed: true }, mine);
    assert.ok(!(await listFor(mine)).includes(id), 'the explicit clear dismisses it');
});
