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

/**
 * Whether a bind address only accepts connections from this machine.
 *
 * This is the *entire* trust model of the web backend: `originGuard` below
 * stops a hostile page in the user's browser, but it cannot stop a non-browser
 * client, which sends no `Origin` header at all and is therefore allowed
 * through by design (a local script acting as the user can already do
 * everything this API does). That reasoning only holds while "reachable" means
 * "reachable from localhost" — which is why binding anywhere else has to be a
 * deliberate, separately-authenticated act rather than the default.
 */
export function isLoopbackBindAddress(host) {
    if (!host) return false;
    const h = host.trim().replace(/^\[|\]$/g, '').toLowerCase();
    if (h === 'localhost') return true;
    if (h === '::1') return true;
    if (h === '::ffff:127.0.0.1') return true;
    return /^127\./.test(h);
}

/**
 * Resolve the bind address and refuse a non-loopback one that was not asked
 * for explicitly.
 *
 * The default used to be `0.0.0.0`, so `node server/index.js` on any machine
 * with a network handed the whole filesystem — including `POST
 * /system/execute`, which runs its body through a shell — to anyone who could
 * reach the port. The production deployment fronts this with Caddy and already
 * sets `NC_HOST=127.0.0.1` (`.env.example`), so nothing about that path
 * changes; what changes is that the unconfigured case is now the safe one.
 */
export function resolveBindHost(env = process.env) {
    const host = env.NC_HOST || '127.0.0.1';
    const loopback = isLoopbackBindAddress(host);
    if (!loopback && env.NC_ALLOW_REMOTE !== '1') {
        const err = new Error(
            `Refusing to bind to ${host}: this backend has no authentication of its own, ` +
            'so anything that reaches the port acts with the service user\'s file system rights.\n' +
            'Either bind to 127.0.0.1 and put authentication in front of it (the shipped ' +
            'deploy/nexuscommander.Caddyfile does this), or set NC_ALLOW_REMOTE=1 to state ' +
            'that the network it is exposed on is already trusted.'
        );
        err.code = 'NC_UNSAFE_BIND';
        throw err;
    }
    return { host, loopback };
}

/**
 * Whether `POST /system/execute` — the app's built-in command line, which runs
 * its argument through a shell on purpose — is served.
 *
 * On a loopback bind it is the feature it looks like. Once the port is exposed
 * to a network, it is a remote shell, so it has to be asked for by name.
 */
export function isShellExecutionEnabled(env = process.env) {
    if (env.NC_ENABLE_SHELL === '0') return false;
    if (env.NC_ENABLE_SHELL === '1') return true;
    return isLoopbackBindAddress(env.NC_HOST || '127.0.0.1');
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
        return parsed.hostname.toLowerCase();
    } catch {
        return null;
    }
}

const WILDCARD_BIND_HOSTS = new Set(['0.0.0.0', '::', '[::]']);

/**
 * The host names this backend answers to.
 *
 * Loopback, every host named in `NC_ALLOWED_ORIGINS` (the deployment's own
 * public names), a specific `NC_HOST` bind address, and whatever
 * `NC_ALLOWED_HOSTS` adds — e.g. the LAN address of an `NC_ALLOW_REMOTE` box.
 */
export function allowedHostnames(env = process.env) {
    const names = new Set(['localhost', '127.0.0.1', '[::1]']);
    const origins = (env.NC_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    for (const origin of origins) {
        try {
            names.add(new URL(origin).hostname.toLowerCase());
        } catch {
            // A malformed origin cannot match a request either; ignore it.
        }
    }
    const bind = (env.NC_HOST || '').trim().toLowerCase();
    if (bind && !WILDCARD_BIND_HOSTS.has(bind)) {
        names.add(bind.includes(':') && !bind.startsWith('[') ? `[${bind}]` : bind);
    }
    for (const host of (env.NC_ALLOWED_HOSTS || '').split(',')) {
        const h = parseHostHeader(host.trim());
        if (h) names.add(h);
    }
    return names;
}

/**
 * Whether a request's `Host` header names this backend.
 *
 * This is what makes the origin check below mean anything. A DNS-rebinding
 * page on `evil.example:3721` that re-points its name at 127.0.0.1 sends
 * `Origin` *and* `Host` as `evil.example:3721`: the same-host rule matched them
 * against each other and let it through to `/system/execute`. Its `Host` is
 * not one of ours, so it is refused here before any route runs.
 */
export function isAllowedHost(hostHeader, names = ALLOWED_HOSTNAMES) {
    const hostname = parseHostHeader(hostHeader);
    if (!hostname) return false;
    return names.has(hostname) || /^127\.\d+\.\d+\.\d+$/.test(hostname);
}

const ALLOWED_HOSTNAMES = allowedHostnames();

export function hostGuard(req, res, next) {
    if (!isAllowedHost(req.headers.host)) {
        return res.status(403).json({
            error: `Forbidden host: ${req.headers.host ?? '(none)'}. Add it to NC_ALLOWED_HOSTS if this server is meant to answer to that name.`
        });
    }
    next();
}

/**
 * Only meaningful behind `hostGuard`: the same-host rule compares the Origin
 * with a `Host` header the client chose, so on its own a rebinding page passes
 * it by sending the same foreign name in both.
 */
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

