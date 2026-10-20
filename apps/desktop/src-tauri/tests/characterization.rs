//! P0.7 — characterization suite for the current mutation behavior.
//!
//! Deferred out of Fase 0, but the Phase 1 table makes it a hard dependency of
//! P1.4 ("characterization suite still green") and section 14 puts it at step 4,
//! before any engine work. Writing it after the rewrite would characterize the
//! rewrite, which is worth nothing.
//!
//! # Why this is an integration test
//!
//! An integration test is a separate crate and can only reach `nexuscommander_lib`'s
//! public surface — the same entry points the Tauri commands call. That is
//! deliberate: P1.3–P1.7 restructure the internals heavily, and a suite bound to
//! private helpers would have to be rewritten alongside the thing it is supposed
//! to be checking.
//!
//! # The two groups, and why they are separated
//!
//! Fase 0's P0.6 stopgap already changed observable behavior: every replacement
//! now returns an error. So this suite characterizes *post-stopgap* behavior, and
//! two very different kinds of assertion live here:
//!
//! - **`invariant_*`** — must stay true through the whole of Phase 1. If one of
//!   these goes red during P1.4/P1.5/P1.6, the rewrite broke something.
//! - **`stopgap_*`** — expected to *flip* when the named item lands. Each one
//!   says which item changes it and what it must become. A red `stopgap_*` test
//!   after that item is progress, not a regression.
//!
//! Without that separation a deliberate behavior change and a regression look
//! identical, and the suite stops being able to fail usefully — the failure mode
//! `CLAUDE.md` calls out for `check-locales.js`.
//!
//! # Known gap
//!
//! `archive::pack_archive` takes a `tauri::AppHandle` and cannot be driven from a
//! test binary at all. Its P0.6 guard is characterized here at the `safety` level
//! instead. Making archive creation testable is P2.2's job (job-scoped archive
//! creation); until then this suite cannot cover the pack path end to end, and
//! says so rather than implying coverage it does not have.

use nexuscommander_lib::engine::job::Scheduler;
use nexuscommander_lib::engine::outcome::CommitOutcome;
use nexuscommander_lib::task_queue::{TaskQueueManager, TaskStatus, TaskType};
use nexuscommander_lib::vfs::{self, DeleteMode};

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

// ===== harness =====

static COUNTER: AtomicU32 = AtomicU32::new(0);

/// A scratch directory that removes itself. Tests run in parallel, so the name
/// carries both the pid and a counter — two runs of the suite at once must not
/// share a path.
struct TestDir(PathBuf);

impl TestDir {
    fn new(name: &str) -> Self {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir =
            std::env::temp_dir().join(format!("nc_char_{}_{}_{}", name, std::process::id(), n));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create scratch dir");
        TestDir(dir)
    }

    fn path(&self, rel: &str) -> PathBuf {
        self.0.join(rel)
    }

    fn s(&self, rel: &str) -> String {
        self.path(rel).to_string_lossy().to_string()
    }

    /// Create a file with `content` and return its path as a String.
    fn file(&self, rel: &str, content: &[u8]) -> String {
        let p = self.path(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        fs::write(&p, content).expect("write fixture");
        p.to_string_lossy().to_string()
    }

    fn dir(&self, rel: &str) -> String {
        let p = self.path(rel);
        fs::create_dir_all(&p).expect("create fixture dir");
        p.to_string_lossy().to_string()
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Staging files the commit engine may have left behind. A successful or
/// rolled-back operation must leave none.
fn leftover_staging(dir: &Path) -> Vec<String> {
    fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|n| n.starts_with(".nc-staging-"))
                .collect()
        })
        .unwrap_or_default()
}

fn read(path: &str) -> Vec<u8> {
    fs::read(path).unwrap_or_else(|e| panic!("read {}: {}", path, e))
}

fn mtime(path: &str) -> std::time::SystemTime {
    fs::metadata(path).unwrap().modified().unwrap()
}

/// `execute_task` spawns onto the async runtime and returns immediately, so
/// every queue assertion has to wait for a terminal state. Poll rather than
/// sleep a fixed amount: the timeout is a failure bound, not a delay.
fn wait_for<F>(mgr: &TaskQueueManager, id: &str, label: &str, pred: F) -> TaskStatus
where
    F: Fn(&TaskStatus) -> bool,
{
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let task = mgr.get_task(id).expect("task disappeared from the queue");
        if pred(&task.status) {
            return task.status;
        }
        if Instant::now() > deadline {
            panic!(
                "timed out waiting for {} (status {:?}, error {:?})",
                label, task.status, task.error
            );
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn wait_for_terminal(mgr: &TaskQueueManager, id: &str) -> TaskStatus {
    wait_for(mgr, id, "a terminal status", |s| {
        matches!(
            s,
            TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled
        )
    })
}

// ===========================================================================
// invariant_* — must stay true through all of Phase 1.
// ===========================================================================

#[test]
fn invariant_copy_file_to_free_destination_preserves_bytes_and_mtime() {
    let t = TestDir::new("copy_free");
    let src = t.file("src.txt", b"hello characterization");
    let dst = t.s("dst.txt");

    // Backdate the source so a copy that ignored mtime would be visible.
    let backdated = std::time::SystemTime::now() - Duration::from_secs(60 * 60 * 24);
    filetime::set_file_mtime(&src, filetime::FileTime::from_system_time(backdated)).unwrap();

    let res = vfs::copy_file(&src, &dst);
    assert!(res.success, "{}", res.message);
    assert_eq!(read(&dst), b"hello characterization");

    let drift = mtime(&dst)
        .duration_since(mtime(&src))
        .unwrap_or_default()
        .as_secs();
    assert!(drift <= 1, "mtime not preserved: drifted {}s", drift);
}

#[test]
fn invariant_copy_directory_merges_into_a_populated_destination() {
    let t = TestDir::new("copy_merge");
    let src = t.dir("src");
    t.file("src/new.txt", b"from source");
    let dst = t.dir("dst");
    let bystander = t.file("dst/bystander.txt", b"was already here");

    let res = vfs::copy_file(&src, &dst);
    assert!(res.success, "merge must be allowed: {}", res.message);
    assert_eq!(read(&t.s("dst/new.txt")), b"from source");
    assert_eq!(
        read(&bystander),
        b"was already here",
        "an unrelated file in the destination must survive a merge"
    );
}

#[test]
fn invariant_copy_refuses_a_directory_into_its_own_subtree() {
    let t = TestDir::new("copy_selfnest");
    let src = t.dir("tree");
    t.file("tree/a.txt", b"a");

    let res = vfs::copy_file(&src, &t.s("tree/inner"));
    assert!(!res.success, "copying a tree into itself must be refused");
    assert!(
        res.message.contains("itself") || res.message.contains("subdirectory"),
        "unexpected message: {}",
        res.message
    );
}

#[test]
fn invariant_copy_entries_creates_the_destination_parent() {
    let t = TestDir::new("copy_parent");
    let src = t.file("a.txt", b"payload");
    let target = t.s("does/not/exist/yet");

    let results = vfs::copy_entries(&[src], &target);
    assert_eq!(results.len(), 1);
    assert!(results[0].success, "{}", results[0].message);
    assert_eq!(read(&t.s("does/not/exist/yet/a.txt")), b"payload");
}

#[test]
fn invariant_move_to_free_destination_moves_and_clears_the_source() {
    let t = TestDir::new("move_free");
    let src = t.file("a.txt", b"moving");
    let target = t.dir("target");

    let results = vfs::move_entries(std::slice::from_ref(&src), &target);
    assert!(results[0].success, "{}", results[0].message);
    assert!(
        !Path::new(&src).exists(),
        "source must be gone after a move"
    );
    assert_eq!(read(&t.s("target/a.txt")), b"moving");
}

#[test]
fn invariant_rename_to_free_destination_succeeds() {
    let t = TestDir::new("rename_free");
    let from = t.file("before.txt", b"same bytes");
    let to = t.s("after.txt");

    let res = vfs::rename_entry(&from, &to);
    assert!(res.success, "{}", res.message);
    assert!(!Path::new(&from).exists());
    assert_eq!(read(&to), b"same bytes");
}

#[test]
fn invariant_batch_rename_can_swap_two_names() {
    // The whole reason batch_rename stages through temporary names: a swap has
    // no ordering that works with plain renames. P1.6 rebuilds the staging, but
    // the swap must keep working.
    let t = TestDir::new("batch_swap");
    let a = t.file("a.txt", b"content of a");
    let b = t.file("b.txt", b"content of b");

    let results = vfs::batch_rename(vec![(a.clone(), b.clone()), (b.clone(), a.clone())]);
    assert!(
        results.iter().all(|r| r.success),
        "swap failed: {:?}",
        results.iter().map(|r| &r.message).collect::<Vec<_>>()
    );
    assert_eq!(read(&a), b"content of b");
    assert_eq!(read(&b), b"content of a");
}

#[test]
fn invariant_batch_rename_rejects_duplicate_targets() {
    let t = TestDir::new("batch_dupe");
    let a = t.file("a.txt", b"a");
    let b = t.file("b.txt", b"b");
    let same = t.s("merged.txt");

    let results = vfs::batch_rename(vec![(a.clone(), same.clone()), (b.clone(), same)]);
    assert!(
        results.iter().any(|r| !r.success),
        "two sources renamed onto one target must be refused"
    );
    assert_eq!(
        read(&a),
        b"a",
        "a refused batch must not have moved anything"
    );
    assert_eq!(read(&b), b"b");
}

#[test]
fn invariant_batch_rename_rolls_back_when_a_target_is_unwritable() {
    let t = TestDir::new("batch_rollback");
    let a = t.file("a.txt", b"a");
    let b = t.file("b.txt", b"b");
    // Second rename targets a directory that does not exist, so phase 2 fails
    // after phase 1 has already staged both files under temp names.
    let good = t.s("a-renamed.txt");
    let bad = t.s("no-such-dir/b-renamed.txt");

    let results = vfs::batch_rename(vec![(a.clone(), good.clone()), (b.clone(), bad)]);
    assert!(results.iter().any(|r| !r.success));
    assert_eq!(read(&a), b"a", "rollback must restore the original name");
    assert_eq!(read(&b), b"b");
    assert!(
        !Path::new(&good).exists(),
        "the partially applied rename must have been undone"
    );
}

// The trash-deletion invariant needs a deliberately broken trash directory to
// reach the branch that matters, and that means process-global `HOME`. It lives
// in its own binary: `tests/trash_delete.rs`.

#[test]
fn invariant_permanent_delete_removes_a_file() {
    let t = TestDir::new("perm_delete");
    let f = t.file("gone.txt", b"x");

    let res = vfs::delete_entry(&f, false, DeleteMode::Permanent);
    assert!(res.success, "{}", res.message);
    assert!(!Path::new(&f).exists());
}

#[test]
fn invariant_non_recursive_delete_refuses_a_populated_directory() {
    let t = TestDir::new("perm_delete_dir");
    let d = t.dir("full");
    t.file("full/child.txt", b"child");

    let res = vfs::delete_entry(&d, false, DeleteMode::Permanent);
    assert!(
        !res.success,
        "non-recursive delete must refuse a full directory"
    );
    assert_eq!(read(&t.s("full/child.txt")), b"child");
}

#[test]
fn invariant_delete_reports_a_missing_path_instead_of_succeeding() {
    let t = TestDir::new("delete_missing");
    let res = vfs::delete_entry(&t.s("never-existed"), false, DeleteMode::Permanent);
    assert!(
        !res.success,
        "deleting a missing path must not report success"
    );
}

#[test]
fn invariant_save_text_file_rejects_null_bytes() {
    let t = TestDir::new("save_null");
    let p = t.s("bin.txt");
    let err = vfs::save_text_file(&p, "before\0after").unwrap_err();
    assert!(err.contains("binary"), "unexpected message: {}", err);
    assert!(
        !Path::new(&p).exists(),
        "a rejected save must not create the file"
    );
}

#[test]
fn invariant_save_text_file_refuses_a_directory_path() {
    let t = TestDir::new("save_dir");
    let d = t.dir("adir");
    assert!(vfs::save_text_file(&d, "text").is_err());
}

#[test]
fn invariant_create_directory_is_idempotent() {
    let t = TestDir::new("mkdir");
    let d = t.s("nested/deep");
    assert!(vfs::create_directory(&d).success);
    assert!(
        vfs::create_directory(&d).success,
        "create_directory uses create_dir_all and must stay idempotent"
    );
}

// --- queue-driven invariants ---

#[test]
fn invariant_queue_copy_to_free_destination_completes() {
    let t = TestDir::new("q_copy_free");
    let src = t.file("a.txt", b"queued payload");
    let target = t.dir("target");

    let mgr = TaskQueueManager::new();
    let id = mgr.create_task(TaskType::Copy, vec![src], target);
    mgr.execute_task(&id);

    assert_eq!(wait_for_terminal(&mgr, &id), TaskStatus::Completed);
    assert_eq!(read(&t.s("target/a.txt")), b"queued payload");
}

#[test]
fn invariant_queue_move_to_free_destination_completes() {
    let t = TestDir::new("q_move_free");
    let src = t.file("a.txt", b"queued move");
    let target = t.dir("target");

    let mgr = TaskQueueManager::new();
    let id = mgr.create_task(TaskType::Move, vec![src.clone()], target);
    mgr.execute_task(&id);

    assert_eq!(wait_for_terminal(&mgr, &id), TaskStatus::Completed);
    assert!(!Path::new(&src).exists());
    assert_eq!(read(&t.s("target/a.txt")), b"queued move");
}

#[test]
fn invariant_queue_conflict_parks_the_task_and_waits() {
    let t = TestDir::new("q_conflict_wait");
    let src = t.file("a.txt", b"new");
    let target = t.dir("target");
    t.file("target/a.txt", b"old");

    let mgr = TaskQueueManager::new();
    let id = mgr.create_task(TaskType::Copy, vec![src], target);
    mgr.execute_task(&id);

    wait_for(&mgr, &id, "WaitingForInput", |s| {
        *s == TaskStatus::WaitingForInput
    });
    let task = mgr.get_task(&id).unwrap();
    assert_eq!(
        task.pending_conflict.as_deref(),
        Some("a.txt"),
        "the parked task must name the conflicting entry"
    );
    assert!(!task.conflict_is_dir);

    mgr.cancel_task(&id);
    wait_for_terminal(&mgr, &id);
}

#[test]
fn invariant_queue_skip_resolution_leaves_the_destination_untouched() {
    let t = TestDir::new("q_skip");
    let src = t.file("a.txt", b"new bytes");
    let target = t.dir("target");
    let dst = t.file("target/a.txt", b"old bytes");

    let mgr = TaskQueueManager::new();
    let id = mgr.create_task(TaskType::Copy, vec![src], target);
    mgr.execute_task(&id);

    wait_for(&mgr, &id, "WaitingForInput", |s| {
        *s == TaskStatus::WaitingForInput
    });
    assert!(mgr.resolve_conflict(&id, "skip"));

    assert_eq!(wait_for_terminal(&mgr, &id), TaskStatus::Completed);
    assert_eq!(
        read(&dst),
        b"old bytes",
        "skip must not touch the destination"
    );
}

#[test]
fn invariant_queue_cancel_during_a_conflict_wait_cancels_the_task() {
    let t = TestDir::new("q_cancel_conflict");
    let src = t.file("a.txt", b"new");
    let target = t.dir("target");
    let dst = t.file("target/a.txt", b"old");

    let mgr = TaskQueueManager::new();
    let id = mgr.create_task(TaskType::Copy, vec![src.clone()], target);
    mgr.execute_task(&id);

    wait_for(&mgr, &id, "WaitingForInput", |s| {
        *s == TaskStatus::WaitingForInput
    });
    assert!(mgr.cancel_task(&id));

    assert_eq!(wait_for_terminal(&mgr, &id), TaskStatus::Cancelled);
    assert_eq!(
        read(&dst),
        b"old",
        "cancelling must leave the destination alone"
    );
    assert_eq!(read(&src), b"new", "cancelling must leave the source alone");
}

#[test]
fn invariant_queue_will_not_start_a_second_worker_for_a_running_task() {
    let t = TestDir::new("q_double_start");
    let src = t.file("a.txt", b"x");
    let target = t.dir("target");
    t.file("target/a.txt", b"blocker");

    let mgr = TaskQueueManager::new();
    let id = mgr.create_task(TaskType::Copy, vec![src], target);
    mgr.execute_task(&id);
    wait_for(&mgr, &id, "WaitingForInput", |s| {
        *s == TaskStatus::WaitingForInput
    });

    // A second execute must be a no-op, not a second worker racing the first.
    let again = mgr.execute_task(&id);
    assert_eq!(again.status, TaskStatus::WaitingForInput);

    mgr.cancel_task(&id);
    wait_for_terminal(&mgr, &id);
}

#[test]
fn invariant_a_cancelled_task_stays_cancelled() {
    // The other pre-P1.3 hole: nothing refused Cancelled -> Running, so a
    // second execute restarted a task the user had stopped.
    let t = TestDir::new("q_cancel_restart");
    let src = t.file("a.txt", b"payload");
    let target = t.dir("target");

    let mgr = TaskQueueManager::new();
    let id = mgr.create_task(TaskType::Copy, vec![src], target);
    assert!(mgr.cancel_task(&id));

    let again = mgr.execute_task(&id);
    assert_eq!(again.status, TaskStatus::Cancelled);
    assert!(
        !Path::new(&t.s("target/a.txt")).exists(),
        "the cancelled copy must not have run"
    );
}

#[test]
fn invariant_a_job_waiting_on_a_decision_does_not_block_another_from_running() {
    // P1.3's deadlock case, through the real queue: with a filesystem budget of
    // one, a task parked on a conflict dialog must not stop a second task from
    // copying. Before P1.3 both ran on the async runtime with no bound at all,
    // so imposing one without releasing the permit would have introduced this.
    let t = TestDir::new("q_park_no_block");
    let blocked_src = t.file("blocked.txt", b"new");
    let target = t.dir("target");
    t.file("target/blocked.txt", b"old");
    let free_src = t.file("free.txt", b"free payload");

    let mgr = TaskQueueManager::with_scheduler(Scheduler::new(4, 1));

    let parked = mgr.create_task(TaskType::Copy, vec![blocked_src], target.clone());
    mgr.execute_task(&parked);
    wait_for(&mgr, &parked, "WaitingForInput", |s| {
        *s == TaskStatus::WaitingForInput
    });

    let other = mgr.create_task(TaskType::Copy, vec![free_src], target);
    mgr.execute_task(&other);
    assert_eq!(
        wait_for_terminal(&mgr, &other),
        TaskStatus::Completed,
        "the parked job is holding the only I/O permit"
    );
    assert_eq!(read(&t.s("target/free.txt")), b"free payload");

    mgr.cancel_task(&parked);
    wait_for_terminal(&mgr, &parked);
}

#[test]
fn invariant_exceeding_the_worker_cap_reports_instead_of_dropping_the_task() {
    // QSF-017: an operation that cannot start must say so. Before P1.3 there was
    // no cap, so this could not be reported because it could not happen —
    // 500 queued operations became 500 threads.
    let t = TestDir::new("q_cap");
    let target = t.dir("target");
    let blocked_src = t.file("blocked.txt", b"new");
    t.file("target/blocked.txt", b"old");

    // One worker slot, occupied by a task parked on a dialog.
    let mgr = TaskQueueManager::with_scheduler(Scheduler::new(1, 1));
    let parked = mgr.create_task(TaskType::Copy, vec![blocked_src], target.clone());
    mgr.execute_task(&parked);
    wait_for(&mgr, &parked, "WaitingForInput", |s| {
        *s == TaskStatus::WaitingForInput
    });

    let overflow = mgr.create_task(TaskType::Copy, vec![t.file("b.txt", b"b")], target);
    let result = mgr.execute_task(&overflow);
    assert_eq!(result.status, TaskStatus::Failed);
    let error = result.error.unwrap_or_default();
    assert!(
        error.contains("Too many operations"),
        "the failure must be legible to a user: {}",
        error
    );

    mgr.cancel_task(&parked);
    wait_for_terminal(&mgr, &parked);
}

/// **Flipped at P1.4.** Was `stopgap_save_text_file_still_truncates_in_place`.
///
/// `save_text_file` never received a P0.6 guard: `fs::write` truncated the file
/// before the replacement was known to be writable. It now stages into the
/// destination directory and commits by rename.
#[test]
fn invariant_save_text_file_replaces_content_without_truncating_first() {
    let t = TestDir::new("save_replace");
    let p = t.file("notes.txt", b"the original notes, which are long");

    vfs::save_text_file(&p, "short").unwrap();
    assert_eq!(read(&p), b"short");
    assert!(
        leftover_staging(&t.0).is_empty(),
        "the staging file must be gone after a successful commit"
    );
}

/// The observable proof that the write is staged rather than in place: a
/// symlinked target is *replaced* instead of being followed and written through
/// to a file outside the directory (QSF-003).
#[cfg(unix)]
#[test]
fn invariant_save_text_file_does_not_write_through_a_symlink() {
    let t = TestDir::new("save_symlink");
    let outside = t.file("outside.txt", b"must not be touched");
    let link = t.s("notes.txt");
    std::os::unix::fs::symlink(&outside, &link).unwrap();

    vfs::save_text_file(&link, "replacement").unwrap();

    assert_eq!(
        read(&outside),
        b"must not be touched",
        "the save followed the symlink out of the directory"
    );
    assert_eq!(read(&link), b"replacement");
}

// ===========================================================================
// Flipped at P1.5. These were the `stopgap_*` tests: every one of them asserted
// that a replacement was *refused*, because the backend truncated the
// destination before the replacement was known to be good. P1.5 replaced that
// with the staging protocol, so each now asserts the replacement actually
// happens — safely.
//
// src/safety.rs is gone. Deleting the guard and proving the replacement had to
// be the same commit; a gap between them is a window where the repository has
// neither protection.
// ===========================================================================

#[test]
fn invariant_copy_replaces_an_existing_file_and_leaves_no_staging_file() {
    let t = TestDir::new("p15_copy");
    let src = t.file("src.txt", b"replacement");
    let dst = t.file("dst.txt", b"original");

    let res = vfs::copy_file(&src, &dst);
    assert!(res.success, "{}", res.message);
    assert_eq!(read(&dst), b"replacement");
    assert_eq!(read(&src), b"replacement", "the source must be untouched");
    assert!(leftover_staging(&t.0).is_empty());
}

#[test]
fn invariant_directory_merge_replaces_a_colliding_child() {
    let t = TestDir::new("p15_merge");
    t.dir("src");
    t.file("src/same.txt", b"from source");
    t.file("src/fresh.txt", b"brand new");
    let dst = t.dir("dst");
    t.file("dst/same.txt", b"already here");
    let bystander = t.file("dst/bystander.txt", b"unrelated");

    let res = vfs::copy_file(&t.s("src"), &dst);
    assert!(res.success, "{}", res.message);
    assert_eq!(read(&t.s("dst/same.txt")), b"from source");
    assert_eq!(read(&t.s("dst/fresh.txt")), b"brand new");
    assert_eq!(
        read(&bystander),
        b"unrelated",
        "a merge must not disturb siblings"
    );
    assert!(leftover_staging(&t.path("dst")).is_empty());
}

/// The inline rename used to replace an existing file of the target name
/// (atomically, but without asking). It has no conflict dialog, so it must
/// refuse instead and leave both files exactly as they were.
#[test]
fn invariant_rename_never_replaces_an_existing_file() {
    let t = TestDir::new("p15_rename");
    let from = t.file("from.txt", b"new");
    let to = t.file("to.txt", b"existing");

    let res = vfs::rename_entry(&from, &to);
    assert!(
        !res.success,
        "renaming onto an existing file must be refused"
    );
    assert_eq!(read(&to), b"existing", "the existing file must survive");
    assert_eq!(read(&from), b"new", "the source must stay where it was");
}

#[test]
fn invariant_rename_to_a_different_case_of_the_same_name_succeeds() {
    let t = TestDir::new("rename_case");
    let from = t.file("report.txt", b"content");
    let to = t.s("Report.txt");

    let res = vfs::rename_entry(&from, &to);
    assert!(res.success, "{}", res.message);
    assert_eq!(read(&to), b"content");
}

#[test]
fn invariant_move_entries_replaces_an_existing_file() {
    let t = TestDir::new("p15_move");
    let src = t.file("a.txt", b"new");
    let target = t.dir("target");
    let dst = t.file("target/a.txt", b"existing");

    let results = vfs::move_entries(std::slice::from_ref(&src), &target);
    assert!(results[0].success, "{}", results[0].message);
    assert_eq!(read(&dst), b"new");
    assert!(!Path::new(&src).exists());
}

#[test]
fn invariant_queue_copy_overwrite_replaces_the_destination() {
    let t = TestDir::new("p15_q_copy");
    let src = t.file("a.txt", b"new bytes");
    let target = t.dir("target");
    let dst = t.file("target/a.txt", b"old bytes");

    let mgr = TaskQueueManager::new();
    let id = mgr.create_task(TaskType::Copy, vec![src], target);
    mgr.execute_task(&id);

    wait_for(&mgr, &id, "WaitingForInput", |s| {
        *s == TaskStatus::WaitingForInput
    });
    assert!(mgr.resolve_conflict(&id, "overwrite"));

    let status = wait_for_terminal(&mgr, &id);
    assert_eq!(
        status,
        TaskStatus::Completed,
        "error: {:?}",
        mgr.get_task(&id).and_then(|t| t.error)
    );
    assert_eq!(read(&dst), b"new bytes");
    assert!(leftover_staging(&t.path("target")).is_empty());
}

#[test]
fn invariant_queue_move_overwrite_replaces_and_consumes_the_source() {
    let t = TestDir::new("p15_q_move");
    let src = t.file("a.txt", b"new bytes");
    let target = t.dir("target");
    let dst = t.file("target/a.txt", b"old bytes");

    let mgr = TaskQueueManager::new();
    let id = mgr.create_task(TaskType::Move, vec![src.clone()], target);
    mgr.execute_task(&id);

    wait_for(&mgr, &id, "WaitingForInput", |s| {
        *s == TaskStatus::WaitingForInput
    });
    assert!(mgr.resolve_conflict(&id, "overwrite"));

    assert_eq!(wait_for_terminal(&mgr, &id), TaskStatus::Completed);
    assert_eq!(read(&dst), b"new bytes");
    assert!(!Path::new(&src).exists());
}

/// The case P0.6's own doc comment called out: cancelling mid-copy used to leave
/// the destination truncated, because `File::create` had already emptied it and
/// the window was "as wide as the file is large".
#[test]
fn invariant_cancelling_a_queued_overwrite_leaves_the_destination_whole() {
    let t = TestDir::new("p15_cancel");
    // Big enough that the copy spans many chunks, so the cancel lands mid-copy.
    let payload = vec![b'n'; 8 * 1024 * 1024];
    let src = t.file("a.txt", &payload);
    let target = t.dir("target");
    let dst = t.file("target/a.txt", b"the original contents");

    let mgr = TaskQueueManager::new();
    let id = mgr.create_task(TaskType::Copy, vec![src], target);
    mgr.execute_task(&id);

    wait_for(&mgr, &id, "WaitingForInput", |s| {
        *s == TaskStatus::WaitingForInput
    });
    assert!(mgr.resolve_conflict(&id, "overwrite"));
    // Cancel as soon as the copy is under way.
    mgr.cancel_task(&id);
    wait_for_terminal(&mgr, &id);

    let after = read(&dst);
    assert!(
        after == b"the original contents" || after == payload,
        "a cancelled overwrite left the destination in neither state ({} bytes)",
        after.len()
    );
    assert!(
        leftover_staging(&t.path("target")).is_empty(),
        "a cancelled copy must clean up its staging file"
    );
}

#[test]
fn invariant_a_copy_onto_a_symlinked_destination_does_not_write_through_it() {
    // QSF-003 through the copy path.
    #[cfg(unix)]
    {
        let t = TestDir::new("p15_symlink");
        let outside = t.file("outside.txt", b"must not be touched");
        let target = t.dir("target");
        std::os::unix::fs::symlink(&outside, t.path("target").join("a.txt")).unwrap();
        let src = t.file("a.txt", b"replacement");

        let results = vfs::copy_entries(std::slice::from_ref(&src), &target);
        assert!(results[0].success, "{}", results[0].message);
        assert_eq!(read(&outside), b"must not be touched");
        assert_eq!(read(&t.s("target/a.txt")), b"replacement");
    }
}

/// **Flipped at P1.6.** Was
/// `stopgap_batch_rename_temp_names_are_predictable_and_clobber`, and it
/// reproduced real data loss: `batch_rename` staged through
/// `{source}.nc_rename_tmp_{index}`, and `fs::rename` onto that name destroyed
/// whatever was already there — including a file left behind by a crashed
/// earlier batch — without reporting anything.
///
/// Staging names are now `.nc-rename-<uuid>`.
#[test]
fn invariant_batch_rename_does_not_clobber_a_file_at_the_old_temp_name() {
    let t = TestDir::new("p16_batch_tmp");
    let a = t.file("a.txt", b"a");
    // The name the old implementation would have staged index 0 through.
    let victim = t.file("a.txt.nc_rename_tmp_0", b"an innocent bystander");

    let results = vfs::batch_rename(vec![(a, t.s("renamed.txt"))]);
    assert!(results[0].success, "{}", results[0].message);
    assert_eq!(read(&t.s("renamed.txt")), b"a");
    assert_eq!(
        read(&victim),
        b"an innocent bystander",
        "the unrelated file must survive"
    );
}

#[test]
fn invariant_batch_rename_leaves_no_staging_names_behind() {
    let t = TestDir::new("p16_batch_clean");
    let a = t.file("a.txt", b"a");
    let b = t.file("b.txt", b"b");

    // A swap forces both entries through staging.
    let results = vfs::batch_rename(vec![(a.clone(), b.clone()), (b.clone(), a.clone())]);
    assert!(results.iter().all(|r| r.success));
    assert_eq!(read(&a), b"b");
    assert_eq!(read(&b), b"a");

    let leftovers: Vec<String> = fs::read_dir(&t.0)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with(".nc-rename-") || n.contains("nc_rename_tmp"))
        .collect();
    assert!(
        leftovers.is_empty(),
        "staging names left behind: {:?}",
        leftovers
    );
}

/// A failed batch must report what state it left behind, not a bare failure.
#[test]
fn invariant_a_failed_batch_rename_reports_a_rollback_outcome() {
    let t = TestDir::new("p16_batch_outcome");
    let a = t.file("a.txt", b"a");
    let b = t.file("b.txt", b"b");

    let results = vfs::batch_rename(vec![
        (a.clone(), t.s("a-renamed.txt")),
        (b.clone(), t.s("no-such-dir/b-renamed.txt")),
    ]);

    assert!(results.iter().any(|r| !r.success));
    // Every entry carries a structured outcome, so the UI can tell a clean
    // rollback from a batch that could not be fully undone (QSF-017).
    for r in &results {
        let outcome = r
            .outcome
            .as_ref()
            .expect("a failed batch must report a structured outcome");
        assert!(
            matches!(
                outcome,
                CommitOutcome::RolledBack { .. } | CommitOutcome::PartiallyCommitted { .. }
            ),
            "unexpected outcome: {:?}",
            outcome
        );
    }
    assert_eq!(read(&a), b"a", "a clean rollback restores both originals");
    assert_eq!(read(&b), b"b");
}

/// Deletes report a structured outcome, so the trash refusal is something the UI
/// can act on rather than an opaque error string.
#[test]
fn invariant_a_delete_reports_a_structured_outcome() {
    let t = TestDir::new("p16_delete_outcome");
    let f = t.file("gone.txt", b"x");

    let res = vfs::delete_entry(&f, false, DeleteMode::Permanent);
    assert!(res.success);
    assert_eq!(res.outcome, Some(CommitOutcome::Committed));

    let missing = vfs::delete_entry(&t.s("never-existed"), false, DeleteMode::Permanent);
    assert!(!missing.success);
}

/// P1.6: keep-both copies alongside the existing entry instead of choosing
/// between them — the only resolution that cannot lose data.
#[test]
fn invariant_queue_keep_both_copies_alongside_the_existing_file() {
    let t = TestDir::new("p16_keep_both");
    let src = t.file("report.pdf", b"new version");
    let target = t.dir("target");
    let existing = t.file("target/report.pdf", b"existing version");

    let mgr = TaskQueueManager::new();
    let id = mgr.create_task(TaskType::Copy, vec![src], target);
    mgr.execute_task(&id);

    wait_for(&mgr, &id, "WaitingForInput", |s| {
        *s == TaskStatus::WaitingForInput
    });
    assert!(mgr.resolve_conflict(&id, "keep_both"));

    assert_eq!(
        wait_for_terminal(&mgr, &id),
        TaskStatus::Completed,
        "error: {:?}",
        mgr.get_task(&id).and_then(|t| t.error)
    );
    assert_eq!(read(&existing), b"existing version", "neither copy is lost");
    assert_eq!(
        read(&t.s("target/report (2).pdf")),
        b"new version",
        "the extension must be preserved so the file still opens correctly"
    );
}

#[test]
fn invariant_an_unknown_conflict_resolution_is_refused() {
    // Defaulting an unrecognised resolution would pick a destructive action for
    // the user on the strength of a typo.
    let t = TestDir::new("p16_bad_resolution");
    let src = t.file("a.txt", b"new");
    let target = t.dir("target");
    t.file("target/a.txt", b"old");

    let mgr = TaskQueueManager::new();
    let id = mgr.create_task(TaskType::Copy, vec![src], target);
    mgr.execute_task(&id);
    wait_for(&mgr, &id, "WaitingForInput", |s| {
        *s == TaskStatus::WaitingForInput
    });

    assert!(!mgr.resolve_conflict(&id, "obliterate"));
    assert_eq!(
        mgr.get_task(&id).unwrap().status,
        TaskStatus::WaitingForInput,
        "the task must still be waiting"
    );

    mgr.cancel_task(&id);
    wait_for_terminal(&mgr, &id);
}

#[test]
fn invariant_batch_rename_case_only_rename() {
    let t = TestDir::new("batch_case_rename");
    let original = t.file("arr.txt", b"original content");
    let target = t.s("Arr.txt");

    let results = vfs::batch_rename(vec![(original.clone(), target.clone())]);
    assert!(results[0].success, "{}", results[0].message);
    assert_eq!(read(&target), b"original content");

    let leftovers: Vec<String> = fs::read_dir(&t.0)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with(".nc-rename-"))
        .collect();
    assert!(
        leftovers.is_empty(),
        "leftover staging files: {:?}",
        leftovers
    );
}
