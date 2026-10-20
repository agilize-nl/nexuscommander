// Fase 1b, item 1 (P1b.0) — what `lib/taskExecutor.js` does *today*.
//
// Group prefixes carry the contract; see the header of
// `fileops.characterization.test.js`.
//
// These drive the same task object `routes/tasks.js` constructs, because the
// executor's whole observable contract is the mutation it performs plus the
// fields it leaves on that object. A test against a convenient subset would not
// notice `status` going to `Completed` for an operation that copied nothing,
// which is exactly the finding P1b.4 closes.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';

import { runTask, cancelTask, resolveConflict } from '../lib/taskExecutor.js';
import { tmpDir, writeFile, read, exists, waitFor, makeTask } from './helpers.js';

/**
 * Runs a task and waits for the conflict pause it is expected to reach.
 *
 * Returns the in-flight `runTask` promise wrapped in a single-element array.
 * An async function that resolves with a thenable has that thenable
 * assimilated (awaited) as part of the Promise spec's resolution procedure —
 * returning `running` directly here would make this function wait for the
 * task to finish before it could hand the still-pending promise back, which
 * deadlocks every caller that cancels or resolves the conflict afterward.
 */
async function runUntilConflict(task) {
    const running = runTask(task);
    running.catch(() => {});
    await waitFor(() => task.status === 'WaitingForInput', 'the task to pause on a conflict');
    return [running];
}

test('invariant_a_copy_task_transfers_the_tree_and_reports_its_totals', async (t) => {
    const dir = await tmpDir(t, 'task-copy');
    await writeFile(dir, 'tree/a.txt', 'aaaa');
    await writeFile(dir, 'tree/b.txt', 'bb');
    const target = path.join(dir, 'target');
    await fs.mkdir(target);

    const task = makeTask({
        id: 'copy-totals',
        taskType: 'Copy',
        sources: [path.join(dir, 'tree')],
        target
    });
    await runTask(task);

    assert.equal(task.status, 'Completed');
    assert.equal(task.total_files, 2);
    assert.equal(task.processed_files, 2);
    assert.equal(task.total_bytes, 6);
    assert.equal(task.transferred_bytes, 6);
    assert.equal(await read(path.join(target, 'tree/a.txt')), 'aaaa');
});

test('invariant_cancelling_during_a_conflict_wait_leaves_the_destination_untouched', async (t) => {
    const dir = await tmpDir(t, 'task-cancel');
    await writeFile(dir, 'tree/only.txt', 'new');
    const target = path.join(dir, 'target');
    await writeFile(dir, 'target/tree/only.txt', 'original');

    const task = makeTask({
        id: 'cancel-on-conflict',
        taskType: 'Copy',
        sources: [path.join(dir, 'tree')],
        target
    });
    const [running] = await runUntilConflict(task);

    cancelTask(task);
    await running;

    assert.equal(task.status, 'Cancelled');
    assert.equal(await read(path.join(target, 'tree/only.txt')), 'original');
    assert.equal(await read(path.join(dir, 'tree/only.txt')), 'new');
});

test('invariant_cancelling_a_move_during_a_conflict_wait_leaves_the_source_in_place', async (t) => {
    const dir = await tmpDir(t, 'task-cancel-move');
    await writeFile(dir, 'tree/only.txt', 'new');
    const target = path.join(dir, 'target');
    await writeFile(dir, 'target/tree/only.txt', 'original');

    const task = makeTask({
        id: 'cancel-on-conflict-move',
        taskType: 'Move',
        sources: [path.join(dir, 'tree')],
        target
    });
    const [running] = await runUntilConflict(task);

    cancelTask(task);
    await running;

    assert.equal(task.status, 'Cancelled');
    assert.equal(await read(path.join(dir, 'tree/only.txt')), 'new');
    assert.equal(await read(path.join(target, 'tree/only.txt')), 'original');
});

test('invariant_an_overwrite_resolution_replaces_only_the_file_it_was_asked_about', async (t) => {
    const dir = await tmpDir(t, 'task-overwrite');
    await writeFile(dir, 'tree/only.txt', 'new');
    const target = path.join(dir, 'target');
    await writeFile(dir, 'target/tree/only.txt', 'original');
    await writeFile(dir, 'target/tree/bystander.txt', 'untouched');

    const task = makeTask({
        id: 'overwrite',
        taskType: 'Copy',
        sources: [path.join(dir, 'tree')],
        target
    });
    const [running] = await runUntilConflict(task);

    assert.equal(resolveConflict(task.id, 'overwrite'), true);
    await running;

    assert.equal(await read(path.join(target, 'tree/only.txt')), 'new');
    assert.equal(await read(path.join(target, 'tree/bystander.txt')), 'untouched');
});

test('invariant_delete_reads_its_mode_from_target_the_way_the_desktop_queue_does', async (t) => {
    // Was `invariant_delete_is_permanent_because_this_backend_has_no_trash`.
    // The backend now has a trash (commit.js::trashEntry) and reads the mode
    // out of `target`, which is the convention `task_queue.rs::execute_delete`
    // has always used. `routes/tasks.js` normalises anything that is not
    // "permanent" to "trash", so this — a raw executor call with the old empty
    // target — is the only way to reach the permanent path without asking for
    // it, and it stays permanent so the desktop and web meanings of the field
    // agree. The desktop invariant still holds on both: a failed trash delete
    // never silently becomes a permanent one.
    const dir = await tmpDir(t, 'task-delete');
    await writeFile(dir, 'tree/a.txt', 'a');

    const task = makeTask({
        id: 'delete',
        taskType: 'Delete',
        sources: [path.join(dir, 'tree')],
        target: 'permanent'
    });
    await runTask(task);

    assert.equal(task.status, 'Completed');
    assert.equal(await exists(path.join(dir, 'tree')), false);
});

// ---------------------------------------------------------------------------
// untransactional_* — today's damage. P1b.3/P1b.4 flip these.
// ---------------------------------------------------------------------------

test('untransactional_a_task_that_copied_nothing_still_reports_completed', async (t) => {
    // `runTask` sets `Completed` for anything that does not throw
    // (`taskExecutor.js:53`), so a run in which every single entry was skipped is
    // indistinguishable from one that transferred the whole tree.
    //
    // Flips in P1b.4: the task carries a CommitOutcome, and `skipped` is its own
    // state with a reason.
    const dir = await tmpDir(t, 'task-skip');
    await writeFile(dir, 'tree/only.txt', 'new');
    const target = path.join(dir, 'target');
    await writeFile(dir, 'target/tree/only.txt', 'original');

    const task = makeTask({
        id: 'skip-everything',
        taskType: 'Copy',
        sources: [path.join(dir, 'tree')],
        target
    });
    const [running] = await runUntilConflict(task);

    assert.equal(resolveConflict(task.id, 'skip'), true);
    await running;

    assert.equal(task.status, 'Completed');
    assert.equal(task.processed_files, 1, 'the skipped entry is counted as processed');
    assert.equal(await read(path.join(target, 'tree/only.txt')), 'original');
    assert.equal(
        task.outcome,
        undefined,
        'characterizing today: no CommitOutcome is produced (flips in P1b.4)'
    );
});

test('untransactional_a_failed_task_reports_prose_and_no_structured_outcome', async (t) => {
    // A failure is a status plus a string. Nothing says whether the destination
    // survived, which is the question that actually matters after a failed
    // mutation.
    //
    // Flips in P1b.4: `rolled_back` / `manual_recovery_required` say it, and
    // `destination_preserved` is answerable without parsing English.
    const dir = await tmpDir(t, 'task-fail');
    const task = makeTask({
        id: 'fail',
        taskType: 'Copy',
        sources: [path.join(dir, 'no-such-tree')],
        target: dir
    });
    await runTask(task);

    assert.equal(task.status, 'Failed');
    assert.equal(typeof task.error, 'string');
    assert.equal(
        task.outcome,
        undefined,
        'characterizing today: no CommitOutcome is produced (flips in P1b.4)'
    );
});

test('untransactional_a_partially_copied_tree_is_reported_as_a_plain_failure', async (t) => {
    // Two entries, the second of which conflicts and is refused: the first is
    // already published and there is no record of that. The desktop engine
    // answers this case with `partially_committed { journal }`.
    //
    // Flips in P1b.4.
    const dir = await tmpDir(t, 'task-partial');
    await writeFile(dir, 'first/a.txt', 'a');
    await writeFile(dir, 'second/b.txt', 'b');
    const target = path.join(dir, 'target');
    await writeFile(dir, 'target/second/b.txt', 'original');

    const task = makeTask({
        id: 'partial',
        taskType: 'Copy',
        // Source order is the loop order, so which half lands is deterministic.
        sources: [path.join(dir, 'first'), path.join(dir, 'second')],
        target
    });
    const [running] = await runUntilConflict(task);

    assert.equal(resolveConflict(task.id, 'skip'), true);
    await running;

    assert.equal(await read(path.join(target, 'first/a.txt')), 'a', 'the first source landed');
    assert.equal(await read(path.join(target, 'second/b.txt')), 'original');
    assert.equal(task.status, 'Completed');
    assert.equal(
        task.outcome,
        undefined,
        'characterizing today: a half-applied operation is reported as success (flips in P1b.4)'
    );
});

// A permanent delete of a folder in a read-only parent used to run
// `fs.rm(recursive)` anyway: every file inside was gone before the folder
// itself failed with EACCES. It must refuse up front, name the blocking
// directory, and classify the failure so the UI can offer elevation.
test('invariant_a_permanent_delete_blocked_by_its_parent_deletes_nothing', { skip: process.geteuid?.() === 0 }, async (t) => {
    const dir = await tmpDir(t, 'task-delete-locked');
    await writeFile(dir, 'locked/folder/nested/a.txt', 'keep me');
    const parent = path.join(dir, 'locked');
    await fs.chmod(parent, 0o555);
    t.after(() => fs.chmod(parent, 0o755));

    const task = makeTask({
        id: 'delete-locked-parent',
        taskType: 'Delete',
        sources: [path.join(parent, 'folder')],
        target: 'permanent'
    });
    await runTask(task);

    assert.equal(task.status, 'Failed');
    assert.equal(task.error_kind, 'permission_denied');
    assert.equal(task.error_path, parent);
    assert.equal(await read(path.join(parent, 'folder/nested/a.txt')), 'keep me');
});
