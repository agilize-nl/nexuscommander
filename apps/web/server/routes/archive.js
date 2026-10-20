import express from 'express';
import AdmZip from 'adm-zip';
import path from 'path';
import fs from 'fs/promises';
import zlib from 'zlib';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { resolveSafePath } from '../lib/security.js';
import { splitVirtualPath, archiveKind } from '../lib/archivePaths.js';
import {
    writeFileAtomically,
    withStaging,
    defaultCopyVerification,
    moveEntryStaged,
    keepBothName,
    Replace
} from '../lib/commit.js';
import {
    capabilities as archiveCapabilities,
    formatFromPath,
    formatById,
    canPack,
    packableFormatIds,
    clampLevel
} from '../lib/archiveFormats.js';
import { assertZipWithinLimits, gunzipOptions, readerKind } from '../lib/archiveLimits.js';
import { ZipFile } from 'yazl';

const execFileAsync = promisify(execFile);
const router = express.Router();

/** A 400 the route handlers can throw from anywhere in their body. */
function badRequest(message) {
    const error = new Error(message);
    error.statusCode = 400;
    return error;
}

/**
 * What promotion does when the destination name is already taken (P2.3).
 *
 * The desktop side of this is `archive::ExtractConflict`; the two must agree,
 * because the shells share the frontend that sends the value.
 */
const ExtractConflict = Object.freeze({
    Skip: 'skip',
    Replace: 'replace',
    KeepBoth: 'keep_both'
});

/**
 * How many conflicting paths an unpack report carries by name. The counts are
 * exact, the samples are capped: extracting a huge archive over a populated
 * directory must not hand the browser one array element per entry.
 */
const MAX_REPORTED_CONFLICTS = 100;

/**
 * An unknown policy is refused rather than defaulted. Silently reading a typo as
 * "skip" would be safe; silently reading it as "replace" would not, and a caller
 * cannot tell which one it got.
 */
function parseConflictPolicy(value) {
    if (value === undefined || value === null) return ExtractConflict.Skip;
    const known = Object.values(ExtractConflict);
    if (!known.includes(value)) {
        const error = new Error(`Unknown conflict policy: ${value}. Expected one of ${known.join(', ')}.`);
        error.statusCode = 400;
        throw error;
    }
    return value;
}

function newUnpackReport() {
    return {
        promoted: 0,
        replaced: 0,
        skipped_count: 0,
        kept_both_count: 0,
        skipped_sample: [],
        kept_both_sample: []
    };
}

function recordSkipped(report, rel) {
    report.skipped_count++;
    if (report.skipped_sample.length < MAX_REPORTED_CONFLICTS) report.skipped_sample.push(rel);
}

function recordKeptBoth(report, rel) {
    report.kept_both_count++;
    if (report.kept_both_sample.length < MAX_REPORTED_CONFLICTS) report.kept_both_sample.push(rel);
}

// P2.1: derived from `lib/archiveFormats.js` and a probe of what is installed,
// not hand-written. The list this returns and the formats `/pack` will actually
// produce come from the same table, so they cannot drift apart again.
router.get('/capabilities', async (req, res) => {
    try {
        res.json(await archiveCapabilities());
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

router.get('/check', async (req, res) => {
    try {
        const result = splitVirtualPath(req.query.path);
        if (result) {
            return res.json(true);
        }
        const filePath = resolveSafePath(req.query.path);
        res.json(archiveKind(filePath) !== null);
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

function parseTarListing(output, archivePath) {
    return output.split('\n').filter(Boolean).map(line => {
        const m = line.match(/^(\S+)\s+\S+\s+(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.+)$/);
        if (!m) return null;
        const [, perms, size, date, time] = m;
        let name = m[5];
        const isDir = perms.startsWith('d') || name.endsWith('/');
        name = name.replace(/\/$/, '');
        const base = name.split('/').pop() || name;
        const ts = new Date(`${date}T${time}`).getTime();
        return {
            name: base,
            is_dir: isDir,
            size: parseInt(size, 10),
            modified: ts,
            path: `${archivePath}::${name}`,
            is_symlink: false,
            permissions: "644",
            extension: isDir ? "" : (base.includes('.') ? base.split('.').pop() : ""),
            owner: "0",
            group: "0",
            created: ts,
            accessed: ts,
            changed: ts
        };
    }).filter(Boolean);
}

function parse7zListing(output, archivePath) {
    return output.split('\n').filter(Boolean).map(line => {
        const m = line.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+(\S+)\s+(\d+)\s+(\d+)\s+(.+)$/);
        if (!m) return null;
        const [, date, time, attr, size, , name] = m;
        const isDir = attr.includes('D');
        const base = name.split('/').pop() || name;
        const ts = new Date(`${date}T${time}`).getTime();
        return {
            name: base,
            is_dir: isDir,
            size: parseInt(size, 10),
            modified: ts,
            path: `${archivePath}::${name}`,
            is_symlink: false,
            permissions: "644",
            extension: isDir ? "" : (base.includes('.') ? base.split('.').pop() : ""),
            owner: "0",
            group: "0",
            created: ts,
            accessed: ts,
            changed: ts
        };
    }).filter(Boolean);
}

router.get('/read', async (req, res) => {
    try {
        const result = splitVirtualPath(req.query.path);
        if (!result) {
            return res.status(400).json({ error: `Not an archive path: ${req.query.path}` });
        }
        const { archivePath, innerPath } = result;
        const kind = await readerKind(archiveKind(archivePath), archivePath);

        let allEntries = [];

        if (kind === 'zip') {
            const zip = new AdmZip(archivePath);
            allEntries = zip.getEntries().map(entry => {
                const cleanEntryName = entry.entryName.replace(/\/$/, '');
                const name = cleanEntryName.split('/').pop() || cleanEntryName;
                return {
                    name,
                    is_dir: entry.isDirectory,
                    size: entry.header.size,
                    modified: entry.header.time.getTime(),
                    path: `${archivePath}::${cleanEntryName}`,
                    is_symlink: false,
                    permissions: "644",
                    extension: entry.isDirectory ? "" : path.extname(name).substring(1),
                    owner: "0",
                    group: "0",
                    created: entry.header.time.getTime(),
                    accessed: entry.header.time.getTime(),
                    changed: entry.header.time.getTime()
                };
            });
        } else if (kind === 'tar') {
            const { stdout } = await execFileAsync('tar', ['tvf', archivePath]);
            allEntries = parseTarListing(stdout, archivePath);
        } else if (kind === '7z') {
            const { stdout } = await execFileAsync('7z', ['l', '-ba', archivePath]);
            allEntries = parse7zListing(stdout, archivePath);
        } else if (kind === 'gz') {
            const stat = await fs.stat(archivePath);
            const base = path.basename(archivePath).replace(/\.gz$/, '');
            allEntries = [{
                name: base,
                is_dir: false,
                size: stat.size,
                modified: Math.floor(stat.mtimeMs),
                path: `${archivePath}::${base}`,
                is_symlink: false,
                permissions: "644",
                extension: base.includes('.') ? base.split('.').pop() : "",
                owner: "0",
                group: "0",
                created: Math.floor(stat.mtimeMs),
                accessed: Math.floor(stat.mtimeMs),
                changed: Math.floor(stat.mtimeMs)
            }];
        } else if (kind === 'rar') {
            const { stdout } = await execFileAsync('7z', ['l', '-ba', archivePath]);
            allEntries = parse7zListing(stdout, archivePath);
        } else {
            return res.status(400).json({ error: `Unsupported archive format: ${archivePath}` });
        }

        const filtered = [];
        const seenDirs = new Set();
        
        for (const entry of allEntries) {
            const entryParts = entry.path.split('::');
            const entryInnerPath = entryParts.slice(1).join('::').replace(/^\//, '').replace(/\/$/, '');
            
            if (!entryInnerPath) continue;
            
            if (innerPath) {
                if (entryInnerPath.startsWith(innerPath + '/')) {
                    const relativePath = entryInnerPath.substring(innerPath.length + 1);
                    const relativeParts = relativePath.split('/');
                    const directName = relativeParts[0];
                    
                    if (relativeParts.length === 1) {
                        filtered.push(entry);
                    } else {
                        const dirPath = `${innerPath}/${directName}`;
                        if (!seenDirs.has(dirPath)) {
                            seenDirs.add(dirPath);
                            filtered.push({
                                name: directName,
                                is_dir: true,
                                size: 0,
                                modified: entry.modified,
                                path: `${archivePath}::${dirPath}`,
                                is_symlink: false,
                                permissions: "755",
                                extension: "",
                                owner: "0",
                                group: "0",
                                created: entry.created,
                                accessed: entry.accessed,
                                changed: entry.changed
                            });
                        }
                    }
                }
            } else {
                const relativeParts = entryInnerPath.split('/');
                const directName = relativeParts[0];
                
                if (relativeParts.length === 1) {
                    filtered.push(entry);
                } else {
                    const dirPath = directName;
                    if (!seenDirs.has(dirPath)) {
                        seenDirs.add(dirPath);
                        filtered.push({
                            name: directName,
                            is_dir: true,
                            size: 0,
                            modified: entry.modified,
                            path: `${archivePath}::${dirPath}`,
                            is_symlink: false,
                            permissions: "755",
                            extension: "",
                            owner: "0",
                            group: "0",
                            created: entry.created,
                            accessed: entry.accessed,
                            changed: entry.changed
                        });
                    }
                }
            }
        }
        
        const finalResult = [];
        const finalPaths = new Set();
        for (const item of filtered) {
            const itemPath = item.path;
            if (!finalPaths.has(itemPath)) {
                finalPaths.add(itemPath);
                finalResult.push(item);
            }
        }

        res.json(finalResult);
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

/**
 * Which format to produce, or a 400 explaining why none can be (P2.1 / QSF-005).
 *
 * An explicit `options.format` wins over the destination's extension, matching
 * desktop, whose `archive_pack` packs by format and lets the caller name the file
 * however it likes. The extension is the fallback, not an override: the shared
 * pack dialog keeps the two in sync, and a user who renames `x.tar.gz` to `backup`
 * should still get the tar.gz they selected.
 *
 * What no longer happens either way: an unsupported request quietly becoming a
 * ZIP that carries the extension of a format it is not.
 */
async function resolvePackFormat(destPath, requestedId) {
    if (requestedId !== undefined && requestedId !== null && requestedId !== '') {
        const format = formatById(String(requestedId));
        if (!format) {
            throw badRequest(
                `Unknown archive format: ${requestedId}. This server can create: ${(await packableFormatIds()).join(', ')}.`
            );
        }
        if (!(await canPack(format))) {
            throw badRequest(
                `This server cannot create ${format.id} archives` +
                    (format.writer === null
                        ? '.'
                        : ` — ${format.packRequires.join(' and ')} must be installed.`) +
                    ` It can create: ${(await packableFormatIds()).join(', ')}.`
            );
        }
        return format;
    }

    const format = formatFromPath(destPath);
    if (!format) {
        throw badRequest(
            `Cannot tell which archive format '${path.basename(destPath)}' should be — ` +
                `no known extension. This server can create: ${(await packableFormatIds()).join(', ')}.`
        );
    }
    if (!(await canPack(format))) {
        throw badRequest(
            `This server cannot create ${format.id} archives` +
                (format.writer === null ? '.' : ` — ${format.packRequires.join(' and ')} must be installed.`) +
                ` It can create: ${(await packableFormatIds()).join(', ')}.`
        );
    }
    return format;
}

/**
 * Spawn `program` with an argument array and no shell, capturing stderr for the
 * error message.
 *
 * Argument arrays, never a command string: these are `execFile` semantics with a
 * stream attached, which is the whole reason `--use-compress-program` is not used
 * below — GNU tar hands that value to a shell (verified: a `;` in it executes),
 * so a compression level formatted into it would be a command-injection sink for
 * the sake of one flag.
 */
function spawnChecked(program, args, options = {}) {
    const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
        if (stderr.length < 8192) stderr += chunk;
    });
    const done = new Promise((resolve, reject) => {
        child.once('error', (e) => reject(new Error(`Could not run ${program}: ${e.message}`)));
        child.once('close', (code, signal) => {
            if (code === 0) return resolve();
            const how = signal ? `killed by ${signal}` : `exit ${code}`;
            reject(new Error(`${program} failed (${how}): ${stderr.trim() || 'no output'}`));
        });
    });
    // The child can fail before anything awaits `done` — a missing source makes
    // tar exit while the caller is still draining the pipe. Without this the
    // rejection is an *unhandled* one for those few milliseconds, which Node
    // reports against whatever is running at the time instead of returning it to
    // the request that caused it. Awaiting `done` later still sees the rejection.
    done.catch(() => {});
    return { child, done };
}

/**
 * Create a tar-family archive by streaming `tar`'s output through the compressor
 * and into the staging protocol.
 *
 * The output never touches `destPath` until `commit()` renames it there, so a
 * failed or half-written pack leaves whatever was at that name intact — the same
 * guarantee `/combine` got in P1b.3, and the reason this streams into `staged`
 * rather than letting `tar -f destPath` write the destination directly.
 */
async function packTarFamily(destPath, sources, format, level, followLinks, signal) {
    const destDir = path.dirname(destPath);
    const destName = path.basename(destPath);

    // `--add-file=` instead of a positional name: a source called `-x` would
    // otherwise be read as a flag, and `--` cannot be used because it would also
    // end the `-C` that follows for the next source.
    const tarArgs = ['--create', '--file', '-'];
    if (followLinks) tarArgs.push('--dereference');
    for (const source of sources) {
        tarArgs.push('-C', path.dirname(source), `--add-file=${path.basename(source)}`);
    }

    const tar = spawnChecked('tar', tarArgs);
    let output = tar.child.stdout;
    let compressor = null;

    if (format.compressor) {
        const args = [`-${level}`, '-c'];
        // zstd refuses levels above 19 unless they are asked for explicitly —
        // they cost enough memory that the CLI makes you say so.
        if (format.compressor === 'zstd' && level > 19) args.unshift('--ultra');
        compressor = spawnChecked(format.compressor, args, {
            stdio: ['pipe', 'pipe', 'pipe']
        });
        // An EPIPE here means the compressor died first; its own non-zero exit is
        // the error worth reporting, so this only stops Node from raising an
        // unhandled 'error' event over it.
        tar.child.stdout.on('error', () => {});
        compressor.child.stdin.on('error', () => {});
        tar.child.stdout.pipe(compressor.child.stdin);
        output = compressor.child.stdout;
    }

    // Killing the children ends the pipe early; their non-zero exits then fail
    // the commit below, which rolls the staging file back.
    const onAbort = () => {
        tar.child.kill('SIGKILL');
        compressor?.child.kill('SIGKILL');
    };
    signal.addEventListener('abort', onAbort, { once: true });

    try {
        return await withStaging(
            destDir,
            destName,
            { verification: defaultCopyVerification(), replace: Replace.IfFile },
            async (staged) => {
                // `for await` applies backpressure: the stream stays paused while
                // each write is in flight, so a slow disk cannot make this buffer
                // the whole archive in memory.
                for await (const chunk of output) {
                    await staged.write(chunk);
                }
                // Both exit codes are checked *before* publishing. A tar that died
                // halfway still produces a well-formed compressed stream, so
                // committing on "the pipe ended" would publish a truncated archive
                // as a success.
                await tar.done;
                if (compressor) await compressor.done;
                signal.throwIfAborted();
                return staged.commit();
            }
        );
    } catch (e) {
        tar.child.kill('SIGKILL');
        compressor?.child.kill('SIGKILL');
        throw e;
    } finally {
        signal.removeEventListener('abort', onAbort);
    }
}

/**
 * Packs in flight, so `/cancel-pack` has something to stop. It used to be a
 * stub that answered `success: true` while the archive went on being written —
 * the UI said "cancelled" and the file still appeared.
 */
const activePacks = new Set();

router.post('/pack', async (req, res) => {
    const controller = new AbortController();
    activePacks.add(controller);
    try {
        const destPath = resolveSafePath(req.body.destPath, 'destPath');
        const sources = (req.body.sources || []).map(s => resolveSafePath(s, 'source'));
        if (sources.length === 0) throw badRequest('Nothing to pack: no sources were given.');

        const options = req.body.options || {};
        const format = await resolvePackFormat(destPath, options.format);
        const level = clampLevel(format, options.compression_level);

        await fs.mkdir(path.dirname(destPath), { recursive: true });

        const followLinks = options.follow_links === true;
        if (format.writer === 'yazl') {
            await packZip(destPath, sources, level, followLinks, controller.signal);
        } else {
            await packTarFamily(destPath, sources, format, level, followLinks, controller.signal);
        }

        // The format is reported back: the caller asked for a file name, and this
        // says what was actually written into it.
        res.json({ success: true, format: format.id, compression_level: level });
    } catch (error) {
        if (controller.signal.aborted) {
            return res.status(499).json({ error: 'Packing was cancelled; nothing was written.', cancelled: true });
        }
        res.status(error.statusCode || 500).json({ error: error.message });
    } finally {
        activePacks.delete(controller);
    }
});

/**
 * Write a zip by streaming it through the staging protocol.
 *
 * Symlinks follow the tar writer's convention here: stored as links (the way
 * `zip -y` does) unless `followLinks` asks for what they point at. A followed
 * directory link is visited once per real directory, so a loop terminates.
 */
async function packZip(destPath, sources, level, followLinks, signal) {
    const zip = new ZipFile();
    const visitedDirs = new Set();
    const excludedFiles = new Set();
    const fileIdentity = (stat) => `${stat.dev}:${stat.ino}`;
    const entryOptions = (stat) => ({ mtime: stat.mtime, mode: stat.mode, compressionLevel: level });

    const add = async (abs, rel, selected = false) => {
        signal.throwIfAborted();
        const lstat = await fs.lstat(abs);
        if (excludedFiles.has(fileIdentity(lstat))) {
            if (selected) throw new Error('The output archive cannot also be a selected source');
            return;
        }
        let stat = lstat;
        if (lstat.isSymbolicLink()) {
            if (!followLinks) {
                const target = await fs.readlink(abs);
                zip.addBuffer(Buffer.from(target), rel, { mtime: lstat.mtime, mode: 0o120777, compressionLevel: 0 });
                return;
            }
            stat = await fs.stat(abs);
        }
        if (stat.isDirectory()) {
            const key = `${stat.dev}:${stat.ino}`;
            if (visitedDirs.has(key)) return;
            visitedDirs.add(key);
            zip.addEmptyDirectory(rel, { mtime: stat.mtime, mode: stat.mode });
            for (const child of (await fs.readdir(abs)).sort()) {
                await add(path.join(abs, child), `${rel}/${child}`);
            }
        } else if (stat.isFile()) {
            // The destination may live inside a selected directory. Never
            // archive the output or read the staging file while writing it.
            // Inodes also cover a source reached through a directory symlink.
            if (excludedFiles.has(fileIdentity(stat))) {
                if (selected) throw new Error('The output archive cannot also be a selected source');
                return;
            }
            zip.addFile(abs, rel, entryOptions(stat));
        }
        // Sockets, FIFOs and devices have no content to archive.
    };

    return withStaging(
        path.dirname(destPath),
        path.basename(destPath),
        { verification: defaultCopyVerification(), replace: Replace.IfFile },
        async (staged) => {
            excludedFiles.add(fileIdentity(await fs.stat(staged.stagedPath)));
            try {
                // Commit replaces the directory entry, not a symlink's target.
                // Excluding that target would silently omit a legitimate source.
                excludedFiles.add(fileIdentity(await fs.lstat(destPath)));
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
            // A file that vanishes or cannot be read surfaces as an 'error' on
            // the ZipFile, not on its output; without this the loop below would
            // wait for an end that never comes.
            zip.on('error', (e) => zip.outputStream.destroy(e));
            const onAbort = () => zip.outputStream.destroy(signal.reason);
            signal.addEventListener('abort', onAbort, { once: true });
            try {
                for (const source of sources) await add(source, path.basename(source), true);
                zip.end();
                // `for await` applies backpressure, so yazl only reads ahead as
                // fast as the staging file is written.
                for await (const chunk of zip.outputStream) {
                    await staged.write(chunk);
                }
                signal.throwIfAborted();
                return staged.commit();
            } finally {
                signal.removeEventListener('abort', onAbort);
            }
        }
    );
}

router.post('/unpack', async (req, res) => {
    try {
        const srcPath = resolveSafePath(req.body.srcPath, 'srcPath');
        const destDir = resolveSafePath(req.body.destDir, 'destDir');
        const conflict = parseConflictPolicy(req.body.conflict);
        const kind = await readerKind(archiveKind(srcPath), srcPath);
        await fs.mkdir(destDir, { recursive: true });

        // Staging lives inside the destination so that promoting an entry is a
        // same-filesystem rename, and at 0700 so the extracted tree is not
        // readable by other local users during the window before promotion.
        const stagingDir = path.join(destDir, `.nc_extract_tmp_${process.pid}_${Date.now()}`);
        await fs.mkdir(stagingDir, { recursive: true, mode: 0o700 });

        try {
            if (kind === 'zip') {
                const zip = new AdmZip(srcPath);
                assertZipWithinLimits(zip.getEntries());
                zip.extractAllTo(stagingDir, true);
            } else if (kind === 'tar') {
                await execFileAsync('tar', ['-x', '-f', srcPath, '-C', stagingDir]);
            } else if (kind === '7z') {
                await execFileAsync('7z', ['x', srcPath, `-o${stagingDir}`, '-y']);
            } else if (kind === 'gz') {
                const compressed = await fs.readFile(srcPath);
                const decompressed = zlib.gunzipSync(compressed, gunzipOptions());
                const outName = path.basename(srcPath).replace(/\.gz$/, '');
                await writeFileAtomically(path.join(stagingDir, outName), decompressed, defaultCopyVerification());
            } else {
                await fs.rm(stagingDir, { recursive: true, force: true });
                return res.status(400).json({ error: `Unsupported archive format: ${srcPath}` });
            }

            const report = newUnpackReport();
            await promoteStagedExtraction(stagingDir, destDir, '', conflict, report);
            // Whatever is still in staging is either a skipped entry or the
            // remains of a failed promotion. Neither belongs in the directory the
            // user is looking at.
            await fs.rm(stagingDir, { recursive: true, force: true });
            res.json({ success: true, ...report });
        } catch (err) {
            await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
            throw err;
        }
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

/**
 * Move the extracted tree out of staging into `targetDir` (P2.3 / QSF-004).
 *
 * Every file goes through `moveEntryStaged`, so an existing entry is only ever
 * replaced when `conflict` says so. The version this replaced called
 * `fs.rename(srcPath, dstPath)` unconditionally: extracting an archive that
 * happened to contain `notes.txt` destroyed the user's `notes.txt` with no
 * prompt and no report — and unlike every other mutation in this backend, the
 * colliding name was chosen by the archive rather than by the user.
 *
 * `rel` is the path relative to the extraction root, carried down only so the
 * report can name conflicts the way the user sees them.
 */
async function promoteStagedExtraction(stagingDir, targetDir, rel, conflict, report) {
    const entries = await fs.readdir(stagingDir, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(stagingDir, entry.name);
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;

        // `lstat`, not `stat`: a symlink sitting at the target name is an
        // existing directory entry, not a hole to write through to wherever it
        // points (the zip-slip guard's companion case).
        const existing = await fs.lstat(path.join(targetDir, entry.name)).catch(() => null);

        if (entry.isDirectory()) {
            if (existing && !existing.isDirectory()) {
                // A file or link holds the name the archive wants for a
                // directory. Nothing to merge, nothing safe to replace: the
                // subtree is skipped as one item.
                recordSkipped(report, relPath);
                continue;
            }
            if (!existing) await fs.mkdir(path.join(targetDir, entry.name), { recursive: true });
            await promoteStagedExtraction(srcPath, path.join(targetDir, entry.name), relPath, conflict, report);
            continue;
        }

        if (existing && conflict === ExtractConflict.Skip) {
            recordSkipped(report, relPath);
            continue;
        }

        let finalName = entry.name;
        let replace = Replace.Never;
        if (existing && conflict === ExtractConflict.Replace) {
            replace = Replace.IfFile;
        } else if (existing && conflict === ExtractConflict.KeepBoth) {
            finalName = await keepBothName(targetDir, entry.name);
            recordKeptBoth(report, rel ? `${rel}/${finalName}` : finalName);
        }

        await moveEntryStaged(srcPath, path.join(targetDir, finalName), {
            replace,
            verification: defaultCopyVerification()
        });

        if (!existing) report.promoted++;
        else if (conflict === ExtractConflict.Replace) report.replaced++;
    }
}

router.get('/test', async (req, res) => {
    try {
        const filePath = resolveSafePath(req.query.path);
        const kind = await readerKind(archiveKind(filePath), filePath);

        if (kind === 'zip') {
            const zip = new AdmZip(filePath);
            // Testing an archive decompresses every entry, so it needs the same
            // ceiling as extracting one — it just discards the result.
            assertZipWithinLimits(zip.getEntries());
            zip.getEntries().forEach(e => { if (!e.isDirectory) e.getData(); });
            return res.json(true);
        }
        if (kind === 'tar') {
            await execFileAsync('tar', ['tf', filePath]);
            return res.json(true);
        }
        if (kind === '7z') {
            await execFileAsync('7z', ['t', filePath]);
            return res.json(true);
        }
        if (kind === 'gz') {
            zlib.gunzipSync(await fs.readFile(filePath), gunzipOptions());
            return res.json(true);
        }
        res.json(false);
    } catch {
        res.json(false);
    }
});

router.post('/split', async (req, res) => {
    try {
        const srcPath = resolveSafePath(req.body.path, 'path');
        const destDir = resolveSafePath(req.body.destDir, 'destDir');
        const chunkSize = Number(req.body.chunkSize);
        if (!Number.isFinite(chunkSize) || chunkSize <= 0) {
            return res.status(400).json({ error: 'Invalid chunkSize' });
        }
        await fs.mkdir(destDir, { recursive: true });
        const baseName = path.basename(srcPath);
        const handle = await fs.open(srcPath, 'r');
        try {
            const buffer = Buffer.alloc(chunkSize);
            let partIndex = 1;
            while (true) {
                const { bytesRead } = await handle.read(buffer, 0, chunkSize, null);
                if (bytesRead === 0) break;
                const partName = `${baseName}.${String(partIndex).padStart(3, '0')}`;
                await writeFileAtomically(path.join(destDir, partName), buffer.subarray(0, bytesRead), defaultCopyVerification());
                partIndex++;
            }
        } finally {
            await handle.close();
        }
        res.json({ success: true, message: 'OK' });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

router.post('/combine', async (req, res) => {
    try {
        const destPath = resolveSafePath(req.body.destPath, 'destPath');
        const sources = (req.body.sources || []).map(s => resolveSafePath(s, 'source'));
        const destDir = path.dirname(destPath);
        const destName = path.basename(destPath);
        await fs.mkdir(destDir, { recursive: true });

        // `createWriteStream(destPath)` used to truncate the destination the
        // moment it opened, before a single byte of the first source was
        // even read — the same QSF-001 shape every other mutation in this
        // sweep closes. Streamed through the staging protocol instead: the
        // combined output only becomes visible at destPath by one atomic
        // rename, once every source has been read in full.
        await withStaging(destDir, destName, { verification: defaultCopyVerification() }, async (staged) => {
            for (const src of sources) {
                const handle = await fs.open(src, 'r');
                try {
                    const buf = Buffer.alloc(1024 * 1024);
                    for (;;) {
                        const { bytesRead } = await handle.read(buf, 0, buf.length);
                        if (bytesRead === 0) break;
                        await staged.write(buf.subarray(0, bytesRead));
                    }
                } finally {
                    await handle.close();
                }
            }
            return staged.commit();
        });

        res.json({ success: true, message: 'OK' });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

router.post('/cancel-pack', (req, res) => {
    const cancelled = activePacks.size;
    for (const controller of activePacks) controller.abort(new Error('Packing was cancelled'));
    res.json({ success: cancelled > 0, cancelled });
});

export default router;
