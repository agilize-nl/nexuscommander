// Fase 1b, item 4 (P1b.3) — `routes/upload.js` after it stopped hand-rolling
// its own temp-file protocol and started sharing lib/commit.js's staging with
// every other mutation. No prior test existed for this route; these pin the
// behavior the rewrite must preserve (or improve, for the conflict case).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';

import uploadRoutes from '../routes/upload.js';
import { tmpDir, writeFile, read, exists, mountRouter } from './helpers.js';

async function api(t) {
    return mountRouter(t, '/api/upload', uploadRoutes);
}

/** mountRouter's `put()` always JSON-encodes; uploads need a raw body PUT. */
async function putFile(base, query, body) {
    const url = `${base}/api/upload/file?${new URLSearchParams(query)}`;
    const res = await fetch(url, { method: 'PUT', body });
    return { status: res.status, body: await res.json() };
}

test('invariant_uploads_a_new_file_to_a_free_destination', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'upload-new');

    const { status, body } = await putFile(client.base, { dir, rel: 'note.txt', size: 7 }, 'payload');

    assert.equal(status, 200);
    assert.deepEqual(body, { success: true });
    assert.equal(await read(path.join(dir, 'note.txt')), 'payload');
});

test('invariant_upload_refuses_an_existing_destination_without_overwrite', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'upload-conflict');
    await writeFile(dir, 'note.txt', 'original');

    const { status, body } = await putFile(client.base, { dir, rel: 'note.txt' }, 'new content');

    assert.equal(status, 409);
    assert.equal(body.error, 'exists');
    assert.equal(await read(path.join(dir, 'note.txt')), 'original', 'a refused upload must not touch the existing file');
});

test('invariant_upload_with_overwrite_replaces_the_existing_file', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'upload-overwrite');
    await writeFile(dir, 'note.txt', 'original');

    const { status, body } = await putFile(client.base, { dir, rel: 'note.txt', overwrite: '1' }, 'replacement');

    assert.equal(status, 200);
    assert.deepEqual(body, { success: true });
    assert.equal(await read(path.join(dir, 'note.txt')), 'replacement');
});

test('invariant_a_size_mismatch_is_refused_and_leaves_no_output', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'upload-size-mismatch');

    const { status, body } = await putFile(client.base, { dir, rel: 'note.txt', size: 999 }, 'short');

    assert.equal(status, 500);
    assert.match(body.error, /size verification failed/i);
    assert.equal(await exists(path.join(dir, 'note.txt')), false);
});

test('invariant_a_size_mismatch_against_an_existing_file_leaves_it_untouched', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'upload-size-mismatch-existing');
    await writeFile(dir, 'note.txt', 'original');

    await putFile(client.base, { dir, rel: 'note.txt', overwrite: '1', size: 999 }, 'short');

    assert.equal(await read(path.join(dir, 'note.txt')), 'original', 'a rolled-back upload must not clobber the previous content');
});

test('invariant_upload_creates_intermediate_directories', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'upload-subdir');

    const { status } = await putFile(client.base, { dir, rel: 'a/b/note.txt' }, 'nested');

    assert.equal(status, 200);
    assert.equal(await read(path.join(dir, 'a/b/note.txt')), 'nested');
});
