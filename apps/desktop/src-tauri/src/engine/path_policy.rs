//! P1.2 — resolve destination paths without traversing a symlink.
//!
//! QSF-003. Nothing in this codebase resolves links by policy today. A copy
//! aimed at `dst/report.pdf` where `report.pdf` is a symlink to
//! `/etc/something` writes through the link, outside the directory the user was
//! looking at, and `Path::exists()` cannot even see the difference — it follows
//! links, so a *dangling* link reports "nothing here" while `fs::copy` onto it
//! still clobbers the link. Before P1.2 the only no-follow call in the codebase
//! was `safety::entry_exists`, which answered a yes/no question about one path
//! and was deleted with the rest of the P0.6 stopgap in P1.5.
//!
//! # The primitive this provides
//!
//! One thing: **a directory handle reached without traversing a symlink**, plus
//! no-follow lookups relative to it. That is deliberately small, because it is
//! what P1.4 and P1.5 actually need — the staging protocol writes a temporary
//! file into the *destination* directory and renames it over the target, so
//! every operation in it is relative to one directory that must be the right
//! one. Pinning that directory once, as a descriptor, also closes the window
//! where the path could be swapped between the check and the write.
//!
//! # What each platform actually guarantees
//!
//! Section 6.1: "Every platform adapter must declare which guarantee it
//! actually provides, and `PathPolicy` must refuse an operation whose requested
//! guarantee the adapter cannot meet rather than silently degrading."
//!
//! - **Unix** — [`Guarantee::ComponentwiseNoFollow`]. Each component is opened
//!   from the descriptor of its parent with `O_NOFOLLOW`, so nothing is
//!   resolved by name after the walk starts and a link anywhere in the path is
//!   an `ELOOP` we can act on.
//! - **Windows** — [`Guarantee::Advisory`]. Win32 has no `openat`: relative
//!   opens need `NtCreateFile`, which is not part of the API surface this crate
//!   uses. `FILE_FLAG_OPEN_REPARSE_POINT` protects only the *final* component.
//!   So the adapter checks each prefix for `FILE_ATTRIBUTE_REPARSE_POINT` by
//!   path, which detects a symlinked component but cannot exclude a swap
//!   between the check and the use.
//!
//! The degradation is not silent: it is in [`DirHandle::guarantee`], it belongs
//! in the operation's result, and [`PathPolicy::require_race_free`] refuses
//! outright for a caller that needs the stronger promise. Refusing *all*
//! Windows mutations instead would not be safety, it would be removing the
//! platform. Native verification is P4.1; the Windows path here is
//! **unverified on Windows** and only known to compile.
//!
//! # Why not `openat2`
//!
//! The plan names `openat2(RESOLVE_NO_SYMLINKS)` (Linux 5.6+) with
//! component-wise `openat` as the fallback. Only the fallback is implemented.
//! The two provide the *same* guarantee — `openat2` is one syscall instead of
//! N, not a stronger promise — and it would cost a raw `libc::syscall` with a
//! hand-rolled `open_how`, runtime version detection, and a fallback path that
//! would then be the one actually exercised on every older kernel and in every
//! test on this machine. A performance win is not worth an unsafe path that the
//! test suite cannot reach. Revisit if profiling says the walk costs anything.

use super::spec::SymlinkPolicy;

use std::ffi::OsStr;
use std::fmt;
use std::path::{Component, Path, PathBuf};

/// What an adapter actually promises about symlink traversal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Guarantee {
    /// Checks are by path and cannot exclude a swap between check and use.
    Advisory,
    /// Every component was opened from its parent's descriptor with
    /// `O_NOFOLLOW`. Race-free: after the walk begins, nothing is resolved by
    /// name again.
    ComponentwiseNoFollow,
}

impl Guarantee {
    /// Whether this guarantee survives another process moving things around
    /// mid-operation.
    pub fn is_race_free(self) -> bool {
        self == Guarantee::ComponentwiseNoFollow
    }
}

/// What the platform this build targets can promise.
pub const fn platform_guarantee() -> Guarantee {
    #[cfg(unix)]
    {
        Guarantee::ComponentwiseNoFollow
    }
    #[cfg(not(unix))]
    {
        Guarantee::Advisory
    }
}

/// A directory entry's kind, determined **without** following links.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    File,
    Dir,
    /// The entry is a symlink. Whether its target exists is a separate and, for
    /// safety purposes, irrelevant question: the link is a real directory entry
    /// that a write would destroy.
    Symlink,
    Other,
}

#[derive(Debug)]
pub enum PathError {
    /// Resolution starts from a filesystem root, so a relative path has no
    /// defined meaning here. Callers resolve against the panel's directory
    /// before handing a path over.
    NotAbsolute(PathBuf),
    /// A component is a symlink and the policy does not allow following it.
    SymlinkRejected {
        path: PathBuf,
        component: PathBuf,
    },
    /// `SymlinkPolicy::Follow`'s depth bound was reached — which is also how a
    /// link cycle terminates.
    TooDeep {
        path: PathBuf,
        max_depth: u8,
    },
    /// More components than the bound allows.
    TooManyComponents {
        path: PathBuf,
        limit: usize,
    },
    /// The caller asked for a race-free guarantee this platform cannot give.
    GuaranteeUnavailable {
        requested: Guarantee,
        provided: Guarantee,
    },
    NotADirectory(PathBuf),
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
}

impl fmt::Display for PathError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PathError::NotAbsolute(p) => {
                write!(f, "'{}' is not an absolute path", p.display())
            }
            PathError::SymlinkRejected { path, component } => write!(
                f,
                "Refused: '{}' passes through the symlink '{}'. Following it would \
                 write outside the directory you selected.",
                path.display(),
                component.display()
            ),
            PathError::TooDeep { path, max_depth } => write!(
                f,
                "Refused: resolving '{}' exceeded the symlink depth limit of {} — \
                 the links may form a cycle.",
                path.display(),
                max_depth
            ),
            PathError::TooManyComponents { path, limit } => write!(
                f,
                "Refused: '{}' has more than {} path components.",
                path.display(),
                limit
            ),
            PathError::GuaranteeUnavailable {
                requested,
                provided,
            } => write!(
                f,
                "Refused: this operation needs a {:?} path guarantee and this platform \
                 provides only {:?}.",
                requested, provided
            ),
            PathError::NotADirectory(p) => {
                write!(f, "'{}' is not a directory", p.display())
            }
            PathError::Io { path, source } => {
                write!(f, "Could not open '{}': {}", path.display(), source)
            }
        }
    }
}

impl std::error::Error for PathError {}

/// How paths are resolved for one operation.
#[derive(Debug, Clone)]
pub struct PathPolicy {
    symlinks: SymlinkPolicy,
    /// Bound on path length. Not a security control on its own — it stops a
    /// pathological path from becoming an unbounded syscall loop.
    max_components: usize,
    /// Refuse rather than proceed when the platform cannot promise race
    /// freedom. Off by default: the Windows adapter is advisory, and defaulting
    /// this on would disable every mutation on that platform.
    require_race_free: bool,
}

impl Default for PathPolicy {
    fn default() -> Self {
        PathPolicy {
            symlinks: SymlinkPolicy::Preserve,
            max_components: 256,
            require_race_free: false,
        }
    }
}

impl PathPolicy {
    pub fn new(symlinks: SymlinkPolicy) -> Self {
        PathPolicy {
            symlinks,
            ..PathPolicy::default()
        }
    }

    /// Refuse when the platform guarantee is only advisory.
    pub fn require_race_free(mut self, required: bool) -> Self {
        self.require_race_free = required;
        self
    }

    pub fn symlink_policy(&self) -> SymlinkPolicy {
        self.symlinks
    }

    /// Open `path` as a directory without traversing a symlink, per policy.
    pub fn open_dir(&self, path: &Path) -> Result<DirHandle, PathError> {
        if self.require_race_free && !platform_guarantee().is_race_free() {
            return Err(PathError::GuaranteeUnavailable {
                requested: Guarantee::ComponentwiseNoFollow,
                provided: platform_guarantee(),
            });
        }
        if !path.is_absolute() {
            return Err(PathError::NotAbsolute(path.to_path_buf()));
        }

        let components: Vec<&OsStr> = normalized_components(path);
        if components.len() > self.max_components {
            return Err(PathError::TooManyComponents {
                path: path.to_path_buf(),
                limit: self.max_components,
            });
        }

        imp::open_dir(self, path, &components)
    }

    /// Whether a symlink component may be traversed, and the remaining budget.
    fn follow_budget(&self) -> Option<u8> {
        match self.symlinks {
            SymlinkPolicy::Follow { max_depth } => Some(max_depth),
            SymlinkPolicy::Preserve | SymlinkPolicy::Reject => None,
        }
    }
}

/// Path components with `.` and the root prefix dropped.
///
/// `..` is kept: it is not a symlink, resolving it from a held descriptor is
/// exactly as safe as any other component, and rewriting it away lexically is
/// what makes `a/link/../b` mean two different things to the checker and to the
/// kernel.
fn normalized_components(path: &Path) -> Vec<&OsStr> {
    path.components()
        .filter_map(|c| match c {
            Component::Normal(name) => Some(name),
            Component::ParentDir => Some(OsStr::new("..")),
            Component::CurDir | Component::RootDir | Component::Prefix(_) => None,
        })
        .collect()
}

/// A directory pinned by the policy walk.
pub struct DirHandle {
    path: PathBuf,
    guarantee: Guarantee,
    inner: imp::DirInner,
}

impl DirHandle {
    /// The path this handle was opened from.
    ///
    /// The path is for messages. Anything that must be *correct* goes through
    /// the handle, because the name may no longer refer to this directory.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// What was actually promised while opening it. Belongs in the operation's
    /// result rather than being assumed.
    pub fn guarantee(&self) -> Guarantee {
        self.guarantee
    }

    /// The kind of the entry named `name` in this directory, without following
    /// links. `None` means there is no entry.
    ///
    /// `name` must be a single component; a separator in it would reintroduce
    /// exactly the multi-component resolution this type exists to control.
    pub fn entry_kind(&self, name: &OsStr) -> Result<Option<EntryKind>, PathError> {
        self.check_single_component(name)?;
        imp::entry_kind(self, name)
    }

    /// Whether an entry exists here at all — the no-follow question
    /// `Path::exists()` cannot answer.
    pub fn entry_exists(&self, name: &OsStr) -> Result<bool, PathError> {
        Ok(self.entry_kind(name)?.is_some())
    }

    /// Create a new file in this directory, failing if the name is taken.
    ///
    /// `O_CREAT | O_EXCL | O_NOFOLLOW`, so it cannot clobber an existing entry
    /// and cannot be redirected through a symlink someone planted at the name.
    /// This is how the staging protocol claims its temporary name.
    pub fn create_new_file(&self, name: &OsStr) -> Result<std::fs::File, PathError> {
        self.check_single_component(name)?;
        imp::create_new_file(self, name)
    }

    /// Rename within this directory. On Unix this is `renameat` on the pinned
    /// descriptor, so it publishes atomically and cannot be redirected.
    pub fn rename(&self, from: &OsStr, to: &OsStr) -> Result<(), PathError> {
        self.check_single_component(from)?;
        self.check_single_component(to)?;
        imp::rename(self, from, to)
    }

    /// Rename out of this directory into another pinned one.
    ///
    /// A batch rename may move entries between directories, and doing that by
    /// path would step outside both handles — reopening the door the walk closed.
    /// On Unix this is `renameat` with two descriptors.
    pub fn rename_into(
        &self,
        from: &OsStr,
        to_dir: &DirHandle,
        to: &OsStr,
    ) -> Result<(), PathError> {
        self.check_single_component(from)?;
        to_dir.check_single_component(to)?;
        imp::rename_into(self, from, to_dir, to)
    }

    /// Remove a file from this directory.
    pub fn remove_file(&self, name: &OsStr) -> Result<(), PathError> {
        self.check_single_component(name)?;
        imp::remove_file(self, name)
    }

    /// A second handle to the same directory.
    ///
    /// `Staged` takes ownership of a handle, but the recursive walk stages many
    /// entries in one directory. Duplicating the descriptor (`dup`) keeps every
    /// staging operation pinned to the *same* directory the walk validated —
    /// re-resolving the path per entry would reopen the door the walk closed.
    pub fn try_clone(&self) -> Result<DirHandle, PathError> {
        Ok(DirHandle {
            path: self.path.clone(),
            guarantee: self.guarantee,
            inner: imp::clone_inner(self)?,
        })
    }

    /// `fsync` the directory itself, so a rename *into* it survives a power cut.
    ///
    /// Syncing the file alone is not enough: the file's data can be durable
    /// while the directory entry that names it is still only in the page cache.
    /// Returns [`SyncSupport::Unsupported`] where the platform has no
    /// equivalent, which the caller must report rather than treat as done.
    pub fn sync(&self) -> Result<SyncSupport, PathError> {
        imp::sync_dir(self)
    }

    fn check_single_component(&self, name: &OsStr) -> Result<(), PathError> {
        if name.is_empty() || Path::new(name).components().count() != 1 {
            return Err(PathError::NotAbsolute(PathBuf::from(name)));
        }
        Ok(())
    }
}

/// Whether a directory sync actually happened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncSupport {
    Synced,
    /// The platform offers no directory sync. The commit still happened; it is
    /// just not durable against a power cut, and saying otherwise would be the
    /// dishonest durability claim section 6.1 forbids.
    Unsupported,
}

impl fmt::Debug for DirHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DirHandle")
            .field("path", &self.path)
            .field("guarantee", &self.guarantee)
            .finish_non_exhaustive()
    }
}

// ===== Unix adapter =====

#[cfg(unix)]
mod imp {
    use super::*;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;

    pub struct DirInner {
        pub fd: OwnedFd,
    }

    fn c_string(name: &OsStr) -> Result<std::ffi::CString, PathError> {
        std::ffi::CString::new(name.as_bytes()).map_err(|_| PathError::Io {
            path: PathBuf::from(name),
            source: std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "path component contains an interior NUL",
            ),
        })
    }

    const DIR_FLAGS: libc::c_int = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC;

    fn open_root() -> Result<OwnedFd, PathError> {
        let root = std::ffi::CString::new("/").unwrap();
        // SAFETY: `root` is a valid NUL-terminated C string that outlives the
        // call, and the flags are a valid combination for opening a directory.
        let fd = unsafe { libc::open(root.as_ptr(), DIR_FLAGS) };
        if fd < 0 {
            return Err(PathError::Io {
                path: PathBuf::from("/"),
                source: std::io::Error::last_os_error(),
            });
        }
        // SAFETY: `fd` is a fresh descriptor owned by nobody else.
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }

    fn openat_dir(parent: &OwnedFd, name: &OsStr, follow: bool) -> std::io::Result<OwnedFd> {
        let c = std::ffi::CString::new(name.as_bytes())
            .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
        let mut flags = DIR_FLAGS;
        if !follow {
            flags |= libc::O_NOFOLLOW;
        }
        // SAFETY: `parent` is an open directory descriptor we own for the
        // duration of the call, and `c` is a valid NUL-terminated C string.
        let fd = unsafe { libc::openat(parent.as_raw_fd(), c.as_ptr(), flags) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: `fd` is a fresh descriptor owned by nobody else.
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }

    pub fn open_dir(
        policy: &PathPolicy,
        path: &Path,
        components: &[&OsStr],
    ) -> Result<DirHandle, PathError> {
        let mut dir = open_root()?;
        let mut budget = policy.follow_budget();
        let mut walked = PathBuf::from("/");

        for name in components {
            walked.push(name);
            match openat_dir(&dir, name, false) {
                Ok(next) => dir = next,
                Err(e) => {
                    // ELOOP: the component is a symlink and O_NOFOLLOW refused
                    // it. ENOTDIR: it is a symlink *to* a non-directory, which
                    // O_DIRECTORY rejects — same cause, different errno, and
                    // treating only ELOOP as "a link" would miss it.
                    let is_link = matches!(
                        e.raw_os_error(),
                        Some(libc::ELOOP) | Some(libc::EMLINK) | Some(libc::ENOTDIR)
                    ) && is_symlink_at(&dir, name);

                    if !is_link {
                        // A plain file in the middle of the path: say so, rather
                        // than making the user parse an errno.
                        if e.raw_os_error() == Some(libc::ENOTDIR) {
                            return Err(PathError::NotADirectory(walked));
                        }
                        return Err(PathError::Io {
                            path: walked,
                            source: e,
                        });
                    }

                    match budget {
                        None => {
                            return Err(PathError::SymlinkRejected {
                                path: path.to_path_buf(),
                                component: walked,
                            })
                        }
                        Some(0) => {
                            let max_depth = match policy.symlinks {
                                SymlinkPolicy::Follow { max_depth } => max_depth,
                                _ => 0,
                            };
                            return Err(PathError::TooDeep {
                                path: path.to_path_buf(),
                                max_depth,
                            });
                        }
                        Some(remaining) => {
                            budget = Some(remaining - 1);
                            dir = openat_dir(&dir, name, true).map_err(|e| PathError::Io {
                                path: walked.clone(),
                                source: e,
                            })?;
                        }
                    }
                }
            }
        }

        Ok(DirHandle {
            path: path.to_path_buf(),
            guarantee: Guarantee::ComponentwiseNoFollow,
            inner: DirInner { fd: dir },
        })
    }

    /// Is `name` inside `dir` a symlink? Answers the "why did openat fail"
    /// question without following anything.
    fn is_symlink_at(dir: &OwnedFd, name: &OsStr) -> bool {
        matches!(stat_at(dir, name), Ok(Some(EntryKind::Symlink)))
    }

    fn stat_at(dir: &OwnedFd, name: &OsStr) -> Result<Option<EntryKind>, PathError> {
        let c = c_string(name)?;
        let mut st: libc::stat = unsafe { std::mem::zeroed() };
        // SAFETY: `dir` is an open directory descriptor, `c` is a valid C
        // string, and `st` is a live, correctly sized stat buffer.
        // AT_SYMLINK_NOFOLLOW makes this an lstat relative to `dir`.
        let rc = unsafe {
            libc::fstatat(
                dir.as_raw_fd(),
                c.as_ptr(),
                &mut st,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if rc != 0 {
            let e = std::io::Error::last_os_error();
            return match e.raw_os_error() {
                Some(libc::ENOENT) | Some(libc::ENOTDIR) => Ok(None),
                _ => Err(PathError::Io {
                    path: PathBuf::from(name),
                    source: e,
                }),
            };
        }

        let mode = st.st_mode & libc::S_IFMT;
        Ok(Some(if mode == libc::S_IFLNK {
            EntryKind::Symlink
        } else if mode == libc::S_IFDIR {
            EntryKind::Dir
        } else if mode == libc::S_IFREG {
            EntryKind::File
        } else {
            EntryKind::Other
        }))
    }

    pub fn entry_kind(handle: &DirHandle, name: &OsStr) -> Result<Option<EntryKind>, PathError> {
        stat_at(&handle.inner.fd, name)
    }

    pub fn create_new_file(handle: &DirHandle, name: &OsStr) -> Result<std::fs::File, PathError> {
        use std::os::fd::IntoRawFd;

        let c = c_string(name)?;
        let flags =
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        // 0o600: a staging file may hold the whole content of the destination,
        // so it must not be world-readable even for the moment it exists. The
        // committed file's mode comes from MetadataPolicy, applied before the
        // rename.
        // SAFETY: the descriptor is an open directory we own, `c` is a valid
        // NUL-terminated C string, and O_CREAT is paired with a mode argument.
        let fd = unsafe {
            libc::openat(
                handle.inner.fd.as_raw_fd(),
                c.as_ptr(),
                flags,
                0o600 as libc::c_uint,
            )
        };
        if fd < 0 {
            return Err(PathError::Io {
                path: handle.path.join(name),
                source: std::io::Error::last_os_error(),
            });
        }
        // SAFETY: `fd` is a fresh descriptor owned by nobody else.
        let owned = unsafe { OwnedFd::from_raw_fd(fd) };
        // SAFETY: transferring sole ownership of the descriptor to File.
        Ok(unsafe { <std::fs::File as FromRawFd>::from_raw_fd(owned.into_raw_fd()) })
    }

    pub fn rename(handle: &DirHandle, from: &OsStr, to: &OsStr) -> Result<(), PathError> {
        let from_c = c_string(from)?;
        let to_c = c_string(to)?;
        let fd = handle.inner.fd.as_raw_fd();
        // SAFETY: `fd` is an open directory descriptor we own and both strings
        // are valid NUL-terminated C strings.
        let rc = unsafe { libc::renameat(fd, from_c.as_ptr(), fd, to_c.as_ptr()) };
        if rc != 0 {
            return Err(PathError::Io {
                path: handle.path.join(to),
                source: std::io::Error::last_os_error(),
            });
        }
        Ok(())
    }

    pub fn rename_into(
        from_dir: &DirHandle,
        from: &OsStr,
        to_dir: &DirHandle,
        to: &OsStr,
    ) -> Result<(), PathError> {
        let from_c = c_string(from)?;
        let to_c = c_string(to)?;
        // SAFETY: both descriptors are open directories we own and both strings
        // are valid NUL-terminated C strings.
        let rc = unsafe {
            libc::renameat(
                from_dir.inner.fd.as_raw_fd(),
                from_c.as_ptr(),
                to_dir.inner.fd.as_raw_fd(),
                to_c.as_ptr(),
            )
        };
        if rc != 0 {
            return Err(PathError::Io {
                path: to_dir.path.join(to),
                source: std::io::Error::last_os_error(),
            });
        }
        Ok(())
    }

    pub fn remove_file(handle: &DirHandle, name: &OsStr) -> Result<(), PathError> {
        let c = c_string(name)?;
        // SAFETY: `fd` is an open directory descriptor we own, `c` is a valid
        // NUL-terminated C string, and flag 0 means "not a directory".
        let rc = unsafe { libc::unlinkat(handle.inner.fd.as_raw_fd(), c.as_ptr(), 0) };
        if rc != 0 {
            return Err(PathError::Io {
                path: handle.path.join(name),
                source: std::io::Error::last_os_error(),
            });
        }
        Ok(())
    }

    pub fn clone_inner(handle: &DirHandle) -> Result<DirInner, PathError> {
        let fd = handle
            .inner
            .fd
            .try_clone()
            .map_err(|source| PathError::Io {
                path: handle.path.clone(),
                source,
            })?;
        Ok(DirInner { fd })
    }

    pub fn sync_dir(handle: &DirHandle) -> Result<SyncSupport, PathError> {
        // SAFETY: `fd` is an open directory descriptor we own.
        let rc = unsafe { libc::fsync(handle.inner.fd.as_raw_fd()) };
        if rc != 0 {
            return Err(PathError::Io {
                path: handle.path.clone(),
                source: std::io::Error::last_os_error(),
            });
        }
        Ok(SyncSupport::Synced)
    }
}

// ===== Windows adapter =====
//
// UNVERIFIED ON WINDOWS. Compiled by the cross-check target only; P4.1 owns
// native qualification. Every claim below is from the API documentation, not
// from a run.

#[cfg(not(unix))]
mod imp {
    use super::*;

    pub struct DirInner;

    /// Win32 exposes no `openat`, so there is no descriptor to pin the
    /// directory with — resolution is by path, and the result is advisory.
    pub fn open_dir(
        policy: &PathPolicy,
        path: &Path,
        components: &[&OsStr],
    ) -> Result<DirHandle, PathError> {
        let mut walked = PathBuf::new();
        if let Some(prefix) = path.components().next() {
            walked.push(prefix.as_os_str());
        }
        walked.push(std::path::MAIN_SEPARATOR.to_string());

        let mut budget = policy.follow_budget();
        for name in components {
            walked.push(name);
            match attributes_of(&walked) {
                Some(attrs) if attrs.is_reparse_point => match budget {
                    None => {
                        return Err(PathError::SymlinkRejected {
                            path: path.to_path_buf(),
                            component: walked,
                        })
                    }
                    Some(0) => {
                        let max_depth = match policy.symlinks {
                            SymlinkPolicy::Follow { max_depth } => max_depth,
                            _ => 0,
                        };
                        return Err(PathError::TooDeep {
                            path: path.to_path_buf(),
                            max_depth,
                        });
                    }
                    Some(remaining) => budget = Some(remaining - 1),
                },
                Some(attrs) if !attrs.is_dir => {
                    return Err(PathError::NotADirectory(walked));
                }
                Some(_) => {}
                None => {
                    return Err(PathError::Io {
                        path: walked,
                        source: std::io::Error::last_os_error(),
                    })
                }
            }
        }

        Ok(DirHandle {
            path: path.to_path_buf(),
            guarantee: Guarantee::Advisory,
            inner: DirInner,
        })
    }

    pub fn entry_kind(handle: &DirHandle, name: &OsStr) -> Result<Option<EntryKind>, PathError> {
        let full = handle.path.join(name);
        Ok(attributes_of(&full).map(|attrs| {
            if attrs.is_reparse_point {
                EntryKind::Symlink
            } else if attrs.is_dir {
                EntryKind::Dir
            } else {
                EntryKind::File
            }
        }))
    }

    pub fn create_new_file(handle: &DirHandle, name: &OsStr) -> Result<std::fs::File, PathError> {
        // No openat, so this is a path-based create. create_new still refuses an
        // existing name; what it cannot do is refuse a reparse point planted at
        // that name between the check and here. Guarantee::Advisory says so.
        let full = handle.path.join(name);
        std::fs::File::options()
            .write(true)
            .create_new(true)
            .open(&full)
            .map_err(|source| PathError::Io { path: full, source })
    }

    pub fn rename(handle: &DirHandle, from: &OsStr, to: &OsStr) -> Result<(), PathError> {
        let target = handle.path.join(to);
        std::fs::rename(handle.path.join(from), &target).map_err(|source| PathError::Io {
            path: target,
            source,
        })
    }

    pub fn rename_into(
        from_dir: &DirHandle,
        from: &OsStr,
        to_dir: &DirHandle,
        to: &OsStr,
    ) -> Result<(), PathError> {
        let target = to_dir.path.join(to);
        std::fs::rename(from_dir.path.join(from), &target).map_err(|source| PathError::Io {
            path: target,
            source,
        })
    }

    pub fn remove_file(handle: &DirHandle, name: &OsStr) -> Result<(), PathError> {
        let full = handle.path.join(name);
        std::fs::remove_file(&full).map_err(|source| PathError::Io { path: full, source })
    }

    pub fn clone_inner(_handle: &DirHandle) -> Result<DirInner, PathError> {
        // The Windows adapter holds no descriptor — resolution is by path — so
        // there is nothing to duplicate.
        Ok(DirInner)
    }

    /// Windows has no directory fsync. FlushFileBuffers needs a handle opened
    /// with write access, which a directory does not grant, and there is no
    /// documented guarantee that it would order the rename anyway.
    ///
    /// Reported as Unsupported rather than faked: a commit that is durable
    /// against a process crash but not a power cut has to say which it is.
    pub fn sync_dir(_handle: &DirHandle) -> Result<SyncSupport, PathError> {
        Ok(SyncSupport::Unsupported)
    }

    struct Attributes {
        is_dir: bool,
        is_reparse_point: bool,
    }

    /// `GetFileAttributesW` does not follow reparse points when reporting
    /// `FILE_ATTRIBUTE_REPARSE_POINT`, so this sees the link rather than its
    /// target — the Windows equivalent of the `lstat` the Unix side uses.
    fn attributes_of(path: &Path) -> Option<Attributes> {
        use std::os::windows::ffi::OsStrExt;

        const INVALID: u32 = u32::MAX;
        const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

        let wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        // SAFETY: `wide` is a NUL-terminated UTF-16 buffer that outlives the call.
        let attrs = unsafe { winapi::um::fileapi::GetFileAttributesW(wide.as_ptr()) };
        if attrs == INVALID {
            return None;
        }
        Some(Attributes {
            is_dir: attrs & FILE_ATTRIBUTE_DIRECTORY != 0,
            is_reparse_point: attrs & FILE_ATTRIBUTE_REPARSE_POINT != 0,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("nc_pathpolicy_{}_{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        // The scratch path itself may run through a symlink (/tmp is one on
        // some systems), which would make every test fail for the wrong
        // reason. Canonicalize once, here, so the fixtures below are the only
        // links in play.
        fs::canonicalize(&dir).unwrap()
    }

    #[test]
    fn opens_an_ordinary_directory() {
        let dir = scratch("plain");
        let target = dir.join("sub");
        fs::create_dir(&target).unwrap();

        let handle = PathPolicy::default().open_dir(&target).unwrap();
        assert_eq!(handle.path(), target);
        assert_eq!(handle.guarantee(), platform_guarantee());
    }

    #[test]
    fn a_relative_path_is_refused() {
        let err = PathPolicy::default().open_dir(Path::new("relative/sub"));
        assert!(matches!(err, Err(PathError::NotAbsolute(_))));
    }

    #[test]
    fn reports_entry_kinds_without_following() {
        let dir = scratch("kinds");
        fs::write(dir.join("file.txt"), b"x").unwrap();
        fs::create_dir(dir.join("subdir")).unwrap();

        let handle = PathPolicy::default().open_dir(&dir).unwrap();
        assert_eq!(
            handle.entry_kind(OsStr::new("file.txt")).unwrap(),
            Some(EntryKind::File)
        );
        assert_eq!(
            handle.entry_kind(OsStr::new("subdir")).unwrap(),
            Some(EntryKind::Dir)
        );
        assert_eq!(handle.entry_kind(OsStr::new("absent")).unwrap(), None);
    }

    #[test]
    fn a_multi_component_name_is_refused() {
        // Accepting "a/b" here would reintroduce exactly the uncontrolled
        // resolution this type exists to prevent.
        let dir = scratch("multi");
        let handle = PathPolicy::default().open_dir(&dir).unwrap();
        assert!(handle.entry_kind(OsStr::new("a/b")).is_err());
    }

    #[cfg(unix)]
    mod unix_links {
        use super::*;

        #[test]
        fn a_symlinked_component_is_refused_by_default() {
            let dir = scratch("link_component");
            let real = dir.join("real");
            fs::create_dir(&real).unwrap();
            fs::create_dir(real.join("inner")).unwrap();
            std::os::unix::fs::symlink(&real, dir.join("link")).unwrap();

            let err = PathPolicy::default()
                .open_dir(&dir.join("link").join("inner"))
                .unwrap_err();
            match err {
                PathError::SymlinkRejected { component, .. } => {
                    assert!(component.ends_with("link"), "{}", component.display());
                }
                other => panic!("expected SymlinkRejected, got {:?}", other),
            }
        }

        #[test]
        fn a_symlinked_final_component_is_refused_by_default() {
            let dir = scratch("link_final");
            let real = dir.join("real");
            fs::create_dir(&real).unwrap();
            std::os::unix::fs::symlink(&real, dir.join("link")).unwrap();

            assert!(matches!(
                PathPolicy::default().open_dir(&dir.join("link")),
                Err(PathError::SymlinkRejected { .. })
            ));
        }

        #[test]
        fn following_is_allowed_only_when_asked_for() {
            let dir = scratch("link_follow");
            let real = dir.join("real");
            fs::create_dir(&real).unwrap();
            std::os::unix::fs::symlink(&real, dir.join("link")).unwrap();

            let policy = PathPolicy::new(SymlinkPolicy::Follow { max_depth: 4 });
            let handle = policy.open_dir(&dir.join("link")).unwrap();
            assert_eq!(handle.path(), dir.join("link"));
        }

        #[test]
        fn a_symlink_cycle_terminates_at_the_depth_bound() {
            // a -> b -> a. Without a bound the walk would loop until the kernel
            // gave up somewhere unpredictable.
            let dir = scratch("cycle");
            std::os::unix::fs::symlink(dir.join("b"), dir.join("a")).unwrap();
            std::os::unix::fs::symlink(dir.join("a"), dir.join("b")).unwrap();

            let policy = PathPolicy::new(SymlinkPolicy::Follow { max_depth: 3 });
            let err = policy.open_dir(&dir.join("a")).unwrap_err();
            assert!(
                matches!(err, PathError::TooDeep { .. } | PathError::Io { .. }),
                "expected the walk to terminate, got {:?}",
                err
            );
        }

        #[test]
        fn a_dangling_symlink_is_still_an_entry() {
            // The QSF-003 case Path::exists() gets wrong: it follows the link,
            // finds nothing, and reports the destination as free.
            let dir = scratch("dangling");
            std::os::unix::fs::symlink(dir.join("no-such-target"), dir.join("dead")).unwrap();

            let handle = PathPolicy::default().open_dir(&dir).unwrap();
            assert!(!dir.join("dead").exists(), "precondition");
            assert_eq!(
                handle.entry_kind(OsStr::new("dead")).unwrap(),
                Some(EntryKind::Symlink)
            );
            assert!(handle.entry_exists(OsStr::new("dead")).unwrap());
        }

        #[test]
        fn a_hard_link_is_an_ordinary_file() {
            // Hard links have no target to escape through — both names are the
            // file. Refusing them would break ordinary copies for nothing.
            let dir = scratch("hardlink");
            let original = dir.join("original.txt");
            fs::write(&original, b"x").unwrap();
            fs::hard_link(&original, dir.join("second.txt")).unwrap();

            let handle = PathPolicy::default().open_dir(&dir).unwrap();
            assert_eq!(
                handle.entry_kind(OsStr::new("second.txt")).unwrap(),
                Some(EntryKind::File)
            );
        }

        #[test]
        fn parent_components_resolve_against_the_real_tree() {
            // `a/link/../b` must mean whatever the kernel says it means. This
            // is why `..` is not rewritten away lexically.
            let dir = scratch("parent");
            fs::create_dir(dir.join("one")).unwrap();
            fs::create_dir(dir.join("two")).unwrap();

            let handle = PathPolicy::default()
                .open_dir(&dir.join("one").join("..").join("two"))
                .unwrap();
            assert_eq!(handle.guarantee(), Guarantee::ComponentwiseNoFollow);
        }

        #[test]
        fn a_symlink_behind_a_parent_component_is_still_caught() {
            let dir = scratch("parent_link");
            let real = dir.join("real");
            fs::create_dir(&real).unwrap();
            std::os::unix::fs::symlink(&real, dir.join("link")).unwrap();
            fs::create_dir(dir.join("other")).unwrap();

            // `link/../other` still has to traverse `link` first.
            assert!(matches!(
                PathPolicy::default().open_dir(&dir.join("link").join("..").join("other")),
                Err(PathError::SymlinkRejected { .. })
            ));
        }
    }

    #[test]
    fn a_path_longer_than_the_bound_is_refused() {
        let policy = PathPolicy {
            max_components: 2,
            ..PathPolicy::default()
        };
        let err = policy.open_dir(Path::new("/a/b/c/d")).unwrap_err();
        assert!(matches!(err, PathError::TooManyComponents { .. }));
    }

    #[test]
    fn requiring_race_freedom_refuses_where_it_cannot_be_provided() {
        let dir = scratch("guarantee");
        let policy = PathPolicy::default().require_race_free(true);
        let result = policy.open_dir(&dir);

        if platform_guarantee().is_race_free() {
            assert!(result.is_ok(), "Unix provides it; the call must go through");
        } else {
            // Section 6.1: refuse rather than degrade silently.
            assert!(matches!(
                result,
                Err(PathError::GuaranteeUnavailable { .. })
            ));
        }
    }

    #[test]
    fn advisory_is_never_reported_as_race_free() {
        assert!(!Guarantee::Advisory.is_race_free());
        assert!(Guarantee::ComponentwiseNoFollow.is_race_free());
    }
}
