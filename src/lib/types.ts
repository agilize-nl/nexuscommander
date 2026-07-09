/** Represents a single file or directory entry from the Rust VFS. */
export interface FileEntry {
  name: string;
  path?: string; // Optional full path (used for collections/search results)
  is_dir: boolean;
  is_symlink: boolean;
  size: number;
  modified: number;
  extension: string;
  permissions: string;
  owner: string;
  group: string;
  created?: number;
  accessed?: number;
  changed?: number;
  link_target?: string;
  compressed_size?: number;
}

/** Info about a filesystem path. */
export interface PathInfo {
  exists: boolean;
  is_dir: boolean;
  canonical: string;
}

/** Information about a logic drive or mount point. */
export interface DriveInfo {
  path: string;
  name: string;
  drive_type: string;
  total_space: number;
  available_space: number;
}

/** Result of comparing two directories. */
export interface ComparisonResult {
  only_in_left: string[];
  only_in_right: string[];
  different: string[];
  identical: string[];
}

/** Result of a file operation from the backend. */
export interface OpResult {
  success: boolean;
  message: string;
}

/** Represents a panel's state. */
export interface PanelState {
  path: string;
  entries: FileEntry[];
  selectedIndex: number;
  selectedEntries: Set<number>;
  sortColumn: SortColumn;
  sortAsc: boolean;
  loading: boolean;
  error: string | null;
}

export type SortColumn = "name" | "extension" | "size" | "modified";

export type ActivePanel = "left" | "right";

/** Types of dialogs that can be shown. */
export type DialogType = "mkdir" | "rename" | "delete" | "copy" | "move" | "pack" | "unpack" | "split" | "combine" | "select_group" | "unselect_group" | "properties" | "permission_denied" | "sudo_password" | null;

/** Dialog state. */
export interface DialogState {
  type: DialogType;
  /** Input value for mkdir/rename */
  inputValue: string;
  /** Entries to operate on (for delete/copy/move) */
  entries: FileEntry[];
  /** Source paths for operations */
  sourcePaths: string[];
  /** Target directory for copy/move */
  targetDir: string;
  /** Source directory (current dir of the active panel) */
  sourceDir: string;
}

/** MenuItem for ContextMenu */
export type MenuItem = {
  label: string;
  action?: () => void;
  shortcut?: string;
  iconPath?: string;
  items?: MenuItem[];
  isSeparator?: never;
  mnemonicIndex?: number;
  checked?: boolean;
  radio?: boolean;
  onToggle?: (checked: boolean) => void;
} | {
  isSeparator: true;
  label?: never;
  action?: never;
  shortcut?: never;
  items?: never;
  mnemonicIndex?: never;
  checked?: never;
  radio?: never;
  onToggle?: never;
};


/** Drop menu state for drag and drop operations. */
export interface DropMenuState {
  visible: boolean;
  x: number;
  y: number;
  files: string[];
  isExternal: boolean;
  targetDir: string;
  side: "left" | "right";
  forceCopy?: boolean;
}

/** Global Context Menu state. */
export interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  options: MenuItem[];
}

export interface FileOpOptions {
  when_file_exists: string;
  when_dir_exists: string;
  when_cannot_set_property: string;
  exclude_empty_dirs: boolean;
  verify: boolean;
  check_free_space: boolean;
  reserve_space: boolean;
  follow_links: boolean;
  correct_links: boolean;
  copy_attributes: boolean;
  drop_readonly: boolean;
  copy_date_time: boolean;
  copy_ownership: boolean;
  copy_on_write: boolean;
}

export interface ColumnConfig {
  caption: string;
  width: number;
  align: string;
  field_contents: string;
}

export interface TabConfig {
  id: string;
  path: string;
  label: string;
  custom_label: string | null;
  locked: boolean;
}

export type ConflictPolicy =
  | 'ask'
  | 'overwrite'
  | 'overwrite_newer'
  | 'overwrite_size_differs'
  | 'skip'
  | 'rename_all';

export interface AppConfig {
  upload_on_conflict?: ConflictPolicy;
  language: string;
  layout_show_menu: boolean;
  layout_show_toolbar: boolean;
  layout_show_folder_brackets: boolean;
  layout_show_parent_dir_row: boolean;
  layout_is_vertical: boolean;
  layout_single_view: boolean;
  layout_panel_ratio: number;
  layout_left_view_mode: "brief" | "full";
  layout_right_view_mode: "brief" | "full";
  theme: string;
  icon_theme: string;
  behavior_selection_mode: string;
  custom_columns: string;
  show_folder_tabs: boolean;
  show_alternating_row_colors: boolean;
  font_family: string;
  font_main_name: string;
  font_main_size: number;
  font_menu_name: string;
  font_menu_size: number;
  font_drive_name: string;
  font_drive_size: number;
  font_tab_name: string;
  font_tab_size: number;
  font_header_name: string;
  font_header_size: number;
  font_pane_name: string;
  font_pane_size: number;
  columns: ColumnConfig[];
  left_tabs: TabConfig[];
  right_tabs: TabConfig[];
  left_active_tab: string;
  right_active_tab: string;
  window_x?: number;
  window_y?: number;
  window_width?: number;
  window_height?: number;
  file_op_options: FileOpOptions;
}

export interface SystemCapabilities {
  headless: boolean;
  desktopOpenAvailable: boolean;
  browserPreviewAvailable: boolean;
  conversionAvailable: boolean;
  transcodingAvailable: boolean;
}

export type ResolvedOpenActionName =
  | "editor"
  | "text-viewer"
  | "image-viewer"
  | "pdf-viewer"
  | "media-player"
  | "media-remux"
  | "converted-preview"
  | "desktop-app"
  | "raw"
  | "unsupported";

export interface ResolvedOpenAction {
  action: ResolvedOpenActionName;
  file_name: string;
  file_size: number;
  mime_type: string | null;
  media_kind: "audio" | "video" | null;
  reason: string | null;
  capabilities: SystemCapabilities;
}

export interface PreviewConversionStatus {
  status: string;
  format: string;
  previewUrl: string;
  outputPath: string;
  message: string;
}

export interface OpenRequest {
  path: string;
  intent: "open" | "view" | "edit";
  siblingPaths?: string[];
}
