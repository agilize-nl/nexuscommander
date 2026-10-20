import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import iconv from 'iconv-lite';
import { resolveSafePath } from '../lib/security.js';
import {
    HEX_DUMP_BYTES,
    IMAGE_EXTENSIONS,
    MAX_VIEW_BYTES,
    readHeadBytes,
    resolveOpenAction,
    sniffBinary,
    toHexLines,
    getMimeType
} from '../lib/file-preview.js';

const router = express.Router();

const ENCODING_MAP = {
    'UTF-8': 'utf8',
    'UTF-8BOM': 'utf8',
    'ANSI': 'win1252',
    'OEM': 'cp437',
    'CP1250': 'cp1250',
    'CP1251': 'cp1251',
    'CP1252': 'cp1252',
    'CP1253': 'cp1253',
    'CP1254': 'cp1254',
    'CP1255': 'cp1255',
    'CP1256': 'cp1256',
    'CP1257': 'cp1257',
    'CP1258': 'cp1258',
    'CP437': 'cp437',
    'CP850': 'cp850',
    'CP852': 'cp852',
    'CP866': 'cp866',
    'CP874': 'cp874',
    'CP932': 'cp932',
    'CP936': 'cp936',
    'CP949': 'cp949',
    'CP950': 'cp950',
    'ISO-8859-1': 'iso-8859-1',
    'ISO-8859-2': 'iso-8859-2',
    'KOI8-R': 'koi8-r',
    'KOI8-U': 'koi8-u',
    'KOI8-RU': 'koi8-ru',
    'UCS-2LE': 'utf16le',
    'UCS-2BE': 'utf16be',
    'UTF-16LE': 'utf16le',
    'UTF-16BE': 'utf16be',
    'UTF-32LE': 'utf32le',
    'UTF-32BE': 'utf32be',
};

function decodeBuffer(buf, encName) {
    const norm = (encName || '').trim();

    if (!norm || norm.toLowerCase() === 'auto-detect') {
        if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
            return { text: iconv.decode(buf.subarray(3), 'utf8'), encoding: 'UTF-8BOM' };
        }
        if (buf.length >= 4 && buf[0] === 0xFF && buf[1] === 0xFE && buf[2] === 0x00 && buf[3] === 0x00) {
            return { text: iconv.decode(buf.subarray(4), 'utf32le'), encoding: 'UTF-32LE' };
        }
        if (buf.length >= 4 && buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0xFE && buf[3] === 0xFF) {
            return { text: iconv.decode(buf.subarray(4), 'utf32be'), encoding: 'UTF-32BE' };
        }
        if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
            return { text: iconv.decode(buf.subarray(2), 'utf16le'), encoding: 'UTF-16LE' };
        }
        if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
            return { text: iconv.decode(buf.subarray(2), 'utf16be'), encoding: 'UTF-16BE' };
        }

        try {
            const utf8Str = buf.toString('utf8');
            if (Buffer.from(utf8Str, 'utf8').equals(buf)) {
                return { text: utf8Str, encoding: 'UTF-8' };
            }
        } catch (_) {}

        return { text: iconv.decode(buf, 'win1252'), encoding: 'ANSI' };
    }

    let b = buf;
    const upperKey = norm.toUpperCase().replace(/[-_]/g, '');
    const matchedKey = Object.keys(ENCODING_MAP).find(k => k.toUpperCase().replace(/[-_]/g, '') === upperKey) || 'UTF-8';

    if (matchedKey === 'UTF-8BOM' && b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) {
        b = b.subarray(3);
    }
    if ((matchedKey === 'UTF-16LE' || matchedKey === 'UCS-2LE') && b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE) {
        b = b.subarray(2);
    }
    if ((matchedKey === 'UTF-16BE' || matchedKey === 'UCS-2BE') && b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF) {
        b = b.subarray(2);
    }
    if (matchedKey === 'UTF-32LE' && b.length >= 4 && b[0] === 0xFF && b[1] === 0xFE && b[2] === 0x00 && b[3] === 0x00) {
        b = b.subarray(4);
    }
    if (matchedKey === 'UTF-32BE' && b.length >= 4 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0xFE && b[3] === 0xFF) {
        b = b.subarray(4);
    }

    const codec = ENCODING_MAP[matchedKey] || 'utf8';
    return { text: iconv.decode(b, codec), encoding: matchedKey };
}

router.get('/read', async (req, res) => {
    try {
        const filePath = resolveSafePath(req.query.path);
        const stats = await fs.stat(filePath);
        const ext = path.extname(filePath).toLowerCase();

        // The size limit below reads `stats.size`, which is 0 for a device:
        // /dev/zero passed it and was then read until the heap ran out, taking
        // the whole server down. A FIFO would hang this request forever.
        if (!stats.isFile()) {
            return res.status(400).json({ error: `Not a regular file: ${filePath}` });
        }

        if (stats.size > MAX_VIEW_BYTES) {
            return res.status(413).json({ error: `File too large to preview (${stats.size} bytes, limit ${MAX_VIEW_BYTES})` });
        }

        const requestedEncoding = typeof req.query.encoding === 'string' ? req.query.encoding : null;
        let mode = "Text";
        let text = null;
        let image_data = null;
        let hex_lines = null;
        let encoding = null;
        const mime_type = getMimeType(filePath);

        if (IMAGE_EXTENSIONS.has(ext) && !requestedEncoding) {
            mode = "Image";
            const buffer = await fs.readFile(filePath);
            image_data = buffer.toString('base64');
        } else {
            const buffer = await fs.readFile(filePath);
            const isBinary = await sniffBinary(filePath, stats.size);
            const dumpBytes = Math.min(stats.size, HEX_DUMP_BYTES);
            hex_lines = toHexLines(buffer.subarray(0, dumpBytes));

            const decoded = decodeBuffer(buffer, requestedEncoding);
            text = decoded.text;
            encoding = decoded.encoding;

            if (requestedEncoding) {
                mode = "Text";
            } else if (isBinary) {
                mode = "Hex";
            } else {
                mode = "Text";
            }
        }

        res.json({
            mode,
            file_name: path.basename(filePath),
            file_size: stats.size,
            text,
            hex_lines,
            image_data,
            mime_type,
            encoding
        });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

router.get('/binary', async (req, res) => {
    try {
        const filePath = resolveSafePath(req.query.path);
        const stats = await fs.stat(filePath);
        if (!stats.isFile()) {
            return res.status(400).json({ error: `Not a regular file: ${filePath}` });
        }
        res.json(await sniffBinary(filePath, stats.size));
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

router.get('/resolve', async (req, res) => {
    try {
        const filePath = resolveSafePath(req.query.path);
        const intent = typeof req.query.intent === 'string' ? req.query.intent : 'open';
        res.json(await resolveOpenAction(filePath, intent));
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

export default router;
