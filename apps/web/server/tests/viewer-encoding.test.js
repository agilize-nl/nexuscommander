import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import express from 'express';
import viewerRouter from '../routes/viewer.js';

test('viewer encoding route decodes files across encodings', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-viewer-test-'));
    const testFile = path.join(tmpDir, 'test.wpd');
    
    // Write binary / formatted file (like WordPerfect starting with WPC#\0\1 and CP1250 bytes)
    const buf = Buffer.from([0x57, 0x50, 0x43, 0x23, 0x00, 0x01, 0xB3, 0xBF]);
    await fs.writeFile(testFile, buf);

    const app = express();
    app.use('/viewer', viewerRouter);

    const server = app.listen(0);
    const port = server.address().port;

    try {
        // 1. Auto-detect on binary/unformatted
        const resAuto = await fetch(`http://127.0.0.1:${port}/viewer/read?path=${encodeURIComponent(testFile)}`);
        assert.equal(resAuto.status, 200);
        const jsonAuto = await resAuto.json();
        assert.equal(jsonAuto.file_name, 'test.wpd');
        assert(jsonAuto.hex_lines.length > 0);
        assert(jsonAuto.text !== null);

        // 2. Specific CP1250 request
        const resCp = await fetch(`http://127.0.0.1:${port}/viewer/read?path=${encodeURIComponent(testFile)}&encoding=CP1250`);
        assert.equal(resCp.status, 200);
        const jsonCp = await resCp.json();
        assert.equal(jsonCp.mode, 'Text');
        assert.equal(jsonCp.encoding, 'CP1250');
        // 0xB3 in CP1250 is 'ł', 0xBF is 'ż'
        assert(jsonCp.text.includes('łż'));

        // 3. All 34 encodings
        const encodings = [
            'Auto-detect', 'UTF-8', 'UTF-8BOM', 'ANSI', 'OEM',
            'CP1250', 'CP1251', 'CP1252', 'CP1253', 'CP1254', 'CP1255', 'CP1256', 'CP1257', 'CP1258',
            'CP437', 'CP850', 'CP852', 'CP866', 'CP874', 'CP932', 'CP936', 'CP949', 'CP950',
            'ISO-8859-1', 'ISO-8859-2', 'KOI8-R', 'KOI8-U', 'KOI8-RU',
            'UCS-2LE', 'UCS-2BE', 'UTF-16LE', 'UTF-16BE', 'UTF-32LE', 'UTF-32BE'
        ];

        for (const enc of encodings) {
            const res = await fetch(`http://127.0.0.1:${port}/viewer/read?path=${encodeURIComponent(testFile)}&encoding=${encodeURIComponent(enc)}`);
            assert.equal(res.status, 200, `Failed for encoding ${enc}`);
            const data = await res.json();
            assert(data.text !== null, `Missing text for encoding ${enc}`);
        }
    } finally {
        server.close();
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
});
