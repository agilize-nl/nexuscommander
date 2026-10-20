//! The safe mutation engine (Phase 1 of the QSF plan).
//!
//! Plan section 6 describes one pipeline that every mutating feature converges
//! on:
//!
//! ```text
//! UI intent
//!   -> validated, versioned OperationSpec
//!   -> asynchronous preflight and immutable operation plan
//!   -> bounded JobManager with one runner per job
//!   -> platform filesystem adapter + PathPolicy
//!   -> stage output in destination filesystem
//!   -> verify content/metadata and sync as required
//!   -> atomic commit
//!   -> source cleanup only after commit
//!   -> durable structured result and recovery record
//! ```
//!
//! It arrives in pieces, and the vocabulary lands before the behavior so that
//! each behavioural commit reads as a behaviour change rather than as type
//! churn (plan section 14, step 5).
//!
//! | Module | Item | Status |
//! |---|---|---|
//! | [`spec`] — `OperationSpec` and the four policies | P1.1 | defined, **not yet honoured** |
//! | [`outcome`] — `CommitOutcome` and the journal | P1.1 | defined, **not yet produced** |
//! | [`path_policy`] — no-follow resolution | P1.2 | **written**, not yet wired in |
//! | [`job`] — bounded scheduler and job state machine | P1.3 | **written**, wired into `task_queue` |
//! | [`commit`] — staging, verification, atomic commit | P1.4 | **written** |
//!
//! Until `commit` exists, `crate::safety` refuses every replacement. P1.5
//! deletes that module and proves the replacement in the same commit.

pub mod commit;
pub mod job;
pub mod outcome;
pub mod path_policy;
pub mod spec;
