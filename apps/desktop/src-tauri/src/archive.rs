use bzip2::write::BzEncoder;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{BufReader, Read, Seek, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;
use xz2::write::XzEncoder;
use zip::write::SimpleFileOptions;
use zstd::stream::write::Encoder as ZstdEncoder;

pub struct ArchiveState(pub Arc<AtomicBool>);

/// Not `ErrorKind::Interrupted`: `write_all` and `io::copy` *retry*
/// Interrupted, so a cancelled pack used to spin on the same error forever
/// instead of stopping.
fn cancelled_io_error() -> std::io::Error {
    std::io::Error::other("Cancelled")
}

struct CancelableWriter<W> {
    inner: W,
    cancel_flag: Arc<AtomicBool>,
}

impl<W: Write> Write for CancelableWriter<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if self.cancel_flag.load(Ordering::SeqCst) {
            return Err(cancelled_io_error());
        }
        self.inner.write(buf)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        if self.cancel_flag.load(Ordering::SeqCst) {
            return Err(cancelled_io_error());
        }
        self.inner.flush()
    }
}

impl<W: Seek> Seek for CancelableWriter<W> {
    fn seek(&mut self, pos: std::io::SeekFrom) -> std::io::Result<u64> {
        if self.cancel_flag.load(Ordering::SeqCst) {
            return Err(cancelled_io_error());
        }
        self.inner.seek(pos)
    }
}

use crate::vfs::FileEntry;

const PACK_PROGRESS_INTERVAL: Duration = Duration::from_millis(50);
const UNPACK_PROGRESS_INTERVAL: Duration = Duration::from_millis(50);
const UNPACK_COPY_BUFFER_SIZE: usize = 64 * 1024;

struct ProgressReader<R, F: FnMut(f64)> {
    inner: R,
    total: u64,
    current: u64,
    on_progress: F,
}

impl<R: Read, F: FnMut(f64)> Read for ProgressReader<R, F> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        if n > 0 {
            self.current += n as u64;
            let p = (self.current as f64 / self.total as f64) * 100.0;
            (self.on_progress)(p);
        }
        Ok(n)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackProgress {
    pub current_file: String,
    pub current_file_num: u64,
    pub total_files: u64,
    pub current_file_progress: f64,
    pub total_progress: f64,
    pub bytes_processed: u64,
    pub total_bytes: u64,
    pub started_at: u64,
    pub bytes_per_second: f64,
}

/// The wire shape of `get_archive_capabilities`.
///
/// `rename_all = "camelCase"` is load-bearing, not style: the shared contract
/// (`packages/ui/src/lib/ipc-contract.ts`) declares `canPack`/`canUnpack`/…,
/// and the web backend already answers in camelCase. Serializing snake_case
/// here made every field read `undefined` in the shared UI, so the desktop
/// pack-format list emptied itself as soon as capabilities loaded.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveFormatCapability {
    pub format: String,
    pub can_pack: bool,
    pub can_unpack: bool,
    pub can_read: bool,
    pub min_compression_level: u32,
    pub max_compression_level: u32,
    pub default_compression_level: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnpackProgress {
    pub current_file: String,
    pub current_file_num: u64,
    pub total_files: u64,
    pub total_progress: f64,
    pub bytes_written: u64,
    pub started_at: u64,
}

fn emit_unpack_progress(
    app: &AppHandle,
    current_file: &str,
    current_file_num: u64,
    total_files: u64,
    total_progress: f64,
    bytes_written: u64,
    started_at: u64,
    last_emit: &Mutex<Instant>,
    force: bool,
) {
    let now = Instant::now();
    let mut guard = last_emit.lock().unwrap();
    let elapsed = now.duration_since(*guard);
    if elapsed < UNPACK_PROGRESS_INTERVAL && !force {
        return;
    }
    *guard = now;
    drop(guard);

    let _ = app.emit(
        "unpack-progress",
        UnpackProgress {
            current_file: current_file.to_string(),
            current_file_num,
            total_files,
            total_progress: total_progress.clamp(0.0, 100.0),
            bytes_written,
            started_at,
        },
    );
}

fn unpack_progress_percent(
    files_done: u64,
    total_files: u64,
    current_file_written: u64,
    current_file_size: u64,
) -> f64 {
    let current_file_progress = if current_file_size > 0 {
        (current_file_written as f64 / current_file_size as f64).min(1.0)
    } else {
        0.0
    };

    if total_files > 0 {
        ((files_done as f64 + current_file_progress) / total_files as f64) * 100.0
    } else {
        current_file_progress * 100.0
    }
}

fn copy_with_unpack_progress<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    app: Option<&AppHandle>,
    current_file: &str,
    current_file_num: u64,
    total_files: u64,
    files_done: u64,
    bytes_written_before_file: u64,
    current_file_size: u64,
    started_at: u64,
    last_emit: &Mutex<Instant>,
) -> Result<u64, String> {
    let mut current_file_written = 0_u64;

    if let Some(app) = app {
        emit_unpack_progress(
            app,
            current_file,
            current_file_num,
            total_files,
            unpack_progress_percent(
                files_done,
                total_files,
                current_file_written,
                current_file_size,
            ),
            bytes_written_before_file,
            started_at,
            last_emit,
            true,
        );
    }

    let mut buffer = [0_u8; UNPACK_COPY_BUFFER_SIZE];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|e| format!("Failed to read {}: {}", current_file, e))?;
        if read == 0 {
            break;
        }

        writer
            .write_all(&buffer[..read])
            .map_err(|e| format!("Failed to write {}: {}", current_file, e))?;

        current_file_written = current_file_written.saturating_add(read as u64);

        if let Some(app) = app {
            emit_unpack_progress(
                app,
                current_file,
                current_file_num,
                total_files,
                unpack_progress_percent(
                    files_done,
                    total_files,
                    current_file_written,
                    current_file_size,
                ),
                bytes_written_before_file.saturating_add(current_file_written),
                started_at,
                last_emit,
                false,
            );
        }
    }

    if let Some(app) = app {
        emit_unpack_progress(
            app,
            current_file,
            current_file_num,
            total_files,
            unpack_progress_percent(
                files_done,
                total_files,
                current_file_written,
                current_file_size,
            ),
            bytes_written_before_file.saturating_add(current_file_written),
            started_at,
            last_emit,
            true,
        );
    }

    Ok(current_file_written)
}

pub fn get_archive_capabilities() -> Vec<ArchiveFormatCapability> {
    vec![
        ArchiveFormatCapability {
            format: "zip".to_string(),
            can_pack: true,
            can_unpack: true,
            can_read: true,
            min_compression_level: 0,
            max_compression_level: 9,
            default_compression_level: 6,
        },
        ArchiveFormatCapability {
            format: "tar.gz".to_string(),
            can_pack: true,
            can_unpack: true,
            can_read: true,
            min_compression_level: 1,
            max_compression_level: 9,
            default_compression_level: 6,
        },
        ArchiveFormatCapability {
            format: "tar.bz2".to_string(),
            can_pack: true,
            can_unpack: true,
            can_read: true,
            min_compression_level: 1,
            max_compression_level: 9,
            default_compression_level: 6,
        },
        ArchiveFormatCapability {
            format: "tar.xz".to_string(),
            can_pack: true,
            can_unpack: true,
            can_read: true,
            min_compression_level: 1,
            max_compression_level: 9,
            default_compression_level: 6,
        },
        ArchiveFormatCapability {
            format: "tar.zst".to_string(),
            can_pack: true,
            can_unpack: true,
            can_read: true,
            min_compression_level: 1,
            max_compression_level: 22,
            default_compression_level: 3,
        },
        ArchiveFormatCapability {
            format: "7z".to_string(),
            can_pack: false,
            can_unpack: true,
            can_read: true,
            min_compression_level: 0,
            max_compression_level: 9,
            default_compression_level: 5,
        },
    ]
}

struct ProgressFile<'a, R: Read> {
    inner: R,
    app: Option<&'a AppHandle>,
    current_file: String,
    current_file_num: u64,
    total_files: u64,
    total_bytes: u64,
    bytes_processed_before: u64,
    current_file_size: u64,
    current_file_processed: u64,
    started_at: u64,
    cancel_flag: Arc<AtomicBool>,
    last_emit_time: &'a Mutex<Instant>,
    last_bytes: &'a Mutex<u64>,
}

impl<'a, R: Read> Read for ProgressFile<'a, R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.cancel_flag.load(Ordering::SeqCst) {
            return Err(cancelled_io_error());
        }
        if self.current_file_processed == 0 {
            emit_progress(
                self.app,
                self.current_file.clone(),
                self.current_file_num,
                self.total_files,
                0.0,
                if self.total_bytes > 0 {
                    (self.bytes_processed_before as f64 / self.total_bytes as f64) * 100.0
                } else {
                    0.0
                },
                self.bytes_processed_before,
                self.total_bytes,
                self.started_at,
                self.last_emit_time,
                self.last_bytes,
            );
        }
        let n = self.inner.read(buf)?;
        if n > 0 {
            self.current_file_processed += n as u64;
            let total_processed = self.bytes_processed_before + self.current_file_processed;
            let current_file_progress = if self.current_file_size > 0 {
                (self.current_file_processed as f64 / self.current_file_size as f64) * 100.0
            } else {
                100.0
            };
            let total_progress = if self.total_bytes > 0 {
                (total_processed as f64 / self.total_bytes as f64) * 100.0
            } else {
                100.0
            };

            emit_progress(
                self.app,
                self.current_file.clone(),
                self.current_file_num,
                self.total_files,
                current_file_progress,
                total_progress,
                total_processed,
                self.total_bytes,
                self.started_at,
                self.last_emit_time,
                self.last_bytes,
            );
        }
        Ok(n)
    }
}

/// Entry inside an archive, mirroring FileEntry for UI compatibility.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchiveEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub compressed_size: u64,
    pub modified: u64,
    pub extension: String,
    pub owner: String,
    pub group: String,
}

/// Supported archive types.
pub fn is_archive(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".zip")
        || lower.ends_with(".tar")
        || lower.ends_with(".tar.gz")
        || lower.ends_with(".tgz")
        || lower.ends_with(".tar.bz2")
        || lower.ends_with(".tar.xz")
        || lower.ends_with(".tar.zst")
        || lower.ends_with(".zst")
        || lower.ends_with(".gz")
}

/// List contents of a ZIP archive.
fn list_zip(path: &str) -> Result<Vec<FileEntry>, String> {
    let file = File::open(path).map_err(|e| format!("Failed to open archive: {}", e))?;
    let reader = BufReader::new(file);
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|e| format!("Failed to read ZIP: {}", e))?;

    let mut entries: Vec<FileEntry> = Vec::new();

    for i in 0..archive.len() {
        let file = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read entry {}: {}", i, e))?;

        let name = file
            .name()
            .map_err(|e| format!("Unreadable name in entry {}: {}", i, e))?
            .to_string();
        // Skip directories that are just path prefixes
        let is_dir = file.is_dir();
        let size = file.size();

        let modified = file
            .last_modified()
            .map(|dt| {
                // Convert to approximate Unix timestamp
                let year = dt.year() as u64;
                let month = dt.month() as u64;
                let day = dt.day() as u64;
                let hour = dt.hour() as u64;
                let minute = dt.minute() as u64;
                // Rough approximation
                (year - 1970) * 31536000 + month * 2592000 + day * 86400 + hour * 3600 + minute * 60
            })
            .unwrap_or(0);

        let extension = if is_dir {
            String::from("<DIR>")
        } else {
            Path::new(&name)
                .extension()
                .map(|e| e.to_string_lossy().to_string())
                .unwrap_or_default()
        };

        entries.push(FileEntry {
            name,
            is_dir,
            is_symlink: false,
            size,
            modified,
            extension,
            permissions: String::new(),
            owner: String::from("root"),
            group: String::from("root"),
        });
    }

    // Sort: directories first, then by name
    entries.sort_by(|a, b| {
        if a.is_dir == b.is_dir {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        } else if a.is_dir {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        }
    });

    Ok(entries)
}

/// List contents of a TAR archive (optionally compressed with gz, bz2, xz, or zst).
fn list_tar(path: &str) -> Result<Vec<FileEntry>, String> {
    let file = File::open(path).map_err(|e| format!("Failed to open archive: {}", e))?;
    let lower = path.to_lowercase();

    let entries_result: Result<Vec<FileEntry>, String> =
        if lower.ends_with(".gz") || lower.ends_with(".tgz") {
            let gz = flate2::read::GzDecoder::new(BufReader::new(file));
            read_tar_entries(gz)
        } else if lower.ends_with(".bz2") || lower.ends_with(".tbz2") {
            let bz = bzip2::read::BzDecoder::new(BufReader::new(file));
            read_tar_entries(bz)
        } else if lower.ends_with(".xz") || lower.ends_with(".txz") {
            let xz = xz2::read::XzDecoder::new(BufReader::new(file));
            read_tar_entries(xz)
        } else if lower.ends_with(".zst") || lower.ends_with(".tzst") {
            let zst = zstd::stream::read::Decoder::new(BufReader::new(file))
                .map_err(|e| format!("Failed to create zstd decoder: {}", e))?;
            read_tar_entries(zst)
        } else {
            read_tar_entries(BufReader::new(file))
        };

    let mut entries = entries_result?;

    entries.sort_by(|a, b| {
        if a.is_dir == b.is_dir {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        } else if a.is_dir {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        }
    });

    Ok(entries)
}

fn read_tar_entries<R: Read>(reader: R) -> Result<Vec<FileEntry>, String> {
    let mut archive = tar::Archive::new(reader);
    let tar_entries = archive
        .entries()
        .map_err(|e| format!("Failed to read tar: {}", e))?;

    let mut entries: Vec<FileEntry> = Vec::new();

    for entry in tar_entries {
        let entry = entry.map_err(|e| format!("Failed to read archive entry: {}", e))?;

        let name = entry
            .path()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let is_dir = entry.header().entry_type().is_dir();
        let size = entry.size();

        let modified = entry.header().mtime().unwrap_or(0);

        let extension = if is_dir {
            String::from("<DIR>")
        } else {
            Path::new(&name)
                .extension()
                .map(|e| e.to_string_lossy().to_string())
                .unwrap_or_default()
        };

        let permissions = {
            let mode = entry.header().mode().unwrap_or(0);
            format!("{:o}", mode & 0o777)
        };

        entries.push(FileEntry {
            name,
            is_dir,
            is_symlink: false,
            size,
            modified,
            extension,
            permissions,
            owner: String::from("root"),
            group: String::from("root"),
        });
    }

    Ok(entries)
}

/// Read archive contents — dispatches to zip or tar reader.
pub fn read_archive(path: &str) -> Result<Vec<FileEntry>, String> {
    let lower = path.to_lowercase();
    if lower.ends_with(".zip") {
        list_zip(path)
    } else if lower.ends_with(".tar")
        || lower.ends_with(".tar.gz")
        || lower.ends_with(".tgz")
        || lower.ends_with(".tar.bz2")
        || lower.ends_with(".tbz2")
        || lower.ends_with(".tar.xz")
        || lower.ends_with(".txz")
        || lower.ends_with(".tar.zst")
        || lower.ends_with(".tzst")
        || lower.ends_with(".zst")
    {
        list_tar(path)
    } else {
        Err(format!("Unsupported archive format: {}", path))
    }
}

/// Extract a single file from a ZIP archive, returning its contents as bytes.
#[allow(dead_code)]
pub fn extract_zip_file(archive_path: &str, file_name: &str) -> Result<Vec<u8>, String> {
    let file = File::open(archive_path).map_err(|e| format!("Failed to open archive: {}", e))?;
    let reader = BufReader::new(file);
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|e| format!("Failed to read ZIP: {}", e))?;

    let mut zip_file = archive
        .by_name(file_name)
        .map_err(|e| format!("File not found in archive: {}", e))?;

    let mut buf = Vec::new();
    zip_file.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

fn emit_progress(
    app: Option<&AppHandle>,
    current_file: String,
    current_file_num: u64,
    total_files: u64,
    current_file_progress: f64,
    total_progress: f64,
    bytes_processed: u64,
    total_bytes: u64,
    started_at: u64,
    last_emit_time: &Mutex<Instant>,
    last_bytes: &Mutex<u64>,
) {
    let now = Instant::now();
    let mut last_emit = last_emit_time.lock().unwrap();
    let mut last_bytes_val = last_bytes.lock().unwrap();

    let elapsed_since_last = now.duration_since(*last_emit);

    if elapsed_since_last >= PACK_PROGRESS_INTERVAL
        || current_file_progress <= 0.0
        || current_file_progress >= 100.0
    {
        let now_unix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        let elapsed_total = now_unix.saturating_sub(started_at) as f64;

        // Instantaneous speed: bytes since last emit / time since last emit
        let bytes_since_last = bytes_processed.saturating_sub(*last_bytes_val);
        let bytes_per_second = if elapsed_since_last.as_secs_f64() > 0.01 {
            bytes_since_last as f64 / elapsed_since_last.as_secs_f64()
        } else if elapsed_total > 0.1 {
            // Fallback to average speed if too fast
            bytes_processed as f64 / elapsed_total
        } else {
            0.0
        };

        *last_emit = now;
        *last_bytes_val = bytes_processed;

        let Some(app) = app else { return };
        let _ = app.emit(
            "pack-progress",
            PackProgress {
                current_file,
                current_file_num,
                total_files,
                current_file_progress: current_file_progress.clamp(0.0, 100.0),
                total_progress: total_progress.clamp(0.0, 100.0),
                bytes_processed,
                total_bytes,
                started_at,
                bytes_per_second,
            },
        );
    }
}

/// Where the source walk puts what it finds: a zip, or a tar stream.
///
/// Zip and the four tar formats used to be five copies of one walk (about a
/// thousand lines) and shared their bugs:
///
/// - a symlink was stored as a *regular file containing its target path* when
///   `follow_links` was on, and was followed when it was off;
/// - every entry got mode 0755, and every tar entry a 1970 timestamp;
/// - a tar path longer than 100 bytes failed the whole pack (`set_path`);
/// - the compressor was never finished explicitly, so a tar.zst frame was left
///   unterminated, and an error in the others' final flush vanished in `Drop`.
trait PackSink {
    fn add_dir(&mut self, name: &str, meta: &std::fs::Metadata) -> Result<(), String>;
    fn add_symlink(
        &mut self,
        name: &str,
        target: &Path,
        meta: &std::fs::Metadata,
    ) -> Result<(), String>;
    fn add_file(
        &mut self,
        name: &str,
        meta: &std::fs::Metadata,
        data: &mut dyn Read,
    ) -> Result<(), String>;
}

/// One pass over the pack sources, shared by every format.
struct PackWalk<'a> {
    app: Option<&'a AppHandle>,
    follow_links: bool,
    started_at: u64,
    total_files: u64,
    total_bytes: u64,
    cancel_flag: Arc<AtomicBool>,
    current_file_num: u64,
    bytes_processed: u64,
    last_emit_time: Mutex<Instant>,
    last_bytes: Mutex<u64>,
}

impl<'a> PackWalk<'a> {
    fn new(
        app: Option<&'a AppHandle>,
        follow_links: bool,
        started_at: u64,
        total_files: u64,
        total_bytes: u64,
        cancel_flag: Arc<AtomicBool>,
    ) -> Self {
        PackWalk {
            app,
            follow_links,
            started_at,
            total_files,
            total_bytes,
            cancel_flag,
            current_file_num: 0,
            bytes_processed: 0,
            last_emit_time: Mutex::new(Instant::now()),
            last_bytes: Mutex::new(0),
        }
    }

    fn check_cancel(&self) -> Result<(), String> {
        if self.cancel_flag.load(Ordering::SeqCst) {
            Err("Cancelled".to_string())
        } else {
            Ok(())
        }
    }

    fn emit(&self, name: &str, current_file_progress: f64) {
        let total_progress = if self.total_bytes > 0 {
            (self.bytes_processed as f64 / self.total_bytes as f64) * 100.0
        } else {
            100.0
        };
        emit_progress(
            self.app,
            name.to_string(),
            self.current_file_num,
            self.total_files,
            current_file_progress,
            total_progress,
            self.bytes_processed,
            self.total_bytes,
            self.started_at,
            &self.last_emit_time,
            &self.last_bytes,
        );
    }

    /// Walk every source into `sink`.
    ///
    /// A symlink is stored as a link unless `follow_links` asks for what it
    /// points at — for a selected link itself too, which is why root links are
    /// only followed under the same flag. A dangling link has nothing to
    /// follow and stays a link.
    fn run(&mut self, src_paths: &[String], sink: &mut dyn PackSink) -> Result<(), String> {
        self.emit("", 0.0);
        for path_str in src_paths {
            self.check_cancel()?;
            let src = Path::new(path_str);
            if src.symlink_metadata().is_err() {
                continue;
            }
            let base = src.parent().unwrap_or(src);
            let walk = WalkDir::new(src)
                .follow_links(self.follow_links)
                .follow_root_links(self.follow_links);
            let mut last_name = String::new();
            for entry in walk {
                self.check_cancel()?;
                let entry = entry.map_err(|e| e.to_string())?;
                let name = entry
                    .path()
                    .strip_prefix(base)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .replace('\\', "/");
                self.add_entry(entry.path(), &name, sink)?;
                last_name = name;
            }
            self.emit(&last_name, 100.0);
        }
        Ok(())
    }

    fn add_entry(
        &mut self,
        path: &Path,
        name: &str,
        sink: &mut dyn PackSink,
    ) -> Result<(), String> {
        let link_meta = path
            .symlink_metadata()
            .map_err(|e| format!("{}: {}", path.display(), e))?;
        let meta = if link_meta.file_type().is_symlink() && self.follow_links {
            path.metadata().unwrap_or(link_meta)
        } else {
            link_meta
        };

        if meta.file_type().is_symlink() {
            let target = std::fs::read_link(path).map_err(|e| e.to_string())?;
            return sink.add_symlink(name, &target, &meta);
        }
        if meta.is_dir() {
            return sink.add_dir(name, &meta);
        }
        if !meta.is_file() {
            // Sockets, FIFOs and devices have no content to archive.
            return Ok(());
        }

        let size = meta.len();
        let file = File::open(path).map_err(|e| format!("{}: {}", path.display(), e))?;
        // `take`: a file that grows while it is read must not write past the
        // size already declared in the entry header.
        let mut reader = ProgressFile {
            inner: file.take(size),
            app: self.app,
            current_file: name.to_string(),
            current_file_num: self.current_file_num + 1,
            total_files: self.total_files,
            total_bytes: self.total_bytes,
            bytes_processed_before: self.bytes_processed,
            current_file_size: size,
            current_file_processed: 0,
            started_at: self.started_at,
            cancel_flag: self.cancel_flag.clone(),
            last_emit_time: &self.last_emit_time,
            last_bytes: &self.last_bytes,
        };
        sink.add_file(name, &meta, &mut reader)?;
        // And one that shrank would leave the entry short of its declared size —
        // a corrupt archive reported as a success.
        if reader.current_file_processed != size {
            return Err(format!(
                "{} changed while it was being packed",
                path.display()
            ));
        }
        self.bytes_processed += size;
        self.current_file_num += 1;
        Ok(())
    }
}

fn tar_header(meta: &std::fs::Metadata) -> tar::Header {
    let mut header = tar::Header::new_gnu();
    header.set_metadata_in_mode(meta, tar::HeaderMode::Complete);
    header
}

/// `append_data`/`append_link` rather than `set_path`, so names longer than
/// the 100-byte header field get a GNU long-name record instead of an error.
struct TarSink<W: Write> {
    builder: tar::Builder<W>,
}

impl<W: Write> PackSink for TarSink<W> {
    fn add_dir(&mut self, name: &str, meta: &std::fs::Metadata) -> Result<(), String> {
        let mut header = tar_header(meta);
        header.set_size(0);
        self.builder
            .append_data(&mut header, name, std::io::empty())
            .map_err(|e| format!("{}: {}", name, e))
    }

    fn add_symlink(
        &mut self,
        name: &str,
        target: &Path,
        meta: &std::fs::Metadata,
    ) -> Result<(), String> {
        let mut header = tar_header(meta);
        header.set_size(0);
        self.builder
            .append_link(&mut header, name, target)
            .map_err(|e| format!("{}: {}", name, e))
    }

    fn add_file(
        &mut self,
        name: &str,
        meta: &std::fs::Metadata,
        data: &mut dyn Read,
    ) -> Result<(), String> {
        let mut header = tar_header(meta);
        header.set_size(meta.len());
        self.builder
            .append_data(&mut header, name, data)
            .map_err(|e| format!("{}: {}", name, e))
    }
}

#[cfg(unix)]
fn unix_mode(meta: &std::fs::Metadata) -> u32 {
    use std::os::unix::fs::MetadataExt;
    meta.mode() & 0o7777
}

#[cfg(not(unix))]
fn unix_mode(meta: &std::fs::Metadata) -> u32 {
    if meta.is_dir() {
        0o755
    } else if meta.permissions().readonly() {
        0o444
    } else {
        0o644
    }
}

/// Zip stores local time; a date outside its 1980–2107 range is left to the
/// writer's default.
fn zip_mtime(meta: &std::fs::Metadata) -> Option<zip::DateTime> {
    use chrono::{Datelike, Timelike};
    let local: chrono::DateTime<chrono::Local> = meta.modified().ok()?.into();
    zip::DateTime::from_date_and_time(
        u16::try_from(local.year()).ok()?,
        local.month() as u8,
        local.day() as u8,
        local.hour() as u8,
        local.minute() as u8,
        local.second() as u8,
    )
    .ok()
}

struct ZipSink<W: Write + Seek> {
    zip: zip::ZipWriter<W>,
    options: SimpleFileOptions,
}

impl<W: Write + Seek> ZipSink<W> {
    fn options_for(&self, meta: &std::fs::Metadata) -> SimpleFileOptions {
        let options = self.options.unix_permissions(unix_mode(meta));
        match zip_mtime(meta) {
            Some(mtime) => options.last_modified_time(mtime),
            None => options,
        }
    }
}

impl<W: Write + Seek> PackSink for ZipSink<W> {
    fn add_dir(&mut self, name: &str, meta: &std::fs::Metadata) -> Result<(), String> {
        let options = self.options_for(meta);
        self.zip
            .add_directory(name, options)
            .map_err(|e| format!("Zip error: {}", e))
    }

    fn add_symlink(
        &mut self,
        name: &str,
        target: &Path,
        meta: &std::fs::Metadata,
    ) -> Result<(), String> {
        let options = self.options_for(meta);
        self.zip
            .add_symlink(name, target.to_string_lossy(), options)
            .map_err(|e| format!("Zip error: {}", e))
    }

    fn add_file(
        &mut self,
        name: &str,
        meta: &std::fs::Metadata,
        data: &mut dyn Read,
    ) -> Result<(), String> {
        let options = self.options_for(meta);
        self.zip
            .start_file(name, options)
            .map_err(|e| format!("Zip error: {}", e))?;
        std::io::copy(data, &mut self.zip)
            .map(|_| ())
            .map_err(|e| format!("{}: {}", name, e))
    }
}

/// Pack into a ZIP archive.
fn pack_zip(
    dest_path: &str,
    src_paths: &[String],
    compression_level: u32,
    walk: &mut PackWalk,
) -> Result<(), String> {
    let file = File::create(dest_path).map_err(|e| format!("Failed to create archive: {}", e))?;
    let writer = CancelableWriter {
        inner: file,
        cancel_flag: walk.cancel_flag.clone(),
    };
    let compression = match compression_level {
        0 => zip::CompressionMethod::Stored,
        _ => zip::CompressionMethod::Deflated,
    };
    let mut sink = ZipSink {
        zip: zip::ZipWriter::new(writer),
        options: SimpleFileOptions::default()
            .compression_method(compression)
            .compression_level(Some(compression_level as i64)),
    };
    walk.run(src_paths, &mut sink)?;
    sink.zip
        .finish()
        .map_err(|e| format!("Failed to finish ZIP: {}", e))?;
    Ok(())
}

#[derive(Debug, Clone, Copy)]
enum TarCompression {
    Gzip,
    Bzip2,
    Xz,
    Zstd,
}

/// Pack into a compressed tar archive. Every encoder is finished explicitly:
/// that writes its trailer and is the only place its final write error is
/// reported rather than swallowed by `Drop`.
fn pack_tar(
    dest_path: &str,
    src_paths: &[String],
    compression: TarCompression,
    compression_level: u32,
    walk: &mut PackWalk,
) -> Result<(), String> {
    fn write_tar<W: Write>(
        sink: W,
        src_paths: &[String],
        walk: &mut PackWalk,
    ) -> Result<W, String> {
        let mut tar = TarSink {
            builder: tar::Builder::new(sink),
        };
        walk.run(src_paths, &mut tar)?;
        tar.builder
            .into_inner()
            .map_err(|e| format!("Failed to finish tar: {}", e))
    }

    let file = File::create(dest_path).map_err(|e| format!("Failed to create archive: {}", e))?;
    let writer = CancelableWriter {
        inner: file,
        cancel_flag: walk.cancel_flag.clone(),
    };
    let finished = match compression {
        TarCompression::Gzip => {
            let level = match compression_level {
                0 => flate2::Compression::none(),
                n => flate2::Compression::new(n.min(9)),
            };
            write_tar(
                flate2::write::GzEncoder::new(writer, level),
                src_paths,
                walk,
            )?
            .finish()
        }
        TarCompression::Bzip2 => write_tar(
            BzEncoder::new(
                writer,
                bzip2::Compression::new(compression_level.clamp(1, 9)),
            ),
            src_paths,
            walk,
        )?
        .finish(),
        TarCompression::Xz => write_tar(
            XzEncoder::new(writer, compression_level.clamp(1, 9)),
            src_paths,
            walk,
        )?
        .finish(),
        TarCompression::Zstd => {
            let encoder = ZstdEncoder::new(writer, compression_level as i32)
                .map_err(|e| format!("Failed to create zstd encoder: {}", e))?;
            write_tar(encoder, src_paths, walk)?.finish()
        }
    };
    finished.map_err(|e| format!("Failed to finish the archive: {}", e))?;
    Ok(())
}

pub fn count_pack_items(src_paths: &[String]) -> (u64, u64) {
    let mut total_files: u64 = 0;
    let mut total_bytes: u64 = 0;

    for path_str in src_paths {
        let src_path = Path::new(path_str);
        if !src_path.exists() {
            continue;
        }

        if src_path.is_file() {
            total_files += 1;
            total_bytes += src_path.metadata().map(|m| m.len()).unwrap_or(0);
        } else if src_path.is_dir() {
            for entry in WalkDir::new(src_path).into_iter().filter_map(|e| e.ok()) {
                if entry.path().is_file() {
                    total_files += 1;
                    total_bytes += entry.path().metadata().map(|m| m.len()).unwrap_or(0);
                }
            }
        }
    }

    (total_files, total_bytes)
}

pub fn pack_archive(
    src_paths: &[String],
    dest_path: &str,
    format: &str,
    compression_level: u32,
    follow_links: bool,
    app: Option<&AppHandle>,
    started_at: u64,
    total_files: u64,
    total_bytes: u64,
    cancel_flag: Arc<AtomicBool>,
) -> Result<(), String> {
    // P1.5. Every pack_* implementation below opens the final destination with
    // File::create, which truncates. Packing is long-running and cancellable, so
    // aiming an archive at an existing file and then cancelling — or hitting a
    // full disk — destroyed that file and left a stub behind.
    //
    // Rather than rewrite five format writers to stream into a staging handle,
    // this packs to a staging path in the *destination directory* and commits it
    // by rename. Same protocol, same guarantee, and it keeps the format code
    // untouched until P2.2 makes archive creation job-scoped.
    let commit = ArchiveStaging::begin(dest_path)?;
    let dest_path = commit.staging_path();
    let dest_path = dest_path.as_str();

    let mut walk = PackWalk::new(
        app,
        follow_links,
        started_at,
        total_files,
        total_bytes,
        cancel_flag,
    );
    match format {
        "tar.gz" => pack_tar(
            dest_path,
            src_paths,
            TarCompression::Gzip,
            compression_level,
            &mut walk,
        ),
        "tar.bz2" => pack_tar(
            dest_path,
            src_paths,
            TarCompression::Bzip2,
            compression_level,
            &mut walk,
        ),
        "tar.xz" => pack_tar(
            dest_path,
            src_paths,
            TarCompression::Xz,
            compression_level,
            &mut walk,
        ),
        "tar.zst" => pack_tar(
            dest_path,
            src_paths,
            TarCompression::Zstd,
            compression_level,
            &mut walk,
        ),
        _ => pack_zip(dest_path, src_paths, compression_level, &mut walk),
    }?;

    // Only a fully written archive is published. A cancelled or failed pack drops
    // `commit`, which removes the staging file and leaves any existing archive at
    // the destination exactly as it was.
    commit.publish()
}

/// Packs into a staging file next to the destination and publishes it by rename.
///
/// The five format writers all take a path and open it with `File::create`.
/// Handing them a staging path in the destination directory gives the P1.4
/// protocol's guarantee without rewriting any of them: same filesystem, so the
/// final rename is atomic, and nothing touches the real destination until the
/// archive is complete. P2.2 replaces this with job-scoped archive creation that
/// streams into the commit engine directly.
struct ArchiveStaging {
    dir: crate::engine::path_policy::DirHandle,
    staging_name: std::ffi::OsString,
    target_name: std::ffi::OsString,
    published: bool,
}

impl ArchiveStaging {
    fn begin(dest_path: &str) -> Result<Self, String> {
        let dest = Path::new(dest_path);
        let parent = dest
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .ok_or_else(|| format!("Archive destination has no parent directory: {}", dest_path))?;
        let target_name = dest
            .file_name()
            .ok_or_else(|| format!("Archive destination has no file name: {}", dest_path))?
            .to_os_string();

        let policy = crate::engine::path_policy::PathPolicy::default();
        let dir = policy.open_dir(parent).map_err(|e| e.to_string())?;

        if matches!(
            dir.entry_kind(&target_name).map_err(|e| e.to_string())?,
            Some(crate::engine::path_policy::EntryKind::Dir)
        ) {
            return Err(format!(
                "'{}' is a directory; it cannot be replaced by an archive.",
                dest_path
            ));
        }

        // A distinct name from the commit engine's own staging prefix, because
        // this file is written by an external crate rather than through `Staged`.
        let staging_name = std::ffi::OsString::from(format!(
            ".nc-archive-{}.part",
            uuid::Uuid::new_v4().simple()
        ));
        // Claim the name with O_CREAT|O_EXCL so it cannot collide or be
        // redirected, then let the format writer reopen it by path.
        drop(
            dir.create_new_file(&staging_name)
                .map_err(|e| e.to_string())?,
        );

        Ok(ArchiveStaging {
            dir,
            staging_name,
            target_name,
            published: false,
        })
    }

    fn staging_path(&self) -> String {
        self.dir
            .path()
            .join(&self.staging_name)
            .to_string_lossy()
            .to_string()
    }

    fn publish(mut self) -> Result<(), String> {
        self.dir
            .rename(&self.staging_name, &self.target_name)
            .map_err(|e| {
                format!(
                    "The archive was created but could not be moved into place: {}.                      Your data is complete in '{}'.",
                    e,
                    self.dir.path().join(&self.staging_name).display()
                )
            })?;
        self.published = true;
        Ok(())
    }
}

impl Drop for ArchiveStaging {
    fn drop(&mut self) {
        if !self.published {
            // Best effort. A cancelled pack must not leave a stub where the
            // user's archive was, and must not leave the partial file either.
            let _ = self.dir.remove_file(&self.staging_name);
        }
    }
}

/// Hard caps applied during archive extraction to defend against Zip Slip /
/// Tar Slip path escapes and decompression ("zip bomb") resource exhaustion.
/// Archives are attacker-controlled input, so these limits are enforced
/// ourselves instead of relying solely on the underlying `zip`/`tar` crates.
const MAX_ARCHIVE_ENTRIES: u64 = 200_000;
const MAX_TOTAL_UNCOMPRESSED_BYTES: u64 = 20 * 1024 * 1024 * 1024; // 20 GiB
const MAX_ENTRY_COMPRESSION_RATIO: u64 = 1032;
const MIN_SIZE_FOR_RATIO_CHECK: u64 = 100 * 1024 * 1024; // 100 MiB
const MAX_PATH_COMPONENT_LEN: usize = 255;
const MAX_PATH_TOTAL_LEN: usize = 4096;

/// How many conflicting paths an [`UnpackReport`] carries by name.
///
/// The counts are exact; the samples are capped. Extracting a 200 000-entry
/// archive over a populated directory must not hand the webview a
/// 200 000-element array to render.
const MAX_REPORTED_CONFLICTS: usize = 100;

/// What promotion does when the destination name is already taken.
///
/// `Skip` is the default because it is the only answer that cannot lose data,
/// and losing data is exactly what the previous promotion did: a bare
/// `fs::rename` over whatever happened to be there, with no report. Extraction
/// is the one mutation where the *source* is attacker-controlled, so the
/// destination gets the conservative default and the user opts in to the rest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExtractConflict {
    #[default]
    Skip,
    /// Replace through `engine::commit` — an atomic publish, never a truncate.
    Replace,
    /// Publish beside it under the first free `name (n).ext`.
    KeepBoth,
}

/// What an extraction actually did.
///
/// `unpack_archive` used to return `()`, so "extracted all 400 files" and
/// "extracted nothing because every name was taken" were the same value. Both
/// are legitimate outcomes of a safe extraction; only one of them is what the
/// user asked for, and the caller cannot phrase the difference from a unit.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UnpackReport {
    /// Entries published under the name the archive asked for.
    pub promoted: u64,
    /// Entries that replaced an existing file (`ExtractConflict::Replace`).
    pub replaced: u64,
    /// Entries left on the floor because something was already there.
    pub skipped_count: u64,
    /// Entries published under a different name (`ExtractConflict::KeepBoth`).
    pub kept_both_count: u64,
    /// Destination-relative paths, capped at [`MAX_REPORTED_CONFLICTS`].
    pub skipped_sample: Vec<String>,
    /// Destination-relative paths as actually published, same cap.
    pub kept_both_sample: Vec<String>,
}

impl UnpackReport {
    fn record_skipped(&mut self, rel: &Path) {
        self.skipped_count += 1;
        if self.skipped_sample.len() < MAX_REPORTED_CONFLICTS {
            self.skipped_sample.push(rel.to_string_lossy().to_string());
        }
    }

    fn record_kept_both(&mut self, rel: &Path) {
        self.kept_both_count += 1;
        if self.kept_both_sample.len() < MAX_REPORTED_CONFLICTS {
            self.kept_both_sample
                .push(rel.to_string_lossy().to_string());
        }
    }

    /// Whether anything the archive contained was *not* published as-is. The UI
    /// keys its "N items were skipped" message off this rather than off an
    /// error, because a skip is a success with a caveat, not a failure.
    pub fn had_conflicts(&self) -> bool {
        self.skipped_count > 0 || self.kept_both_count > 0 || self.replaced > 0
    }
}

/// Validate that an archive entry's relative path cannot escape `dest`,
/// rejecting absolute paths, `..`, and platform path prefixes/roots.
fn validate_relative_entry_path(dest: &Path, rel: &Path) -> Result<std::path::PathBuf, String> {
    if rel.as_os_str().is_empty() {
        return Err("Archive entry has an empty path".to_string());
    }
    if rel.is_absolute() {
        return Err(format!(
            "Archive entry has an absolute path: {}",
            rel.display()
        ));
    }
    for component in rel.components() {
        match component {
            std::path::Component::Normal(part) => {
                if part.len() > MAX_PATH_COMPONENT_LEN {
                    return Err(format!(
                        "Archive entry path component too long: {}",
                        rel.display()
                    ));
                }
            }
            std::path::Component::CurDir => {}
            _ => {
                return Err(format!(
                    "Archive entry contains an unsafe path component: {}",
                    rel.display()
                ));
            }
        }
    }
    if rel.as_os_str().len() > MAX_PATH_TOTAL_LEN {
        return Err(format!("Archive entry path too long: {}", rel.display()));
    }

    let out_path = dest.join(rel);
    if !out_path.starts_with(dest) {
        return Err(format!(
            "Archive entry escapes destination directory: {}",
            rel.display()
        ));
    }
    Ok(out_path)
}

fn entry_matches_filter(rel_path: &Path, name: &str, filter: Option<&[String]>) -> bool {
    let Some(filter) = filter else {
        return true;
    };
    if filter.is_empty() {
        return true;
    }

    let rel_str = rel_path.to_string_lossy().to_string();
    let clean_rel = rel_str.trim_start_matches("./").trim_start_matches('/');
    let clean_name = name.trim_start_matches("./").trim_start_matches('/');

    filter.iter().any(|target| {
        let clean_target = target.trim_start_matches("./").trim_start_matches('/');
        clean_rel == clean_target
            || clean_name == clean_target
            || clean_rel.starts_with(&format!("{}/", clean_target))
            || clean_name.starts_with(&format!("{}/", clean_target))
            || clean_rel.split('/').next_back() == Some(clean_target)
            || clean_name.split('/').next_back() == Some(clean_target)
    })
}

/// A Unix root, a Windows root or a drive letter at the start of an entry name.
fn is_absolute_entry_name(name: &str) -> bool {
    let b = name.as_bytes();
    name.starts_with('/')
        || name.starts_with('\\')
        || (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':')
}

/// Safely extract a ZIP archive entry-by-entry, rejecting path traversal,
/// symlink entries and oversized/high-ratio entries.
fn unpack_zip_safe(
    src_path: &str,
    dest: &Path,
    filter: Option<&[String]>,
    app: Option<&AppHandle>,
    started_at: u64,
    last_emit: &Mutex<Instant>,
) -> Result<(), String> {
    let file = File::open(src_path).map_err(|e| format!("Failed to open archive: {}", e))?;
    let mut archive = zip::ZipArchive::new(BufReader::new(file))
        .map_err(|e| format!("Failed to read ZIP: {}", e))?;

    let entry_count = archive.len() as u64;
    if entry_count > MAX_ARCHIVE_ENTRIES {
        return Err(format!(
            "Archive has too many entries ({} > {})",
            entry_count, MAX_ARCHIVE_ENTRIES
        ));
    }

    // Count file entries (non-dirs) that pass the filter for accurate total
    let total_files: u64 = (0..archive.len())
        .filter(|&i| {
            if let Ok(e) = archive.by_index_raw(i) {
                let Ok(name) = e.name().map(|n| n.to_string()) else {
                    return false;
                };
                if let Some(rel) = e.enclosed_name() {
                    return !e.is_dir() && entry_matches_filter(&rel, &name, filter);
                }
            }
            false
        })
        .count() as u64;

    let mut total_bytes: u64 = 0;
    let mut files_done: u64 = 0;
    let mut bytes_written: u64 = 0;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read ZIP entry {}: {}", i, e))?;

        let name = entry
            .name()
            .map_err(|e| format!("Unreadable name in ZIP entry {}: {}", i, e))?
            .to_string();
        // zip ≥ 9 makes an absolute name relative instead of rejecting it, which
        // would extract `/etc/x` as `<dest>/etc/x`. Contained, but an archive
        // that names absolute paths is refused outright, as it always was here.
        if is_absolute_entry_name(&name) {
            return Err(format!("Unsafe path in ZIP entry: {}", name));
        }
        let rel = entry
            .enclosed_name()
            .ok_or_else(|| format!("Unsafe path in ZIP entry: {}", name))?;

        if !entry_matches_filter(&rel, &name, filter) {
            continue;
        }

        let out_path = validate_relative_entry_path(dest, &rel)?;

        if entry.is_symlink() {
            return Err(format!("Refusing to extract symlink entry: {}", name));
        }

        if entry.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
            continue;
        }

        let declared_size = entry.size();
        let compressed_size = entry.compressed_size();
        if compressed_size > 0
            && declared_size > MIN_SIZE_FOR_RATIO_CHECK
            && declared_size > compressed_size.saturating_mul(MAX_ENTRY_COMPRESSION_RATIO)
        {
            return Err(format!(
                "ZIP entry {} exceeds allowed compression ratio (possible decompression bomb)",
                name
            ));
        }

        total_bytes = total_bytes.saturating_add(declared_size);
        if total_bytes > MAX_TOTAL_UNCOMPRESSED_BYTES {
            return Err(format!(
                "Archive exceeds maximum total uncompressed size ({} bytes)",
                MAX_TOTAL_UNCOMPRESSED_BYTES
            ));
        }

        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        let mut out_file = File::create(&out_path)
            .map_err(|e| format!("Failed to create {}: {}", out_path.display(), e))?;
        // Bound the actual bytes written to the declared size regardless of
        // what the compressed stream could otherwise expand to.
        let mut limited = (&mut entry).take(declared_size);
        let written = copy_with_unpack_progress(
            &mut limited,
            &mut out_file,
            app,
            &name,
            files_done + 1,
            total_files,
            files_done,
            bytes_written,
            declared_size,
            started_at,
            last_emit,
        )
        .map_err(|e| format!("Failed to extract {}: {}", out_path.display(), e))?;

        files_done += 1;
        bytes_written = bytes_written.saturating_add(written);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Some(mode) = entry.unix_mode() {
                // Mask out setuid/setgid/sticky bits from untrusted archives.
                let _ = std::fs::set_permissions(
                    &out_path,
                    std::fs::Permissions::from_mode(mode & 0o777),
                );
            }
        }
    }

    Ok(())
}

/// Safely extract entries of a tar archive (already decompressed),
/// rejecting path traversal, symlinks/hardlinks/special files and enforcing
/// entry-count and total-size caps.
fn unpack_tar_entries<R: Read>(
    archive: &mut tar::Archive<R>,
    dest: &Path,
    filter: Option<&[String]>,
    app: Option<&AppHandle>,
    total_files_hint: u64,
    started_at: u64,
    last_emit: &Mutex<Instant>,
) -> Result<(), String> {
    let mut entry_count: u64 = 0;
    let mut total_bytes: u64 = 0;
    let mut files_done: u64 = 0;
    let mut bytes_written: u64 = 0;

    let entries = archive
        .entries()
        .map_err(|e| format!("Failed to read tar entries: {}", e))?;

    for entry in entries {
        let mut entry = entry.map_err(|e| format!("Failed to read tar entry: {}", e))?;

        entry_count += 1;
        if entry_count > MAX_ARCHIVE_ENTRIES {
            return Err(format!(
                "Archive has too many entries (> {})",
                MAX_ARCHIVE_ENTRIES
            ));
        }

        let entry_type = entry.header().entry_type();
        if entry_type.is_symlink() || entry_type.is_hard_link() {
            return Err("Refusing to extract symlink/hardlink entry from tar archive".to_string());
        }
        if entry_type.is_character_special()
            || entry_type.is_block_special()
            || entry_type.is_fifo()
        {
            return Err("Refusing to extract special device entry from tar archive".to_string());
        }
        if !entry_type.is_file() && !entry_type.is_dir() {
            // Skip GNU/PAX metadata entry types that aren't actual content.
            continue;
        }

        let rel = entry
            .path()
            .map_err(|e| format!("Invalid entry path: {}", e))?
            .into_owned();
        let name = rel.to_string_lossy().to_string();

        if !entry_matches_filter(&rel, &name, filter) {
            continue;
        }

        let out_path = validate_relative_entry_path(dest, &rel)?;

        let size = entry.header().size().unwrap_or(0);
        total_bytes = total_bytes.saturating_add(size);
        if total_bytes > MAX_TOTAL_UNCOMPRESSED_BYTES {
            return Err(format!(
                "Archive exceeds maximum total uncompressed size ({} bytes)",
                MAX_TOTAL_UNCOMPRESSED_BYTES
            ));
        }

        if entry_type.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
            continue;
        }

        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        let mut out_file = File::create(&out_path)
            .map_err(|e| format!("Failed to create {}: {}", out_path.display(), e))?;
        let visible_total = if total_files_hint > 0 {
            total_files_hint
        } else {
            files_done + 1
        };
        let written = copy_with_unpack_progress(
            &mut entry,
            &mut out_file,
            app,
            &name,
            files_done + 1,
            visible_total,
            files_done,
            bytes_written,
            size,
            started_at,
            last_emit,
        )
        .map_err(|e| format!("Failed to unpack {}: {}", out_path.display(), e))?;

        files_done += 1;
        bytes_written = bytes_written.saturating_add(written);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(mode) = entry.header().mode() {
                // Mask out setuid/setgid/sticky bits from untrusted archives.
                let _ = std::fs::set_permissions(
                    &out_path,
                    std::fs::Permissions::from_mode(mode & 0o777),
                );
            }
        }
    }

    Ok(())
}

/// Unpack an archive to the target directory via private staging and promotion.
pub fn unpack_archive(
    src_path: &str,
    dest_dir: &str,
    entries_filter: Option<&[String]>,
    conflict: ExtractConflict,
    app: Option<&AppHandle>,
) -> Result<UnpackReport, String> {
    let src_path = src_path.trim_end_matches('/');
    let dest_dir = dest_dir.trim_end_matches('/');
    let lower = src_path.to_lowercase();
    let dest = Path::new(dest_dir);

    if !dest.exists() {
        std::fs::create_dir_all(dest).map_err(|e: std::io::Error| e.to_string())?;
    }
    let dest = dest
        .canonicalize()
        .map_err(|e| format!("Failed to resolve destination directory: {}", e))?;
    let dest = dest.as_path();

    let started_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let last_emit = Mutex::new(Instant::now() - Duration::from_secs(1));

    let now_nanos = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let staging_dir = dest.join(format!(
        ".nc_extract_tmp_{}_{}",
        std::process::id(),
        now_nanos
    ));
    // Staging lives inside the destination so that promoting an entry is a
    // same-filesystem rename, and at 0700 so the extracted tree is not readable
    // by other local users during the window before promotion.
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(&staging_dir)
        .map_err(|e| format!("Failed to create extraction staging directory: {}", e))?;

    let unpack_res = (|| -> Result<(), String> {
        if lower.ends_with(".zip") {
            unpack_zip_safe(
                src_path,
                &staging_dir,
                entries_filter,
                app,
                started_at,
                &last_emit,
            )?;
        } else if lower.ends_with(".tar")
            || lower.ends_with(".tar.gz")
            || lower.ends_with(".tgz")
            || lower.ends_with(".tar.bz2")
            || lower.ends_with(".tbz2")
            || lower.ends_with(".tar.xz")
            || lower.ends_with(".txz")
            || lower.ends_with(".tar.zst")
            || lower.ends_with(".tzst")
            || lower.ends_with(".zst")
        {
            let file =
                File::open(src_path).map_err(|e| format!("Failed to open archive: {}", e))?;
            let total_size = file.metadata().map(|m| m.len()).unwrap_or(0);
            let progress_reader = ProgressReader {
                inner: file,
                total: if total_size == 0 { 1 } else { total_size },
                current: 0,
                on_progress: |p| {
                    println!("Unpacking progress: {:.1}%", p);
                },
            };
            let buf_reader = BufReader::new(progress_reader);

            if lower.ends_with(".gz") || lower.ends_with(".tgz") {
                let gz = flate2::read::GzDecoder::new(buf_reader);
                let mut archive = tar::Archive::new(gz);
                unpack_tar_entries(
                    &mut archive,
                    &staging_dir,
                    entries_filter,
                    app,
                    0,
                    started_at,
                    &last_emit,
                )?;
            } else if lower.ends_with(".bz2") || lower.ends_with(".tbz2") {
                let bz = bzip2::read::BzDecoder::new(buf_reader);
                let mut archive = tar::Archive::new(bz);
                unpack_tar_entries(
                    &mut archive,
                    &staging_dir,
                    entries_filter,
                    app,
                    0,
                    started_at,
                    &last_emit,
                )?;
            } else if lower.ends_with(".xz") || lower.ends_with(".txz") {
                let xz = xz2::read::XzDecoder::new(buf_reader);
                let mut archive = tar::Archive::new(xz);
                unpack_tar_entries(
                    &mut archive,
                    &staging_dir,
                    entries_filter,
                    app,
                    0,
                    started_at,
                    &last_emit,
                )?;
            } else if lower.ends_with(".zst") || lower.ends_with(".tzst") {
                let zst = zstd::stream::read::Decoder::new(buf_reader)
                    .map_err(|e| format!("Failed to create zstd decoder: {}", e))?;
                let mut archive = tar::Archive::new(zst);
                unpack_tar_entries(
                    &mut archive,
                    &staging_dir,
                    entries_filter,
                    app,
                    0,
                    started_at,
                    &last_emit,
                )?;
            } else {
                let mut archive = tar::Archive::new(buf_reader);
                unpack_tar_entries(
                    &mut archive,
                    &staging_dir,
                    entries_filter,
                    app,
                    0,
                    started_at,
                    &last_emit,
                )?;
            }
        } else {
            return Err(format!("Unpacking not supported for: {}", src_path));
        }
        Ok(())
    })();

    if let Err(e) = unpack_res {
        let _ = std::fs::remove_dir_all(&staging_dir);
        return Err(e);
    }

    let mut report = UnpackReport::default();
    let promote_res =
        promote_extracted_dir(&staging_dir, dest, Path::new(""), conflict, &mut report);
    // Whatever is left in staging is either a skipped entry or the remains of a
    // failed promotion. Neither belongs in the destination the user is looking
    // at, and neither is recoverable from here.
    let _ = std::fs::remove_dir_all(&staging_dir);
    promote_res.map(|()| report)
}

/// Move the extracted tree out of staging and into `dest_dir`.
///
/// Every file goes through `engine::commit::move_entry_staged`, so the publish
/// is one atomic rename on the destination filesystem (staging lives inside
/// `dest_dir` precisely so that holds) and an existing entry is only ever
/// replaced when `conflict` says so. The version this replaced called
/// `fs::rename` unconditionally with a `fs::copy` fallback: extracting an
/// archive that happened to contain `notes.txt` destroyed the user's
/// `notes.txt` with no prompt, no report and no way back — QSF-001's shape in
/// the one code path where the colliding name is chosen by the archive rather
/// than by the user.
///
/// `rel` is the path relative to the extraction root, carried down purely so
/// the report can name conflicts the way the user sees them.
fn promote_extracted_dir(
    staging_dir: &Path,
    dest_dir: &Path,
    rel: &Path,
    conflict: ExtractConflict,
    report: &mut UnpackReport,
) -> Result<(), String> {
    // Extraction promotion is a move: same filesystem, so `move_entry_staged`
    // resolves to a single `renameat` and the staged-copy path only exists for
    // the case that cannot happen here.
    let spec = crate::engine::spec::OperationSpec::new(
        crate::engine::spec::OperationKind::Move,
        Vec::new(),
        None,
    );
    let policy = crate::engine::path_policy::PathPolicy::new(spec.symlinks);

    let entries = std::fs::read_dir(staging_dir)
        .map_err(|e| format!("Failed to read extraction staging directory: {}", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read staging entry: {}", e))?;
        let src_path = entry.path();
        let name = entry.file_name();
        let rel_path = rel.join(&name);
        let target_path = dest_dir.join(&name);

        // `symlink_metadata`, not `exists`: a symlink sitting at the target name
        // is an existing entry, not whatever it points at. Following it is how a
        // write lands outside the directory the user chose (QSF-003), and an
        // archive that ships `config -> /etc/passwd` is the reason to care.
        let existing = std::fs::symlink_metadata(&target_path).ok();

        if src_path.is_dir() {
            match existing {
                Some(md) if md.is_dir() => {}
                Some(_) => {
                    // A file or a link occupies the name the archive wants for a
                    // directory. There is no merge to perform and nothing safe to
                    // replace, so the whole subtree is skipped as one item.
                    report.record_skipped(&rel_path);
                    continue;
                }
                None => {
                    std::fs::create_dir_all(&target_path).map_err(|e| {
                        format!(
                            "Failed to create extracted directory {}: {}",
                            rel_path.display(),
                            e
                        )
                    })?;
                }
            }
            promote_extracted_dir(&src_path, &target_path, &rel_path, conflict, report)?;
            continue;
        }

        let (final_name, replace, outcome) = match (existing.is_some(), conflict) {
            (false, _) => (
                name.clone(),
                crate::engine::commit::Replace::Never,
                PromotedAs::Fresh,
            ),
            (true, ExtractConflict::Skip) => {
                report.record_skipped(&rel_path);
                continue;
            }
            (true, ExtractConflict::Replace) => (
                name.clone(),
                crate::engine::commit::Replace::IfFile,
                PromotedAs::Replaced,
            ),
            (true, ExtractConflict::KeepBoth) => {
                let dir = policy
                    .open_dir(dest_dir)
                    .map_err(|e| format!("Failed to open destination directory: {}", e))?;
                let free = crate::engine::commit::keep_both_name(&dir, &name)
                    .map_err(|e| format!("Failed to find a free name for {:?}: {}", name, e))?;
                report.record_kept_both(&rel.join(&free));
                (
                    free,
                    crate::engine::commit::Replace::Never,
                    PromotedAs::KeptBoth,
                )
            }
        };

        crate::engine::commit::move_entry_staged(
            &policy,
            &src_path,
            &dest_dir.join(&final_name),
            spec.verification,
            spec.metadata,
            replace,
            &mut |_| Ok(()),
        )
        .map_err(|e| {
            format!(
                "Failed to promote extracted file {}: {}",
                rel_path.display(),
                e
            )
        })?;

        match outcome {
            PromotedAs::Fresh => report.promoted += 1,
            PromotedAs::Replaced => report.replaced += 1,
            PromotedAs::KeptBoth => {}
        }
    }
    Ok(())
}

/// Which counter a successful promotion belongs to. `KeptBoth` is already
/// counted when its name is chosen, so it lands in no counter here.
enum PromotedAs {
    Fresh,
    Replaced,
    KeptBoth,
}

/// Test the integrity of an archive without writing extracted files to disk.
/// Returns Ok(true) if valid, Ok(false) if corrupted or invalid, Err if unreadable or unsupported.
pub fn test_archive(path: &str) -> Result<bool, String> {
    let p = Path::new(path);
    if !p.exists() || !p.is_file() {
        return Err(format!("Archive file not found or is not a file: {}", path));
    }

    let lower = path.to_lowercase();
    if lower.ends_with(".zip") {
        let file = File::open(path).map_err(|e| format!("Failed to open archive: {}", e))?;
        let mut archive = match zip::ZipArchive::new(BufReader::new(file)) {
            Ok(a) => a,
            Err(_) => return Ok(false),
        };

        if (archive.len() as u64) > MAX_ARCHIVE_ENTRIES {
            return Ok(false);
        }

        let mut sink = std::io::sink();
        for i in 0..archive.len() {
            let mut entry = match archive.by_index(i) {
                Ok(e) => e,
                Err(_) => return Ok(false),
            };
            if !entry.is_dir() {
                // Read and decompress into sink; zip verifies CRC32 and decompression on stream read
                if std::io::copy(&mut entry, &mut sink).is_err() {
                    return Ok(false);
                }
            }
        }
        Ok(true)
    } else if lower.ends_with(".tar")
        || lower.ends_with(".tar.gz")
        || lower.ends_with(".tgz")
        || lower.ends_with(".tar.bz2")
        || lower.ends_with(".tbz2")
        || lower.ends_with(".tar.xz")
        || lower.ends_with(".txz")
        || lower.ends_with(".tar.zst")
        || lower.ends_with(".tzst")
    {
        let file = File::open(path).map_err(|e| format!("Failed to open archive: {}", e))?;
        let reader = BufReader::new(file);

        let test_tar = |decoder: Box<dyn Read>| -> bool {
            let mut archive = tar::Archive::new(decoder);
            let entries = match archive.entries() {
                Ok(e) => e,
                Err(_) => return false,
            };
            let mut sink = std::io::sink();
            for entry in entries {
                let mut entry = match entry {
                    Ok(e) => e,
                    Err(_) => return false,
                };
                if std::io::copy(&mut entry, &mut sink).is_err() {
                    return false;
                }
            }
            true
        };

        let ok = if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
            test_tar(Box::new(flate2::read::GzDecoder::new(reader)))
        } else if lower.ends_with(".tar.bz2") || lower.ends_with(".tbz2") {
            test_tar(Box::new(bzip2::read::BzDecoder::new(reader)))
        } else if lower.ends_with(".tar.xz") || lower.ends_with(".txz") {
            test_tar(Box::new(xz2::read::XzDecoder::new(reader)))
        } else if lower.ends_with(".tar.zst") || lower.ends_with(".tzst") {
            match zstd::stream::read::Decoder::new(reader) {
                Ok(zst) => test_tar(Box::new(zst)),
                Err(_) => return Ok(false),
            }
        } else {
            test_tar(Box::new(reader))
        };
        Ok(ok)
    } else if lower.ends_with(".gz") {
        let file = File::open(path).map_err(|e| format!("Failed to open archive: {}", e))?;
        let mut decoder = flate2::read::GzDecoder::new(BufReader::new(file));
        let mut sink = std::io::sink();
        Ok(std::io::copy(&mut decoder, &mut sink).is_ok())
    } else if lower.ends_with(".zst") {
        let file = File::open(path).map_err(|e| format!("Failed to open archive: {}", e))?;
        let mut decoder = match zstd::stream::read::Decoder::new(BufReader::new(file)) {
            Ok(d) => d,
            Err(_) => return Ok(false),
        };
        let mut sink = std::io::sink();
        Ok(std::io::copy(&mut decoder, &mut sink).is_ok())
    } else if lower.ends_with(".7z") {
        let status = std::process::Command::new("7z")
            .args(["t", path])
            .output()
            .or_else(|_| std::process::Command::new("7za").args(["t", path]).output());

        match status {
            Ok(out) => Ok(out.status.success()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                Err("7z or 7za executable not found on PATH".to_string())
            }
            Err(e) => Err(format!("Failed to execute 7z test: {}", e)),
        }
    } else {
        Err(format!("Unsupported archive format: {}", path))
    }
}

/// Split a file into chunks of `chunk_size` bytes in `dest_dir`.
/// Creates parts named `<basename>.001`, `<basename>.002`, etc.
/// Uses transaction staging via `crate::engine::commit::Staged` for each chunk.
pub fn split_file(
    path: &str,
    chunk_size: u64,
    dest_dir: &str,
) -> Result<crate::vfs::OpResult, String> {
    use crate::engine::commit::{Replace, Staged};
    use crate::engine::path_policy::PathPolicy;
    use crate::engine::spec::OperationKind;
    use crate::vfs::OpResult;

    let src_p = Path::new(path);
    if !src_p.exists() || !src_p.is_file() {
        return Ok(OpResult::err(&format!(
            "Source file does not exist or is not a regular file: {}",
            path
        )));
    }

    if chunk_size == 0 {
        return Ok(OpResult::err("Invalid chunk size: must be greater than 0"));
    }

    let dest_p = Path::new(dest_dir);
    if let Err(e) = std::fs::create_dir_all(dest_p) {
        return Ok(OpResult::err(&format!(
            "Failed to create destination directory: {}",
            e
        )));
    }

    let base_name = match src_p.file_name() {
        Some(name) => name.to_string_lossy().to_string(),
        None => return Ok(OpResult::err("Invalid source file name")),
    };

    let mut src_file = match File::open(src_p) {
        Ok(f) => f,
        Err(e) => return Ok(OpResult::err(&format!("Failed to open source file: {}", e))),
    };

    let policy = PathPolicy::default();
    let verification =
        crate::engine::spec::OperationSpec::new(OperationKind::Write, Vec::new(), None)
            .verification;

    let mut part_index: u64 = 1;
    let mut parts_committed: u64 = 0;
    let mut total_bytes: u64 = 0;
    let mut weakest_durability: Option<crate::engine::spec::Durability> = None;
    let mut all_directories_synced = true;
    let mut buffer = vec![0u8; std::cmp::min(chunk_size, 64 * 1024) as usize];

    loop {
        let part_name = format!("{}.{:03}", base_name, part_index);
        let part_target = dest_p.join(&part_name);

        let mut staged = match Staged::create(&policy, &part_target, verification, Replace::IfFile)
        {
            Ok(s) => s,
            Err(e) => {
                return Ok(OpResult::err(&format!(
                    "Failed to stage part {}: {}",
                    part_name, e
                )))
            }
        };

        let mut chunk_bytes_written: u64 = 0;
        while chunk_bytes_written < chunk_size {
            let to_read =
                std::cmp::min(buffer.len() as u64, chunk_size - chunk_bytes_written) as usize;

            let bytes_read = match src_file.read(&mut buffer[..to_read]) {
                Ok(n) => n,
                Err(e) => return Ok(OpResult::err(&format!("Error reading source file: {}", e))),
            };

            if bytes_read == 0 {
                break;
            }

            if let Err(e) = staged.write(&buffer[..bytes_read]) {
                return Ok(OpResult::err(&format!(
                    "Error writing part {}: {}",
                    part_name, e
                )));
            }

            chunk_bytes_written += bytes_read as u64;
        }

        // If nothing was read for this chunk and we already wrote at least one part, we are done.
        // If the original file was 0 bytes, we write a single empty part .001.
        if chunk_bytes_written == 0 && part_index > 1 {
            break;
        }

        let report = match staged.commit(Some(chunk_bytes_written)) {
            Ok(r) => r,
            Err(e) => {
                return Ok(OpResult::err(&format!(
                    "Failed to commit part {}: {}",
                    part_name, e
                )))
            }
        };
        total_bytes += report.bytes;
        // A split is only as durable as its weakest part, so carry the lowest
        // claim rather than the last one.
        weakest_durability = match weakest_durability {
            Some(current) if current <= report.durability => Some(current),
            _ => Some(report.durability),
        };
        all_directories_synced &= report.directory_synced;
        parts_committed += 1;

        // If we read less than chunk_size, we reached EOF.
        if chunk_bytes_written < chunk_size {
            break;
        }

        part_index += 1;
    }

    // Durability is a policy, not a default: phrase the result from the commit
    // reports rather than implying the bytes reached the platter.
    let claim = weakest_durability
        .map(|d| {
            crate::engine::commit::CommitReport {
                bytes: total_bytes,
                replaced_existing: false,
                durability: d,
                directory_synced: all_directories_synced,
                verified_digest: false,
            }
            .durability_claim()
        })
        .unwrap_or("written (not flushed)");

    Ok(OpResult::ok(&format!(
        "Split {} into {} part(s) ({} bytes, {})",
        base_name, parts_committed, total_bytes, claim
    )))
}

/// Combine multiple source parts in `sources` into `dest_path`.
/// Streams through `crate::engine::commit::Staged` so the output is only
/// published upon complete, verified write of all sources.
pub fn combine_files(sources: &[String], dest_path: &str) -> Result<crate::vfs::OpResult, String> {
    use crate::engine::commit::{Replace, Staged};
    use crate::engine::path_policy::PathPolicy;
    use crate::engine::spec::OperationKind;
    use crate::vfs::OpResult;

    if sources.is_empty() {
        return Ok(OpResult::err("No source files specified"));
    }

    for src in sources {
        let p = Path::new(src);
        if !p.exists() || !p.is_file() {
            return Ok(OpResult::err(&format!(
                "Source file not found or is not a file: {}",
                src
            )));
        }
    }

    let dest_p = Path::new(dest_path);
    if let Some(parent) = dest_p.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return Ok(OpResult::err(&format!(
                "Failed to create parent directory for destination: {}",
                e
            )));
        }
    }

    let policy = PathPolicy::default();
    let verification =
        crate::engine::spec::OperationSpec::new(OperationKind::Write, Vec::new(), None)
            .verification;

    let mut staged = match Staged::create(&policy, dest_p, verification, Replace::IfFile) {
        Ok(s) => s,
        Err(e) => {
            return Ok(OpResult::err(&format!(
                "Failed to stage combined file: {}",
                e
            )))
        }
    };

    let mut total_bytes: u64 = 0;
    let mut buffer = [0u8; 64 * 1024];

    for src in sources {
        let mut file = match File::open(src) {
            Ok(f) => f,
            Err(e) => {
                return Ok(OpResult::err(&format!(
                    "Failed to open source file {}: {}",
                    src, e
                )))
            }
        };

        loop {
            let bytes_read = match file.read(&mut buffer) {
                Ok(n) => n,
                Err(e) => {
                    return Ok(OpResult::err(&format!(
                        "Failed reading source file {}: {}",
                        src, e
                    )))
                }
            };

            if bytes_read == 0 {
                break;
            }

            if let Err(e) = staged.write(&buffer[..bytes_read]) {
                return Ok(OpResult::err(&format!(
                    "Failed writing to combined file: {}",
                    e
                )));
            }

            total_bytes += bytes_read as u64;
        }
    }

    let report = match staged.commit(Some(total_bytes)) {
        Ok(r) => r,
        Err(e) => {
            return Ok(OpResult::err(&format!(
                "Failed to commit combined file: {}",
                e
            )))
        }
    };

    // Durability is a policy, not a default: phrase the result from the commit
    // report rather than implying the bytes reached the platter.
    Ok(OpResult::ok(&format!(
        "Combined {} part(s) into {} ({} bytes, {})",
        sources.len(),
        dest_path,
        report.bytes,
        report.durability_claim()
    )))
}

#[cfg(test)]
mod extraction_safety_tests {
    use super::*;
    use std::io::Cursor;

    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "nc-archive-test-{}-{}-{}",
                name,
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn build_zip_with_entry(name: &str, contents: &[u8]) -> Vec<u8> {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut buf);
            let options =
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
            writer.start_file(name, options).unwrap();
            writer.write_all(contents).unwrap();
            writer.finish().unwrap();
        }
        buf.into_inner()
    }

    fn build_tar_with_raw_path(path: &str, contents: &[u8]) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_size(contents.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        // Bypass tar::Builder's own path handling to embed a raw
        // (potentially malicious) path directly into the header, the same
        // way a hand-crafted malicious tar file would.
        {
            let name_bytes = path.as_bytes();
            let header_bytes = header.as_mut_bytes();
            header_bytes[..name_bytes.len().min(100)]
                .copy_from_slice(&name_bytes[..name_bytes.len().min(100)]);
        }
        header.set_cksum();
        builder.append(&header, contents).unwrap();
        builder.into_inner().unwrap()
    }

    fn build_tar_symlink(name: &str, link_target: &str) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_size(0);
        header.set_mode(0o777);
        header.set_path(name).unwrap();
        header.set_link_name(link_target).unwrap();
        header.set_cksum();
        builder.append(&header, std::io::empty()).unwrap();
        builder.into_inner().unwrap()
    }

    #[test]
    fn zip_slip_parent_traversal_is_blocked() {
        let tmp = TempDir::new("zip-slip");
        let dest = tmp.path().join("dest");
        std::fs::create_dir_all(&dest).unwrap();
        let dest = dest.canonicalize().unwrap();

        let zip_bytes = build_zip_with_entry("../evil.txt", b"pwned");
        let archive_path = tmp.path().join("evil.zip");
        std::fs::write(&archive_path, &zip_bytes).unwrap();

        let result = unpack_zip_safe(
            archive_path.to_str().unwrap(),
            &dest,
            None,
            None,
            0,
            &Mutex::new(Instant::now()),
        );
        assert!(result.is_err(), "zip slip entry must be rejected");
        assert!(!tmp.path().join("evil.txt").exists());
    }

    #[test]
    fn zip_absolute_path_is_blocked() {
        let tmp = TempDir::new("zip-abs");
        let dest = tmp.path().join("dest");
        std::fs::create_dir_all(&dest).unwrap();
        let dest = dest.canonicalize().unwrap();

        let zip_bytes = build_zip_with_entry("/etc/evil.txt", b"pwned");
        let archive_path = tmp.path().join("evil.zip");
        std::fs::write(&archive_path, &zip_bytes).unwrap();

        let result = unpack_zip_safe(
            archive_path.to_str().unwrap(),
            &dest,
            None,
            None,
            0,
            &Mutex::new(Instant::now()),
        );
        assert!(result.is_err(), "absolute path entry must be rejected");
        assert!(!Path::new("/etc/evil.txt").exists());
    }

    #[test]
    fn zip_benign_nested_entry_extracts_fine() {
        let tmp = TempDir::new("zip-ok");
        let dest = tmp.path().join("dest");
        std::fs::create_dir_all(&dest).unwrap();
        let dest = dest.canonicalize().unwrap();

        let zip_bytes = build_zip_with_entry("sub/dir/file.txt", b"hello world");
        let archive_path = tmp.path().join("ok.zip");
        std::fs::write(&archive_path, &zip_bytes).unwrap();

        unpack_zip_safe(
            archive_path.to_str().unwrap(),
            &dest,
            None,
            None,
            0,
            &Mutex::new(Instant::now()),
        )
        .unwrap();
        let extracted = dest.join("sub/dir/file.txt");
        assert_eq!(std::fs::read(&extracted).unwrap(), b"hello world");
    }

    #[test]
    fn tar_slip_parent_traversal_is_blocked() {
        let tmp = TempDir::new("tar-slip");
        let dest = tmp.path().join("dest");
        std::fs::create_dir_all(&dest).unwrap();
        let dest = dest.canonicalize().unwrap();

        let tar_bytes = build_tar_with_raw_path("../evil.txt", b"pwned");
        let mut archive = tar::Archive::new(Cursor::new(tar_bytes));
        let result = unpack_tar_entries(
            &mut archive,
            &dest,
            None,
            None,
            0,
            0,
            &Mutex::new(Instant::now()),
        );
        assert!(result.is_err(), "tar slip entry must be rejected");
        assert!(!tmp.path().join("evil.txt").exists());
    }

    #[test]
    fn tar_absolute_path_is_blocked() {
        let tmp = TempDir::new("tar-abs");
        let dest = tmp.path().join("dest");
        std::fs::create_dir_all(&dest).unwrap();
        let dest = dest.canonicalize().unwrap();

        let tar_bytes = build_tar_with_raw_path("/etc/evil.txt", b"pwned");
        let mut archive = tar::Archive::new(Cursor::new(tar_bytes));
        let result = unpack_tar_entries(
            &mut archive,
            &dest,
            None,
            None,
            0,
            0,
            &Mutex::new(Instant::now()),
        );
        assert!(result.is_err(), "absolute path entry must be rejected");
    }

    #[test]
    fn tar_symlink_escape_is_blocked() {
        let tmp = TempDir::new("tar-symlink");
        let dest = tmp.path().join("dest");
        std::fs::create_dir_all(&dest).unwrap();
        let dest = dest.canonicalize().unwrap();

        let tar_bytes = build_tar_symlink("evil-link", "/etc");
        let mut archive = tar::Archive::new(Cursor::new(tar_bytes));
        let result = unpack_tar_entries(
            &mut archive,
            &dest,
            None,
            None,
            0,
            0,
            &Mutex::new(Instant::now()),
        );
        assert!(result.is_err(), "symlink entries must be rejected");
        assert!(!dest.join("evil-link").exists());
    }

    #[test]
    fn tar_benign_nested_entry_extracts_fine() {
        let tmp = TempDir::new("tar-ok");
        let dest = tmp.path().join("dest");
        std::fs::create_dir_all(&dest).unwrap();
        let dest = dest.canonicalize().unwrap();

        let tar_bytes = build_tar_with_raw_path("sub/dir/file.txt", b"hello world");
        let mut archive = tar::Archive::new(Cursor::new(tar_bytes));
        unpack_tar_entries(
            &mut archive,
            &dest,
            None,
            None,
            0,
            0,
            &Mutex::new(Instant::now()),
        )
        .unwrap();
        let extracted = dest.join("sub/dir/file.txt");
        assert_eq!(std::fs::read(&extracted).unwrap(), b"hello world");
    }

    #[test]
    fn read_archive_and_unpack_tar_zst_works() {
        let tmp = TempDir::new("tar-zst-read");
        let tar_bytes = build_tar_with_raw_path("test/file.txt", b"zstd test content");

        // Compress tar_bytes with zstd
        let mut zst_bytes = Vec::new();
        {
            let mut encoder = zstd::stream::write::Encoder::new(&mut zst_bytes, 1).unwrap();
            encoder.write_all(&tar_bytes).unwrap();
            encoder.finish().unwrap();
        }

        let zst_path = tmp.path().join("test.tar.zst");
        std::fs::write(&zst_path, &zst_bytes).unwrap();

        // 1. Verify read_archive lists the entry
        let entries = read_archive(zst_path.to_str().unwrap()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "test/file.txt");

        // 2. Verify unpack_archive extracts the entry
        let dest = tmp.path().join("unpacked");
        let report = unpack_archive(
            zst_path.to_str().unwrap(),
            dest.to_str().unwrap(),
            None,
            ExtractConflict::Skip,
            None,
        )
        .unwrap();
        assert_eq!(
            std::fs::read(dest.join("test/file.txt")).unwrap(),
            b"zstd test content"
        );
        assert_eq!(report.promoted, 1);
        assert!(!report.had_conflicts());
    }

    #[test]
    fn read_archive_corrupt_tar_zst_returns_error() {
        let tmp = TempDir::new("tar-zst-corrupt");
        let corrupt_path = tmp.path().join("corrupt.tar.zst");
        // Write invalid data
        std::fs::write(&corrupt_path, b"not a valid zstd tar archive data").unwrap();

        let result = read_archive(corrupt_path.to_str().unwrap());
        assert!(
            result.is_err(),
            "corrupt archive read must return an Error, not an empty list"
        );
        let err_msg = result.unwrap_err();
        assert!(
            err_msg.contains("Failed"),
            "Error message should describe failure: {}",
            err_msg
        );
    }

    // ---- P2.3: promotion may not destroy what is already in the destination ----
    //
    // The staging protocol above keeps a *failed* extraction from touching the
    // destination. These cover the other half: a fully successful extraction
    // whose entry names happen to collide with files the user already had.

    fn build_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut buf);
            let options =
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
            for (name, contents) in entries {
                writer.start_file(*name, options).unwrap();
                writer.write_all(contents).unwrap();
            }
            writer.finish().unwrap();
        }
        buf.into_inner()
    }

    /// Write `entries` to `<tmp>/archive.zip` and return a prepared destination.
    fn staged_archive(tmp: &TempDir, entries: &[(&str, &[u8])]) -> (std::path::PathBuf, String) {
        let archive_path = tmp.path().join("archive.zip");
        std::fs::write(&archive_path, build_zip(entries)).unwrap();
        let dest = tmp.path().join("dest");
        std::fs::create_dir_all(&dest).unwrap();
        (dest, archive_path.to_string_lossy().to_string())
    }

    #[test]
    fn extraction_leaves_an_existing_file_untouched_by_default() {
        let tmp = TempDir::new("promote-skip");
        let (dest, archive) = staged_archive(&tmp, &[("notes.txt", b"from the archive")]);
        std::fs::write(dest.join("notes.txt"), b"mine").unwrap();

        let report = unpack_archive(
            &archive,
            dest.to_str().unwrap(),
            None,
            ExtractConflict::Skip,
            None,
        )
        .unwrap();

        assert_eq!(
            std::fs::read(dest.join("notes.txt")).unwrap(),
            b"mine",
            "the default policy must not replace a file the user already had"
        );
        assert_eq!(report.skipped_count, 1);
        assert_eq!(report.skipped_sample, vec!["notes.txt".to_string()]);
        assert_eq!(report.promoted, 0);
        assert!(report.had_conflicts());
    }

    #[test]
    fn extraction_replace_policy_publishes_over_the_existing_file() {
        let tmp = TempDir::new("promote-replace");
        let (dest, archive) = staged_archive(&tmp, &[("notes.txt", b"from the archive")]);
        std::fs::write(dest.join("notes.txt"), b"mine").unwrap();

        let report = unpack_archive(
            &archive,
            dest.to_str().unwrap(),
            None,
            ExtractConflict::Replace,
            None,
        )
        .unwrap();

        assert_eq!(
            std::fs::read(dest.join("notes.txt")).unwrap(),
            b"from the archive"
        );
        assert_eq!(report.replaced, 1);
        assert_eq!(report.skipped_count, 0);
    }

    #[test]
    fn extraction_keep_both_publishes_beside_the_existing_file() {
        let tmp = TempDir::new("promote-keep-both");
        let (dest, archive) = staged_archive(&tmp, &[("notes.txt", b"from the archive")]);
        std::fs::write(dest.join("notes.txt"), b"mine").unwrap();

        let report = unpack_archive(
            &archive,
            dest.to_str().unwrap(),
            None,
            ExtractConflict::KeepBoth,
            None,
        )
        .unwrap();

        assert_eq!(std::fs::read(dest.join("notes.txt")).unwrap(), b"mine");
        assert_eq!(
            std::fs::read(dest.join("notes (2).txt")).unwrap(),
            b"from the archive"
        );
        assert_eq!(report.kept_both_count, 1);
        assert_eq!(report.kept_both_sample, vec!["notes (2).txt".to_string()]);
    }

    #[cfg(unix)]
    #[test]
    fn extraction_does_not_write_through_a_symlink_at_the_destination() {
        let tmp = TempDir::new("promote-symlink");
        let (dest, archive) = staged_archive(&tmp, &[("notes.txt", b"from the archive")]);

        // The destination name is a link pointing outside the extraction root —
        // the shape an archive uses to reach a file the user never selected.
        let outside = tmp.path().join("outside.txt");
        std::fs::write(&outside, b"untouched").unwrap();
        std::os::unix::fs::symlink(&outside, dest.join("notes.txt")).unwrap();

        let report = unpack_archive(
            &archive,
            dest.to_str().unwrap(),
            None,
            ExtractConflict::Skip,
            None,
        )
        .unwrap();

        assert_eq!(
            std::fs::read(&outside).unwrap(),
            b"untouched",
            "a link at the destination name must count as an existing entry, not \
             as a hole to write through"
        );
        assert_eq!(report.skipped_count, 1);

        // And under Replace the link itself is what gets replaced.
        let report = unpack_archive(
            &archive,
            dest.to_str().unwrap(),
            None,
            ExtractConflict::Replace,
            None,
        )
        .unwrap();
        assert_eq!(std::fs::read(&outside).unwrap(), b"untouched");
        assert!(!dest
            .join("notes.txt")
            .symlink_metadata()
            .unwrap()
            .is_symlink());
        assert_eq!(
            std::fs::read(dest.join("notes.txt")).unwrap(),
            b"from the archive"
        );
        assert_eq!(report.replaced, 1);
    }

    #[test]
    fn extraction_skips_a_directory_whose_name_is_taken_by_a_file() {
        let tmp = TempDir::new("promote-dir-blocked");
        let (dest, archive) = staged_archive(&tmp, &[("data/inner.txt", b"from the archive")]);
        // A regular file occupies the name the archive wants for a directory.
        std::fs::write(dest.join("data"), b"mine").unwrap();

        let report = unpack_archive(
            &archive,
            dest.to_str().unwrap(),
            None,
            ExtractConflict::Skip,
            None,
        )
        .unwrap();

        assert_eq!(std::fs::read(dest.join("data")).unwrap(), b"mine");
        assert_eq!(
            report.skipped_count, 1,
            "the subtree is skipped as one item"
        );
        assert_eq!(report.promoted, 0);
    }

    #[test]
    fn extraction_report_counts_exactly_and_samples_are_bounded() {
        let tmp = TempDir::new("promote-bounded");
        let names: Vec<String> = (0..MAX_REPORTED_CONFLICTS + 5)
            .map(|i| format!("f{}.txt", i))
            .collect();
        let entries: Vec<(&str, &[u8])> = names
            .iter()
            .map(|n| (n.as_str(), b"from the archive" as &[u8]))
            .collect();
        let (dest, archive) = staged_archive(&tmp, &entries);
        for name in &names {
            std::fs::write(dest.join(name), b"mine").unwrap();
        }

        let report = unpack_archive(
            &archive,
            dest.to_str().unwrap(),
            None,
            ExtractConflict::Skip,
            None,
        )
        .unwrap();

        assert_eq!(report.skipped_count as usize, names.len(), "count is exact");
        assert_eq!(
            report.skipped_sample.len(),
            MAX_REPORTED_CONFLICTS,
            "the sample handed to the webview stays capped"
        );
    }

    #[test]
    fn test_archive_valid_and_corrupt_zip() {
        let tmp = TempDir::new("test-archive-zip");
        let valid_bytes = build_zip(&[("file.txt", b"hello valid zip")]);
        let good_path = tmp.path().join("good.zip");
        std::fs::write(&good_path, &valid_bytes).unwrap();

        assert_eq!(test_archive(good_path.to_str().unwrap()), Ok(true));

        let bad_path = tmp.path().join("bad.zip");
        std::fs::write(&bad_path, b"not a zip file at all").unwrap();
        assert_eq!(test_archive(bad_path.to_str().unwrap()), Ok(false));
    }

    #[test]
    fn test_archive_valid_and_corrupt_tar_gz() {
        let tmp = TempDir::new("test-archive-tar-gz");
        let tar_path = tmp.path().join("good.tar.gz");
        {
            let file = File::create(&tar_path).unwrap();
            let gz = flate2::write::GzEncoder::new(file, flate2::Compression::default());
            let mut tar = tar::Builder::new(gz);
            let mut header = tar::Header::new_gnu();
            let data = b"tar content inside gzip";
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            tar.append_data(&mut header, "file.txt", &data[..]).unwrap();
            tar.finish().unwrap();
        }

        assert_eq!(test_archive(tar_path.to_str().unwrap()), Ok(true));

        let bad_path = tmp.path().join("bad.tar.gz");
        std::fs::write(&bad_path, b"random corrupted tar gz bytes").unwrap();
        assert_eq!(test_archive(bad_path.to_str().unwrap()), Ok(false));
    }

    #[test]
    fn test_archive_nonexistent_returns_err() {
        let res = test_archive("/nonexistent/path/archive.zip");
        assert!(res.is_err());
    }

    #[test]
    fn test_split_and_combine_roundtrip() {
        let tmp = TempDir::new("split-combine-roundtrip");
        let src_file = tmp.path().join("original.dat");
        let data: Vec<u8> = (0..5000).map(|i| (i % 256) as u8).collect();
        std::fs::write(&src_file, &data).unwrap();

        let split_dir = tmp.path().join("splits");
        let split_res = split_file(
            src_file.to_str().unwrap(),
            1024,
            split_dir.to_str().unwrap(),
        )
        .unwrap();
        assert!(split_res.success);

        let part1 = split_dir.join("original.dat.001");
        let part2 = split_dir.join("original.dat.002");
        let part3 = split_dir.join("original.dat.003");
        let part4 = split_dir.join("original.dat.004");
        let part5 = split_dir.join("original.dat.005");

        assert!(part1.exists(), "part 001 exists");
        assert!(part5.exists(), "part 005 exists");
        assert_eq!(std::fs::metadata(&part1).unwrap().len(), 1024);
        assert_eq!(std::fs::metadata(&part5).unwrap().len(), 5000 - 4 * 1024);

        let combined_file = tmp.path().join("combined.dat");
        let sources = vec![
            part1.to_str().unwrap().to_string(),
            part2.to_str().unwrap().to_string(),
            part3.to_str().unwrap().to_string(),
            part4.to_str().unwrap().to_string(),
            part5.to_str().unwrap().to_string(),
        ];

        let combine_res = combine_files(&sources, combined_file.to_str().unwrap()).unwrap();
        assert!(combine_res.success);

        let combined_data = std::fs::read(&combined_file).unwrap();
        assert_eq!(
            data, combined_data,
            "Combined data matches original byte-for-byte"
        );
    }

    /// QSF-001/QSF-026: the result must carry the commit engine's durability
    /// claim, never a bare "OK" that implies the bytes reached the platter.
    #[test]
    fn split_and_combine_results_report_the_durability_claim() {
        let tmp = TempDir::new("split-combine-durability");
        let src_file = tmp.path().join("payload.bin");
        std::fs::write(&src_file, vec![7u8; 2048]).unwrap();

        let split_dir = tmp.path().join("parts");
        let split_res = split_file(
            src_file.to_str().unwrap(),
            1024,
            split_dir.to_str().unwrap(),
        )
        .unwrap();
        assert!(split_res.success);
        assert!(
            split_res.message.contains("2 part(s)") && split_res.message.contains("2048 bytes"),
            "split message states parts and bytes: {}",
            split_res.message
        );
        assert!(
            split_res.message.contains("written"),
            "split message carries a durability claim: {}",
            split_res.message
        );
        assert_ne!(split_res.message, "OK");

        let sources = vec![
            split_dir
                .join("payload.bin.001")
                .to_str()
                .unwrap()
                .to_string(),
            split_dir
                .join("payload.bin.002")
                .to_str()
                .unwrap()
                .to_string(),
        ];
        let dest = tmp.path().join("rejoined.bin");
        let combine_res = combine_files(&sources, dest.to_str().unwrap()).unwrap();
        assert!(combine_res.success);
        assert!(
            combine_res.message.contains("2 part(s)") && combine_res.message.contains("2048 bytes"),
            "combine message states parts and bytes: {}",
            combine_res.message
        );
        assert!(
            combine_res.message.contains("written"),
            "combine message carries a durability claim: {}",
            combine_res.message
        );
        assert_ne!(combine_res.message, "OK");
    }

    #[test]
    fn test_split_invalid_chunk_size() {
        let tmp = TempDir::new("split-invalid-chunk");
        let src = tmp.path().join("test.txt");
        std::fs::write(&src, b"abc").unwrap();

        let res = split_file(src.to_str().unwrap(), 0, tmp.path().to_str().unwrap()).unwrap();
        assert!(!res.success);
    }

    #[test]
    fn test_combine_empty_sources() {
        let tmp = TempDir::new("combine-empty");
        let dest = tmp.path().join("out.txt");
        let res = combine_files(&[], dest.to_str().unwrap()).unwrap();
        assert!(!res.success);
    }
}

#[cfg(all(test, unix))]
mod pack_tests {
    use super::*;
    use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nc-pack-test-{}-{}-{}",
            name,
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const LONG: &str = "a-directory-name-that-is-long-enough/to-push-the-whole-entry-path/well-past-the-hundred-byte-header-field.txt";

    /// A tree with a script (0750), a symlink and a path over 100 bytes.
    fn fixture(root: &Path) -> std::path::PathBuf {
        let src = root.join("tree");
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::write(src.join("sub/run.sh"), b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(
            src.join("sub/run.sh"),
            std::fs::Permissions::from_mode(0o750),
        )
        .unwrap();
        std::fs::write(src.join("plain.txt"), b"plain").unwrap();
        symlink("plain.txt", src.join("link")).unwrap();
        let long = src.join(LONG);
        std::fs::create_dir_all(long.parent().unwrap()).unwrap();
        std::fs::write(&long, b"long").unwrap();
        src
    }

    fn pack(src: &Path, dest: &Path, format: &str, follow_links: bool) -> Result<(), String> {
        let sources = vec![src.to_string_lossy().to_string()];
        let (files, bytes) = count_pack_items(&sources);
        pack_archive(
            &sources,
            dest.to_str().unwrap(),
            format,
            6,
            follow_links,
            None,
            0,
            files,
            bytes,
            Arc::new(AtomicBool::new(false)),
        )
    }

    /// name, entry type, mode, mtime, content, link target
    type TarEntry = (String, tar::EntryType, u32, u64, Vec<u8>, Option<String>);

    fn tar_entries(path: &Path, format: &str) -> Vec<TarEntry> {
        let file = File::open(path).unwrap();
        let reader: Box<dyn Read> = match format {
            "tar.gz" => Box::new(flate2::read::GzDecoder::new(file)),
            "tar.bz2" => Box::new(bzip2::read::BzDecoder::new(file)),
            "tar.xz" => Box::new(xz2::read::XzDecoder::new(file)),
            "tar.zst" => Box::new(zstd::stream::read::Decoder::new(file).unwrap()),
            _ => unreachable!(),
        };
        let mut archive = tar::Archive::new(reader);
        archive
            .entries()
            .unwrap()
            .map(|e| {
                let mut e = e.unwrap();
                let name = e
                    .path()
                    .unwrap()
                    .to_string_lossy()
                    .trim_end_matches('/')
                    .to_string();
                let kind = e.header().entry_type();
                let mode = e.header().mode().unwrap();
                let mtime = e.header().mtime().unwrap();
                let link = e
                    .link_name()
                    .unwrap()
                    .map(|l| l.to_string_lossy().to_string());
                let mut data = Vec::new();
                e.read_to_end(&mut data).unwrap();
                (name, kind, mode, mtime, data, link)
            })
            .collect()
    }

    #[test]
    fn every_tar_format_round_trips_links_modes_times_and_long_names() {
        for format in ["tar.gz", "tar.bz2", "tar.xz", "tar.zst"] {
            let root = scratch(&format.replace('.', "_"));
            let src = fixture(&root);
            let dest = root.join(format!("out.{format}"));
            pack(&src, &dest, format, false).unwrap_or_else(|e| panic!("{format}: {e}"));

            // A truncated stream (an unfinished zstd frame) fails right here.
            let entries = tar_entries(&dest, format);
            let find = |n: &str| {
                entries.iter().find(|e| e.0 == n).unwrap_or_else(|| {
                    panic!(
                        "{format}: no {n} in {:?}",
                        entries.iter().map(|e| &e.0).collect::<Vec<_>>()
                    )
                })
            };

            assert_eq!(find("tree/plain.txt").4, b"plain", "{format}");
            let link = find("tree/link");
            assert_eq!(
                link.1,
                tar::EntryType::Symlink,
                "{format}: a link stays a link"
            );
            assert_eq!(link.5.as_deref(), Some("plain.txt"), "{format}");
            assert_eq!(
                find("tree/sub/run.sh").2 & 0o777,
                0o750,
                "{format}: mode is kept"
            );
            let expected_mtime = std::fs::metadata(src.join("plain.txt")).unwrap().mtime() as u64;
            assert_eq!(
                find("tree/plain.txt").3,
                expected_mtime,
                "{format}: mtime is kept"
            );
            assert_eq!(
                find(&format!("tree/{LONG}")).4,
                b"long",
                "{format}: long names work"
            );

            let _ = std::fs::remove_dir_all(&root);
        }
    }

    #[test]
    fn follow_links_stores_what_a_link_points_at() {
        let root = scratch("follow");
        let src = fixture(&root);
        let dest = root.join("out.tar.gz");
        pack(&src, &dest, "tar.gz", true).unwrap();
        let entries = tar_entries(&dest, "tar.gz");
        let link = entries.iter().find(|e| e.0 == "tree/link").unwrap();
        assert_eq!(link.1, tar::EntryType::Regular);
        assert_eq!(link.4, b"plain");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn zip_round_trips_links_and_modes() {
        let root = scratch("zip");
        let src = fixture(&root);
        let dest = root.join("out.zip");
        pack(&src, &dest, "zip", false).unwrap();

        let mut zip = zip::ZipArchive::new(File::open(&dest).unwrap()).unwrap();
        {
            let mut plain = zip.by_name("tree/plain.txt").unwrap();
            let mut data = Vec::new();
            plain.read_to_end(&mut data).unwrap();
            assert_eq!(data, b"plain");
        }
        assert!(
            zip.by_name("tree/link").unwrap().is_symlink(),
            "a link stays a link"
        );
        assert_eq!(
            zip.by_name("tree/sub/run.sh").unwrap().unix_mode().unwrap() & 0o777,
            0o750
        );
        assert!(zip.by_name(&format!("tree/{LONG}")).is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Cancellation used to surface as `ErrorKind::Interrupted`, which
    /// `write_all` and `io::copy` retry — so this call never returned.
    #[test]
    fn a_cancelled_write_fails_instead_of_retrying_forever() {
        let mut writer = CancelableWriter {
            inner: Vec::new(),
            cancel_flag: Arc::new(AtomicBool::new(true)),
        };
        let err = writer.write_all(b"data").unwrap_err();
        assert_ne!(err.kind(), std::io::ErrorKind::Interrupted);
    }

    #[test]
    fn a_cancelled_pack_leaves_nothing_behind() {
        let root = scratch("cancel");
        let src = fixture(&root);
        let dest = root.join("out.tar.zst");
        let sources = vec![src.to_string_lossy().to_string()];
        let result = pack_archive(
            &sources,
            dest.to_str().unwrap(),
            "tar.zst",
            3,
            false,
            None,
            0,
            0,
            0,
            Arc::new(AtomicBool::new(true)),
        );
        assert_eq!(result.unwrap_err(), "Cancelled");
        assert!(!dest.exists());
        let leftovers: Vec<_> = std::fs::read_dir(&root)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name() != "tree")
            .collect();
        assert!(leftovers.is_empty(), "staging left behind: {leftovers:?}");
        let _ = std::fs::remove_dir_all(&root);
    }
}
