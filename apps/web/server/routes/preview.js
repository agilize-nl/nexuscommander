import express from 'express';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolveSafePath } from '../lib/security.js';
import { detectCapabilities, OFFICE_EXTENSIONS, MEDIA_REMUX_EXTENSIONS, findSubtitlesForVideo, srtToVtt, parseAudioTrackInfo, getMediaMetadata } from '../lib/file-preview.js';

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

router.get('/stream', async (req, res) => {
    try {
        const filePath = resolveSafePath(req.query.path);
        const ffmpeg = await getFfmpegCommand();
        if (!ffmpeg) {
            return res.status(503).json({ error: 'ffmpeg is not available on this server.' });
        }

        const startTime = parseFloat(req.query.start) || 0;
        const audioStreamIndex = req.query.audioStreamIndex !== undefined ? parseInt(req.query.audioStreamIndex, 10) : null;

        const args = [];
        if (startTime > 0) {
            args.push('-ss', startTime.toString());
        }

        args.push('-i', filePath);

        if (startTime > 0) {
            args.push('-avoid_negative_ts', 'make_zero');
        }

        if (audioStreamIndex !== null && !isNaN(audioStreamIndex)) {
            args.push('-map', '0:v:0?', '-map', `0:${audioStreamIndex}?`);
        } else {
            args.push('-map', '0:v:0?', '-map', '0:a:0?');
        }

        args.push(
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-b:a', '192k',
            '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
            '-f', 'mp4',
            'pipe:1'
        );

        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');

        const { spawn } = await import('child_process');
        const ffmpegProc = spawn(ffmpeg, args);

        ffmpegProc.stdout.pipe(res);
        ffmpegProc.stderr.on('data', () => {});

        ffmpegProc.on('error', (err) => {
            if (!res.headersSent) {
                res.status(500).json({ error: err.message });
            }
        });

        req.on('close', () => {
            ffmpegProc.kill('SIGKILL');
        });
    } catch (error) {
        if (!res.headersSent) {
            res.status(error.statusCode || 500).json({ error: error.message });
        }
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

        return res.json({
            status: 'ready',
            format: 'mp4',
            previewUrl: `/api/preview/stream?path=${encodeURIComponent(filePath)}`,
            message: 'Direct On-The-Fly Stream'
        });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.stderr || error.message });
    }
});




router.get('/media-info', async (req, res) => {
    try {
        const filePath = resolveSafePath(req.query.path);
        const { duration, audioTracks } = await getMediaMetadata(filePath);
        const companionSubs = await findSubtitlesForVideo(filePath);
        const subtitles = [...companionSubs];

        const ffmpeg = await getFfmpegCommand();
        if (ffmpeg) {
            try {
                const { stdout } = await execFileAsync('ffprobe', [
                    '-v', 'error',
                    '-select_streams', 's',
                    '-show_entries', 'stream=index:stream_tags=language,title',
                    '-of', 'json',
                    filePath
                ], { timeout: 5000 });
                const data = JSON.parse(stdout);
                if (Array.isArray(data.streams)) {
                    for (const s of data.streams) {
                        const lang = s.tags?.language || 'und';
                        const title = s.tags?.title || '';
                        const label = title ? `${title} (${lang}) [Embedded]` : `Subtitle Track ${s.index} (${lang}) [Embedded]`;
                        subtitles.push({
                            id: `embedded-${s.index}`,
                            label,
                            language: lang,
                            isEmbedded: true,
                            streamIndex: s.index,
                            src: `/api/preview/subtitle-stream?path=${encodeURIComponent(filePath)}&streamIndex=${s.index}`
                        });
                    }
                }
            } catch {
                // ffprobe failed or not available - companion subs already collected
            }
        }

        res.json({
            duration,
            audioTracks,
            subtitles
        });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

router.get('/audio-tracks', async (req, res) => {
    try {
        const filePath = resolveSafePath(req.query.path);
        const audioTracks = [];
        const ffmpeg = await getFfmpegCommand();
        if (ffmpeg) {
            try {
                const { stdout } = await execFileAsync('ffprobe', [
                    '-v', 'error',
                    '-select_streams', 'a',
                    '-show_entries', 'stream=index,codec_name,channels,channel_layout:stream_tags=language,title',
                    '-of', 'json',
                    filePath
                ], { timeout: 5000 });
                const data = JSON.parse(stdout);
                if (Array.isArray(data.streams)) {
                    data.streams.forEach((s, idx) => {
                        audioTracks.push(parseAudioTrackInfo(s, s.index, idx));
                    });
                }
            } catch {
                // ffprobe failed or not available
            }
        }

        res.json({ audioTracks });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

router.get('/subtitles', async (req, res) => {
    try {
        const filePath = resolveSafePath(req.query.path);
        const companionSubs = await findSubtitlesForVideo(filePath);

        const subtitles = [...companionSubs];
        const ffmpeg = await getFfmpegCommand();
        if (ffmpeg) {
            try {
                const { stdout } = await execFileAsync('ffprobe', [
                    '-v', 'error',
                    '-select_streams', 's',
                    '-show_entries', 'stream=index:stream_tags=language,title',
                    '-of', 'json',
                    filePath
                ], { timeout: 5000 });
                const data = JSON.parse(stdout);
                if (Array.isArray(data.streams)) {
                    for (const s of data.streams) {
                        const lang = s.tags?.language || 'und';
                        const title = s.tags?.title || '';
                        const label = title ? `${title} (${lang}) [Embedded]` : `Subtitle Track ${s.index} (${lang}) [Embedded]`;
                        subtitles.push({
                            id: `embedded-${s.index}`,
                            label,
                            language: lang,
                            isEmbedded: true,
                            streamIndex: s.index,
                            src: `/api/preview/subtitle-stream?path=${encodeURIComponent(filePath)}&streamIndex=${s.index}`
                        });
                    }
                }
            } catch {
                // ffprobe failed or not available - companion subs already collected
            }
        }

        res.json({ subtitles });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

router.get('/subtitle', async (req, res) => {
    try {
        const filePath = resolveSafePath(req.query.path);
        const ext = path.extname(filePath).toLowerCase();

        res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');

        if (ext === '.vtt') {
            const content = await fs.readFile(filePath, 'utf-8');
            return res.send(content.startsWith('WEBVTT') ? content : `WEBVTT\n\n${content}`);
        }

        const rawContent = await fs.readFile(filePath, 'utf-8');
        const vttContent = srtToVtt(rawContent);
        return res.send(vttContent);
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

router.get('/subtitle-stream', async (req, res) => {
    try {
        const filePath = resolveSafePath(req.query.path);
        const streamIndex = parseInt(req.query.streamIndex, 10);
        if (isNaN(streamIndex)) {
            return res.status(400).json({ error: 'Invalid stream index' });
        }

        res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');

        const { spawn } = await import('child_process');
        const ffmpegProc = spawn('ffmpeg', [
            '-i', filePath,
            '-map', `0:${streamIndex}`,
            '-f', 'webvtt',
            '-'
        ]);

        ffmpegProc.stdout.pipe(res);
        ffmpegProc.stderr.on('data', () => {});
        ffmpegProc.on('error', (err) => {
            if (!res.headersSent) {
                res.status(500).json({ error: err.message });
            }
        });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

export default router;
