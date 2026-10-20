// P2.1 — one source of truth for what this backend can actually do with each
// archive format.
//
// `GET /api/archive/capabilities` used to return a hand-written list that
// advertised `canPack: true` for tar.gz, tar.zst and 7z, while `POST
// /api/archive/pack` ignored the destination extension entirely and always built
// a ZIP with AdmZip. Packing `backup.tar.gz` produced a ZIP carrying that name —
// QSF-005 exactly: a format claim the writer never honoured, and a file the user
// could not open with the tool the extension implies.
//
// So the table below is what both endpoints read. A format is advertised as
// packable only if this file names a writer for it *and* the binaries that writer
// needs are on PATH, which is why `capabilities()` probes rather than asserts:
// this backend runs on whatever host it is installed on, and `tar.zst` without
// `zstd` is not a capability.
//
// Deliberately the same six formats desktop's `get_archive_capabilities()`
// returns, with the same level ranges, so the shared frontend sees one shape from
// both shells.

import fs from 'fs/promises';
import fssync from 'fs';
import path from 'path';

/**
 * `writer` is the mechanism `/pack` dispatches on; `null` means this backend
 * cannot create the format at all (7z, matching desktop, which also reports
 * `can_pack: false` for it).
 *
 * `packRequires`/`readRequires` are external programs. `tar` shells out to the
 * compressor itself when *reading* (`tar xf` sniffs the stream), so reading
 * tar.zst needs `zstd` present just as writing it does.
 */
const FORMATS = [
    {
        id: 'zip',
        extensions: ['.zip'],
        // Streamed with yazl. AdmZip used to build the whole archive in one
        // Buffer, so packing a large folder took the server down; it also had
        // no level knob, which is why this range used to be pinned at 6.
        writer: 'yazl',
        packRequires: [],
        readRequires: [],
        levels: { min: 0, max: 9, default: 6 }
    },
    {
        id: 'tar.gz',
        extensions: ['.tar.gz', '.tgz'],
        writer: 'tar',
        compressor: 'gzip',
        packRequires: ['tar', 'gzip'],
        readRequires: ['tar', 'gzip'],
        levels: { min: 1, max: 9, default: 6 }
    },
    {
        id: 'tar.bz2',
        extensions: ['.tar.bz2', '.tbz2'],
        writer: 'tar',
        compressor: 'bzip2',
        packRequires: ['tar', 'bzip2'],
        readRequires: ['tar', 'bzip2'],
        levels: { min: 1, max: 9, default: 6 }
    },
    {
        id: 'tar.xz',
        extensions: ['.tar.xz', '.txz'],
        writer: 'tar',
        compressor: 'xz',
        packRequires: ['tar', 'xz'],
        readRequires: ['tar', 'xz'],
        levels: { min: 1, max: 9, default: 6 }
    },
    {
        id: 'tar.zst',
        extensions: ['.tar.zst', '.tzst', '.zst'],
        writer: 'tar',
        compressor: 'zstd',
        packRequires: ['tar', 'zstd'],
        readRequires: ['tar', 'zstd'],
        levels: { min: 1, max: 22, default: 3 }
    },
    {
        id: '7z',
        extensions: ['.7z'],
        writer: null,
        packRequires: null,
        readRequires: ['7z'],
        levels: { min: 0, max: 9, default: 5 }
    }
];

/** The `.tar` container with no compression — packable, and read by plain `tar`. */
const PLAIN_TAR = {
    id: 'tar',
    extensions: ['.tar'],
    writer: 'tar',
    compressor: null,
    packRequires: ['tar'],
    readRequires: ['tar'],
    levels: { min: 0, max: 0, default: 0 }
};

const ALL_FORMATS = [...FORMATS, PLAIN_TAR];

/**
 * Resolve a bare program name against PATH.
 *
 * Spawning `prog --version` and reading the exit code is the obvious probe and
 * the wrong one: `bzip2 --version` prints its banner and exits non-zero, so the
 * probe would report a present binary as missing. Looking for an executable file
 * on PATH answers the question that is actually being asked.
 */
async function onPath(program) {
    const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
        try {
            await fs.access(path.join(dir, program), fssync.constants.X_OK);
            return true;
        } catch {
            // Next directory. A missing or unreadable PATH entry is normal.
        }
    }
    return false;
}

/**
 * Probes are cached for the process lifetime: the capability list is fetched on
 * every pack dialog, and walking PATH six times per request to learn what has
 * not changed since boot is waste. Installing `zstd` under a running server
 * therefore needs a restart to be noticed — an acceptable trade for a file
 * manager, and the alternative (re-probing per request) hid nothing useful.
 */
const probeCache = new Map();

function probe(program) {
    if (!probeCache.has(program)) probeCache.set(program, onPath(program));
    return probeCache.get(program);
}

/** Whether `program` is on PATH (cached; see `probe`). */
export function toolAvailable(program) {
    return probe(program);
}

/** Test seam: drop the cached probes so a test can control what is "installed". */
export function _resetToolProbes() {
    probeCache.clear();
}

async function allPresent(programs) {
    if (!programs) return false;
    for (const program of programs) {
        if (!(await probe(program))) return false;
    }
    return true;
}

/** The format whose extension `destPath` carries, or null. */
export function formatFromPath(destPath) {
    const lower = destPath.toLowerCase();
    // Longest extension first, so `.tar.gz` is not read as `.gz`-less plain tar
    // and `.tar.zst` never matches `.tar`.
    const byLength = ALL_FORMATS.flatMap((f) => f.extensions.map((ext) => ({ ext, format: f }))).sort(
        (a, b) => b.ext.length - a.ext.length
    );
    for (const { ext, format } of byLength) {
        if (lower.endsWith(ext)) return format;
    }
    return null;
}

export function formatById(id) {
    return ALL_FORMATS.find((f) => f.id === id) || null;
}

/**
 * The list `GET /api/archive/capabilities` returns, in desktop's field shape.
 *
 * Plain `.tar` is left out to keep the two shells' lists identical — desktop has
 * no plain-tar writer either. `/pack` still accepts a `.tar` destination, so this
 * under-promises rather than over-promises, which is the direction that cannot
 * mislead.
 */
export async function capabilities() {
    const out = [];
    for (const format of FORMATS) {
        const readable = await allPresent(format.readRequires);
        out.push({
            format: format.id,
            canPack: format.writer !== null && (await allPresent(format.packRequires)),
            canUnpack: readable,
            canRead: readable,
            minCompressionLevel: format.levels.min,
            maxCompressionLevel: format.levels.max,
            defaultCompressionLevel: format.levels.default
        });
    }
    return out;
}

/** Whether every program this format's writer needs is installed. */
export async function canPack(format) {
    return format.writer !== null && allPresent(format.packRequires);
}

/** Every format this host can currently write, for error messages. */
export async function packableFormatIds() {
    const ids = [];
    for (const format of ALL_FORMATS) {
        if (await canPack(format)) ids.push(format.id);
    }
    return ids;
}

/**
 * Clamp a requested compression level into the range the format accepts.
 *
 * Clamping rather than rejecting: a level outside the range is a UI mismatch, not
 * a data risk, and the archive that comes out is still exactly the format asked
 * for. The format itself is never substituted — that is the part `/pack` refuses
 * over.
 */
export function clampLevel(format, requested) {
    const level = Number(requested);
    if (!Number.isFinite(level)) return format.levels.default;
    return Math.min(format.levels.max, Math.max(format.levels.min, Math.round(level)));
}
