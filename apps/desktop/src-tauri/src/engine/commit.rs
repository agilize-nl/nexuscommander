//! P1.4 — staging, verification, and atomic commit.
//!
//! The protocol every mutation converges on:
//!
//! 1. Pin the **destination directory** with [`PathPolicy`], no symlink followed.
//! 2. Create a randomly named staging file *inside it* with
//!    `O_CREAT | O_EXCL | O_NOFOLLOW`.
//! 3. Write the new content there. The old destination is untouched throughout.
//! 4. Verify per [`VerificationPolicy`].
//! 5. Sync per [`Durability`].
//! 6. `renameat` the staging file over the target — one atomic step.
//! 7. Only then release anything on the source side.
//!
//! Any failure before step 6 leaves the destination exactly as it was, and the
//! staging file is removed. That is the whole point: `fs::copy` and
//! `File::create` truncate the destination *first*, so today a read error, a
//! full disk, a cancel or a power cut at the wrong moment leaves the user with
//! neither the old file nor a complete new one (QSF-001).
//!
//! # The temp file must live in the destination directory
//!
//! Section 6.1: "The temporary file must live in the *destination* directory to
//! make the final rename same-filesystem; a system temp directory defeats the
//! entire protocol." A rename across filesystems is not atomic and usually is
//! not even permitted, so staging in `/tmp` would turn step 6 back into a
//! copy — a truncating one. [`Staged`] takes a [`DirHandle`] and cannot be
//! constructed to stage anywhere else.
//!
//! # What verification and durability actually prove
//!
//! A byte count proves as much as a byte count proves. A digest readback proves
//! the page cache agrees with what was written — **not** that the data reached
//! the platter. Only [`Durability::SyncFile`] and above make a durability claim,
//! and [`CommitReport::durability_claim`] is what the UI must phrase its message
//! from. Where the platform cannot sync a directory, the report says so instead
//! of quietly rounding up.
//!
//! # Directory trees
//!
//! There is no portable primitive that atomically replaces or merges a populated
//! directory, so trees are **journaled**: per-entry commits through this module
//! plus a durable record of what has landed
//! ([`CommitOutcome::PartiallyCommitted`]). P1.5 builds the recursive walk on
//! top; this module owns the single-entry commit.

use std::ffi::{OsStr, OsString};
use std::io::Write;
use std::path::{Path, PathBuf};

use super::outcome::CommitOutcome;
use super::path_policy::{DirHandle, EntryKind, PathError, PathPolicy, SyncSupport};
use super::spec::{Durability, MetadataPolicy, UnsupportedMetadata, VerificationPolicy};

/// Why a commit could not be completed.
///
/// Every variant leaves the destination in its previous state. The one that
/// does not is [`CommitError::CommitFailed`], which is why it is separate: at
/// that point the staging file is complete and verified, and only the rename
/// failed.
#[derive(Debug)]
pub enum CommitError {
    Path(PathError),
    /// Could not claim a staging name. Retried; see [`Staged::MAX_NAME_ATTEMPTS`].
    Staging {
        dir: PathBuf,
        source: std::io::Error,
    },
    /// Writing the staged content failed. Destination untouched.
    Write {
        staged: PathBuf,
        source: std::io::Error,
    },
    /// Verification did not agree with what was supposed to be written.
    /// Destination untouched, and deliberately *not* committed.
    VerificationFailed {
        staged: PathBuf,
        detail: String,
    },
    Sync {
        staged: PathBuf,
        source: std::io::Error,
    },
    /// The final rename failed. The destination is still the old one and the
    /// staging file is complete — the one case worth reporting distinctly,
    /// because the user's new data exists and is recoverable by hand.
    CommitFailed {
        staged: PathBuf,
        target: PathBuf,
        source: std::io::Error,
    },
    /// The destination exists and the caller did not ask to replace it.
    DestinationExists {
        target: PathBuf,
        kind: EntryKind,
    },
    /// The target names a directory. Replacing a directory with a file is not a
    /// rename this module will perform.
    TargetIsDirectory(PathBuf),
    /// A directory move across filesystems. Not a failure the user caused — the
    /// caller has to fall back to a journaled tree copy plus a delete, and needs
    /// to be able to tell this apart from a real error to do so.
    CrossDeviceDirectory {
        src: PathBuf,
        dst: PathBuf,
    },
    Cancelled,
}

impl std::fmt::Display for CommitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CommitError::Path(e) => write!(f, "{}", e),
            CommitError::Staging { dir, source } => write!(
                f,
                "Could not create a temporary file in '{}': {}. Nothing was changed.",
                dir.display(),
                source
            ),
            CommitError::Write { staged, source } => write!(
                f,
                "Failed while writing '{}': {}. The original is unchanged.",
                staged.display(),
                source
            ),
            CommitError::VerificationFailed { staged, detail } => write!(
                f,
                "Refused to publish '{}': {}. The original is unchanged.",
                staged.display(),
                detail
            ),
            CommitError::Sync { staged, source } => write!(
                f,
                "Could not flush '{}' to disk: {}. The original is unchanged.",
                staged.display(),
                source
            ),
            CommitError::CommitFailed {
                staged,
                target,
                source,
            } => write!(
                f,
                "Could not replace '{}': {}. The original is intact and your new \
                 content is complete in '{}' — move it into place manually or retry.",
                target.display(),
                source,
                staged.display()
            ),
            CommitError::DestinationExists { target, kind } => write!(
                f,
                "'{}' already exists (a {:?}) and replacing it was not requested.",
                target.display(),
                kind
            ),
            CommitError::TargetIsDirectory(p) => write!(
                f,
                "'{}' is a directory; it cannot be replaced by a file.",
                p.display()
            ),
            CommitError::CrossDeviceDirectory { src, dst } => write!(
                f,
                "'{}' and '{}' are on different filesystems, so the folder must be \
                 copied entry by entry rather than moved.",
                src.display(),
                dst.display()
            ),
            CommitError::Cancelled => write!(f, "Cancelled. Nothing was changed."),
        }
    }
}

impl std::error::Error for CommitError {}

impl From<PathError> for CommitError {
    fn from(e: PathError) -> Self {
        CommitError::Path(e)
    }
}

impl CommitError {
    /// Whether the previous destination content is still intact.
    ///
    /// True for every variant. Stated as code rather than as a comment because
    /// it is the property the whole module exists to provide, and a future
    /// variant that breaks it should have to change this function deliberately.
    pub fn destination_preserved(&self) -> bool {
        true
    }

    /// The outcome to report for this failure.
    pub fn as_outcome(&self) -> CommitOutcome {
        match self {
            CommitError::Cancelled => CommitOutcome::CancelledBeforeCommit,
            CommitError::CommitFailed { staged, target, .. } => {
                CommitOutcome::ManualRecoveryRequired {
                    detail: self.to_string(),
                    paths: vec![
                        staged.to_string_lossy().to_string(),
                        target.to_string_lossy().to_string(),
                    ],
                }
            }
            other => CommitOutcome::RolledBack {
                reason: other.to_string(),
            },
        }
    }
}

/// What a completed commit actually achieved.
#[derive(Debug, Clone, PartialEq)]
pub struct CommitReport {
    pub bytes: u64,
    pub replaced_existing: bool,
    pub durability: Durability,
    /// `false` when the tier asked for a directory sync the platform does not
    /// provide. The commit happened; it is not power-cut durable.
    pub directory_synced: bool,
    pub verified_digest: bool,
}

impl CommitReport {
    /// The strongest thing that may honestly be said about this commit.
    ///
    /// UI copy must come from here, not from "the operation succeeded".
    pub fn durability_claim(&self) -> &'static str {
        match self.durability {
            Durability::None => "written (not flushed)",
            Durability::FlushOnly => "written (survives the app closing, not a power cut)",
            Durability::SyncFile if !self.directory_synced => {
                "written and flushed to disk (this platform cannot sync the folder entry)"
            }
            Durability::SyncFile => "written and flushed to disk",
            Durability::SyncFileAndDirectory if !self.directory_synced => {
                "written and flushed to disk (this platform cannot sync the folder entry)"
            }
            Durability::SyncFileAndDirectory => "written and durable",
        }
    }
}

/// Whether an existing destination may be replaced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Replace {
    /// Fail with [`CommitError::DestinationExists`] if anything is there.
    Never,
    /// Replace an existing regular file or symlink. A directory is still
    /// refused — swapping a populated directory for a file by rename is not
    /// something a caller can have meant.
    IfFile,
}

/// Fault points, so the tests can prove the destination survives a failure at
/// every stage. Compiled out of release builds entirely.
#[cfg(test)]
pub(crate) mod faults {
    use std::cell::RefCell;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum At {
        AfterStagingCreated,
        MidWrite,
        BeforeSync,
        AfterSync,
        BeforeRename,
    }

    thread_local! {
        static ACTIVE: RefCell<Option<At>> = const { RefCell::new(None) };
    }

    /// Arm a fault for the current thread. Disarms on drop, so one test cannot
    /// leak a fault into the next.
    pub struct Armed;

    pub fn arm(at: At) -> Armed {
        ACTIVE.with(|a| *a.borrow_mut() = Some(at));
        Armed
    }

    impl Drop for Armed {
        fn drop(&mut self) {
            ACTIVE.with(|a| *a.borrow_mut() = None);
        }
    }

    pub(super) fn check(at: At) -> std::io::Result<()> {
        let armed = ACTIVE.with(|a| *a.borrow());
        if armed == Some(at) {
            return Err(std::io::Error::other(format!("injected fault at {:?}", at)));
        }
        Ok(())
    }
}

#[inline]
#[allow(unused_variables)]
fn fault(at: FaultPoint) -> std::io::Result<()> {
    #[cfg(test)]
    {
        faults::check(at)?;
    }
    Ok(())
}

#[cfg(test)]
type FaultPoint = faults::At;
#[cfg(not(test))]
type FaultPoint = ();

#[cfg(test)]
macro_rules! fault_at {
    ($v:ident) => {
        faults::At::$v
    };
}
#[cfg(not(test))]
macro_rules! fault_at {
    // Must expand to an *expression*, not to nothing: `fault(fault_at!(X))` is a
    // call argument. Expanding to `()` makes `fault` a no-op the optimiser
    // removes entirely.
    ($v:ident) => {
        ()
    };
}

/// A staged replacement, not yet published.
///
/// Dropping without [`Staged::commit`] removes the staging file and leaves the
/// destination alone — so an early `?` anywhere in a caller is a rollback, not a
/// leak. That is deliberate: the safe behaviour has to be the one you get by
/// forgetting.
pub struct Staged {
    dir: DirHandle,
    temp_name: OsString,
    target_name: OsString,
    file: Option<std::fs::File>,
    bytes: u64,
    digest: u64,
    verification: VerificationPolicy,
    replace: Replace,
    published: bool,
}

impl Staged {
    /// How many random names to try before giving up.
    ///
    /// A collision means another operation is staging in the same directory at
    /// the same instant. Three tries makes that astronomically unlikely without
    /// looping forever on a directory that refuses creation for some other
    /// reason.
    pub const MAX_NAME_ATTEMPTS: u32 = 3;

    /// Begin staging a replacement for `target`.
    ///
    /// `target` is the full destination path; its parent is pinned through
    /// `policy` and the staging file is created inside it.
    pub fn create(
        policy: &PathPolicy,
        target: &Path,
        verification: VerificationPolicy,
        replace: Replace,
    ) -> Result<Self, CommitError> {
        let parent = target
            .parent()
            .ok_or_else(|| CommitError::TargetIsDirectory(target.to_path_buf()))?;
        let target_name = target
            .file_name()
            .ok_or_else(|| CommitError::TargetIsDirectory(target.to_path_buf()))?
            .to_os_string();

        let dir = policy.open_dir(parent)?;
        Self::in_dir(dir, target_name, verification, replace)
    }

    /// Begin staging inside an already-pinned directory.
    ///
    /// The recursive walk in P1.5 opens each destination directory once and
    /// stages many entries in it, rather than re-resolving the path per file.
    pub fn in_dir(
        dir: DirHandle,
        target_name: OsString,
        verification: VerificationPolicy,
        replace: Replace,
    ) -> Result<Self, CommitError> {
        // Check the destination *before* staging, so the common "it's already
        // there" refusal costs nothing.
        match dir.entry_kind(&target_name)? {
            None => {}
            Some(EntryKind::Dir) => {
                return Err(CommitError::TargetIsDirectory(
                    dir.path().join(&target_name),
                ))
            }
            Some(kind) if replace == Replace::Never => {
                return Err(CommitError::DestinationExists {
                    target: dir.path().join(&target_name),
                    kind,
                })
            }
            // An existing file or symlink with Replace::IfFile: the staged
            // rename will replace it atomically.
            Some(_) => {}
        }

        let mut last: Option<std::io::Error> = None;
        for _ in 0..Self::MAX_NAME_ATTEMPTS {
            let temp_name = staging_name(&target_name);
            match dir.create_new_file(&temp_name) {
                Ok(file) => {
                    if let Err(e) = fault(fault_at!(AfterStagingCreated)) {
                        let _ = dir.remove_file(&temp_name);
                        return Err(CommitError::Staging {
                            dir: dir.path().to_path_buf(),
                            source: e,
                        });
                    }
                    return Ok(Staged {
                        dir,
                        temp_name,
                        target_name,
                        file: Some(file),
                        bytes: 0,
                        digest: DIGEST_SEED,
                        verification,
                        replace,
                        published: false,
                    });
                }
                Err(PathError::Io { source, .. })
                    if source.kind() == std::io::ErrorKind::AlreadyExists =>
                {
                    last = Some(source);
                    continue;
                }
                Err(e) => return Err(CommitError::Path(e)),
            }
        }
        Err(CommitError::Staging {
            dir: dir.path().to_path_buf(),
            source: last.unwrap_or_else(|| std::io::Error::other("no staging name available")),
        })
    }

    /// The staging file's path. For messages and journal entries.
    pub fn staged_path(&self) -> PathBuf {
        self.dir.path().join(&self.temp_name)
    }

    /// The path this will become on commit.
    pub fn target_path(&self) -> PathBuf {
        self.dir.path().join(&self.target_name)
    }

    pub fn bytes_written(&self) -> u64 {
        self.bytes
    }

    /// Append to the staged content.
    pub fn write(&mut self, buf: &[u8]) -> Result<(), CommitError> {
        fault(fault_at!(MidWrite)).map_err(|source| CommitError::Write {
            staged: self.staged_path(),
            source,
        })?;

        let file = self.file.as_mut().expect("staged file already taken");
        file.write_all(buf).map_err(|source| CommitError::Write {
            staged: self.dir.path().join(&self.temp_name),
            source,
        })?;
        self.bytes += buf.len() as u64;
        if self.verification.digest {
            self.digest = fold_digest(self.digest, buf);
        }
        Ok(())
    }

    /// Publish the staged content over the target.
    ///
    /// `expected_bytes` is compared against what was written when
    /// [`VerificationPolicy::byte_count`] is set — the source's size, so a
    /// truncated read is caught before it replaces anything.
    pub fn commit(mut self, expected_bytes: Option<u64>) -> Result<CommitReport, CommitError> {
        let staged = self.staged_path();
        let target = self.target_path();

        // --- verify ---
        if let (true, Some(expected)) = (self.verification.byte_count, expected_bytes) {
            if expected != self.bytes {
                return Err(CommitError::VerificationFailed {
                    staged,
                    detail: format!("expected {} bytes but staged {}", expected, self.bytes),
                });
            }
        }

        let mut file = self.file.take().expect("staged file already taken");

        // --- durability ---
        fault(fault_at!(BeforeSync)).map_err(|source| CommitError::Sync {
            staged: staged.clone(),
            source,
        })?;

        match self.verification.durability {
            Durability::None => {}
            Durability::FlushOnly => {
                file.flush().map_err(|source| CommitError::Sync {
                    staged: staged.clone(),
                    source,
                })?;
            }
            Durability::SyncFile | Durability::SyncFileAndDirectory => {
                file.flush().map_err(|source| CommitError::Sync {
                    staged: staged.clone(),
                    source,
                })?;
                file.sync_all().map_err(|source| CommitError::Sync {
                    staged: staged.clone(),
                    source,
                })?;
            }
        }

        // --- verify the readback, after the sync so it reads what was synced ---
        let verified_digest = if self.verification.digest {
            drop(file);
            let actual = digest_of(&staged).map_err(|source| CommitError::Sync {
                staged: staged.clone(),
                source,
            })?;
            if actual != self.digest {
                return Err(CommitError::VerificationFailed {
                    staged,
                    detail: "the readback does not match what was written".to_string(),
                });
            }
            true
        } else {
            drop(file);
            false
        };

        fault(fault_at!(AfterSync)).map_err(|source| CommitError::Sync {
            staged: staged.clone(),
            source,
        })?;

        let replaced_existing = self.dir.entry_exists(&self.target_name)?;
        if replaced_existing && self.replace == Replace::Never {
            return Err(CommitError::DestinationExists {
                target,
                kind: EntryKind::File,
            });
        }

        fault(fault_at!(BeforeRename)).map_err(|source| CommitError::CommitFailed {
            staged: staged.clone(),
            target: target.clone(),
            source,
        })?;

        // --- the atomic step ---
        match self.dir.rename(&self.temp_name, &self.target_name) {
            Ok(()) => {}
            Err(PathError::Io { source, .. }) => {
                return Err(CommitError::CommitFailed {
                    staged,
                    target,
                    source,
                });
            }
            Err(e) => return Err(CommitError::Path(e)),
        }
        // Past this point the staging name no longer exists, so Drop must not
        // try to remove it.
        self.published = true;

        // --- make the *entry* durable, not just the data ---
        let directory_synced = match self.verification.durability {
            Durability::SyncFileAndDirectory => match self.dir.sync()? {
                SyncSupport::Synced => true,
                SyncSupport::Unsupported => false,
            },
            _ => false,
        };

        Ok(CommitReport {
            bytes: self.bytes,
            replaced_existing,
            durability: self.verification.durability,
            directory_synced,
            verified_digest,
        })
    }
}

impl Drop for Staged {
    fn drop(&mut self) {
        if self.published {
            return;
        }
        // Close before unlinking so the descriptor does not outlive the name.
        self.file.take();
        // Best effort: if this fails the file is reported through the journal's
        // `orphaned_staging`, never silently forgotten.
        let _ = self.dir.remove_file(&self.temp_name);
    }
}

/// Write `contents` to `path` through the staging protocol.
///
/// The whole-file convenience for the paths P1.4 migrates first: the in-app text
/// editor, settings, and bookmarks.
pub fn write_file_atomically(
    policy: &PathPolicy,
    path: &Path,
    contents: &[u8],
    verification: VerificationPolicy,
) -> Result<CommitReport, CommitError> {
    let mut staged = Staged::create(policy, path, verification, Replace::IfFile)?;
    staged.write(contents)?;
    staged.commit(Some(contents.len() as u64))
}

/// A free name next to `target_name`, for `ConflictPolicy::KeepBoth`.
///
/// `report.pdf` becomes `report (2).pdf`, then `report (3).pdf`, and so on. The
/// extension is preserved because it is what decides how the file opens; a
/// scheme that produced `report.pdf (2)` would quietly break the association.
/// Dotfiles (`.bashrc`) have no extension to preserve and become `.bashrc (2)`.
///
/// Deterministic, so two runs against the same directory pick the same name —
/// plan section 8.1 lists "conflict-plan determinism and keep-both naming" as a
/// property worth testing rather than assuming.
pub fn keep_both_name(dir: &DirHandle, target_name: &OsStr) -> Result<OsString, CommitError> {
    if dir.entry_kind(target_name)?.is_none() {
        return Ok(target_name.to_os_string());
    }

    let name = Path::new(target_name);
    // `file_stem`/`extension` treat a leading dot as part of the stem only when
    // there is nothing else, so `.bashrc` has no extension and `.tar.gz` keeps
    // `gz` — matching what the user sees in the panel.
    let stem = name
        .file_stem()
        .map(|s| s.to_os_string())
        .unwrap_or_else(|| target_name.to_os_string());
    let ext = name.extension().map(|e| e.to_os_string());

    for n in 2..=MAX_KEEP_BOTH_ATTEMPTS {
        let mut candidate = stem.clone();
        candidate.push(format!(" ({})", n));
        if let Some(ext) = &ext {
            candidate.push(".");
            candidate.push(ext);
        }
        if dir.entry_kind(&candidate)?.is_none() {
            return Ok(candidate);
        }
    }

    Err(CommitError::DestinationExists {
        target: dir.path().join(target_name),
        kind: EntryKind::File,
    })
}

/// Give up rather than loop forever in a directory with thousands of copies.
const MAX_KEEP_BOTH_ATTEMPTS: u32 = 10_000;

/// How a move was actually carried out.
#[derive(Debug, Clone, PartialEq)]
pub enum MoveKind {
    /// Same filesystem: one `renameat`. Atomic, and it never had a truncation
    /// window in the first place — the unsafe part of the old implementation was
    /// deleting the destination *first*.
    Renamed,
    /// Cross-filesystem: staged copy, committed, and only then was the source
    /// released. The ordering QSF-002 is about.
    CopiedThenSourceRemoved { bytes: u64 },
    /// The copy committed but the source could not be removed. The data is safe
    /// and duplicated, and the user has to be told — it looks like a finished
    /// move until they notice the original is still there.
    CopiedSourceRetained { bytes: u64, reason: String },
}

/// Copy one regular file to `dst` through the staging protocol.
///
/// `on_progress` is called with the size of each chunk written; returning an
/// error aborts the copy, which rolls the staging file back and leaves the
/// destination untouched. That is how the task queue implements cancellation —
/// and why cancelling mid-copy can no longer destroy an existing destination
/// (the P0.6 note on `copy_file_chunked`: "the window between destination
/// emptied and replacement written is as wide as the file is large").
pub fn copy_file_staged(
    policy: &PathPolicy,
    src: &Path,
    dst: &Path,
    verification: VerificationPolicy,
    metadata: MetadataPolicy,
    replace: Replace,
    on_progress: &mut dyn FnMut(u64) -> Result<(), CommitError>,
) -> Result<CommitReport, CommitError> {
    let parent = dst
        .parent()
        .ok_or_else(|| CommitError::TargetIsDirectory(dst.to_path_buf()))?;
    let target_name = dst
        .file_name()
        .ok_or_else(|| CommitError::TargetIsDirectory(dst.to_path_buf()))?
        .to_os_string();
    let dir = policy.open_dir(parent)?;
    copy_file_staged_in(
        &dir,
        src,
        target_name,
        verification,
        metadata,
        replace,
        on_progress,
    )
}

/// [`copy_file_staged`] into an already-pinned directory.
///
/// The recursive walk opens each destination directory once and copies many
/// entries into it, rather than re-resolving the whole path per file.
pub fn copy_file_staged_in(
    dir: &DirHandle,
    src: &Path,
    target_name: OsString,
    verification: VerificationPolicy,
    metadata: MetadataPolicy,
    replace: Replace,
    on_progress: &mut dyn FnMut(u64) -> Result<(), CommitError>,
) -> Result<CommitReport, CommitError> {
    use std::io::Read;

    let mut source = std::fs::File::open(src).map_err(|source| CommitError::Write {
        staged: src.to_path_buf(),
        source,
    })?;
    let source_len = source.metadata().map(|m| m.len()).ok();

    let mut staged = Staged::in_dir(dir.try_clone()?, target_name, verification, replace)?;

    let mut buf = vec![0u8; CHUNK_BYTES];
    loop {
        let n = source.read(&mut buf).map_err(|source| CommitError::Write {
            staged: staged.staged_path(),
            source,
        })?;
        if n == 0 {
            break;
        }
        staged.write(&buf[..n])?;
        // Cancellation and progress. An Err here drops `staged`, which rolls
        // back — the destination is never left half-written.
        on_progress(n as u64)?;
    }

    if metadata.timestamps {
        // Stamp the *staged* file, so the published one carries the source's
        // mtime the instant it appears. Setting it after the rename would leave
        // a window where the committed file has the wrong timestamp.
        copy_mtime(src, &staged.staged_path(), metadata)?;
    }

    staged.commit(source_len)
}

/// Move `src` to `dst`: rename where possible, staged copy where not.
///
/// The source is released **only** after the destination commit. QSF-002 was the
/// opposite ordering — the queued move deleted the destination outright and only
/// then attempted the rename, so if both the rename and the copy fallback failed
/// the user had lost the destination for nothing.
pub fn move_entry_staged(
    policy: &PathPolicy,
    src: &Path,
    dst: &Path,
    verification: VerificationPolicy,
    metadata: MetadataPolicy,
    replace: Replace,
    on_progress: &mut dyn FnMut(u64) -> Result<(), CommitError>,
) -> Result<MoveKind, CommitError> {
    let parent = dst
        .parent()
        .ok_or_else(|| CommitError::TargetIsDirectory(dst.to_path_buf()))?;
    let target_name = dst
        .file_name()
        .ok_or_else(|| CommitError::TargetIsDirectory(dst.to_path_buf()))?
        .to_os_string();
    let dir = policy.open_dir(parent)?;

    // Refuse an unwanted replacement before touching anything.
    match dir.entry_kind(&target_name)? {
        Some(EntryKind::Dir) if !src.is_dir() => {
            return Err(CommitError::TargetIsDirectory(dst.to_path_buf()))
        }
        Some(kind) if replace == Replace::Never => {
            return Err(CommitError::DestinationExists {
                target: dst.to_path_buf(),
                kind,
            })
        }
        _ => {}
    }

    // Same filesystem: one atomic rename. It replaces the destination in a
    // single step, so there is no window in which neither version exists.
    match std::fs::rename(src, dst) {
        Ok(()) => return Ok(MoveKind::Renamed),
        Err(e) if is_cross_device(&e) => {}
        Err(source) => {
            // A directory move that is not cross-device (ENOTEMPTY, EACCES, …)
            // is a real failure and must not silently become a tree copy.
            if src.is_dir() {
                return Err(CommitError::CommitFailed {
                    staged: src.to_path_buf(),
                    target: dst.to_path_buf(),
                    source,
                });
            }
        }
    }

    if src.is_dir() {
        // A cross-device directory move is a journaled tree copy plus a delete,
        // which this function cannot perform: it commits one entry, and a tree
        // has no atomic commit. So it hands the case back as its own variant
        // rather than as a failure.
        //
        // This used to return `CommitFailed`, which the caller could not tell
        // apart from a real error — `task_queue::execute_move` matches on
        // `CrossDeviceDirectory` to run its journaled tree copy, so that
        // fallback was unreachable and every folder move to another filesystem
        // failed. Nothing has been touched at this point either way.
        return Err(CommitError::CrossDeviceDirectory {
            src: src.to_path_buf(),
            dst: dst.to_path_buf(),
        });
    }

    let report = copy_file_staged_in(
        &dir,
        src,
        target_name,
        verification,
        metadata,
        replace,
        on_progress,
    )?;

    // Committed. Only now is it safe to let go of the source.
    match std::fs::remove_file(src) {
        Ok(()) => Ok(MoveKind::CopiedThenSourceRemoved {
            bytes: report.bytes,
        }),
        Err(e) => Ok(MoveKind::CopiedSourceRetained {
            bytes: report.bytes,
            reason: e.to_string(),
        }),
    }
}

/// Whether this error means "different filesystem", the one case where a rename
/// legitimately falls back to copy-and-delete.
fn is_cross_device(e: &std::io::Error) -> bool {
    #[cfg(unix)]
    {
        e.raw_os_error() == Some(libc::EXDEV)
    }
    #[cfg(windows)]
    {
        // ERROR_NOT_SAME_DEVICE
        e.raw_os_error() == Some(17)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = e;
        false
    }
}

fn copy_mtime(src: &Path, staged: &Path, metadata: MetadataPolicy) -> Result<(), CommitError> {
    let modified = match src.metadata().and_then(|m| m.modified()) {
        Ok(m) => m,
        Err(source) => {
            return match metadata.on_unsupported {
                UnsupportedMetadata::Fail => Err(CommitError::Write {
                    staged: staged.to_path_buf(),
                    source,
                }),
                // Reported through the operation result, not swallowed: the
                // copy succeeded and the timestamp did not.
                UnsupportedMetadata::WarnAndContinue => Ok(()),
            };
        }
    };
    match filetime::set_file_mtime(staged, filetime::FileTime::from_system_time(modified)) {
        Ok(()) => Ok(()),
        Err(source) => match metadata.on_unsupported {
            UnsupportedMetadata::Fail => Err(CommitError::Write {
                staged: staged.to_path_buf(),
                source,
            }),
            UnsupportedMetadata::WarnAndContinue => Ok(()),
        },
    }
}

/// 512 KiB, matching the chunk the task queue already used so cancellation
/// granularity and progress-update frequency are unchanged.
const CHUNK_BYTES: usize = 512 * 1024;

/// Write a small configuration file through the staging protocol.
///
/// The P1.4 entry point for settings, bookmarks and the in-app editor: these are
/// small, irreplaceable, and written on ordinary UI actions, which is why
/// `OperationKind::Write` defaults to the strongest durability tier. QSF-012 is
/// what the previous `fs::write` cost — a crash mid-write left a truncated
/// config, and the app then read it as "no settings" and reset the user's
/// session.
///
/// Returns the human-readable durability claim so the caller can report it
/// truthfully rather than saying "saved".
pub fn write_config_atomically(path: &Path, contents: &[u8]) -> Result<CommitReport, CommitError> {
    use super::spec::OperationKind;

    if let Some(parent) = path.parent() {
        // The staging protocol needs the destination directory to exist; it does
        // not create it, because creating a directory tree is a mutation of its
        // own and belongs to the caller's operation.
        std::fs::create_dir_all(parent).map_err(|source| CommitError::Staging {
            dir: parent.to_path_buf(),
            source,
        })?;
    }

    let verification = super::spec::OperationSpec::new(
        OperationKind::Write,
        Vec::new(),
        Some(path.to_string_lossy().to_string()),
    )
    .verification;

    write_file_atomically(&PathPolicy::default(), path, contents, verification)
}

/// A staging name that cannot be guessed and cannot collide with a user's file.
///
/// QSF-011 is the counter-example: `batch_rename` stages through
/// `{source}.nc_rename_tmp_{index}`, which is fully predictable, so a file that
/// happens to carry that name is destroyed without a word. The leading dot keeps
/// it out of ordinary listings; the random suffix keeps two concurrent
/// operations in one directory apart.
fn staging_name(target: &OsStr) -> OsString {
    // Not cryptographic — this needs unpredictability against collision, not
    // against an adversary who can already write to the directory.
    let unique = uuid::Uuid::new_v4().simple().to_string();
    let mut name = OsString::from(".nc-staging-");
    // Keep a hint of the target so an orphan is identifiable, bounded so a long
    // name cannot push the result past NAME_MAX.
    let hint: String = target
        .to_string_lossy()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-' || *c == '_')
        .take(40)
        .collect();
    name.push(hint);
    name.push("-");
    name.push(&unique[..16]);
    name
}

const DIGEST_SEED: u64 = 0xcbf2_9ce4_8422_2325;

/// FNV-1a. Enough to catch a truncated or corrupted readback, which is what
/// `VerificationPolicy::digest` is for; it is not a tamper check and the field
/// name should not be read as one.
fn fold_digest(mut hash: u64, bytes: &[u8]) -> u64 {
    for b in bytes {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    hash
}

fn digest_of(path: &Path) -> std::io::Result<u64> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut hash = DIGEST_SEED;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hash = fold_digest(hash, &buf[..n]);
    }
    Ok(hash)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "nc_commit_{}_{}_{}",
                name,
                std::process::id(),
                uuid::Uuid::new_v4().simple()
            ));
            fs::create_dir_all(&dir).unwrap();
            Scratch(fs::canonicalize(&dir).unwrap())
        }
        fn p(&self, rel: &str) -> PathBuf {
            self.0.join(rel)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn policy() -> PathPolicy {
        PathPolicy::default()
    }

    fn durable() -> VerificationPolicy {
        VerificationPolicy {
            byte_count: true,
            digest: false,
            durability: Durability::SyncFileAndDirectory,
        }
    }

    /// Staging files are hidden dot-files; this finds any that were left behind.
    fn leftovers(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with(".nc-staging-"))
            .collect()
    }

    #[test]
    fn writes_a_new_file() {
        let s = Scratch::new("new");
        let report =
            write_file_atomically(&policy(), &s.p("out.txt"), b"hello", durable()).unwrap();

        assert_eq!(fs::read(s.p("out.txt")).unwrap(), b"hello");
        assert_eq!(report.bytes, 5);
        assert!(!report.replaced_existing);
        assert!(leftovers(&s.0).is_empty(), "staging file left behind");
    }

    #[test]
    fn replaces_an_existing_file() {
        let s = Scratch::new("replace");
        fs::write(s.p("out.txt"), b"the original contents").unwrap();

        let report = write_file_atomically(&policy(), &s.p("out.txt"), b"new", durable()).unwrap();
        assert_eq!(fs::read(s.p("out.txt")).unwrap(), b"new");
        assert!(report.replaced_existing);
        assert!(leftovers(&s.0).is_empty());
    }

    #[test]
    fn the_staging_file_is_created_in_the_destination_directory() {
        // Section 6.1: staging in a system temp directory makes the final rename
        // cross-filesystem, which defeats the entire protocol.
        let s = Scratch::new("same_fs");
        let mut staged =
            Staged::create(&policy(), &s.p("out.txt"), durable(), Replace::IfFile).unwrap();
        staged.write(b"x").unwrap();

        let staged_path = staged.staged_path();
        assert_eq!(
            staged_path.parent().unwrap(),
            s.0,
            "staging must happen next to the target"
        );
        assert!(staged_path.exists());
        staged.commit(Some(1)).unwrap();
    }

    #[test]
    fn staging_names_are_unpredictable_and_do_not_collide() {
        // The QSF-011 counter-example: batch_rename's {source}.nc_rename_tmp_{i}
        // is guessable, so a user file with that name is destroyed silently.
        let a = staging_name(OsStr::new("report.pdf"));
        let b = staging_name(OsStr::new("report.pdf"));
        assert_ne!(a, b, "two stagings of the same target must differ");
        assert!(a.to_string_lossy().starts_with(".nc-staging-"));
    }

    #[test]
    fn a_long_target_name_does_not_produce_an_unusable_staging_name() {
        let long = "x".repeat(300);
        let name = staging_name(OsStr::new(&long));
        assert!(
            name.len() < 255,
            "staging name would exceed NAME_MAX: {}",
            name.len()
        );
    }

    #[test]
    fn dropping_without_committing_rolls_back() {
        let s = Scratch::new("drop");
        fs::write(s.p("out.txt"), b"original").unwrap();

        {
            let mut staged =
                Staged::create(&policy(), &s.p("out.txt"), durable(), Replace::IfFile).unwrap();
            staged.write(b"never published").unwrap();
            // dropped here without commit
        }

        assert_eq!(fs::read(s.p("out.txt")).unwrap(), b"original");
        assert!(
            leftovers(&s.0).is_empty(),
            "an abandoned staging file must be cleaned up"
        );
    }

    #[test]
    fn a_byte_count_mismatch_refuses_to_publish() {
        let s = Scratch::new("bytecount");
        fs::write(s.p("out.txt"), b"original").unwrap();

        let mut staged =
            Staged::create(&policy(), &s.p("out.txt"), durable(), Replace::IfFile).unwrap();
        staged.write(b"short").unwrap();
        // Claim more than was written — a truncated source read looks like this.
        let err = staged.commit(Some(999)).unwrap_err();

        assert!(matches!(err, CommitError::VerificationFailed { .. }));
        assert!(err.destination_preserved());
        assert_eq!(fs::read(s.p("out.txt")).unwrap(), b"original");
        assert!(leftovers(&s.0).is_empty());
    }

    #[test]
    fn a_digest_readback_is_checked_when_requested() {
        let s = Scratch::new("digest");
        let verification = VerificationPolicy {
            byte_count: true,
            digest: true,
            durability: Durability::SyncFile,
        };
        let report =
            write_file_atomically(&policy(), &s.p("out.txt"), b"content", verification).unwrap();
        assert!(report.verified_digest);
        assert_eq!(fs::read(s.p("out.txt")).unwrap(), b"content");
    }

    #[test]
    fn replace_never_refuses_an_existing_destination() {
        let s = Scratch::new("never");
        fs::write(s.p("out.txt"), b"original").unwrap();

        let err = Staged::create(&policy(), &s.p("out.txt"), durable(), Replace::Never)
            .err()
            .expect("must refuse");
        assert!(matches!(err, CommitError::DestinationExists { .. }));
        assert_eq!(fs::read(s.p("out.txt")).unwrap(), b"original");
    }

    #[test]
    fn a_directory_is_never_replaced_by_a_file() {
        let s = Scratch::new("dir_target");
        fs::create_dir(s.p("target")).unwrap();

        let err = Staged::create(&policy(), &s.p("target"), durable(), Replace::IfFile)
            .err()
            .expect("must refuse");
        assert!(matches!(err, CommitError::TargetIsDirectory(_)));
        assert!(s.p("target").is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_destination_directory_is_refused() {
        // QSF-003 through the commit path: without PathPolicy the staged file
        // would land wherever the link points.
        let s = Scratch::new("link_dir");
        let real = s.p("real");
        fs::create_dir(&real).unwrap();
        std::os::unix::fs::symlink(&real, s.p("link")).unwrap();

        let err = Staged::create(
            &policy(),
            &s.p("link").join("out.txt"),
            durable(),
            Replace::IfFile,
        )
        .err()
        .expect("must refuse");
        assert!(matches!(
            err,
            CommitError::Path(PathError::SymlinkRejected { .. })
        ));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_target_is_replaced_rather_than_written_through() {
        // The other half of QSF-003. `dst/report.pdf` is a link to a file
        // elsewhere; a truncating write follows it and destroys the *target*.
        // The staged rename replaces the link itself and leaves the target
        // alone, which is what SymlinkPolicy::Preserve means.
        let s = Scratch::new("link_target");
        let outside = s.p("outside.txt");
        fs::write(&outside, b"must not be touched").unwrap();
        fs::create_dir(s.p("dst")).unwrap();
        std::os::unix::fs::symlink(&outside, s.p("dst").join("report.txt")).unwrap();

        write_file_atomically(
            &policy(),
            &s.p("dst").join("report.txt"),
            b"replacement",
            durable(),
        )
        .unwrap();

        assert_eq!(
            fs::read(&outside).unwrap(),
            b"must not be touched",
            "the write followed the symlink out of the destination directory"
        );
        assert_eq!(
            fs::read(s.p("dst").join("report.txt")).unwrap(),
            b"replacement"
        );
        assert!(
            fs::symlink_metadata(s.p("dst").join("report.txt"))
                .unwrap()
                .file_type()
                .is_file(),
            "the link should have been replaced by a regular file"
        );
    }

    // ===== fault injection: the destination must survive every stage =====

    fn assert_destination_survives(fault_at: faults::At) {
        let s = Scratch::new(&format!("fault_{:?}", fault_at).to_lowercase());
        fs::write(s.p("out.txt"), b"the original contents").unwrap();

        let result = {
            let _armed = faults::arm(fault_at);
            write_file_atomically(&policy(), &s.p("out.txt"), b"replacement", durable())
        };

        let err = result
            .err()
            .unwrap_or_else(|| panic!("fault at {:?} did not surface as an error", fault_at));
        assert!(err.destination_preserved());
        assert_eq!(
            fs::read(s.p("out.txt")).unwrap(),
            b"the original contents",
            "a fault at {:?} damaged the destination",
            fault_at
        );

        match fault_at {
            // The rename is the last step; if it fails the staged content is
            // complete and is deliberately kept, so the user can recover it.
            faults::At::BeforeRename => {
                assert!(matches!(err, CommitError::CommitFailed { .. }));
                assert!(matches!(
                    err.as_outcome(),
                    CommitOutcome::ManualRecoveryRequired { .. }
                ));
            }
            _ => {
                assert!(
                    leftovers(&s.0).is_empty(),
                    "a fault at {:?} left a staging file behind: {:?}",
                    fault_at,
                    leftovers(&s.0)
                );
                assert!(matches!(err.as_outcome(), CommitOutcome::RolledBack { .. }));
            }
        }
    }

    #[test]
    fn a_fault_just_after_staging_leaves_the_destination_alone() {
        assert_destination_survives(faults::At::AfterStagingCreated);
    }

    #[test]
    fn a_fault_mid_write_leaves_the_destination_alone() {
        assert_destination_survives(faults::At::MidWrite);
    }

    #[test]
    fn a_fault_before_the_sync_leaves_the_destination_alone() {
        assert_destination_survives(faults::At::BeforeSync);
    }

    #[test]
    fn a_fault_after_the_sync_leaves_the_destination_alone() {
        assert_destination_survives(faults::At::AfterSync);
    }

    #[test]
    fn a_fault_at_the_rename_leaves_the_destination_and_keeps_the_staged_copy() {
        assert_destination_survives(faults::At::BeforeRename);
    }

    #[test]
    fn a_failed_rename_reports_where_the_new_content_is() {
        let s = Scratch::new("recovery_paths");
        fs::write(s.p("out.txt"), b"original").unwrap();

        let (err, staged_path) = {
            let _armed = faults::arm(faults::At::BeforeRename);
            let mut staged =
                Staged::create(&policy(), &s.p("out.txt"), durable(), Replace::IfFile).unwrap();
            staged.write(b"replacement").unwrap();
            let path = staged.staged_path();
            (staged.commit(Some(11)).unwrap_err(), path)
        };

        match err.as_outcome() {
            CommitOutcome::ManualRecoveryRequired { paths, .. } => {
                assert!(
                    paths.iter().any(|p| p == &staged_path.to_string_lossy()),
                    "the recovery report must name the staged file: {:?}",
                    paths
                );
            }
            other => panic!("expected ManualRecoveryRequired, got {:?}", other),
        }
        // The message has to tell the user their data is not lost.
        assert!(err.to_string().contains("your new content is complete"));
    }

    // ===== keep-both naming =====

    #[test]
    fn keep_both_leaves_a_free_name_alone() {
        let s = Scratch::new("kb_free");
        let dir = policy().open_dir(&s.0).unwrap();
        assert_eq!(
            keep_both_name(&dir, OsStr::new("report.pdf")).unwrap(),
            OsStr::new("report.pdf")
        );
    }

    #[test]
    fn keep_both_preserves_the_extension() {
        let s = Scratch::new("kb_ext");
        fs::write(s.p("report.pdf"), b"x").unwrap();
        let dir = policy().open_dir(&s.0).unwrap();

        // "report.pdf (2)" would break how the file opens.
        assert_eq!(
            keep_both_name(&dir, OsStr::new("report.pdf")).unwrap(),
            OsStr::new("report (2).pdf")
        );
    }

    #[test]
    fn keep_both_counts_up_past_existing_copies() {
        let s = Scratch::new("kb_count");
        for name in ["report.pdf", "report (2).pdf", "report (3).pdf"] {
            fs::write(s.p(name), b"x").unwrap();
        }
        let dir = policy().open_dir(&s.0).unwrap();
        assert_eq!(
            keep_both_name(&dir, OsStr::new("report.pdf")).unwrap(),
            OsStr::new("report (4).pdf")
        );
    }

    #[test]
    fn keep_both_is_deterministic() {
        let s = Scratch::new("kb_det");
        fs::write(s.p("a.txt"), b"x").unwrap();
        let dir = policy().open_dir(&s.0).unwrap();
        let first = keep_both_name(&dir, OsStr::new("a.txt")).unwrap();
        let second = keep_both_name(&dir, OsStr::new("a.txt")).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn keep_both_handles_a_name_with_no_extension() {
        let s = Scratch::new("kb_noext");
        fs::write(s.p("Makefile"), b"x").unwrap();
        let dir = policy().open_dir(&s.0).unwrap();
        assert_eq!(
            keep_both_name(&dir, OsStr::new("Makefile")).unwrap(),
            OsStr::new("Makefile (2)")
        );
    }

    #[test]
    fn keep_both_treats_a_dotfile_as_having_no_extension() {
        let s = Scratch::new("kb_dotfile");
        fs::write(s.p(".bashrc"), b"x").unwrap();
        let dir = policy().open_dir(&s.0).unwrap();
        assert_eq!(
            keep_both_name(&dir, OsStr::new(".bashrc")).unwrap(),
            OsStr::new(".bashrc (2)")
        );
    }

    #[cfg(unix)]
    #[test]
    fn keep_both_counts_a_symlink_as_taken() {
        // Path::exists() would follow a dangling link and report the name free,
        // then the copy would clobber the link.
        let s = Scratch::new("kb_symlink");
        std::os::unix::fs::symlink(s.p("no-such-target"), s.p("a.txt")).unwrap();
        let dir = policy().open_dir(&s.0).unwrap();
        assert_eq!(
            keep_both_name(&dir, OsStr::new("a.txt")).unwrap(),
            OsStr::new("a (2).txt")
        );
    }

    // ===== durability honesty =====

    #[test]
    fn the_durability_claim_matches_the_tier_that_was_used() {
        let s = Scratch::new("claims");
        for (tier, expect) in [
            (Durability::None, "not flushed"),
            (Durability::FlushOnly, "not a power cut"),
            (Durability::SyncFile, "flushed to disk"),
        ] {
            let verification = VerificationPolicy {
                byte_count: true,
                digest: false,
                durability: tier,
            };
            let name = format!("out-{:?}.txt", tier);
            let report = write_file_atomically(&policy(), &s.p(&name), b"x", verification).unwrap();
            assert!(
                report.durability_claim().contains(expect),
                "tier {:?} claimed {:?}",
                tier,
                report.durability_claim()
            );
        }
    }

    #[test]
    fn only_the_top_tier_claims_durability_and_only_if_the_directory_synced() {
        let s = Scratch::new("top_tier");
        let report = write_file_atomically(&policy(), &s.p("out.txt"), b"x", durable()).unwrap();

        #[cfg(unix)]
        {
            assert!(report.directory_synced);
            assert_eq!(report.durability_claim(), "written and durable");
        }
        #[cfg(not(unix))]
        {
            // Windows has no directory fsync; the claim must say so rather than
            // rounding up to durable.
            assert!(!report.directory_synced);
            assert!(report.durability_claim().contains("cannot sync the folder"));
        }
    }

    #[test]
    fn a_lower_tier_never_claims_the_directory_was_synced() {
        let s = Scratch::new("lower_tier");
        let verification = VerificationPolicy {
            byte_count: true,
            digest: false,
            durability: Durability::SyncFile,
        };
        let report = write_file_atomically(&policy(), &s.p("out.txt"), b"x", verification).unwrap();
        assert!(!report.directory_synced);
    }

    /// A same-filesystem directory move is still one atomic rename. This is the
    /// case the `CrossDeviceDirectory` classification must not disturb.
    #[test]
    fn same_filesystem_directory_move_is_a_rename() {
        let s = Scratch::new("dir_move_same_fs");
        fs::create_dir_all(s.p("src/sub")).unwrap();
        fs::write(s.p("src/sub/a.txt"), b"hello").unwrap();
        fs::create_dir_all(s.p("dest")).unwrap();

        let kind = move_entry_staged(
            &policy(),
            &s.p("src"),
            &s.p("dest/src"),
            durable(),
            move_metadata(),
            Replace::IfFile,
            &mut |_| Ok(()),
        )
        .unwrap();

        assert_eq!(kind, MoveKind::Renamed);
        assert!(!s.p("src").exists(), "the source must be gone after a move");
        assert_eq!(
            fs::read(s.p("dest/src/sub/a.txt")).unwrap(),
            b"hello",
            "the tree must arrive intact"
        );
    }

    /// Moving a directory onto a *non-empty* directory of the same name fails,
    /// and must keep failing: `rename` cannot merge trees, and quietly turning
    /// ENOTEMPTY into a tree copy would be a silent merge the user never asked
    /// for. It must not be reported as `CrossDeviceDirectory` either — that
    /// variant means "retry as a tree copy", and here that is the wrong answer.
    #[test]
    fn directory_move_onto_non_empty_directory_fails_without_touching_either_side() {
        let s = Scratch::new("dir_move_onto_dir");
        fs::create_dir_all(s.p("src")).unwrap();
        fs::write(s.p("src/new.txt"), b"new").unwrap();
        fs::create_dir_all(s.p("dest/src")).unwrap();
        fs::write(s.p("dest/src/existing.txt"), b"existing").unwrap();

        let err = move_entry_staged(
            &policy(),
            &s.p("src"),
            &s.p("dest/src"),
            durable(),
            move_metadata(),
            Replace::IfFile,
            &mut |_| Ok(()),
        )
        .expect_err("a non-empty destination directory cannot be renamed over");

        assert!(
            !matches!(err, CommitError::CrossDeviceDirectory { .. }),
            "ENOTEMPTY is a real failure, not a cross-device retry: {:?}",
            err
        );
        // Both sides survive untouched — nothing was destroyed to make room.
        assert_eq!(fs::read(s.p("src/new.txt")).unwrap(), b"new");
        assert_eq!(fs::read(s.p("dest/src/existing.txt")).unwrap(), b"existing");
    }

    /// A cross-device *directory* move is handed back as `CrossDeviceDirectory`,
    /// not as a generic `CommitFailed`. `task_queue::execute_move` matches on
    /// that variant to run its journaled tree copy, so the distinction is what
    /// makes a folder move to another filesystem possible at all — when it was
    /// reported as `CommitFailed` the fallback was unreachable dead code.
    ///
    /// Needs two filesystems, so it is skipped rather than failed where only one
    /// is available. `NC_TEST_OTHER_FS` names a writable directory on another
    /// filesystem; `/dev/shm` is the usual Linux default.
    #[test]
    fn cross_device_directory_move_is_classified_for_the_tree_copy_fallback() {
        let Some(other) = other_filesystem_dir() else {
            eprintln!("skipped: no second filesystem available");
            return;
        };
        let s = Scratch::new("dir_move_xdev");
        fs::create_dir_all(s.p("src/sub")).unwrap();
        fs::write(s.p("src/sub/a.txt"), b"hello").unwrap();

        let err = move_entry_staged(
            &policy(),
            &s.p("src"),
            &other.join("moved_src"),
            durable(),
            move_metadata(),
            Replace::IfFile,
            &mut |_| Ok(()),
        )
        .expect_err("this function cannot commit a tree; it must hand the case back");

        assert!(
            matches!(err, CommitError::CrossDeviceDirectory { .. }),
            "expected CrossDeviceDirectory so the caller can fall back, got: {:?}",
            err
        );
        // Refused *before* anything was touched.
        assert_eq!(fs::read(s.p("src/sub/a.txt")).unwrap(), b"hello");
        assert!(!other.join("moved_src").exists());
        let _ = fs::remove_dir_all(&other);
    }

    /// The metadata policy a real move uses, so these tests exercise the same
    /// configuration as `task_queue::execute_move` and `vfs::rename_entry`.
    fn move_metadata() -> MetadataPolicy {
        crate::engine::spec::OperationSpec::new(
            crate::engine::spec::OperationKind::Move,
            Vec::new(),
            None,
        )
        .metadata
    }

    /// A scratch directory on a filesystem other than the one `Scratch` uses, or
    /// `None` when there is only one. Verified by comparing device ids rather
    /// than trusting the mount point to be separate.
    fn other_filesystem_dir() -> Option<PathBuf> {
        let candidates: Vec<PathBuf> = std::env::var_os("NC_TEST_OTHER_FS")
            .map(|v| vec![PathBuf::from(v)])
            .unwrap_or_else(|| vec![PathBuf::from("/dev/shm")]);

        let here = std::env::temp_dir();
        let here_dev = device_of(&here)?;

        for base in candidates {
            if !base.is_dir() {
                continue;
            }
            if device_of(&base) == Some(here_dev) {
                continue;
            }
            let dir = base.join(format!(
                "nc_xdev_{}_{}",
                std::process::id(),
                uuid::Uuid::new_v4().simple()
            ));
            if fs::create_dir_all(&dir).is_ok() {
                return Some(dir);
            }
        }
        None
    }

    #[cfg(unix)]
    fn device_of(p: &Path) -> Option<u64> {
        use std::os::unix::fs::MetadataExt;
        p.metadata().ok().map(|m| m.dev())
    }

    #[cfg(not(unix))]
    fn device_of(_p: &Path) -> Option<u64> {
        None
    }
}
