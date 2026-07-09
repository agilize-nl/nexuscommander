import path from 'path';
import os from 'os';

/**
 * NexusCommander is a local two-panel file manager: its whole purpose is to give
 * the logged-in user full filesystem access, so paths are intentionally NOT
 * jailed to a single root (that would break browsing other drives/mounts).
 * The actual attack surface this bridge exposes is a browser tab on the same
 * machine calling into this API cross-origin - see ALLOWED_ORIGINS/originGuard
 * below, which is what actually stops an untrusted page from using it.
 */
export function resolveSafePath(input, label = 'path') {
    if (typeof input !== 'string' || input.length === 0) {
        const err = new Error(`Missing or invalid ${label}`);
        err.statusCode = 400;
        throw err;
    }
    if (input.includes('\0')) {
        const err = new Error(`Invalid ${label}`);
        err.statusCode = 400;
        throw err;
    }
    return path.resolve(input);
}

const PROTECTED_ROOTS = new Set([
    '/', '/etc', '/bin', '/usr', '/boot', '/proc', '/sys', '/dev',
    '/root', '/lib', '/lib64', '/sbin', '/var', os.homedir()
]);

// Refuses to delete/rename-away well-known critical roots and the user's
// home directory itself (deleting *inside* the home dir is still allowed).
export function assertNotProtectedRoot(resolvedPath) {
    if (PROTECTED_ROOTS.has(resolvedPath)) {
        const err = new Error(`Refusing to operate on protected path: ${resolvedPath}`);
        err.statusCode = 400;
        throw err;
    }
}

export const ALLOWED_ORIGINS = (
    process.env.NC_ALLOWED_ORIGINS ||
    'http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173'
).split(',').map(s => s.trim()).filter(Boolean);

const ALLOWED_SAME_HOST_ORIGIN_PORTS = (
    process.env.NC_ALLOWED_ORIGIN_PORTS || '5173,4173,3721'
).split(',').map(s => s.trim()).filter(Boolean);

function parseHostHeader(hostHeader) {
    if (!hostHeader) return null;
    try {
        const parsed = new URL(`http://${hostHeader}`);
        return parsed.hostname;
    } catch {
        return hostHeader.split(':')[0] || null;
    }
}

export function isAllowedOrigin(origin, hostHeader) {
    if (!origin) return true;
    if (ALLOWED_ORIGINS.includes(origin)) return true;

    try {
        const originUrl = new URL(origin);
        const requestHostname = parseHostHeader(hostHeader);

        return Boolean(
            requestHostname &&
            originUrl.hostname === requestHostname &&
            ALLOWED_SAME_HOST_ORIGIN_PORTS.includes(originUrl.port)
        );
    } catch {
        return false;
    }
}

// Defense in depth beyond the `cors` package: reject *any* request that carries
// a foreign Origin header, including "simple" requests (plain GET/no custom
// headers) that browsers don't send a CORS preflight for but still label with
// an Origin header when made cross-origin.
export function originGuard(req, res, next) {
    if (!isAllowedOrigin(req.headers.origin, req.headers.host)) {
        return res.status(403).json({ error: 'Forbidden origin' });
    }
    next();
}

/**
 * Validates and sanitizes a relative path string.
 * @param {string} rel
 * @returns {string}
 */
export function sanitizeRelPath(rel) {
    if (typeof rel !== 'string' || rel.length === 0) {
        const err = new Error('Missing or invalid relative path');
        err.statusCode = 400;
        throw err;
    }
    if (rel.includes('\0')) {
        const err = new Error('Relative path contains null byte');
        err.statusCode = 400;
        throw err;
    }
    if (rel.includes('\\')) {
        const err = new Error('Relative path cannot contain backslashes');
        err.statusCode = 400;
        throw err;
    }
    
    const normalized = rel.normalize('NFC');
    
    if (Buffer.byteLength(normalized, 'utf8') > 4096) {
        const err = new Error('Relative path too long');
        err.statusCode = 400;
        throw err;
    }

    const segments = normalized.split('/');
    for (const segment of segments) {
        if (segment === '' || segment === '.' || segment === '..') {
            const err = new Error('Invalid path segment');
            err.statusCode = 400;
            throw err;
        }
        if (/^\.+$/.test(segment)) {
            const err = new Error('Invalid path segment containing only dots');
            err.statusCode = 400;
            throw err;
        }
        if (/[\x00-\x1f\x7f]/.test(segment)) {
            const err = new Error('Relative path contains control characters');
            err.statusCode = 400;
            throw err;
        }
        if (Buffer.byteLength(segment, 'utf8') > 255) {
            const err = new Error('Path segment too long');
            err.statusCode = 400;
            throw err;
        }
    }
    return segments.join('/');
}

