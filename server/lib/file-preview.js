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
