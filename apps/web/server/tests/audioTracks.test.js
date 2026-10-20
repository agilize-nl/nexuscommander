import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";
import { tmpDir, mountRouter } from "./helpers.js";
import previewRouter from "../routes/preview.js";
import { parseAudioTrackInfo } from "../lib/file-preview.js";

test("parseAudioTrackInfo formats languages, channels, codecs, and titles correctly", () => {
    const track1 = parseAudioTrackInfo({
        index: 1,
        codec_name: "aac",
        channels: 2,
        channel_layout: "stereo",
        tags: { language: "nld", title: "Nederlands Stereo" }
    }, 1, 0);

    assert.equal(track1.id, "audio-1");
    assert.equal(track1.streamIndex, 1);
    assert.equal(track1.audioIndex, 0);
    assert.equal(track1.language, "nld");
    assert.equal(track1.isDefault, true);
    assert.ok(track1.label.includes("Nederlands"));
    assert.ok(track1.label.includes("AAC"));
    assert.ok(track1.label.includes("Stereo"));

    const track2 = parseAudioTrackInfo({
        index: 2,
        codec_name: "ac3",
        channels: 6,
        channel_layout: "5.1(side)",
        tags: { language: "eng", title: "Director Commentary" }
    }, 2, 1);

    assert.equal(track2.id, "audio-2");
    assert.equal(track2.streamIndex, 2);
    assert.equal(track2.audioIndex, 1);
    assert.equal(track2.language, "eng");
    assert.equal(track2.isDefault, false);
    assert.ok(track2.label.includes("Director Commentary"));
    assert.ok(track2.label.includes("5.1"));
    assert.ok(track2.label.includes("AC3"));
});

test("GET /api/preview/audio-tracks handles missing ffprobe or invalid files gracefully", async (t) => {
    const dir = await tmpDir(t, "audio-tracks-test");
    const fakeVideo = path.join(dir, "video.mp4");
    await fs.writeFile(fakeVideo, "dummy binary payload");

    const client = await mountRouter(t, "/api/preview", previewRouter);
    const { status, body } = await client.get(`/api/preview/audio-tracks?path=${encodeURIComponent(fakeVideo)}`);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.audioTracks));
});
