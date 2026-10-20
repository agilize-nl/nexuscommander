// Fase 1b, item 1 (P1b.0) — the path guards that must survive the phase.
//
// All `invariant_*`: P1b.2 adds component-wise no-follow resolution *beside*
// these, it does not replace them. If one of these goes red during the rewrite,
// a guard was dropped rather than strengthened.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';

import { resolveSafePath, assertNotProtectedRoot, sanitizeRelPath } from '../lib/security.js';

test('invariant_resolve_safe_path_absolutises_and_rejects_junk', () => {
    assert.equal(resolveSafePath('/tmp/./a/../b'), '/tmp/b');

    for (const bad of ['', null, undefined, 42, '/tmp/a\0b']) {
        assert.throws(() => resolveSafePath(bad), /Missing or invalid|Invalid/);
    }
});

test('invariant_protected_roots_are_refused', () => {
    const protectedRoots = [
        '/', '/etc', '/bin', '/usr', '/boot', '/proc', '/sys', '/dev',
        '/root', '/lib', '/lib64', '/sbin', '/var', os.homedir()
    ];

    for (const root of protectedRoots) {
        assert.throws(
            () => assertNotProtectedRoot(root),
            /Refusing to operate on protected path/,
            `${root} must stay protected`
        );
    }

    // Deleting *inside* the home directory stays allowed — the guard is about
    // the roots themselves, and widening it would break ordinary use.
    assert.doesNotThrow(() => assertNotProtectedRoot(`${os.homedir()}/Documents`));
});

test('invariant_sanitize_rel_path_rejects_traversal_and_control_characters', () => {
    for (const bad of [
        '../escape',
        'a/../../escape',
        'a//b',
        './a',
        'a/./b',
        'a\\b',
        'a\0b',
        'a/\x01b',
        `a/${'x'.repeat(256)}`
    ]) {
        assert.throws(() => sanitizeRelPath(bad), `${JSON.stringify(bad)} must be rejected`);
    }

    assert.equal(sanitizeRelPath('dir/sub/file.txt'), 'dir/sub/file.txt');
});
