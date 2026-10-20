import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { tmpDir, mountRouter } from './helpers.js';
import previewRouter from '../routes/preview.js';
import { parseSubtitleInfo, srtToVtt, findSubtitlesForVideo } from '../lib/file-preview.js';

test('parseSubtitleInfo recognizes languages and extra tags', () => {
    assert.deepEqual(parseSubtitleInfo('Movie.en.srt', 'Movie'), {
        label: 'English',
        language: 'en',
        ext: '.srt'
    });

    assert.deepEqual(parseSubtitleInfo('Movie.nl.forced.vtt', 'Movie'), {
        label: 'Nederlands (forced)',
        language: 'nl',
        ext: '.vtt'
    });

    assert.deepEqual(parseSubtitleInfo('Movie.dut.srt', 'Movie'), {
        label: 'Nederlands',
        language: 'nl',
        ext: '.srt'
    });

    assert.deepEqual(parseSubtitleInfo('Movie.srt', 'Movie'), {
        label: 'Subtitles (SRT)',
        language: 'und',
        ext: '.srt'
    });
});

test('srtToVtt converts SRT timestamps and headers correctly', () => {
    const srt = `1
00:00:01,500 --> 00:00:04,200
Hello, world!

2
00:00:05,000 --> 00:00:07,800
This is a test.
`;
    const vtt = srtToVtt(srt);
    assert.ok(vtt.startsWith('WEBVTT\n'));
    assert.ok(vtt.includes('00:00:01.500 --> 00:00:04.200'));
    assert.ok(vtt.includes('00:00:05.000 --> 00:00:07.800'));
    assert.ok(vtt.includes('Hello, world!'));
});

test('findSubtitlesForVideo discovers companion subtitle files', async (t) => {
    const dir = await tmpDir(t, 'subs-test');
    const video = path.join(dir, 'BigBuckBunny.mp4');
    await fs.writeFile(video, 'fake video');
    await fs.writeFile(path.join(dir, 'BigBuckBunny.en.srt'), '1\n00:00:01,000 --> 00:00:02,000\nEnglish');
    await fs.writeFile(path.join(dir, 'BigBuckBunny.nl.vtt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nNederlands');
    await fs.writeFile(path.join(dir, 'Unrelated.txt'), 'not a subtitle');

    const subs = await findSubtitlesForVideo(video);
    assert.equal(subs.length, 2);
    const enSub = subs.find(s => s.language === 'en');
    const nlSub = subs.find(s => s.language === 'nl');
    assert.ok(enSub);
    assert.ok(nlSub);
    assert.equal(enSub.label, 'English');
    assert.equal(nlSub.label, 'Nederlands');
});

test('GET /api/preview/subtitles and /api/preview/subtitle routes work end to end', async (t) => {
    const dir = await tmpDir(t, 'subs-routes-test');
    const video = path.join(dir, 'video.mp4');
    const srt = path.join(dir, 'video.en.srt');
    await fs.writeFile(video, 'video bytes');
    await fs.writeFile(srt, '1\n00:00:01,000 --> 00:00:03,000\nHello from subtitle');

    const client = await mountRouter(t, '/api/preview', previewRouter);
    const { status, body } = await client.get(`/api/preview/subtitles?path=${encodeURIComponent(video)}`);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.subtitles));
    assert.equal(body.subtitles.length, 1);
    assert.equal(body.subtitles[0].language, 'en');

    const subRes = await fetch(`${client.base}/api/preview/subtitle?path=${encodeURIComponent(srt)}`);
    assert.equal(subRes.status, 200);
    const subText = await subRes.text();
    assert.ok(subText.startsWith('WEBVTT'));
    assert.ok(subText.includes('00:00:01.000 --> 00:00:03.000'));
});
