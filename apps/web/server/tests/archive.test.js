// Fase 1b, item 4 (P1b.3) — `routes/archive.js`'s pack/split/combine outputs,
// after they stopped writing straight at their final destination
// (`zip.writeZip`, `fs.writeFile`, `createWriteStream`, all truncating on
// open) and started going through lib/commit.js. No prior test existed for this
// route.
//
// Fase 2, item 3 (P2.3) adds the extraction half at the bottom: `/unpack`
// promoted its staged tree with a bare `fs.rename`, so an archive entry that
// happened to share a name with one of the user's files replaced it silently.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import AdmZip from 'adm-zip';
import { execFile } from 'child_process';
import { promisify } from 'util';

import archiveRoutes from '../routes/archive.js';
import { tmpDir, writeFile, read, exists, mountRouter } from './helpers.js';

const execFileAsync = promisify(execFile);

async function api(t) {
    return mountRouter(t, '/api/archive', archiveRoutes);
}

async function stagingLeftovers(dir) {
    const names = await fs.readdir(dir);
    return names.filter((n) => n.startsWith('.nc-staging-'));
}

test('packing a directory into itself excludes the output and its staging file', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'pack-self');
    await writeFile(dir, 'a.txt', 'hello');
    const destPath = await writeFile(dir, 'out.zip', 'previous archive');
    const response = await client.post('/api/archive/pack', { destPath, sources: [dir] });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const zip = new AdmZip(destPath);
    assert.deepEqual(zip.getEntries().map(entry => entry.entryName).sort(),
        [`${path.basename(dir)}/`, `${path.basename(dir)}/a.txt`]);
    assert.equal(zip.getEntry(`${path.basename(dir)}/a.txt`).getData().toString(), 'hello');
    assert.deepEqual(await stagingLeftovers(dir), []);
});

test('explicitly selecting the output archive as a source leaves it intact', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'pack-output-source');
    const destPath = await writeFile(dir, 'out.zip', 'keep this archive');
    const response = await client.post('/api/archive/pack', { destPath, sources: [destPath] });
    assert.equal(response.status, 500);
    assert.equal(await read(destPath), 'keep this archive');
    assert.deepEqual(await stagingLeftovers(dir), []);
});

test('packing over an output symlink preserves and archives its source target', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'pack-output-link');
    const source = await writeFile(dir, 'source.txt', 'source content');
    const destPath = path.join(dir, 'out.zip');
    await fs.symlink(source, destPath);
    const response = await client.post('/api/archive/pack', { destPath, sources: [source] });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(await read(source), 'source content');
    assert.equal((await fs.lstat(destPath)).isSymbolicLink(), false);
    assert.equal(new AdmZip(destPath).getEntry('source.txt').getData().toString(), 'source content');
    assert.deepEqual(await stagingLeftovers(dir), []);
});

test('packing a source directory through a symlink still excludes the output', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'pack-source-link');
    await writeFile(dir, 'tree/a.txt', 'hello');
    await fs.symlink(path.join(dir, 'tree'), path.join(dir, 'alias'));
    const destPath = path.join(dir, 'tree', 'out.zip');
    const response = await client.post('/api/archive/pack', {
        destPath, sources: [path.join(dir, 'alias')], options: { follow_links: true }
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(new AdmZip(destPath).getEntries().map(entry => entry.entryName).sort(),
        ['alias/', 'alias/a.txt']);
    assert.deepEqual(await stagingLeftovers(path.join(dir, 'tree')), []);
});

test('an output symlink inside the source tree is excluded without omitting its target', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'pack-tree-output-link');
    const source = await writeFile(dir, 'a.txt', 'keep me');
    const destPath = path.join(dir, 'out.zip');
    await fs.symlink(source, destPath);
    const response = await client.post('/api/archive/pack', { destPath, sources: [dir] });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(new AdmZip(destPath).getEntries().map(entry => entry.entryName).sort(),
        [`${path.basename(dir)}/`, `${path.basename(dir)}/a.txt`]);
    assert.equal(await read(source), 'keep me');
    assert.deepEqual(await stagingLeftovers(dir), []);
});

test('invariant_pack_creates_a_valid_zip_from_sources', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'pack');
    await writeFile(dir, 'a.txt', 'hello');
    const destPath = path.join(dir, 'out.zip');

    const { status, body } = await client.post('/api/archive/pack', {
        destPath,
        sources: [path.join(dir, 'a.txt')]
    });

    assert.equal(status, 200);
    // P2.1: the response names the format that was actually written, so a caller
    // can tell a ZIP from a ZIP-shaped substitution.
    assert.deepEqual(body, { success: true, format: 'zip', compression_level: 6 });
    const zip = new AdmZip(destPath);
    assert.equal(zip.getEntry('a.txt').getData().toString(), 'hello');
    assert.deepEqual(await stagingLeftovers(dir), []);
});

test('invariant_pack_leaves_a_previous_output_intact_when_a_source_is_missing', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'pack-fail');
    const destPath = await writeFile(dir, 'out.zip', 'not actually a zip, but must survive');

    const { status } = await client.post('/api/archive/pack', {
        destPath,
        sources: [path.join(dir, 'no-such-file')]
    });

    assert.equal(status, 500);
    assert.equal(await read(destPath), 'not actually a zip, but must survive');
});

test('invariant_split_writes_every_chunk_and_reassembles_byte_for_byte', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'split');
    const original = 'a'.repeat(10) + 'b'.repeat(10) + 'c'.repeat(5);
    const srcPath = await writeFile(dir, 'blob.bin', original);
    const destDir = path.join(dir, 'parts');

    const { status, body } = await client.post('/api/archive/split', {
        path: srcPath,
        destDir,
        chunkSize: 10
    });

    assert.equal(status, 200);
    assert.deepEqual(body, { success: true, message: 'OK' });

    const parts = (await fs.readdir(destDir)).sort();
    assert.deepEqual(parts, ['blob.bin.001', 'blob.bin.002', 'blob.bin.003']);
    assert.equal(await read(path.join(destDir, 'blob.bin.001')), 'a'.repeat(10));
    assert.equal(await read(path.join(destDir, 'blob.bin.003')), 'c'.repeat(5));
    assert.deepEqual(await stagingLeftovers(destDir), []);
});

test('invariant_combine_concatenates_sources_into_one_output', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'combine');
    const part1 = await writeFile(dir, 'part1', 'hello, ');
    const part2 = await writeFile(dir, 'part2', 'world');
    const destPath = path.join(dir, 'out', 'combined.bin');

    const { status, body } = await client.post('/api/archive/combine', {
        destPath,
        sources: [part1, part2]
    });

    assert.equal(status, 200);
    assert.deepEqual(body, { success: true, message: 'OK' });
    assert.equal(await read(destPath), 'hello, world');
    assert.deepEqual(await stagingLeftovers(path.dirname(destPath)), []);
});

test('invariant_combine_leaves_the_previous_output_intact_when_a_source_is_missing', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'combine-fail');
    const destPath = await writeFile(dir, 'out.bin', 'IMPORTANT');

    const { status } = await client.post('/api/archive/combine', {
        destPath,
        sources: [path.join(dir, 'no-such-file')]
    });

    assert.equal(status, 500);
    assert.equal(await read(destPath), 'IMPORTANT');
    assert.deepEqual(await stagingLeftovers(dir), []);
});

test('invariant_split_and_combine_round_trip_a_file', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'roundtrip');
    const original = 'x'.repeat(25);
    const srcPath = await writeFile(dir, 'src.bin', original);
    const destDir = path.join(dir, 'parts');

    await client.post('/api/archive/split', { path: srcPath, destDir, chunkSize: 8 });
    const parts = (await fs.readdir(destDir)).sort().map((n) => path.join(destDir, n));

    const combined = path.join(dir, 'rebuilt.bin');
    const { status } = await client.post('/api/archive/combine', { destPath: combined, sources: parts });

    assert.equal(status, 200);
    assert.equal(await read(combined), original);
});

// ---- P2.3: promotion may not destroy what is already in the destination ----

/** An archive at `<dir>/archive.zip` plus an empty destination beside it. */
async function fixture(dir, entries) {
    const zip = new AdmZip();
    for (const [name, contents] of Object.entries(entries)) {
        zip.addFile(name, Buffer.from(contents));
    }
    const srcPath = path.join(dir, 'archive.zip');
    zip.writeZip(srcPath);
    const destDir = path.join(dir, 'dest');
    await fs.mkdir(destDir, { recursive: true });
    return { srcPath, destDir };
}

test('invariant_unpack_leaves_an_existing_file_untouched_by_default', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'unpack-skip');
    const { srcPath, destDir } = await fixture(dir, { 'notes.txt': 'from the archive' });
    await writeFile(destDir, 'notes.txt', 'mine');

    const { status, body } = await client.post('/api/archive/unpack', { srcPath, destDir });

    assert.equal(status, 200);
    assert.equal(await read(path.join(destDir, 'notes.txt')), 'mine');
    assert.equal(body.skipped_count, 1);
    assert.deepEqual(body.skipped_sample, ['notes.txt']);
    assert.equal(body.promoted, 0);
});

test('invariant_unpack_replace_policy_publishes_over_the_existing_file', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'unpack-replace');
    const { srcPath, destDir } = await fixture(dir, { 'notes.txt': 'from the archive' });
    await writeFile(destDir, 'notes.txt', 'mine');

    const { status, body } = await client.post('/api/archive/unpack', {
        srcPath,
        destDir,
        conflict: 'replace'
    });

    assert.equal(status, 200);
    assert.equal(await read(path.join(destDir, 'notes.txt')), 'from the archive');
    assert.equal(body.replaced, 1);
    assert.equal(body.skipped_count, 0);
});

test('invariant_unpack_keep_both_publishes_beside_the_existing_file', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'unpack-keep-both');
    const { srcPath, destDir } = await fixture(dir, { 'notes.txt': 'from the archive' });
    await writeFile(destDir, 'notes.txt', 'mine');

    const { status, body } = await client.post('/api/archive/unpack', {
        srcPath,
        destDir,
        conflict: 'keep_both'
    });

    assert.equal(status, 200);
    assert.equal(await read(path.join(destDir, 'notes.txt')), 'mine');
    assert.equal(await read(path.join(destDir, 'notes (2).txt')), 'from the archive');
    assert.equal(body.kept_both_count, 1);
    assert.deepEqual(body.kept_both_sample, ['notes (2).txt']);
});

test('invariant_unpack_does_not_write_through_a_symlink_at_the_destination', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'unpack-symlink');
    const { srcPath, destDir } = await fixture(dir, { 'notes.txt': 'from the archive' });

    // The destination name is a link pointing outside the extraction root — the
    // shape an archive uses to reach a file the user never selected.
    const outside = await writeFile(dir, 'outside.txt', 'untouched');
    await fs.symlink(outside, path.join(destDir, 'notes.txt'));

    const skipped = await client.post('/api/archive/unpack', { srcPath, destDir });
    assert.equal(skipped.status, 200);
    assert.equal(await read(outside), 'untouched');
    assert.equal(skipped.body.skipped_count, 1);

    // And under `replace` the link itself is what gets replaced.
    const replaced = await client.post('/api/archive/unpack', { srcPath, destDir, conflict: 'replace' });
    assert.equal(replaced.status, 200);
    assert.equal(await read(outside), 'untouched');
    assert.equal((await fs.lstat(path.join(destDir, 'notes.txt'))).isSymbolicLink(), false);
    assert.equal(await read(path.join(destDir, 'notes.txt')), 'from the archive');
    assert.equal(replaced.body.replaced, 1);
});

test('invariant_unpack_skips_a_directory_whose_name_is_taken_by_a_file', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'unpack-dir-blocked');
    const { srcPath, destDir } = await fixture(dir, { 'data/inner.txt': 'from the archive' });
    await writeFile(destDir, 'data', 'mine');

    const { status, body } = await client.post('/api/archive/unpack', { srcPath, destDir });

    assert.equal(status, 200);
    assert.equal(await read(path.join(destDir, 'data')), 'mine');
    assert.equal(body.skipped_count, 1);
    assert.equal(body.promoted, 0);
});

test('invariant_unpack_refuses_an_unknown_conflict_policy', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'unpack-bad-policy');
    const { srcPath, destDir } = await fixture(dir, { 'notes.txt': 'from the archive' });
    await writeFile(destDir, 'notes.txt', 'mine');

    const { status } = await client.post('/api/archive/unpack', {
        srcPath,
        destDir,
        conflict: 'overwrite'
    });

    // Not silently read as "skip" and not silently read as "replace": a policy
    // this backend does not implement is a bad request.
    assert.equal(status, 400);
    assert.equal(await read(path.join(destDir, 'notes.txt')), 'mine');
});

// ---- P2.1: the advertised format is the format that gets written ----
//
// `/pack` used to ignore the destination extension and `options.format` alike and
// always build a ZIP with AdmZip, while `/capabilities` advertised `canPack: true`
// for tar.gz, tar.zst and 7z. Packing `backup.tar.gz` produced a ZIP with that
// name — a file the user could not open with the tool the extension implies.

/** What `tar` says is inside an archive, or null when it cannot read it. */
async function tarListing(archivePath) {
    try {
        const { stdout } = await execFileAsync('tar', ['tf', archivePath]);
        return stdout.split('\n').filter(Boolean).sort();
    } catch {
        return null;
    }
}

test('invariant_pack_writes_the_format_the_extension_names', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'pack-formats');
    await writeFile(dir, 'a.txt', 'hello');
    const sources = [path.join(dir, 'a.txt')];

    const caps = await (await fetch(`${client.base}/api/archive/capabilities`)).json();
    const packable = new Set(caps.filter((c) => c.canPack).map((c) => c.format));

    // Whatever this host can pack, it must actually produce — checked with the
    // real tool rather than by trusting the response.
    for (const [format, ext] of [
        ['tar.gz', '.tar.gz'],
        ['tar.bz2', '.tar.bz2'],
        ['tar.xz', '.tar.xz'],
        ['tar.zst', '.tar.zst']
    ]) {
        if (!packable.has(format)) continue;
        const destPath = path.join(dir, `out${ext}`);
        const { status, body } = await client.post('/api/archive/pack', { destPath, sources });

        assert.equal(status, 200, `${format}: ${JSON.stringify(body)}`);
        assert.equal(body.format, format);
        assert.deepEqual(await tarListing(destPath), ['a.txt'], `${format} must be a readable tar`);
        // A ZIP wearing a .tar.gz name is what this test exists to catch.
        const head = await fs.readFile(destPath);
        assert.notEqual(head.subarray(0, 2).toString('latin1'), 'PK', `${format} must not be a ZIP`);
    }
});

test('invariant_pack_refuses_an_extension_it_cannot_produce', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'pack-refuse');
    await writeFile(dir, 'a.txt', 'hello');

    const { status, body } = await client.post('/api/archive/pack', {
        destPath: path.join(dir, 'out.rar'),
        sources: [path.join(dir, 'a.txt')]
    });

    // Not a ZIP named `.rar`: refused, and the message says what it can do.
    assert.equal(status, 400);
    assert.match(body.error, /cannot create|which archive format/i);
    assert.equal(await exists(path.join(dir, 'out.rar')), false);
});

test('invariant_pack_refuses_a_format_this_backend_has_no_writer_for', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'pack-no-writer');
    await writeFile(dir, 'a.txt', 'hello');

    const { status, body } = await client.post('/api/archive/pack', {
        destPath: path.join(dir, 'out.7z'),
        sources: [path.join(dir, 'a.txt')],
        options: { format: '7z' }
    });

    assert.equal(status, 400);
    assert.match(body.error, /cannot create 7z/i);
    assert.equal(await exists(path.join(dir, 'out.7z')), false);
});

test('invariant_pack_honours_an_explicit_format_over_the_extension', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'pack-explicit');
    await writeFile(dir, 'a.txt', 'hello');
    const destPath = path.join(dir, 'backup');

    const { status, body } = await client.post('/api/archive/pack', {
        destPath,
        sources: [path.join(dir, 'a.txt')],
        options: { format: 'tar.gz', compression_level: 9 }
    });

    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.format, 'tar.gz');
    assert.equal(body.compression_level, 9);
    assert.deepEqual(await tarListing(destPath), ['a.txt']);
});

test('invariant_capabilities_only_advertises_formats_pack_accepts', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'pack-caps');
    await writeFile(dir, 'a.txt', 'hello');
    const caps = await (await fetch(`${client.base}/api/archive/capabilities`)).json();

    // The list and the writer come from one table; this is the assertion that
    // they cannot drift apart again.
    for (const cap of caps) {
        const { status } = await client.post('/api/archive/pack', {
            destPath: path.join(dir, `out-${cap.format}`),
            sources: [path.join(dir, 'a.txt')],
            options: { format: cap.format }
        });
        assert.equal(status, cap.canPack ? 200 : 400, `${cap.format} advertised canPack=${cap.canPack}`);
    }
});

test('invariant_pack_leaves_a_previous_tar_intact_when_a_source_is_missing', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'pack-tar-fail');
    const destPath = await writeFile(dir, 'out.tar.gz', 'not actually a tar, but must survive');

    const { status } = await client.post('/api/archive/pack', {
        destPath,
        sources: [path.join(dir, 'no-such-file')]
    });

    // tar exits non-zero, so the staged output is discarded and never published.
    assert.notEqual(status, 200);
    assert.equal(await read(destPath), 'not actually a tar, but must survive');
    assert.deepEqual(await stagingLeftovers(dir), []);
});

test('invariant_unpack_leaves_no_staging_directory_behind', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'unpack-staging');
    const { srcPath, destDir } = await fixture(dir, { 'a.txt': 'one', 'b/c.txt': 'two' });

    const { status, body } = await client.post('/api/archive/unpack', { srcPath, destDir });

    assert.equal(status, 200);
    assert.equal(body.promoted, 2);
    assert.equal(await read(path.join(destDir, 'a.txt')), 'one');
    assert.equal(await read(path.join(destDir, 'b/c.txt')), 'two');
    const leftovers = (await fs.readdir(destDir)).filter((n) => n.startsWith('.nc_extract_tmp_'));
    assert.deepEqual(leftovers, []);
});

// `/pack` used to build a zip with AdmZip's `toBuffer()` — the whole archive in
// memory before a byte reached disk, so a large folder took the server down.
// It now streams through yazl, which also makes the level real.
test('invariant_pack_streams_a_zip_tree_with_the_requested_level', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'pack-tree');
    await writeFile(dir, 'tree/a.txt', 'a'.repeat(4096));
    await writeFile(dir, 'tree/sub/b.txt', 'bee');
    await fs.symlink('a.txt', path.join(dir, 'tree/link'));
    const destPath = path.join(dir, 'out.zip');

    const { status, body } = await client.post('/api/archive/pack', {
        destPath,
        sources: [path.join(dir, 'tree')],
        options: { compression_level: 0 }
    });

    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.compression_level, 0);
    const zip = new AdmZip(destPath);
    assert.equal(zip.getEntry('tree/a.txt').getData().toString(), 'a'.repeat(4096));
    assert.equal(zip.getEntry('tree/a.txt').header.method, 0, 'level 0 must store, not deflate');
    assert.equal(zip.getEntry('tree/sub/b.txt').getData().toString(), 'bee');
    const link = zip.getEntry('tree/link');
    assert.equal((link.header.attr >>> 16) & 0o170000, 0o120000, 'a symlink is stored as a link by default');
    assert.equal(link.getData().toString(), 'a.txt');
    assert.deepEqual(await stagingLeftovers(dir), []);
});

test('invariant_cancel_pack_stops_a_pack_in_flight_and_writes_nothing', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'pack-cancel');
    // Enough incompressible data that the pack is still running when the
    // cancel arrives.
    const big = Buffer.alloc(64 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 4) big.writeUInt32LE((i * 2654435761) >>> 0, i);
    await fs.mkdir(path.join(dir, 'src'));
    await fs.writeFile(path.join(dir, 'src/big.bin'), big);
    const destPath = path.join(dir, 'out.zip');

    const packing = client.post('/api/archive/pack', {
        destPath,
        sources: [path.join(dir, 'src')],
        options: { compression_level: 9 }
    });
    await new Promise((r) => setTimeout(r, 50));
    const cancel = await client.post('/api/archive/cancel-pack', {});
    const { status, body } = await packing;

    assert.equal(cancel.body.cancelled, 1);
    assert.equal(status, 499, JSON.stringify(body));
    assert.equal(body.cancelled, true);
    assert.equal(await exists(destPath), false);
    assert.deepEqual(await stagingLeftovers(dir), []);
});

// AdmZip reads a whole archive into one Buffer before listing a single entry.
// Above NC_MAX_INMEMORY_ZIP_BYTES a zip goes to 7z (which streams), and with no
// 7z it is refused with a sentence instead of exhausting the heap.
test('invariant_a_zip_over_the_in_memory_limit_is_never_handed_to_adm_zip', async (t) => {
    const { _resetToolProbes } = await import('../lib/archiveFormats.js');
    const client = await api(t);
    const dir = await tmpDir(t, 'big-zip');
    const zip = new AdmZip();
    zip.addFile('inside.txt', Buffer.from('content'));
    const zipPath = path.join(dir, 'big.zip');
    zip.writeZip(zipPath);

    const saved = { limit: process.env.NC_MAX_INMEMORY_ZIP_BYTES, PATH: process.env.PATH };
    t.after(() => {
        if (saved.limit === undefined) delete process.env.NC_MAX_INMEMORY_ZIP_BYTES;
        else process.env.NC_MAX_INMEMORY_ZIP_BYTES = saved.limit;
        process.env.PATH = saved.PATH;
        _resetToolProbes();
    });
    process.env.NC_MAX_INMEMORY_ZIP_BYTES = '16';

    process.env.PATH = dir; // no 7z here
    _resetToolProbes();
    const refused = await client.get(`/api/archive/read?path=${encodeURIComponent(zipPath + '::')}`);
    assert.equal(refused.status, 413);
    assert.match(refused.body.error, /7z/);

    process.env.PATH = saved.PATH;
    _resetToolProbes();
    const { toolAvailable } = await import('../lib/archiveFormats.js');
    if (await toolAvailable('7z')) {
        const listed = await client.get(`/api/archive/read?path=${encodeURIComponent(zipPath + '::')}`);
        assert.equal(listed.status, 200, JSON.stringify(listed.body));
        assert.ok(JSON.stringify(listed.body).includes('inside.txt'));
    }
});
