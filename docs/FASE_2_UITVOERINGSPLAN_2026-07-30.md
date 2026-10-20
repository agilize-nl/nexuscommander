# Fase 2 execution plan — rebuild archive handling on the safe foundation

**Date:** 2026-07-30  
**Status:** In Progress.  
**Derived from:** `COMPREHENSIVE_QUALITY_SAFETY_UPGRADE_PLAN_2026-07-28.md`, Section "Phase 2 — Rebuild archive handling on the safe foundation" (P2.1–P2.5), section 6 (target architecture), QSF-004, and QSF-005.  
**Predecessors:** `archive/FASE_0_UITVOERINGSPLAN_2026-07-29.md`, `archive/FASE_1_UITVOERINGSPLAN_2026-07-29.md`, and `archive/FASE_1B_UITVOERINGSPLAN_2026-07-30.md`.

## Context

Fase 0 contained immediate risk, Fase 1 established the safe Rust mutation engine on desktop, and Fase 1b established the safe Express mutation path on web. 

Archive operations (packing, unpacking, listing) are now the primary remaining surface where unsafe or un-transactional writes and format mismatches can occur:
- **Extraction (QSF-004)** currently writes directly into the destination filesystem without a staging protocol, preflight bounds, or transactional promotion.
- **Format capability mismatch (QSF-005)** advertises formats and options that differ between UI, Desktop backend, and Web backend.
- **Cancellation & Job Isolation** need individual cancellation tokens and job-scoped state machines rather than a single shared flag.

This phase rebuilds archive creation, extraction, listing, and format handling on top of the `commit.rs` / `commit.js` staging foundation established in Fases 1 & 1b.

## Deliverables & Tasks

### 1. P2.1 — Archive capability matrix & contract alignment
- Publish a single source of truth for archive format capabilities in `packages/ui/src/lib/ipc-contract.ts` / IPC seam.
- Align Desktop (`archive.rs`) and Web (`archive.js` / `archivePaths.js`) format detection and creation capabilities. *(Updated 2026-07-30: Added full read/list and unpack support for `.tar.zst`, `.zst`, `.tzst`, `.tar.bz2`, `.tbz2`, `.tar.xz`, and `.txz` across both Desktop and Web backends. Fixed error propagation in `read_tar_entries`. Fixed `handleUnpack`, F5 Copy, and Drag & Drop when invoked from inside archives to extract the underlying archive file to the destination panel, with fallback copy for cross-device links and automatic Permission Denied / SUDO elevation).*
- Reject unsupported extensions/options explicitly instead of silently falling back to ZIP.
- Remove inert UI options like `solid_archive` or map them to concrete format options.

*(Updated 2026-07-31 — the web pack path.* The format work above was read-side.
Write-side, web was still the QSF-005 case in full: `/api/archive/capabilities`
returned a hand-written list claiming `canPack: true` for `tar.gz`, `tar.zst` and
`7z`, `POST /api/archive/pack` ignored the destination extension *and*
`options.format` entirely and always built a ZIP with AdmZip, and the web adapter
dropped the dialog's `packOptions` before they ever left the browser. Packing
`backup.tar.gz` produced a ZIP carrying that name. Now:

- `server/lib/archiveFormats.js` is the single table both endpoints read. It
  carries each format's extensions, writer, required external programs and level
  range, and `capabilities()` derives the advertised list from it by probing PATH
  — so `tar.zst` is only advertised as packable on a host that actually has
  `zstd`. The probe resolves executables on PATH rather than running
  `prog --version`: `bzip2 --version` exits non-zero, so the obvious probe would
  report an installed binary as missing.
- `/pack` dispatches on that table. ZIP stays on AdmZip; the tar family streams
  `tar --create --file -` through `gzip`/`bzip2`/`xz`/`zstd` at the requested
  level and into `withStaging`, so the output only appears at `destPath` on one
  atomic rename after both exit codes are checked. A tar that dies halfway still
  emits a well-formed compressed stream, so committing on "the pipe ended" would
  publish a truncated archive as a success.
- An extension or format the host cannot produce is now a 400 naming what it can
  do, never a substituted container. `7z` reports `canPack: false`, matching
  desktop, which has no 7z writer either.
- **`--use-compress-program` is deliberately not used.** It is the obvious way to
  pass a compression level to `tar`, and GNU tar 1.35 hands that value to a
  shell — verified directly: `--use-compress-program='gzip -6; touch pwned'`
  creates `pwned`. Formatting a level into it would put a command-injection sink
  in the pack path for the sake of one flag. Hence the separate compressor
  process with an argument array.
- Web's zip entry advertises `min = max = default = 6`, because AdmZip exposes no
  level knob and builds at zlib's default. A 0–9 range there would be a slider
  that changes nothing.
- The shared pack dialog now filters its format dropdown through
  `getArchiveCapabilities()` (`canPack` only), falling back to the full list while
  the call is in flight or absent, and moves the selection off a format the
  backend cannot write. That is the "or is hidden from the UI" half of the exit
  criterion.

Still open in P2.1: `solid_archive` remains declared in `lib.rs`,
`ipc-contract.ts` and `Dialog.svelte` and inert in all five desktop writers.
Desktop honours `compression_level` for zip; web cannot, and says so.)*

### 2. P2.2 — Job-scoped archive creation with atomic output
- Give every archive packing job a dedicated `JobId` with independent cancellation token and progress tracking.
- Ensure output creation stages output to a temporary file (`.part` / staging) in the destination directory and atomical-commits upon completion via `commit.rs` / `commit.js`.
- Handle empty inputs and progress/time calculations accurately.

### 3. P2.3 — Private no-follow extraction staging & transactional promotion
- Extract archives into a private temporary staging directory inside the target parent directory.
- Perform preflight validation: path traversal checks, entry count, total uncompressed size, free disk space check, duplicate/case collisions, and symlink policy checks.
- Promote staged entries atomically to their final target using `commit.rs` / `commit.js`.
- Ensure cancellation or error mid-extraction cleans up staging and leaves existing files intact.

*(Updated 2026-07-31 — promotion.* Staging existed on both backends, but **promotion
out of staging did not go through the commit engine on either**: desktop's
`promote_extracted_dir` called `fs::rename` with a `fs::copy` fallback and web's
`promoteStagedExtraction` called `fs.rename`, both unconditionally. An archive
containing `notes.txt` therefore destroyed the user's `notes.txt` with no prompt,
no report and no way back — QSF-001's shape in the one code path where the
colliding name is chosen by the *archive* rather than by the user. Now:

- Promotion runs through `engine::commit::move_entry_staged` / `moveEntryStaged`
  under an explicit `ExtractConflict` policy — `skip` (the default), `replace`,
  `keep_both`. Absent policy means `skip` on both backends; web 400s on an
  unknown value rather than defaulting it.
- The destination is probed with `symlink_metadata`/`lstat`, so a link at the
  target name counts as an existing entry instead of a hole to write through.
- A file occupying the name the archive wants for a directory skips that subtree
  as one item rather than failing the extraction.
- `unpack_archive` returns an `UnpackReport` (`promoted`/`replaced`/
  `skipped_count`/`kept_both_count` plus samples capped at 100) instead of `()`,
  so "extracted 400 entries" and "extracted nothing, every name was taken" are no
  longer the same value. Both shells phrase their toast from the report; the UI no
  longer reports "successful" for an extraction that produced nothing.
- Staging directories are created at `0700` on both backends, so the extracted
  tree is not readable by other local users during the window before promotion.

Still open in P2.3: the free-disk-space preflight, duplicate/case-collision
detection, and a UI that *offers* `replace`/`keep_both` when the report comes back
with skips (today the user is told, and has to re-run to choose differently).)*

### 4. P2.4 — Metadata/symlink preservation & streaming/bounded listing
- Preserve unix permissions, executable bits, timestamps, and symlinks per explicit `MetadataPolicy`.
- Implement bounded limits and pagination/streaming for large archive listings to prevent webview memory exhaustion.

### 5. P2.5 — Hostile fixture matrix & regression tests
- Create a test fixture corpus covering directory traversal attempts (`../`), absolute path entries, zip bomb ratio limits, symlink redirection targets, and invalid header structures.
- Add automated tests to ensure extraction cannot escape the destination directory or overwrite existing files without explicit conflict resolution.

*(Updated 2026-07-31.* Escape is covered on desktop
(`archive::extraction_safety_tests`): zip slip, tar slip, absolute paths in both,
tar symlink escape, benign nested entries, and corrupt-archive error propagation.
The overwrite half now has six desktop tests and seven web tests
(`apps/web/server/tests/archive.test.js`) covering: default skip leaves the
existing file byte-identical, `replace` publishes over it, `keep_both` publishes
beside it, a symlink at the destination is not written through, a file blocking a
directory name skips the subtree, counts are exact while samples stay capped, and
web refuses an unknown policy with 400. Per the "verify a check can fail" rule
both sets were run against a deliberately broken guard (`Skip` wired to
`Replace::IfFile`, and the web promotion put back to a bare `fs.rename`): 3 desktop
and 2 web tests went red, then the guard was restored.

P2.1's write side adds six more web tests: every format the capability list calls
packable is packed and then verified with `tar tf` and a `PK` magic-number check,
an unproducible extension and an unproducible format are both refused without
writing anything, an explicit format beats the extension, `capabilities()` and
`/pack` agree format-by-format, and a failed `tar` leaves a previous archive at
that name intact. Also run against the restored always-ZIP writer: the two format
tests went red.

Still open in P2.5: the zip-bomb ratio and entry-count caps have no test, because
`MIN_SIZE_FOR_RATIO_CHECK` is 100 MiB and `MAX_ARCHIVE_ENTRIES` is 200 000 —
production-sized thresholds that a cheap fixture cannot reach. Extracting the
bound checks into pure predicates and unit-testing those with fabricated numbers
is the way in. Invalid header structures are covered only for tar.zst.)*

## Exit Criteria
- `check-no-fs-bypass.js` allowlist entry for `archive.rs` / `routes/archive.js` updated so extraction uses safe staging and commit engine primitives. **Done (2026-07-31)** — both entries now enumerate what is left (staging-internal writes and staging cleanup) rather than covering the whole unfinished feature.
- Every advertised archive format can be safely listed, packed, and unpacked, or is hidden from the UI. **Done (2026-07-31)** — web's list is now derived from its writers plus a PATH probe, `/pack` refuses anything it cannot produce, and the shared dialog offers only packable formats. See P2.1.
- Extraction into populated directories is fully transactional and cancellable without partial corruption of existing files. **Done (2026-07-31)** on both backends; see P2.3.

## Remaining work, in the order it should be picked up

1. **P2.2 — job-scoped packing.** `ArchiveState(Arc<AtomicBool>)` is still one
   process-wide cancel flag: `archive_cancel_pack` takes no job id, so cancelling
   one pack cancels every pack in flight. This is also what keeps
   `archive::pack_archive` out of the integration suite (it needs an `AppHandle`).
   Web has no pack cancellation at all — the new `packTarFamily` streams through
   `withStaging`, so a cancel token would abort cleanly, but nothing can send one.
2. **P2.4 — metadata and bounded listing.** Extraction applies unix mode bits
   (masking setuid/setgid/sticky) but no timestamps, and there is no
   `MetadataPolicy` on the extraction path. `read_archive` still returns every
   entry in one array with no pagination.
3. **P2.1 — `solid_archive`.** Still declared in `lib.rs`, `ipc-contract.ts` and
   `Dialog.svelte`, still inert in all five desktop writers.
4. The three P2.3/P2.5 gaps named in their sections above.
5. **Web pack has no progress reporting.** Desktop emits `PackProgress` events and
   drives `PackProgressDialog`; web's `/pack` is a single blocking request. The
   streaming writer now knows its byte count as it goes, so the data exists.
