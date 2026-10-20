// Fase 1b, item 3 (P1b.2) — the fixture suite the plan asks for: symlinked
// destination, symlinked intermediate component, cycle, hardlink, `..`
// escape, case-only collision, and a destination replaced by a symlink
// between check and write. The last one is the honest limitation, not a bug:
// this adapter cannot win that race, and the test asserts the advisory label
// rather than a guarantee Node cannot provide.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';

import {
    resolveForMutation,
    entryKind,
    platformGuarantee,
    isRaceFree,
    Guarantee,
    SymlinkPolicy,
    PathError
} from '../lib/pathPolicy.js';
import { tmpDir, writeFile } from './helpers.js';

test('opens_an_ordinary_directory', async (t) => {
    const dir = await tmpDir(t, 'pp-plain');
    const target = path.join(dir, 'sub');
    await fs.mkdir(target);

    const result = await resolveForMutation(target);
    assert.equal(result.path, target);
    assert.equal(result.guarantee, platformGuarantee());
});

test('a_relative_path_is_refused', async () => {
    await assert.rejects(() => resolveForMutation('relative/sub'), (e) => {
        assert.ok(e instanceof PathError);
        assert.equal(e.kind, 'not_absolute');
        return true;
    });
});

test('reports_entry_kinds_without_following', async (t) => {
    const dir = await tmpDir(t, 'pp-kinds');
    await writeFile(dir, 'file.txt', 'x');
    await fs.mkdir(path.join(dir, 'subdir'));

    assert.equal(await entryKind(dir, 'file.txt'), 'file');
    assert.equal(await entryKind(dir, 'subdir'), 'dir');
    assert.equal(await entryKind(dir, 'absent'), null);
});

test('a_multi_component_name_is_refused', async (t) => {
    // Accepting "a/b" here would reintroduce exactly the uncontrolled
    // resolution this module exists to prevent.
    const dir = await tmpDir(t, 'pp-multi');
    await assert.rejects(() => entryKind(dir, 'a/b'), (e) => {
        assert.ok(e instanceof PathError);
        assert.equal(e.kind, 'invalid_component');
        return true;
    });
});

// ===== the plan's named fixtures =====

test('fixture_symlinked_destination_is_refused_by_default', async (t) => {
    const dir = await tmpDir(t, 'pp-fixture-dest-link');
    const real = path.join(dir, 'real');
    await fs.mkdir(real);
    await fs.symlink(real, path.join(dir, 'link'));

    await assert.rejects(() => resolveForMutation(path.join(dir, 'link')), (e) => {
        assert.ok(e instanceof PathError);
        assert.equal(e.kind, 'symlink_rejected');
        return true;
    });
});

test('fixture_symlinked_intermediate_component_is_refused', async (t) => {
    const dir = await tmpDir(t, 'pp-fixture-mid-link');
    const real = path.join(dir, 'real');
    await fs.mkdir(real);
    await fs.mkdir(path.join(real, 'inner'));
    await fs.symlink(real, path.join(dir, 'link'));

    const err = await resolveForMutation(path.join(dir, 'link', 'inner')).catch((e) => e);
    assert.ok(err instanceof PathError);
    assert.equal(err.kind, 'symlink_rejected');
    assert.ok(err.component.endsWith('link'), err.component);
});

test('fixture_a_symlink_cycle_terminates_at_the_depth_bound', async (t) => {
    // a -> b -> a. Without a bound the walk would loop forever re-queueing
    // components.
    const dir = await tmpDir(t, 'pp-fixture-cycle');
    await fs.symlink(path.join(dir, 'b'), path.join(dir, 'a'));
    await fs.symlink(path.join(dir, 'a'), path.join(dir, 'b'));

    const err = await resolveForMutation(path.join(dir, 'a'), {
        symlinkPolicy: SymlinkPolicy.Follow,
        maxDepth: 3
    }).catch((e) => e);

    assert.ok(err instanceof PathError);
    assert.equal(err.kind, 'too_deep');
});

test('fixture_a_hard_link_is_an_ordinary_file', async (t) => {
    // Hard links have no target to escape through — both names are the same
    // file. Refusing them would break ordinary copies for nothing.
    const dir = await tmpDir(t, 'pp-fixture-hardlink');
    const original = path.join(dir, 'original.txt');
    await writeFile(dir, 'original.txt', 'x');
    await fs.link(original, path.join(dir, 'second.txt'));

    assert.equal(await entryKind(dir, 'second.txt'), 'file');
});

// `path.join`/`path.normalize` collapse a literal `foo/../bar` down to `bar`
// before this module ever sees it, which would make these two fixtures pass
// without ever exercising the `..`-as-a-kept-component code path they name.
// Building the raw string by concatenation is deliberate, not a style choice.
function rawJoin(...parts) {
    return parts.join(path.sep);
}

test('fixture_parent_components_resolve_against_the_real_tree', async (t) => {
    // `one/../two` must mean whatever the filesystem says it means — this is
    // why `..` is kept as a component instead of being rewritten away
    // lexically before the walk starts.
    const dir = await tmpDir(t, 'pp-fixture-dotdot');
    await fs.mkdir(path.join(dir, 'one'));
    await fs.mkdir(path.join(dir, 'two'));

    const result = await resolveForMutation(rawJoin(dir, 'one', '..', 'two'));
    assert.equal(result.path, path.join(dir, 'two'));
    assert.equal(result.guarantee, Guarantee.Advisory);
});

test('fixture_a_symlink_behind_a_parent_component_is_still_caught', async (t) => {
    const dir = await tmpDir(t, 'pp-fixture-dotdot-link');
    const real = path.join(dir, 'real');
    await fs.mkdir(real);
    await fs.symlink(real, path.join(dir, 'link'));
    await fs.mkdir(path.join(dir, 'other'));

    // `link/../other` still has to traverse `link` first.
    await assert.rejects(() => resolveForMutation(rawJoin(dir, 'link', '..', 'other')), (e) => {
        assert.equal(e.kind, 'symlink_rejected');
        return true;
    });
});

test('fixture_case_only_names_are_distinct_entries', async (t) => {
    // Linux filesystems are case-sensitive; this pins that this resolver does
    // not fold case anywhere in the walk, which would silently merge two
    // distinct destinations.
    const dir = await tmpDir(t, 'pp-fixture-case');
    await writeFile(dir, 'Report.txt', 'upper');
    await writeFile(dir, 'report.txt', 'lower');

    assert.equal(await entryKind(dir, 'Report.txt'), 'file');
    assert.equal(await entryKind(dir, 'report.txt'), 'file');
    const upper = await fs.readFile(path.join(dir, 'Report.txt'), 'utf8');
    const lower = await fs.readFile(path.join(dir, 'report.txt'), 'utf8');
    assert.notEqual(upper, lower, 'case-only names must not collide');
});

test('fixture_a_destination_replaced_by_a_symlink_between_check_and_write_is_not_caught_here_by_design', async (t) => {
    // The honest limitation: this adapter resolves by path, not by a held
    // descriptor, so nothing here can prevent a swap happening *after* this
    // call returns and *before* the caller's actual write. What this test
    // proves is narrower and still worth pinning: the checker itself is not
    // broken (a fresh call after the swap does detect the new symlink), and
    // the guarantee this module reports is `advisory`, never a stronger claim
    // it cannot back up.
    const dir = await tmpDir(t, 'pp-fixture-toctou');
    const target = path.join(dir, 'target');
    await fs.mkdir(target);

    const before = await resolveForMutation(target);
    assert.equal(before.guarantee, Guarantee.Advisory);
    assert.equal(isRaceFree(before.guarantee), false);

    // Simulate another process winning the race right after the check.
    await fs.rm(target, { recursive: true });
    await fs.symlink(dir, target);

    await assert.rejects(() => resolveForMutation(target), (e) => {
        assert.equal(e.kind, 'symlink_rejected');
        return true;
    });
});

// ===== bounds and the race-free refusal =====

test('a_path_longer_than_the_bound_is_refused', async (t) => {
    const dir = await tmpDir(t, 'pp-bound');
    await assert.rejects(
        () => resolveForMutation(path.join(dir, 'a/b/c/d'), { maxComponents: 2 }),
        (e) => {
            assert.equal(e.kind, 'too_many_components');
            return true;
        }
    );
});

test('requiring_race_freedom_is_always_refused', async (t) => {
    // Section 6.1: refuse rather than degrade silently. Unlike the Rust
    // suite's Unix branch, there is no platform on which this adapter can
    // honestly say yes.
    const dir = await tmpDir(t, 'pp-race');
    await assert.rejects(() => resolveForMutation(dir, { requireRaceFree: true }), (e) => {
        assert.equal(e.kind, 'guarantee_unavailable');
        return true;
    });
});

test('advisory_is_never_reported_as_race_free', () => {
    assert.equal(isRaceFree(Guarantee.Advisory), false);
    assert.equal(isRaceFree(Guarantee.ComponentwiseNoFollow), true);
    assert.equal(platformGuarantee(), Guarantee.Advisory);
});

test('following_is_allowed_only_when_asked_for', async (t) => {
    const dir = await tmpDir(t, 'pp-follow');
    const real = path.join(dir, 'real');
    await fs.mkdir(real);
    await fs.symlink(real, path.join(dir, 'link'));

    const result = await resolveForMutation(path.join(dir, 'link'), {
        symlinkPolicy: SymlinkPolicy.Follow,
        maxDepth: 4
    });
    assert.equal(result.path, real);
});

test('a_dangling_symlink_is_still_an_entry', async (t) => {
    // The QSF-003 case a follow-by-default check gets wrong: it follows the
    // link, finds nothing, and reports the destination as free.
    const dir = await tmpDir(t, 'pp-dangling');
    await fs.symlink(path.join(dir, 'no-such-target'), path.join(dir, 'dead'));

    assert.equal(await entryKind(dir, 'dead'), 'symlink');
});
