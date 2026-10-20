import fs from 'fs/promises';
import { constants as fsConstants } from 'fs';
import path from 'path';

export const MAX_VIEW_BYTES = 10 * 1024 * 1024;
export const MAX_EDIT_BYTES = 2 * 1024 * 1024;
export const SNIFF_BYTES = 8000;
export const HEX_DUMP_BYTES = 64 * 1024;

export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico']);
export const PDF_EXTENSIONS = new Set(['.pdf']);
export const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.opus', '.weba']);
export const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.m4v', '.ogv']);
// Containers most browsers can't play natively, but that ffmpeg can usually
// repackage into an mp4 in seconds (stream copy, no re-encoding) whenever the
// video/audio tracks inside are already H.264/AAC.
export const MEDIA_REMUX_EXTENSIONS = new Set(['.mkv', '.avi', '.mov', '.flv', '.wmv', '.ts', '.m2ts', '.3gp', '.mpg', '.mpeg']);
export const OFFICE_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp']);
export const TEXT_EDIT_EXTENSIONS = new Set([
    '.txt', '.md', '.log', '.json', '.xml', '.csv', '.yml', '.yaml',
    '.js', '.ts', '.svelte', '.css', '.html', '.htm', '.sh', '.py',
    '.php', '.sql', '.env'
]);

const EXTENSION_MIME_TYPES = new Map([
    ['.pdf', 'application/pdf'],
    ['.mp3', 'audio/mpeg'],
    ['.wav', 'audio/wav'],
    ['.ogg', 'audio/ogg'],
    ['.m4a', 'audio/mp4'],
    ['.aac', 'audio/aac'],
    ['.flac', 'audio/flac'],
    ['.opus', 'audio/opus'],
    ['.weba', 'audio/webm'],
    ['.mp4', 'video/mp4'],
    ['.webm', 'video/webm'],
    ['.m4v', 'video/x-m4v'],
    ['.ogv', 'video/ogg'],
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.gif', 'image/gif'],
    ['.svg', 'image/svg+xml'],
    ['.webp', 'image/webp'],
    ['.bmp', 'image/bmp'],
    ['.ico', 'image/x-icon']
]);

async function commandExists(command) {
    const pathValue = process.env.PATH || '';
    for (const dir of pathValue.split(':')) {
        if (!dir) continue;
        try {
            await fs.access(path.join(dir, command), fsConstants.X_OK);
            return true;
        } catch {
            // Keep looking.
        }
    }
    return false;
}

export async function detectCapabilities() {
    const headless = process.env.NC_FORCE_HEADLESS === '1'
        || (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);
    const [hasXdgOpen, hasGio, hasLibreOffice, hasSoffice, hasFfmpeg] = await Promise.all([
        commandExists('xdg-open'),
        commandExists('gio'),
        commandExists('libreoffice'),
        commandExists('soffice'),
        commandExists('ffmpeg')
    ]);

    return {
        headless,
        desktopOpenAvailable: !headless && (hasXdgOpen || hasGio),
        browserPreviewAvailable: true,
        conversionAvailable: hasLibreOffice || hasSoffice,
        transcodingAvailable: hasFfmpeg
    };
}

export async function readHeadBytes(filePath, length) {
    if (length <= 0) return Buffer.alloc(0);
    const handle = await fs.open(filePath, 'r');
    try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, 0);
        return buffer.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}

export function isBinaryBuffer(buffer) {
    return buffer.includes(0);
}

export async function sniffBinary(filePath, size) {
    const sample = await readHeadBytes(filePath, Math.min(size, SNIFF_BYTES));
    return isBinaryBuffer(sample);
}

export function toHexLines(buffer) {
    const lines = [];
    for (let offset = 0; offset < buffer.length; offset += 16) {
        const chunk = buffer.subarray(offset, offset + 16);
        const hex = Array.from(chunk, (b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ');
        const ascii = Array.from(chunk, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
        lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex}  |${ascii}|`);
    }
    return lines;
}

export function getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return EXTENSION_MIME_TYPES.get(ext) || null;
}

export async function resolveOpenAction(filePath, intent = 'open') {
    const stats = await fs.stat(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const capabilities = await detectCapabilities();
    const isBinary = await sniffBinary(filePath, stats.size);
    const mimeType = getMimeType(filePath);

    const base = {
        action: 'unsupported',
        file_name: path.basename(filePath),
        file_size: stats.size,
        mime_type: mimeType,
        media_kind: null,
        reason: null,
        capabilities
    };

    if (intent === 'edit') {
        if (!isBinary && TEXT_EDIT_EXTENSIONS.has(ext) && stats.size <= MAX_EDIT_BYTES) {
            return { ...base, action: 'editor' };
        }
        if (capabilities.desktopOpenAvailable) {
            return { ...base, action: 'desktop-app' };
        }
        return {
            ...base,
            action: 'unsupported',
            reason: isBinary
                ? 'This file is binary and cannot be edited in the built-in editor.'
                : 'This file type is not supported by the built-in editor.'
        };
    }

    if (IMAGE_EXTENSIONS.has(ext)) {
        return { ...base, action: 'image-viewer' };
    }
    if (PDF_EXTENSIONS.has(ext)) {
        return { ...base, action: 'pdf-viewer' };
    }
    if (AUDIO_EXTENSIONS.has(ext)) {
        return { ...base, action: 'media-player', media_kind: 'audio' };
    }
    if (VIDEO_EXTENSIONS.has(ext)) {
        return { ...base, action: 'media-player', media_kind: 'video' };
    }
    if (MEDIA_REMUX_EXTENSIONS.has(ext)) {
        if (capabilities.transcodingAvailable) {
            return { ...base, action: 'media-remux', media_kind: 'video' };
        }
        return {
            ...base,
            action: 'unsupported',
            media_kind: 'video',
            reason: 'This video container needs ffmpeg on the server to preview in the browser. Use "Copy stream URL" to open it directly in VLC or mpv instead.'
        };
    }
    if (OFFICE_EXTENSIONS.has(ext)) {
        if (capabilities.conversionAvailable) {
            return { ...base, action: 'converted-preview' };
        }
        return {
            ...base,
            action: 'unsupported',
            reason: 'Office preview needs LibreOffice headless on the server.'
        };
    }
    if (!isBinary) {
        if (intent === 'open' && !capabilities.headless && capabilities.desktopOpenAvailable) {
            return { ...base, action: 'desktop-app' };
        }
        return { ...base, action: intent === 'edit' ? 'editor' : 'text-viewer' };
    }
    if (intent === 'open' && !capabilities.headless && capabilities.desktopOpenAvailable) {
        return { ...base, action: 'desktop-app' };
    }

    return {
        ...base,
        action: 'unsupported',
        reason: 'No built-in preview is available for this file type in the headless runtime.'
    };
}


export const SUBTITLE_EXTENSIONS = new Set(['.vtt', '.srt', '.sub', '.ass', '.ssa']);

const LANGUAGE_CODE_MAP = new Map([
    ['nl', { code: 'nl', label: 'Nederlands' }],
    ['dut', { code: 'nl', label: 'Nederlands' }],
    ['nld', { code: 'nl', label: 'Nederlands' }],
    ['dutch', { code: 'nl', label: 'Nederlands' }],
    ['nederlands', { code: 'nl', label: 'Nederlands' }],
    ['en', { code: 'en', label: 'English' }],
    ['eng', { code: 'en', label: 'English' }],
    ['english', { code: 'en', label: 'English' }],
    ['de', { code: 'de', label: 'Deutsch' }],
    ['ger', { code: 'de', label: 'Deutsch' }],
    ['deu', { code: 'de', label: 'Deutsch' }],
    ['german', { code: 'de', label: 'Deutsch' }],
    ['deutsch', { code: 'de', label: 'Deutsch' }],
    ['fr', { code: 'fr', label: 'Français' }],
    ['fre', { code: 'fr', label: 'Français' }],
    ['fra', { code: 'fr', label: 'Français' }],
    ['french', { code: 'fr', label: 'Français' }],
    ['francais', { code: 'fr', label: 'Français' }],
    ['es', { code: 'es', label: 'Español' }],
    ['spa', { code: 'es', label: 'Español' }],
    ['spanish', { code: 'es', label: 'Español' }],
    ['espanol', { code: 'es', label: 'Español' }],
    ['pt', { code: 'pt', label: 'Português' }],
    ['por', { code: 'pt', label: 'Português' }],
    ['portuguese', { code: 'pt', label: 'Português' }],
    ['it', { code: 'it', label: 'Italiano' }],
    ['ita', { code: 'it', label: 'Italiano' }],
    ['italian', { code: 'it', label: 'Italiano' }],
    ['ja', { code: 'ja', label: 'Japanese' }],
    ['jpn', { code: 'ja', label: 'Japanese' }],
    ['japanese', { code: 'ja', label: 'Japanese' }],
    ['zh', { code: 'zh', label: 'Chinese' }],
    ['chi', { code: 'zh', label: 'Chinese' }],
    ['zho', { code: 'zh', label: 'Chinese' }],
    ['ru', { code: 'ru', label: 'Russian' }],
    ['rus', { code: 'ru', label: 'Russian' }],
    ['ar', { code: 'ar', label: 'Arabic' }],
    ['ko', { code: 'ko', label: 'Korean' }],
    ['tr', { code: 'tr', label: 'Turkish' }],
    ['pl', { code: 'pl', label: 'Polish' }],
    ['sv', { code: 'sv', label: 'Swedish' }],
    ['da', { code: 'da', label: 'Danish' }],
    ['no', { code: 'no', label: 'Norwegian' }],
    ['fi', { code: 'fi', label: 'Finnish' }],
    ['el', { code: 'el', label: 'Greek' }],
    ['he', { code: 'he', label: 'Hebrew' }],
    ['cs', { code: 'cs', label: 'Czech' }],
    ['hu', { code: 'hu', label: 'Hungarian' }],
    ['ro', { code: 'ro', label: 'Romanian' }],
    ['uk', { code: 'uk', label: 'Ukrainian' }]
]);

export function parseSubtitleInfo(subFileName, videoBaseName) {
    const ext = path.extname(subFileName).toLowerCase();
    const nameWithoutExt = path.basename(subFileName, ext);

    let remainder = nameWithoutExt;
    if (videoBaseName && remainder.toLowerCase().startsWith(videoBaseName.toLowerCase())) {
        remainder = remainder.slice(videoBaseName.length).replace(/^[._ -]+/, '');
    }

    const tokens = remainder.toLowerCase().split(/[._ -]+/).filter(Boolean);
    let langInfo = null;
    let extraTags = [];

    for (const token of tokens) {
        if (!langInfo && LANGUAGE_CODE_MAP.has(token)) {
            langInfo = LANGUAGE_CODE_MAP.get(token);
        } else {
            extraTags.push(token);
        }
    }

    let label = '';
    let language = langInfo ? langInfo.code : 'und';

    if (langInfo) {
        label = langInfo.label;
        if (extraTags.length > 0) {
            label += ` (${extraTags.join(' ')})`;
        }
    } else if (remainder) {
        label = remainder;
    } else {
        label = `Subtitles (${ext.replace('.', '').toUpperCase()})`;
    }

    return { label, language, ext };
}

export function srtToVtt(srtText) {
    if (!srtText) return 'WEBVTT\n\n';
    let text = srtText.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    text = text.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, (match, t1, ms1, t2, ms2) => {
        const p1 = t1.split(':');
        const hh1 = p1[0].padStart(2, '0');
        const p2 = t2.split(':');
        const hh2 = p2[0].padStart(2, '0');
        return `${hh1}:${p1[1]}:${p1[2]}.${ms1} --> ${hh2}:${p2[1]}:${p2[2]}.${ms2}`;
    });
    // Fallback for standalone timestamp lines if not matched above
    text = text.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, (match, time, ms) => {
        const parts = time.split(':');
        const hh = parts[0].padStart(2, '0');
        return `${hh}:${parts[1]}:${parts[2]}.${ms}`;
    });
    return `WEBVTT\n\n${text}\n`;
}

export async function findSubtitlesForVideo(videoPath) {
    const dir = path.dirname(videoPath);
    const videoExt = path.extname(videoPath);
    const videoBaseName = path.basename(videoPath, videoExt);

    const subtitles = [];

    try {
        const files = await fs.readdir(dir);
        const subFiles = files.filter(f => {
            const ext = path.extname(f).toLowerCase();
            return SUBTITLE_EXTENSIONS.has(ext);
        });

        const matching = subFiles.filter(f => f.toLowerCase().startsWith(videoBaseName.toLowerCase()));
        const others = subFiles.filter(f => !f.toLowerCase().startsWith(videoBaseName.toLowerCase()));

        for (const f of matching) {
            const { label, language } = parseSubtitleInfo(f, videoBaseName);
            const fullPath = path.join(dir, f);
            subtitles.push({
                id: `file-${subtitles.length}`,
                label,
                language,
                fileName: f,
                path: fullPath,
                src: `/api/preview/subtitle?path=${encodeURIComponent(fullPath)}`,
                isDefault: subtitles.length === 0 && matching.length === 1
            });
        }

        if (subtitles.length === 0) {
            for (const f of others) {
                const { label, language } = parseSubtitleInfo(f, '');
                const fullPath = path.join(dir, f);
                subtitles.push({
                    id: `file-${subtitles.length}`,
                    label,
                    language,
                    fileName: f,
                    path: fullPath,
                    src: `/api/preview/subtitle?path=${encodeURIComponent(fullPath)}`,
                    isDefault: subtitles.length === 0
                });
            }
        }
    } catch (e) {
        console.error('Error finding subtitle files:', e);
    }

    return subtitles;
}


export function parseAudioTrackInfo(stream, streamIndex, audioIndex) {
    const lang = stream.tags?.language || stream.tags?.LANGUAGE || "und";
    const title = stream.tags?.title || stream.tags?.TITLE || "";
    const codec = (stream.codec_name || "").toUpperCase();
    const channels = stream.channels || 0;
    const channelLayout = stream.channel_layout || "";

    let channelDesc = "";
    if (channels === 6 || channelLayout.includes("5.1")) {
        channelDesc = "5.1";
    } else if (channels === 8 || channelLayout.includes("7.1")) {
        channelDesc = "7.1";
    } else if (channels === 2 || channelLayout === "stereo") {
        channelDesc = "Stereo";
    } else if (channels === 1 || channelLayout === "mono") {
        channelDesc = "Mono";
    } else if (channels > 0) {
        channelDesc = `${channels}ch`;
    }

    let langLabel = "";
    const langLower = lang.toLowerCase();
    if (LANGUAGE_CODE_MAP.has(langLower)) {
        langLabel = LANGUAGE_CODE_MAP.get(langLower).label;
    } else if (lang && lang !== "und") {
        langLabel = lang.toUpperCase();
    }

    const descParts = [];
    if (langLabel) descParts.push(langLabel);
    if (codec) descParts.push(codec);
    if (channelDesc) descParts.push(channelDesc);
    const descStr = descParts.length > 0 ? `(${descParts.join(", ")})` : "";

    let label = "";
    if (title) {
        label = descStr ? `${title} ${descStr}` : title;
    } else if (descParts.length > 0) {
        label = `Audio ${audioIndex + 1}: ${descParts.join(" - ")}`;
    } else {
        label = `Audio Track ${audioIndex + 1}`;
    }

    return {
        id: `audio-${stream.index ?? streamIndex}`,
        label,
        language: lang,
        streamIndex: stream.index ?? streamIndex,
        audioIndex,
        codec: stream.codec_name || "",
        channels,
        channelLayout,
        title,
        isDefault: audioIndex === 0
    };
}


export async function getMediaMetadata(filePath) {
    let duration = null;
    const audioTracks = [];
    const hasFfprobe = await commandExists("ffprobe");

    if (hasFfprobe) {
        try {
            const { promisify } = await import("util");
            const { execFile } = await import("child_process");
            const execFileAsync = promisify(execFile);

            const { stdout } = await execFileAsync("ffprobe", [
                "-v", "error",
                "-show_entries", "format=duration:stream=index,codec_type,codec_name,channels,channel_layout,duration:stream_tags=language,title",
                "-of", "json",
                filePath
            ], { timeout: 7000 });

            const data = JSON.parse(stdout);
            if (data.format && data.format.duration) {
                const parsed = parseFloat(data.format.duration);
                if (!isNaN(parsed) && parsed > 0) {
                    duration = parsed;
                }
            }

            if (Array.isArray(data.streams)) {
                let audioIdx = 0;
                for (const s of data.streams) {
                    if (s.codec_type === "audio") {
                        audioTracks.push(parseAudioTrackInfo(s, s.index, audioIdx++));
                    }
                    if (duration === null && s.duration) {
                        const parsed = parseFloat(s.duration);
                        if (!isNaN(parsed) && parsed > 0) {
                            duration = parsed;
                        }
                    }
                }
            }
        } catch {
            // ffprobe error or timeout
        }
    }

    return {
        duration,
        audioTracks
    };
}
