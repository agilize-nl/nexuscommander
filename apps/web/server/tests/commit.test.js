// Fase 1b, item 2 (P1b.1) — the staging, verification and atomic-commit
// protocol. Port of `engine/commit.rs`'s test suite: every fault point must
// leave the previous destination byte-identical, and the one exception
// (`before_rename`) must say so and keep the recoverable staged copy instead
// of silently deleting it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';

import {
    writeFileAtomically,
    copyFileStaged,
    moveEntryStaged,
    keepBothName,
    withStaging,
    durabilityClaim,
    durabilityAtLeast,
    Durability,
    Replace,
    CommitError,
    FaultPoint,
    _armFault
} from '../lib/commit.js';
import { tmpDir, writeFile, read, exists } from './helpers.js';

async function leftovers(dir) {
    const names = await fs.readdir(dir);
    return names.filter((n) => n.startsWith('.nc-staging-'));
}

test('writes_a_new_file', async (t) => {
    const dir = await tmpDir(t, 'commit-new');
    const report = await writeFileAtomically(path.join(dir, 'out.txt'), 'hello');

    assert.equal(await read(path.join(dir, 'out.txt')), 'hello');
    assert.equal(report.bytes, 5);
    assert.equal(report.replacedExisting, false);
    assert.deepEqual(await leftovers(dir), []);
});

test('replaces_an_existing_file', async (t) => {
    const dir = await tmpDir(t, 'commit-replace');
    await writeFile(dir, 'out.txt', 'the original contents');

    const report = await writeFileAtomically(path.join(dir, 'out.txt'), 'new');

    assert.equal(await read(path.join(dir, 'out.txt')), 'new');
    assert.equal(report.replacedExisting, true);
    assert.deepEqual(await leftovers(dir), []);
});

test('the_staging_file_is_created_in_the_destination_directory', async (t) => {
    // Section 6.1: staging in a system temp directory makes the final rename
    // cross-filesystem, which defeats the entire protocol.
    const dir = await tmpDir(t, 'commit-same-fs');
    let stagedPathSeen;
    await withStaging(
        dir,
        'out.txt',
        { verification: { byteCount: true, digest: false, durability: Durability.None } },
        async (staged) => {
            await staged.write(Buffer.from('x'));
            stagedPathSeen = staged.stagedPath;
            assert.equal(path.dirname(stagedPathSeen), dir, 'staging must happen next to the target');
            assert.equal(await exists(stagedPathSeen), true);
            return staged.commit(1);
        }
    );
});

test('staging_names_are_unpredictable_and_do_not_collide', async (t) => {
    const dir = await tmpDir(t, 'commit-names');
    const names = new Set();
    for (let i = 0; i < 5; i++) {
        await withStaging(
            dir,
            'report.pdf',
            { verification: { byteCount: false, digest: false, durability: Durability.None } },
            async (staged) => {
                names.add(path.basename(staged.stagedPath));
                await staged.disposeIfNotPublished();
            }
        );
    }
    assert.equal(names.size, 5, 'each staging attempt must get a distinct name');
    for (const name of names) {
        assert.match(name, /^\.nc-staging-/);
    }
});

test('dropping_without_committing_rolls_back', async (t) => {
    const dir = await tmpDir(t, 'commit-drop');
    await writeFile(dir, 'out.txt', 'original');

    await assert.rejects(() =>
        withStaging(dir, 'out.txt', { verification: defaultVerification() }, async (staged) => {
            await staged.write(Buffer.from('never published'));
            throw new Error('caller changed its mind');
        })
    );

    assert.equal(await read(path.join(dir, 'out.txt')), 'original');
    assert.deepEqual(await leftovers(dir), []);
});

test('a_byte_count_mismatch_refuses_to_publish', async (t) => {
    const dir = await tmpDir(t, 'commit-bytecount');
    await writeFile(dir, 'out.txt', 'original');

    // Let commit()'s rejection propagate through withStaging rather than
    // swallowing it here — withStaging's own catch is what closes the handle
    // and removes the staging file, so catching early would leak both.
    const err = await withStaging(dir, 'out.txt', { verification: defaultVerification() }, async (staged) => {
        await staged.write(Buffer.from('short'));
        return staged.commit(999);
    }).catch((e) => e);

    assert.ok(err instanceof CommitError);
    assert.equal(err.kind, 'verification_failed');
    assert.equal(err.destinationPreserved(), true);
    assert.equal(await read(path.join(dir, 'out.txt')), 'original');
    assert.deepEqual(await leftovers(dir), []);
});

test('a_digest_readback_is_checked_when_requested', async (t) => {
    const dir = await tmpDir(t, 'commit-digest');
    const verification = { byteCount: true, digest: true, durability: Durability.SyncFile };

    const report = await writeFileAtomically(path.join(dir, 'out.txt'), 'content', verification);

    assert.equal(report.verifiedDigest, true);
    assert.equal(await read(path.join(dir, 'out.txt')), 'content');
});

test('replace_never_refuses_an_existing_destination', async (t) => {
    const dir = await tmpDir(t, 'commit-never');
    await writeFile(dir, 'out.txt', 'original');

    const err = await withStaging(
        dir,
        'out.txt',
        { verification: defaultVerification(), replace: Replace.Never },
        async () => {}
    ).catch((e) => e);

    assert.ok(err instanceof CommitError);
    assert.equal(err.kind, 'destination_exists');
    assert.equal(await read(path.join(dir, 'out.txt')), 'original');
});

test('a_directory_is_never_replaced_by_a_file', async (t) => {
    const dir = await tmpDir(t, 'commit-dir-target');
    await fs.mkdir(path.join(dir, 'target'));

    const err = await writeFileAtomically(path.join(dir, 'target'), 'x').catch((e) => e);

    assert.ok(err instanceof CommitError);
    assert.equal(err.kind, 'target_is_directory');
    assert.equal((await fs.stat(path.join(dir, 'target'))).isDirectory(), true);
});

// ===== fault injection: the destination must survive every stage =====

function defaultVerification() {
    return { byteCount: true, digest: false, durability: Durability.SyncFileAndDirectory };
}

async function assertDestinationSurvives(t, faultAt) {
    const dir = await tmpDir(t, `commit-fault-${faultAt}`);
    await writeFile(dir, 'out.txt', 'the original contents');

    const disarm = _armFault(faultAt);
    let err;
    try {
        err = await writeFileAtomically(path.join(dir, 'out.txt'), 'replacement', defaultVerification()).catch((e) => e);
    } finally {
        disarm();
    }

    assert.ok(err instanceof CommitError, `fault at ${faultAt} did not surface as a CommitError`);
    assert.equal(err.destinationPreserved(), true);
    assert.equal(
        await read(path.join(dir, 'out.txt')),
        'the original contents',
        `a fault at ${faultAt} damaged the destination`
    );

    if (faultAt === FaultPoint.BeforeRename) {
        assert.equal(err.kind, 'commit_failed');
        assert.deepEqual(err.asOutcome().state, 'manual_recovery_required');
        assert.equal(await (await leftovers(dir)).length > 0, true, 'the staged copy must be kept for manual recovery');
    } else {
        assert.deepEqual(await leftovers(dir), [], `a fault at ${faultAt} left a staging file behind`);
        assert.equal(err.asOutcome().state, 'rolled_back');
    }
    return dir;
}

test('a_fault_just_after_staging_leaves_the_destination_alone', async (t) => {
    await assertDestinationSurvives(t, FaultPoint.AfterStagingCreated);
});

test('a_fault_mid_write_leaves_the_destination_alone', async (t) => {
    await assertDestinationSurvives(t, FaultPoint.MidWrite);
});

test('a_fault_before_the_sync_leaves_the_destination_alone', async (t) => {
    await assertDestinationSurvives(t, FaultPoint.BeforeSync);
});

test('a_fault_after_the_sync_leaves_the_destination_alone', async (t) => {
    await assertDestinationSurvives(t, FaultPoint.AfterSync);
});

test('a_fault_at_the_rename_leaves_the_destination_and_keeps_the_staged_copy', async (t) => {
    await assertDestinationSurvives(t, FaultPoint.BeforeRename);
});

test('a_failed_rename_reports_where_the_new_content_is', async (t) => {
    const dir = await tmpDir(t, 'commit-recovery-paths');
    await writeFile(dir, 'out.txt', 'original');

    const disarm = _armFault(FaultPoint.BeforeRename);
    let err;
    try {
        err = await writeFileAtomically(path.join(dir, 'out.txt'), 'replacement', defaultVerification()).catch((e) => e);
    } finally {
        disarm();
    }

    const outcome = err.asOutcome();
    assert.equal(outcome.state, 'manual_recovery_required');
    assert.ok(
        outcome.paths.some((p) => p.includes('.nc-staging-')),
        `the recovery report must name the staged file: ${JSON.stringify(outcome.paths)}`
    );
    assert.match(err.message, /your new content is complete/);
});

// ===== keep-both naming =====

test('keep_both_leaves_a_free_name_alone', async (t) => {
    const dir = await tmpDir(t, 'kb-free');
    assert.equal(await keepBothName(dir, 'report.pdf'), 'report.pdf');
});

test('keep_both_preserves_the_extension', async (t) => {
    const dir = await tmpDir(t, 'kb-ext');
    await writeFile(dir, 'report.pdf', 'x');
    assert.equal(await keepBothName(dir, 'report.pdf'), 'report (2).pdf');
});

test('keep_both_counts_up_past_existing_copies', async (t) => {
    const dir = await tmpDir(t, 'kb-count');
    for (const name of ['report.pdf', 'report (2).pdf', 'report (3).pdf']) {
        await writeFile(dir, name, 'x');
    }
    assert.equal(await keepBothName(dir, 'report.pdf'), 'report (4).pdf');
});

test('keep_both_is_deterministic', async (t) => {
    const dir = await tmpDir(t, 'kb-det');
    await writeFile(dir, 'a.txt', 'x');
    const first = await keepBothName(dir, 'a.txt');
    const second = await keepBothName(dir, 'a.txt');
    assert.equal(first, second);
});

test('keep_both_handles_a_name_with_no_extension', async (t) => {
    const dir = await tmpDir(t, 'kb-noext');
    await writeFile(dir, 'Makefile', 'x');
    assert.equal(await keepBothName(dir, 'Makefile'), 'Makefile (2)');
});

test('keep_both_treats_a_dotfile_as_having_no_extension', async (t) => {
    const dir = await tmpDir(t, 'kb-dotfile');
    await writeFile(dir, '.bashrc', 'x');
    assert.equal(await keepBothName(dir, '.bashrc'), '.bashrc (2)');
});

test('keep_both_counts_a_symlink_as_taken', async (t) => {
    const dir = await tmpDir(t, 'kb-symlink');
    await fs.symlink(path.join(dir, 'no-such-target'), path.join(dir, 'a.txt'));
    assert.equal(await keepBothName(dir, 'a.txt'), 'a (2).txt');
});

// ===== durability honesty =====

test('the_durability_claim_matches_the_tier_that_was_used', async (t) => {
    const dir = await tmpDir(t, 'commit-claims');
    const cases = [
        [Durability.None, 'not flushed'],
        [Durability.FlushOnly, 'not a power cut'],
        [Durability.SyncFile, 'flushed to disk']
    ];
    for (const [tier, expect] of cases) {
        const verification = { byteCount: true, digest: false, durability: tier };
        const report = await writeFileAtomically(path.join(dir, `out-${tier}.txt`), 'x', verification);
        assert.ok(
            durabilityClaim(report).includes(expect),
            `tier ${tier} claimed ${durabilityClaim(report)}`
        );
    }
});

test('only_the_top_tier_claims_durability_and_only_if_the_directory_synced', async (t) => {
    const dir = await tmpDir(t, 'commit-top-tier');
    const report = await writeFileAtomically(path.join(dir, 'out.txt'), 'x', defaultVerification());

    // Linux: directory fsync is supported.
    assert.equal(report.directorySynced, true);
    assert.equal(durabilityClaim(report), 'written and durable');
});

test('a_lower_tier_never_claims_the_directory_was_synced', async (t) => {
    const dir = await tmpDir(t, 'commit-lower-tier');
    const verification = { byteCount: true, digest: false, durability: Durability.SyncFile };
    const report = await writeFileAtomically(path.join(dir, 'out.txt'), 'x', verification);
    assert.equal(report.directorySynced, false);
});

test('durability_tiers_are_ordered_weakest_first', () => {
    assert.equal(durabilityAtLeast(Durability.None, Durability.FlushOnly), false);
    assert.equal(durabilityAtLeast(Durability.FlushOnly, Durability.FlushOnly), true);
    assert.equal(durabilityAtLeast(Durability.SyncFileAndDirectory, Durability.SyncFile), true);
});

// ===== copyFileStaged / moveEntryStaged =====

test('copy_file_staged_preserves_content_mode_and_mtime', async (t) => {
    const dir = await tmpDir(t, 'commit-copy');
    const src = await writeFile(dir, 'src.txt', 'payload');
    await fs.chmod(src, 0o640);
    const when = new Date('2020-01-02T03:04:05Z');
    await fs.utimes(src, when, when);

    const dst = path.join(dir, 'out', 'src.txt');
    await fs.mkdir(path.dirname(dst), { recursive: true });
    const report = await copyFileStaged(src, dst);

    assert.equal(await read(dst), 'payload');
    assert.equal(report.bytes, 7);
    const stat = await fs.stat(dst);
    assert.equal(stat.mode & 0o777, 0o640);
    assert.equal(Math.floor(stat.mtimeMs / 1000), Math.floor(when.getTime() / 1000));
});

test('copy_file_staged_leaves_the_previous_destination_on_a_failed_source_read', async (t) => {
    const dir = await tmpDir(t, 'commit-copy-fail');
    const dst = await writeFile(dir, 'dst.txt', 'IMPORTANT');

    await assert.rejects(() => copyFileStaged(path.join(dir, 'no-such-file'), dst));

    assert.equal(await read(dst), 'IMPORTANT', 'the destination must never be truncated before the source is known readable');
    assert.deepEqual(await leftovers(dir), []);
});

test('move_entry_staged_renames_on_the_same_filesystem', async (t) => {
    const dir = await tmpDir(t, 'commit-move-rename');
    const src = await writeFile(dir, 'src.txt', 'a');
    const dst = path.join(dir, 'dst.txt');

    const result = await moveEntryStaged(src, dst);

    assert.deepEqual(result, { kind: 'renamed' });
    assert.equal(await read(dst), 'a');
    assert.equal(await exists(src), false);
});

test(
    'move_entry_staged_across_devices_copies_then_removes_the_source',
    { skip: process.env.NC_XDEV_DIR ? false : 'set NC_XDEV_DIR to a directory on a different filesystem to run this' },
    async (t) => {
        const dir = await tmpDir(t, 'commit-move-xdev');
        const other = await fs.mkdtemp(path.join(process.env.NC_XDEV_DIR, 'nc-web-commit-xdev-'));
        t.after(async () => {
            await fs.rm(other, { recursive: true, force: true }).catch(() => {});
        });

        const src = await writeFile(dir, 'src.txt', 'a');
        const dst = path.join(other, 'dst.txt');

        const result = await moveEntryStaged(src, dst);

        assert.equal(result.kind, 'copied_then_source_removed');
        assert.equal(await read(dst), 'a');
        assert.equal(await exists(src), false);
    }
);
