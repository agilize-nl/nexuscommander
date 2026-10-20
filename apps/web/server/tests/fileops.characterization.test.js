// Fase 1b, item 1 (P1b.0) — what `lib/fileOps.js` does *today*.
//
// Two groups, and the prefix is the contract:
//
//   invariant_*        must stay true through the whole phase. Red means the
//                      rewrite broke something a user relies on.
//   untransactional_*  documents damage the current implementation causes. Each
//                      one names the item that flips it. Red *after* that item
//                      is the change arriving; update the assertion in the same
//                      commit that changes the behaviour, never ahead of it.
//
// On fault injection: the desktop suite reached mid-write failures with a
// `fault_at!` macro compiled into the engine (P1.4). The web equivalent belongs
// with `lib/commit.js` (P1b.1), which will take an injectable sink. Until then
// the failures below are reached the honest way — an unreadable source and a
// blocking FIFO — both of which are enough to pin the *ordering* claim that
// matters: the destination is destroyed before the source is known to be
// readable at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';

import {
    copyOneFile,
    copySourceSync,
    moveSourceSync,
    collectEntries,
    pruneEmptyDirs
} from '../lib/fileOps.js';
import {
    tmpDir,
    writeFile,
    read,
    exists,
    waitFor,
    makeFifo,
    openFifoWriter
} from './helpers.js';

test('invariant_copy_to_a_free_destination_preserves_content_mode_and_mtime', async (t) => {
    const dir = await tmpDir(t, 'copy-free');
    const src = await writeFile(dir, 'src.txt', 'payload');
    await fs.chmod(src, 0o640);
    const when = new Date('2020-01-02T03:04:05Z');
    await fs.utimes(src, when, when);

    const dst = path.join(dir, 'out', 'src.txt');
    await copyOneFile(src, dst);

    assert.equal(await read(dst), 'payload');
    const stat = await fs.stat(dst);
    assert.equal(stat.mode & 0o777, 0o640);
    assert.equal(Math.floor(stat.mtimeMs / 1000), Math.floor(when.getTime() / 1000));
});

test('invariant_copy_reports_progress_for_every_byte_it_transfers', async (t) => {
    const dir = await tmpDir(t, 'copy-progress');
    const src = await writeFile(dir, 'src.bin', Buffer.alloc(200_000, 7));

    let reported = 0;
    await copyOneFile(src, path.join(dir, 'out.bin'), (n) => {
        reported += n;
    });

    assert.equal(reported, 200_000);
});

test('invariant_copying_a_directory_merges_into_a_populated_destination', async (t) => {
    const dir = await tmpDir(t, 'copy-merge');
    await writeFile(dir, 'tree/a.txt', 'a');
    await writeFile(dir, 'tree/nested/b.txt', 'b');
    const target = path.join(dir, 'target');
    await writeFile(dir, 'target/tree/existing.txt', 'keep me');

    const result = await copySourceSync(path.join(dir, 'tree'), target);

    assert.equal(result.success, true);
    assert.equal(await read(path.join(target, 'tree/a.txt')), 'a');
    assert.equal(await read(path.join(target, 'tree/nested/b.txt')), 'b');
    // Merging must not be a synonym for replacing the directory.
    assert.equal(await read(path.join(target, 'tree/existing.txt')), 'keep me');
});

test('invariant_an_existing_file_destination_is_not_overwritten_by_a_directory_copy', async (t) => {
    const dir = await tmpDir(t, 'copy-conflict');
    await writeFile(dir, 'tree/a.txt', 'new');
    const target = path.join(dir, 'target');
    await writeFile(dir, 'target/tree/a.txt', 'original');

    const result = await copySourceSync(path.join(dir, 'tree'), target);

    // The *shape* of this answer changes in P1b.4 (it becomes a CommitOutcome
    // and an explicit conflict policy). The byte-level claim below may not:
    // nothing may destroy an existing destination without being asked to.
    assert.equal(result.success, false);
    assert.equal(await read(path.join(target, 'tree/a.txt')), 'original');
});

test('invariant_a_conflicting_copy_stops_before_it_touches_the_conflicting_file', async (t) => {
    const dir = await tmpDir(t, 'copy-conflict-only');
    await writeFile(dir, 'tree/only.txt', 'new');
    const target = path.join(dir, 'target');
    await writeFile(dir, 'target/tree/only.txt', 'original');

    await copySourceSync(path.join(dir, 'tree'), target);

    assert.equal(await read(path.join(target, 'tree/only.txt')), 'original');
    assert.equal(await read(path.join(dir, 'tree/only.txt')), 'new');
});

test('invariant_move_relocates_a_tree_and_prunes_the_emptied_source', async (t) => {
    const dir = await tmpDir(t, 'move-tree');
    await writeFile(dir, 'tree/a.txt', 'a');
    await writeFile(dir, 'tree/nested/b.txt', 'b');
    const target = path.join(dir, 'target');
    await fs.mkdir(target);

    const result = await moveSourceSync(path.join(dir, 'tree'), target);

    assert.equal(result.success, true);
    assert.equal(await read(path.join(target, 'tree/a.txt')), 'a');
    assert.equal(await read(path.join(target, 'tree/nested/b.txt')), 'b');
    assert.equal(await exists(path.join(dir, 'tree')), false);
});

test('invariant_a_conflicting_move_leaves_the_source_where_it_was', async (t) => {
    const dir = await tmpDir(t, 'move-conflict');
    await writeFile(dir, 'tree/only.txt', 'new');
    const target = path.join(dir, 'target');
    await writeFile(dir, 'target/tree/only.txt', 'original');

    const result = await moveSourceSync(path.join(dir, 'tree'), target);

    assert.equal(result.success, false);
    assert.equal(await read(path.join(dir, 'tree/only.txt')), 'new');
    assert.equal(await read(path.join(target, 'tree/only.txt')), 'original');
});

test('invariant_collect_entries_includes_empty_directories_so_they_get_recreated', async (t) => {
    const dir = await tmpDir(t, 'collect');
    await writeFile(dir, 'tree/a.txt', 'a');
    await fs.mkdir(path.join(dir, 'tree/empty'), { recursive: true });

    const entries = await collectEntries(path.join(dir, 'tree'));
    const rels = entries.map((e) => e.rel).sort();

    assert.deepEqual(rels, ['tree/a.txt', 'tree/empty']);
    assert.equal(entries.find((e) => e.rel === 'tree/empty').isDir, true);
});

test('invariant_prune_empty_dirs_leaves_a_directory_that_still_has_content', async (t) => {
    const dir = await tmpDir(t, 'prune');
    await writeFile(dir, 'tree/keep/a.txt', 'a');
    await fs.mkdir(path.join(dir, 'tree/gone'), { recursive: true });

    await pruneEmptyDirs(path.join(dir, 'tree'));

    assert.equal(await exists(path.join(dir, 'tree/gone')), false);
    assert.equal(await read(path.join(dir, 'tree/keep/a.txt')), 'a');
});

// ---------------------------------------------------------------------------
// P1b.3 flipped these from untransactional_* to invariant_*: copyOneFile now
// routes through lib/commit.js's copyFileStaged rather than
// `createWriteStream(dest)`, which used to truncate the destination the
// moment it opened (QSF-001). Kept in this file rather than moved to
// commit.test.js because they pin the *fileOps.js call site's* behavior, not
// the primitive in isolation.
// ---------------------------------------------------------------------------

test('invariant_an_unreadable_source_leaves_the_destination_untouched', async (t) => {
    const dir = await tmpDir(t, 'truncate-enoent');
    const dst = await writeFile(dir, 'dst.txt', 'IMPORTANT');

    await assert.rejects(() => copyOneFile(path.join(dir, 'no-such-file'), dst));

    assert.equal(await read(dst), 'IMPORTANT', 'the destination must survive a source that never existed');
});

test('invariant_the_destination_is_never_truncated_before_the_copy_commits', async (t) => {
    // A FIFO source blocks the reader until something opens the write end, so
    // this observes the whole window during which a copy is in flight —
    // exactly the window QSF-001 used to destroy the destination in.
    const dir = await tmpDir(t, 'truncate-fifo');
    const fifo = await makeFifo(dir, 'source.fifo');
    if (!fifo) {
        t.skip('mkfifo unavailable');
        return;
    }

    const dst = await writeFile(dir, 'dst.txt', 'IMPORTANT');

    // `copyOneFile` opens the FIFO for read before anything else, and that
    // open blocks until a writer exists — so the writer-open must start
    // concurrently (never awaited first) or the two ends deadlock waiting on
    // each other. Once both are in flight the rendezvous completes and the
    // reader's open resolves, but its first *read* still blocks until the
    // writer actually writes, which is the window this test observes.
    const writerPromise = openFifoWriter(fifo);
    const copying = copyOneFile(fifo, dst);
    // A failed assertion below must not leave the reader blocked on a FIFO
    // nobody ever writes to — that turns a test failure into a hung run.
    copying.catch(() => {});
    const writer = await writerPromise;

    try {
        await waitFor(
            async () => (await fs.readdir(dir)).some((n) => n.startsWith('.nc-staging-')),
            'a staging file to appear beside the destination'
        );
        assert.equal(await read(dst), 'IMPORTANT', 'the destination must hold its old content throughout the copy');
    } finally {
        await writer.write('replacement').catch(() => {});
        await writer.close().catch(() => {});
    }

    await copying;
    assert.equal(await read(dst), 'replacement');
});

test('invariant_a_copy_in_flight_is_invisible_at_the_final_destination', async (t) => {
    // The in-flight bytes live in a staging file; the final name only ever
    // shows the complete content, published in one atomic rename.
    const dir = await tmpDir(t, 'staging-hidden');
    const fifo = await makeFifo(dir, 'source.fifo');
    if (!fifo) {
        t.skip('mkfifo unavailable');
        return;
    }

    const dst = path.join(dir, 'out.txt');
    const writerPromise = openFifoWriter(fifo);
    const copying = copyOneFile(fifo, dst);
    copying.catch(() => {});
    const writer = await writerPromise;

    try {
        await waitFor(
            async () => (await fs.readdir(dir)).some((n) => n.startsWith('.nc-staging-')),
            'the staging file to appear'
        );
        assert.equal(await exists(dst), false, 'the final name must not appear until the copy commits');
    } finally {
        await writer.write('done').catch(() => {});
        await writer.close().catch(() => {});
    }

    await copying;
    assert.equal(await read(dst), 'done');
});

test('invariant_a_failed_copy_leaves_no_output_behind', async (t) => {
    const dir = await tmpDir(t, 'partial-rolled-back');
    const srcDir = path.join(dir, 'a-directory');
    await fs.mkdir(srcDir);
    const dst = path.join(dir, 'out.txt');

    // A directory source fails on read *after* staging has begun.
    await assert.rejects(() => copyOneFile(srcDir, dst));

    assert.equal(await exists(dst), false, 'a rolled-back copy must not leave a file at the final name');
    assert.deepEqual(
        (await fs.readdir(dir)).filter((n) => n.startsWith('.nc-staging-')),
        [],
        'a rolled-back copy must not leave its staging file behind'
    );
});

test('invariant_a_cross_device_move_verifies_the_copy_before_releasing_the_source', {
    skip: process.env.NC_XDEV_DIR
        ? false
        : 'set NC_XDEV_DIR to a directory on a different filesystem to run this'
}, async (t) => {
    // The EXDEV branch now goes through moveEntryStaged: a staged, verified
    // copy commits before the source is unlinked, rather than the old
    // copy-then-unlink with no readback in between.
    const dir = await tmpDir(t, 'xdev');
    const other = await fs.mkdtemp(path.join(process.env.NC_XDEV_DIR, 'nc-web-xdev-'));
    t.after(async () => {
        await fs.rm(other, { recursive: true, force: true }).catch(() => {});
    });

    await writeFile(dir, 'tree/a.txt', 'a');
    const result = await moveSourceSync(path.join(dir, 'tree'), other);

    assert.equal(result.success, true);
    assert.equal(await read(path.join(other, 'tree/a.txt')), 'a');
    assert.equal(await exists(path.join(dir, 'tree')), false);
});
