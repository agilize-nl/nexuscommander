import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fsRoutes from './routes/fs.js';
import archiveRoutes from './routes/archive.js';
import viewerRoutes from './routes/viewer.js';
import previewRoutes from './routes/preview.js';
import taskRoutes from './routes/tasks.js';
import settingsRoutes from './routes/settings.js';
import bookmarkRoutes from './routes/bookmarks.js';
import systemRoutes from './routes/system.js';
import { hostGuard, isAllowedOrigin, originGuard, resolveBindHost } from './lib/security.js';
import { buildCsp } from './lib/csp.js';
import uploadRoutes from './routes/upload.js';
import downloadRoutes from './routes/download.js';

const app = express();
const PORT = Number(process.env.NC_PORT || 3721);

let bind;
try {
    bind = resolveBindHost();
} catch (e) {
    console.error(`\n❌ ${e.message}\n`);
    process.exit(1);
}
const HOST = bind.host;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.resolve(__dirname, '..', 'build');
const buildIndex = path.join(buildDir, 'index.html');
const hasBuild = fs.existsSync(buildIndex);
const appCsp = hasBuild ? buildCsp(fs.readFileSync(buildIndex, 'utf8')) : null;
const { version } = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));

// First, before CORS and before the static build: a request for a host name
// that is not ours is a DNS-rebinding attempt or a misconfiguration, and
// neither should reach a route.
app.use(hostGuard);
app.use((req, res, next) => {
    cors({
        origin(origin, callback) {
            callback(null, isAllowedOrigin(origin, req.headers.host));
        }
    })(req, res, next);
});
app.use(originGuard);
// Mounted ahead of the global JSON parser because each brings its own with a
// larger limit. Behind it, the global one (100 kB) parsed the body first and
// the route's limit never applied: a 500-item download selection got a 413.
app.use('/api/upload', uploadRoutes);
app.use('/api/download', downloadRoutes);
app.use(express.json());

// Main API routes
app.use('/api/fs', fsRoutes);
app.use('/api/archive', archiveRoutes);
app.use('/api/viewer', viewerRoutes);
app.use('/api/preview', previewRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/bookmarks', bookmarkRoutes);
app.use('/api/system', systemRoutes);

app.get('/api/health', (req, res) => {
    res.json({ status: 'NexusCommander Backend Running', version });
});

if (hasBuild) {
    app.use(express.static(buildDir, {
        index: false,
        setHeaders(res, filePath) {
            if (filePath.endsWith('.html')) res.setHeader('Content-Security-Policy', appCsp);
        }
    }));

    // SPA fallback for all non-API GET requests when the production build exists.
    app.get(/^(?!\/api(?:\/|$)).*/, (req, res) => {
        res.setHeader('Content-Security-Policy', appCsp);
        res.sendFile(buildIndex);
    });
} else {
    app.get('/', (req, res) => {
        res.json({
            status: 'NexusCommander Backend Running',
            version,
            frontend: 'Build not found; run npm run build for standalone mode'
        });
    });
}

const server = app.listen(PORT, HOST, () => {
    console.log(`NexusCommander Backend listening on http://${HOST}:${PORT}`);
    if (!bind.loopback) {
        console.warn(
            `⚠️  Bound to ${HOST} with NC_ALLOW_REMOTE=1. This backend authenticates nobody; ` +
            'whatever fronts it must.'
        );
    }
});
// Uploads and long copies stream for as long as they need, so there is no
// whole-request deadline. A stalled upload is caught by the idle timeout in
// routes/upload.js instead; the header timeout covers a client that never
// finishes sending its request line.
server.requestTimeout = 0;
server.headersTimeout = 60_000;

