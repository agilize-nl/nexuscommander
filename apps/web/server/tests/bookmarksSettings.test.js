// Fase 1b, item 4 (P1b.3) — routes/bookmarks.js and routes/settings.js after
// swapping a bare fs.writeFile (bookmarks) and a hand-rolled temp-file-plus-
// rename (settings) for lib/commit.js's writeFileAtomically. No prior test
// existed for either route.
//
// Both modules compute their config path from `os.homedir()` once, at import
// time — so HOME must be redirected *before* they are ever imported, not just
// before a request. Dynamic import after setting process.env.HOME is what
// makes that possible without restructuring either route.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { tmpDir, mountRouter, exists } from './helpers.js';

async function freshRoutesUnder(t, moduleName) {
    const home = await tmpDir(t, `home-${moduleName}`);
    const realHome = os.homedir();
    process.env.HOME = home;
    t.after(() => {
        process.env.HOME = realHome;
    });
    const mod = await import(`../routes/${moduleName}.js?home=${encodeURIComponent(home)}`);
    return { home, router: mod.default };
}

test('invariant_bookmarks_are_written_atomically_and_read_back', async (t) => {
    const { home, router } = await freshRoutesUnder(t, 'bookmarks');
    const client = await mountRouter(t, '/api/bookmarks', router);

    const bookmarks = [{ path: '/tmp', label: 'tmp' }];
    const { status, body } = await client.post('/api/bookmarks', { bookmarks });

    assert.equal(status, 200);
    assert.deepEqual(body, { success: true });

    const configPath = path.join(home, '.config/nexuscommander/bookmarks.json');
    assert.deepEqual(JSON.parse(await fs.readFile(configPath, 'utf8')), bookmarks);

    const leftovers = (await fs.readdir(path.dirname(configPath))).filter((n) => n.startsWith('.nc-staging-'));
    assert.deepEqual(leftovers, []);
});

test('invariant_settings_write_still_takes_its_two_backups_and_is_staged', async (t) => {
    const { home, router } = await freshRoutesUnder(t, 'settings');
    const client = await mountRouter(t, '/api/settings', router);
    const configPath = path.join(home, '.config/nexuscommander/config.json');

    // A first write with real customization, so the second write's backups
    // have something to be backups *of*.
    await client.post('/api/settings', { newConfig: { theme: 'custom-theme-one' } });
    const beforeSecondWrite = await fs.readFile(configPath, 'utf8');

    const { status, body } = await client.post('/api/settings', { newConfig: { theme: 'custom-theme-two' } });

    assert.equal(status, 200);
    assert.deepEqual(body, { success: true });

    const written = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.equal(written.theme, 'custom-theme-two');

    // backupExistingConfig() takes an unqualified .bak and a timestamped one;
    // writeFileAtomically must not have removed that behavior.
    assert.equal(await fs.readFile(`${configPath}.bak`, 'utf8'), beforeSecondWrite);
    const siblings = await fs.readdir(path.dirname(configPath));
    assert.ok(siblings.some((n) => /\.config\.\d.*\.bak$/.test(n) || /config\.json\..*\.bak$/.test(n)), siblings.join(','));
    assert.deepEqual(siblings.filter((n) => n.startsWith('.nc-staging-')), []);
});

// Fase 1 — per-client settings isolation
// (apps/web/docs/PER_CLIENT_INSTELLINGEN_PLAN.md). Server-side only: no
// browser client sends X-NC-Client-Id yet, so every test that omits the
// header is characterizing the still-load-bearing legacy path.

const VALID_ID_A = 'nc_0123456789abcdef0123456789abcdef';
const VALID_ID_B = 'nc_fedcba9876543210fedcba9876543210';

const INVALID_CLIENT_IDS = [
    '../../etc/passwd',
    'nc_abc',
    `nc_${'0'.repeat(31)}.`,
    `NC_${'0'.repeat(32)}`,
    `nc_${'A'.repeat(32)}`,
    `${VALID_ID_A}, ${VALID_ID_B}` // what a joined duplicate header collapses to
];

function legacyConfigPath(home) {
    return path.join(home, '.config/nexuscommander/config.json');
}

function profileConfigPath(home, clientId) {
    return path.join(home, '.config/nexuscommander/profiles', clientId, 'config.json');
}

test('parseClientId accepts only nc_<32 lowercase hex>, and a missing header is null, not an error', async () => {
    const { parseClientId } = await import('../lib/profiles.js');

    assert.equal(parseClientId(undefined), null);
    assert.equal(parseClientId(VALID_ID_A), VALID_ID_A);

    for (const bad of INVALID_CLIENT_IDS) {
        assert.throws(() => parseClientId(bad), (err) => err.status === 400);
    }
});

test('a request without X-NC-Client-Id reads and writes exactly the legacy path', async (t) => {
    const { home, router } = await freshRoutesUnder(t, 'settings');
    const client = await mountRouter(t, '/api/settings', router);

    await client.post('/api/settings', { newConfig: { theme: 'legacy-theme' } });

    const written = JSON.parse(await fs.readFile(legacyConfigPath(home), 'utf8'));
    assert.equal(written.theme, 'legacy-theme');

    const { body } = await client.get('/api/settings');
    assert.equal(body.theme, 'legacy-theme');
    assert.equal(await exists(path.join(home, '.config/nexuscommander/profiles')), false);
});

test('an invalid X-NC-Client-Id is rejected with 400 on GET and POST, and never touches the legacy file', async (t) => {
    const { home, router } = await freshRoutesUnder(t, 'settings');
    const client = await mountRouter(t, '/api/settings', router);

    await client.post('/api/settings', { newConfig: { theme: 'baseline' } });
    const beforeInvalid = await fs.readFile(legacyConfigPath(home), 'utf8');

    for (const invalid of INVALID_CLIENT_IDS) {
        const getResult = await client.get('/api/settings', { 'X-NC-Client-Id': invalid });
        assert.equal(getResult.status, 400, invalid);

        const postResult = await client.post(
            '/api/settings',
            { newConfig: { theme: 'attacker-controlled' } },
            { 'X-NC-Client-Id': invalid }
        );
        assert.equal(postResult.status, 400, invalid);
    }

    assert.equal(await fs.readFile(legacyConfigPath(home), 'utf8'), beforeInvalid);
});

test('two valid client IDs write to two separate profile files and cannot affect each other or legacy', async (t) => {
    const { home, router } = await freshRoutesUnder(t, 'settings');
    const client = await mountRouter(t, '/api/settings', router);

    await client.post('/api/settings', { newConfig: { theme: 'legacy-theme' } });
    await client.post('/api/settings', { newConfig: { theme: 'theme-a' } }, { 'X-NC-Client-Id': VALID_ID_A });
    await client.post('/api/settings', { newConfig: { theme: 'theme-b' } }, { 'X-NC-Client-Id': VALID_ID_B });

    const { body: bodyA } = await client.get('/api/settings', { 'X-NC-Client-Id': VALID_ID_A });
    const { body: bodyB } = await client.get('/api/settings', { 'X-NC-Client-Id': VALID_ID_B });
    assert.equal(bodyA.theme, 'theme-a');
    assert.equal(bodyB.theme, 'theme-b');

    const legacyConfig = JSON.parse(await fs.readFile(legacyConfigPath(home), 'utf8'));
    const profileA = JSON.parse(await fs.readFile(profileConfigPath(home, VALID_ID_A), 'utf8'));
    const profileB = JSON.parse(await fs.readFile(profileConfigPath(home, VALID_ID_B), 'utf8'));
    assert.equal(legacyConfig.theme, 'legacy-theme');
    assert.equal(profileA.theme, 'theme-a');
    assert.equal(profileB.theme, 'theme-b');
});

test('an unknown profile reads the legacy config as its seed, but GET never materializes a profile directory', async (t) => {
    const { home, router } = await freshRoutesUnder(t, 'settings');
    const client = await mountRouter(t, '/api/settings', router);

    await client.post('/api/settings', { newConfig: { theme: 'legacy-seed' } });

    const { body } = await client.get('/api/settings', { 'X-NC-Client-Id': VALID_ID_A });
    assert.equal(body.theme, 'legacy-seed');

    assert.equal(await exists(profileConfigPath(home, VALID_ID_A)), false);
    assert.equal(await exists(path.join(home, '.config/nexuscommander/profiles')), false);
});

test('once a profile is materialized by POST, it stays independent of later legacy changes', async (t) => {
    const { home, router } = await freshRoutesUnder(t, 'settings');
    const client = await mountRouter(t, '/api/settings', router);

    await client.post('/api/settings', { newConfig: { theme: 'legacy-v1' } });
    await client.post('/api/settings', { newConfig: { theme: 'profile-theme' } }, { 'X-NC-Client-Id': VALID_ID_A });
    await client.post('/api/settings', { newConfig: { theme: 'legacy-v2' } });

    const { body } = await client.get('/api/settings', { 'X-NC-Client-Id': VALID_ID_A });
    assert.equal(body.theme, 'profile-theme');
});

test('the 409 guard still applies within one profile and is not triggered by another profile\'s state', async (t) => {
    const { router } = await freshRoutesUnder(t, 'settings');
    const client = await mountRouter(t, '/api/settings', router);

    // Captured before any customization exists anywhere, so this is exactly
    // what mergeConfig({}, {}) produces — a legitimately "fresh" payload.
    const { body: freshDefaults } = await client.get('/api/settings');

    await client.post('/api/settings', { newConfig: { theme: 'custom-a' } }, { 'X-NC-Client-Id': VALID_ID_A });

    const blocked = await client.post('/api/settings', { newConfig: freshDefaults }, { 'X-NC-Client-Id': VALID_ID_A });
    assert.equal(blocked.status, 409);

    const { body: stillCustomA } = await client.get('/api/settings', { 'X-NC-Client-Id': VALID_ID_A });
    assert.equal(stillCustomA.theme, 'custom-a');

    // Profile B has no customization of its own; the guard must not borrow A's state.
    const accepted = await client.post('/api/settings', { newConfig: freshDefaults }, { 'X-NC-Client-Id': VALID_ID_B });
    assert.equal(accepted.status, 200);
});

test('a second write within a profile takes its two backups next to that profile file, not next to legacy', async (t) => {
    const { home, router } = await freshRoutesUnder(t, 'settings');
    const client = await mountRouter(t, '/api/settings', router);
    const profilePath = profileConfigPath(home, VALID_ID_A);

    await client.post('/api/settings', { newConfig: { theme: 'profile-v1' } }, { 'X-NC-Client-Id': VALID_ID_A });
    const beforeSecondWrite = await fs.readFile(profilePath, 'utf8');

    await client.post('/api/settings', { newConfig: { theme: 'profile-v2' } }, { 'X-NC-Client-Id': VALID_ID_A });

    assert.equal(await fs.readFile(`${profilePath}.bak`, 'utf8'), beforeSecondWrite);
    const siblings = await fs.readdir(path.dirname(profilePath));
    assert.ok(siblings.some((n) => /config\.json\..*\.bak$/.test(n)), siblings.join(','));
    assert.deepEqual(siblings.filter((n) => n.startsWith('.nc-staging-')), []);

    const legacyDir = path.dirname(legacyConfigPath(home));
    const legacySiblings = (await fs.readdir(legacyDir).catch(() => [])).filter((n) => n.includes('.bak'));
    assert.deepEqual(legacySiblings, []);
});

test('GET /api/settings sets Vary: X-NC-Client-Id and Cache-Control: no-store', async (t) => {
    const { router } = await freshRoutesUnder(t, 'settings');
    const client = await mountRouter(t, '/api/settings', router);

    const res = await fetch(`${client.base}/api/settings`);
    await res.json();

    assert.equal(res.headers.get('vary'), 'X-NC-Client-Id');
    assert.equal(res.headers.get('cache-control'), 'no-store');
});
