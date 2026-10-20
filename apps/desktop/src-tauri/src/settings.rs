use ini::Ini;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;
use tauri::Manager;

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct FileOpOptions {
    pub when_file_exists: String,
    pub when_dir_exists: String,
    pub when_cannot_set_property: String,
    pub exclude_empty_dirs: bool,
    pub verify: bool,
    pub check_free_space: bool,
    pub reserve_space: bool,
    pub follow_links: bool,
    pub correct_links: bool,
    pub copy_attributes: bool,
    pub drop_readonly: bool,
    pub copy_date_time: bool,
    pub copy_ownership: bool,
    pub copy_on_write: bool,
}

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct TabConfig {
    pub id: String,
    pub path: String,
    pub label: String,
    pub custom_label: Option<String>,
    pub locked: bool,
}

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct ColumnConfig {
    pub caption: String,
    pub width: u32,
    pub align: String,
    pub field_contents: String,
}

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct AppConfig {
    pub language: String,
    pub start_as_root: bool,
    pub layout_show_menu: bool,
    pub audio_player: String,
    pub color_background: String,
    pub color_text: String,
    pub theme: String,
    pub icon_theme: String,
    pub behavior_selection_mode: String,
    pub custom_columns: String,
    pub show_folder_tabs: bool,
    pub show_folders_with_brackets: bool,
    pub show_parent_dir_row: bool,
    pub show_alternating_row_colors: bool,
    pub show_file_sizes_in_bytes: bool,
    pub font_family: String, // Keep legacy field for now
    pub font_main_name: String,
    pub font_main_size: u32,
    pub font_menu_name: String,
    pub font_menu_size: u32,
    pub font_drive_name: String,
    pub font_drive_size: u32,
    pub font_tab_name: String,
    pub font_tab_size: u32,
    pub font_header_name: String,
    pub font_header_size: u32,
    pub font_pane_name: String,
    pub font_pane_size: u32,
    pub font_status_name: String,
    pub font_status_size: u32,
    pub columns: Vec<ColumnConfig>,
    pub column_views: HashMap<String, Vec<ColumnConfig>>,
    pub window_x: Option<i32>,
    pub window_y: Option<i32>,
    pub window_width: Option<u32>,
    pub window_height: Option<u32>,
    pub options_window_width: Option<u32>,
    pub options_window_height: Option<u32>,
    pub left_tabs: Vec<TabConfig>,
    pub right_tabs: Vec<TabConfig>,
    pub left_active_tab: String,
    pub right_active_tab: String,
    pub left_mode: String,
    pub right_mode: String,
    pub left_view_mode: String,
    pub right_view_mode: String,
    pub is_vertical_layout: bool,
    pub is_single_view: bool,
    pub panel_ratio: f64,
    pub file_op_options: FileOpOptions,
}

fn get_config_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from(".nexuscmd"))
        .join("nexuscmd.ini")
}

/// Every theme and icon set the UI can actually render. These double as the
/// allowlist for the two appearance values that cross a privilege boundary in
/// `restart_as_root`, so they must stay in step with `themes` in
/// packages/ui/src/lib/theme.ts and the icon-theme options in
/// packages/ui/src/lib/components/OptionsDialog.svelte.
pub const THEMES: &[&str] = &[
    "midnight",
    "ocean",
    "dracula",
    "solarized-dark",
    "gruvbox",
    "nortonly",
    "github-light",
    "solarized-light",
    "gruvbox-light",
    "catppuccin-latte",
    "arctic-light",
];

pub const ICON_THEMES: &[&str] = &[
    "material",
    "papirus",
    "zorin",
    "lucide",
    "tabler",
    "fluent",
    "material-symbols",
    "phosphor",
    "remix",
];

/// The environment variables an elevated instance inherits its appearance
/// through. `restart_as_root` sets them; nothing else does.
pub const INHERITED_THEME_ENV: &str = "NEXUSCMD_INHERITED_THEME";
pub const INHERITED_ICON_THEME_ENV: &str = "NEXUSCMD_INHERITED_ICON_THEME";

/// The allowlisted spelling of `value`, or `None` when the UI has no such theme.
///
/// Returns the entry from `allowed` rather than the caller's string, so nothing
/// user-derived survives the check: this value is handed to a process that is
/// about to become root, and it is read from a file any unprivileged user can
/// write.
pub fn known_appearance_value(value: &str, allowed: &[&str]) -> Option<String> {
    allowed
        .iter()
        .find(|known| **known == value)
        .map(|known| (*known).to_string())
}

/// Appearance carried over from the session that elevated this process.
///
/// `restart_as_root` re-execs through pkexec, which resets HOME to the target
/// user's home, so the elevated instance reads /root/.config/… — a different
/// config, usually never written. It therefore used to take over the screen in
/// the default dark theme with default icons even though the user was looking
/// at a light one. Only theme and icon set are inherited: tabs, layout, paths
/// and window geometry stay per-account on purpose, because the elevated
/// instance genuinely browses as another user.
#[derive(Default)]
struct InheritedAppearance {
    theme: Option<String>,
    icon_theme: Option<String>,
}

impl InheritedAppearance {
    fn from_env() -> Self {
        Self {
            theme: std::env::var(INHERITED_THEME_ENV)
                .ok()
                .and_then(|value| known_appearance_value(&value, THEMES)),
            icon_theme: std::env::var(INHERITED_ICON_THEME_ENV)
                .ok()
                .and_then(|value| known_appearance_value(&value, ICON_THEMES)),
        }
    }

    /// Outrank whatever is on disk — root's own config is precisely the one the
    /// user is *not* looking at.
    fn apply_to(&self, config: &mut AppConfig) {
        if let Some(theme) = &self.theme {
            config.theme = theme.clone();
        }
        if let Some(icon_theme) = &self.icon_theme {
            config.icon_theme = icon_theme.clone();
        }
    }

    /// Give up a field as soon as this instance saves a different value for it:
    /// the user changed it *here*, so it is theirs from now on. Without this,
    /// picking a theme inside the elevated session would be undone by the next
    /// `load_settings` — the options dialog and every column resize call it.
    fn release_overridden(&mut self, saved: &AppConfig) {
        if self
            .theme
            .as_deref()
            .is_some_and(|theme| theme != saved.theme)
        {
            self.theme = None;
        }
        if self
            .icon_theme
            .as_deref()
            .is_some_and(|icon_theme| icon_theme != saved.icon_theme)
        {
            self.icon_theme = None;
        }
    }
}

fn inherited_appearance() -> &'static Mutex<InheritedAppearance> {
    static INHERITED: OnceLock<Mutex<InheritedAppearance>> = OnceLock::new();
    INHERITED.get_or_init(|| Mutex::new(InheritedAppearance::from_env()))
}

#[tauri::command]
pub fn load_settings(app: AppHandle) -> AppConfig {
    let path = get_config_path(&app);
    let mut config = AppConfig {
        language: "doublecmd.pot".to_string(),
        start_as_root: false,
        layout_show_menu: true,
        audio_player: "builtin".to_string(),
        color_background: "#1e293b".to_string(),
        color_text: "#f8fafc".to_string(),
        theme: "midnight".to_string(),
        icon_theme: "material".to_string(),
        behavior_selection_mode: "NC".to_string(),
        custom_columns: "Default".to_string(),
        show_folder_tabs: true,
        show_folders_with_brackets: true,
        show_parent_dir_row: true,
        show_alternating_row_colors: false,
        show_file_sizes_in_bytes: false,
        font_family: "Roboto, sans-serif".to_string(),
        font_main_name: "Roboto, sans-serif".to_string(),
        font_main_size: 15,
        font_menu_name: "Roboto, sans-serif".to_string(),
        font_menu_size: 15,
        font_drive_name: "Roboto, sans-serif".to_string(),
        font_drive_size: 15,
        font_tab_name: "Roboto, sans-serif".to_string(),
        font_tab_size: 15,
        font_header_name: "Roboto, sans-serif".to_string(),
        font_header_size: 15,
        font_pane_name: "Roboto, sans-serif".to_string(),
        font_pane_size: 15,
        font_status_name: "Roboto, sans-serif".to_string(),
        font_status_size: 15,
        columns: vec![
            ColumnConfig {
                caption: "Name".to_string(),
                width: 665,
                align: "<-".to_string(),
                field_contents: "FileName".to_string(),
            },
            ColumnConfig {
                caption: "Ext".to_string(),
                width: 50,
                align: "<-".to_string(),
                field_contents: "FileExt".to_string(),
            },
            ColumnConfig {
                caption: "Size".to_string(),
                width: 70,
                align: "->".to_string(),
                field_contents: "FileSize".to_string(),
            },
            ColumnConfig {
                caption: "Date".to_string(),
                width: 283,
                align: "->".to_string(),
                field_contents: "FileTime".to_string(),
            },
            ColumnConfig {
                caption: "Attr".to_string(),
                width: 179,
                align: "<-".to_string(),
                field_contents: "FileAttr".to_string(),
            },
        ],
        column_views: HashMap::new(),
        window_x: None,
        window_y: None,
        window_width: None,
        window_height: None,
        options_window_width: None,
        options_window_height: None,
        left_tabs: Vec::new(),
        right_tabs: Vec::new(),
        left_active_tab: String::new(),
        right_active_tab: String::new(),
        left_mode: "list".to_string(),
        right_mode: "list".to_string(),
        left_view_mode: "full".to_string(),
        right_view_mode: "full".to_string(),
        is_vertical_layout: true,
        is_single_view: false,
        panel_ratio: 0.5,
        file_op_options: FileOpOptions {
            when_file_exists: "Ask".to_string(),
            when_dir_exists: "Ask".to_string(),
            when_cannot_set_property: "Ask".to_string(),
            exclude_empty_dirs: true,
            verify: false,
            check_free_space: true,
            reserve_space: true,
            follow_links: false,
            correct_links: false,
            copy_attributes: true,
            drop_readonly: false,
            copy_date_time: true,
            copy_ownership: false,
            copy_on_write: false,
        },
    };

    if let Ok(conf) = Ini::load_from_file(path) {
        if let Some(section) = conf.section(Some("Main")) {
            if let Some(v) = section.get("Language") {
                config.language = v.to_string();
            }
            if let Some(v) = section.get("StartAsRoot") {
                config.start_as_root = v == "true";
            }
            if let Some(v) = section.get("BehaviorSelection") {
                config.behavior_selection_mode = v.to_string();
            }
            if let Some(v) = section.get("AudioPlayer") {
                let val = v.to_string();
                if val == "builtin" || val == "system" {
                    config.audio_player = val;
                }
            }
        }
        if let Some(section) = conf.section(Some("Layout")) {
            if let Some(v) = section.get("ShowMenu") {
                config.layout_show_menu = v == "true";
            }
        }
        if let Some(section) = conf.section(Some("Colors")) {
            if let Some(v) = section.get("Background") {
                config.color_background = v.to_string();
            }
            if let Some(v) = section.get("Text") {
                config.color_text = v.to_string();
            }
            if let Some(v) = section.get("Theme") {
                config.theme = v.to_string();
            }
            if let Some(v) = section.get("IconTheme") {
                config.icon_theme = v.to_string();
            }
        }
        if let Some(section) = conf.section(Some("View")) {
            if let Some(v) = section.get("CustomColumns") {
                config.custom_columns = v.to_string();
            }
            if let Some(v) = section.get("ShowFolderTabs") {
                config.show_folder_tabs = v == "true";
            }
            if let Some(v) = section.get("ShowFoldersWithBrackets") {
                config.show_folders_with_brackets = v == "true";
            }
            if let Some(v) = section.get("ShowParentDirRow") {
                config.show_parent_dir_row = v == "true";
            }
            if let Some(v) = section.get("ShowAlternatingRowColors") {
                config.show_alternating_row_colors = v == "true";
            }
            if let Some(v) = section.get("ShowFileSizesInBytes") {
                config.show_file_sizes_in_bytes = v == "true";
            }
            if let Some(v) = section.get("FontFamily") {
                config.font_family = v.to_string();
            }
            if let Some(v) = section.get("FontMainName") {
                config.font_main_name = v.to_string();
            }
            if let Some(v) = section.get("FontMainSize") {
                if let Ok(n) = v.parse() {
                    config.font_main_size = n;
                }
            }
            if let Some(v) = section.get("FontMenuName") {
                config.font_menu_name = v.to_string();
            }
            if let Some(v) = section.get("FontMenuSize") {
                if let Ok(n) = v.parse() {
                    config.font_menu_size = n;
                }
            }
            if let Some(v) = section.get("FontDriveName") {
                config.font_drive_name = v.to_string();
            }
            if let Some(v) = section.get("FontDriveSize") {
                if let Ok(n) = v.parse() {
                    config.font_drive_size = n;
                }
            }
            if let Some(v) = section.get("FontTabName") {
                config.font_tab_name = v.to_string();
            }
            if let Some(v) = section.get("FontTabSize") {
                if let Ok(n) = v.parse() {
                    config.font_tab_size = n;
                }
            }
            if let Some(v) = section.get("FontHeaderName") {
                config.font_header_name = v.to_string();
            }
            if let Some(v) = section.get("FontHeaderSize") {
                if let Ok(n) = v.parse() {
                    config.font_header_size = n;
                }
            }
            if let Some(v) = section.get("FontPaneName") {
                config.font_pane_name = v.to_string();
            }
            if let Some(v) = section.get("FontPaneSize") {
                if let Ok(n) = v.parse() {
                    config.font_pane_size = n;
                }
            }
            if let Some(v) = section.get("FontStatusName") {
                config.font_status_name = v.to_string();
            }
            if let Some(v) = section.get("FontStatusSize") {
                if let Ok(n) = v.parse() {
                    config.font_status_size = n;
                }
            }
            if let Some(v) = section.get("Columns") {
                if let Ok(cols) = serde_json::from_str::<Vec<ColumnConfig>>(v) {
                    config.columns = cols;
                }
            }
            if let Some(v) = section.get("ColumnViews") {
                if let Ok(views) = serde_json::from_str::<HashMap<String, Vec<ColumnConfig>>>(v) {
                    config.column_views = views;
                }
            }
        }
        if config.column_views.is_empty() {
            config
                .column_views
                .insert("Default".to_string(), config.columns.clone());
        }
        if let Some(section) = conf.section(Some("Window")) {
            if let Some(v) = section.get("X") {
                if let Ok(n) = v.parse() {
                    config.window_x = Some(n);
                }
            }
            if let Some(v) = section.get("Y") {
                if let Ok(n) = v.parse() {
                    config.window_y = Some(n);
                }
            }
            if let Some(v) = section.get("Width") {
                if let Ok(n) = v.parse() {
                    config.window_width = Some(n);
                }
            }
            if let Some(v) = section.get("Height") {
                if let Ok(n) = v.parse() {
                    config.window_height = Some(n);
                }
            }
            if let Some(v) = section.get("OptionsWidth") {
                if let Ok(n) = v.parse() {
                    config.options_window_width = Some(n);
                }
            }
            if let Some(v) = section.get("OptionsHeight") {
                if let Ok(n) = v.parse() {
                    config.options_window_height = Some(n);
                }
            }
        }
        if let Some(section) = conf.section(Some("FileOperations")) {
            if let Some(v) = section.get("WhenFileExists") {
                config.file_op_options.when_file_exists = v.to_string();
            }
            if let Some(v) = section.get("WhenDirExists") {
                config.file_op_options.when_dir_exists = v.to_string();
            }
            if let Some(v) = section.get("WhenCannotSetProperty") {
                config.file_op_options.when_cannot_set_property = v.to_string();
            }
            if let Some(v) = section.get("ExcludeEmptyDirs") {
                config.file_op_options.exclude_empty_dirs = v == "true";
            }
            if let Some(v) = section.get("Verify") {
                config.file_op_options.verify = v == "true";
            }
            if let Some(v) = section.get("CheckFreeSpace") {
                config.file_op_options.check_free_space = v == "true";
            }
            if let Some(v) = section.get("ReserveSpace") {
                config.file_op_options.reserve_space = v == "true";
            }
            if let Some(v) = section.get("FollowLinks") {
                config.file_op_options.follow_links = v == "true";
            }
            if let Some(v) = section.get("CorrectLinks") {
                config.file_op_options.correct_links = v == "true";
            }
            if let Some(v) = section.get("CopyAttributes") {
                config.file_op_options.copy_attributes = v == "true";
            }
            if let Some(v) = section.get("DropReadonly") {
                config.file_op_options.drop_readonly = v == "true";
            }
            if let Some(v) = section.get("CopyDateTime") {
                config.file_op_options.copy_date_time = v == "true";
            }
            if let Some(v) = section.get("CopyOwnership") {
                config.file_op_options.copy_ownership = v == "true";
            }
            if let Some(v) = section.get("CopyOnWrite") {
                config.file_op_options.copy_on_write = v == "true";
            }
        }
        if let Some(section) = conf.section(Some("Session")) {
            if let Some(v) = section.get("LeftTabs") {
                if let Ok(tabs) = serde_json::from_str::<Vec<TabConfig>>(v) {
                    config.left_tabs = tabs;
                }
            }
            if let Some(v) = section.get("RightTabs") {
                if let Ok(tabs) = serde_json::from_str::<Vec<TabConfig>>(v) {
                    config.right_tabs = tabs;
                }
            }
            if let Some(v) = section.get("LeftActiveTab") {
                config.left_active_tab = v.to_string();
            }
            if let Some(v) = section.get("RightActiveTab") {
                config.right_active_tab = v.to_string();
            }
            if let Some(v) = section.get("LeftMode") {
                config.left_mode = v.to_string();
            }
            if let Some(v) = section.get("RightMode") {
                config.right_mode = v.to_string();
            }
            if let Some(v) = section.get("LeftViewMode") {
                config.left_view_mode = v.to_string();
            }
            if let Some(v) = section.get("RightViewMode") {
                config.right_view_mode = v.to_string();
            }
            if let Some(v) = section.get("IsVerticalLayout") {
                config.is_vertical_layout = v == "true";
            }
            if let Some(v) = section.get("IsSingleView") {
                config.is_single_view = v == "true";
            }
            if let Some(v) = section.get("PanelRatio") {
                if let Ok(ratio) = v.parse::<f64>() {
                    config.panel_ratio = ratio;
                }
            }
        }
    }
    if let Ok(inherited) = inherited_appearance().lock() {
        inherited.apply_to(&mut config);
    }

    config
}

#[tauri::command]
pub fn save_settings(app: AppHandle, new_config: AppConfig) -> Result<(), String> {
    if let Ok(mut inherited) = inherited_appearance().lock() {
        inherited.release_overridden(&new_config);
    }

    let mut conf = Ini::new();

    let validated_audio_player = if new_config.audio_player == "system" {
        "system"
    } else {
        "builtin"
    };
    conf.with_section(Some("Main"))
        .set("Language", &new_config.language)
        .set("StartAsRoot", new_config.start_as_root.to_string())
        .set("BehaviorSelection", &new_config.behavior_selection_mode)
        .set("AudioPlayer", validated_audio_player);

    conf.with_section(Some("Layout"))
        .set("ShowMenu", new_config.layout_show_menu.to_string());

    conf.with_section(Some("Colors"))
        .set("Background", &new_config.color_background)
        .set("Text", &new_config.color_text)
        .set("Theme", &new_config.theme)
        .set("IconTheme", &new_config.icon_theme);

    let columns_json = serde_json::to_string(&new_config.columns).map_err(|e| e.to_string())?;
    let views_json = serde_json::to_string(&new_config.column_views).map_err(|e| e.to_string())?;

    conf.with_section(Some("View"))
        .set("CustomColumns", &new_config.custom_columns)
        .set("ShowFolderTabs", new_config.show_folder_tabs.to_string())
        .set(
            "ShowFoldersWithBrackets",
            new_config.show_folders_with_brackets.to_string(),
        )
        .set(
            "ShowParentDirRow",
            new_config.show_parent_dir_row.to_string(),
        )
        .set(
            "ShowAlternatingRowColors",
            new_config.show_alternating_row_colors.to_string(),
        )
        .set(
            "ShowFileSizesInBytes",
            new_config.show_file_sizes_in_bytes.to_string(),
        )
        .set("FontFamily", &new_config.font_family)
        .set("FontMainName", &new_config.font_main_name)
        .set("FontMainSize", new_config.font_main_size.to_string())
        .set("FontMenuName", &new_config.font_menu_name)
        .set("FontMenuSize", new_config.font_menu_size.to_string())
        .set("FontDriveName", &new_config.font_drive_name)
        .set("FontDriveSize", new_config.font_drive_size.to_string())
        .set("FontTabName", &new_config.font_tab_name)
        .set("FontTabSize", new_config.font_tab_size.to_string())
        .set("FontHeaderName", &new_config.font_header_name)
        .set("FontHeaderSize", new_config.font_header_size.to_string())
        .set("FontPaneName", &new_config.font_pane_name)
        .set("FontPaneSize", new_config.font_pane_size.to_string())
        .set("FontStatusName", &new_config.font_status_name)
        .set("FontStatusSize", new_config.font_status_size.to_string())
        .set("Columns", columns_json)
        .set("ColumnViews", views_json);

    if let Some(x) = new_config.window_x {
        conf.set_to(Some("Window"), "X".into(), x.to_string());
    }
    if let Some(y) = new_config.window_y {
        conf.set_to(Some("Window"), "Y".into(), y.to_string());
    }
    if let Some(w) = new_config.window_width {
        conf.set_to(Some("Window"), "Width".into(), w.to_string());
    }
    if let Some(h) = new_config.window_height {
        conf.set_to(Some("Window"), "Height".into(), h.to_string());
    }
    if let Some(w) = new_config.options_window_width {
        conf.set_to(Some("Window"), "OptionsWidth".into(), w.to_string());
    }
    if let Some(h) = new_config.options_window_height {
        conf.set_to(Some("Window"), "OptionsHeight".into(), h.to_string());
    }

    conf.with_section(Some("FileOperations"))
        .set(
            "WhenFileExists",
            &new_config.file_op_options.when_file_exists,
        )
        .set("WhenDirExists", &new_config.file_op_options.when_dir_exists)
        .set(
            "WhenCannotSetProperty",
            &new_config.file_op_options.when_cannot_set_property,
        )
        .set(
            "ExcludeEmptyDirs",
            new_config.file_op_options.exclude_empty_dirs.to_string(),
        )
        .set("Verify", new_config.file_op_options.verify.to_string())
        .set(
            "CheckFreeSpace",
            new_config.file_op_options.check_free_space.to_string(),
        )
        .set(
            "ReserveSpace",
            new_config.file_op_options.reserve_space.to_string(),
        )
        .set(
            "FollowLinks",
            new_config.file_op_options.follow_links.to_string(),
        )
        .set(
            "CorrectLinks",
            new_config.file_op_options.correct_links.to_string(),
        )
        .set(
            "CopyAttributes",
            new_config.file_op_options.copy_attributes.to_string(),
        )
        .set(
            "DropReadonly",
            new_config.file_op_options.drop_readonly.to_string(),
        )
        .set(
            "CopyDateTime",
            new_config.file_op_options.copy_date_time.to_string(),
        )
        .set(
            "CopyOwnership",
            new_config.file_op_options.copy_ownership.to_string(),
        )
        .set(
            "CopyOnWrite",
            new_config.file_op_options.copy_on_write.to_string(),
        );

    let left_tabs_json = serde_json::to_string(&new_config.left_tabs).map_err(|e| e.to_string())?;
    let right_tabs_json =
        serde_json::to_string(&new_config.right_tabs).map_err(|e| e.to_string())?;

    conf.with_section(Some("Session"))
        .set("LeftTabs", left_tabs_json)
        .set("RightTabs", right_tabs_json)
        .set("LeftActiveTab", &new_config.left_active_tab)
        .set("RightActiveTab", &new_config.right_active_tab)
        .set("LeftMode", &new_config.left_mode)
        .set("RightMode", &new_config.right_mode)
        .set("LeftViewMode", &new_config.left_view_mode)
        .set("RightViewMode", &new_config.right_view_mode)
        .set(
            "IsVerticalLayout",
            new_config.is_vertical_layout.to_string(),
        )
        .set("IsSingleView", new_config.is_single_view.to_string())
        .set("PanelRatio", new_config.panel_ratio.to_string());

    let path = get_config_path(&app);

    // P1.4: serialize to memory, then stage and commit by rename. `rust-ini`'s
    // write_to_file truncates the config first, so an interrupted save left a
    // partial file that load_settings then read as defaults — silently resetting
    // the user's panels, tabs and columns (QSF-012).
    let mut rendered = Vec::new();
    conf.write_to(&mut rendered).map_err(|e| e.to_string())?;
    crate::engine::commit::write_config_atomically(&path, &rendered).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn appearance(theme: &str, icon_theme: &str) -> AppConfig {
        AppConfig {
            theme: theme.to_string(),
            icon_theme: icon_theme.to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn known_appearance_value_accepts_only_names_the_ui_can_render() {
        assert_eq!(
            known_appearance_value("github-light", THEMES).as_deref(),
            Some("github-light")
        );
        assert_eq!(
            known_appearance_value("zorin", ICON_THEMES).as_deref(),
            Some("zorin")
        );
        // A theme name is not an icon set, and vice versa.
        assert_eq!(known_appearance_value("midnight", ICON_THEMES), None);
        assert_eq!(known_appearance_value("material", THEMES), None);
        assert_eq!(known_appearance_value("", THEMES), None);
        // Anything unrecognised is dropped rather than forwarded to a process
        // that is about to become root.
        assert_eq!(
            known_appearance_value("github-light\nPATH=/tmp/evil", THEMES),
            None
        );
    }

    #[test]
    fn inherited_appearance_outranks_the_elevated_accounts_own_config() {
        let inherited = InheritedAppearance {
            theme: Some("github-light".to_string()),
            icon_theme: Some("zorin".to_string()),
        };

        // What root's own nexuscmd.ini says, or the defaults when it has none.
        let mut config = appearance("midnight", "material");
        inherited.apply_to(&mut config);

        assert_eq!(config.theme, "github-light");
        assert_eq!(config.icon_theme, "zorin");
    }

    #[test]
    fn changing_appearance_inside_the_elevated_session_ends_the_inheritance() {
        let mut inherited = InheritedAppearance {
            theme: Some("github-light".to_string()),
            icon_theme: Some("zorin".to_string()),
        };

        // A save that only carries the inherited values back (a column resize,
        // a tab change) must not count as the user choosing something.
        inherited.release_overridden(&appearance("github-light", "zorin"));
        assert_eq!(inherited.theme.as_deref(), Some("github-light"));
        assert_eq!(inherited.icon_theme.as_deref(), Some("zorin"));

        // Picking a theme here does, and only that field is released.
        inherited.release_overridden(&appearance("dracula", "zorin"));
        assert_eq!(inherited.theme, None);
        assert_eq!(inherited.icon_theme.as_deref(), Some("zorin"));

        let mut config = appearance("dracula", "material");
        inherited.apply_to(&mut config);
        assert_eq!(config.theme, "dracula");
        assert_eq!(config.icon_theme, "zorin");
    }
}
