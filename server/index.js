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
import { isAllowedOrigin, originGuard } from './lib/security.js';
import uploadRoutes from './routes/upload.js';

const app = express();
const PORT = Number(process.env.NC_PORT || 3721);
const HOST = process.env.NC_HOST || '0.0.0.0';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.resolve(__dirname, '..', 'build');
const buildIndex = path.join(buildDir, 'index.html');
const hasBuild = fs.existsSync(buildIndex);
const { version } = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));

app.use((req, res, next) => {
    cors({
        origin(origin, callback) {
            callback(null, isAllowedOrigin(origin, req.headers.host));
        }
    })(req, res, next);
});
app.use(originGuard);
app.use('/api/upload', uploadRoutes);
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
    app.use(express.static(buildDir, { index: false }));

    // SPA fallback for all non-API GET requests when the production build exists.
    app.get(/^(?!\/api(?:\/|$)).*/, (req, res) => {
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
});
server.requestTimeout = 0;

