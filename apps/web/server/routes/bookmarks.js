import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { writeFileAtomically } from '../lib/commit.js';

const router = express.Router();
const bookmarksPath = path.join(os.homedir(), '.config/nexuscommander/bookmarks.json');

router.get('/', async (req, res) => {
    try {
        const data = await fs.readFile(bookmarksPath, 'utf8');
        res.json(JSON.parse(data));
    } catch (error) {
        res.json([]);
    }
});

router.post('/', async (req, res) => {
    try {
        const { bookmarks } = req.body;
        await fs.mkdir(path.dirname(bookmarksPath), { recursive: true });
        await writeFileAtomically(bookmarksPath, JSON.stringify(bookmarks, null, 2));
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

export default router;
