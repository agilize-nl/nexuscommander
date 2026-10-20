use crate::engine::outcome::{CommitOutcome, Journal, JournalFailure};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

/// Copy the source modification time to the destination.
///
/// `std::fs::copy` and streamed copies create a fresh destination timestamp,
/// so every copy path must call this after all destination writes are done.
pub(crate) fn preserve_modified_time(src: &Path, dst: &Path) -> std::io::Result<()> {
    let modified = src.metadata()?.modified()?;
    filetime::set_file_mtime(dst, filetime::FileTime::from_system_time(modified))
}

/// Represents a single file or directory entry in the VFS.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub modified: u64,
    pub extension: String,
    pub permissions: String,
    pub owner: String,
    pub group: String,
}

/// Result of a file operation.
///
/// P1.6: `outcome` carries the structured result. `success`/`message` stay as the
/// fallback for paths not yet migrated, and stay first in the struct because
/// every existing caller reads them. When `outcome` is present it is
/// authoritative — `success: false` with `RolledBack` says something quite
/// different to a user than the same flag with `ManualRecoveryRequired`, and
/// before this they were the same value with different prose (QSF-017).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpResult {
    pub success: bool,
    pub message: String,
    /// Omitted from the wire entirely when absent, so unmigrated paths send the
    /// same JSON they always did.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub outcome: Option<crate::engine::outcome::CommitOutcome>,
}

impl OpResult {
    pub fn ok(msg: &str) -> Self {
        OpResult {
            success: true,
            message: msg.to_string(),
            outcome: None,
        }
    }
    pub fn err(msg: &str) -> Self {
        OpResult {
            success: false,
            message: msg.to_string(),
            outcome: None,
        }
    }

    /// Attach the structured outcome.
    ///
    /// `success` is derived from the outcome rather than passed in, so the flag
    /// and the outcome cannot disagree — a `PartiallyCommitted` result reporting
    /// `success: true` is exactly the "implying success" the plan forbids.
    pub fn with_outcome(msg: &str, outcome: crate::engine::outcome::CommitOutcome) -> Self {
        OpResult {
            success: outcome.is_fully_committed()
                || matches!(
                    outcome,
                    crate::engine::outcome::CommitOutcome::Skipped { .. }
                ),
            message: msg.to_string(),
            outcome: Some(outcome),
        }
    }
}

/// Result of comparing two directories.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComparisonResult {
    pub only_in_left: Vec<String>,
    pub only_in_right: Vec<String>,
    pub different: Vec<String>,
    pub identical: Vec<String>,
}

/// Reads a directory and returns a sorted list of FileEntry items.
/// Directories are listed first, then files, both sorted alphabetically.
pub fn read_directory(path: &str) -> Result<Vec<FileEntry>, String> {
    let dir_path = Path::new(path);

    if !dir_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    if !dir_path.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    let entries = fs::read_dir(dir_path).map_err(|e| format!("Failed to read directory: {}", e))?;

    let mut file_entries: Vec<FileEntry> = Vec::new();
    #[cfg(unix)]
    let mut owner_cache: HashMap<u32, String> = HashMap::new();
    #[cfg(unix)]
    let mut group_cache: HashMap<u32, String> = HashMap::new();

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        // Use symlink_metadata to avoid following links and detect broken ones
        let metadata = match entry.path().symlink_metadata() {
            Ok(m) => m,
            Err(_) => continue, // Metadata failed entirely
        };

        let name = entry.file_name().to_string_lossy().to_string();
        let is_symlink = metadata.file_type().is_symlink();

        // If it's a symlink, we might want to know if target is a dir
        let is_dir = if is_symlink {
            // Try to follow to see if target is dir
            fs::metadata(entry.path())
                .map(|m| m.is_dir())
                .unwrap_or(false)
        } else {
            metadata.is_dir()
        };

        let size = if is_dir { 0 } else { metadata.len() };

        let modified = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let extension = if is_dir {
            String::new()
        } else {
            let name_os = entry.file_name();
            let name_str = name_os.to_string_lossy();
            if let Some(last_dot_idx) = name_str.rfind('.') {
                if last_dot_idx > 0 {
                    name_str[last_dot_idx + 1..].to_string()
                } else {
                    String::new()
                }
            } else {
                String::new()
            }
        };

        #[cfg(unix)]
        let permissions = {
            use std::os::unix::fs::PermissionsExt;
            let mode = metadata.permissions().mode();
            let mut s = String::with_capacity(10);

            s.push(if is_dir {
                'd'
            } else if is_symlink {
                'l'
            } else {
                '-'
            });
            s.push(if mode & 0o400 != 0 { 'r' } else { '-' });
            s.push(if mode & 0o200 != 0 { 'w' } else { '-' });
            s.push(if mode & 0o100 != 0 { 'x' } else { '-' });
            s.push(if mode & 0o040 != 0 { 'r' } else { '-' });
            s.push(if mode & 0o020 != 0 { 'w' } else { '-' });
            s.push(if mode & 0o010 != 0 { 'x' } else { '-' });
            s.push(if mode & 0o004 != 0 { 'r' } else { '-' });
            s.push(if mode & 0o002 != 0 { 'w' } else { '-' });
            s.push(if mode & 0o001 != 0 { 'x' } else { '-' });
            s
        };

        #[cfg(not(unix))]
        let permissions = {
            if metadata.permissions().readonly() {
                String::from("r--")
            } else {
                String::from("rw-")
            }
        };

        #[cfg(unix)]
        let (owner, group) = {
            use std::os::unix::fs::MetadataExt;
            let uid = metadata.uid();
            let gid = metadata.gid();
            let owner = owner_cache
                .entry(uid)
                .or_insert_with(|| {
                    uzers::get_user_by_uid(uid)
                        .map(|user| user.name().to_string_lossy().to_string())
                        .unwrap_or_else(|| String::from("user"))
                })
                .clone();
            let group = group_cache
                .entry(gid)
                .or_insert_with(|| {
                    uzers::get_group_by_gid(gid)
                        .map(|group| group.name().to_string_lossy().to_string())
                        .unwrap_or_else(|| String::from("group"))
                })
                .clone();
            (owner, group)
        };

        #[cfg(not(unix))]
        let (owner, group) = (String::from("user"), String::from("group"));

        file_entries.push(FileEntry {
            name,
            is_dir,
            is_symlink,
            size,
            modified,
            extension,
            permissions,
            owner,
            group,
        });
    }

    // Sort: directories first (alphabetically), then files (alphabetically)
    file_entries.sort_by(|a, b| {
        if a.is_dir == b.is_dir {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        } else if a.is_dir {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        }
    });

    Ok(file_entries)
}

// ===== CRUD Operations =====

/// Create a new directory at the given path.
pub fn create_directory(path: &str) -> OpResult {
    match fs::create_dir_all(path) {
        Ok(_) => OpResult::ok(&format!("Directory created: {}", path)),
        Err(e) => OpResult::err(&format!("Failed to create directory: {}", e)),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum DeleteMode {
    Permanent,
    Trash,
}

/// Helper for legacy/internal permanent deletion.
fn delete_entry_permanent(p: &Path, recursive: bool) -> std::io::Result<()> {
    if p.is_dir() {
        if recursive {
            fs::remove_dir_all(p)
        } else {
            fs::remove_dir(p)
        }
    } else {
        fs::remove_file(p)
    }
}

/// Delete a file or directory.
/// If `recursive` is true, deletes directory contents recursively.
pub fn delete_entry(path: &str, recursive: bool, mode: DeleteMode) -> OpResult {
    let p = Path::new(path);
    if !p.exists() {
        return OpResult::err(&format!("Path does not exist: {}", path));
    }

    match mode {
        DeleteMode::Trash => {
            match trash::delete(p) {
                Ok(_) => OpResult::with_outcome(
                    &format!("Moved to trash: {}", path),
                    CommitOutcome::Committed,
                ),
                // Do NOT silently fall back to a permanent delete here: the
                // caller explicitly asked for Trash, and turning that into
                // an unrecoverable delete without a separate confirmation
                // would make "trash" quietly become destructive. Surface
                // the failure instead; the caller can retry with
                // `DeleteMode::Permanent` if the user explicitly confirms.
                //
                // P1.6 models this as its own outcome. `RolledBack` is the
                // accurate one: nothing happened and the file is exactly where it
                // was. It is deliberately *not* ManualRecoveryRequired — there is
                // nothing to recover, only a decision to make — and deliberately
                // not a bare `success: false`, so the UI can offer the explicit
                // permanent-delete confirmation instead of showing an error the
                // user cannot act on.
                Err(e) => OpResult::with_outcome(
                    &format!(
                        "Could not move to trash: {}. Not deleted permanently without explicit confirmation.",
                        e
                    ),
                    CommitOutcome::RolledBack {
                        reason: format!("trash unavailable: {}", e),
                    },
                ),
            }
        }
        DeleteMode::Permanent => match delete_entry_permanent(p, recursive) {
            Ok(_) => OpResult::with_outcome(
                &format!("Deleted permanently: {}", path),
                CommitOutcome::Committed,
            ),
            Err(e) => OpResult::with_outcome(
                &format!("Failed to delete permanently: {}", e),
                CommitOutcome::RolledBack {
                    reason: e.to_string(),
                },
            ),
        },
    }
}

/// Delete multiple entries. Returns results for each path.
pub fn delete_entries(paths: &[String], recursive: bool, mode: DeleteMode) -> Vec<OpResult> {
    paths
        .iter()
        .map(|p| delete_entry(p, recursive, mode))
        .collect()
}

/// Whether `a` and `b` name the same directory entry — which is what a
/// case-only rename looks like on a case-insensitive filesystem (vfat, exFAT,
/// NTFS, default macOS volumes).
fn same_entry(a: &Path, b: &Path) -> bool {
    let (Ok(ma), Ok(mb)) = (a.symlink_metadata(), b.symlink_metadata()) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        ma.dev() == mb.dev() && ma.ino() == mb.ino()
    }
    #[cfg(not(unix))]
    {
        let _ = (ma, mb);
        matches!(
            (fs::canonicalize(a), fs::canonicalize(b)),
            (Ok(ca), Ok(cb)) if ca == cb
        )
    }
}

/// Rename / move a file or directory from `from` to `to`.
///
/// Never replaces an existing entry. This is the inline rename, and it used to
/// pass `Replace::IfFile`: renaming `a.txt` to the name of an existing `b.txt`
/// destroyed `b.txt` without a question. Atomic, but still gone. Overwriting is
/// a decision the copy/move conflict dialog asks for; a rename has no dialog.
pub fn rename_entry(from: &str, to: &str) -> OpResult {
    move_or_rename(from, to, crate::engine::commit::Replace::Never)
}

/// `rename_entry` with an explicit replace policy. Paste (`move_entries`) keeps
/// replacing an existing file atomically — the P1.5 decision for paste, which
/// copy_file shares — while the inline rename never does.
fn move_or_rename(from: &str, to: &str, replace: crate::engine::commit::Replace) -> OpResult {
    // A case-only rename on a case-insensitive filesystem names the entry
    // itself as the "existing" destination, and rename(2) on one inode is a
    // no-op. batch_rename stages through a temporary name, which handles both.
    if from != to && same_entry(Path::new(from), Path::new(to)) {
        return batch_rename(vec![(from.to_string(), to.to_string())])
            .into_iter()
            .next()
            .unwrap_or_else(|| OpResult::err("Rename produced no result"));
    }

    // P1.5: through the engine so the path policy applies — an intermediate
    // symlink is refused rather than followed out of the directory the user
    // was looking at (QSF-003).
    let spec = engine_spec(crate::engine::spec::OperationKind::Rename);
    let result = crate::engine::commit::move_entry_staged(
        &crate::engine::path_policy::PathPolicy::new(spec.symlinks),
        Path::new(from),
        Path::new(to),
        spec.verification,
        spec.metadata,
        replace,
        &mut |_| Ok(()),
    );

    match result {
        Ok(kind) => OpResult::from_move(from, to, kind),
        // A folder moved to another filesystem cannot be renamed, and the engine
        // refuses to guess: it hands the case back untouched. The tree copy plus
        // source removal is the journaled model from QSF-002 — copy first, verify
        // every file through the engine, and only release the original once the
        // whole tree has committed. Without this, cut-and-paste of a folder
        // across filesystems failed outright.
        Err(crate::engine::commit::CommitError::CrossDeviceDirectory { .. }) => {
            // The tree copy merges into an existing directory; a rename must
            // not, for the same reason it must not replace a file.
            if matches!(replace, crate::engine::commit::Replace::Never)
                && Path::new(to).symlink_metadata().is_ok()
            {
                return OpResult::err(&format!("Destination already exists: {}", to));
            }
            move_directory_by_copying(from, to)
        }
        Err(e) => OpResult::from_commit_error(&e),
    }
}

/// Move a directory by copying the tree and then removing the source.
///
/// Used for the two cases a `rename` cannot express: another filesystem
/// (EXDEV) and merging into an existing directory of the same name (ENOTEMPTY).
/// Each file is committed individually through `engine::commit`, which is the
/// journaled per-entry model — a tree has no atomic commit.
///
/// The source is released only after every file has committed. If the copy fails
/// the original is left completely intact; if the copy succeeds but the source
/// cannot be removed, this reports failure rather than "moved", because both
/// copies then exist and calling that a move hides the leftover original — the
/// same rule [`OpResult::from_move`] applies to `CopiedSourceRetained`.
fn move_directory_by_copying(from: &str, to: &str) -> OpResult {
    let copied = copy_directory(from, to);
    if !copied.success {
        return copied;
    }
    match fs::remove_dir_all(Path::new(from)) {
        Ok(()) => OpResult::ok(&format!("Moved: {} → {}", from, to)),
        Err(e) => OpResult::err(&format!(
            "Copied '{}' to '{}', but could not remove the original: {}. \
             Both copies still exist.",
            from, to, e
        )),
    }
}

/// Batch rename, staged through unguessable temporary names.
///
/// # What P1.6 fixed (QSF-011)
///
/// The previous implementation staged through `{source}.nc_rename_tmp_{index}`.
/// That name is fully predictable, and `fs::rename` onto it destroys whatever is
/// already there — so a user file that happened to carry it was lost without a
/// word, and so was anything left behind by a crashed earlier batch. There is a
/// characterization test that reproduced exactly that.
///
/// Three changes:
///
/// 1. Staging names are random (`.nc-rename-<uuid>`), so they cannot collide with
///    a user's file or with a concurrent batch.
/// 2. Both phases go through [`crate::engine::path_policy`], so no rename can be
///    redirected through a symlinked path component.
/// 3. A failure reports a [`Journal`] rather than a bag of prose. A batch that
///    could not be fully rolled back says so, and names the staging files it
///    could not restore, instead of leaving them for the user to find.
///
/// # Why two phases at all
///
/// A batch can contain a cycle — `a -> b, b -> a` — which no ordering of plain
/// renames can perform. Staging every source under a temporary name first breaks
/// every cycle, and is why this cannot simply loop over `rename_entry`.
pub fn batch_rename(renames: Vec<(String, String)>) -> Vec<OpResult> {
    let mut results = vec![OpResult::ok("Preflight passed"); renames.len()];
    // Preflight rejections fill in *every* slot, not just the offending one:
    // returning early with the rest still reading "Preflight passed" would tell
    // the UI those renames succeeded.
    macro_rules! refuse_batch {
        ($i:expr, $msg:expr) => {{
            for (j, r) in results.iter_mut().enumerate() {
                *r = if j == $i {
                    batch_refused($msg)
                } else {
                    batch_refused("Not attempted: the batch was refused on another entry")
                };
            }
            return results;
        }};
    }

    // 1. Duplicate targets inside the batch.
    let mut seen_targets = std::collections::HashSet::new();
    for (i, (_, to)) in renames.iter().enumerate() {
        if !seen_targets.insert(to) {
            refuse_batch!(i, "Two entries in this batch rename to the same path");
        }
    }

    // 2. Sources exist, target parents exist, and no target collides with
    //    something outside the batch.
    let sources_set: std::collections::HashSet<&String> =
        renames.iter().map(|(from, _)| from).collect();
    for (i, (from, to)) in renames.iter().enumerate() {
        let from_path = Path::new(from);
        let to_path = Path::new(to);

        if !from_path.exists() {
            refuse_batch!(i, "Source path does not exist");
        }
        if let Some(parent) = to_path.parent() {
            if !parent.exists() {
                refuse_batch!(i, "Target parent directory does not exist");
            }
        }
        if to_path.exists() {
            let is_case_only = from.to_lowercase() == to.to_lowercase();
            if !is_case_only && !sources_set.contains(to) {
                refuse_batch!(i, "Target path already exists");
            }
        }
    }

    // 3. Phase one: stage every source under an unguessable name in its own
    //    directory. This is what breaks rename cycles.
    let mut staged: Vec<StagedRename> = Vec::new();
    for (i, (from, _)) in renames.iter().enumerate() {
        match StagedRename::stage(Path::new(from)) {
            Ok(entry) => staged.push(entry),
            Err(e) => {
                let journal = unstage_all(staged);
                return batch_failure(
                    renames.len(),
                    i,
                    &format!("Could not stage '{}': {}", from, e),
                    journal,
                );
            }
        }
    }

    // 4. Phase two: publish each staged entry under its target name.
    for (i, (_, to)) in renames.iter().enumerate() {
        if let Err(e) = staged[i].publish(Path::new(to)) {
            // Everything before `i` is published and has to be taken back down.
            let published = i;
            // Roll back what has been published, then unstage the rest.
            let mut journal = Journal::default();
            for entry in staged.iter_mut().take(published) {
                if let Err(e) = entry.unpublish() {
                    journal.failed.push(JournalFailure {
                        path: entry.staged_display(),
                        reason: format!("could not roll back: {}", e),
                    });
                    journal.orphaned_staging.push(entry.staged_display());
                }
            }
            let unstage_journal = unstage_all(staged);
            journal.failed.extend(unstage_journal.failed);
            journal
                .orphaned_staging
                .extend(unstage_journal.orphaned_staging);

            return batch_failure(
                renames.len(),
                i,
                &format!("Could not rename to '{}': {}", to, e),
                journal,
            );
        }
    }

    for (i, (from, to)) in renames.iter().enumerate() {
        results[i] = OpResult::with_outcome(
            &format!("Renamed: {} → {}", from, to),
            CommitOutcome::Committed,
        );
    }
    results
}

/// A batch rename refused before anything was staged.
///
/// `RolledBack` rather than a bare error: nothing was attempted, so the
/// destination is intact, and that is the fact the UI needs. There is no
/// "refused before starting" variant because it would be indistinguishable in
/// every way that matters — `destination_preserved()` is true for both.
fn batch_refused(reason: &str) -> OpResult {
    OpResult::with_outcome(
        reason,
        CommitOutcome::RolledBack {
            reason: reason.to_string(),
        },
    )
}

/// Build the per-entry results for a failed batch.
///
/// Every entry gets a result, and the ones that were rolled back say so rather
/// than reporting a bare failure the user cannot interpret. If the rollback
/// itself was incomplete the journal is attached to *every* entry, because the
/// leftover staging files are a property of the batch, not of one rename.
fn batch_failure(
    len: usize,
    failed_index: usize,
    message: &str,
    journal: Journal,
) -> Vec<OpResult> {
    let clean = journal.failed.is_empty() && journal.orphaned_staging.is_empty();
    (0..len)
        .map(|i| {
            let outcome = if clean {
                CommitOutcome::RolledBack {
                    reason: message.to_string(),
                }
            } else {
                CommitOutcome::PartiallyCommitted {
                    journal: journal.clone(),
                }
            };
            let text = if i == failed_index {
                message.to_string()
            } else if clean {
                "Rolled back: the batch failed on another entry".to_string()
            } else {
                format!(
                    "The batch failed and could not be fully rolled back ({}). \
                     Staged files left behind: {}",
                    journal.summary(),
                    journal.orphaned_staging.join(", ")
                )
            };
            OpResult::with_outcome(&text, outcome)
        })
        .collect()
}

/// Restore every staged entry to its original name, collecting what could not be.
fn unstage_all(staged: Vec<StagedRename>) -> Journal {
    let mut journal = Journal::default();
    for mut entry in staged {
        if let Err(e) = entry.unstage() {
            journal.failed.push(JournalFailure {
                path: entry.original_display(),
                reason: format!("could not restore the original name: {}", e),
            });
            journal.orphaned_staging.push(entry.staged_display());
        }
    }
    journal
}

/// One entry of a batch rename, currently parked under a temporary name.
struct StagedRename {
    dir: crate::engine::path_policy::DirHandle,
    original_name: std::ffi::OsString,
    staged_name: std::ffi::OsString,
    /// Set once published; `Some(directory, name)` of where it now lives.
    published_at: Option<(crate::engine::path_policy::DirHandle, std::ffi::OsString)>,
}

impl StagedRename {
    fn stage(from: &Path) -> Result<Self, String> {
        let parent = from
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .ok_or_else(|| format!("'{}' has no parent directory", from.display()))?;
        let original_name = from
            .file_name()
            .ok_or_else(|| format!("'{}' has no file name", from.display()))?
            .to_os_string();

        let dir = crate::engine::path_policy::PathPolicy::default()
            .open_dir(parent)
            .map_err(|e| e.to_string())?;

        // Unguessable, unlike the old {source}.nc_rename_tmp_{index}.
        let staged_name =
            std::ffi::OsString::from(format!(".nc-rename-{}", uuid::Uuid::new_v4().simple()));
        dir.rename(&original_name, &staged_name)
            .map_err(|e| e.to_string())?;

        Ok(StagedRename {
            dir,
            original_name,
            staged_name,
            published_at: None,
        })
    }

    fn publish(&mut self, to: &Path) -> Result<(), String> {
        let parent = to
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .ok_or_else(|| format!("'{}' has no parent directory", to.display()))?;
        let target_name = to
            .file_name()
            .ok_or_else(|| format!("'{}' has no file name", to.display()))?
            .to_os_string();

        // Cross-directory renames are legal in a batch, so the target directory
        // gets its own policy-checked handle.
        let target_dir = if parent == self.dir.path() {
            self.dir.try_clone().map_err(|e| e.to_string())?
        } else {
            crate::engine::path_policy::PathPolicy::default()
                .open_dir(parent)
                .map_err(|e| e.to_string())?
        };
        // renameat with both descriptors: a cross-directory rename by path would
        // step outside both pinned handles.
        self.dir
            .rename_into(&self.staged_name, &target_dir, &target_name)
            .map_err(|e| e.to_string())?;
        self.published_at = Some((target_dir, target_name));
        Ok(())
    }

    /// Move a published entry back to its staging name.
    fn unpublish(&mut self) -> Result<(), String> {
        let Some((dir, name)) = self.published_at.take() else {
            return Ok(());
        };
        if let Err(e) = dir.rename_into(&name, &self.dir, &self.staged_name) {
            let from_path = dir.path().join(&name);
            let to_path = self.dir.path().join(&self.staged_name);
            if let Err(e2) = std::fs::rename(&from_path, &to_path) {
                return Err(format!("{} (fallback rename: {})", e, e2));
            }
        }
        Ok(())
    }

    /// Restore the original name.
    fn unstage(&mut self) -> Result<(), String> {
        if self.published_at.is_some() {
            let _ = self.unpublish();
        }
        if let Err(e) = self.dir.rename(&self.staged_name, &self.original_name) {
            let from_path = self.dir.path().join(&self.staged_name);
            let to_path = self.dir.path().join(&self.original_name);
            if let Err(e2) = std::fs::rename(&from_path, &to_path) {
                return Err(format!("{} (fallback rename: {})", e, e2));
            }
        }
        Ok(())
    }

    fn staged_display(&self) -> String {
        self.dir
            .path()
            .join(&self.staged_name)
            .to_string_lossy()
            .to_string()
    }

    fn original_display(&self) -> String {
        self.dir
            .path()
            .join(&self.original_name)
            .to_string_lossy()
            .to_string()
    }
}

/// Copy a single file from `src` to `dst`.
/// Copy a single file from `src` to `dst`.
pub fn copy_file(src: &str, dst: &str) -> OpResult {
    let src_path = Path::new(src);
    let dst_path = Path::new(dst);

    if !src_path.exists() {
        return OpResult::err(&format!("Source does not exist: {}", src));
    }

    if src_path.is_dir() {
        return copy_directory(src, dst);
    }

    // Create parent directory if it doesn't exist
    if let Some(parent) = dst_path.parent() {
        if !parent.exists() {
            if let Err(e) = fs::create_dir_all(parent) {
                return OpResult::err(&format!("Failed to create parent directory: {}", e));
            }
        }
    }

    // P1.5: staged in the destination directory, verified, then committed by
    // rename. Replaces the P0.6 refusal, which had to decline every overwrite
    // because fs::copy truncates the destination before a single byte of the
    // replacement is known to be good.
    match copy_via_engine(src_path, dst_path) {
        Ok(report) => OpResult::ok(&format!(
            "Copied {} ({} bytes, {})",
            src,
            report.bytes,
            report.durability_claim()
        )),
        Err(e) => OpResult::from_commit_error(&e),
    }
}

/// Copy one regular file through the commit engine with this crate's defaults.
fn copy_via_engine(
    src: &Path,
    dst: &Path,
) -> Result<crate::engine::commit::CommitReport, crate::engine::commit::CommitError> {
    let spec = engine_spec(crate::engine::spec::OperationKind::Copy);
    crate::engine::commit::copy_file_staged(
        &crate::engine::path_policy::PathPolicy::new(spec.symlinks),
        src,
        dst,
        spec.verification,
        spec.metadata,
        crate::engine::commit::Replace::IfFile,
        &mut |_| Ok(()),
    )
}

/// The default policy set for a direct (non-queued) operation of `kind`.
fn engine_spec(kind: crate::engine::spec::OperationKind) -> crate::engine::spec::OperationSpec {
    crate::engine::spec::OperationSpec::new(kind, Vec::new(), None)
}

fn canonicalize_path(p: &Path) -> std::path::PathBuf {
    if p.exists() {
        fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
    } else if let Some(parent) = p.parent() {
        let parent_canon = canonicalize_path(parent);
        if let Some(file_name) = p.file_name() {
            parent_canon.join(file_name)
        } else {
            parent_canon
        }
    } else {
        p.to_path_buf()
    }
}

impl OpResult {
    /// Report a `CommitError`.
    ///
    /// Every one of them leaves the destination intact, which is the fact the
    /// message has to convey — the engine's Display impls all say so explicitly
    /// rather than leaving the user to guess.
    fn from_commit_error(e: &crate::engine::commit::CommitError) -> OpResult {
        OpResult::with_outcome(&e.to_string(), e.as_outcome())
    }

    /// Report a completed move.
    fn from_move(from: &str, to: &str, kind: crate::engine::commit::MoveKind) -> OpResult {
        use crate::engine::commit::MoveKind;
        match kind {
            MoveKind::Renamed => OpResult::ok(&format!("Moved: {} → {}", from, to)),
            MoveKind::CopiedThenSourceRemoved { bytes } => {
                OpResult::ok(&format!("Moved: {} → {} ({} bytes)", from, to, bytes))
            }
            // Not success. The data is safe and duplicated, and saying "moved"
            // would leave the user to discover the original themselves.
            MoveKind::CopiedSourceRetained { reason, .. } => OpResult::err(&format!(
                "Copied to {} successfully, but could not remove the original '{}': {}.                  Both copies still exist.",
                to, from, reason
            )),
        }
    }
}

/// Recursively copy a directory from `src` to `dst`.
fn copy_directory(src: &str, dst: &str) -> OpResult {
    let src_path = Path::new(src);
    let dst_path = Path::new(dst);

    let src_canon = canonicalize_path(src_path);
    let dst_canon = canonicalize_path(dst_path);

    if dst_canon == src_canon || dst_canon.starts_with(&src_canon) {
        return OpResult::err("Cannot copy directory into itself or its subdirectory");
    }

    if let Err(e) = fs::create_dir_all(dst_path) {
        return OpResult::err(&format!("Failed to create destination directory: {}", e));
    }

    let entries = match fs::read_dir(src_path) {
        Ok(e) => e,
        Err(e) => return OpResult::err(&format!("Failed to read source directory: {}", e)),
    };

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => return OpResult::err(&format!("Failed to read entry: {}", e)),
        };

        let src_child = entry.path();
        let dst_child = dst_path.join(entry.file_name());

        if src_child.is_dir() {
            let result = copy_directory(&src_child.to_string_lossy(), &dst_child.to_string_lossy());
            if !result.success {
                return result;
            }
        } else {
            // P1.5: each file is staged and committed individually. A tree
            // cannot be committed atomically, so this is the journaled model
            // from section 6.1 — per-entry atomic commits. Merging into a
            // populated directory keeps working, and a colliding file is now
            // replaced safely instead of refused.
            if let Err(e) = copy_via_engine(&src_child, &dst_child) {
                return OpResult::err(&format!("Failed to copy {}: {}", src_child.display(), e));
            }
        }
    }

    if let Err(e) = preserve_modified_time(src_path, dst_path) {
        return OpResult::err(&format!(
            "Copied directory data but failed to preserve modification time: {}",
            e
        ));
    }

    OpResult::ok(&format!("Directory copied: {} → {}", src, dst))
}

/// Copy multiple entries to a target directory.
pub fn copy_entries(sources: &[String], target_dir: &str) -> Vec<OpResult> {
    let target = Path::new(target_dir);
    sources
        .iter()
        .map(|src| {
            let src_path = Path::new(src);
            let file_name = src_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let dst = target.join(&file_name);
            copy_file(src, &dst.to_string_lossy())
        })
        .collect()
}

/// Move multiple entries to a target directory.
pub fn move_entries(sources: &[String], target_dir: &str) -> Vec<OpResult> {
    let target = Path::new(target_dir);
    sources
        .iter()
        .map(|src| {
            let src_path = Path::new(src);
            let file_name = src_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let dst = target.join(&file_name);
            // Pasting a folder into a directory that already holds one of that
            // name is a merge, not a replacement. `rename` cannot merge trees
            // (ENOTEMPTY), so this goes to the per-file tree copy — the same
            // route the queued move takes, so paste and F6 agree. `rename_entry`
            // itself must not do this: it is also the plain rename, where
            // silently merging two folders would be a surprise.
            if src_path.is_dir() && dst.is_dir() {
                return move_directory_by_copying(src, &dst.to_string_lossy());
            }
            move_or_rename(
                src,
                &dst.to_string_lossy(),
                crate::engine::commit::Replace::IfFile,
            )
        })
        .collect()
}

/// Save a text file safely with binary/null-byte guard and size cap.
pub fn save_text_file(path: &str, text: &str) -> Result<(), String> {
    let p = Path::new(path);
    if p.is_dir() {
        return Err("Cannot save to a directory path".to_string());
    }

    // Guard against binary: check for null bytes
    if text.as_bytes().contains(&0) {
        return Err("Cannot save file: binary content detected".to_string());
    }

    // Size limit check: 10MB
    const MAX_TEXT_SIZE: usize = 10 * 1024 * 1024;
    if text.len() > MAX_TEXT_SIZE {
        return Err(format!(
            "File size exceeds limit of {} bytes for in-app text editor",
            MAX_TEXT_SIZE
        ));
    }

    // P1.4: staged in the destination directory and committed by rename.
    // `fs::write` truncated the file before writing, so a failure part-way
    // through left the user's document truncated — the in-app editor's own
    // version of QSF-001, and the one destructive path P0.6 never guarded.
    crate::engine::commit::write_config_atomically(p, text.as_bytes())
        .map_err(|e| format!("Failed to write file: {}", e))?;
    Ok(())
}

fn calculate_dir_size_du(path: &str) -> Option<u64> {
    use std::process::Command;
    let output = Command::new("du").args(["-sb", "--", path]).output().ok()?;

    if output.status.success() || !output.stdout.is_empty() {
        let stdout_str = String::from_utf8_lossy(&output.stdout);
        if let Some(first_word) = stdout_str.split_whitespace().next() {
            if let Ok(size) = first_word.parse::<u64>() {
                return Some(size);
            }
        }
    }
    None
}

/// Calculate total size of a directory recursively.
pub fn calculate_dir_size(path: &str) -> Result<u64, String> {
    let p = Path::new(path);
    if !p.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }
    if let Some(size) = calculate_dir_size_du(path) {
        return Ok(size);
    }
    dir_size_recursive(p).map_err(|e| format!("Failed to calculate size: {}", e))
}

fn dir_size_recursive(path: &Path) -> Result<u64, std::io::Error> {
    let mut total: u64 = 0;
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            if let Ok(md) = fs::symlink_metadata(entry.path()) {
                total += md.len();
            }
        } else if file_type.is_dir() {
            total += dir_size_recursive(&entry.path())?;
        } else {
            if let Ok(md) = entry.metadata() {
                total += md.len();
            }
        }
    }
    Ok(total)
}

// ===== Path utilities =====

/// Returns the home directory path for the current user.
pub fn get_home_dir() -> String {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| String::from("/"))
}

/// Returns the parent directory of the given path.
pub fn get_parent_dir(path: &str) -> String {
    Path::new(path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| String::from("/"))
}

/// Returns basic info about a path (exists, is_dir, canonical path)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PathInfo {
    pub exists: bool,
    pub is_dir: bool,
    pub canonical: String,
}

pub fn get_path_info(path: &str) -> PathInfo {
    let p = Path::new(path);
    let exists = p.exists();
    let is_dir = p.is_dir();
    let canonical = p
        .canonicalize()
        .map(|c| c.to_string_lossy().to_string())
        .unwrap_or_else(|_| path.to_string());

    PathInfo {
        exists,
        is_dir,
        canonical,
    }
}

/// Information about a logic drive or mount point.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DriveInfo {
    pub path: String,
    pub name: String,
    pub drive_type: String, // "Local", "Network", "Removable", "CDROM"
    pub total_space: u64,
    pub available_space: u64,
}

fn decode_mount_path(path: &str) -> String {
    path.replace("\\040", " ")
}

fn is_gvfs_root_mount(source: &str, mount_point: &str, fs_type: &str) -> bool {
    source == "gvfsd-fuse"
        || fs_type == "fuse.gvfsd-fuse"
        || (mount_point.starts_with("/run/user/") && mount_point.ends_with("/gvfs"))
}

fn gvfs_display_name(raw_name: &str) -> String {
    for key in ["share=", "host=", "server="] {
        if let Some(start) = raw_name.find(key) {
            let value_start = start + key.len();
            let value = raw_name[value_start..]
                .split(',')
                .next()
                .unwrap_or(raw_name)
                .replace("\\040", " ");
            if !value.is_empty() {
                return value;
            }
        }
    }

    raw_name.to_string()
}

fn get_disk_space(path: &str) -> (u64, u64) {
    #[cfg(unix)]
    {
        use std::ffi::CString;
        use std::mem::MaybeUninit;

        if let Ok(c_path) = CString::new(path) {
            unsafe {
                let mut stat: libc::statvfs = MaybeUninit::zeroed().assume_init();
                if libc::statvfs(c_path.as_ptr(), &mut stat) == 0 {
                    // The casts are redundant on 64-bit Linux, where clippy sees
                    // them, but statvfs field widths are platform-defined and
                    // this block also compiles for macOS. Keeping them costs
                    // nothing and avoids a silent truncation on a target that
                    // cannot be tested from here.
                    #[allow(clippy::unnecessary_cast)]
                    let block_size = stat.f_frsize as u64;
                    #[allow(clippy::unnecessary_cast)]
                    let total = stat.f_blocks as u64 * block_size;
                    #[allow(clippy::unnecessary_cast)]
                    let free = stat.f_bavail as u64 * block_size;
                    return (total, free);
                }
            }
        }
    }

    #[cfg(windows)]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;

        let wide_path: Vec<u16> = OsStr::new(path)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        let mut free_bytes_available: u64 = 0;
        let mut total_number_of_bytes: u64 = 0;
        let mut total_number_of_free_bytes: u64 = 0;

        unsafe {
            if winapi::um::fileapi::GetDiskFreeSpaceExW(
                wide_path.as_ptr(),
                &mut free_bytes_available as *mut _ as *mut _,
                &mut total_number_of_bytes as *mut _ as *mut _,
                &mut total_number_of_free_bytes as *mut _ as *mut _,
            ) != 0
            {
                return (total_number_of_bytes, free_bytes_available);
            }
        }
    }

    (0, 0)
}

/// Lists all available logic drives / mounts on the system.
fn collect_drives() -> Vec<DriveInfo> {
    let mut drives = Vec::new();

    #[cfg(target_os = "windows")]
    {
        // On Windows, use logical drive letters
        use std::os::windows::ffi::OsStrExt;
        let mut buffer = [0u16; 256];
        unsafe {
            let len = winapi::um::fileapi::GetLogicalDriveStringsW(256, buffer.as_mut_ptr());
            if len > 0 {
                let mut start = 0;
                while start < len as usize {
                    let end = buffer[start..].iter().position(|&x| x == 0).unwrap_or(0);
                    if end == 0 {
                        break;
                    }
                    let drive_path_vec: Vec<u16> = buffer[start..start + end + 1].to_vec();
                    let drive_path = String::from_utf16_lossy(&drive_path_vec[..end]);

                    // Get drive type
                    let wide_path: Vec<u16> = std::ffi::OsStr::new(&drive_path)
                        .encode_wide()
                        .chain(std::iter::once(0))
                        .collect();
                    let t = winapi::um::fileapi::GetDriveTypeW(wide_path.as_ptr());
                    let drive_type = match t {
                        winapi::um::winbase::DRIVE_FIXED => "Local",
                        winapi::um::winbase::DRIVE_REMOTE => "Network",
                        winapi::um::winbase::DRIVE_REMOVABLE => "Removable",
                        winapi::um::winbase::DRIVE_CDROM => "CDROM",
                        _ => "Unknown",
                    };

                    drives.push(DriveInfo {
                        path: drive_path.clone(),
                        name: drive_path,
                        drive_type: drive_type.to_string(),
                        total_space: 0, // Would need GetDiskFreeSpaceEx
                        available_space: 0,
                    });
                    start += end + 1;
                }
            }
        }
    }

    #[cfg(target_os = "linux")]
    fn detect_drive_type(mount_source: &str, mount_point: &str, fs_type: &str) -> &'static str {
        let source_lower = mount_source.to_lowercase();
        let fs_lower = fs_type.to_lowercase();
        let point_lower = mount_point.to_lowercase();

        // 1. Explicit Network Protocol & Naming Checks
        let is_network_fs = fs_lower.contains("cifs")
            || fs_lower.contains("smb")
            || fs_lower.contains("nfs")
            || fs_lower.contains("gvfs")
            || fs_lower.contains("sshfs")
            || fs_lower.contains("davfs")
            || fs_lower.contains("afp")
            || fs_lower.contains("rclone")
            || fs_lower.contains("autofs");

        let is_network_source = source_lower.contains("//")
            || source_lower.contains("\\\\")
            || source_lower.contains(':')
            || source_lower.contains("smb")
            || source_lower.contains("cifs")
            || source_lower.contains("gvfs")
            || source_lower.contains("nfs")
            || source_lower.contains("ds216")
            || source_lower.contains("omv")
            || source_lower.contains("nas");

        if is_network_fs || is_network_source {
            return "Network";
        }

        // 2. Physical Block Devices (/dev/sd*, /dev/nvme*, /dev/mapper/*, etc.)
        if mount_source.starts_with("/dev/") {
            let dev_name = mount_source.trim_start_matches("/dev/");
            let disk_name = if dev_name.starts_with("nvme") || dev_name.starts_with("mmcblk") {
                dev_name.split('p').next().unwrap_or(dev_name)
            } else {
                dev_name.trim_end_matches(|c: char| c.is_ascii_digit())
            };

            let removable_path = format!("/sys/class/block/{}/removable", disk_name);
            if let Ok(rem_str) = fs::read_to_string(&removable_path) {
                if rem_str.trim() == "1" {
                    return "Removable";
                }
            }

            let sys_device_path = format!("/sys/class/block/{}/device", disk_name);
            if let Ok(target) = fs::read_link(&sys_device_path) {
                if target.to_string_lossy().contains("usb") {
                    return "Removable";
                }
            }

            if point_lower.starts_with("/media") || point_lower.starts_with("/run/media") {
                return "Removable";
            }

            return "Local";
        }

        // 3. Any non-/dev mounts under /mnt, /media, /run/media that are not local filesystems (ZFS/Btrfs/Ext4)
        let is_local_fs = fs_lower == "zfs"
            || fs_lower == "btrfs"
            || fs_lower == "ext4"
            || fs_lower == "xfs"
            || fs_lower == "ntfs"
            || fs_lower == "ntfs3"
            || fs_lower == "vfat";
        if (point_lower.starts_with("/mnt")
            || point_lower.starts_with("/media")
            || point_lower.starts_with("/run/media"))
            && !is_local_fs
        {
            return "Network";
        }

        "Local"
    }

    #[cfg(target_os = "linux")]
    fn clean_drive_name(mount_point: &str) -> String {
        if mount_point == "/" {
            return "/".to_string();
        }

        let trimmed = mount_point.trim_end_matches('/');
        let parts: Vec<&str> = trimmed.split('/').filter(|s| !s.is_empty()).collect();

        if parts.is_empty() {
            return mount_point.to_string();
        }

        parts.last().unwrap_or(&mount_point).to_string()
    }

    #[cfg(target_os = "linux")]
    fn is_container_path(path: &str) -> bool {
        let p = path.trim_end_matches('/');
        if p == "/" || p.is_empty() {
            return false;
        }
        if p == "/media" || p == "/run/media" || p == "/mnt" || p == "/run/user" {
            return true;
        }
        let parts: Vec<&str> = p.split('/').filter(|s| !s.is_empty()).collect();
        if parts.len() == 2 && (parts[0] == "media" || parts[0] == "run") {
            return true;
        }
        if parts.len() == 3 && parts[0] == "run" && parts[1] == "media" {
            return true;
        }
        false
    }

    #[cfg(target_os = "linux")]
    {
        // 1. Parse /proc/mounts for common mount points
        if let Ok(content) = fs::read_to_string("/proc/mounts") {
            for line in content.lines() {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 3 {
                    let mount_source = parts[0];
                    let mount_point = decode_mount_path(parts[1]);
                    let fs_type = parts[2];

                    if is_gvfs_root_mount(mount_source, &mount_point, fs_type) {
                        continue;
                    }

                    if is_container_path(&mount_point) {
                        continue;
                    }

                    // Skip pseudo filesystems, automount triggers, and kernel mounts.
                    // Checking exists() on an 'autofs' mount point blocks on unreachable
                    // remote servers until network timeout.
                    if fs_type == "autofs"
                        || fs_type == "binfmt_misc"
                        || fs_type.starts_with("cgroup")
                        || fs_type == "devpts"
                        || fs_type == "devtmpfs"
                        || fs_type == "sysfs"
                        || fs_type == "proc"
                        || fs_type == "securityfs"
                        || fs_type == "pstore"
                        || fs_type == "bpf"
                        || fs_type == "tracefs"
                        || fs_type == "debugfs"
                        || fs_type == "mqueue"
                        || fs_type == "hugetlbfs"
                        || fs_type == "fusectl"
                        || fs_type == "configfs"
                        || fs_type == "rpc_pipefs"
                        || fs_type == "efivarfs"
                        || mount_source.starts_with("systemd-1")
                    {
                        continue;
                    }

                    if mount_point == "/"
                        || mount_point.starts_with("/media")
                        || mount_point.starts_with("/mnt")
                        || mount_point.starts_with("/run/media")
                    {
                        if !Path::new(&mount_point).exists() {
                            continue;
                        }

                        let drive_type = detect_drive_type(mount_source, &mount_point, fs_type);
                        let name = clean_drive_name(&mount_point);

                        if !drives
                            .iter()
                            .any(|d: &DriveInfo| d.path == mount_point || d.name == name)
                        {
                            drives.push(DriveInfo {
                                path: mount_point,
                                name,
                                drive_type: drive_type.to_string(),
                                total_space: 0,
                                available_space: 0,
                            });
                        }
                    }
                }
            }
        }

        // 2. Scan GVFS mount points (modern Linux network mounts)
        if let Ok(user_dir) = fs::read_dir("/run/user") {
            for entry in user_dir.flatten() {
                let gvfs_path = entry.path().join("gvfs");
                if gvfs_path.exists() && gvfs_path.is_dir() {
                    if let Ok(mounts) = fs::read_dir(&gvfs_path) {
                        for mount in mounts.flatten() {
                            let path = mount.path().to_string_lossy().to_string();
                            if !Path::new(&path).exists() {
                                continue;
                            }
                            let name = gvfs_display_name(&mount.file_name().to_string_lossy());

                            if !drives
                                .iter()
                                .any(|d: &DriveInfo| d.path == path || d.name == name)
                            {
                                drives.push(DriveInfo {
                                    path,
                                    name,
                                    drive_type: "Network".to_string(),
                                    total_space: 0,
                                    available_space: 0,
                                });
                            }
                        }
                    }
                }
            }
        }

        // 3. Scan /media and /run/media for automounted USB devices (udisks2 / GNOME Files)
        for base in &["/media", "/run/media"] {
            if let Ok(entries) = fs::read_dir(base) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        let path_str = path.to_string_lossy().to_string();

                        // Check subdirectories (e.g. /media/$USER/USB_LABEL)
                        if let Ok(sub_entries) = fs::read_dir(&path) {
                            for sub in sub_entries.flatten() {
                                let sub_path = sub.path();
                                if sub_path.is_dir() {
                                    let sub_str = sub_path.to_string_lossy().to_string();
                                    if is_container_path(&sub_str) || !Path::new(&sub_str).exists()
                                    {
                                        continue;
                                    }
                                    let sub_name = clean_drive_name(&sub_str);
                                    if !drives
                                        .iter()
                                        .any(|d| d.path == sub_str || d.name == sub_name)
                                    {
                                        drives.push(DriveInfo {
                                            path: sub_str,
                                            name: sub_name,
                                            drive_type: "Removable".to_string(),
                                            total_space: 0,
                                            available_space: 0,
                                        });
                                    }
                                }
                            }
                        }

                        if !is_container_path(&path_str) && Path::new(&path_str).exists() {
                            let dir_name = clean_drive_name(&path_str);
                            if !drives
                                .iter()
                                .any(|d| d.path == path_str || d.name == dir_name)
                            {
                                drives.push(DriveInfo {
                                    path: path_str,
                                    name: dir_name,
                                    drive_type: "Removable".to_string(),
                                    total_space: 0,
                                    available_space: 0,
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        // On MacOS, list /Volumes
        drives.push(DriveInfo {
            path: "/".to_string(),
            name: "Macintosh HD".to_string(),
            drive_type: "Local".to_string(),
            total_space: 0,
            available_space: 0,
        });

        if let Ok(entries) = fs::read_dir("/Volumes") {
            for entry in entries.flatten() {
                let path = entry.path().to_string_lossy().to_string();
                let name = entry.file_name().to_string_lossy().to_string();
                drives.push(DriveInfo {
                    path,
                    name,
                    drive_type: "Removable".to_string(), // Most things in /Volumes are removable/network
                    total_space: 0,
                    available_space: 0,
                });
            }
        }
    }

    // Sort drives: Local (Root first) -> Network -> Removable, each alphabetical
    drives.sort_by(|a, b| {
        let p_a = match a.drive_type.as_str() {
            "Local" => 0,
            "Network" => 1,
            _ => 2,
        };
        let p_b = match b.drive_type.as_str() {
            "Local" => 0,
            "Network" => 1,
            _ => 2,
        };

        if p_a != p_b {
            return p_a.cmp(&p_b);
        }

        // Within same group, handle Root (/) priority for Local
        if p_a == 0 {
            if a.path == "/" {
                return std::cmp::Ordering::Less;
            }
            if b.path == "/" {
                return std::cmp::Ordering::Greater;
            }
        }

        // Default: Alphabetical by name
        a.name.to_lowercase().cmp(&b.name.to_lowercase())
    });

    // Query disk space in parallel across all drives with a deadline to prevent
    // any unresponsive network shares (CIFS/NFS) from hanging the entire list.
    let mut receivers = Vec::with_capacity(drives.len());
    for drive in &drives {
        let path = drive.path.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        let _ = std::thread::Builder::new()
            .name("vfs-disk-space".to_string())
            .spawn(move || {
                let res = get_disk_space(&path);
                let _ = tx.send(res);
            });
        receivers.push(rx);
    }

    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(2000);
    for (drive, rx) in drives.iter_mut().zip(receivers) {
        let now = std::time::Instant::now();
        if now < deadline {
            let remaining = deadline - now;
            if let Ok((total, available)) = rx.recv_timeout(remaining) {
                drive.total_space = total;
                drive.available_space = available;
            }
        }
    }

    drives
}

#[tauri::command]
pub async fn get_drives() -> Vec<DriveInfo> {
    tauri::async_runtime::spawn_blocking(collect_drives)
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub async fn compare_directories(
    left_path: String,
    right_path: String,
) -> Result<ComparisonResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let left_entries = read_directory(&left_path)?;
        let right_entries = read_directory(&right_path)?;

        let mut result = ComparisonResult {
            only_in_left: Vec::new(),
            only_in_right: Vec::new(),
            different: Vec::new(),
            identical: Vec::new(),
        };

        let left_map: std::collections::HashMap<String, FileEntry> = left_entries
            .into_iter()
            .map(|e| (e.name.clone(), e))
            .collect();

        let right_map: std::collections::HashMap<String, FileEntry> = right_entries
            .into_iter()
            .map(|e| (e.name.clone(), e))
            .collect();

        for (name, left_entry) in &left_map {
            // Skip hidden files or ".." if they were in the list (though usually they aren't in this VFS)
            if name == ".." || name == "." {
                continue;
            }

            if let Some(right_entry) = right_map.get(name) {
                if left_entry.is_dir == right_entry.is_dir
                    && (left_entry.is_dir
                        || (left_entry.size == right_entry.size
                            && left_entry.modified == right_entry.modified))
                {
                    result.identical.push(name.clone());
                } else {
                    result.different.push(name.clone());
                }
            } else {
                result.only_in_left.push(name.clone());
            }
        }

        for name in right_map.keys() {
            if name == ".." || name == "." {
                continue;
            }
            if !left_map.contains_key(name) {
                result.only_in_right.push(name.clone());
            }
        }

        Ok(result)
    })
    .await
    .map_err(|e| format!("Task execution error: {}", e))?
}

// ===== File properties: permissions / ownership / size-on-disk =====
// Backs the shared (PWA-origin) FilePropertiesDialog on the desktop shell. The
// desktop backend previously could only READ permissions (get_path_info / read_directory);
// these commands let it WRITE them. Privilege escalation is handled the existing way:
// the process is (re)started as root via `restart_as_root` (pkexec), so these ops run
// with whatever privileges the process holds. See docs security audit 2026-07.

/// Users and groups known to the system, plus the current user/group.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsersGroups {
    pub users: Vec<String>,
    pub groups: Vec<String>,
    #[serde(rename = "currentUser")]
    pub current_user: Option<String>,
    #[serde(rename = "currentGroup")]
    pub current_group: Option<String>,
}

/// Enumerate system users and groups (from /etc/passwd and /etc/group) plus the
/// current user/group. Mirrors the web server's `GET /fs/users-groups`.
#[cfg(unix)]
pub fn get_users_groups() -> UsersGroups {
    use std::io::BufRead;

    fn first_fields(path: &str) -> Vec<String> {
        let mut out = Vec::new();
        if let Ok(f) = fs::File::open(path) {
            for line in std::io::BufReader::new(f).lines().map_while(Result::ok) {
                if line.starts_with('#') {
                    continue;
                }
                if let Some(name) = line.split(':').next() {
                    if !name.is_empty() {
                        out.push(name.to_string());
                    }
                }
            }
        }
        out.sort();
        out.dedup();
        out
    }

    let users = first_fields("/etc/passwd");
    let groups = first_fields("/etc/group");

    let uid = uzers::get_current_uid();
    let gid = uzers::get_current_gid();
    let current_user = uzers::get_user_by_uid(uid).map(|u| u.name().to_string_lossy().to_string());
    let current_group =
        uzers::get_group_by_gid(gid).map(|g| g.name().to_string_lossy().to_string());

    UsersGroups {
        users,
        groups,
        current_user,
        current_group,
    }
}

#[cfg(not(unix))]
pub fn get_users_groups() -> UsersGroups {
    UsersGroups {
        users: Vec::new(),
        groups: Vec::new(),
        current_user: None,
        current_group: None,
    }
}

/// Set permissions (octal string like "755"/"0755") and/or owner/group (by name)
/// on a path. Any argument left as `None` is unchanged. POSIX-only.
#[cfg(unix)]
pub fn set_file_properties(
    path: &str,
    permissions: Option<String>,
    owner: Option<String>,
    group: Option<String>,
) -> OpResult {
    use std::os::unix::fs::PermissionsExt;

    let p = Path::new(path);
    if !p.exists() {
        return OpResult::err(&format!("Path does not exist: {path}"));
    }

    // Permissions (chmod).
    if let Some(perm) = permissions {
        let cleaned: String = perm.trim().trim_start_matches("0o").to_string();
        match u32::from_str_radix(&cleaned, 8) {
            Ok(mode) => {
                if let Err(e) = fs::set_permissions(p, fs::Permissions::from_mode(mode)) {
                    return OpResult::err(&format!("Failed to set permissions: {e}"));
                }
            }
            Err(_) => return OpResult::err(&format!("Invalid octal mode: {perm}")),
        }
    }

    // Ownership (chown by name).
    if owner.is_some() || group.is_some() {
        let uid = match &owner {
            Some(name) => match uzers::get_user_by_name(name) {
                Some(u) => Some(u.uid()),
                None => return OpResult::err(&format!("Unknown user: {name}")),
            },
            None => None,
        };
        let gid = match &group {
            Some(name) => match uzers::get_group_by_name(name) {
                Some(g) => Some(g.gid()),
                None => return OpResult::err(&format!("Unknown group: {name}")),
            },
            None => None,
        };
        if let Err(e) = std::os::unix::fs::chown(p, uid, gid) {
            return OpResult::err(&format!("Failed to change ownership: {e}"));
        }
    }

    OpResult::ok("Properties updated")
}

#[cfg(not(unix))]
pub fn set_file_properties(
    _path: &str,
    _permissions: Option<String>,
    _owner: Option<String>,
    _group: Option<String>,
) -> OpResult {
    OpResult::err("POSIX permissions/ownership are not available on this platform")
}

/// Actual on-disk allocation for a path (block count × 512), which can differ from
/// the logical size (sparse files, filesystem block rounding). POSIX-only; returns
/// the logical size as a fallback elsewhere.
#[cfg(unix)]
pub fn get_size_on_disk(path: &str) -> u64 {
    use std::os::unix::fs::MetadataExt;
    match fs::symlink_metadata(path) {
        Ok(meta) => meta.blocks() * 512,
        Err(_) => 0,
    }
}

#[cfg(not(unix))]
pub fn get_size_on_disk(path: &str) -> u64 {
    fs::symlink_metadata(path).map(|m| m.len()).unwrap_or(0)
}

#[cfg(test)]
mod copy_tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn copy_file_preserves_modified_time() {
        let test_dir =
            std::env::temp_dir().join(format!("nexuscommander-vfs-copy-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&test_dir).unwrap();
        let src = test_dir.join("source.jpg");
        let dst = test_dir.join("destination.jpg");

        fs::File::create(&src).unwrap().write_all(b"photo").unwrap();
        let expected = filetime::FileTime::from_unix_time(1_714_666_620, 0);
        filetime::set_file_mtime(&src, expected).unwrap();

        let result = copy_file(&src.to_string_lossy(), &dst.to_string_lossy());
        assert!(result.success, "{}", result.message);
        assert_eq!(
            filetime::FileTime::from_last_modification_time(&dst.metadata().unwrap()),
            expected
        );

        fs::remove_dir_all(test_dir).unwrap();
    }
}

/// P0.6 regression tests (QSF-001, QSF-002).
///
/// The pair that matters: an existing destination must survive byte-for-byte,
/// and the ordinary "destination does not exist yet" case must keep working.
/// The second half is what stops the stopgap from being a silent feature
/// removal.
#[cfg(test)]
mod transactional_replacement_tests {
    use super::*;

    fn test_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nexuscommander-p06-{}-{}",
            name,
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn copy_onto_existing_file_replaces_it_through_a_staged_commit() {
        // P0.6 refused this outright. P1.5 performs it: staged beside the
        // destination, verified, then published by rename, so the old contents
        // are only gone once the new ones are complete.
        let dir = test_dir("copy-existing");
        let src = dir.join("new.txt");
        let dst = dir.join("precious.txt");
        fs::write(&src, b"replacement").unwrap();
        fs::write(&dst, b"THE ONLY COPY").unwrap();

        let result = copy_file(&src.to_string_lossy(), &dst.to_string_lossy());

        assert!(result.success, "{}", result.message);
        assert_eq!(fs::read(&dst).unwrap(), b"replacement");
        assert!(
            !fs::read_dir(&dir)
                .unwrap()
                .filter_map(|e| e.ok())
                .any(|e| e.file_name().to_string_lossy().starts_with(".nc-staging-")),
            "the staging file must be gone after a successful commit"
        );

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn copy_to_free_destination_still_succeeds() {
        let dir = test_dir("copy-free");
        let src = dir.join("new.txt");
        let dst = dir.join("free.txt");
        fs::write(&src, b"payload").unwrap();

        let result = copy_file(&src.to_string_lossy(), &dst.to_string_lossy());

        assert!(result.success, "{}", result.message);
        assert_eq!(fs::read(&dst).unwrap(), b"payload");

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn move_onto_existing_file_replaces_it_and_consumes_the_source() {
        // move_entries derives the destination name from the source, so the
        // collision is set up by putting a file of that name in the target dir.
        let source_dir = test_dir("move-existing-src");
        let target_dir = test_dir("move-existing-dst");
        let src = source_dir.join("report.txt");
        let collide = target_dir.join("report.txt");
        fs::write(&src, b"source contents").unwrap();
        fs::write(&collide, b"ALREADY HERE").unwrap();

        let results = move_entries(
            &[src.to_string_lossy().to_string()],
            &target_dir.to_string_lossy(),
        );

        // P1.5: rename(2) replaces the destination atomically, so there is never
        // a moment when neither version exists. QSF-002 was the *queued* move
        // deleting the destination first, which is what P0.6 refused.
        assert!(results[0].success, "{}", results[0].message);
        assert_eq!(fs::read(&collide).unwrap(), b"source contents");
        assert!(!src.exists(), "the source must be consumed by a move");

        fs::remove_dir_all(source_dir).unwrap();
        fs::remove_dir_all(target_dir).unwrap();
    }

    #[test]
    fn move_to_free_destination_still_succeeds() {
        let dir = test_dir("move-free");
        let target = test_dir("move-free-target");
        let src = dir.join("moving.txt");
        fs::write(&src, b"in transit").unwrap();

        let results = move_entries(
            &[src.to_string_lossy().to_string()],
            &target.to_string_lossy(),
        );

        assert!(results[0].success, "{}", results[0].message);
        assert_eq!(fs::read(target.join("moving.txt")).unwrap(), b"in transit");
        assert!(
            !src.exists(),
            "source should be gone after a successful move"
        );

        fs::remove_dir_all(dir).unwrap();
        fs::remove_dir_all(target).unwrap();
    }

    /// Merging a tree into an existing directory must keep working — only a
    /// colliding *file* is refused. Otherwise the stopgap would block the
    /// ordinary "copy these into that folder" case entirely.
    #[test]
    fn directory_merge_replaces_a_colliding_child_and_spares_its_siblings() {
        let dir = test_dir("merge");
        let src_tree = dir.join("tree");
        let dst_tree = dir.join("existing-tree");
        fs::create_dir_all(&src_tree).unwrap();
        fs::create_dir_all(&dst_tree).unwrap();
        fs::write(src_tree.join("fresh.txt"), b"fresh").unwrap();
        fs::write(dst_tree.join("unrelated.txt"), b"untouched").unwrap();

        let ok = copy_file(&src_tree.to_string_lossy(), &dst_tree.to_string_lossy());
        assert!(
            ok.success,
            "merging into an existing directory: {}",
            ok.message
        );
        assert_eq!(fs::read(dst_tree.join("fresh.txt")).unwrap(), b"fresh");
        assert_eq!(
            fs::read(dst_tree.join("unrelated.txt")).unwrap(),
            b"untouched"
        );

        // Now the same copy collides on fresh.txt. P0.6 refused the whole
        // operation; P1.5 replaces just that entry, per file, which is the
        // journaled tree model from section 6.1 — a tree has no atomic commit,
        // so each entry gets its own.
        fs::write(src_tree.join("fresh.txt"), b"second version").unwrap();
        let replaced = copy_file(&src_tree.to_string_lossy(), &dst_tree.to_string_lossy());
        assert!(replaced.success, "{}", replaced.message);
        assert_eq!(
            fs::read(dst_tree.join("fresh.txt")).unwrap(),
            b"second version"
        );
        assert_eq!(
            fs::read(dst_tree.join("unrelated.txt")).unwrap(),
            b"untouched",
            "replacing one child must not disturb the rest of the directory"
        );

        fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(test)]
mod cross_device_move_tests {
    use super::*;

    /// Cut-and-paste of a *folder* to another filesystem. `rename` cannot do it,
    /// so `move_entries` falls back to a tree copy plus a source removal. Before
    /// that fallback existed the whole operation just failed, which is the
    /// clipboard half of the same gap the task queue had.
    ///
    /// Needs two filesystems; skipped when only one is available.
    #[test]
    fn move_entries_moves_a_folder_across_filesystems() {
        let Some(other) = other_fs_dir() else {
            eprintln!("skipped: no second filesystem available");
            return;
        };
        let src_root = std::env::temp_dir().join(format!(
            "nc_xdev_move_src_{}_{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let folder = src_root.join("payload");
        fs::create_dir_all(folder.join("nested")).unwrap();
        fs::write(folder.join("nested/a.txt"), b"contents").unwrap();

        let results = move_entries(
            &[folder.to_string_lossy().to_string()],
            &other.to_string_lossy(),
        );

        assert_eq!(results.len(), 1);
        assert!(
            results[0].success,
            "a folder move across filesystems must succeed: {}",
            results[0].message
        );
        assert_eq!(
            fs::read(other.join("payload/nested/a.txt")).unwrap(),
            b"contents",
            "the tree must arrive intact"
        );
        assert!(
            !folder.exists(),
            "the source must be released once the copy has committed"
        );

        let _ = fs::remove_dir_all(&src_root);
        let _ = fs::remove_dir_all(&other);
    }

    /// A folder move within one filesystem stays a plain rename — the fallback
    /// must not take over a case that `rename` already handles.
    #[test]
    fn move_entries_moves_a_folder_within_one_filesystem() {
        let root = std::env::temp_dir().join(format!(
            "nc_samefs_move_{}_{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let folder = root.join("payload");
        fs::create_dir_all(folder.join("nested")).unwrap();
        fs::write(folder.join("nested/a.txt"), b"contents").unwrap();
        let dest = root.join("dest");
        fs::create_dir_all(&dest).unwrap();

        let results = move_entries(
            &[folder.to_string_lossy().to_string()],
            &dest.to_string_lossy(),
        );

        assert!(results[0].success, "{}", results[0].message);
        assert_eq!(
            fs::read(dest.join("payload/nested/a.txt")).unwrap(),
            b"contents"
        );
        assert!(!folder.exists());

        let _ = fs::remove_dir_all(&root);
    }

    /// Pasting a folder onto an existing folder of the same name merges, matching
    /// the queued move and the web backend. Before this, `rename` failed with
    /// ENOTEMPTY and the paste reported an error for a case the UI presents as
    /// ordinary.
    #[test]
    fn move_entries_merges_a_folder_into_an_existing_folder() {
        let root = std::env::temp_dir().join(format!(
            "nc_paste_merge_{}_{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let src = root.join("left/shared");
        fs::create_dir_all(src.join("nested")).unwrap();
        fs::write(src.join("from_source.txt"), b"source").unwrap();
        fs::write(src.join("nested/deep.txt"), b"deep").unwrap();

        let dest_parent = root.join("right");
        let existing = dest_parent.join("shared");
        fs::create_dir_all(&existing).unwrap();
        fs::write(existing.join("already_here.txt"), b"existing").unwrap();

        let results = move_entries(
            &[src.to_string_lossy().to_string()],
            &dest_parent.to_string_lossy(),
        );

        assert!(results[0].success, "{}", results[0].message);
        assert_eq!(
            fs::read(existing.join("already_here.txt")).unwrap(),
            b"existing",
            "a merge must not delete what was already in the destination"
        );
        assert_eq!(
            fs::read(existing.join("from_source.txt")).unwrap(),
            b"source"
        );
        assert_eq!(fs::read(existing.join("nested/deep.txt")).unwrap(), b"deep");
        assert!(!src.exists(), "the source must be released after the merge");

        let _ = fs::remove_dir_all(&root);
    }

    fn other_fs_dir() -> Option<std::path::PathBuf> {
        let base = std::env::var_os("NC_TEST_OTHER_FS")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from("/dev/shm"));
        if !base.is_dir() {
            return None;
        }
        if device_of(&base)? == device_of(&std::env::temp_dir())? {
            return None;
        }
        let dir = base.join(format!(
            "nc_xdev_dst_{}_{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).ok().map(|_| dir)
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

    #[test]
    fn test_collect_drives_queries_disk_space_in_parallel() {
        let start = std::time::Instant::now();
        let drives = collect_drives();
        let elapsed = start.elapsed();
        assert!(!drives.is_empty(), "drives should not be empty");
        println!(
            "collect_drives took {:?} for {} drives",
            elapsed,
            drives.len()
        );
        let root = drives.iter().find(|d| d.path == "/");
        if let Some(r) = root {
            assert!(r.total_space > 0, "root total space should be > 0");
            assert!(r.available_space > 0, "root available space should be > 0");
        }
        for d in &drives {
            if d.drive_type == "Network" {
                println!(
                    "Network drive {} at {}: total={}, avail={}",
                    d.name, d.path, d.total_space, d.available_space
                );
                if std::path::Path::new(&d.path).exists() {
                    assert!(
                        d.total_space > 0,
                        "accessible network drive {} should have total_space > 0",
                        d.name
                    );
                    assert!(
                        d.available_space > 0,
                        "accessible network drive {} should have available_space > 0",
                        d.name
                    );
                }
            }
        }
    }
}
