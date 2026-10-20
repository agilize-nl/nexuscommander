//! P1.3 — the bounded job scheduler and the job state machine.
//!
//! Two separate problems, both in `task_queue.rs` today.
//!
//! # 1. Blocking filesystem work on the async runtime
//!
//! `execute_task` hands `execute_copy`/`execute_move`/`execute_delete` — which
//! are ordinary synchronous `fs` loops, containing `thread::sleep` — to
//! `tauri::async_runtime::spawn`. That parks a tokio worker for the entire
//! duration of a multi-gigabyte copy. There is no bound on how many run at once
//! and nothing that could impose one. [`Scheduler`] replaces it with dedicated
//! OS threads and a hard cap.
//!
//! # 2. The bound and the conflict dialog are in direct conflict
//!
//! A job that hits a name collision parks on `WaitingForInput` until the user
//! answers, which may be never. If the bound applied to *threads*, N parked
//! jobs would deadlock the queue: no worker free, and no worker able to become
//! free without a user who is waiting for a job that cannot start.
//!
//! The three ways out (recorded in the Fase 1 plan) were: release and re-queue a
//! parked job, which needs resumable mid-flight operations; exempt parked jobs
//! from the bound, which means the bound stops bounding anything; or move
//! conflict resolution into preflight, which is what plan section 6 describes
//! but changes the UX from one-at-a-time-mid-copy to all-up-front.
//!
//! This module takes a fourth: **bound the two resources separately.**
//!
//! - **Threads** are capped hard ([`Scheduler::MAX_WORKERS`]). Past the cap,
//!   starting a job fails loudly instead of spawning without limit.
//! - **Filesystem concurrency** is a separate counting semaphore
//!   ([`IoPermits`]). A job holds a permit only while it is actually doing I/O,
//!   and [`Permit::park`] hands it back the moment the job blocks on a user
//!   decision or a pause.
//!
//! So a parked job costs a thread but not a share of the disk, three jobs
//! waiting on three dialogs cannot stop a fourth from copying, and the number
//! that hammer the filesystem at once stays bounded. Conflict UX is unchanged;
//! moving it to preflight stays the target for P1.6 and is no longer forced by
//! a deadlock.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use super::spec::OperationSpec;

/// Where a job is in its lifecycle.
///
/// Mirrors `task_queue::TaskStatus` one-for-one so the wire format is unchanged
/// (P1.3 does not alter `TaskInfo`). What it adds is a transition table: today
/// the legal moves are implied by scattered `if t.status == …` checks, and
/// nothing stops a stale handle writing `Running` over `Cancelled`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum JobState {
    Queued,
    Running,
    Paused,
    /// Blocked on a conflict decision from the user. Holds a thread, but no
    /// I/O permit.
    WaitingForDecision,
    Completed,
    Failed,
    Cancelled,
}

impl JobState {
    /// No further transition is possible.
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            JobState::Completed | JobState::Failed | JobState::Cancelled
        )
    }

    /// A worker thread is dedicated to this job.
    pub fn holds_a_worker(self) -> bool {
        matches!(
            self,
            JobState::Running | JobState::Paused | JobState::WaitingForDecision
        )
    }

    /// The job is doing filesystem work and should count against [`IoPermits`].
    ///
    /// Deliberately only `Running`. A paused or parked job is occupying a
    /// thread but not the disk, and charging it for I/O is exactly what would
    /// deadlock the queue.
    pub fn consumes_io_permit(self) -> bool {
        self == JobState::Running
    }

    /// Whether `self -> next` is a legal move.
    ///
    /// The one rule worth stating outright: **nothing leaves a terminal state.**
    /// `execute_task` currently guards only against restarting a `Running` or
    /// `WaitingForInput` task, so a second `execute` on a *cancelled* task
    /// re-enters `Running` and starts a second worker over the same paths.
    pub fn can_transition_to(self, next: JobState) -> bool {
        use JobState::*;
        if self.is_terminal() {
            return false;
        }
        match (self, next) {
            // Starting work.
            (Queued, Running) => true,
            // A queued job can be abandoned before it ever starts.
            (Queued, Cancelled) => true,

            // Ordinary progress and parking.
            (Running, Paused | WaitingForDecision) => true,
            (Paused | WaitingForDecision, Running) => true,

            // Any active state can finish or be cancelled.
            (Running | Paused | WaitingForDecision, Completed | Failed | Cancelled) => true,

            // Everything else, including Queued -> Completed (a job that never
            // ran cannot have succeeded) and any self-transition.
            _ => false,
        }
    }
}

/// A counting semaphore over concurrent filesystem work.
///
/// Not a thread pool: threads are handed out by [`Scheduler`]. This bounds how
/// many jobs touch the disk at once, which is the resource that actually
/// contends — twenty simultaneous tree copies do not go twenty times faster,
/// they go slower and make progress reporting meaningless.
pub struct IoPermits {
    available: Mutex<usize>,
    released: Condvar,
    capacity: usize,
}

impl IoPermits {
    pub fn new(capacity: usize) -> Arc<Self> {
        assert!(
            capacity > 0,
            "an IoPermits capacity of 0 can never be acquired"
        );
        Arc::new(IoPermits {
            available: Mutex::new(capacity),
            released: Condvar::new(),
            capacity,
        })
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    /// Permits not currently held. Test and diagnostic use.
    pub fn available(&self) -> usize {
        *self.available.lock().unwrap()
    }

    /// Take a permit, blocking until one is free.
    pub fn acquire(self: &Arc<Self>) -> Permit {
        self.take();
        Permit {
            owner: Arc::clone(self),
            held: true,
        }
    }

    /// Take a permit, giving up after `timeout`.
    ///
    /// Used where blocking forever would be worse than failing — a job that can
    /// never start should say so rather than hang.
    pub fn acquire_timeout(self: &Arc<Self>, timeout: Duration) -> Option<Permit> {
        let deadline = Instant::now() + timeout;
        let mut available = self.available.lock().unwrap();
        while *available == 0 {
            let remaining = deadline.checked_duration_since(Instant::now())?;
            let (guard, wait) = self
                .released
                .wait_timeout(available, remaining)
                .expect("IoPermits mutex poisoned");
            available = guard;
            if wait.timed_out() && *available == 0 {
                return None;
            }
        }
        *available -= 1;
        drop(available);
        Some(Permit {
            owner: Arc::clone(self),
            held: true,
        })
    }

    fn take(&self) {
        let mut available = self.available.lock().unwrap();
        while *available == 0 {
            available = self.released.wait(available).expect("IoPermits poisoned");
        }
        *available -= 1;
    }

    fn give_back(&self) {
        let mut available = self.available.lock().unwrap();
        *available += 1;
        debug_assert!(
            *available <= self.capacity,
            "released more permits than exist"
        );
        self.released.notify_one();
    }
}

/// The right to do filesystem work. Returned automatically on drop.
pub struct Permit {
    owner: Arc<IoPermits>,
    held: bool,
}

impl Permit {
    /// Whether this permit is currently held rather than parked.
    pub fn is_held(&self) -> bool {
        self.held
    }

    /// Hand the permit back while the job waits on something that is not I/O.
    ///
    /// This is the call that makes the bound safe to impose. Without it, a job
    /// sitting on a conflict dialog holds a share of the filesystem budget for
    /// as long as the user takes to answer — which may be until they go home.
    /// Idempotent: parking an already-parked permit does nothing.
    pub fn park(&mut self) {
        if self.held {
            self.held = false;
            self.owner.give_back();
        }
    }

    /// Take the permit back before resuming I/O. Blocks if the pool is
    /// saturated, which is the point — the job resumes when there is room.
    /// Idempotent.
    pub fn unpark(&mut self) {
        if !self.held {
            self.owner.take();
            self.held = true;
        }
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        self.park();
    }
}

/// Dedicated OS threads for blocking filesystem work, with a hard cap.
#[derive(Clone)]
pub struct Scheduler {
    live_workers: Arc<AtomicUsize>,
    permits: Arc<IoPermits>,
    max_workers: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub enum SpawnError {
    /// The worker cap was reached. Reported rather than queued, because the
    /// caller has to tell the user their operation did not start — silently
    /// dropping it is QSF-017.
    AtCapacity { live: usize, max: usize },
}

impl std::fmt::Display for SpawnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SpawnError::AtCapacity { live, max } => write!(
                f,
                "Too many operations are already running ({} of a maximum {}). \
                 Wait for one to finish, or cancel one, and try again.",
                live, max
            ),
        }
    }
}

impl std::error::Error for SpawnError {}

impl Default for Scheduler {
    fn default() -> Self {
        Scheduler::new(Scheduler::MAX_WORKERS, Scheduler::DEFAULT_IO_CONCURRENCY)
    }
}

impl Scheduler {
    /// Hard cap on live worker threads.
    ///
    /// Sits below `task_queue::MAX_TRACKED_TASKS` (500) on purpose: that cap
    /// never evicts an *active* task, so without a separate worker cap a user
    /// who queues 500 operations gets 500 threads.
    pub const MAX_WORKERS: usize = 32;

    /// How many jobs may touch the filesystem at once.
    ///
    /// Small and deliberately not derived from the core count: this bounds
    /// contention on a disk, not CPU parallelism. Concurrent bulk copies past a
    /// handful make everything slower and turn every ETA into noise.
    pub const DEFAULT_IO_CONCURRENCY: usize = 4;

    pub fn new(max_workers: usize, io_concurrency: usize) -> Self {
        Scheduler {
            live_workers: Arc::new(AtomicUsize::new(0)),
            permits: IoPermits::new(io_concurrency),
            max_workers,
        }
    }

    pub fn permits(&self) -> &Arc<IoPermits> {
        &self.permits
    }

    /// Worker threads currently alive.
    pub fn live_workers(&self) -> usize {
        self.live_workers.load(Ordering::SeqCst)
    }

    /// Run `work` on a dedicated blocking thread, holding an I/O permit.
    ///
    /// `work` receives its [`Permit`] so it can [`Permit::park`] while waiting
    /// on a user decision. The permit is released when `work` returns, whatever
    /// it returns and even if it panics.
    pub fn spawn<F>(&self, name: &str, work: F) -> Result<(), SpawnError>
    where
        F: FnOnce(&mut Permit) + Send + 'static,
    {
        // Reserve the slot before spawning: checking then spawning would let two
        // callers both see room and both take the last one.
        let mut live = self.live_workers.load(Ordering::SeqCst);
        loop {
            if live >= self.max_workers {
                return Err(SpawnError::AtCapacity {
                    live,
                    max: self.max_workers,
                });
            }
            match self.live_workers.compare_exchange(
                live,
                live + 1,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => break,
                Err(actual) => live = actual,
            }
        }

        let permits = Arc::clone(&self.permits);
        let live_workers = Arc::clone(&self.live_workers);
        let spawned = std::thread::Builder::new()
            .name(format!("nc-job-{}", name))
            .spawn(move || {
                // Decrement on the way out however we leave, including a panic
                // inside `work` — leaking a slot per panic would eventually
                // wedge the scheduler with no live threads at all.
                let _guard = WorkerSlot(live_workers);
                let mut permit = permits.acquire();
                work(&mut permit);
            });

        if spawned.is_err() {
            // The OS refused the thread; give the slot back rather than leaking it.
            self.live_workers.fetch_sub(1, Ordering::SeqCst);
            return Err(SpawnError::AtCapacity {
                live: self.live_workers(),
                max: self.max_workers,
            });
        }
        Ok(())
    }
}

/// Decrements the live-worker count when the thread unwinds or returns.
struct WorkerSlot(Arc<AtomicUsize>);

impl Drop for WorkerSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Everything known about one job.
///
/// Plan section 6's `JobRecord`. Not yet the storage `task_queue` uses — that
/// still keeps `Task` so `TaskInfo` stays byte-identical on the wire — but it is
/// the shape the queue converges on in P1.6, and the state machine above is
/// already shared.
#[derive(Debug, Clone)]
pub struct JobRecord {
    pub id: String,
    pub spec: OperationSpec,
    pub state: JobState,
    pub created_at: Instant,
    pub started_at: Option<Instant>,
    pub finished_at: Option<Instant>,
    pub progress: Progress,
    pub error: Option<String>,
    pub outcome: Option<super::outcome::CommitOutcome>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Progress {
    pub total_bytes: u64,
    pub transferred_bytes: u64,
    pub total_files: u32,
    pub processed_files: u32,
}

impl Progress {
    /// Progress invariants from plan section 8.1: monotonic, finite, bounded.
    ///
    /// Worth asserting rather than assuming — the current queue adds the *whole
    /// source size* to `transferred_bytes` when a conflict is skipped, so the
    /// counter can exceed what was actually moved.
    pub fn is_consistent(&self) -> bool {
        self.transferred_bytes <= self.total_bytes && self.processed_files <= self.total_files
    }
}

impl JobRecord {
    pub fn new(id: String, spec: OperationSpec) -> Self {
        JobRecord {
            id,
            spec,
            state: JobState::Queued,
            created_at: Instant::now(),
            started_at: None,
            finished_at: None,
            progress: Progress::default(),
            error: None,
            outcome: None,
        }
    }

    /// Apply a state transition, refusing illegal ones.
    ///
    /// Returns whether the move was made. A refused transition is not an error
    /// the user needs to see — it means a stale handle tried to act on a job
    /// that has already moved on — but it must not silently *succeed*.
    pub fn transition_to(&mut self, next: JobState) -> bool {
        if !self.state.can_transition_to(next) {
            return false;
        }
        if next == JobState::Running && self.started_at.is_none() {
            self.started_at = Some(Instant::now());
        }
        if next.is_terminal() {
            self.finished_at = Some(Instant::now());
        }
        self.state = next;
        true
    }
}

/// A bounded registry of jobs sharing one [`Scheduler`].
///
/// P1.6 moves `task_queue`'s storage here. For now this is the scheduler plus
/// the record type, so the concurrency behaviour has something to be tested
/// against independently of the copy/move code.
#[derive(Clone)]
pub struct JobManager {
    jobs: Arc<Mutex<HashMap<String, JobRecord>>>,
    scheduler: Scheduler,
}

impl Default for JobManager {
    fn default() -> Self {
        JobManager::new(Scheduler::default())
    }
}

impl JobManager {
    pub fn new(scheduler: Scheduler) -> Self {
        JobManager {
            jobs: Arc::new(Mutex::new(HashMap::new())),
            scheduler,
        }
    }

    pub fn scheduler(&self) -> &Scheduler {
        &self.scheduler
    }

    pub fn insert(&self, record: JobRecord) {
        self.jobs.lock().unwrap().insert(record.id.clone(), record);
    }

    pub fn get(&self, id: &str) -> Option<JobRecord> {
        self.jobs.lock().unwrap().get(id).cloned()
    }

    /// Apply a transition to a stored job. `false` if the job is unknown or the
    /// move is illegal.
    pub fn transition(&self, id: &str, next: JobState) -> bool {
        let mut jobs = self.jobs.lock().unwrap();
        match jobs.get_mut(id) {
            Some(job) => job.transition_to(next),
            None => false,
        }
    }

    /// Jobs currently occupying a worker thread.
    pub fn active_count(&self) -> usize {
        self.jobs
            .lock()
            .unwrap()
            .values()
            .filter(|j| j.state.holds_a_worker())
            .count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::spec::OperationKind;
    use std::sync::mpsc;

    fn record(id: &str) -> JobRecord {
        JobRecord::new(
            id.to_string(),
            OperationSpec::new(OperationKind::Copy, vec!["/a".into()], Some("/b".into())),
        )
    }

    // ===== state machine =====

    #[test]
    fn a_terminal_state_is_a_dead_end() {
        for terminal in [JobState::Completed, JobState::Failed, JobState::Cancelled] {
            for next in [
                JobState::Queued,
                JobState::Running,
                JobState::Paused,
                JobState::WaitingForDecision,
                JobState::Completed,
            ] {
                assert!(
                    !terminal.can_transition_to(next),
                    "{:?} -> {:?} must be refused",
                    terminal,
                    next
                );
            }
        }
    }

    #[test]
    fn a_cancelled_job_cannot_be_restarted() {
        // The concrete gap this table closes: execute_task guards only against
        // restarting Running/WaitingForInput, so a second execute on a
        // cancelled task re-entered Running and started a second worker over
        // the same paths.
        let mut job = record("j");
        assert!(job.transition_to(JobState::Running));
        assert!(job.transition_to(JobState::Cancelled));
        assert!(
            !job.transition_to(JobState::Running),
            "a cancelled job must not re-enter Running"
        );
        assert_eq!(job.state, JobState::Cancelled);
    }

    #[test]
    fn a_queued_job_cannot_report_success_without_running() {
        let mut job = record("j");
        assert!(!job.transition_to(JobState::Completed));
        assert_eq!(job.state, JobState::Queued);
    }

    #[test]
    fn parking_and_resuming_are_both_legal() {
        let mut job = record("j");
        assert!(job.transition_to(JobState::Running));
        assert!(job.transition_to(JobState::WaitingForDecision));
        assert!(job.transition_to(JobState::Running));
        assert!(job.transition_to(JobState::Paused));
        assert!(job.transition_to(JobState::Running));
        assert!(job.transition_to(JobState::Completed));
    }

    #[test]
    fn timestamps_are_stamped_by_the_transition_not_the_caller() {
        let mut job = record("j");
        assert!(job.started_at.is_none());
        job.transition_to(JobState::Running);
        assert!(job.started_at.is_some());
        assert!(job.finished_at.is_none());
        job.transition_to(JobState::Failed);
        assert!(job.finished_at.is_some());
    }

    #[test]
    fn only_running_is_charged_for_io() {
        assert!(JobState::Running.consumes_io_permit());
        // The whole reason the bound is safe to impose.
        assert!(!JobState::WaitingForDecision.consumes_io_permit());
        assert!(!JobState::Paused.consumes_io_permit());

        // ...but a parked job is still occupying a thread.
        assert!(JobState::WaitingForDecision.holds_a_worker());
        assert!(JobState::Paused.holds_a_worker());
        assert!(!JobState::Completed.holds_a_worker());
    }

    // ===== permits =====

    #[test]
    fn permits_are_returned_on_drop() {
        let permits = IoPermits::new(2);
        {
            let _a = permits.acquire();
            let _b = permits.acquire();
            assert_eq!(permits.available(), 0);
        }
        assert_eq!(permits.available(), 2);
    }

    #[test]
    fn a_saturated_pool_blocks_until_a_permit_comes_back() {
        let permits = IoPermits::new(1);
        let held = permits.acquire();

        assert!(
            permits.acquire_timeout(Duration::from_millis(50)).is_none(),
            "the pool is full; the second acquire must not succeed"
        );

        drop(held);
        assert!(permits.acquire_timeout(Duration::from_millis(50)).is_some());
    }

    #[test]
    fn parking_frees_the_permit_for_another_job() {
        // The deadlock this design exists to prevent: with a capacity of one, a
        // job sitting on a conflict dialog would otherwise own the filesystem
        // budget until the user answered.
        let permits = IoPermits::new(1);
        let mut parked = permits.acquire();
        assert_eq!(permits.available(), 0);

        parked.park();
        assert_eq!(permits.available(), 1, "a parked job releases its permit");
        assert!(!parked.is_held());

        let other = permits
            .acquire_timeout(Duration::from_millis(50))
            .expect("another job must be able to run while the first is parked");

        // And the parked job waits its turn rather than double-spending.
        drop(other);
        parked.unpark();
        assert!(parked.is_held());
        assert_eq!(permits.available(), 0);
    }

    #[test]
    fn park_and_unpark_are_idempotent() {
        let permits = IoPermits::new(2);
        let mut p = permits.acquire();
        p.park();
        p.park();
        assert_eq!(
            permits.available(),
            2,
            "a double park must not conjure a second permit"
        );
        p.unpark();
        p.unpark();
        assert_eq!(permits.available(), 1);
    }

    // ===== scheduler =====

    #[test]
    fn work_runs_on_a_dedicated_thread_not_the_async_runtime() {
        let scheduler = Scheduler::default();
        let (tx, rx) = mpsc::channel();

        scheduler
            .spawn("test", move |_permit| {
                let name = std::thread::current()
                    .name()
                    .unwrap_or_default()
                    .to_string();
                tx.send(name).unwrap();
            })
            .unwrap();

        let name = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(
            name.starts_with("nc-job-"),
            "unexpected thread name: {}",
            name
        );
    }

    #[test]
    fn the_worker_cap_is_reported_rather_than_exceeded() {
        let scheduler = Scheduler::new(2, 4);
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let release_rx = Arc::new(Mutex::new(release_rx));

        for _ in 0..2 {
            let rx = Arc::clone(&release_rx);
            scheduler
                .spawn("blocker", move |_permit| {
                    let _ = rx.lock().unwrap().recv();
                })
                .unwrap();
        }

        // Wait for both to actually be live before asserting the cap.
        let deadline = Instant::now() + Duration::from_secs(5);
        while scheduler.live_workers() < 2 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }

        let err = scheduler.spawn("overflow", |_| {}).unwrap_err();
        assert_eq!(err, SpawnError::AtCapacity { live: 2, max: 2 });
        // The user has to be told; a dropped operation is QSF-017.
        assert!(err.to_string().contains("Too many operations"));

        let _ = release_tx.send(());
        let _ = release_tx.send(());
    }

    #[test]
    fn a_panicking_job_gives_its_worker_slot_back() {
        // Leaking a slot per panic would wedge the scheduler at the cap with no
        // live threads at all.
        let scheduler = Scheduler::new(1, 1);
        scheduler
            .spawn("panics", |_permit| panic!("deliberate test panic"))
            .unwrap();

        let deadline = Instant::now() + Duration::from_secs(5);
        while scheduler.live_workers() > 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(scheduler.live_workers(), 0);
        assert_eq!(
            scheduler.permits().available(),
            1,
            "the permit must come back too"
        );

        scheduler
            .spawn("after", |_| {})
            .expect("the scheduler must still be usable after a panicking job");
    }

    #[test]
    fn io_concurrency_is_bounded_independently_of_the_worker_cap() {
        // Four workers allowed, but only two may touch the filesystem at once.
        let scheduler = Scheduler::new(4, 2);
        let peak = Arc::new(AtomicUsize::new(0));
        let current = Arc::new(AtomicUsize::new(0));
        let (done_tx, done_rx) = mpsc::channel();

        for _ in 0..4 {
            let peak = Arc::clone(&peak);
            let current = Arc::clone(&current);
            let done = done_tx.clone();
            scheduler
                .spawn("io", move |_permit| {
                    let now = current.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    std::thread::sleep(Duration::from_millis(60));
                    current.fetch_sub(1, Ordering::SeqCst);
                    let _ = done.send(());
                })
                .unwrap();
        }
        drop(done_tx);

        for _ in 0..4 {
            done_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        }
        assert!(
            peak.load(Ordering::SeqCst) <= 2,
            "io concurrency reached {} with a bound of 2",
            peak.load(Ordering::SeqCst)
        );
    }

    #[test]
    fn a_parked_job_does_not_block_another_from_doing_io() {
        // The deadlock case, end to end: with a filesystem budget of one, a job
        // parked on a decision must not stop a second job from running.
        let scheduler = Scheduler::new(4, 1);
        let (parked_tx, parked_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let (ran_tx, ran_rx) = mpsc::channel();

        scheduler
            .spawn("parker", move |permit| {
                permit.park();
                parked_tx.send(()).unwrap();
                let _ = release_rx.recv();
            })
            .unwrap();

        parked_rx.recv_timeout(Duration::from_secs(5)).unwrap();

        scheduler
            .spawn("worker", move |_permit| {
                ran_tx.send(()).unwrap();
            })
            .unwrap();

        ran_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("a parked job must not hold the filesystem budget");

        let _ = release_tx.send(());
    }

    // ===== manager =====

    #[test]
    fn the_manager_refuses_an_illegal_transition_on_a_stored_job() {
        let manager = JobManager::default();
        manager.insert(record("j"));

        assert!(manager.transition("j", JobState::Running));
        assert!(manager.transition("j", JobState::Completed));
        assert!(!manager.transition("j", JobState::Running));
        assert_eq!(manager.get("j").unwrap().state, JobState::Completed);
    }

    #[test]
    fn an_unknown_job_transitions_to_nothing() {
        assert!(!JobManager::default().transition("nope", JobState::Running));
    }

    #[test]
    fn active_count_counts_workers_not_records() {
        let manager = JobManager::default();
        manager.insert(record("running"));
        manager.insert(record("parked"));
        manager.insert(record("finished"));

        manager.transition("running", JobState::Running);
        manager.transition("parked", JobState::Running);
        manager.transition("parked", JobState::WaitingForDecision);
        manager.transition("finished", JobState::Running);
        manager.transition("finished", JobState::Completed);

        assert_eq!(manager.active_count(), 2);
    }

    #[test]
    fn progress_notices_an_impossible_counter() {
        assert!(Progress::default().is_consistent());
        assert!(!Progress {
            total_bytes: 10,
            transferred_bytes: 11,
            ..Progress::default()
        }
        .is_consistent());
        assert!(!Progress {
            total_files: 1,
            processed_files: 2,
            ..Progress::default()
        }
        .is_consistent());
    }
}
