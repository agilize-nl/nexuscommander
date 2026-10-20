// Shared UI-state types come from @nexus/ui; web-specific DTOs stay here.
export * from "@nexus/ui/types";

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
  font_status_name: string;
  font_status_size: number;
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




export interface AudioTrack {
  id: string;
  label: string;
  language: string;
  streamIndex: number;
  audioIndex: number;
  codec?: string;
  channels?: number;
  channelLayout?: string;
  title?: string;
  isDefault?: boolean;
}

export interface SubtitleTrack {
  id: string;
  label: string;
  language: string;
  src: string;
  isDefault?: boolean;
  isEmbedded?: boolean;
  fileName?: string;
  customBlob?: boolean;
}

export interface MediaInfo {
  duration: number | null;
  audioTracks: AudioTrack[];
  subtitles: SubtitleTrack[];
}
