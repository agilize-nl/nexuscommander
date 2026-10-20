//! P1.1 — the versioned operation specification.
//!
//! Every mutating feature is supposed to converge on one description of "what
//! was asked for", separate from "how it is being done" (`JobRecord`, P1.3) and
//! from "what happened" (`CommitOutcome`, this module's sibling). Today those
//! three are tangled together in `Task` and in the positional arguments of
//! `pack_archive` — the concentration QSF-022 describes and the reason clippy's
//! `too_many_arguments` is silenced repo-wide.
//!
//! **Nothing honours these policies yet.** This module defines and serializes
//! them; P1.4–P1.7 make the mutation paths obey them. Landing the vocabulary
//! first is deliberate (plan section 14, step 5: "without changing user-visible
//! copy semantics yet") so the behavioural commits are readable as behaviour
//! changes rather than as type churn.
//!
//! # On defaults
//!
//! Defaults are chosen per operation kind rather than globally. Section 6.1 is
//! blunt about why: `fsync` per file plus a directory sync turns a large tree
//! copy into an order-of-magnitude slower operation, and "a safety default so
//! slow that users turn it off protects nobody". A settings write is small and
//! irreplaceable; a 40 GB tree copy is neither.

use serde::{Deserialize, Serialize};

/// Bumped whenever the meaning of an existing field changes.
///
/// A persisted job or recovery record carrying a different version must be read
/// with a migration, never reinterpreted under current semantics — silently
/// applying today's meaning to yesterday's field is how a "resume" turns into a
/// different operation than the user authorized.
pub const POLICY_VERSION: u32 = 1;

/// What the user asked for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OperationSpec {
    /// Absolute source paths, in the order the user selected them.
    pub sources: Vec<String>,
    /// For copy/move: the destination *directory*. For rename: the new path.
    /// For delete: unused.
    pub destination: Option<String>,
    pub kind: OperationKind,
    pub conflict: ConflictPolicy,
    pub symlinks: SymlinkPolicy,
    pub metadata: MetadataPolicy,
    pub verification: VerificationPolicy,
    /// The `POLICY_VERSION` this spec was created under.
    pub policy_version: u32,
}

impl OperationSpec {
    /// A spec with the defaults appropriate to `kind`.
    pub fn new(kind: OperationKind, sources: Vec<String>, destination: Option<String>) -> Self {
        OperationSpec {
            sources,
            destination,
            conflict: ConflictPolicy::default_for(kind),
            symlinks: SymlinkPolicy::default_for(kind),
            metadata: MetadataPolicy::default_for(kind),
            verification: VerificationPolicy::default_for(kind),
            kind,
            policy_version: POLICY_VERSION,
        }
    }

    /// Whether this spec was written by the current policy version.
    ///
    /// Callers that read persisted specs must check this rather than assuming;
    /// see the `POLICY_VERSION` note.
    pub fn is_current_version(&self) -> bool {
        self.policy_version == POLICY_VERSION
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationKind {
    Copy,
    Move,
    Rename,
    Delete,
    /// Writing a file's whole contents — the in-app text editor, settings and
    /// bookmarks. Small, irreplaceable, and the one kind that defaults to a
    /// durable commit.
    Write,
    CreateArchive,
    ExtractArchive,
}

impl OperationKind {
    /// Whether the source stops existing when the operation succeeds.
    ///
    /// Deliberately *not* called "destructive": under QSF-001 every kind here
    /// can destroy its destination, so that word would separate nothing. What
    /// this distinguishes is whether the source is still available to retry
    /// from — which is what decides the commit ordering. Source cleanup happens
    /// only after the destination commit is durable (QSF-002).
    pub fn consumes_source(self) -> bool {
        matches!(
            self,
            OperationKind::Move | OperationKind::Rename | OperationKind::Delete
        )
    }
}

/// What to do when the destination already exists.
///
/// `Ask` is the only variant that needs a round trip to the UI. Per-item
/// decisions are recorded separately in the plan (P1.6) rather than by mutating
/// the spec, so the spec stays an immutable record of what was authorized.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictPolicy {
    Ask,
    Skip,
    /// Replace the destination — only ever through a staged, verified commit.
    /// This is *not* the current `Overwrite`, which truncates in place; that is
    /// exactly what P0.6 refuses and what P1.5 replaces.
    Replace,
    KeepBoth,
    /// Recurse into an existing directory instead of treating it as a conflict.
    /// Meaningless for a file destination and rejected at plan time.
    Merge,
}

impl ConflictPolicy {
    fn default_for(kind: OperationKind) -> Self {
        match kind {
            // A whole-file write is the user editing something they have open;
            // asking whether to replace it would be noise.
            OperationKind::Write => ConflictPolicy::Replace,
            _ => ConflictPolicy::Ask,
        }
    }
}

/// How symlinks encountered in the source or destination are treated.
///
/// QSF-003: nothing in the codebase resolves links by policy today, so a
/// symlinked destination is followed and written through, landing outside the
/// directory the user was looking at.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SymlinkPolicy {
    /// Recreate the link itself. The safe default for copy and move: it cannot
    /// write through a link to somewhere the user did not choose.
    Preserve,
    /// Refuse the operation if any component is a link.
    Reject,
    /// Follow links deliberately, bounded by `max_depth` and with cycle
    /// detection. Never a default — this is the variant that can escape the
    /// operation tree, so it must be an explicit user choice.
    Follow { max_depth: u8 },
}

impl SymlinkPolicy {
    fn default_for(_kind: OperationKind) -> Self {
        SymlinkPolicy::Preserve
    }
}

/// Which metadata to carry across, and what to do when the platform cannot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct MetadataPolicy {
    pub timestamps: bool,
    pub permissions: bool,
    pub ownership: bool,
    pub extended_attributes: bool,
    /// Keep holes in sparse files instead of materialising zeroes. Copying a
    /// sparse 100 GB image densely is a disk-full failure, not a slow success.
    pub preserve_sparse: bool,
    /// What to do when the destination filesystem or platform cannot represent
    /// something requested above.
    pub on_unsupported: UnsupportedMetadata,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnsupportedMetadata {
    /// Carry what can be carried and report the rest in the result. Never
    /// silently: an unreported downgrade is QSF-017.
    WarnAndContinue,
    Fail,
}

impl MetadataPolicy {
    fn default_for(kind: OperationKind) -> Self {
        MetadataPolicy {
            // Current behavior, preserved: every copy path calls
            // preserve_modified_time.
            timestamps: true,
            permissions: matches!(kind, OperationKind::Copy | OperationKind::Move),
            // Requires privilege the app does not have outside elevation, so
            // asking for it by default would fail ordinary copies.
            ownership: false,
            extended_attributes: false,
            preserve_sparse: false,
            on_unsupported: UnsupportedMetadata::WarnAndContinue,
        }
    }
}

/// What must be proven about the destination before the commit is published,
/// and how durable that commit has to be.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerificationPolicy {
    /// Compare the number of bytes written against the source size. Cheap.
    pub byte_count: bool,
    /// Read the destination back and compare a digest. Doubles read I/O.
    pub digest: bool,
    pub durability: Durability,
}

/// How far a write must be pushed before the operation claims to have committed.
///
/// Section 6.1: a post-write readback proves the page cache agrees with what was
/// written, not that the data reached the platter. Only the sync tiers make a
/// durability claim, and no message may imply otherwise.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Durability {
    /// Hand the bytes to the OS and move on.
    None,
    /// Flush userspace buffers. Survives the process dying, not the machine.
    FlushOnly,
    /// `fsync` the file before the commit rename.
    SyncFile,
    /// `fsync` the file *and* the destination directory, so the rename itself
    /// survives a power cut. The only tier that makes the commit durable.
    SyncFileAndDirectory,
}

impl VerificationPolicy {
    fn default_for(kind: OperationKind) -> Self {
        match kind {
            // Small, irreplaceable, and infrequent: the only kind where full
            // durability is worth its cost by default.
            OperationKind::Write => VerificationPolicy {
                byte_count: true,
                digest: false,
                durability: Durability::SyncFileAndDirectory,
            },
            // Bulk data. Byte counts are nearly free; a digest doubles read I/O
            // and per-file fsync is the order-of-magnitude cost section 6.1
            // warns about. Both are available, neither is imposed.
            OperationKind::Copy | OperationKind::Move => VerificationPolicy {
                byte_count: true,
                digest: false,
                durability: Durability::FlushOnly,
            },
            _ => VerificationPolicy {
                byte_count: true,
                digest: false,
                durability: Durability::FlushOnly,
            },
        }
    }

    /// Whether this policy is entitled to tell the user the data is durable.
    ///
    /// The UI must gate its wording on this rather than on "the operation
    /// succeeded".
    pub fn claims_durability(&self) -> bool {
        self.durability >= Durability::SyncFile
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(kind: OperationKind) -> OperationSpec {
        OperationSpec::new(kind, vec!["/a".into()], Some("/b".into()))
    }

    #[test]
    fn new_stamps_the_current_policy_version() {
        let s = spec(OperationKind::Copy);
        assert_eq!(s.policy_version, POLICY_VERSION);
        assert!(s.is_current_version());
    }

    #[test]
    fn a_foreign_policy_version_is_not_treated_as_current() {
        let mut s = spec(OperationKind::Copy);
        s.policy_version = POLICY_VERSION + 1;
        assert!(
            !s.is_current_version(),
            "a spec from another version must not be reinterpreted silently"
        );
    }

    #[test]
    fn round_trips_through_serde_unchanged() {
        for kind in [
            OperationKind::Copy,
            OperationKind::Move,
            OperationKind::Rename,
            OperationKind::Delete,
            OperationKind::Write,
            OperationKind::CreateArchive,
            OperationKind::ExtractArchive,
        ] {
            let original = spec(kind);
            let json = serde_json::to_string(&original).unwrap();
            let back: OperationSpec = serde_json::from_str(&json).unwrap();
            assert_eq!(original, back, "round trip changed the spec for {:?}", kind);
        }
    }

    #[test]
    fn enums_serialize_as_snake_case_for_the_typescript_mirror() {
        // ipc-contract.ts spells these out; serde's default would be `KeepBoth`.
        let json = serde_json::to_string(&ConflictPolicy::KeepBoth).unwrap();
        assert_eq!(json, "\"keep_both\"");
        let json = serde_json::to_string(&Durability::SyncFileAndDirectory).unwrap();
        assert_eq!(json, "\"sync_file_and_directory\"");
        let json = serde_json::to_string(&OperationKind::CreateArchive).unwrap();
        assert_eq!(json, "\"create_archive\"");

        // The one non-obvious shape: a data-carrying variant nests, so the TS
        // mirror is a union of two string literals and an object, not three
        // string literals.
        let json = serde_json::to_string(&SymlinkPolicy::Preserve).unwrap();
        assert_eq!(json, "\"preserve\"");
        let json = serde_json::to_string(&SymlinkPolicy::Follow { max_depth: 8 }).unwrap();
        assert_eq!(json, "{\"follow\":{\"max_depth\":8}}");
    }

    #[test]
    fn symlinks_default_to_preserve_for_every_kind() {
        // Following is the variant that can escape the operation tree (QSF-003),
        // so it must never arrive by default.
        for kind in [
            OperationKind::Copy,
            OperationKind::Move,
            OperationKind::Delete,
            OperationKind::CreateArchive,
            OperationKind::ExtractArchive,
        ] {
            assert_eq!(spec(kind).symlinks, SymlinkPolicy::Preserve, "{:?}", kind);
        }
    }

    #[test]
    fn writes_default_to_a_durable_commit_and_bulk_copies_do_not() {
        assert!(
            spec(OperationKind::Write).verification.claims_durability(),
            "a settings or editor write is small and irreplaceable"
        );
        assert!(
            !spec(OperationKind::Copy).verification.claims_durability(),
            "per-file fsync on a tree copy is the cost section 6.1 warns about"
        );
    }

    #[test]
    fn durability_tiers_are_ordered_weakest_first() {
        // claims_durability() compares with >=, so the ordering is load-bearing.
        assert!(Durability::None < Durability::FlushOnly);
        assert!(Durability::FlushOnly < Durability::SyncFile);
        assert!(Durability::SyncFile < Durability::SyncFileAndDirectory);
    }

    #[test]
    fn only_move_rename_and_delete_consume_their_source() {
        assert!(OperationKind::Move.consumes_source());
        assert!(OperationKind::Rename.consumes_source());
        assert!(OperationKind::Delete.consumes_source());

        // These leave the source in place, so a failed commit is always
        // retryable from it.
        assert!(!OperationKind::Copy.consumes_source());
        assert!(!OperationKind::Write.consumes_source());
        assert!(!OperationKind::CreateArchive.consumes_source());
        assert!(!OperationKind::ExtractArchive.consumes_source());
    }
}
