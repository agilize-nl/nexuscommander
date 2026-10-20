// The offenders are in archive.rs: pack_archive, emit_progress and the unpack
// helpers take 9-13 positional arguments each, threading destination, sources,
// compression level, symlink policy, AppHandle, timing, counters and a cancel
// flag through every layer by hand. (The five per-format pack writers that
// used to lead this list now share one `PackWalk`.)
//
// Clippy is right, and the fix is not a signature tweak: QSF-022/P3.4 replaces
// this with the OperationSpec/JobRecord types, which is exactly the parameter
// object clippy is asking for. Silencing it repo-wide until then keeps the rest
// of the lint set enforceable instead of leaving clippy off entirely. Remove
// this attribute when P3.4 lands — it should then fail on its own.
#![allow(clippy::too_many_arguments)]

// The mutation modules are `pub` so `tests/characterization.rs` can drive them
// (P0.7). An integration test is a separate crate, so it can only reach the
// public surface — which is the point: the suite binds to the same entry points
// the Tauri commands call, and therefore survives the Phase 1 rewrite of the
// internals instead of having to be rewritten along with them.
pub mod archive;
mod bookmarks;
pub mod engine;
mod help;
mod network;
mod open_with;
mod search;
mod settings;
pub mod task_queue;
mod terminal;
pub mod vfs;
mod viewer;

use crate::archive::ArchiveState;
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use task_queue::{Task, TaskQueueManager, TaskType};
use tauri::{Manager, State};
use vfs::{FileEntry, OpResult, PathInfo};
use viewer::ViewerContent;

fn theme_startup_color(theme: &str) -> tauri::utils::config::Color {
    match theme {
        "dracula" => tauri::utils::config::Color(33, 34, 44, 255),
        "solarized-dark" => tauri::utils::config::Color(0, 33, 43, 255),
        "gruvbox" => tauri::utils::config::Color(29, 32, 33, 255),
        "ocean" => tauri::utils::config::Color(15, 17, 26, 255),
        "nortonly" => tauri::utils::config::Color(0, 56, 112, 255),
        "github-light" => tauri::utils::config::Color(246, 248, 250, 255),
        "solarized-light" => tauri::utils::config::Color(253, 246, 227, 255),
        "gruvbox-light" => tauri::utils::config::Color(251, 241, 199, 255),
        "catppuccin-latte" | "arctic-light" => tauri::utils::config::Color(255, 255, 255, 255),
        _ => tauri::utils::config::Color(10, 14, 23, 255),
    }
}

fn native_window_theme(theme: &str) -> tauri::Theme {
    match theme {
        "github-light" | "solarized-light" | "gruvbox-light" | "catppuccin-latte"
        | "arctic-light" => tauri::Theme::Light,
        _ => tauri::Theme::Dark,
    }
}

#[derive(Debug, Deserialize)]
pub struct PackOptions {
    pub format: String,
    pub compression_level: u32,
    pub solid_archive: bool,
    pub follow_links: bool,
}

// ===== VFS Commands =====

#[tauri::command]
async fn read_directory(path: String) -> Result<Vec<FileEntry>, String> {
    let path_clone = path.clone();
    match tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tauri::async_runtime::spawn_blocking(move || vfs::read_directory(&path_clone)),
    )
    .await
    {
        Ok(res) => res.map_err(|e| format!("Task execution error: {}", e))?,
        Err(_) => Err(format!(
            "Timeout reading directory '{}': target unreachable",
            path
        )),
    }
}

#[tauri::command]
fn get_home_dir() -> String {
    vfs::get_home_dir()
}

#[tauri::command]
fn get_parent_dir(path: String) -> String {
    vfs::get_parent_dir(&path)
}

#[tauri::command]
async fn get_path_info(path: String) -> PathInfo {
    let fallback = PathInfo {
        exists: false,
        is_dir: false,
        canonical: path.clone(),
    };
    let path_clone = path.clone();
    match tokio::time::timeout(
        std::time::Duration::from_millis(1500),
        tauri::async_runtime::spawn_blocking(move || vfs::get_path_info(&path_clone)),
    )
    .await
    {
        Ok(Ok(info)) => info,
        _ => fallback,
    }
}

// ===== File properties (permissions / ownership / size-on-disk) =====
// Back the shared FilePropertiesDialog on desktop. Writing perms/ownership needs
// root; the process is elevated via restart_as_root (pkexec) beforehand.

#[tauri::command]
async fn get_users_groups() -> vfs::UsersGroups {
    tauri::async_runtime::spawn_blocking(vfs::get_users_groups)
        .await
        .unwrap_or_else(|_| vfs::UsersGroups {
            users: vec![],
            groups: vec![],
            current_user: None,
            current_group: None,
        })
}

#[tauri::command]
async fn set_file_properties(
    path: String,
    permissions: Option<String>,
    owner: Option<String>,
    group: Option<String>,
) -> OpResult {
    let target = path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        vfs::set_file_properties(&path, permissions, owner, group)
    })
    .await
    .unwrap_or_else(|e| OpResult::err(&format!("{}: {}", target, e)))
}

#[tauri::command]
async fn get_size_on_disk(path: String) -> u64 {
    let path_clone = path.clone();
    match tokio::time::timeout(
        std::time::Duration::from_millis(2000),
        tauri::async_runtime::spawn_blocking(move || vfs::get_size_on_disk(&path_clone)),
    )
    .await
    {
        Ok(Ok(size)) => size,
        _ => 0,
    }
}

// ===== CRUD Commands =====

#[tauri::command]
async fn create_directory(path: String) -> OpResult {
    let target = path.clone();
    tauri::async_runtime::spawn_blocking(move || vfs::create_directory(&path))
        .await
        .unwrap_or_else(|e| OpResult::err(&format!("{}: {}", target, e)))
}

#[tauri::command]
async fn delete_entry(path: String, recursive: bool, mode: vfs::DeleteMode) -> OpResult {
    let target = path.clone();
    tauri::async_runtime::spawn_blocking(move || vfs::delete_entry(&path, recursive, mode))
        .await
        .unwrap_or_else(|e| OpResult::err(&format!("{}: {}", target, e)))
}

#[tauri::command]
async fn delete_entries(
    paths: Vec<String>,
    recursive: bool,
    mode: vfs::DeleteMode,
) -> Vec<OpResult> {
    tauri::async_runtime::spawn_blocking(move || vfs::delete_entries(&paths, recursive, mode))
        .await
        .unwrap_or_else(|e| vec![OpResult::err(&e.to_string())])
}

#[tauri::command]
async fn rename_entry(from: String, to: String) -> OpResult {
    let target = from.clone();
    tauri::async_runtime::spawn_blocking(move || vfs::rename_entry(&from, &to))
        .await
        .unwrap_or_else(|e| OpResult::err(&format!("{}: {}", target, e)))
}

#[tauri::command]
async fn batch_rename(renames: Vec<(String, String)>) -> Vec<OpResult> {
    tauri::async_runtime::spawn_blocking(move || vfs::batch_rename(renames))
        .await
        .unwrap_or_else(|e| vec![OpResult::err(&e.to_string())])
}

#[tauri::command]
async fn copy_file(src: String, dst: String) -> OpResult {
    let target = src.clone();
    tauri::async_runtime::spawn_blocking(move || vfs::copy_file(&src, &dst))
        .await
        .unwrap_or_else(|e| OpResult::err(&format!("{}: {}", target, e)))
}

#[tauri::command]
async fn copy_entries(sources: Vec<String>, target_dir: String) -> Vec<OpResult> {
    tauri::async_runtime::spawn_blocking(move || vfs::copy_entries(&sources, &target_dir))
        .await
        .unwrap_or_else(|e| vec![OpResult::err(&e.to_string())])
}

#[tauri::command]
async fn move_entries(sources: Vec<String>, target_dir: String) -> Vec<OpResult> {
    tauri::async_runtime::spawn_blocking(move || vfs::move_entries(&sources, &target_dir))
        .await
        .unwrap_or_else(|e| vec![OpResult::err(&e.to_string())])
}

#[tauri::command]
async fn save_text_file(path: String, text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || vfs::save_text_file(&path, &text))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn calculate_dir_size(path: String) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || vfs::calculate_dir_size(&path))
        .await
        .map_err(|e| format!("Task execution error: {}", e))?
}

// ===== Archive Commands =====

#[tauri::command]
fn is_archive(path: String) -> bool {
    archive::is_archive(&path)
}

#[tauri::command]
async fn read_archive(path: String) -> Result<Vec<FileEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || archive::read_archive(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn archive_pack(
    app: tauri::AppHandle,
    state: State<'_, ArchiveState>,
    sources: Vec<String>,
    dest_path: String,
    options: Option<PackOptions>,
) -> Result<(), String> {
    let opts = options.unwrap_or(PackOptions {
        format: "zip".to_string(),
        compression_level: 6,
        solid_archive: false,
        follow_links: false,
    });

    let started_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let (total_files, total_bytes) = archive::count_pack_items(&sources);
    let cancel_flag = state.0.clone();
    cancel_flag.store(false, Ordering::SeqCst);

    tauri::async_runtime::spawn_blocking(move || {
        archive::pack_archive(
            &sources,
            &dest_path,
            &opts.format,
            opts.compression_level,
            opts.follow_links,
            Some(&app),
            started_at,
            total_files,
            total_bytes,
            cancel_flag,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn archive_cancel_pack(state: State<'_, ArchiveState>) {
    state.0.store(true, Ordering::SeqCst);
}

#[tauri::command]
async fn archive_unpack(
    app: tauri::AppHandle,
    src_path: String,
    dest_dir: String,
    entries: Option<Vec<String>>,
    conflict: Option<archive::ExtractConflict>,
) -> Result<archive::UnpackReport, String> {
    // Absent policy means `Skip`: a caller that has not been taught to ask about
    // conflicts must not get the answer that overwrites.
    let conflict = conflict.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        archive::unpack_archive(
            &src_path,
            &dest_dir,
            entries.as_deref(),
            conflict,
            Some(&app),
        )
    })
    .await
    .map_err(|e| format!("Extraction task error: {}", e))?
}

#[tauri::command]
fn get_archive_capabilities() -> Vec<archive::ArchiveFormatCapability> {
    archive::get_archive_capabilities()
}

#[tauri::command]
async fn archive_test(path: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || archive::test_archive(&path))
        .await
        .map_err(|e| format!("Archive test task error: {}", e))?
}

#[tauri::command]
async fn split_file(
    path: String,
    chunk_size: u64,
    dest_dir: String,
) -> Result<vfs::OpResult, String> {
    tauri::async_runtime::spawn_blocking(move || archive::split_file(&path, chunk_size, &dest_dir))
        .await
        .map_err(|e| format!("Split file task error: {}", e))?
}

#[tauri::command]
async fn combine_files(sources: Vec<String>, dest_path: String) -> Result<vfs::OpResult, String> {
    tauri::async_runtime::spawn_blocking(move || archive::combine_files(&sources, &dest_path))
        .await
        .map_err(|e| format!("Combine files task error: {}", e))?
}

// ===== Viewer Commands =====

#[tauri::command]
async fn read_file_for_viewer(
    path: String,
    encoding: Option<String>,
) -> Result<ViewerContent, String> {
    tauri::async_runtime::spawn_blocking(move || {
        viewer::read_file_for_viewer(&path, encoding.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ===== Task Queue Commands =====

struct TaskQueueState(TaskQueueManager);

#[tauri::command]
fn task_create(
    state: State<'_, TaskQueueState>,
    task_type: String,
    sources: Vec<String>,
    target: String,
) -> Result<String, String> {
    let tt = match task_type.as_str() {
        "copy" => TaskType::Copy,
        "move" => TaskType::Move,
        "delete" => TaskType::Delete,
        other => return Err(format!("Unknown task type: {}", other)),
    };
    let mgr = &state.0;
    Ok(mgr.create_task(tt, sources, target))
}

#[tauri::command]
fn task_execute(state: State<'_, TaskQueueState>, task_id: String) -> Task {
    let mgr = &state.0;
    mgr.execute_task(&task_id)
}

#[tauri::command]
fn task_get(state: State<'_, TaskQueueState>, task_id: String) -> Option<Task> {
    let mgr = &state.0;
    mgr.get_task(&task_id)
}

#[tauri::command]
fn task_list(state: State<'_, TaskQueueState>) -> Vec<Task> {
    let mgr = &state.0;
    mgr.get_all_tasks()
}

#[tauri::command]
fn task_pause(state: State<'_, TaskQueueState>, task_id: String) -> bool {
    let mgr = &state.0;
    mgr.pause_task(&task_id)
}

#[tauri::command]
fn task_resume(state: State<'_, TaskQueueState>, task_id: String) -> bool {
    let mgr = &state.0;
    mgr.resume_task(&task_id)
}

#[tauri::command]
fn task_cancel(state: State<'_, TaskQueueState>, task_id: String) -> bool {
    let mgr = &state.0;
    mgr.cancel_task(&task_id)
}

#[tauri::command]
fn task_clear_finished(state: State<'_, TaskQueueState>, include_failed: Option<bool>) {
    let mgr = &state.0;
    mgr.clear_finished_tasks(include_failed.unwrap_or(false));
}

#[tauri::command]
fn resolve_task_conflict(
    state: State<'_, TaskQueueState>,
    task_id: String,
    resolution: String,
) -> bool {
    let mgr = &state.0;
    mgr.resolve_conflict(&task_id, &resolution)
}

// ===== App Entry Point =====

#[tauri::command]
fn load_language_file(_lang: String) -> std::collections::HashMap<String, String> {
    // Placeholder returning empty map to satisfy build
    std::collections::HashMap::new()
}

#[tauri::command]
fn exit_app(app_handle: tauri::AppHandle) {
    app_handle.exit(0);
}

// Privilege escalation is POSIX-only: it relies on pkexec and on the euid
// check below. Windows has no equivalent of "restart the same process as
// root", so the command still exists there (the frontend calls it
// unconditionally) but reports that it is unsupported.
#[cfg(unix)]
#[tauri::command]
async fn restart_as_root(app_handle: tauri::AppHandle) -> Result<(), String> {
    let exe_path = std::env::current_exe().map_err(|e| e.to_string())?;

    // This dialog is enforced here in the Rust command itself (not in the
    // frontend) so a compromised webview cannot skip it by invoking this
    // command directly via `invoke("restart_as_root")` and bypassing the
    // normal UI. `pkexec` still requires the user's own OS-level
    // authentication afterwards, but that prompt alone doesn't communicate
    // intent, so this adds an explicit, unskippable in-app confirmation
    // before any elevation is attempted.
    //
    // The command is `async` and this is the awaited dialog for one reason:
    // a synchronous `#[tauri::command]` runs on the GTK main thread, and rfd's
    // blocking `show()` posts the dialog onto the default main context and then
    // parks the calling thread until it is answered. On the main thread that is
    // a deadlock — the thread that has to dispatch the dialog is the one waiting
    // for it — and the whole window froze with no dialog ever appearing. Never
    // call an rfd blocking dialog from a sync command.
    let confirmation = rfd::AsyncMessageDialog::new()
        .set_level(rfd::MessageLevel::Warning)
        .set_title("Restart NexusCommander as root?")
        .set_description(
            "NexusCommander will restart with full root privileges via pkexec. \
All file, archive and process actions will then run as root for the rest \
of this session, which makes any bug far more dangerous. Only continue if \
you intended to trigger this yourself.",
        )
        .set_buttons(rfd::MessageButtons::YesNo)
        .show()
        .await;

    if confirmation != rfd::MessageDialogResult::Yes {
        eprintln!("[SECURITY] restart_as_root: user declined confirmation, aborting");
        return Err("Restart as root was cancelled".to_string());
    }

    eprintln!(
        "[SECURITY] restart_as_root: confirmed by user, exe: {:?}",
        exe_path
    );

    // pkexec intentionally starts its target with a minimal environment. That
    // normally removes DISPLAY/XAUTHORITY (and the Wayland runtime directory),
    // leaving GTK unable to attach to the already-running desktop session.
    // Pass only the session coordinates needed to draw the existing app; do
    // not forward the caller's general environment into the root process.
    //
    // `/usr/bin/env` is the target of pkexec so these values survive pkexec's
    // environment sanitisation without requiring a system-wide polkit policy.
    let gui_environment = graphical_session_environment();
    let inherited_appearance = inherited_appearance_environment(&app_handle);
    let child = std::process::Command::new("pkexec")
        .arg("/usr/bin/env")
        .args(gui_environment)
        .args(inherited_appearance)
        .arg(&exe_path)
        .stdin(std::process::Stdio::inherit())
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::inherit())
        .spawn()
        .map_err(|e| {
            eprintln!("[DEBUG] Failed to spawn pkexec: {}", e);
            format!("Failed to start as root: {}", e)
        })?;

    eprintln!("[DEBUG] pkexec spawned successfully, pid: {}", child.id());

    // Hand over only once pkexec has really become the elevated instance.
    // Quitting on a fixed timer quit this instance even when the user dismissed
    // the polkit prompt or failed to authenticate, so a cancelled elevation was
    // indistinguishable from the application crashing.
    let exe_name = exe_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        await_pkexec_handoff(child, &exe_name, PKEXEC_AUTH_TIMEOUT)
    })
    .await
    .map_err(|e| format!("Task execution error: {}", e))??;

    eprintln!("[DEBUG] Elevated instance took over, exiting current instance");
    app_handle.exit(0);
    Ok(())
}

/// Long enough for a password prompt plus a fumbled retry, short enough that a
/// wedged polkit agent does not hold a blocking-pool thread forever.
#[cfg(unix)]
const PKEXEC_AUTH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);

/// The strictly limited subset of the desktop session that a GTK process needs
/// after `pkexec` has discarded the caller's environment. These are passed as
/// arguments to `/usr/bin/env`, rather than inherited by pkexec itself.
#[cfg(unix)]
fn graphical_session_environment() -> Vec<std::ffi::OsString> {
    [
        "DISPLAY",
        "XAUTHORITY",
        "WAYLAND_DISPLAY",
        "XDG_RUNTIME_DIR",
    ]
    .iter()
    .filter_map(|key| {
        let value = std::env::var_os(key)?;
        if value.is_empty() {
            return None;
        }

        let mut assignment = std::ffi::OsString::from(*key);
        assignment.push("=");
        assignment.push(value);
        Some(assignment)
    })
    .collect()
}

/// The current session's appearance, as environment assignments for the
/// elevated instance.
///
/// Everything else about the session deliberately does not travel: HOME becomes
/// root's, so the elevated instance keeps its own tabs, paths, layout and window
/// geometry — it really is a different user's session. The *looks* are the one
/// exception, because the user is watching a single window change hands and a
/// silent switch to the default dark theme reads as a crash-and-restart rather
/// than an elevation.
///
/// Both values are matched against the names the UI can render instead of being
/// forwarded verbatim: this crosses a privilege boundary, and the config file
/// they come from is writable by the unprivileged user.
#[cfg(unix)]
fn inherited_appearance_environment(app: &tauri::AppHandle) -> Vec<std::ffi::OsString> {
    let config = settings::load_settings(app.clone());

    [
        (
            settings::INHERITED_THEME_ENV,
            settings::known_appearance_value(&config.theme, settings::THEMES),
        ),
        (
            settings::INHERITED_ICON_THEME_ENV,
            settings::known_appearance_value(&config.icon_theme, settings::ICON_THEMES),
        ),
    ]
    .into_iter()
    .filter_map(|(key, value)| {
        let mut assignment = std::ffi::OsString::from(key);
        assignment.push("=");
        assignment.push(value?);
        Some(assignment)
    })
    .collect()
}

/// Block until `pkexec` either fails or has replaced itself with `exe_name`.
///
/// pkexec `exec`s the target program in its own process once polkit authorises,
/// so on success the child handle stays alive for the rest of the session and
/// only an *exit* reports failure. The handoff itself is observed through
/// `/proc/<pid>/comm`, which stays world-readable after the process turns root —
/// `/proc/<pid>/exe` does not, since reading that needs ptrace access we lose
/// the moment the process is no longer ours.
#[cfg(unix)]
fn await_pkexec_handoff(
    mut child: std::process::Child,
    exe_name: &str,
    timeout: std::time::Duration,
) -> Result<(), String> {
    use std::time::{Duration, Instant};

    const POLL: Duration = Duration::from_millis(50);
    // Only reachable where `/proc` cannot answer, i.e. a unix that is not Linux —
    // which is also a unix without pkexec, so this keeps the old timer behaviour
    // for a path that cannot realistically be taken.
    const BLIND_GRACE: Duration = Duration::from_millis(1500);
    // A successful `exec` only proves that pkexec launched the target. Keep
    // watching briefly so an immediate GTK/WebKit startup failure does not
    // make the original instance exit and strand the user without an app.
    const STARTUP_GRACE: Duration = Duration::from_millis(1500);

    let pid = child.id();
    let started = Instant::now();
    let mut target_observed_at = None;

    loop {
        match child.try_wait() {
            // pkexec can only exit *before* the exec, so any exit is a failure.
            Ok(Some(status)) => return Err(pkexec_failure_message(status)),
            Ok(None) => {}
            Err(e) => return Err(format!("Failed to monitor pkexec: {}", e)),
        }

        match read_process_comm(pid) {
            Some(comm) if comm_is(&comm, exe_name) => {
                let observed_at = target_observed_at.get_or_insert_with(Instant::now);
                if observed_at.elapsed() >= STARTUP_GRACE {
                    return Ok(());
                }
            }
            None if started.elapsed() >= BLIND_GRACE => return Ok(()),
            _ => {}
        }

        if started.elapsed() >= timeout {
            return Err("Timed out waiting for authentication".to_string());
        }

        std::thread::sleep(POLL);
    }
}

/// Why pkexec gave up, phrased so the frontend can show it as-is. 126 and 127
/// are pkexec's own documented codes for "prompt dismissed" and "not
/// authorised"; anything else is the elevated process refusing to start.
#[cfg(unix)]
fn pkexec_failure_message(status: std::process::ExitStatus) -> String {
    match status.code() {
        Some(126) => "Authentication dialog was dismissed".to_string(),
        Some(127) => "Not authorised to restart as root".to_string(),
        Some(code) => format!("pkexec exited with status {}", code),
        None => "pkexec was terminated by a signal".to_string(),
    }
}

/// Whether `comm` names `exe_name`. `/proc/<pid>/comm` is capped at 15 bytes, so
/// anything longer arrives truncated and has to be compared as a prefix.
#[cfg(unix)]
fn comm_is(comm: &str, exe_name: &str) -> bool {
    const COMM_LEN: usize = 15;
    let expected = exe_name.as_bytes();
    !expected.is_empty() && comm.as_bytes() == &expected[..COMM_LEN.min(expected.len())]
}

/// The process name of `pid`, or `None` when `/proc` cannot answer.
#[cfg(unix)]
fn read_process_comm(pid: u32) -> Option<String> {
    std::fs::read_to_string(format!("/proc/{}/comm", pid))
        .ok()
        .map(|comm| comm.trim().to_string())
}

// The elevation handoff decides whether this instance is allowed to quit, so
// both of its answers are covered: a failed pkexec must keep the app alive with
// a reason, and a completed exec must let it go.
#[cfg(all(test, target_os = "linux"))]
mod pkexec_handoff_tests {
    use super::{await_pkexec_handoff, comm_is, pkexec_failure_message};
    use std::os::unix::process::ExitStatusExt;
    use std::process::{Command, ExitStatus, Stdio};
    use std::time::Duration;

    const TEST_TIMEOUT: Duration = Duration::from_secs(5);

    // No shell: the spawned process has to *be* the program whose name lands in
    // /proc/<pid>/comm, and QSF-006 keeps `sh -c` out of this crate entirely.
    fn spawn(program: &str, arg: &str) -> std::process::Child {
        let mut cmd = Command::new(program);
        if !arg.is_empty() {
            cmd.arg(arg);
        }
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap_or_else(|e| panic!("{program} should be spawnable: {e}"))
    }

    #[test]
    fn a_child_that_exits_is_reported_not_swallowed() {
        // `false` exits immediately, the way pkexec does when authentication
        // never succeeds. The exe name is one this child can never carry, so
        // the only way out of the loop is the exit status.
        let err = await_pkexec_handoff(spawn("false", ""), "nexuscommander", TEST_TIMEOUT)
            .expect_err("a pkexec that exits must not read as a successful handoff");
        assert!(err.contains("status 1"), "unexpected message: {err}");
    }

    #[test]
    fn pkexec_exit_codes_are_translated_into_a_reason() {
        // Wait status is code << 8; the low byte carries the signal instead.
        assert!(pkexec_failure_message(ExitStatus::from_raw(126 << 8)).contains("dismissed"));
        assert!(pkexec_failure_message(ExitStatus::from_raw(127 << 8)).contains("Not authorised"));
        assert!(pkexec_failure_message(ExitStatus::from_raw(3 << 8)).contains("status 3"));
        assert!(pkexec_failure_message(ExitStatus::from_raw(9)).contains("signal"));
    }

    #[test]
    fn exec_into_the_target_binary_completes_the_handoff() {
        // A spawned `sleep` is the same shape as pkexec turning into the
        // elevated instance: a live pid whose comm is the target program.
        let handoff = await_pkexec_handoff(spawn("sleep", "3"), "sleep", TEST_TIMEOUT);
        assert!(handoff.is_ok(), "expected handoff, got {handoff:?}");
    }

    #[test]
    fn comm_matches_a_name_truncated_to_the_kernel_limit() {
        assert!(comm_is("nexuscommander", "nexuscommander"));
        // /proc/<pid>/comm keeps the first 15 bytes of "nexuscommander-desktop".
        assert!(comm_is("nexuscommander-", "nexuscommander-desktop"));
        assert!(!comm_is("nexuscommander", "nexuscommander-desktop"));
        assert!(!comm_is("pkexec", "nexuscommander"));
        assert!(!comm_is("", ""));
    }
}

#[cfg(not(unix))]
#[tauri::command]
fn restart_as_root(_app_handle: tauri::AppHandle) -> Result<(), String> {
    Err("Restarting as root is not supported on this platform".to_string())
}

#[cfg(unix)]
#[tauri::command]
fn is_running_as_root() -> bool {
    unsafe { libc::geteuid() == 0 }
}

// No POSIX root on Windows. Reporting false keeps the root warning banner
// and the permission UI out of the way rather than claiming an elevation
// state we cannot determine here.
#[cfg(not(unix))]
#[tauri::command]
fn is_running_as_root() -> bool {
    false
}

#[cfg(target_os = "linux")]
fn is_missing_dnd_cursor_message(domain: Option<&str>, message: Option<&str>) -> bool {
    domain == Some("Gdk")
        && matches!(
            message,
            Some(
                "Unable to load dnd-none from the cursor theme"
                    | "Unable to load dnd-move from the cursor theme"
                    | "Unable to load dnd-copy from the cursor theme"
            )
        )
}

/// GTK 3 emits these through GLib's structured writer, bypassing the legacy
/// per-domain handler API. Keep the filter deliberately exact: it is only for
/// the harmless legacy DnD cursor aliases missing from older cursor themes;
/// every other GTK/GDK message keeps its normal destination and formatting.
#[cfg(target_os = "linux")]
fn gtk_noise_filter_writer(
    level: glib::LogLevel,
    fields: &[glib::LogField<'_>],
) -> glib::LogWriterOutput {
    let mut domain = None;
    let mut message = None;

    for field in fields {
        match field.key() {
            "GLIB_DOMAIN" => domain = field.value_str(),
            "MESSAGE" => message = field.value_str(),
            _ => {}
        }
    }

    if is_missing_dnd_cursor_message(domain, message) {
        glib::LogWriterOutput::Handled
    } else {
        glib::log_writer_default(level, fields)
    }
}

#[cfg(target_os = "linux")]
fn install_gtk_noise_filter() {
    glib::log_set_writer_func(gtk_noise_filter_writer);
}

#[cfg(all(test, target_os = "linux"))]
mod gtk_noise_filter_tests {
    use super::{gtk_noise_filter_writer, is_missing_dnd_cursor_message};

    #[test]
    fn filters_only_the_three_legacy_gdk_cursor_messages() {
        for message in [
            "Unable to load dnd-none from the cursor theme",
            "Unable to load dnd-move from the cursor theme",
            "Unable to load dnd-copy from the cursor theme",
        ] {
            assert!(is_missing_dnd_cursor_message(Some("Gdk"), Some(message)));
        }

        assert!(!is_missing_dnd_cursor_message(
            Some("Gdk"),
            Some("Unable to load dnd-link from the cursor theme"),
        ));
        assert!(!is_missing_dnd_cursor_message(
            Some("Gtk"),
            Some("Unable to load dnd-copy from the cursor theme"),
        ));
        assert!(!is_missing_dnd_cursor_message(Some("Gdk"), None));
    }

    #[test]
    fn handles_the_structured_fields_gdk_emits() {
        let fields = [
            glib::LogField::new(glib::gstr!("GLIB_DOMAIN"), b"Gdk"),
            glib::LogField::new(
                glib::gstr!("MESSAGE"),
                b"Unable to load dnd-copy from the cursor theme",
            ),
        ];

        assert_eq!(
            gtk_noise_filter_writer(glib::LogLevel::Message, &fields),
            glib::LogWriterOutput::Handled,
        );
    }
}

#[cfg(not(target_os = "linux"))]
fn install_gtk_noise_filter() {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_gtk_noise_filter();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(TaskQueueState(TaskQueueManager::new()))
        .manage(ArchiveState(Arc::new(AtomicBool::new(false))))
        .manage(search::SearchState::new())
        .setup(|app| {
            let config = settings::load_settings(app.handle().clone());
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_background_color(Some(theme_startup_color(&config.theme)));
                let _ = window.set_theme(Some(native_window_theme(&config.theme)));
                if let (Some(x), Some(y)) = (config.window_x, config.window_y) {
                    let _ =
                        window.set_position(tauri::Position::Physical(tauri::PhysicalPosition::<
                            i32,
                        >::new(
                            x, y
                        )));
                }
                if let (Some(w), Some(h)) = (config.window_width, config.window_height) {
                    let _ = window
                        .set_size(tauri::Size::Physical(tauri::PhysicalSize::<u32>::new(w, h)));
                }

                // The frontend reveals the window after its saved theme has painted.
                // Keep a fallback so a frontend startup error cannot leave it hidden.
                //
                // This is a vangnet, not the normal route: the frontend reaches its
                // own show() ~1.4s after launch. It used to be 8s, which mattered
                // because revealWindow() waited on animation frames a hidden window
                // never delivers, so the fallback *was* the route and every start
                // cost 8.2s. Keep it comfortably above the frontend's own path but
                // short enough that a genuine startup error is not mistaken for a
                // hang.
                let fallback_window = window.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    if !fallback_window.is_visible().unwrap_or(false) {
                        let _ = fallback_window.show();
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // VFS
            read_directory,
            get_home_dir,
            get_parent_dir,
            get_path_info,
            vfs::get_drives,
            vfs::compare_directories,
            // File properties (permissions / ownership / size-on-disk)
            get_users_groups,
            set_file_properties,
            get_size_on_disk,
            // CRUD
            create_directory,
            delete_entry,
            delete_entries,
            rename_entry,
            batch_rename,
            copy_file,
            copy_entries,
            move_entries,
            save_text_file,
            calculate_dir_size,
            // Archive
            is_archive,
            read_archive,
            archive_pack,
            archive_cancel_pack,
            archive_unpack,
            get_archive_capabilities,
            archive_test,
            split_file,
            combine_files,
            // Viewer
            read_file_for_viewer,
            // Task queue
            task_create,
            task_execute,
            task_get,
            task_list,
            task_pause,
            task_resume,
            task_cancel,
            task_clear_finished,
            resolve_task_conflict,
            // Phase 4 commands
            bookmarks::get_bookmarks,
            bookmarks::save_bookmarks,
            bookmarks::add_bookmark,
            bookmarks::remove_bookmark,
            search::search_files,
            search::search_cancel,
            terminal::open_terminal,
            terminal::open_file,
            terminal::open_in_editor,
            open_with::get_open_with_apps,
            open_with::open_file_with_app,
            open_with::set_default_app,
            // Phase 5 commands
            settings::load_settings,
            settings::save_settings,
            help::get_help_topics,
            help::get_help_content,
            network::map_network_drive,
            network::disconnect_network_drive,
            load_language_file,
            exit_app,
            restart_as_root,
            is_running_as_root
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
