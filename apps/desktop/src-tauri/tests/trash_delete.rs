//! P0.7 — the trash-deletion invariant, in its own test binary.
//!
//! `vfs::delete_entry(_, _, DeleteMode::Trash)` must never turn a failed trash
//! attempt into a permanent deletion. That is the invariant the QSF plan names
//! explicitly ("the trash fallback-to-permanent is never silent") and that P1.6
//! has to preserve while it re-models Trash as its own outcome.
//!
//! # Why this is not in `characterization.rs`
//!
//! The interesting branch is the *failure* branch, and on a healthy desktop the
//! trash simply works — the first version of this test asserted "if it failed,
//! the file survives" and the condition never held, so it proved nothing. That
//! is precisely the green-check-validating-nothing failure mode `CLAUDE.md`
//! warns about.
//!
//! Forcing the failure means redirecting `HOME`/`XDG_DATA_HOME` at a read-only
//! directory, which is process-global state. Cargo gives each `tests/*.rs` its
//! own binary, so putting these here keeps the environment change away from the
//! parallel tests in the main suite.
//!
//! Redirecting `HOME` has a second benefit: without it, running the suite files
//! its fixtures into the developer's real trash.

use nexuscommander_lib::vfs::{self, DeleteMode};

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Once;

static ENV: Once = Once::new();

/// Point the freedesktop trash lookup at a directory it cannot write to.
///
/// `/tmp` and `$HOME` are usually the same filesystem, in which case the trash
/// implementation uses the home trash rather than a `$topdir/.Trash-$uid`, so
/// breaking the home location is enough. If they are *not* the same filesystem
/// the topdir trash is used instead and the delete may well succeed — which is
/// why `trash_failure_never_deletes_the_file` asserts the invariant on both
/// branches rather than requiring the failure.
fn sabotage_trash() -> PathBuf {
    let jail = std::env::temp_dir().join(format!("nc_trash_jail_{}", std::process::id()));
    ENV.call_once(|| {
        let _ = fs::remove_dir_all(&jail);
        fs::create_dir_all(&jail).expect("create jail");
        let mut perms = fs::metadata(&jail).unwrap().permissions();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            perms.set_mode(0o500); // r-x: lookups work, creation does not
        }
        #[cfg(not(unix))]
        perms.set_readonly(true);
        fs::set_permissions(&jail, perms).expect("make jail read-only");

        std::env::set_var("HOME", &jail);
        std::env::set_var("XDG_DATA_HOME", jail.join("share"));
    });
    jail
}

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("nc_trash_{}_{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create scratch");
        Scratch(dir)
    }

    fn file(&self, rel: &str, content: &[u8]) -> String {
        let p = self.0.join(rel);
        fs::write(&p, content).expect("write fixture");
        p.to_string_lossy().to_string()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// The invariant. Both branches are asserted so the test is meaningful whether
/// or not the sabotage succeeded on this machine, and the failure branch — the
/// one that actually matters — is the one the sabotage is there to reach.
#[test]
fn trash_failure_never_deletes_the_file() {
    sabotage_trash();
    let s = Scratch::new("invariant");
    let f = s.file("doomed.txt", b"contents that must survive");

    let res = vfs::delete_entry(&f, false, DeleteMode::Trash);

    if res.success {
        assert!(
            !Path::new(&f).exists(),
            "trash reported success but the file is still there"
        );
    } else {
        assert!(
            Path::new(&f).exists(),
            "QSF invariant broken: a failed trash attempt deleted the file anyway"
        );
        assert_eq!(fs::read(&f).unwrap(), b"contents that must survive");
        assert!(
            res.message.contains("Not deleted permanently"),
            "the refusal must tell the user nothing was deleted: {}",
            res.message
        );
    }
}

/// Refusing to fall back must not be a dead end: the caller can still ask for a
/// permanent deletion explicitly, which is what the UI does after a separate
/// confirmation. P1.6 keeps this two-step shape and models it as an outcome.
#[test]
fn permanent_delete_still_works_after_a_trash_failure() {
    sabotage_trash();
    let s = Scratch::new("retry");
    let f = s.file("doomed.txt", b"x");

    let trashed = vfs::delete_entry(&f, false, DeleteMode::Trash);
    if trashed.success {
        // Trash worked on this machine; there is nothing to retry.
        return;
    }

    let res = vfs::delete_entry(&f, false, DeleteMode::Permanent);
    assert!(res.success, "{}", res.message);
    assert!(!Path::new(&f).exists());
}
