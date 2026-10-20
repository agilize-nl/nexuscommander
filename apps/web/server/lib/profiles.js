// Per-client settings isolation — Fase 1 of
// apps/web/docs/PER_CLIENT_INSTELLINGEN_PLAN.md. This module holds only ID
// validation and path resolution; routes/settings.js decides what to do with
// the paths.

import os from 'os';
import path from 'path';

const CLIENT_ID_RE = /^nc_[a-f0-9]{32}$/;

// A function, not a module-level constant: the settings route tests redirect
// HOME before a dynamic import to isolate each test case. A cached
// `CONFIG_ROOT` computed once at import time would silently defeat that
// isolation instead of failing loudly.
export function configRoot() {
    return path.join(os.homedir(), '.config/nexuscommander');
}

/**
 * `undefined` (header absent) returns `null` — the caller's cue to fall back
 * to legacy behavior. Anything present that doesn't match the whitelist
 * throws a 400-tagged error; it must never silently resolve to the legacy
 * path, since that would let a typo or a probing request land unnoticed in
 * the shared file.
 */
export function parseClientId(value) {
    if (value === undefined) return null;
    if (typeof value !== 'string' || !CLIENT_ID_RE.test(value)) {
        const error = new Error('Invalid X-NC-Client-Id');
        error.status = 400;
        throw error;
    }
    return value;
}

export function legacySettingsPath() {
    return path.join(configRoot(), 'config.json');
}

export function profileSettingsPath(clientId) {
    return path.join(configRoot(), 'profiles', clientId, 'config.json');
}
