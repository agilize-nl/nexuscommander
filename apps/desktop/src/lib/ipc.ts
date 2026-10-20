import { invoke, convertFileSrc as tauriConvertFileSrc } from "@tauri-apps/api/core";
import type { FileEntry, PathInfo, OpResult, DriveInfo, ComparisonResult } from "./types";

/** Convert a filesystem path to a URL the webview can load (Tauri asset protocol). */
export function convertFileSrc(filePath: string): string {
  return tauriConvertFileSrc(filePath);
}

// ===== Read Operations =====

// Both panels, the drive bar and the periodic stale-path check can ask for the
// same listing within a frame or two. Coalescing the duplicates keeps the
// backend from walking the same directory several times over.
const directoryRequests = new Map<string, Promise<FileEntry[]>>();
let drivesRequest: Promise<DriveInfo[]> | null = null;
let drivesCache: { value: DriveInfo[]; loadedAt: number } | null = null;

function parentDirectory(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  if (!normalized || normalized === "/") return "/";
  const slash = normalized.lastIndexOf("/");
  return slash <= 0 ? "/" : normalized.slice(0, slash);
}

export async function readDirectory(path: string): Promise<FileEntry[]> {
  const pending = directoryRequests.get(path);
  if (pending) return pending;

  const request = invoke<FileEntry[]>("read_directory", { path });
  directoryRequests.set(path, request);

  try {
    return await request;
  } finally {
    if (directoryRequests.get(path) === request) {
      directoryRequests.delete(path);
    }
  }
}

export async function getHomeDir(): Promise<string> {
  return invoke<string>("get_home_dir");
}

export async function getParentDir(path: string): Promise<string> {
  return invoke<string>("get_parent_dir", { path });
}

export async function getPathInfo(path: string): Promise<PathInfo> {
  return invoke<PathInfo>("get_path_info", { path });
}

export async function getDrives(): Promise<DriveInfo[]> {
  // Enumerating drives touches every mount point; a 1s cache is short enough that
  // an eject still shows up quickly but long enough to absorb the burst both
  // panels fire on every navigation.
  const now = Date.now();
  if (drivesCache && now - drivesCache.loadedAt < 1000) {
    return drivesCache.value;
  }
  if (drivesRequest) return drivesRequest;

  drivesRequest = invoke<DriveInfo[]>("get_drives");
  try {
    const value = await drivesRequest;
    drivesCache = { value, loadedAt: Date.now() };
    return value;
  } finally {
    drivesRequest = null;
  }
}

export function sortDrives(drives: DriveInfo[]): DriveInfo[] {
  const local = drives.filter((d) => d.drive_type === "Local");
  const network = drives.filter((d) => d.drive_type === "Network");
  const usb = drives.filter(
    (d) => d.drive_type !== "Local" && d.drive_type !== "Network"
  );

  local.sort((a, b) => {
    if (a.path === "/") return -1;
    if (b.path === "/") return 1;
    return a.name.localeCompare(b.name, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });

  network.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, {
      numeric: true,
      sensitivity: "base",
    })
  );

  usb.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, {
      numeric: true,
      sensitivity: "base",
    })
  );

  return [...local, ...network, ...usb];
}

export async function compareDirectories(leftPath: string, rightPath: string): Promise<ComparisonResult> {
  return invoke<ComparisonResult>("compare_directories", { leftPath, rightPath });
}

// ===== CRUD Operations =====

export async function createDirectory(path: string): Promise<OpResult> {
  return invoke<OpResult>("create_directory", { path });
}

export enum DeleteMode {
  Permanent = "Permanent",
  Trash = "Trash",
}

export async function deleteEntry(path: string, recursive = false, mode = DeleteMode.Trash): Promise<OpResult> {
  return invoke<OpResult>("delete_entry", { path, recursive, mode });
}

export async function deleteEntries(paths: string[], recursive = true, mode = DeleteMode.Trash): Promise<OpResult[]> {
  return invoke<OpResult[]>("delete_entries", { paths, recursive, mode });
}

export async function renameEntry(from: string, to: string): Promise<OpResult> {
  return invoke<OpResult>("rename_entry", { from, to });
}

export async function batchRename(renames: [string, string][]): Promise<OpResult[]> {
  return invoke<OpResult[]>("batch_rename", { renames });
}

export async function copyFile(src: string, dst: string): Promise<OpResult> {
  return invoke<OpResult>("copy_file", { src, dst });
}

export async function copyEntries(sources: string[], targetDir: string): Promise<OpResult[]> {
  return invoke<OpResult[]>("copy_entries", { sources, targetDir });
}

export async function moveEntries(sources: string[], targetDir: string): Promise<OpResult[]> {
  return invoke<OpResult[]>("move_entries", { sources, targetDir });
}

export async function saveTextFile(path: string, text: string): Promise<void> {
  return invoke<void>("save_text_file", { path, text });
}

function abortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("Operation aborted", "AbortError");
  }
  const err = new Error("Operation aborted");
  err.name = "AbortError";
  return err;
}

export async function calculateDirSize(path: string, signal?: AbortSignal): Promise<number> {
  if (signal?.aborted) throw abortError();
  const size = await invoke<number>("calculate_dir_size", { path });
  if (signal?.aborted) throw abortError();
  return size;
}

export async function calculateDirSizes(paths: string[], signal?: AbortSignal): Promise<DirSizeResult[]> {
  const results: DirSizeResult[] = [];
  const concurrency = 4;
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < paths.length) {
      if (signal?.aborted) throw abortError();
      const index = nextIndex++;
      const path = paths[index];
      try {
        results[index] = { path, size: await calculateDirSize(path, signal) };
      } catch (e: any) {
        if (e?.name === "AbortError") throw e;
        const error = typeof e === "string" ? e : e?.message || String(e);
        results[index] = { path, error };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, paths.length) }, () => worker()),
  );

  return results;
}

// ===== Archive Operations =====

export async function isArchive(path: string): Promise<boolean> {
  return invoke<boolean>("is_archive", { path });
}

export async function readArchive(path: string): Promise<FileEntry[]> {
  return invoke<FileEntry[]>("read_archive", { path });
}

export async function archivePack(sources: string[], destPath: string, options?: { format?: string; compression_level?: number; solid_archive?: boolean; follow_links?: boolean }): Promise<void> {
  return invoke<void>("archive_pack", { sources, destPath, options });
}

export async function archiveCancelPack(): Promise<void> {
  return invoke<void>("archive_cancel_pack");
}

export async function archiveUnpack(
  srcPath: string,
  destDir: string,
  entries?: string[],
  conflict?: ExtractConflict
): Promise<UnpackReport> {
  // `null` rather than omitted: the backend reads absent as `Skip`, and sending
  // the field explicitly keeps that decision visible on this side too.
  return invoke<UnpackReport>("archive_unpack", {
    srcPath,
    destDir,
    entries: entries || null,
    conflict: conflict ?? null
  });
}

export async function getArchiveCapabilities(): Promise<ArchiveFormatCapability[]> {
  return invoke<ArchiveFormatCapability[]>("get_archive_capabilities");
}

export async function archiveTest(path: string): Promise<boolean> {
  return invoke<boolean>("archive_test", { path });
}

export async function splitFile(path: string, chunkSize: number, destDir: string): Promise<OpResult> {
  return invoke<OpResult>("split_file", { path, chunkSize, destDir });
}

export async function combineFiles(sources: string[], destPath: string): Promise<OpResult> {
  return invoke<OpResult>("combine_files", { sources, destPath });
}

// ===== Viewer Operations =====

export interface ViewerContent {
  mode: "Text" | "Hex" | "Image" | "Unsupported";
  file_name: string;
  file_size: number;
  text: string | null;
  hex_lines: string[] | null;
  image_data: string | null;
  mime_type: string | null;
  encoding?: string | null;
}

export async function readFileForViewer(path: string, encoding?: string): Promise<ViewerContent> {
  return invoke<ViewerContent>("read_file_for_viewer", { path, encoding });
}

// QSF-008 / P0.1: `check_is_binary` has no backend handler — see the note above.

// ===== Task Queue Operations =====


export interface TaskInfo {
  id: string;
  task_type: "Copy" | "Move" | "Delete";
  status: "Queued" | "Running" | "Paused" | "Completed" | "Failed" | "Cancelled" | "WaitingForInput";
  sources: string[];
  target: string;
  total_bytes: number;
  transferred_bytes: number;
  total_files: number;
  processed_files: number;
  current_file: string;
  speed_bytes_per_sec: number;
  eta_seconds: number;
  pending_conflict: string | null;
  conflict_is_dir: boolean;
  error: string | null;
}

export async function taskCreate(
  taskType: "copy" | "move" | "delete",
  sources: string[],
  target: string
): Promise<string> {
  return invoke<string>("task_create", { taskType, sources, target });
}

export async function taskExecute(taskId: string): Promise<TaskInfo> {
  return invoke<TaskInfo>("task_execute", { taskId });
}

export async function taskGet(taskId: string): Promise<TaskInfo | null> {
  return invoke<TaskInfo | null>("task_get", { taskId });
}

export async function taskList(): Promise<TaskInfo[]> {
  return invoke<TaskInfo[]>("task_list");
}

export async function taskCancel(taskId: string): Promise<boolean> {
  return invoke<boolean>("task_cancel", { taskId });
}

export async function taskPause(taskId: string): Promise<boolean> {
  return invoke<boolean>("task_pause", { taskId });
}

export async function taskResume(taskId: string): Promise<boolean> {
  return invoke<boolean>("task_resume", { taskId });
}

export async function taskClearFinished(includeFailed = false): Promise<void> {
  return invoke<void>("task_clear_finished", { includeFailed });
}

export async function resolveTaskConflict(taskId: string, resolution: string): Promise<boolean> {
  return invoke<boolean>("resolve_task_conflict", { taskId, resolution });
}

// ===== Phase 4: Bookmarks & Hotlist =====

export interface Bookmark {
  name: string;
  path: string;
}

export async function getBookmarks(): Promise<Bookmark[]> {
  return invoke<Bookmark[]>("get_bookmarks");
}

export async function saveBookmarks(bookmarks: Bookmark[]): Promise<void> {
  return invoke<void>("save_bookmarks", { bookmarks });
}

export async function addBookmark(bookmark: Bookmark): Promise<void> {
  return invoke<void>("add_bookmark", { bookmark });
}

export async function removeBookmark(path: string): Promise<void> {
  return invoke<void>("remove_bookmark", { path });
}

// ===== Phase 4: Search =====

export interface SearchParams {
  query: string;
  start_dir: string;
  use_regex: boolean;
  content_query: string | null;
}

export interface SearchResult {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: number;
}

export async function searchFiles(params: SearchParams): Promise<string> {
  return invoke<string>("search_files", { params });
}

export async function searchCancel(jobId: string): Promise<void> {
  return invoke<void>("search_cancel", { jobId });
}

/**
 * Subscribe to a streaming search job (Tauri events). Backs the shared SearchModal:
 * `searchFiles` returns a jobId, then incremental `search-result:<jobId>` events and a
 * terminal `search-done:<jobId>` event drive the UI. Returns a combined unlisten.
 */
export async function searchListen(
  jobId: string,
  onResult: (result: SearchResult) => void,
  onDone: () => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  const unlistenResult = await listen<SearchResult>(`search-result:${jobId}`, (event) => {
    if (event.payload) onResult(event.payload);
  });
  const unlistenDone = await listen(`search-done:${jobId}`, () => onDone());
  return () => {
    unlistenResult();
    unlistenDone();
  };
}

// ===== Phase 4: Terminal =====

export async function openTerminal(path: string): Promise<void> {
  return invoke<void>("open_terminal", { path });
}

export async function openFile(path: string): Promise<void> {
  return invoke("open_file", { path });
}

export async function openInEditor(path: string): Promise<void> {
  return invoke("open_in_editor", { path });
}

export interface AppInfo {
  name: string;
  desktop_entry: string;
  icon: string | null;
  is_default: boolean;
}

export async function getOpenWithApps(path: string): Promise<AppInfo[]> {
  return invoke<AppInfo[]>("get_open_with_apps", { path });
}

export async function openFileWithApp(path: string, desktopEntry: string): Promise<void> {
  return invoke<void>("open_file_with_app", { path, desktopEntry });
}

export async function setDefaultApp(path: string, desktopEntry: string): Promise<void> {
  return invoke<void>("set_default_app", { path, desktopEntry });
}


// ===== Phase 5: Settings =====

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

export interface AppConfig {
  language: string;
  start_as_root: boolean;
  layout_show_menu: boolean;
  audio_player: string;
  color_background: string;
  color_text: string;
  theme: string;
  icon_theme: string;
  behavior_selection_mode: string;
  custom_columns: string;
  show_folder_tabs: boolean;
  show_folders_with_brackets: boolean;
  show_parent_dir_row: boolean;
  show_alternating_row_colors: boolean;
  show_file_sizes_in_bytes: boolean;
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
  column_views: Record<string, ColumnConfig[]>;
  left_tabs: TabConfig[];
  right_tabs: TabConfig[];
  left_active_tab: string;
  right_active_tab: string;
  left_mode: string;
  right_mode: string;
  left_view_mode: string;
  right_view_mode: string;
  is_vertical_layout: boolean;
  is_single_view: boolean;
  panel_ratio: number;
  window_x?: number;
  window_y?: number;
  window_width?: number;
  window_height?: number;
  options_window_width?: number;
  options_window_height?: number;
  file_op_options: FileOpOptions;
}

export async function loadSettings(): Promise<AppConfig> {
  return invoke<AppConfig>("load_settings");
}

export async function saveSettings(newConfig: AppConfig): Promise<void> {
  return invoke<void>("save_settings", { newConfig });
}

// QSF-008 / P0.1: `edit_config_file` has no backend handler — see the note in
// the archive section. Nothing in either shell calls it today.

export interface HelpTopic {
  id: string;
  label: string;
  labelKey?: string;
  file?: string;
  children?: HelpTopic[];
}

export async function getHelpTopics(): Promise<HelpTopic[]> {
  return await invoke("get_help_topics");
}

export async function getHelpContent(file: string, lang?: string): Promise<string> {
  return await invoke("get_help_content", { fileName: file, lang });
}

// ===== Network Operations =====

export async function mapNetworkDrive(path: string, letter: string, persistent: boolean): Promise<void> {
  return invoke<void>("map_network_drive", { path, letter, persistent });
}

export async function disconnectNetworkDrive(pathOrLetter: string): Promise<void> {
  return invoke<void>("disconnect_network_drive", { pathOrLetter });
}

// QSF-008 / P0.1: `get_os` has no backend handler — see the note in the archive
// section. NetworkConnectionsModal feature-detects it and falls back to the
// POSIX presentation.

export async function loadLanguageFile(lang: string): Promise<Record<string, any>> {
  return invoke<Record<string, any>>("load_language_file", { lang });
}

// ===== App Control =====

export async function exitApp(): Promise<void> {
  return invoke<void>("exit_app");
}

export async function restartAsRoot(): Promise<void> {
  return invoke<void>("restart_as_root");
}

export async function isRunningAsRoot(): Promise<boolean> {
  return invoke<boolean>("is_running_as_root");
}

// ===== File properties (permissions / ownership / size-on-disk) =====
// Fase 4: backed by new Rust commands (set_file_properties / get_users_groups /
// get_size_on_disk in vfs.rs). Gives the desktop shell the same capability the
// web shell already had, so the shared FilePropertiesDialog works on both.

export interface UsersGroups {
  users: string[];
  groups: string[];
  currentUser?: string;
  currentGroup?: string;
}

export async function getUsersGroups(): Promise<UsersGroups> {
  return invoke<UsersGroups>("get_users_groups");
}

export async function setFileProperties(
  path: string,
  params: { permissions?: string; owner?: string; group?: string }
): Promise<{ success: boolean; message?: string }> {
  const res = await invoke<OpResult>("set_file_properties", {
    path,
    permissions: params.permissions ?? null,
    owner: params.owner ?? null,
    group: params.group ?? null,
  });
  if (res.success) {
    directoryRequests.delete(parentDirectory(path));
    directoryRequests.delete(path);
  }
  // The message travels with the flag: `set_file_properties` returns a failed
  // OpResult rather than throwing, so dropping it here left the caller with a
  // bare `false` and no way to say what went wrong (or to recognise a
  // permission denial and offer elevation).
  return { success: res.success, message: res.message };
}

export async function getSizeOnDisk(path: string): Promise<number> {
  return invoke<number>("get_size_on_disk", { path });
}

// ===== @nexus/ui adapter registration (Fase 2 — the adapter seam) =====
// This module implements the transport-agnostic NexusIpc contract with Tauri
// `invoke()`. Shared components in @nexus/ui call getIpc() rather than importing
// these functions directly. `satisfies` verifies conformance without hiding errors.
import {
  setIpc,
  type ArchiveFormatCapability,
  type DirSizeResult,
  type ExtractConflict,
  type NexusIpc,
  type SystemCapabilities,
  type UnpackReport
} from "@nexus/ui";

export async function getSystemCapabilities(): Promise<SystemCapabilities> {
  return {
    headless: false,
    desktopOpenAvailable: true,
    browserPreviewAvailable: true,
    conversionAvailable: false,
    transcodingAvailable: false,
  };
}

export const desktopIpc = {
  readDirectory,
  getHomeDir,
  getParentDir,
  getPathInfo,
  getDrives,
  sortDrives,
  compareDirectories,
  createDirectory,
  deleteEntry,
  deleteEntries,
  renameEntry,
  batchRename,
  copyFile,
  copyEntries,
  moveEntries,
  saveTextFile,
  calculateDirSize,
  calculateDirSizes,
  isArchive,
  readArchive,
  archivePack,
  archiveCancelPack,
  archiveUnpack,
  getArchiveCapabilities,
  archiveTest,
  splitFile,
  combineFiles,
  readFileForViewer,
  taskCreate,
  taskExecute,
  taskGet,
  taskList,
  taskCancel,
  taskPause,
  taskResume,
  taskClearFinished,
  resolveTaskConflict,
  getBookmarks,
  saveBookmarks,
  addBookmark,
  removeBookmark,
  searchFiles,
  searchCancel,
  searchListen,
  openTerminal,
  openFile,
  openInEditor,
  getOpenWithApps,
  openFileWithApp,
  setDefaultApp,
  getSystemCapabilities,
  loadSettings,
  saveSettings,
  getHelpTopics,
  getHelpContent,
  mapNetworkDrive,
  disconnectNetworkDrive,
  loadLanguageFile,
  exitApp,
  restartAsRoot,
  isRunningAsRoot,
  getUsersGroups,
  setFileProperties,
  getSizeOnDisk,
  convertFileSrc,
} satisfies NexusIpc;

setIpc(desktopIpc);
