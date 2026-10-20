import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";
import { tmpDir, mountRouter } from "./helpers.js";
import previewRouter from "../routes/preview.js";
import { getMediaMetadata } from "../lib/file-preview.js";

test("getMediaMetadata handles non-existent or dummy files gracefully", async (t) => {
    const dir = await tmpDir(t, "media-meta-test");
    const fakeVideo = path.join(dir, "video.mp4");
    await fs.writeFile(fakeVideo, "dummy binary payload");

    const meta = await getMediaMetadata(fakeVideo);
    assert.ok(meta);
    assert.ok("duration" in meta);
    assert.ok(Array.isArray(meta.audioTracks));
});

test("GET /api/preview/media-info returns duration, audioTracks and subtitles", async (t) => {
    const dir = await tmpDir(t, "media-info-route-test");
    const fakeVideo = path.join(dir, "movie.mkv");
    await fs.writeFile(fakeVideo, "dummy binary payload");
    const subFile = path.join(dir, "movie.nl.srt");
    await fs.writeFile(subFile, "1\n00:00:01,000 --> 00:00:04,000\nHallo wereld\n");

    const client = await mountRouter(t, "/api/preview", previewRouter);
    const { status, body } = await client.get(`/api/preview/media-info?path=${encodeURIComponent(fakeVideo)}`);
    assert.equal(status, 200);
    assert.ok("duration" in body);
    assert.ok(Array.isArray(body.audioTracks));
    assert.ok(Array.isArray(body.subtitles));
    assert.equal(body.subtitles.length, 1);
    assert.equal(body.subtitles[0].language, "nl");
});
