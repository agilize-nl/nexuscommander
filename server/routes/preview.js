import express from 'express';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolveSafePath } from '../lib/security.js';
import { detectCapabilities, OFFICE_EXTENSIONS, MEDIA_REMUX_EXTENSIONS } from '../lib/file-preview.js';

const execFileAsync = promisify(execFile);
const router = express.Router();
const PREVIEW_DIR = path.join(os.tmpdir(), 'nexuscommander-previews');

async function ensurePreviewDir() {
    await fs.mkdir(PREVIEW_DIR, { recursive: true });
}

async function getLibreOfficeCommand() {
    const capabilities = await detectCapabilities();
    if (!capabilities.conversionAvailable) return null;

    for (const candidate of ['libreoffice', 'soffice']) {
        try {
            await execFileAsync(candidate, ['--version']);
            return candidate;
        } catch {
            // Try the next one.
        }
    }
    return null;
}

async function getFfmpegCommand() {
    const capabilities = await detectCapabilities();
    if (!capabilities.transcodingAvailable) return null;
    try {
        await execFileAsync('ffmpeg', ['-version']);
        return 'ffmpeg';
    } catch {
        return null;
    }
}

router.post('/convert', async (req, res) => {
    try {
        const filePath = resolveSafePath(req.body.path);
        const ext = path.extname(filePath).toLowerCase();
        if (!OFFICE_EXTENSIONS.has(ext)) {
            return res.status(400).json({ error: 'Only office documents can be converted for preview.' });
        }

        const libreOffice = await getLibreOfficeCommand();
        if (!libreOffice) {
            return res.status(503).json({ error: 'LibreOffice headless is not available on this server.' });
        }

        await ensurePreviewDir();
        const sourceName = path.basename(filePath, ext);
        const targetPath = path.join(PREVIEW_DIR, `${sourceName}.pdf`);
        await execFileAsync(libreOffice, [
            '--headless',
            '--convert-to', 'pdf',
            '--outdir', PREVIEW_DIR,
            filePath
        ]);

        return res.json({
            status: 'ready',
            format: 'pdf',
            previewUrl: `/api/fs/raw?path=${encodeURIComponent(targetPath)}`,
            outputPath: targetPath,
            message: 'Preview generated'
        });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.stderr || error.message });
    }
});

router.post('/remux', async (req, res) => {
    try {
        const filePath = resolveSafePath(req.body.path);
        const ext = path.extname(filePath).toLowerCase();
        if (!MEDIA_REMUX_EXTENSIONS.has(ext)) {
            return res.status(400).json({ error: 'This file type does not need remuxing for browser playback.' });
        }

        const ffmpeg = await getFfmpegCommand();
        if (!ffmpeg) {
            return res.status(503).json({ error: 'ffmpeg is not available on this server.' });
        }

        await ensurePreviewDir();
        const sourceName = path.basename(filePath, ext);
        const targetPath = path.join(PREVIEW_DIR, `${sourceName}.mp4`);

        try {
            // Fast path only: repackage the existing streams into an mp4
            // container without re-encoding. This takes seconds regardless of
            // file length because it's pure I/O, not CPU-bound decoding, so
            // it stays cheap even on a small LXC. It only works when the
            // source already carries browser-compatible H.264/AAC streams;
            // anything else (HEVC, DTS, ...) is rejected rather than falling
            // back to a slow full re-encode that could tie up the server for
            // the length of the request.
            await execFileAsync(ffmpeg, [
                '-y', '-i', filePath,
                '-c', 'copy', '-movflags', '+faststart',
                targetPath
            ], { timeout: 60000 });
        } catch {
            return res.status(422).json({
                error: 'This file uses a codec that cannot be repackaged for the browser without a slow full re-encode. Use "Copy stream URL" to open it in VLC or mpv instead.'
            });
        }

        return res.json({
            status: 'ready',
            format: 'mp4',
            previewUrl: `/api/fs/raw?path=${encodeURIComponent(targetPath)}`,
            outputPath: targetPath,
            message: 'Remuxed for browser playback (no re-encoding)'
        });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.stderr || error.message });
    }
});

export default router;
