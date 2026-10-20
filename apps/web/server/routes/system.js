import express from 'express';
import { execFile, exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { resolveSafePath, isShellExecutionEnabled } from '../lib/security.js';
import { detectCapabilities } from '../lib/file-preview.js';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);
const router = express.Router();
function getDesktopAppDirs() {
    const dirs = new Set([
        path.join(os.homedir(), '.local/share/applications'),
        path.join(os.homedir(), '.local/share/flatpak/exports/share/applications'),
        '/usr/local/share/applications',
        '/usr/share/applications',
        '/var/lib/flatpak/exports/share/applications',
        '/var/lib/snapd/desktop/applications'
    ]);
    if (process.env.XDG_DATA_DIRS) {
        for (const p of process.env.XDG_DATA_DIRS.split(':')) {
            const trimmed = p.trim();
            if (!trimmed) continue;
            dirs.add(trimmed.endsWith('applications') ? trimmed : path.join(trimmed, 'applications'));
        }
    }
    return Array.from(dirs);
}

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

/// First token of an `Exec=` line with freedesktop quoting stripped:
/// `Exec=/usr/bin/gvim -f %F` -> `/usr/bin/gvim`, `Exec="my app" %f` -> `my app`.
function execBinaryFromExecLine(exec) {
    const trimmed = (exec || '').trim();
    if (!trimmed) return null;
    const first = trimmed.startsWith('"')
        ? trimmed.slice(1).split('"')[0]
        : trimmed.split(/\s+/)[0];
    return first || null;
}

/// Whether `binary` can actually be executed: a path is checked directly, a
/// bare name is looked up on PATH. Mirrors `binary_exists` in open_with.rs.
function binaryExists(binary) {
    if (!binary) return false;
    if (binary.includes('/')) {
        try {
            return fsSync.statSync(binary).isFile();
        } catch {
            return false;
        }
    }
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
        if (!dir) continue;
        try {
            if (fsSync.statSync(path.join(dir, binary)).isFile()) return true;
        } catch {
            // Not on this PATH element.
        }
    }
    return false;
}

function parseDesktopEntry(content) {
    const section = content.split(/\[Desktop Action /)[0]; // ignore action sub-sections
    const get = (key) => {
        const m = section.match(new RegExp(`^${key}=(.*)$`, 'm'));
        return m ? m[1].trim() : null;
    };
    // TryExec is the spec's own "is this actually installed?" marker; fall back
    // to the Exec binary for entries that omit it.
    const execBinary = get('TryExec') || execBinaryFromExecLine(get('Exec'));
    return {
        name: get('Name'),
        icon: get('Icon'),
        mimeTypes: (get('MimeType') || '').split(';').filter(Boolean),
        noDisplay: get('NoDisplay') === 'true' || get('Hidden') === 'true',
        execBinary,
        needsTerminal: get('Terminal') === 'true'
    };
}

/// An entry is only offered when it is genuinely launchable: its binary is
/// present, and it is not a terminal app (`gtk-launch` gives it no terminal,
/// so it would just fail silently). Distro packages such as `vim-common` ship
/// `vim.desktop` even when the binary itself was never installed.
/// Mirrors `is_launchable` in open_with.rs.
function isLaunchable(entry) {
    if (entry.needsTerminal) return false;
    return binaryExists(entry.execBinary);
}

/// Only accept `desktopEntry` values naming a `.desktop` file actually
/// installed in one of the standard application directories - the same set
/// `/open-with` draws from. These endpoints are reachable over HTTP, so they
/// must not hand an arbitrary client-supplied string to
/// `gtk-launch`/`xdg-mime` as-is. Mirrors `is_known_desktop_entry` in
/// open_with.rs.
function isKnownDesktopEntry(fileName) {
    if (
        typeof fileName !== 'string' ||
        !fileName ||
        fileName.includes('/') ||
        fileName.includes('\\') ||
        fileName.includes('..')
    ) {
        return false;
    }
    return getDesktopAppDirs().some((dir) => {
        try {
            return fsSync.statSync(path.join(dir, fileName)).isFile();
        } catch {
            return false;
        }
    });
}

async function resolveIconPath(icon) {
    if (!icon) return null;
    if (path.isAbsolute(icon)) {
        try {
            await fs.access(icon);
            return icon;
        } catch {
            return null;
        }
    }
    const searchDirs = [
        '/usr/share/pixmaps',
        '/usr/share/icons/hicolor/scalable/apps',
        '/usr/share/icons/hicolor/48x48/apps',
        '/usr/share/icons/hicolor/64x64/apps',
        '/usr/share/icons/hicolor/128x128/apps',
        '/usr/share/icons/hicolor/256x256/apps',
        path.join(os.homedir(), '.local/share/icons/hicolor/scalable/apps'),
        path.join(os.homedir(), '.local/share/icons/hicolor/48x48/apps')
    ];
    const exts = ['.png', '.svg', '.xpm', ''];
    for (const dir of searchDirs) {
        for (const ext of exts) {
            const full = path.join(dir, ext ? `${icon}${ext}` : icon);
            try {
                await fs.access(full);
                return full;
            } catch {}
        }
    }
    // Nothing resolved: the return value promises a path, so a bare theme icon
    // name is not a valid answer. The frontend decides what to render instead.
    return null;
}

async function queryGioMime(mimetype) {
    try {
        const { stdout } = await execFileAsync('gio', ['mime', mimetype]);
        let defaultApp = null;
        const apps = [];
        for (const line of stdout.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.startsWith('Default application for ')) {
                const idx = trimmed.indexOf(':');
                if (idx !== -1) {
                    const candidate = trimmed.slice(idx + 1).trim();
                    if (candidate.endsWith('.desktop')) defaultApp = candidate;
                }
            } else if (trimmed.endsWith('.desktop')) {
                const clean = trimmed.replace(/^[^a-zA-Z0-9_]+/, '');
                if (clean.endsWith('.desktop') && !apps.includes(clean)) {
                    apps.push(clean);
                }
            }
        }
        return { defaultApp, apps };
    } catch {
        return { defaultApp: null, apps: [] };
    }
}

async function listDesktopApps() {
    const results = [];
    const seen = new Set();
    const appDirs = getDesktopAppDirs();
    for (const dir of appDirs) {
        let files;
        try {
            files = await fs.readdir(dir);
        } catch {
            continue;
        }
        for (const file of files) {
            if (!file.endsWith('.desktop') || seen.has(file)) continue;
            try {
                const content = await fs.readFile(path.join(dir, file), 'utf8');
                const entry = parseDesktopEntry(content);
                if (entry.name && !entry.noDisplay && isLaunchable(entry)) {
                    seen.add(file);
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

        const gio = await queryGioMime(mimetype);
        let defaultEntry = gio.defaultApp || '';
        if (!defaultEntry) {
            try {
                const { stdout } = await execFileAsync('xdg-mime', ['query', 'default', mimetype]);
                defaultEntry = stdout.trim();
            } catch {
                // No default registered; that's fine.
            }
        }

        const apps = await listDesktopApps();
        const isTextLike = mimetype.startsWith('text/') || [
            'application/json',
            'application/javascript',
            'application/xml',
            'application/x-sh',
            'application/x-yaml',
            'application/toml',
            'application/x-desktop'
        ].includes(mimetype);

        const seen = new Set();
        const matched = [];

        if (defaultEntry) {
            const entry = apps.find(a => a.desktopEntry === defaultEntry);
            if (entry) {
                seen.add(entry.desktopEntry);
                matched.push(entry);
            }
        }
        for (const appId of gio.apps) {
            if (!seen.has(appId)) {
                const entry = apps.find(a => a.desktopEntry === appId);
                if (entry) {
                    seen.add(entry.desktopEntry);
                    matched.push(entry);
                }
            }
        }
        for (const app of apps) {
            if (!seen.has(app.desktopEntry) && app.mimeTypes.includes(mimetype)) {
                seen.add(app.desktopEntry);
                matched.push(app);
            }
        }
        if (isTextLike) {
            for (const app of apps) {
                if (!seen.has(app.desktopEntry) && app.mimeTypes.includes('text/plain')) {
                    seen.add(app.desktopEntry);
                    matched.push(app);
                }
            }
        }

        const results = await Promise.all(matched.map(async a => ({
            name: a.name,
            desktop_entry: a.desktopEntry,
            icon: await resolveIconPath(a.icon),
            is_default: a.desktopEntry === defaultEntry
        })));

        res.json(results);
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
        if (!isKnownDesktopEntry(desktopEntry)) {
            return res.status(400).json({ error: `Unknown application: ${desktopEntry}` });
        }
        const appId = desktopEntry.replace(/\.desktop$/, '');
        await execFileAsync('gtk-launch', [appId, targetPath]);
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
        if (!isKnownDesktopEntry(desktopEntry)) {
            return res.status(400).json({ error: `Unknown application: ${desktopEntry}` });
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
// line, not user-supplied network input).
//
// The origin guard in index.js stops a hostile *page* from reaching it, but it
// deliberately lets through requests that carry no Origin header at all, so it
// is no defence against a non-browser client. What makes that acceptable is
// the loopback bind (see resolveBindHost): a local process acting as this user
// can already run anything. The moment the port is exposed to a network that
// stops being true and this endpoint is a remote shell, so it is served only
// when isShellExecutionEnabled() says so - on by default on loopback, off by
// default once NC_HOST leaves it, and overridable either way with
// NC_ENABLE_SHELL.
router.post('/execute', async (req, res) => {
    try {
        if (!isShellExecutionEnabled()) {
            return res.status(403).json({
                error: 'Command execution is disabled because this backend is not bound to ' +
                    'loopback. Set NC_ENABLE_SHELL=1 to serve it anyway.'
            });
        }
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

router.get('/is-root', (req, res) => {
    const isRoot = typeof process.getuid === 'function' ? process.getuid() === 0 : false;
    res.json(isRoot);
});

router.get('/help-topics', async (req, res) => {
    try {
        const __dirname = path.dirname(fileURLToPath(import.meta.url));
        const topicsPath = path.resolve(__dirname, '../../../../packages/ui/src/lib/help/topics.json');
        const data = await fs.readFile(topicsPath, 'utf8');
        res.json(JSON.parse(data));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/help-content', async (req, res) => {
    try {
        const { file, lang } = req.query;
        if (typeof file !== 'string' || !file) {
            return res.status(400).json({ error: 'Missing file parameter' });
        }
        const safeFileName = path.basename(file);
        const __dirname = path.dirname(fileURLToPath(import.meta.url));
        const helpDir = path.resolve(__dirname, '../../../../packages/ui/src/lib/help');

        if (typeof lang === 'string' && lang) {
            const shortLang = lang.split('_')[0];
            const translatedName = safeFileName.replace(/\.md$/, `.${shortLang}.md`);
            const translatedPath = path.join(helpDir, translatedName);
            try {
                const content = await fs.readFile(translatedPath, 'utf8');
                return res.setHeader('Content-Type', 'text/plain; charset=utf-8').send(content);
            } catch {
                // Fall back to base file
            }
        }

        const basePath = path.join(helpDir, safeFileName);
        const content = await fs.readFile(basePath, 'utf8');
        res.setHeader('Content-Type', 'text/plain; charset=utf-8').send(content);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

export default router;

// Exported for the open-with test suite: these guards are the web-side mirror
// of open_with.rs and must be testable directly, not just via a live HTTP
// route that needs a desktop session to exercise.
export {
    execBinaryFromExecLine,
    binaryExists,
    parseDesktopEntry,
    isLaunchable,
    isKnownDesktopEntry,
    getDesktopAppDirs,
    resolveIconPath
};
