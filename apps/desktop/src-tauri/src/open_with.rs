use serde::Serialize;
use std::process::Command;

#[derive(Serialize, Clone)]
pub struct AppInfo {
    pub name: String,
    pub desktop_entry: String,
    pub icon: Option<String>,
    pub is_default: bool,
}

#[derive(Clone)]
struct DesktopEntry {
    file_name: String,
    name: String,
    icon: Option<String>,
    mime_types: Vec<String>,
    no_display: bool,
    /// Binary the entry claims to run, taken from `TryExec` or the first token
    /// of `Exec`. `None` when neither field is usable.
    exec_binary: Option<String>,
    /// `Terminal=true`: the app expects to be run inside a terminal emulator.
    needs_terminal: bool,
}

fn desktop_app_dirs() -> Vec<std::path::PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".local/share/applications"));
        dirs.push(home.join(".local/share/flatpak/exports/share/applications"));
    }
    dirs.push(std::path::PathBuf::from("/usr/local/share/applications"));
    dirs.push(std::path::PathBuf::from("/usr/share/applications"));
    dirs.push(std::path::PathBuf::from(
        "/var/lib/flatpak/exports/share/applications",
    ));
    dirs.push(std::path::PathBuf::from(
        "/var/lib/snapd/desktop/applications",
    ));

    if let Ok(xdg_data_dirs) = std::env::var("XDG_DATA_DIRS") {
        for part in xdg_data_dirs.split(':') {
            let trimmed = part.trim();
            if trimmed.is_empty() {
                continue;
            }
            let p = std::path::PathBuf::from(trimmed);
            let app_dir = if p.ends_with("applications") {
                p
            } else {
                p.join("applications")
            };
            if !dirs.contains(&app_dir) {
                dirs.push(app_dir);
            }
        }
    }
    dirs.retain(|d| d.is_dir());
    dirs
}

fn resolve_icon_path(icon: &str) -> Option<String> {
    if icon.is_empty() {
        return None;
    }
    let p = std::path::Path::new(icon);
    if p.is_absolute() && p.is_file() {
        return Some(icon.to_string());
    }

    let mut candidate_dirs = vec![
        std::path::PathBuf::from("/usr/share/pixmaps"),
        std::path::PathBuf::from("/usr/share/icons/hicolor/scalable/apps"),
        std::path::PathBuf::from("/usr/share/icons/hicolor/48x48/apps"),
        std::path::PathBuf::from("/usr/share/icons/hicolor/64x64/apps"),
        std::path::PathBuf::from("/usr/share/icons/hicolor/128x128/apps"),
        std::path::PathBuf::from("/usr/share/icons/hicolor/256x256/apps"),
        std::path::PathBuf::from("/usr/share/icons/hicolor/512x512/apps"),
    ];
    if let Some(home) = dirs::home_dir() {
        candidate_dirs.push(home.join(".local/share/icons/hicolor/scalable/apps"));
        candidate_dirs.push(home.join(".local/share/icons/hicolor/48x48/apps"));
    }

    let extensions = ["png", "svg", "xpm"];
    for dir in candidate_dirs {
        for ext in &extensions {
            let file = dir.join(format!("{}.{}", icon, ext));
            if file.is_file() {
                return Some(file.to_string_lossy().to_string());
            }
        }
        let direct = dir.join(icon);
        if direct.is_file() {
            return Some(direct.to_string_lossy().to_string());
        }
    }
    // Nothing resolved: the return type promises a path, so a bare theme icon
    // name is not a valid answer. The frontend decides what to render instead.
    None
}

fn get_field(section: &str, key: &str) -> Option<String> {
    for line in section.lines() {
        if let Some(rest) = line.strip_prefix(key) {
            if let Some(value) = rest.strip_prefix('=') {
                return Some(value.trim().to_string());
            }
        }
    }
    None
}

/// First token of an `Exec=` line, with the freedesktop quoting stripped.
/// `Exec=/usr/bin/gvim -f %F` -> `/usr/bin/gvim`, `Exec="my app" %f` -> `my app`.
fn exec_binary_from_exec_line(exec: &str) -> Option<String> {
    let exec = exec.trim();
    let first = if let Some(rest) = exec.strip_prefix('"') {
        rest.split('"').next().unwrap_or_default()
    } else {
        exec.split_whitespace().next().unwrap_or_default()
    };
    if first.is_empty() {
        None
    } else {
        Some(first.to_string())
    }
}

/// Whether `binary` can actually be executed: an absolute/relative path is
/// checked directly, a bare name is looked up on `PATH`.
fn binary_exists(binary: &str) -> bool {
    if binary.is_empty() {
        return false;
    }
    if binary.contains('/') {
        return std::path::Path::new(binary).is_file();
    }
    let path = match std::env::var_os("PATH") {
        Some(p) => p,
        None => return false,
    };
    std::env::split_paths(&path).any(|dir| dir.join(binary).is_file())
}

fn parse_desktop_entry(file_name: &str, content: &str) -> Option<DesktopEntry> {
    // Ignore any [Desktop Action ...] sub-sections, only read the main [Desktop Entry] block.
    let section = content.split("[Desktop Action ").next().unwrap_or(content);
    let name = get_field(section, "Name")?;
    let icon = get_field(section, "Icon");
    let mime_types = get_field(section, "MimeType")
        .unwrap_or_default()
        .split(';')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();
    let no_display = get_field(section, "NoDisplay").as_deref() == Some("true")
        || get_field(section, "Hidden").as_deref() == Some("true");
    // TryExec is the spec's own "is this actually installed?" marker; fall back
    // to the Exec binary for entries that omit it.
    let exec_binary = get_field(section, "TryExec")
        .or_else(|| get_field(section, "Exec").and_then(|e| exec_binary_from_exec_line(&e)));
    let needs_terminal = get_field(section, "Terminal").as_deref() == Some("true");

    Some(DesktopEntry {
        file_name: file_name.to_string(),
        name,
        icon,
        mime_types,
        no_display,
        exec_binary,
        needs_terminal,
    })
}

/// An entry is only offered when it is genuinely launchable: its binary is
/// present, and it is not a terminal app (`gtk-launch` gives it no terminal,
/// so it would just fail silently). Distro packages such as `vim-common` ship
/// `vim.desktop` even when the binary itself was never installed.
fn is_launchable(entry: &DesktopEntry) -> bool {
    if entry.needs_terminal {
        return false;
    }
    match &entry.exec_binary {
        Some(binary) => binary_exists(binary),
        None => false,
    }
}

fn list_desktop_apps() -> Vec<DesktopEntry> {
    let mut results = Vec::new();
    for dir in desktop_app_dirs() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("desktop") {
                continue;
            }
            let file_name = match path.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if let Ok(content) = std::fs::read_to_string(&path) {
                if let Some(parsed) = parse_desktop_entry(&file_name, &content) {
                    if !parsed.no_display && is_launchable(&parsed) {
                        results.push(parsed);
                    }
                }
            }
        }
    }
    results
}

/// Only accept `desktop_entry` values that name a `.desktop` file actually
/// installed in one of the standard application directories, the same set
/// `get_open_with_apps` draws from. This is called from IPC-reachable
/// commands, so it must not trust an arbitrary frontend-supplied string
/// enough to hand it to `gtk-launch`/`xdg-mime` as-is.
fn is_known_desktop_entry(file_name: &str) -> bool {
    if file_name.is_empty()
        || file_name.contains('/')
        || file_name.contains('\\')
        || file_name.contains("..")
    {
        return false;
    }
    desktop_app_dirs()
        .iter()
        .any(|dir| dir.join(file_name).is_file())
}

fn query_mimetype(path: &str) -> Result<String, String> {
    let output = Command::new("xdg-mime")
        .args(["query", "filetype", path])
        .output()
        .map_err(|e| format!("Failed to run xdg-mime: {}", e))?;
    if !output.status.success() {
        return Err("xdg-mime could not determine the file type".to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn query_gio_mime_apps(mimetype: &str) -> (Option<String>, Vec<String>) {
    let output = match Command::new("gio").args(["mime", mimetype]).output() {
        Ok(o) if o.status.success() => o,
        _ => return (None, Vec::new()),
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut default_app = None;
    let mut apps = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("Default application for ") {
            if let Some(idx) = trimmed.find(':') {
                let candidate = trimmed[idx + 1..].trim();
                if candidate.ends_with(".desktop") {
                    default_app = Some(candidate.to_string());
                }
            }
        } else if trimmed.ends_with(".desktop") {
            let entry_name = trimmed.trim_start_matches(|c: char| !c.is_alphanumeric() && c != '_');
            if entry_name.ends_with(".desktop") && !apps.contains(&entry_name.to_string()) {
                apps.push(entry_name.to_string());
            }
        }
    }
    (default_app, apps)
}

/// List installed applications that can open the given file, and which one is currently default.
#[tauri::command]
pub fn get_open_with_apps(path: String) -> Result<Vec<AppInfo>, String> {
    if !cfg!(target_os = "linux") {
        return Ok(Vec::new());
    }

    let mimetype = query_mimetype(&path)?;

    let (gio_default, gio_apps) = query_gio_mime_apps(&mimetype);

    let default_entry = gio_default
        .or_else(|| {
            Command::new("xdg-mime")
                .args(["query", "default", &mimetype])
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_default();

    let all_desktop_apps = list_desktop_apps();

    let is_text_like = mimetype.starts_with("text/")
        || matches!(
            mimetype.as_str(),
            "application/json"
                | "application/javascript"
                | "application/xml"
                | "application/x-sh"
                | "application/x-yaml"
                | "application/toml"
                | "application/x-desktop"
        );

    let mut matched_entries = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();

    // 1. Explicitly registered/recommended via gio or xdg default
    if !default_entry.is_empty() {
        if let Some(entry) = all_desktop_apps
            .iter()
            .find(|a| a.file_name == default_entry)
        {
            seen_ids.insert(entry.file_name.clone());
            matched_entries.push(entry.clone());
        }
    }
    for app_id in &gio_apps {
        if !seen_ids.contains(app_id) {
            if let Some(entry) = all_desktop_apps.iter().find(|a| &a.file_name == app_id) {
                seen_ids.insert(entry.file_name.clone());
                matched_entries.push(entry.clone());
            }
        }
    }

    // 2. Exact mimetype matches from .desktop files
    for app in &all_desktop_apps {
        if !seen_ids.contains(&app.file_name) && app.mime_types.contains(&mimetype) {
            seen_ids.insert(app.file_name.clone());
            matched_entries.push(app.clone());
        }
    }

    // 3. For text-like files, include editors that declare text/plain
    if is_text_like {
        for app in &all_desktop_apps {
            if !seen_ids.contains(&app.file_name)
                && app.mime_types.iter().any(|m| m == "text/plain")
            {
                seen_ids.insert(app.file_name.clone());
                matched_entries.push(app.clone());
            }
        }
    }

    let apps = matched_entries
        .into_iter()
        .map(|a| AppInfo {
            is_default: a.file_name == default_entry,
            name: a.name,
            desktop_entry: a.file_name,
            icon: a.icon.as_deref().and_then(resolve_icon_path),
        })
        .collect();

    Ok(apps)
}

/// Launch `path` with the application identified by `desktop_entry` (e.g. "org.gnome.TextEditor.desktop").
#[tauri::command]
pub fn open_file_with_app(path: String, desktop_entry: String) -> Result<(), String> {
    if !is_known_desktop_entry(&desktop_entry) {
        return Err(format!("Unknown application: {}", desktop_entry));
    }
    let app_id = desktop_entry.trim_end_matches(".desktop");
    crate::terminal::spawn_reaped(Command::new("gtk-launch").arg(app_id).arg(&path))
        .map_err(|e| format!("Could not launch {}: {}", desktop_entry, e))?;
    Ok(())
}

/// Register `desktop_entry` as the default application for the mimetype of `path`.
#[tauri::command]
pub fn set_default_app(path: String, desktop_entry: String) -> Result<(), String> {
    if !is_known_desktop_entry(&desktop_entry) {
        return Err(format!("Unknown application: {}", desktop_entry));
    }
    let mimetype = query_mimetype(&path)?;
    let status = Command::new("xdg-mime")
        .args(["default", &desktop_entry, &mimetype])
        .status()
        .map_err(|e| format!("Failed to run xdg-mime: {}", e))?;
    if !status.success() {
        return Err(format!(
            "xdg-mime failed to set {} as default",
            desktop_entry
        ));
    }
    Ok(())
}

#[cfg(test)]
mod desktop_entry_validation_tests {
    use super::is_known_desktop_entry;

    #[test]
    fn rejects_path_traversal_and_separators() {
        assert!(!is_known_desktop_entry("../../../etc/passwd"));
        assert!(!is_known_desktop_entry("some/dir/app.desktop"));
        assert!(!is_known_desktop_entry("some\\dir\\app.desktop"));
        assert!(!is_known_desktop_entry(""));
    }

    #[test]
    fn rejects_entries_that_are_not_actually_installed() {
        assert!(!is_known_desktop_entry(
            "totally-bogus-app-name-xyz-nc-test.desktop"
        ));
    }
}

#[cfg(test)]
mod launchability_tests {
    use super::{
        binary_exists, exec_binary_from_exec_line, is_launchable, parse_desktop_entry,
        resolve_icon_path,
    };

    fn entry(body: &str) -> super::DesktopEntry {
        parse_desktop_entry(
            "test.desktop",
            &format!("[Desktop Entry]\nName=Test\n{}", body),
        )
        .expect("entry should parse")
    }

    #[test]
    fn extracts_the_binary_from_an_exec_line() {
        assert_eq!(exec_binary_from_exec_line("vim %F").as_deref(), Some("vim"));
        assert_eq!(
            exec_binary_from_exec_line("/usr/bin/gvim -f %F").as_deref(),
            Some("/usr/bin/gvim")
        );
        assert_eq!(
            exec_binary_from_exec_line("\"/opt/my app/bin\" %f").as_deref(),
            Some("/opt/my app/bin")
        );
        assert_eq!(exec_binary_from_exec_line("   "), None);
    }

    #[test]
    fn resolves_binaries_against_path_and_absolute_paths() {
        assert!(binary_exists("sh"));
        assert!(binary_exists("/bin/sh"));
        assert!(!binary_exists("totally-bogus-binary-xyz-nc-test"));
        assert!(!binary_exists("/bin/totally-bogus-binary-xyz-nc-test"));
        assert!(!binary_exists(""));
    }

    #[test]
    fn rejects_entries_whose_binary_is_missing() {
        // The vim-common case: desktop file installed, binary is not.
        assert!(!is_launchable(&entry(
            "TryExec=totally-bogus-binary-xyz-nc-test\nExec=sh %F"
        )));
        assert!(!is_launchable(&entry(
            "Exec=totally-bogus-binary-xyz-nc-test %F"
        )));
        assert!(!is_launchable(&entry("Name=No exec line at all")));
    }

    #[test]
    fn rejects_terminal_apps_even_when_installed() {
        assert!(!is_launchable(&entry("Exec=sh %F\nTerminal=true")));
    }

    #[test]
    fn accepts_installed_graphical_apps() {
        assert!(is_launchable(&entry("Exec=sh %F")));
        assert!(is_launchable(&entry(
            "TryExec=sh\nExec=sh %F\nTerminal=false"
        )));
    }

    #[test]
    fn resolve_icon_path_returns_a_real_path_or_none() {
        // The Option promises a filesystem path. An unresolvable theme icon
        // name must be None rather than the input echoed back, otherwise the
        // frontend has to re-derive "is this actually a path?" from the string.
        assert_eq!(resolve_icon_path("totally-bogus-icon-xyz-nc-test"), None);
        assert_eq!(resolve_icon_path("/nonexistent/xyz-nc-test.png"), None);
        assert_eq!(resolve_icon_path(""), None);

        // An absolute path that does exist comes back unchanged.
        let tmp = std::env::temp_dir().join(format!("nc-icon-test-{}.png", std::process::id()));
        std::fs::write(&tmp, b"").expect("write temp icon");
        let found = resolve_icon_path(&tmp.to_string_lossy());
        std::fs::remove_file(&tmp).ok();
        assert_eq!(found, Some(tmp.to_string_lossy().to_string()));
    }
}
