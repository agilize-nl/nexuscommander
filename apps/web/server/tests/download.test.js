// Browser-download plan — server/routes/download.js characterization tests.
// Covers §7's test plan items that are exercisable without a real browser:
// prepare validation, one-shot bundleId, headers, empty dirs, symlink-skip,
// and stream/error semantics.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs/promises';
import express from 'express';
import AdmZip from 'adm-zip';

import downloadRoutes from '../routes/download.js';
import { tmpDir, writeFile, mountRouter } from './helpers.js';

async function api(t) {
    return mountRouter(t, '/api/download', downloadRoutes);
}

async function collectBuffer(response) {
    const chunks = [];
    for await (const chunk of response.body) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

test('invariant_prepare_rejects_an_empty_items_array', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'dl-prepare-empty');

    const { status, body } = await client.post('/api/download/prepare', { dir, items: [] });

    assert.equal(status, 400);
    assert.match(body.error, /non-empty array/i);
});

test('invariant_prepare_rejects_a_traversal_item', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'dl-prepare-traversal');
    await writeFile(dir, 'note.txt', 'hi');

    const { status } = await client.post('/api/download/prepare', { dir, items: ['../etc/passwd'] });

    assert.equal(status, 400);
});

test('invariant_prepare_reports_total_bytes_and_file_count_for_a_single_file', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'dl-prepare-single');
    await writeFile(dir, 'note.txt', 'hello world');

    const { status, body } = await client.post('/api/download/prepare', { dir, items: ['note.txt'] });

    assert.equal(status, 200);
    assert.equal(body.fileCount, 1);
    assert.equal(body.totalBytes, 11);
    assert.ok(/^[0-9a-f]{32}$/.test(body.bundleId), 'bundleId must be 128 bits of hex');
});

test('invariant_prepare_recurses_into_directories_and_counts_empty_ones', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'dl-prepare-recurse');
    await writeFile(dir, 'sub/a.txt', 'aaaa');
    await writeFile(dir, 'sub/b.txt', 'bb');
    await fs.mkdir(path.join(dir, 'empty-dir'), { recursive: true });

    const { status, body } = await client.post('/api/download/prepare', { dir, items: ['sub', 'empty-dir'] });

    assert.equal(status, 200);
    assert.equal(body.fileCount, 2);
    assert.equal(body.totalBytes, 6);
    assert.equal(body.directoryCount, 2); // 'sub' and 'empty-dir' themselves
});

test('invariant_prepare_skips_a_symlink_and_reports_it', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'dl-prepare-symlink');
    await writeFile(dir, 'real.txt', 'data');
    const outsideDir = await tmpDir(t, 'dl-prepare-symlink-outside');
    await writeFile(outsideDir, 'secret.txt', 'shhh');
    await fs.symlink(path.join(outsideDir, 'secret.txt'), path.join(dir, 'link.txt'));

    const { status, body } = await client.post('/api/download/prepare', { dir, items: ['real.txt', 'link.txt'] });

    assert.equal(status, 200);
    assert.equal(body.fileCount, 1, 'the symlink must not be counted as a file');
    assert.deepEqual(body.skipped, ['link.txt']);
});

test('invariant_bundle_route_404s_for_an_unknown_bundle_id', async (t) => {
    const client = await api(t);

    const res = await fetch(`${client.base}/api/download/bundle?bundleId=deadbeefdeadbeefdeadbeefdeadbeef`);

    assert.equal(res.status, 404);
});

test('invariant_bundle_download_streams_a_valid_zip_with_content_disposition', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'dl-bundle-zip');
    await writeFile(dir, 'a.txt', 'hello');
    await writeFile(dir, 'nested/b.txt', 'world');

    const { body: prepared } = await client.post('/api/download/prepare', { dir, items: ['a.txt', 'nested'] });

    const res = await fetch(`${client.base}/api/download/bundle?bundleId=${prepared.bundleId}`);

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.match(res.headers.get('content-disposition'), /^attachment; filename="/);
    assert.equal(res.headers.get('content-length'), null, 'zip streaming must not declare a Content-Length');

    const buffer = await collectBuffer(res);
    const zip = new AdmZip(buffer);
    const names = zip.getEntries().map((e) => e.entryName).sort();
    assert.deepEqual(names, ['a.txt', 'nested/', 'nested/b.txt']);
    assert.equal(zip.readAsText('a.txt'), 'hello');
    assert.equal(zip.readAsText('nested/b.txt'), 'world');
});

test('invariant_bundle_id_is_one_shot_a_second_get_404s', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'dl-bundle-oneshot');
    await writeFile(dir, 'a.txt', 'hello');

    const { body: prepared } = await client.post('/api/download/prepare', { dir, items: ['a.txt'] });

    const first = await fetch(`${client.base}/api/download/bundle?bundleId=${prepared.bundleId}`);
    assert.equal(first.status, 200);
    await collectBuffer(first);

    const second = await fetch(`${client.base}/api/download/bundle?bundleId=${prepared.bundleId}`);
    assert.equal(second.status, 404, 'a completed bundleId must not be reusable');
});

test('invariant_progress_sse_404s_for_an_unknown_bundle_id', async (t) => {
    const client = await api(t);

    const res = await fetch(`${client.base}/api/download/deadbeefdeadbeefdeadbeefdeadbeef/progress`);

    assert.equal(res.status, 404);
});

test('invariant_progress_sse_emits_a_status_event_for_a_prepared_bundle', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'dl-progress-status');
    await writeFile(dir, 'a.txt', 'hello');

    const { body: prepared } = await client.post('/api/download/prepare', { dir, items: ['a.txt'] });

    const res = await fetch(`${client.base}/api/download/${prepared.bundleId}/progress`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');

    const reader = res.body.getReader();
    const { value } = await reader.read();
    const text = Buffer.from(value).toString('utf8');
    assert.match(text, /^event: status\ndata: /);
    await reader.cancel();
});

test('invariant_single_regular_file_selection_names_the_archive_after_it', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'dl-archive-name-file');
    await writeFile(dir, 'report.txt', 'x');

    const { body: prepared } = await client.post('/api/download/prepare', { dir, items: ['report.txt'] });
    const res = await fetch(`${client.base}/api/download/bundle?bundleId=${prepared.bundleId}`);
    await collectBuffer(res);

    assert.match(res.headers.get('content-disposition'), /filename="report\.txt\.zip"/);
});

test('invariant_multi_item_selection_names_the_archive_generically', async (t) => {
    const client = await api(t);
    const dir = await tmpDir(t, 'dl-archive-name-multi');
    await writeFile(dir, 'a.txt', 'x');
    await writeFile(dir, 'b.txt', 'y');

    const { body: prepared } = await client.post('/api/download/prepare', { dir, items: ['a.txt', 'b.txt'] });
    const res = await fetch(`${client.base}/api/download/bundle?bundleId=${prepared.bundleId}`);
    await collectBuffer(res);

    assert.match(res.headers.get('content-disposition'), /filename="2-bestanden\.zip"/);
});
