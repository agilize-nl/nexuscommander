use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bookmark {
    pub name: String,
    pub path: String,
}

fn get_bookmarks_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from(".nexus"))
        .join("bookmarks.json")
}

#[tauri::command]
pub fn get_bookmarks(app: AppHandle) -> Result<Vec<Bookmark>, String> {
    let path = get_bookmarks_path(&app);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content =
        fs::read_to_string(path).map_err(|e| format!("Failed to read bookmarks: {}", e))?;
    let bookmarks: Vec<Bookmark> = serde_json::from_str(&content).unwrap_or_default();
    Ok(bookmarks)
}

#[tauri::command]
pub fn save_bookmarks(app: AppHandle, bookmarks: Vec<Bookmark>) -> Result<(), String> {
    let path = get_bookmarks_path(&app);
    let content = serde_json::to_string_pretty(&bookmarks)
        .map_err(|e| format!("Failed to serialize: {}", e))?;

    // P1.4: staged and committed by rename. `fs::write` truncated the file
    // first, so a crash mid-write left a truncated bookmarks.json, which
    // get_bookmarks then parsed as an empty list and silently discarded every
    // bookmark the user had (QSF-012).
    crate::engine::commit::write_config_atomically(&path, content.as_bytes())
        .map_err(|e| format!("Failed to write bookmarks: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn add_bookmark(app: AppHandle, bookmark: Bookmark) -> Result<(), String> {
    let mut bookmarks = get_bookmarks(app.clone())?;
    bookmarks.push(bookmark);
    save_bookmarks(app, bookmarks)
}

#[tauri::command]
pub fn remove_bookmark(app: AppHandle, path: String) -> Result<(), String> {
    let mut bookmarks = get_bookmarks(app.clone())?;
    bookmarks.retain(|b| b.path != path);
    save_bookmarks(app, bookmarks)
}
