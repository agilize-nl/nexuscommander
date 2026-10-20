use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};
use walkdir::WalkDir;

/// Search jobs are attacker/user-reachable long-running background threads
/// that walk arbitrary (possibly huge or network-mounted) directory trees.
/// These limits bound their CPU/IO/memory footprint and make sure a search
/// can always be stopped instead of running forever in the background.
const MAX_CONCURRENT_SEARCHES: usize = 3;
const MAX_SEARCH_RESULTS: usize = 5000;
const MAX_CONTENT_SEARCH_FILE_BYTES: u64 = 10 * 1024 * 1024;
const SEARCH_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchParams {
    pub query: String,
    pub start_dir: String,
    pub use_regex: bool,
    pub content_query: Option<String>,
}

/// Tracks cancellation flags for in-flight search jobs and enforces a cap on
/// how many searches may run concurrently.
#[derive(Clone)]
pub struct SearchState {
    jobs: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    active_count: Arc<AtomicUsize>,
}

impl SearchState {
    pub fn new() -> Self {
        Self {
            jobs: Arc::new(Mutex::new(HashMap::new())),
            active_count: Arc::new(AtomicUsize::new(0)),
        }
    }
}

impl Default for SearchState {
    fn default() -> Self {
        Self::new()
    }
}

/// Start a search job on a background thread and return its job id. Results
/// and completion are emitted on `search-result:{job_id}` /
/// `search-done:{job_id}` so events from a cancelled/earlier search can't be
/// mistaken for a later one. Cancel with `search_cancel(job_id)`.
#[tauri::command]
pub async fn search_files(
    app: AppHandle,
    state: State<'_, SearchState>,
    params: SearchParams,
) -> Result<String, String> {
    let active = state.active_count.load(Ordering::SeqCst);
    if active >= MAX_CONCURRENT_SEARCHES {
        return Err(format!(
            "Too many searches are already running ({} active, max {}). Cancel one and try again.",
            active, MAX_CONCURRENT_SEARCHES
        ));
    }

    let job_id = uuid::Uuid::new_v4().to_string();
    let cancel_flag = Arc::new(AtomicBool::new(false));
    state
        .jobs
        .lock()
        .unwrap()
        .insert(job_id.clone(), cancel_flag.clone());
    state.active_count.fetch_add(1, Ordering::SeqCst);

    let mut name_regex: Option<Regex> = None;
    if params.use_regex {
        name_regex = Regex::new(&params.query).ok();
    }
    let query_lower = params.query.to_lowercase();
    let content_lower = params.content_query.as_ref().map(|c| c.to_lowercase());

    let jobs_map = state.jobs.clone();
    let active_count = state.active_count.clone();
    let job_id_thread = job_id.clone();
    let result_event = format!("search-result:{}", job_id);
    let done_event = format!("search-done:{}", job_id);

    // Run search on a blocking thread
    std::thread::spawn(move || {
        let started_at = Instant::now();
        let mut emitted = 0usize;

        for entry in WalkDir::new(&params.start_dir)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if cancel_flag.load(Ordering::SeqCst) {
                break;
            }
            if started_at.elapsed() > SEARCH_TIMEOUT {
                break;
            }
            if emitted >= MAX_SEARCH_RESULTS {
                break;
            }

            let path_str = entry.path().to_string_lossy().to_string();
            let file_name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().is_dir();

            let mut matches_name = false;
            if params.use_regex {
                if let Some(re) = &name_regex {
                    matches_name = re.is_match(&file_name);
                }
            } else {
                matches_name = file_name.to_lowercase().contains(&query_lower);
            }

            if !matches_name {
                continue;
            }

            // Check content if needed
            let mut matches_content = true;
            if let Some(cq) = &content_lower {
                if is_dir {
                    matches_content = false;
                } else if let Ok(metadata) = entry.metadata() {
                    if metadata.len() < MAX_CONTENT_SEARCH_FILE_BYTES {
                        if let Ok(content) = fs::read_to_string(entry.path()) {
                            matches_content = content.to_lowercase().contains(cq);
                        } else {
                            matches_content = false;
                        }
                    } else {
                        matches_content = false;
                    }
                }
            }

            if matches_name && matches_content {
                let metadata = entry.metadata().ok();
                let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
                let modified = metadata
                    .as_ref()
                    .and_then(|m| m.modified().ok())
                    .and_then(|sys_time| sys_time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);

                let res = SearchResult {
                    name: file_name,
                    path: path_str,
                    is_dir,
                    size,
                    modified,
                };
                let _ = app.emit(&result_event, Some(res));
                emitted += 1;
            }
        }

        let _ = app.emit(&done_event, ());
        jobs_map.lock().unwrap().remove(&job_id_thread);
        active_count.fetch_sub(1, Ordering::SeqCst);
    });

    Ok(job_id)
}

/// Cancel an in-flight search job. A no-op if the job already finished.
#[tauri::command]
pub fn search_cancel(state: State<'_, SearchState>, job_id: String) {
    if let Some(flag) = state.jobs.lock().unwrap().get(&job_id) {
        flag.store(true, Ordering::SeqCst);
    }
}
