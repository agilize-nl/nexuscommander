import express from 'express';
import { execFile, exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { resolveSafePath } from '../lib/security.js';
import { detectCapabilities } from '../lib/file-preview.js';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);
const router = express.Router();
const DESKTOP_APP_DIRS = [
    '/usr/share/applications',
    '/usr/local/share/applications',
    path.join(os.homedir(), '.local/share/applications')
];

router.get('/os', (req, res) => res.json(os.platform()));

router.get('/user', (req, res) => {
    res.json({ username: os.userInfo().username });
});

router.get('/capabilities', async (req, res) => {
    try {
        res.json(await detectCapabilities());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

async function launchWithDefaultApp(targetPath) {
    const attempts = [];

    try {
        const { stdout: mimeOut } = await execFileAsync('xdg-mime', ['query', 'filetype', targetPath]);
        const mimetype = mimeOut.trim();
        if (mimetype) {
            const { stdout: defaultOut } = await execFileAsync('xdg-mime', ['query', 'default', mimetype]);
            const desktopEntry = defaultOut.trim();
            if (desktopEntry) {
                const appId = desktopEntry.replace(/\.desktop$/, '');
                await execFileAsync('gtk-launch', [appId, targetPath]);
                return;
            }
        }
    } catch (error) {
        attempts.push(`gtk-launch default app: ${error.message}`);
    }

    for (const [command, args] of [
        ['gio', ['open', targetPath]],
        ['xdg-open', [targetPath]]
    ]) {
        try {
            await execFileAsync(command, args);
            return;
        } catch (error) {
            attempts.push(`${command}: ${error.message}`);
        }
    }

    throw new Error(`Could not open file with a system app. ${attempts.join(' | ')}`);
}

router.post('/open-file', async (req, res) => {
    try {
        const targetPath = resolveSafePath(req.body.path);
        await launchWithDefaultApp(targetPath);
        res.json({ success: true });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

router.post('/open-terminal', async (req, res) => {
    try {
        const targetPath = resolveSafePath(req.body.path);
        const capabilities = await detectCapabilities();
        if (capabilities.headless) {
            return res.status(503).json({
                error: `No desktop terminal is available on this headless server. Connect over Tailscale SSH instead and run: cd '${targetPath}'`
            });
        }
        // ChromeOS typically uses 'terminal' or 'gnome-terminal'
        await execFileAsync('gnome-terminal', [`--working-directory=${targetPath}`]);
        res.json({ success: true });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.stderr || error.message });
    }
});

router.get('/languages', (req, res) => {
    res.json([
        { code: 'en', name: 'English' },
        { code: 'nl', name: 'Nederlands' },
        { code: 'de', name: 'Deutsch' },
        { code: 'fr', name: 'Français' },
        { code: 'es', name: 'Español' },
        { code: 'pt', name: 'Português' }
    ]);
});

router.get('/language/:lang', async (req, res) => {
    try {
        const supported = new Set(['en', 'nl', 'de', 'fr', 'es', 'pt']);
        const lang = supported.has(req.params.lang) ? req.params.lang : 'en';
        const __dirname = path.dirname(fileURLToPath(import.meta.url));
        const langPath = path.join(__dirname, '..', 'langs', `${lang}.json`);
        const data = await fs.readFile(langPath, 'utf8');
        res.json(JSON.parse(data));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ===== Open with / default app (Linux .desktop / xdg-mime integration) =====

function parseDesktopEntry(content) {
    const section = content.split(/\[Desktop Action /)[0]; // ignore action sub-sections
    const get = (key) => {
        const m = section.match(new RegExp(`^${key}=(.*)$`, 'm'));
        return m ? m[1].trim() : null;
    };
    return {
        name: get('Name'),
        icon: get('Icon'),
        mimeTypes: (get('MimeType') || '').split(';').filter(Boolean),
        noDisplay: get('NoDisplay') === 'true' || get('Hidden') === 'true'
    };
}

async function listDesktopApps() {
    const results = [];
    for (const dir of DESKTOP_APP_DIRS) {
        let files;
        try {
            files = await fs.readdir(dir);
        } catch {
            continue;
        }
        for (const file of files) {
            if (!file.endsWith('.desktop')) continue;
            try {
                const content = await fs.readFile(path.join(dir, file), 'utf8');
                const entry = parseDesktopEntry(content);
                if (entry.name && !entry.noDisplay) {
                    results.push({ desktopEntry: file, ...entry });
                }
            } catch {
                // Skip unreadable/malformed .desktop files.
            }
        }
    }
    return results;
}

router.get('/open-with', async (req, res) => {
    try {
        const targetPath = resolveSafePath(req.query.path);
        const { stdout: mimeOut } = await execFileAsync('xdg-mime', ['query', 'filetype', targetPath]);
        const mimetype = mimeOut.trim();
        let defaultEntry = '';
        try {
            const { stdout } = await execFileAsync('xdg-mime', ['query', 'default', mimetype]);
            defaultEntry = stdout.trim();
        } catch {
            // No default registered; that's fine.
        }

        const apps = await listDesktopApps();
        const matching = apps.filter(a => a.mimeTypes.includes(mimetype));
        res.json(matching.map(a => ({
            name: a.name,
            desktop_entry: a.desktopEntry,
            icon: a.icon,
            is_default: a.desktopEntry === defaultEntry
        })));
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

router.post('/open-file-with', async (req, res) => {
    try {
        const targetPath = resolveSafePath(req.body.path);
        const { desktopEntry } = req.body;
        if (typeof desktopEntry !== 'string' || !desktopEntry) {
            return res.status(400).json({ error: 'Missing desktopEntry' });
        }
        const appId = desktopEntry.replace(/\.desktop$/, '');
        execFile('gtk-launch', [appId, targetPath]);
        res.json({ success: true });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

router.post('/set-default-app', async (req, res) => {
    try {
        const targetPath = resolveSafePath(req.body.path);
        const { desktopEntry } = req.body;
        if (typeof desktopEntry !== 'string' || !desktopEntry) {
            return res.status(400).json({ error: 'Missing desktopEntry' });
        }
        const { stdout: mimeOut } = await execFileAsync('xdg-mime', ['query', 'filetype', targetPath]);
        const mimetype = mimeOut.trim();
        await execFileAsync('xdg-mime', ['default', desktopEntry, mimetype]);
        res.json({ success: true });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

// ===== Command line execution =====
// This intentionally runs the user's own typed command through a shell (pipes,
// redirects, globbing are expected here - it's the app's built-in command
// line, not user-supplied network input). It's safe because the global
// CORS/origin guard in index.js means only this app's own frontend can reach
// it, never an arbitrary cross-origin page.
router.post('/execute', async (req, res) => {
    try {
        const { command, currentDir } = req.body;
        if (typeof command !== 'string' || !command.trim()) {
            return res.status(400).json({ error: 'Missing command' });
        }
        const cwd = resolveSafePath(currentDir, 'currentDir');
        const { stdout, stderr } = await execAsync(command, { cwd, timeout: 30000, maxBuffer: 5 * 1024 * 1024 });
        res.json(stdout || stderr || '');
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.stderr || error.message });
    }
});

// ===== Network drives (GVFS-backed on Linux) =====

router.post('/map-network-drive', async (req, res) => {
    try {
        const { path: uri } = req.body;
        if (typeof uri !== 'string' || !uri) {
            return res.status(400).json({ error: 'Missing path/URI' });
        }
        await execFileAsync('gio', ['mount', uri]);
        res.json({ success: true });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.stderr || error.message });
    }
});

router.post('/disconnect-network-drive', async (req, res) => {
    try {
        const { pathOrLetter } = req.body;
        if (typeof pathOrLetter !== 'string' || !pathOrLetter) {
            return res.status(400).json({ error: 'Missing path' });
        }
        await execFileAsync('gio', ['mount', '-u', pathOrLetter]);
        res.json({ success: true });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.stderr || error.message });
    }
});

router.post('/open-config-dir', async (req, res) => {
    try {
        const configDir = path.join(os.homedir(), '.config/nexuscommander');
        await fs.mkdir(configDir, { recursive: true });
        execFile('xdg-open', [configDir]);
        res.json({ success: true });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

export default router;
