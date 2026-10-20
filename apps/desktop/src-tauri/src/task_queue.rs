use crate::engine::job::{JobState, Permit, Scheduler};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};

/// Status of a background task.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum TaskStatus {
    Queued,
    Running,
    Paused,
    Completed,
    Failed,
    Cancelled,
    WaitingForInput,
}

/// Conflict resolution strategy.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub enum ConflictResolution {
    Overwrite,
    Skip,
    OverwriteAll,
    SkipAll,
    /// P1.6. Copy alongside the existing entry under a free name
    /// (`report (2).pdf`) instead of choosing between them. The option users
    /// actually want most of the time, and the only one that cannot lose data.
    KeepBoth,
    KeepBothAll,
}

impl ConflictResolution {
    /// Whether this decision applies to the whole task rather than one entry.
    fn is_global(self) -> bool {
        matches!(
            self,
            ConflictResolution::OverwriteAll
                | ConflictResolution::SkipAll
                | ConflictResolution::KeepBothAll
        )
    }

    fn is_skip(self) -> bool {
        matches!(self, ConflictResolution::Skip | ConflictResolution::SkipAll)
    }

    fn is_keep_both(self) -> bool {
        matches!(
            self,
            ConflictResolution::KeepBoth | ConflictResolution::KeepBothAll
        )
    }
}

/// Why a task failed, in a form the UI can explain and act on.
///
/// `error` alone was a raw English string — "Failed to delete … (trash: false):
/// Permission denied (os error 13)" — that the frontend could only print. The
/// kind lets it say what happened in the user's language and offer the one
/// thing that helps (elevation for `PermissionDenied`); `error` stays as the
/// technical detail.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TaskErrorKind {
    PermissionDenied,
    NotFound,
    NoSpace,
    ReadOnly,
    Busy,
    /// A move copied the data but could not release the source: both copies
    /// exist. Not data loss, but not the move the user asked for either.
    SourceRetained,
    Other,
}

impl TaskErrorKind {
    pub fn from_io(e: &std::io::Error) -> Self {
        use std::io::ErrorKind as K;
        match e.kind() {
            K::PermissionDenied => Self::PermissionDenied,
            K::NotFound => Self::NotFound,
            K::StorageFull | K::QuotaExceeded => Self::NoSpace,
            K::ReadOnlyFilesystem => Self::ReadOnly,
            K::ResourceBusy | K::ExecutableFileBusy => Self::Busy,
            _ => Self::Other,
        }
    }

    /// Copy and move report their failures as strings by the time they reach
    /// the queue. `io::Error`'s Display ends in "(os error N)", and mapping N
    /// back through `from_raw_os_error` keeps the platform's own errno table
    /// (13 on Linux, 5 on Windows) rather than a hand-written one.
    pub fn from_message(msg: &str) -> Self {
        msg.rfind("(os error ")
            .and_then(|i| msg[i + "(os error ".len()..].split(')').next())
            .and_then(|code| code.parse::<i32>().ok())
            .map(|code| Self::from_io(&std::io::Error::from_raw_os_error(code)))
            .unwrap_or(Self::Other)
    }

    fn from_trash(e: &trash::Error, path: &Path) -> Self {
        match e {
            #[cfg(all(
                unix,
                not(target_os = "macos"),
                not(target_os = "ios"),
                not(target_os = "android")
            ))]
            trash::Error::FileSystem { source, .. } => Self::from_io(source),
            trash::Error::Os { code, .. } => {
                Self::from_io(&std::io::Error::from_raw_os_error(*code))
            }
            // "does not exist or insufficient permissions" — tell them apart.
            trash::Error::CouldNotAccess { .. } if path.symlink_metadata().is_err() => {
                Self::NotFound
            }
            trash::Error::CouldNotAccess { .. } => Self::PermissionDenied,
            _ => Self::Other,
        }
    }
}

/// Type of file operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum TaskType {
    Copy,
    Move,
    Delete,
}

/// A single background task.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub task_type: TaskType,
    pub status: TaskStatus,
    pub sources: Vec<String>,
    pub target: String,
    pub total_bytes: u64,
    pub transferred_bytes: u64,
    pub total_files: u32,
    pub processed_files: u32,
    pub current_file: String,
    pub current_file_bytes: u64,
    pub current_file_total_bytes: u64,
    pub speed_bytes_per_sec: f64,
    pub eta_seconds: u64,
    #[serde(skip)]
    pub start_time: Option<std::time::Instant>,
    pub pending_conflict: Option<String>,
    pub conflict_is_dir: bool,
    pub global_resolution: Option<ConflictResolution>,
    pub current_resolution: Option<ConflictResolution>,
    pub error: Option<String>,
    pub error_kind: Option<TaskErrorKind>,
    /// The path the failure is about — not always a source: a delete refused
    /// up front names the directory that blocks it.
    pub error_path: Option<String>,
    #[serde(skip)]
    pub finished_at: Option<std::time::Instant>,
}

/// `TaskStatus` is the wire format; `JobState` owns the transition rules.
///
/// P1.3 keeps `TaskInfo` byte-identical on the wire, so the queue still stores
/// `TaskStatus` and borrows the state machine rather than being rewritten around
/// `JobRecord`. P1.6 collapses the two.
fn job_state(status: &TaskStatus) -> JobState {
    match status {
        TaskStatus::Queued => JobState::Queued,
        TaskStatus::Running => JobState::Running,
        TaskStatus::Paused => JobState::Paused,
        TaskStatus::WaitingForInput => JobState::WaitingForDecision,
        TaskStatus::Completed => JobState::Completed,
        TaskStatus::Failed => JobState::Failed,
        TaskStatus::Cancelled => JobState::Cancelled,
    }
}

impl Task {
    /// Move to `next` only if the state machine allows it.
    ///
    /// Returns whether the move happened. Before P1.3 every transition was a
    /// bare assignment, so a stale handle could write `Running` over
    /// `Cancelled` — which is how a cancelled task got a second worker.
    fn transition_to(&mut self, next: TaskStatus) -> bool {
        if !job_state(&self.status).can_transition_to(job_state(&next)) {
            return false;
        }
        self.status = next;
        true
    }

    /// Whether the job has been asked to stop. Checked inside every I/O loop.
    fn is_cancelled(&self) -> bool {
        self.status == TaskStatus::Cancelled
    }

    fn fail(&mut self, kind: TaskErrorKind, path: Option<String>, detail: impl Into<String>) {
        self.transition_to(TaskStatus::Failed);
        self.error_kind = Some(kind);
        self.error_path = path;
        self.error = Some(detail.into());
    }
}

/// Find the first directory that would stop a permanent delete of `path`
/// part-way through.
///
/// `remove_dir_all` deletes depth-first and stops at the first entry it cannot
/// unlink. On a folder whose *parent* is not writable that is the folder
/// itself — after its entire contents are already gone. Checking every
/// directory involved before touching anything turns the common permission
/// failure into "nothing was deleted" instead of "everything but the folder
/// was". Best effort only: ACLs, immutable flags, root-squashing network
/// mounts and races can still fail later, which the caller reports as usual.
#[cfg(unix)]
fn removal_blocker(path: &Path) -> Option<(std::path::PathBuf, std::io::Error)> {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;

    fn writable(dir: &Path) -> Result<(), std::io::Error> {
        let c = std::ffi::CString::new(dir.as_os_str().as_bytes())
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;
        // SAFETY: `c` is a valid NUL-terminated string for the whole call.
        if unsafe { libc::access(c.as_ptr(), libc::W_OK | libc::X_OK) } == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }

    // In a sticky directory (/tmp) write access is not enough: only the
    // owner of the entry or of the directory may unlink it.
    fn sticky_denies(dir: &Path, entry: &Path) -> bool {
        let (Ok(d), Ok(e)) = (fs::metadata(dir), entry.symlink_metadata()) else {
            return false;
        };
        let euid = unsafe { libc::geteuid() };
        d.mode() & 0o1000 != 0 && euid != 0 && e.uid() != euid && d.uid() != euid
    }

    fn walk(dir: &Path) -> Option<(std::path::PathBuf, std::io::Error)> {
        if let Err(e) = writable(dir) {
            return Some((dir.to_path_buf(), e));
        }
        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(e) => return Some((dir.to_path_buf(), e)),
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if sticky_denies(dir, &p) {
                return Some((
                    p,
                    std::io::Error::from(std::io::ErrorKind::PermissionDenied),
                ));
            }
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                if let Some(blocker) = walk(&p) {
                    return Some(blocker);
                }
            }
        }
        None
    }

    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        if let Err(e) = writable(parent) {
            return Some((parent.to_path_buf(), e));
        }
        if sticky_denies(parent, path) {
            return Some((
                path.to_path_buf(),
                std::io::Error::from(std::io::ErrorKind::PermissionDenied),
            ));
        }
    }
    if path.symlink_metadata().map(|m| m.is_dir()).unwrap_or(false) {
        return walk(path);
    }
    None
}

#[cfg(not(unix))]
fn removal_blocker(_path: &Path) -> Option<(std::path::PathBuf, std::io::Error)> {
    None
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

/// The global task queue manager.
#[derive(Clone)]
pub struct TaskQueueManager {
    tasks: Arc<Mutex<HashMap<String, Task>>>,
    /// P1.3. Dedicated blocking threads with a hard cap, plus a separate bound
    /// on how many jobs touch the filesystem at once. Replaces
    /// `tauri::async_runtime::spawn`, which parked a tokio worker for the whole
    /// duration of every copy.
    scheduler: Scheduler,
}

impl Default for TaskQueueManager {
    fn default() -> Self {
        Self::new()
    }
}

impl TaskQueueManager {
    pub fn new() -> Self {
        TaskQueueManager {
            tasks: Arc::new(Mutex::new(HashMap::new())),
            scheduler: Scheduler::default(),
        }
    }

    /// A manager with an explicit scheduler. Tests use it to make the bounds
    /// small enough to observe.
    pub fn with_scheduler(scheduler: Scheduler) -> Self {
        TaskQueueManager {
            tasks: Arc::new(Mutex::new(HashMap::new())),
            scheduler,
        }
    }

    pub fn scheduler(&self) -> &Scheduler {
        &self.scheduler
    }

    /// Create a new task and add it to the queue.
    pub fn create_task(&self, task_type: TaskType, sources: Vec<String>, target: String) -> String {
        // Delete encodes its mode in `target`. Only the exact word "permanent"
        // is the unrecoverable one: everything else — "", a typo, a caller
        // that forgot the argument — used to be read as "not trash" and so as
        // permanent. The web backend already normalised the same way.
        let target = match task_type {
            TaskType::Delete if target == "permanent" => target,
            TaskType::Delete => "trash".to_string(),
            _ => target,
        };
        let id = uuid::Uuid::new_v4().to_string();
        let total_bytes = sources.iter().map(|s| calculate_total_size(s)).sum();
        let total_files = sources.iter().map(|s| count_files(s)).sum();

        let task = Task {
            id: id.clone(),
            task_type,
            status: TaskStatus::Queued,
            sources,
            target,
            total_bytes,
            transferred_bytes: 0,
            total_files,
            processed_files: 0,
            current_file: String::new(),
            current_file_bytes: 0,
            current_file_total_bytes: 0,
            speed_bytes_per_sec: 0.0,
            eta_seconds: 0,
            start_time: None,
            pending_conflict: None,
            conflict_is_dir: false,
            global_resolution: None,
            current_resolution: None,
            error: None,
            error_kind: None,
            error_path: None,
            finished_at: None,
        };

        let mut tasks = self.tasks.lock().unwrap();
        prune_tasks(&mut tasks);
        tasks.insert(id.clone(), task);
        id
    }

    /// Execute a task asynchronously. Idempotent: if the task is already
    /// running or waiting on conflict input, this returns the current state
    /// instead of spawning a second worker for the same task.
    pub fn execute_task(&self, task_id: &str) -> Task {
        let task_data = {
            let mut tasks = self.tasks.lock().unwrap();
            prune_tasks(&mut tasks);
            let Some(task) = tasks.get_mut(task_id) else {
                return Task {
                    id: task_id.to_string(),
                    task_type: TaskType::Copy,
                    status: TaskStatus::Failed,
                    sources: vec![],
                    target: String::new(),
                    total_bytes: 0,
                    transferred_bytes: 0,
                    total_files: 0,
                    processed_files: 0,
                    current_file: String::new(),
                    current_file_bytes: 0,
                    current_file_total_bytes: 0,
                    speed_bytes_per_sec: 0.0,
                    eta_seconds: 0,
                    start_time: None,
                    pending_conflict: None,
                    conflict_is_dir: false,
                    global_resolution: None,
                    current_resolution: None,
                    error: Some("Task not found".to_string()),
                    error_kind: Some(TaskErrorKind::NotFound),
                    error_path: None,
                    finished_at: None,
                };
            };

            // One runner per job. Two separate questions, and conflating them
            // is what the old single check got wrong:
            //
            // 1. Does this job already have a worker? Then a second would race
            //    it. `holds_a_worker()` covers Running, WaitingForInput *and*
            //    Paused — the old check named only the first two, so a paused
            //    task got a second worker while the first still sat in the
            //    pause loop.
            // 2. Is the transition legal at all? `transition_to` refuses the
            //    terminal states, so a cancelled task can no longer re-enter
            //    Running, which the old check also allowed.
            //
            // Note that WaitingForInput -> Running *is* a legal transition: it
            // is how the conflict wait resumes. It just is not something an
            // external execute_task may do.
            if job_state(&task.status).holds_a_worker() {
                return task.clone();
            }
            if !task.transition_to(TaskStatus::Running) {
                return task.clone();
            }
            task.start_time = Some(std::time::Instant::now());
            task.clone()
        };

        let mgr = self.clone();
        let t = task_data.clone();

        // Dedicated blocking thread, not the async runtime: these are
        // synchronous fs loops containing thread::sleep.
        if let Err(e) = self.scheduler.spawn(&task_data.id, move |permit| {
            match t.task_type {
                TaskType::Copy => mgr.execute_copy(&t, permit),
                TaskType::Move => mgr.execute_move(&t, permit),
                TaskType::Delete => mgr.execute_delete(&t, permit),
            };
        }) {
            // At capacity. The user has to be told their operation did not
            // start; dropping it silently is QSF-017.
            let mut tasks = self.tasks.lock().unwrap();
            if let Some(task) = tasks.get_mut(task_id) {
                task.fail(TaskErrorKind::Other, None, e.to_string());
                return task.clone();
            }
        }

        task_data
    }

    /// Copy one file through the commit engine, reporting progress and
    /// honouring cancellation.
    ///
    /// P1.5. The previous implementation opened the destination with
    /// `File::create`, which truncates: the window between "destination emptied"
    /// and "replacement written" was as wide as the file was large, and
    /// cancelling mid-copy is a first-class feature here rather than an edge
    /// case. It is now staged beside the destination and published by rename, so
    /// cancelling — or a read error, or a full disk — leaves the original whole.
    fn copy_file_chunked(
        &self,
        src: &Path,
        dst: &Path,
        task_id: &str,
        permit: &mut Permit,
        mut processed: u32,
        mut transferred: u64,
    ) -> Result<(u32, u64), String> {
        let src_len = src.metadata().map(|m| m.len()).unwrap_or(0);
        {
            let mut tasks = self.tasks.lock().unwrap();
            if let Some(t) = tasks.get_mut(task_id) {
                t.current_file_total_bytes = src_len;
                t.current_file_bytes = 0;
                t.current_file = src
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
            }
        }

        let mut file_transferred = 0u64;
        let spec = crate::engine::spec::OperationSpec::new(
            crate::engine::spec::OperationKind::Copy,
            Vec::new(),
            None,
        );

        let result = crate::engine::commit::copy_file_staged(
            &crate::engine::path_policy::PathPolicy::new(spec.symlinks),
            src,
            dst,
            spec.verification,
            spec.metadata,
            crate::engine::commit::Replace::IfFile,
            &mut |chunk| {
                // Pause and cancel are checked between chunks, exactly as before.
                loop {
                    let status = {
                        let tasks = self.tasks.lock().unwrap();
                        tasks.get(task_id).map(|t| t.status.clone())
                    };
                    match status {
                        Some(TaskStatus::Cancelled) => {
                            return Err(crate::engine::commit::CommitError::Cancelled)
                        }
                        Some(TaskStatus::Paused) => {
                            // A paused job is not doing I/O, so it must not hold
                            // a share of the filesystem budget while it waits.
                            permit.park();
                            std::thread::sleep(std::time::Duration::from_millis(100));
                            permit.unpark();
                            continue;
                        }
                        _ => break,
                    }
                }

                transferred += chunk;
                file_transferred += chunk;

                let mut tasks = self.tasks.lock().unwrap();
                if let Some(t) = tasks.get_mut(task_id) {
                    t.transferred_bytes = transferred;
                    t.current_file_bytes = file_transferred;
                    if let Some(start) = t.start_time {
                        let elapsed = start.elapsed().as_secs_f64();
                        if elapsed > 0.1 {
                            let speed = transferred as f64 / elapsed;
                            t.speed_bytes_per_sec = speed;
                            if speed > 100.0 {
                                let remaining = t.total_bytes.saturating_sub(transferred);
                                t.eta_seconds = (remaining as f64 / speed) as u64;
                            }
                        }
                    }
                }
                Ok(())
            },
        );

        match result {
            Ok(_) => {}
            Err(crate::engine::commit::CommitError::Cancelled) => return Err("Cancelled".into()),
            Err(e) => return Err(e.to_string()),
        }

        processed += 1;
        {
            let mut tasks = self.tasks.lock().unwrap();
            if let Some(t) = tasks.get_mut(task_id) {
                t.processed_files = processed;
            }
        }
        Ok((processed, transferred))
    }

    fn copy_dir_recursive_chunked(
        &self,
        src: &Path,
        dst: &Path,
        task_id: &str,
        permit: &mut Permit,
        mut processed: u32,
        mut transferred: u64,
    ) -> Result<(u32, u64), String> {
        let src_canon = canonicalize_path(src);
        let dst_canon = canonicalize_path(dst);
        if dst_canon == src_canon || dst_canon.starts_with(&src_canon) {
            return Err("Cannot copy directory into itself or its subdirectory".into());
        }

        fs::create_dir_all(dst).map_err(|e| format!("mkdir: {}", e))?;
        let entries = fs::read_dir(src).map_err(|e| format!("readdir: {}", e))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("entry: {}", e))?;
            let src_child = entry.path();
            let dst_child = dst.join(entry.file_name());

            // Check cancellation inside directory sweep
            {
                let mut tasks = self.tasks.lock().unwrap();
                if let Some(t) = tasks.get_mut(task_id) {
                    if t.status == TaskStatus::Cancelled {
                        return Err("Cancelled".into());
                    }
                    t.current_file = entry.file_name().to_string_lossy().to_string();
                }
            }

            if src_child.is_dir() {
                let (p, t) = self.copy_dir_recursive_chunked(
                    &src_child,
                    &dst_child,
                    task_id,
                    permit,
                    processed,
                    transferred,
                )?;
                processed = p;
                transferred = t;
            } else {
                let (p, t) = self.copy_file_chunked(
                    &src_child,
                    &dst_child,
                    task_id,
                    permit,
                    processed,
                    transferred,
                )?;
                processed = p;
                transferred = t;
            }
        }
        crate::vfs::preserve_modified_time(src, dst)
            .map_err(|e| format!("preserve directory modification time: {}", e))?;
        Ok((processed, transferred))
    }

    fn execute_copy(&self, task: &Task, permit: &mut Permit) -> Task {
        let target_path = Path::new(&task.target);
        let mut processed = 0u32;
        let mut transferred = 0u64;

        for source in &task.sources {
            let src_path = Path::new(source);
            let file_name = src_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();

            {
                let mut tasks = self.tasks.lock().unwrap();
                if let Some(t) = tasks.get_mut(&task.id) {
                    if t.status == TaskStatus::Cancelled {
                        return t.clone();
                    }
                    t.current_file = file_name.clone();
                }
            }

            let mut dst = target_path.join(&file_name);

            // Conflict Resolution
            if dst.exists() {
                let is_directory = dst.is_dir();
                let mut resolution = None;
                {
                    let mut tasks = self.tasks.lock().unwrap();
                    if let Some(t) = tasks.get_mut(&task.id) {
                        if let Some(res) = t.global_resolution {
                            resolution = Some(res);
                        } else {
                            t.transition_to(TaskStatus::WaitingForInput);
                            t.pending_conflict = Some(file_name.clone());
                            t.conflict_is_dir = is_directory;
                        }
                    }
                }

                if resolution.is_none() {
                    // Give the filesystem permit back while the dialog is open.
                    // Holding it would let one job waiting on a decision own a
                    // share of the I/O budget for as long as the user takes to
                    // answer, and enough of those would deadlock the queue.
                    permit.park();
                    loop {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                        let mut tasks = self.tasks.lock().unwrap();
                        if let Some(t) = tasks.get_mut(&task.id) {
                            if t.is_cancelled() {
                                return t.clone();
                            }
                            if let Some(res) = t.current_resolution.take() {
                                resolution = Some(res);
                                t.transition_to(TaskStatus::Running);
                                t.pending_conflict = None;
                                break;
                            }
                            if let Some(res) = t.global_resolution {
                                resolution = Some(res);
                                t.transition_to(TaskStatus::Running);
                                t.pending_conflict = None;
                                break;
                            }
                        } else {
                            break;
                        }
                    }
                    // Wait for room on the filesystem before resuming.
                    permit.unpark();
                }

                if resolution.map(|r| r.is_skip()).unwrap_or(false) {
                    let size = calculate_total_size(source);
                    transferred += size;
                    processed += 1;
                    let mut tasks = self.tasks.lock().unwrap();
                    if let Some(t) = tasks.get_mut(&task.id) {
                        t.transferred_bytes = transferred;
                        t.processed_files = processed;
                    }
                    continue;
                }
                if resolution.map(|r| r.is_keep_both()).unwrap_or(false) {
                    // Retarget to a free name instead of replacing anything.
                    match free_destination_name(target_path, &file_name) {
                        Ok(free) => dst = target_path.join(free),
                        Err(e) => {
                            let mut tasks = self.tasks.lock().unwrap();
                            if let Some(t) = tasks.get_mut(&task.id) {
                                t.fail(
                                    TaskErrorKind::from_message(&e),
                                    Some(task.target.clone()),
                                    e,
                                );
                                return t.clone();
                            }
                            return task.clone();
                        }
                    }
                }
            }

            let res = if src_path.is_dir() {
                self.copy_dir_recursive_chunked(
                    src_path,
                    &dst,
                    &task.id,
                    permit,
                    processed,
                    transferred,
                )
            } else {
                self.copy_file_chunked(src_path, &dst, &task.id, permit, processed, transferred)
            };

            match res {
                Ok((p, t)) => {
                    processed = p;
                    transferred = t;
                }
                Err(e) => {
                    let mut tasks = self.tasks.lock().unwrap();
                    if let Some(t) = tasks.get_mut(&task.id) {
                        if e == "Cancelled" {
                            t.transition_to(TaskStatus::Cancelled);
                        } else {
                            t.fail(
                                TaskErrorKind::from_message(&e),
                                Some(source.clone()),
                                format!("Failed to copy {}: {}", source, e),
                            );
                        }
                        return t.clone();
                    }
                }
            }
        }

        let mut tasks = self.tasks.lock().unwrap();
        if let Some(t) = tasks.get_mut(&task.id) {
            t.transition_to(TaskStatus::Completed);
            return t.clone();
        }
        task.clone()
    }

    fn execute_move(&self, task: &Task, permit: &mut Permit) -> Task {
        let target_path = Path::new(&task.target);
        let mut processed = 0u32;
        let mut transferred = 0u64;

        for source in &task.sources {
            let src_path = Path::new(source);
            let file_name = src_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();

            {
                let mut tasks = self.tasks.lock().unwrap();
                if let Some(t) = tasks.get_mut(&task.id) {
                    if t.status == TaskStatus::Cancelled {
                        return t.clone();
                    }
                    t.current_file = file_name.clone();
                }
            }

            let mut dst = target_path.join(&file_name);

            // Conflict Resolution
            if dst.exists() {
                let is_directory = dst.is_dir();
                let mut resolution = None;
                {
                    let mut tasks = self.tasks.lock().unwrap();
                    if let Some(t) = tasks.get_mut(&task.id) {
                        if let Some(res) = t.global_resolution {
                            resolution = Some(res);
                        } else {
                            t.transition_to(TaskStatus::WaitingForInput);
                            t.pending_conflict = Some(file_name.clone());
                            t.conflict_is_dir = is_directory;
                        }
                    }
                }

                if resolution.is_none() {
                    // Give the filesystem permit back while the dialog is open.
                    // Holding it would let one job waiting on a decision own a
                    // share of the I/O budget for as long as the user takes to
                    // answer, and enough of those would deadlock the queue.
                    permit.park();
                    loop {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                        let mut tasks = self.tasks.lock().unwrap();
                        if let Some(t) = tasks.get_mut(&task.id) {
                            if t.is_cancelled() {
                                return t.clone();
                            }
                            if let Some(res) = t.current_resolution.take() {
                                resolution = Some(res);
                                t.transition_to(TaskStatus::Running);
                                t.pending_conflict = None;
                                break;
                            }
                            if let Some(res) = t.global_resolution {
                                resolution = Some(res);
                                t.transition_to(TaskStatus::Running);
                                t.pending_conflict = None;
                                break;
                            }
                        } else {
                            break;
                        }
                    }
                    // Wait for room on the filesystem before resuming.
                    permit.unpark();
                }

                if resolution.map(|r| r.is_skip()).unwrap_or(false) {
                    let size = calculate_total_size(source);
                    transferred += size;
                    processed += 1;
                    let mut tasks = self.tasks.lock().unwrap();
                    if let Some(t) = tasks.get_mut(&task.id) {
                        t.transferred_bytes = transferred;
                        t.processed_files = processed;
                    }
                    continue;
                }
                if resolution.map(|r| r.is_keep_both()).unwrap_or(false) {
                    match free_destination_name(target_path, &file_name) {
                        Ok(free) => dst = target_path.join(free),
                        Err(e) => {
                            let mut tasks = self.tasks.lock().unwrap();
                            if let Some(t) = tasks.get_mut(&task.id) {
                                t.fail(
                                    TaskErrorKind::from_message(&e),
                                    Some(task.target.clone()),
                                    e,
                                );
                                return t.clone();
                            }
                            return task.clone();
                        }
                    }
                }
                // Overwrite / OverwriteAll: proceed. P1.5 made this safe.
                // QSF-002 was that this path deleted the destination outright
                // and only then attempted the rename, so if both the rename and
                // the copy fallback failed the user had lost the destination for
                // nothing. The rename below replaces atomically, and the
                // cross-filesystem fallback stages the copy and releases the
                // source only after it commits.
            }

            // Merging a folder into an existing folder of the same name cannot be
            // a rename: `rename` fails with ENOTEMPTY rather than combining two
            // trees. The conflict dialog offers "Merge" for a directory (and it
            // is the primary button), and the web backend merges per file, so
            // the desktop queue has to do the same or that button does nothing.
            // Routing it to the journaled tree copy merges entry by entry —
            // which is exactly what the fallback below already does.
            let needs_tree_merge = src_path.is_dir() && dst.is_dir();

            // P1.7: through the engine. Same filesystem is one atomic rename;
            // cross-filesystem stages the copy and releases the source only after
            // the commit lands (QSF-002). A cross-device *directory* move comes
            // back as CrossDeviceDirectory so the journaled tree copy below can
            // take over — nothing has been destroyed at that point.
            let spec = crate::engine::spec::OperationSpec::new(
                crate::engine::spec::OperationKind::Move,
                Vec::new(),
                None,
            );
            let engine_result = if needs_tree_merge {
                Err(crate::engine::commit::CommitError::CrossDeviceDirectory {
                    src: src_path.to_path_buf(),
                    dst: dst.clone(),
                })
            } else {
                crate::engine::commit::move_entry_staged(
                    &crate::engine::path_policy::PathPolicy::new(spec.symlinks),
                    src_path,
                    &dst,
                    spec.verification,
                    spec.metadata,
                    crate::engine::commit::Replace::IfFile,
                    &mut |_| {
                        let cancelled = {
                            let tasks = self.tasks.lock().unwrap();
                            tasks
                                .get(&task.id)
                                .map(|t| t.is_cancelled())
                                .unwrap_or(false)
                        };
                        if cancelled {
                            return Err(crate::engine::commit::CommitError::Cancelled);
                        }
                        Ok(())
                    },
                )
            };

            match engine_result {
                Ok(kind) => {
                    let size = calculate_total_size(source);
                    let files = count_files(source);
                    transferred += size;
                    processed += files;
                    let retained = match kind {
                        crate::engine::commit::MoveKind::CopiedSourceRetained {
                            ref reason,
                            ..
                        } => Some(reason.clone()),
                        _ => None,
                    };
                    let mut tasks = self.tasks.lock().unwrap();
                    if let Some(t) = tasks.get_mut(&task.id) {
                        t.processed_files = processed;
                        t.transferred_bytes = transferred;
                        if let Some(reason) = retained {
                            // The copy committed but the source could not be
                            // released. Not success: it looks like a finished move
                            // until the user notices the original is still there.
                            t.fail(
                                TaskErrorKind::SourceRetained,
                                Some(source.clone()),
                                format!(
                                    "Copied '{}' to '{}', but could not remove the original: {}. \
                                     Both copies still exist.",
                                    source,
                                    dst.display(),
                                    reason
                                ),
                            );
                            return t.clone();
                        }
                    }
                }
                Err(crate::engine::commit::CommitError::Cancelled) => {
                    let mut tasks = self.tasks.lock().unwrap();
                    if let Some(t) = tasks.get_mut(&task.id) {
                        t.transition_to(TaskStatus::Cancelled);
                        return t.clone();
                    }
                }
                Err(crate::engine::commit::CommitError::CrossDeviceDirectory { .. }) => {
                    // Journaled tree copy, then release the source.
                    let res = self.copy_dir_recursive_chunked(
                        src_path,
                        &dst,
                        &task.id,
                        permit,
                        processed,
                        transferred,
                    );
                    match res {
                        Ok((p, t)) => {
                            processed = p;
                            transferred = t;
                            if let Err(e) = fs::remove_dir_all(src_path) {
                                let mut tasks = self.tasks.lock().unwrap();
                                if let Some(t) = tasks.get_mut(&task.id) {
                                    t.fail(
                                        TaskErrorKind::SourceRetained,
                                        Some(source.clone()),
                                        format!(
                                            "Copied '{}' successfully, but could not remove the \
                                             original: {}. Both copies still exist.",
                                            source, e
                                        ),
                                    );
                                    return t.clone();
                                }
                            }
                        }
                        Err(e) => {
                            let mut tasks = self.tasks.lock().unwrap();
                            if let Some(t) = tasks.get_mut(&task.id) {
                                if e == "Cancelled" {
                                    t.transition_to(TaskStatus::Cancelled);
                                } else {
                                    t.fail(
                                        TaskErrorKind::from_message(&e),
                                        Some(source.clone()),
                                        format!("Failed to move {}: {}", source, e),
                                    );
                                }
                                return t.clone();
                            }
                        }
                    }
                }
                Err(e) => {
                    let mut tasks = self.tasks.lock().unwrap();
                    if let Some(t) = tasks.get_mut(&task.id) {
                        let detail = format!("Failed to move {}: {}", source, e);
                        t.fail(
                            TaskErrorKind::from_message(&detail),
                            Some(source.clone()),
                            detail,
                        );
                        return t.clone();
                    }
                }
            }
        }

        let mut tasks = self.tasks.lock().unwrap();
        if let Some(t) = tasks.get_mut(&task.id) {
            t.transition_to(TaskStatus::Completed);
            return t.clone();
        }
        task.clone()
    }

    /// Delete has no conflict dialog and no pause loop, so it never parks —
    /// it holds its permit for its whole (short) duration.
    fn execute_delete(&self, task: &Task, _permit: &mut Permit) -> Task {
        let mut processed = 0u32;
        let is_trash = task.target != "permanent";

        for source in &task.sources {
            let src_path = Path::new(source);

            {
                let mut tasks = self.tasks.lock().unwrap();
                if let Some(t) = tasks.get_mut(&task.id) {
                    if t.status == TaskStatus::Cancelled {
                        return t.clone();
                    }
                    t.current_file = source.clone();
                }
            }

            // Measured before the delete: afterwards there is nothing left to
            // count, which is why a finished delete used to report 0 files.
            let files = count_files(source);
            let bytes = calculate_total_size(source);

            let result: Result<(), (TaskErrorKind, String, String)> = if is_trash {
                trash::delete(src_path).map_err(|e| {
                    (
                        TaskErrorKind::from_trash(&e, src_path),
                        source.clone(),
                        e.to_string(),
                    )
                })
            } else if let Some((blocker, e)) = removal_blocker(src_path) {
                Err((
                    TaskErrorKind::from_io(&e),
                    blocker.to_string_lossy().into_owned(),
                    e.to_string(),
                ))
            } else {
                let removed = if src_path.is_dir() {
                    fs::remove_dir_all(src_path)
                } else {
                    fs::remove_file(src_path)
                };
                removed.map_err(|e| (TaskErrorKind::from_io(&e), source.clone(), e.to_string()))
            };

            if let Err((kind, path, detail)) = result {
                let mut tasks = self.tasks.lock().unwrap();
                if let Some(t) = tasks.get_mut(&task.id) {
                    t.fail(kind, Some(path), detail);
                    return t.clone();
                }
            }

            processed += files;
            {
                let mut tasks = self.tasks.lock().unwrap();
                if let Some(t) = tasks.get_mut(&task.id) {
                    t.processed_files = processed;
                    t.transferred_bytes += bytes;
                }
            }
        }

        let mut tasks = self.tasks.lock().unwrap();
        if let Some(t) = tasks.get_mut(&task.id) {
            t.transition_to(TaskStatus::Completed);
            return t.clone();
        }
        task.clone()
    }

    /// Get a task by ID.
    pub fn get_task(&self, task_id: &str) -> Option<Task> {
        let tasks = self.tasks.lock().unwrap();
        tasks.get(task_id).cloned()
    }

    /// Get all tasks.
    pub fn get_all_tasks(&self) -> Vec<Task> {
        let mut tasks = self.tasks.lock().unwrap();
        prune_tasks(&mut tasks);
        tasks.values().cloned().collect()
    }

    /// Resolve a conflict for a task.
    pub fn resolve_conflict(&self, task_id: &str, resolution: &str) -> bool {
        let mut tasks = self.tasks.lock().unwrap();
        if let Some(task) = tasks.get_mut(task_id) {
            let res = match resolution {
                "overwrite" => ConflictResolution::Overwrite,
                "skip" => ConflictResolution::Skip,
                "overwrite_all" => ConflictResolution::OverwriteAll,
                "skip_all" => ConflictResolution::SkipAll,
                "keep_both" => ConflictResolution::KeepBoth,
                "keep_both_all" => ConflictResolution::KeepBothAll,
                // An unknown resolution is refused rather than defaulting to
                // anything: guessing here would pick a destructive action for the
                // user on the strength of a typo.
                _ => return false,
            };

            if res.is_global() {
                task.global_resolution = Some(res);
            } else {
                task.current_resolution = Some(res);
            }
            return true;
        }
        false
    }

    /// Pause a task.
    pub fn pause_task(&self, task_id: &str) -> bool {
        let mut tasks = self.tasks.lock().unwrap();
        if let Some(task) = tasks.get_mut(task_id) {
            return task.transition_to(TaskStatus::Paused);
        }
        false
    }

    /// Resume a task.
    pub fn resume_task(&self, task_id: &str) -> bool {
        let mut tasks = self.tasks.lock().unwrap();
        if let Some(task) = tasks.get_mut(task_id) {
            return task.transition_to(TaskStatus::Running);
        }
        false
    }

    /// Cancel a task.
    pub fn cancel_task(&self, task_id: &str) -> bool {
        let mut tasks = self.tasks.lock().unwrap();
        if let Some(task) = tasks.get_mut(task_id) {
            return task.transition_to(TaskStatus::Cancelled);
        }
        false
    }

    /// Remove completed/failed/cancelled tasks from the list.
    /// Drop tasks the user no longer needs to see.
    ///
    /// Two statuses are deliberately retained beyond the obviously-live ones:
    ///
    /// - `Failed`, because the task record is the only place its `error` lives.
    ///   The UI clears as soon as anything finishes, so dropping failures here
    ///   destroyed the explanation before it could be rendered — which is what
    ///   made a failed operation look like it had done nothing at all.
    /// - `WaitingForInput`, because its worker is still alive in the conflict
    ///   wait loop. Removing that record orphans the worker (QSF-010).
    ///
    /// Failed tasks are not retained forever: `prune_tasks` drops them on the
    /// finished-task TTL and the `MAX_TRACKED_TASKS` cap, so this cannot grow
    /// without bound.
    ///
    /// `include_failed` is the user's own "Clear finished". Retaining failures
    /// there too meant the button did nothing for the one task it was shown
    /// on, and the panel — kept open by any failed task — could not be
    /// dismissed for an hour.
    pub fn clear_finished_tasks(&self, include_failed: bool) {
        let mut tasks = self.tasks.lock().unwrap();
        tasks.retain(|_, t| {
            t.status == TaskStatus::Queued
                || t.status == TaskStatus::Running
                || t.status == TaskStatus::Paused
                || t.status == TaskStatus::WaitingForInput
                || (t.status == TaskStatus::Failed && !include_failed)
        });
    }
}

// Helpers

/// Hard cap on tracked tasks and how long a finished task is kept around,
/// so repeated copy/move/delete operations can't grow the task map (and the
/// path/error strings it retains) without bound over a long-running session.
const MAX_TRACKED_TASKS: usize = 500;
const FINISHED_TASK_TTL: std::time::Duration = std::time::Duration::from_secs(3600);

fn is_finished_status(status: &TaskStatus) -> bool {
    matches!(
        status,
        TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled
    )
}

/// Bound the task map: stamp newly-finished tasks with a completion time,
/// drop finished tasks past the TTL, and if still over the cap evict the
/// oldest finished tasks first. Active (queued/running/waiting) tasks are
/// never evicted.
fn prune_tasks(tasks: &mut HashMap<String, Task>) {
    let now = std::time::Instant::now();

    for t in tasks.values_mut() {
        if is_finished_status(&t.status) {
            if t.finished_at.is_none() {
                t.finished_at = Some(now);
            }
        } else {
            t.finished_at = None;
        }
    }

    tasks.retain(|_, t| {
        !is_finished_status(&t.status)
            || t.finished_at
                .map(|f| now.duration_since(f) < FINISHED_TASK_TTL)
                .unwrap_or(true)
    });

    if tasks.len() > MAX_TRACKED_TASKS {
        let mut finished: Vec<(String, std::time::Instant)> = tasks
            .iter()
            .filter(|(_, t)| is_finished_status(&t.status))
            .map(|(id, t)| (id.clone(), t.finished_at.unwrap_or(now)))
            .collect();
        finished.sort_by_key(|(_, finished_at)| *finished_at);

        let overflow = tasks.len() - MAX_TRACKED_TASKS;
        for (id, _) in finished.into_iter().take(overflow) {
            tasks.remove(&id);
        }
    }
}

/// A free name in `dir` for `file_name`, for the keep-both resolution.
fn free_destination_name(dir: &Path, file_name: &str) -> Result<std::ffi::OsString, String> {
    let handle = crate::engine::path_policy::PathPolicy::default()
        .open_dir(dir)
        .map_err(|e| e.to_string())?;
    crate::engine::commit::keep_both_name(&handle, std::ffi::OsStr::new(file_name))
        .map_err(|e| e.to_string())
}

fn calculate_total_size(path: &str) -> u64 {
    let p = Path::new(path);
    if p.is_file() {
        p.metadata().map(|m| m.len()).unwrap_or(0)
    } else if p.is_dir() {
        dir_size(p)
    } else {
        0
    }
}

fn dir_size(path: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            if let Ok(file_type) = entry.file_type() {
                if file_type.is_symlink() {
                    if let Ok(md) = fs::symlink_metadata(entry.path()) {
                        total += md.len();
                    }
                } else if file_type.is_dir() {
                    total += dir_size(&entry.path());
                } else {
                    if let Ok(md) = entry.metadata() {
                        total += md.len();
                    }
                }
            }
        }
    }
    total
}

fn count_files(path: &str) -> u32 {
    let p = Path::new(path);
    if p.is_file() {
        1
    } else if p.is_dir() {
        count_files_recursive(p)
    } else {
        0
    }
}

fn count_files_recursive(path: &Path) -> u32 {
    let mut count = 0u32;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            if let Ok(file_type) = entry.file_type() {
                if file_type.is_symlink() {
                    count += 1;
                } else if file_type.is_dir() {
                    count += count_files_recursive(&entry.path());
                } else {
                    count += 1;
                }
            }
        }
    }
    count
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    use std::io::Write;

    fn make_task(status: TaskStatus, finished_at: Option<std::time::Instant>) -> Task {
        Task {
            id: uuid::Uuid::new_v4().to_string(),
            task_type: TaskType::Copy,
            status,
            sources: vec![],
            target: String::new(),
            total_bytes: 0,
            transferred_bytes: 0,
            total_files: 0,
            processed_files: 0,
            current_file: String::new(),
            current_file_bytes: 0,
            current_file_total_bytes: 0,
            speed_bytes_per_sec: 0.0,
            eta_seconds: 0,
            start_time: None,
            pending_conflict: None,
            conflict_is_dir: false,
            global_resolution: None,
            current_resolution: None,
            error: None,
            error_kind: None,
            error_path: None,
            finished_at,
        }
    }

    #[test]
    fn prune_removes_expired_finished_tasks() {
        let mut tasks = HashMap::new();
        let old = make_task(
            TaskStatus::Completed,
            Some(std::time::Instant::now() - FINISHED_TASK_TTL - std::time::Duration::from_secs(1)),
        );
        let fresh = make_task(TaskStatus::Completed, Some(std::time::Instant::now()));
        let running = make_task(TaskStatus::Running, None);

        tasks.insert(old.id.clone(), old.clone());
        tasks.insert(fresh.id.clone(), fresh.clone());
        tasks.insert(running.id.clone(), running.clone());

        prune_tasks(&mut tasks);

        assert!(
            !tasks.contains_key(&old.id),
            "expired finished task must be pruned"
        );
        assert!(
            tasks.contains_key(&fresh.id),
            "fresh finished task must survive"
        );
        assert!(
            tasks.contains_key(&running.id),
            "active task must never be pruned by TTL"
        );
    }

    #[test]
    fn prune_never_evicts_active_tasks_even_over_cap() {
        let mut tasks = HashMap::new();
        for _ in 0..(MAX_TRACKED_TASKS + 50) {
            let t = make_task(TaskStatus::Running, None);
            tasks.insert(t.id.clone(), t);
        }

        prune_tasks(&mut tasks);

        assert_eq!(
            tasks.len(),
            MAX_TRACKED_TASKS + 50,
            "active tasks are never evicted by the cap"
        );
    }

    #[test]
    fn prune_evicts_oldest_finished_tasks_first_over_cap() {
        let mut tasks = HashMap::new();
        let now = std::time::Instant::now();

        // One very old finished task that should be evicted first.
        let oldest = make_task(
            TaskStatus::Completed,
            Some(now - std::time::Duration::from_secs(10)),
        );
        tasks.insert(oldest.id.clone(), oldest.clone());

        // Fill up to (and past) the cap with newer finished tasks.
        for i in 0..(MAX_TRACKED_TASKS + 10) {
            let t = make_task(
                TaskStatus::Completed,
                Some(now - std::time::Duration::from_millis(i as u64)),
            );
            tasks.insert(t.id.clone(), t);
        }

        prune_tasks(&mut tasks);

        assert!(tasks.len() <= MAX_TRACKED_TASKS);
        assert!(
            !tasks.contains_key(&oldest.id),
            "oldest finished task should be evicted first"
        );
    }

    #[test]
    fn execute_task_does_not_restart_an_already_running_task() {
        let mgr = TaskQueueManager::new();
        let id = mgr.create_task(TaskType::Copy, vec![], "/tmp".to_string());

        // Simulate a task that is already actively running in a worker,
        // without letting a real (instantly-completing, empty-sources)
        // worker race with this test.
        let marker_start = std::time::Instant::now();
        {
            let mut tasks = mgr.tasks.lock().unwrap();
            let t = tasks.get_mut(&id).unwrap();
            t.status = TaskStatus::Running;
            t.start_time = Some(marker_start);
        }

        let result = mgr.execute_task(&id);
        assert_eq!(result.status, TaskStatus::Running);
        assert_eq!(
            result.start_time,
            Some(marker_start),
            "must not reset start_time or spawn a duplicate worker for an already-running task"
        );
    }

    #[test]
    fn execute_task_does_not_restart_a_paused_task() {
        // P1.3. The pre-P1.3 guard listed Running and WaitingForInput only, so a
        // Paused task fell through, was set back to Running, and got a second
        // worker while the first was still sitting in the pause loop — two
        // workers writing the same destination.
        //
        // Constructed directly rather than by pausing a live copy: making a real
        // task sit in Paused long enough to observe would be a race.
        let mgr = TaskQueueManager::new();
        let id = mgr.create_task(TaskType::Copy, vec![], "/tmp".to_string());
        let marker = std::time::Instant::now();
        {
            let mut tasks = mgr.tasks.lock().unwrap();
            let t = tasks.get_mut(&id).unwrap();
            t.status = TaskStatus::Paused;
            t.start_time = Some(marker);
        }

        let result = mgr.execute_task(&id);
        assert_eq!(
            result.status,
            TaskStatus::Paused,
            "a paused task already owns a worker; execute must be a no-op"
        );
        assert_eq!(result.start_time, Some(marker));
    }

    #[test]
    fn execute_task_does_not_restart_a_terminal_task() {
        // The other pre-P1.3 hole: nothing refused Cancelled -> Running.
        for terminal in [
            TaskStatus::Cancelled,
            TaskStatus::Completed,
            TaskStatus::Failed,
        ] {
            let mgr = TaskQueueManager::new();
            let id = mgr.create_task(TaskType::Copy, vec![], "/tmp".to_string());
            {
                let mut tasks = mgr.tasks.lock().unwrap();
                tasks.get_mut(&id).unwrap().status = terminal.clone();
            }

            let result = mgr.execute_task(&id);
            assert_eq!(
                result.status, terminal,
                "{:?} must not be restartable",
                terminal
            );
        }
    }

    #[test]
    fn cancel_accepts_every_cancellable_status() {
        let mgr = TaskQueueManager::new();

        for status in [
            TaskStatus::Queued,
            TaskStatus::Running,
            TaskStatus::Paused,
            TaskStatus::WaitingForInput,
        ] {
            let task = make_task(status, None);
            let id = task.id.clone();
            mgr.tasks.lock().unwrap().insert(id.clone(), task);

            assert!(mgr.cancel_task(&id));
            assert_eq!(mgr.get_task(&id).unwrap().status, TaskStatus::Cancelled);
        }
    }

    #[test]
    fn chunked_copy_preserves_modified_time() {
        let test_dir =
            std::env::temp_dir().join(format!("nexuscommander-task-copy-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&test_dir).unwrap();
        let src = test_dir.join("source.jpg");
        let dst = test_dir.join("destination.jpg");
        fs::File::create(&src).unwrap().write_all(b"photo").unwrap();
        let expected = filetime::FileTime::from_unix_time(1_714_666_622, 0);
        filetime::set_file_mtime(&src, expected).unwrap();

        let mgr = TaskQueueManager::new();
        let id = mgr.create_task(TaskType::Copy, vec![], test_dir.to_string_lossy().into());
        let mut permit = mgr.scheduler().permits().acquire();
        mgr.copy_file_chunked(&src, &dst, &id, &mut permit, 0, 0)
            .unwrap();

        assert_eq!(
            filetime::FileTime::from_last_modification_time(&dst.metadata().unwrap()),
            expected
        );
        fs::remove_dir_all(test_dir).unwrap();
    }
}

#[cfg(test)]
mod directory_move_tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "nc_dirmove_{}_{}_{}",
            name,
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn run_to_completion(mgr: &TaskQueueManager, id: &str) -> Task {
        mgr.execute_task(id);
        for _ in 0..600 {
            let t = mgr.get_task(id).expect("task must exist");
            if matches!(
                t.status,
                TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled
            ) {
                return t;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        panic!("task {} never finished", id);
    }

    /// Moving a folder into a panel that already has a folder of that name is the
    /// "Merge" the conflict dialog offers. `rename` cannot do it (ENOTEMPTY), so
    /// before this was routed to the tree copy the primary button did nothing at
    /// all. The merge must add the source's files *without* removing what was
    /// already in the destination.
    #[test]
    fn moving_a_folder_onto_an_existing_folder_merges_instead_of_failing() {
        let root = scratch("merge");
        let src = root.join("left/shared");
        fs::create_dir_all(src.join("nested")).unwrap();
        fs::write(src.join("from_source.txt"), b"source").unwrap();
        fs::write(src.join("nested/deep.txt"), b"deep").unwrap();

        let dest_parent = root.join("right");
        let existing = dest_parent.join("shared");
        fs::create_dir_all(&existing).unwrap();
        fs::write(existing.join("already_here.txt"), b"existing").unwrap();

        let mgr = TaskQueueManager::new();
        let id = mgr.create_task(
            TaskType::Move,
            vec![src.to_string_lossy().to_string()],
            dest_parent.to_string_lossy().to_string(),
        );
        // Answer the conflict dialog the way the primary button does.
        mgr.resolve_conflict(&id, "overwrite_all");
        let task = run_to_completion(&mgr, &id);

        assert_eq!(
            task.status,
            TaskStatus::Completed,
            "merge must succeed, error was: {:?}",
            task.error
        );
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
        assert!(
            !src.exists(),
            "the source folder must be released after the merge"
        );

        let _ = fs::remove_dir_all(&root);
    }

    /// The ordinary case, and the one the merge routing must not disturb: a
    /// folder moved to a panel with no name collision is a plain rename.
    #[test]
    fn moving_a_folder_to_a_free_name_still_succeeds() {
        let root = scratch("free");
        let src = root.join("left/payload");
        fs::create_dir_all(src.join("nested")).unwrap();
        fs::write(src.join("nested/a.txt"), b"contents").unwrap();
        let dest_parent = root.join("right");
        fs::create_dir_all(&dest_parent).unwrap();

        let mgr = TaskQueueManager::new();
        let id = mgr.create_task(
            TaskType::Move,
            vec![src.to_string_lossy().to_string()],
            dest_parent.to_string_lossy().to_string(),
        );
        let task = run_to_completion(&mgr, &id);

        assert_eq!(
            task.status,
            TaskStatus::Completed,
            "error: {:?}",
            task.error
        );
        assert_eq!(
            fs::read(dest_parent.join("payload/nested/a.txt")).unwrap(),
            b"contents"
        );
        assert!(!src.exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn error_kind_is_read_from_the_os_error_code() {
        assert_eq!(
            TaskErrorKind::from_message("Failed to copy /x: Permission denied (os error 13)"),
            TaskErrorKind::PermissionDenied
        );
        assert_eq!(
            TaskErrorKind::from_message("No such file or directory (os error 2)"),
            TaskErrorKind::NotFound
        );
        assert_eq!(
            TaskErrorKind::from_message("Cannot copy directory into itself"),
            TaskErrorKind::Other
        );
    }

    /// A permanent delete of a folder whose parent is not writable used to run
    /// `remove_dir_all` anyway: every file inside was gone before the folder
    /// itself failed with EACCES. It must now refuse before touching anything,
    /// and name the directory that blocks it.
    #[cfg(unix)]
    #[test]
    fn permanent_delete_blocked_by_parent_deletes_nothing() {
        use std::os::unix::fs::PermissionsExt;
        if unsafe { libc::geteuid() } == 0 {
            return; // root ignores the mode bits this test relies on
        }
        let root = scratch("locked_parent");
        let parent = root.join("locked");
        let victim = parent.join("folder");
        fs::create_dir_all(victim.join("nested")).unwrap();
        fs::write(victim.join("nested/a.txt"), b"keep me").unwrap();
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o555)).unwrap();

        let mgr = TaskQueueManager::new();
        let id = mgr.create_task(
            TaskType::Delete,
            vec![victim.to_string_lossy().to_string()],
            "permanent".into(),
        );
        let task = run_to_completion(&mgr, &id);

        fs::set_permissions(&parent, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(task.status, TaskStatus::Failed);
        assert_eq!(task.error_kind, Some(TaskErrorKind::PermissionDenied));
        assert_eq!(
            task.error_path.as_deref(),
            Some(parent.to_string_lossy().as_ref())
        );
        assert_eq!(
            fs::read(victim.join("nested/a.txt")).unwrap(),
            b"keep me",
            "the contents must survive a delete that cannot finish"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn permanent_delete_reports_what_it_removed() {
        let root = scratch("delete_counts");
        let victim = root.join("folder");
        fs::create_dir_all(&victim).unwrap();
        fs::write(victim.join("a.txt"), b"12345").unwrap();
        fs::write(victim.join("b.txt"), b"678").unwrap();

        let mgr = TaskQueueManager::new();
        let id = mgr.create_task(
            TaskType::Delete,
            vec![victim.to_string_lossy().to_string()],
            "permanent".into(),
        );
        let task = run_to_completion(&mgr, &id);

        assert_eq!(
            task.status,
            TaskStatus::Completed,
            "error: {:?}",
            task.error
        );
        assert!(!victim.exists());
        assert_eq!(task.processed_files, 2);
        assert_eq!(task.transferred_bytes, 8);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_delete_with_an_unknown_mode_goes_to_the_trash() {
        let mgr = TaskQueueManager::new();
        for target in ["", "Permanent", "nonsense"] {
            let id = mgr.create_task(TaskType::Delete, vec!["/nonexistent".into()], target.into());
            assert_eq!(mgr.get_task(&id).unwrap().target, "trash", "{target:?}");
        }
        let id = mgr.create_task(
            TaskType::Delete,
            vec!["/nonexistent".into()],
            "permanent".into(),
        );
        assert_eq!(mgr.get_task(&id).unwrap().target, "permanent");
    }

    #[test]
    fn clearing_with_include_failed_dismisses_a_failed_task() {
        let root = scratch("clear_failed");
        let missing = root.join("does-not-exist");
        let mgr = TaskQueueManager::new();
        let id = mgr.create_task(
            TaskType::Copy,
            vec![missing.to_string_lossy().to_string()],
            root.to_string_lossy().to_string(),
        );
        assert_eq!(run_to_completion(&mgr, &id).status, TaskStatus::Failed);

        mgr.clear_finished_tasks(false);
        assert!(
            mgr.get_task(&id).is_some(),
            "the automatic sweep keeps failures"
        );
        mgr.clear_finished_tasks(true);
        assert!(
            mgr.get_task(&id).is_none(),
            "the user's clear dismisses them"
        );

        let _ = fs::remove_dir_all(&root);
    }
}
