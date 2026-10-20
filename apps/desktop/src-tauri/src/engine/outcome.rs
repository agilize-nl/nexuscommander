//! P1.1 — what actually happened, said precisely.
//!
//! Today every mutation answers with `OpResult { success: bool, message: String }`.
//! That shape cannot express the states this codebase genuinely produces: a move
//! whose copy succeeded but whose source deletion failed, a directory tree that
//! is half committed, a cancellation that landed before anything was published
//! versus one that landed after. All of them currently collapse into
//! `success: false` plus prose, which the UI can only display — QSF-017.
//!
//! `CommitOutcome` is the vocabulary from plan section 6, extended by section
//! 6.1's `PartiallyCommitted { journal }`. It exists because no portable
//! primitive commits a populated directory merge atomically, so recursive
//! operations are journaled — per-entry atomic commits plus a durable record of
//! what has committed — and the result has to be able to *say* that rather than
//! implying success.
//!
//! **Nothing produces these variants yet.** P1.4 onwards do. This lands the
//! vocabulary first so the behavioural commits read as behaviour changes.

use serde::{Deserialize, Serialize};

/// The terminal state of a single committed unit of work.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum CommitOutcome {
    /// The destination is published and the operation is complete. For a
    /// source-consuming kind, the source has already been released.
    Committed,

    /// Nothing was attempted, by policy — `ConflictPolicy::Skip`, or a
    /// per-item skip decision. Not a failure.
    Skipped { reason: String },

    /// Cancelled while still staging. The destination was never touched, and
    /// any temporary file has been removed.
    CancelledBeforeCommit,

    /// Something failed after staging began; the staged work was discarded and
    /// the previous destination is intact. This is the outcome the whole
    /// staging protocol exists to make reachable.
    RolledBack { reason: String },

    /// A move whose destination committed but whose source could not be
    /// released. Data is safe and duplicated — the user has to be told, because
    /// it looks like a completed move until they notice the source is still
    /// there.
    CopiedSourceRetained { source: String, reason: String },

    /// A recursive operation interrupted between per-entry commits. Section 6.1:
    /// this is not a failure and not a success, and it is the honest answer for
    /// any tree operation that did not run to completion.
    PartiallyCommitted { journal: Journal },

    /// Neither the old nor the new state can be established automatically. The
    /// rarest and most serious outcome; it must reach the user with the paths
    /// involved, never only the console.
    ManualRecoveryRequired { detail: String, paths: Vec<String> },
}

impl CommitOutcome {
    /// Whether the destination now holds the intended new content, in full.
    ///
    /// Deliberately narrow. `PartiallyCommitted` and `CopiedSourceRetained` are
    /// **not** success: treating them as such is precisely the "implying
    /// success" the plan forbids for tree operations.
    pub fn is_fully_committed(&self) -> bool {
        matches!(self, CommitOutcome::Committed)
    }

    /// Whether the previous destination content is still intact.
    ///
    /// The question that matters for data loss, and a different question from
    /// whether the operation succeeded.
    pub fn destination_preserved(&self) -> bool {
        matches!(
            self,
            CommitOutcome::Skipped { .. }
                | CommitOutcome::CancelledBeforeCommit
                | CommitOutcome::RolledBack { .. }
        )
    }

    /// Whether this outcome must be surfaced to the user rather than logged.
    ///
    /// `CLAUDE.md`: "A destructive failure that only reaches the console is a
    /// bug." A plain success and a policy skip are the only two that may pass
    /// quietly.
    pub fn requires_user_attention(&self) -> bool {
        !matches!(
            self,
            CommitOutcome::Committed | CommitOutcome::Skipped { .. }
        )
    }
}

/// The durable record of a partially committed recursive operation.
///
/// It has to be enough to describe the state to a user *and* to resume, since a
/// tree operation that stops halfway with no record leaves a destination nobody
/// can reason about.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Journal {
    /// Destination paths that are fully published.
    pub committed: Vec<String>,
    /// Entries that were skipped by policy, with the reason.
    pub skipped: Vec<JournalSkip>,
    /// Entries that failed, with the reason. Their destinations are untouched.
    pub failed: Vec<JournalFailure>,
    /// Source paths not yet attempted, so a resume knows where to pick up.
    pub remaining: Vec<String>,
    /// Staging files that could not be cleaned up. Left here rather than
    /// forgotten: an orphaned temp file in the user's directory needs naming.
    pub orphaned_staging: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JournalSkip {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JournalFailure {
    pub path: String,
    pub reason: String,
}

impl Journal {
    /// Whether anything at all was published.
    ///
    /// A journal with nothing committed and nothing orphaned describes an
    /// operation that never started, which should be reported as cancelled or
    /// rolled back rather than as partial.
    pub fn touched_the_destination(&self) -> bool {
        !self.committed.is_empty() || !self.orphaned_staging.is_empty()
    }

    /// One line for the user. Counts, not paths — the paths belong in the
    /// detail view, and a summary that lists 4000 files is not a summary.
    pub fn summary(&self) -> String {
        format!(
            "{} committed, {} skipped, {} failed, {} not attempted",
            self.committed.len(),
            self.skipped.len(),
            self.failed.len(),
            self.remaining.len()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn journal() -> Journal {
        Journal {
            committed: vec!["/dst/a".into()],
            skipped: vec![JournalSkip {
                path: "/dst/b".into(),
                reason: "exists".into(),
            }],
            failed: vec![JournalFailure {
                path: "/dst/c".into(),
                reason: "permission denied".into(),
            }],
            remaining: vec!["/src/d".into()],
            orphaned_staging: vec![],
        }
    }

    #[test]
    fn only_committed_counts_as_fully_committed() {
        assert!(CommitOutcome::Committed.is_fully_committed());

        // The two that most look like success and are not.
        assert!(!CommitOutcome::PartiallyCommitted { journal: journal() }.is_fully_committed());
        assert!(!CommitOutcome::CopiedSourceRetained {
            source: "/src/a".into(),
            reason: "device busy".into(),
        }
        .is_fully_committed());
    }

    #[test]
    fn the_outcomes_that_leave_the_destination_intact_say_so() {
        assert!(CommitOutcome::CancelledBeforeCommit.destination_preserved());
        assert!(CommitOutcome::RolledBack {
            reason: "short write".into()
        }
        .destination_preserved());
        assert!(CommitOutcome::Skipped {
            reason: "policy".into()
        }
        .destination_preserved());

        // A completed replacement did *not* preserve the old destination — that
        // is what the user asked for, but the predicate must not claim it.
        assert!(!CommitOutcome::Committed.destination_preserved());
        assert!(!CommitOutcome::PartiallyCommitted { journal: journal() }.destination_preserved());
    }

    #[test]
    fn every_outcome_except_success_and_skip_reaches_the_user() {
        assert!(!CommitOutcome::Committed.requires_user_attention());
        assert!(!CommitOutcome::Skipped {
            reason: "policy".into()
        }
        .requires_user_attention());

        for outcome in [
            CommitOutcome::CancelledBeforeCommit,
            CommitOutcome::RolledBack { reason: "x".into() },
            CommitOutcome::CopiedSourceRetained {
                source: "/s".into(),
                reason: "x".into(),
            },
            CommitOutcome::PartiallyCommitted { journal: journal() },
            CommitOutcome::ManualRecoveryRequired {
                detail: "x".into(),
                paths: vec![],
            },
        ] {
            assert!(
                outcome.requires_user_attention(),
                "{:?} must not be console-only",
                outcome
            );
        }
    }

    #[test]
    fn an_empty_journal_did_not_touch_the_destination() {
        assert!(!Journal::default().touched_the_destination());

        // Orphaned staging counts even with nothing committed: there is a file
        // sitting in the user's directory that needs explaining.
        let orphaned = Journal {
            orphaned_staging: vec!["/dst/.nc-tmp-1".into()],
            ..Journal::default()
        };
        assert!(orphaned.touched_the_destination());
    }

    #[test]
    fn round_trips_through_serde_with_a_tagged_state() {
        let outcome = CommitOutcome::PartiallyCommitted { journal: journal() };
        let json = serde_json::to_string(&outcome).unwrap();
        assert!(
            json.contains("\"state\":\"partially_committed\""),
            "the TypeScript mirror discriminates on `state`: {}",
            json
        );

        let back: CommitOutcome = serde_json::from_str(&json).unwrap();
        assert_eq!(outcome, back);
    }

    #[test]
    fn journal_summary_reports_counts_not_paths() {
        assert_eq!(
            journal().summary(),
            "1 committed, 1 skipped, 1 failed, 1 not attempted"
        );
    }
}
