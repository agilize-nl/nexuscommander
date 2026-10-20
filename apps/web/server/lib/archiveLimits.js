import fs from 'fs/promises';
import { toolAvailable } from './archiveFormats.js';

// Bounds on what extracting an archive is allowed to cost.
//
// An archive is attacker-authored data even when the user picked the file
// themselves — the entry count, the declared sizes and the compression ratio
// are all chosen by whoever built it. Without a ceiling, `extractAllTo` on a
// 42 KB zip bomb fills the destination filesystem, and `gunzipSync` on a
// modest .gz allocates its full decompressed size as one Buffer before
// anything else gets a chance to notice.
//
// These are not security boundaries against the *user* — this backend hands
// out the user's own filesystem on purpose. They are the difference between
// "that archive was malformed" and "the machine needs a reboot".

/** Parse a positive integer env override, falling back to `fallback`. */
function envInt(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function archiveLimits() {
    return {
        /** Entries in one archive. */
        maxEntries: envInt('NC_MAX_ARCHIVE_ENTRIES', 200_000),
        /** Total uncompressed bytes across all entries. */
        maxTotalBytes: envInt('NC_MAX_ARCHIVE_BYTES', 32 * 1024 * 1024 * 1024),
        /** Uncompressed:compressed ratio, checked over the archive as a whole. */
        maxRatio: envInt('NC_MAX_ARCHIVE_RATIO', 200),
        /**
         * Ceiling for the one-shot, fully-in-memory gzip path. Node caps a
         * Buffer at ~2 GiB anyway; this fails fast with a sentence that says
         * what happened instead of an allocation error deep in zlib.
         */
        maxGunzipBytes: envInt('NC_MAX_GUNZIP_BYTES', 1024 * 1024 * 1024),
        /**
         * Largest zip handed to AdmZip, which reads the *whole archive* into
         * one Buffer before it can list a single entry. Above this a zip goes
         * through 7z, which streams.
         */
        maxInMemoryZipBytes: envInt('NC_MAX_INMEMORY_ZIP_BYTES', 512 * 1024 * 1024)
    };
}

/**
 * The reader for a zip: 'adm-zip' (in memory) or '7z' (streaming).
 *
 * Without this a multi-gigabyte zip was read into memory to be listed, tested
 * or extracted — and a single such request could exhaust the server's heap.
 * A large zip with no 7z installed is refused with a sentence instead.
 */
export async function zipReader(archivePath, limits = archiveLimits()) {
    const { size } = await fs.stat(archivePath);
    if (size <= limits.maxInMemoryZipBytes) return 'adm-zip';
    if (await toolAvailable('7z')) return '7z';
    throw new ArchiveLimitError(
        `This zip is ${size} bytes, over the ${limits.maxInMemoryZipBytes}-byte limit for reading it in memory. ` +
        'Install 7z (p7zip) on the server to handle large zips, or raise NC_MAX_INMEMORY_ZIP_BYTES.'
    );
}

/** `archiveKind`, with a large zip routed to the 7z reader. */
export async function readerKind(kind, archivePath) {
    if (kind === 'zip' && (await zipReader(archivePath)) === '7z') return '7z';
    return kind;
}

export class ArchiveLimitError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ArchiveLimitError';
        this.statusCode = 413;
    }
}

/**
 * Refuse a zip whose *declared* contents exceed the limits.
 *
 * Header sizes are the archive's own claim and a lying header is possible, but
 * the check still catches every practical bomb: the entries have to declare
 * their sizes for a reader to allocate against them, which is the whole
 * mechanism. Ratio is measured over the archive as a whole rather than per
 * entry, so one highly compressible file among many normal ones is not a
 * false positive.
 */
export function assertZipWithinLimits(entries, limits = archiveLimits()) {
    if (entries.length > limits.maxEntries) {
        throw new ArchiveLimitError(
            `Archive declares ${entries.length} entries, over the ${limits.maxEntries} limit ` +
            '(raise NC_MAX_ARCHIVE_ENTRIES if this is legitimate).'
        );
    }

    let total = 0;
    let compressed = 0;
    for (const entry of entries) {
        total += entry.header?.size ?? 0;
        compressed += entry.header?.compressedSize ?? 0;
    }

    if (total > limits.maxTotalBytes) {
        throw new ArchiveLimitError(
            `Archive declares ${total} uncompressed bytes, over the ${limits.maxTotalBytes} limit ` +
            '(raise NC_MAX_ARCHIVE_BYTES if this is legitimate).'
        );
    }
    // A tiny archive has a meaningless ratio (an empty file compresses to a
    // header), so only weigh it once there is enough data to be a bomb.
    if (compressed > 4096 && total / compressed > limits.maxRatio) {
        throw new ArchiveLimitError(
            `Archive expands ${Math.round(total / compressed)}x, over the ${limits.maxRatio}x limit ` +
            '(raise NC_MAX_ARCHIVE_RATIO if this is legitimate).'
        );
    }

    return { entries: entries.length, totalBytes: total, compressedBytes: compressed };
}

/**
 * Options for the in-memory gzip paths. `maxOutputLength` makes zlib stop and
 * report `ERR_BUFFER_TOO_LARGE` at the ceiling instead of allocating first.
 */
export function gunzipOptions(limits = archiveLimits()) {
    return { maxOutputLength: limits.maxGunzipBytes };
}
