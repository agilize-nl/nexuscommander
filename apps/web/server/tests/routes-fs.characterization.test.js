// Fase 1b, item 1 (P1b.0) — the HTTP mutation contract of `/api/fs`, today.
//
// The route layer is characterized separately from `lib/fileOps.js` because it
// is the layer P1b.4 changes: the same filesystem behaviour, answered with a
// CommitOutcome instead of a bare boolean. Pinning the current answers here is
// what makes that commit read as a contract change rather than as noise.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';

import fsRoutes from '../routes/fs.js';
import { tmpDir, writeFile, read, exists, mountRouter } from './helpers.js';

async function api(t) {
    return mountRouter(t, '/api/fs', fsRoutes);
}

test('invariant_copy_refuses_an_existing_destination_and_leaves_it_intact', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'route-copy');
    await writeFile(dir, 'tree/a.txt', 'new');
    const target = path.join(dir, 'target');
    await writeFile(dir, 'target/tree/a.txt', 'original');

    const { status, body } = await client.post('/api/fs/copy', {
        sources: [path.join(dir, 'tree')],
        targetDir: target
    });

    assert.equal(status, 200);
    assert.equal(body[0].success, false);
    assert.equal(await read(path.join(target, 'tree/a.txt')), 'original');
});

test('invariant_single_file_copy_refuses_an_existing_destination_and_leaves_it_intact', async (t) => {
    // The single-source `{ src, dst }` branch, as opposed to the array
    // `{ sources, targetDir }` branch above — it used to gate on `fs.access`
    // before calling `copyOneFile`, a separate check-then-act than the one
    // `copyFileStaged`'s own `Replace.Never` now performs atomically.
    const client = await api(t);
    const dir = await tmpDir(t, 'route-copy-single');
    await writeFile(dir, 'src.txt', 'new');
    await writeFile(dir, 'dst.txt', 'original');

    const { status, body } = await client.post('/api/fs/copy', {
        src: path.join(dir, 'src.txt'),
        dst: path.join(dir, 'dst.txt')
    });

    assert.equal(status, 200);
    assert.equal(body.success, false);
    assert.equal(await read(path.join(dir, 'dst.txt')), 'original');
});

test('invariant_single_file_copy_to_a_free_destination_succeeds', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'route-copy-single-ok');
    await writeFile(dir, 'src.txt', 'payload');

    const { status, body } = await client.post('/api/fs/copy', {
        src: path.join(dir, 'src.txt'),
        dst: path.join(dir, 'dst.txt')
    });

    assert.equal(status, 200);
    assert.deepEqual(body, { success: true, message: 'OK' });
    assert.equal(await read(path.join(dir, 'dst.txt')), 'payload');
});

test('invariant_copy_with_conflict_policy_keep_both_picks_a_free_name', async (t) => {
    // ipc-contract.ts's ConflictPolicy — reachable through the wire now,
    // not just as an internal fileOps.js parameter nothing ever passed.
    const client = await api(t);
    const dir = await tmpDir(t, 'route-copy-keep-both');
    await writeFile(dir, 'tree/a.txt', 'new');
    const target = path.join(dir, 'target');
    await writeFile(dir, 'target/tree/a.txt', 'original');

    const { status, body } = await client.post('/api/fs/copy', {
        sources: [path.join(dir, 'tree')],
        targetDir: target,
        conflictPolicy: 'keep_both'
    });

    assert.equal(status, 200);
    assert.equal(body[0].success, true);
    assert.equal(await read(path.join(target, 'tree/a.txt')), 'original', 'the conflicting file must be untouched');
    assert.equal(await read(path.join(target, 'tree/a (2).txt')), 'new', 'the new content lands under a free name');
});

test('invariant_move_with_conflict_policy_skip_leaves_both_sides_alone', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'route-move-skip');
    await writeFile(dir, 'tree/only.txt', 'new');
    const target = path.join(dir, 'target');
    await writeFile(dir, 'target/tree/only.txt', 'original');

    const { status, body } = await client.post('/api/fs/move', {
        sources: [path.join(dir, 'tree')],
        targetDir: target,
        conflictPolicy: 'skip'
    });

    assert.equal(status, 200);
    assert.equal(body[0].success, true);
    assert.equal(await read(path.join(target, 'tree/only.txt')), 'original');
    assert.equal(await read(path.join(dir, 'tree/only.txt')), 'new', 'a skipped source file is not removed');
});

test('invariant_an_unrecognized_conflict_policy_keeps_the_default_refuse_behavior', async (t) => {
    // "ask" and "merge" are valid ConflictPolicy values this synchronous route
    // cannot act on (no per-file round trip here); they must not be silently
    // reinterpreted as anything more permissive than the existing default.
    const client = await api(t);
    const dir = await tmpDir(t, 'route-copy-ask-falls-back');
    await writeFile(dir, 'tree/a.txt', 'new');
    const target = path.join(dir, 'target');
    await writeFile(dir, 'target/tree/a.txt', 'original');

    const { body } = await client.post('/api/fs/copy', {
        sources: [path.join(dir, 'tree')],
        targetDir: target,
        conflictPolicy: 'ask'
    });

    assert.equal(body[0].success, false);
    assert.equal(await read(path.join(target, 'tree/a.txt')), 'original');
});

test('invariant_rename_falls_back_to_a_staged_copy_across_devices', {
    skip: process.env.NC_XDEV_DIR ? false : 'set NC_XDEV_DIR to a directory on a different filesystem to run this'
}, async (t) => {
    // A bare fs.rename had no answer for EXDEV at all — it just threw and the
    // route returned a 500. moveEntryStaged's fallback makes a cross-device
    // rename work the way a same-filesystem one already did.
    const client = await api(t);
    const dir = await tmpDir(t, 'route-rename-xdev');
    const other = await fs.mkdtemp(path.join(process.env.NC_XDEV_DIR, 'nc-web-rename-xdev-'));
    t.after(async () => {
        await fs.rm(other, { recursive: true, force: true }).catch(() => {});
    });
    await writeFile(dir, 'src.txt', 'payload');

    const { status, body } = await client.post('/api/fs/rename', {
        from: path.join(dir, 'src.txt'),
        to: path.join(other, 'dst.txt')
    });

    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(await read(path.join(other, 'dst.txt')), 'payload');
    assert.equal(await exists(path.join(dir, 'src.txt')), false);
});

test('invariant_delete_refuses_a_protected_root', async (t) => {
    const client = await api(t);

    const { status, body } = await client.post('/api/fs/delete', { path: '/etc' });

    assert.equal(status, 400);
    assert.match(body.error, /protected path/i);
    assert.equal(await exists('/etc'), true);
});

test('invariant_rename_refuses_a_protected_root', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'route-rename-protected');

    const { status, body } = await client.post('/api/fs/rename', {
        from: '/etc',
        to: path.join(dir, 'etc')
    });

    assert.equal(status, 400);
    assert.match(body.error, /protected path/i);
    assert.equal(await exists('/etc'), true);
});

test('invariant_mkdir_creates_the_directory_and_is_idempotent', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'route-mkdir');
    const target = path.join(dir, 'a/b/c');

    const first = await client.post('/api/fs/mkdir', { path: target });
    const second = await client.post('/api/fs/mkdir', { path: target });

    assert.equal(first.body.success, true);
    assert.equal(second.body.success, true);
    assert.equal((await fs.stat(target)).isDirectory(), true);
});

test('invariant_text_write_refuses_a_binary_file', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'route-text-binary');
    const target = await writeFile(dir, 'blob.bin', Buffer.from([0, 1, 2, 0, 3]));

    const { status } = await client.put(
        `/api/fs/text?path=${encodeURIComponent(target)}`,
        { text: 'hello' }
    );

    assert.equal(status, 400);
    assert.deepEqual([...(await fs.readFile(target))], [0, 1, 2, 0, 3]);
});

// ---------------------------------------------------------------------------
// untransactional_* — today's answers. P1b.3/P1b.4 flip these.
// ---------------------------------------------------------------------------

test('untransactional_a_successful_copy_answers_with_a_bare_boolean', async (t) => {
    // `{ success, message }` and nothing else: no operation kind, no durability
    // claim, no outcome. The UI can display this and reason about none of it.
    //
    // Flips in P1b.4: `outcome` is present and `success` is derived from it.
    const client = await api(t);
    const dir = await tmpDir(t, 'route-copy-ok');
    await writeFile(dir, 'tree/a.txt', 'a');
    const target = path.join(dir, 'target');
    await fs.mkdir(target);

    const { body } = await client.post('/api/fs/copy', {
        sources: [path.join(dir, 'tree')],
        targetDir: target
    });

    assert.deepEqual(body, [{ success: true, message: 'OK' }]);
});

test('untransactional_move_answers_per_source_with_no_aggregate_outcome', async (t) => {
    // Two sources, one of which conflicts: the response is a bag of booleans in
    // request order. Nothing states that the operation as a whole is half
    // applied, which is what `partially_committed { journal }` exists to say.
    //
    // Flips in P1b.4.
    const client = await api(t);
    const dir = await tmpDir(t, 'route-move-partial');
    await writeFile(dir, 'first/a.txt', 'a');
    await writeFile(dir, 'second/b.txt', 'b');
    const target = path.join(dir, 'target');
    await writeFile(dir, 'target/second/b.txt', 'original');

    const { body } = await client.post('/api/fs/move', {
        sources: [path.join(dir, 'first'), path.join(dir, 'second')],
        targetDir: target
    });

    assert.equal(body.length, 2);
    assert.equal(body[0].success, true);
    assert.equal(body[1].success, false);
    assert.equal(await exists(path.join(dir, 'first')), false, 'the first source was moved');
    assert.equal(await read(path.join(dir, 'second/b.txt')), 'b', 'the second was not');
    assert.equal(
        body.outcome,
        undefined,
        'characterizing today: the array has no aggregate outcome (flips in P1b.4)'
    );
});

test('invariant_delete_names_which_of_its_two_meanings_it_performed', async (t) => {
    // Was `untransactional_delete_is_immediate_permanent_and_unqualified`: this
    // route answered `{ success: true }` for an irreversible operation, and it
    // performed that irreversible operation no matter what the caller asked
    // for. The 2026-08-10 audit's finding #2 is the consequence — the shared
    // dialog says "move to trash" and this is what it reached.
    //
    // Now: trash is the default (matching the desktop adapter's
    // `DeleteMode.Trash`), permanent has to be named, and the message says
    // which one happened rather than leaving the caller to assume.
    const client = await api(t);
    const dir = await tmpDir(t, 'route-delete');

    const permanent = await writeFile(dir, 'doomed.txt', 'bye');
    const gone = await client.post('/api/fs/delete', { path: permanent, mode: 'permanent' });
    assert.equal(gone.body.success, true);
    assert.match(gone.body.message, /^Deleted permanently: /);
    assert.equal(await exists(permanent), false);

    // The default is recoverable, so it is checked against a scratch trash
    // rather than the developer's real one.
    const trashHome = await tmpDir(t, 'route-delete-trash');
    const previous = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = trashHome;
    t.after(() => {
        if (previous === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = previous;
    });

    const recoverable = await writeFile(dir, 'oops.txt', 'wanted');
    const trashed = await client.post('/api/fs/delete', { path: recoverable });
    assert.equal(trashed.body.success, true);
    assert.match(trashed.body.message, /^Moved to trash: /);
    assert.equal(await exists(recoverable), false);
    assert.equal(await read(path.join(trashHome, 'Trash', 'files', 'oops.txt')), 'wanted');
});

test('invariant_text_write_reports_the_durability_it_actually_achieved', async (t) => {
    // P1b.3: staged write, atomic rename, and the message phrased from the
    // durability tier that was actually achieved — never the unconditional
    // "Saved" a bare fs.writeFile used to claim regardless of what happened.
    const client = await api(t);
    const dir = await tmpDir(t, 'route-text');
    const target = await writeFile(dir, 'note.txt', 'original');

    const { body } = await client.put(
        `/api/fs/text?path=${encodeURIComponent(target)}`,
        { text: 'replacement' }
    );

    assert.equal(body.success, true);
    assert.equal(body.message, 'written and durable');
    assert.equal(await read(target), 'replacement');
});

// The inline rename has no conflict dialog. It used to take moveEntryStaged's
// default and replace an existing file: renaming a.txt to b.txt destroyed b.txt.
test('invariant_rename_never_replaces_an_existing_file', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'route-rename-exists');
    const from = await writeFile(dir, 'a.txt', 'from a');
    const to = await writeFile(dir, 'b.txt', 'precious b');

    const { status, body } = await client.post('/api/fs/rename', { from, to });

    assert.equal(status, 409, JSON.stringify(body));
    assert.equal(body.kind, 'destination_exists');
    assert.equal(await read(to), 'precious b');
    assert.equal(await read(from), 'from a');
});

test('invariant_rename_to_a_free_name_still_works', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'route-rename-free');
    const from = await writeFile(dir, 'a.txt', 'content');
    const to = path.join(dir, 'c.txt');

    const { status } = await client.post('/api/fs/rename', { from, to });

    assert.equal(status, 200);
    assert.equal(await read(to), 'content');
    assert.equal(await exists(from), false);
});

// /api/fs/raw serves files inline on the app's own origin. An HTML or SVG file
// opened through it must not be able to run script against the API.
test('invariant_raw_sandboxes_active_content', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'route-raw-active');
    const html = await writeFile(dir, 'page.html', '<script>alert(1)</script>');
    const png = await writeFile(dir, 'image.png', 'not really a png');

    const active = await fetch(`${client.base}/api/fs/raw?path=${encodeURIComponent(html)}`);
    assert.equal(active.headers.get('content-security-policy'), 'sandbox');
    assert.equal(active.headers.get('x-content-type-options'), 'nosniff');
    await active.arrayBuffer();

    const passive = await fetch(`${client.base}/api/fs/raw?path=${encodeURIComponent(png)}`);
    assert.equal(passive.headers.get('content-security-policy'), null, 'images and PDFs must still render');
    assert.equal(passive.headers.get('x-content-type-options'), 'nosniff');
    await passive.arrayBuffer();
});
