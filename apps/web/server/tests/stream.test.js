import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";
import { tmpDir, mountRouter } from "./helpers.js";
import previewRouter from "../routes/preview.js";
import fsRouter from "../routes/fs.js";

test("POST /api/preview/remux returns 503 when ffmpeg is not available", async (t) => {
    const dir = await tmpDir(t, "remux-no-ffmpeg-test");
    const mkv = path.join(dir, "sample.mkv");
    await fs.writeFile(mkv, "fake mkv content");

    const origPath = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
        const client = await mountRouter(t, "/api/preview", previewRouter);
        const { status, body } = await client.post("/api/preview/remux", { path: mkv });
        assert.equal(status, 503);
        assert.ok(body.error.includes("ffmpeg"));
    } finally {
        process.env.PATH = origPath;
    }
});

test("POST /api/preview/remux returns on-the-fly streaming URL when ffmpeg is available", async (t) => {
    const dir = await tmpDir(t, "remux-test");
    const binDir = path.join(dir, "bin");
    await fs.mkdir(binDir, { recursive: true });
    const fakeFfmpeg = path.join(binDir, "ffmpeg");
    await fs.writeFile(fakeFfmpeg, "#!/bin/sh\necho ffmpeg version 6.0\n", { mode: 0o755 });

    const mkv = path.join(dir, "sample.mkv");
    await fs.writeFile(mkv, "fake mkv content");

    const origPath = process.env.PATH;
    process.env.PATH = `${binDir}:${origPath}`;
    try {
        const client = await mountRouter(t, "/api/preview", previewRouter);
        const { status, body } = await client.post("/api/preview/remux", { path: mkv });

        assert.equal(status, 200);
        assert.equal(body.status, "ready");
        assert.equal(body.format, "mp4");
        assert.ok(body.previewUrl.startsWith("/api/preview/stream?path="));
        assert.ok(body.previewUrl.includes(encodeURIComponent(mkv)));
    } finally {
        process.env.PATH = origPath;
    }
});

test("POST /api/preview/remux rejects non-remuxable file types", async (t) => {
    const dir = await tmpDir(t, "remux-invalid-test");
    const txt = path.join(dir, "notes.txt");
    await fs.writeFile(txt, "just text");

    const client = await mountRouter(t, "/api/preview", previewRouter);
    const { status, body } = await client.post("/api/preview/remux", { path: txt });

    assert.equal(status, 400);
    assert.ok(body.error);
});

test("GET /api/preview/stream validates path safety and rejects null bytes or missing path", async (t) => {
    const client = await mountRouter(t, "/api/preview", previewRouter);
    const res = await fetch(`${client.base}/api/preview/stream?path=${encodeURIComponent("file\0name.mp4")}`);
    assert.equal(res.status, 400);
});

test("GET /api/fs/raw returns no-transform and handles raw files", async (t) => {
    const dir = await tmpDir(t, "raw-test");
    const media = path.join(dir, "track.mp3");
    await fs.writeFile(media, "sample audio payload");

    const client = await mountRouter(t, "/api/fs", fsRouter);
    const res = await fetch(`${client.base}/api/fs/raw?path=${encodeURIComponent(media)}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-transform");
    assert.equal(res.headers.get("accept-ranges"), "bytes");
    const body = await res.text();
    assert.equal(body, "sample audio payload");
});
