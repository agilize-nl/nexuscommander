import express from 'express';
import fs from 'fs/promises';
import path from 'path';
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

router.get('/read', async (req, res) => {
    try {
        const filePath = resolveSafePath(req.query.path);
        const stats = await fs.stat(filePath);
        const ext = path.extname(filePath).toLowerCase();

        if (stats.size > MAX_VIEW_BYTES) {
            return res.status(413).json({ error: `File too large to preview (${stats.size} bytes, limit ${MAX_VIEW_BYTES})` });
        }

        let mode = "Text";
        let text = null;
        let image_data = null;
        let hex_lines = null;
        const mime_type = getMimeType(filePath);

        if (IMAGE_EXTENSIONS.has(ext)) {
            mode = "Image";
            const buffer = await fs.readFile(filePath);
            image_data = buffer.toString('base64');
        } else {
            const isBinary = await sniffBinary(filePath, stats.size);
            if (isBinary) {
                mode = "Hex";
                const dumpBytes = Math.min(stats.size, HEX_DUMP_BYTES);
                const buffer = await readHeadBytes(filePath, dumpBytes);
                hex_lines = toHexLines(buffer);
            } else {
                const buffer = await fs.readFile(filePath);
                text = buffer.toString('utf8');
            }
        }

        res.json({
            mode,
            file_name: path.basename(filePath),
            file_size: stats.size,
            text,
            hex_lines,
            image_data,
            mime_type
        });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

router.get('/binary', async (req, res) => {
    try {
        const filePath = resolveSafePath(req.query.path);
        const stats = await fs.stat(filePath);
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
