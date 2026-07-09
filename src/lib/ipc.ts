import type { 
  FileEntry, 
  PathInfo, 
  OpResult, 
  DriveInfo, 
  ComparisonResult, 
  AppConfig, 
  FileOpOptions, 
  ColumnConfig, 
  TabConfig 
} from "./types";
import type {
  SystemCapabilities,
  ResolvedOpenAction,
  PreviewConversionStatus,
  OpenRequest
} from "./types";

export type { AppConfig, ColumnConfig, FileOpOptions, TabConfig } from "./types";
export type { SystemCapabilities, ResolvedOpenAction, PreviewConversionStatus, OpenRequest } from "./types";

const API = "/api";

export interface HealthInfo {
  status: string;
  version: string;
}

export async function getHealth(): Promise<HealthInfo> {
  return apiFetch<HealthInfo>("/health");
}

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const url = `${API}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = await response.json();
      if (body?.error) message = body.error;
    } catch {
      // Response body wasn't JSON; fall back to statusText.
    }
    throw new Error(`API error: ${message}`);
  }
  return response.json();
}

// ===== Read Operations =====

export async function readDirectory(path: string): Promise<FileEntry[]> {
  return apiFetch<FileEntry[]>(`/fs/read?path=${encodeURIComponent(path)}`);
}

export async function getHomeDir(): Promise<string> {
  return apiFetch<string>("/fs/home");
}

export async function getParentDir(path: string): Promise<string> {
  return apiFetch<string>(`/fs/parent?path=${encodeURIComponent(path)}`);
}

export async function getParentInfo(path: string): Promise<FileEntry> {
  return apiFetch<FileEntry>(`/fs/info?path=${encodeURIComponent(path)}`);
}

export async function getPathInfo(path: string): Promise<PathInfo> {
  return apiFetch<PathInfo>(`/fs/info?path=${encodeURIComponent(path)}`);
}

export async function fetchDrives(): Promise<DriveInfo[]> {
  return apiFetch<DriveInfo[]>("/fs/drives");
}

export async function compareDirectories(leftPath: string, rightPath: string): Promise<ComparisonResult> {
  return apiFetch<ComparisonResult>(`/fs/compare?left=${encodeURIComponent(leftPath)}&right=${encodeURIComponent(rightPath)}`);
}

// ===== CRUD Operations =====

export async function createDirectory(path: string): Promise<OpResult> {
  return apiFetch<OpResult>("/fs/mkdir", {
    method: 'POST',
    body: JSON.stringify({ path })
  });
}

export async function deleteEntry(path: string, recursive = false): Promise<OpResult> {
  return apiFetch<OpResult>("/fs/delete", {
    method: 'POST',
    body: JSON.stringify({ path, recursive })
  });
}

export async function deleteEntries(paths: string[], recursive = true): Promise<OpResult[]> {
  return Promise.all(paths.map(path => deleteEntry(path, recursive)));
}

export async function renameEntry(from: string, to: string): Promise<OpResult> {
  return apiFetch<OpResult>("/fs/rename", {
    method: 'POST',
    body: JSON.stringify({ from, to })
  });
}

export async function batchRename(renames: [string, string][]): Promise<OpResult[]> {
  return Promise.all(renames.map(([from, to]) => renameEntry(from, to)));
}

export async function copyFile(src: string, dst: string): Promise<OpResult> {
  return apiFetch<OpResult>("/fs/copy", {
    method: 'POST',
    body: JSON.stringify({ src, dst })
  });
}

export async function copyEntries(sources: string[], targetDir: string): Promise<OpResult[]> {
  return apiFetch<OpResult[]>("/fs/copy", {
    method: 'POST',
    body: JSON.stringify({ sources, targetDir })
  });
}

export async function moveEntries(sources: string[], targetDir: string): Promise<OpResult[]> {
  return apiFetch<OpResult[]>("/fs/move", {
    method: 'POST',
    body: JSON.stringify({ sources, targetDir })
  });
}

export async function calculateDirSize(path: string, signal?: AbortSignal): Promise<number> {
  return apiFetch<number>(`/fs/dirsize?path=${encodeURIComponent(path)}`, { signal });
}

export interface DirSizeResult {
  path: string;
  size?: number;
  error?: string;
}

/** Computes sizes for multiple directories in a single request (avoids exhausting the browser's connection pool). */
export async function calculateDirSizes(paths: string[], signal?: AbortSignal): Promise<DirSizeResult[]> {
  return apiFetch<DirSizeResult[]>("/fs/dirsizes", {
    method: 'POST',
    body: JSON.stringify({ paths }),
    signal
  });
}

// ===== Archive Operations =====

export async function isArchive(path: string): Promise<boolean> {
  return apiFetch<boolean>(`/archive/check?path=${encodeURIComponent(path)}`);
}

export async function readArchive(path: string): Promise<FileEntry[]> {
  return apiFetch<FileEntry[]>(`/archive/read?path=${encodeURIComponent(path)}`);
}

export async function archivePack(sources: string[], destPath: string): Promise<void> {
  return apiFetch<void>("/archive/pack", {
    method: 'POST',
    body: JSON.stringify({ sources, destPath })
  });
}

export async function archiveUnpack(srcPath: string, destDir: string): Promise<void> {
  return apiFetch<void>("/archive/unpack", {
    method: 'POST',
    body: JSON.stringify({ srcPath, destDir })
  });
}

export async function archiveTest(path: string): Promise<boolean> {
  return apiFetch<boolean>(`/archive/test?path=${encodeURIComponent(path)}`);
}

export async function splitFile(path: string, chunkSize: number, destDir: string): Promise<OpResult> {
  return apiFetch<OpResult>("/archive/split", {
    method: 'POST',
    body: JSON.stringify({ path, chunkSize, destDir })
  });
}

export async function combineFiles(sources: string[], destPath: string): Promise<OpResult> {
  return apiFetch<OpResult>("/archive/combine", {
    method: 'POST',
    body: JSON.stringify({ sources, destPath })
  });
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
}

export async function readFileForViewer(path: string): Promise<ViewerContent> {
  return apiFetch<ViewerContent>(`/viewer/read?path=${encodeURIComponent(path)}`);
}

export async function checkIsBinary(path: string): Promise<boolean> {
  return apiFetch<boolean>(`/viewer/binary?path=${encodeURIComponent(path)}`);
}

export async function resolveOpenAction(path: string, intent: "open" | "view" | "edit" = "open"): Promise<ResolvedOpenAction> {
  return apiFetch<ResolvedOpenAction>(`/viewer/resolve?path=${encodeURIComponent(path)}&intent=${encodeURIComponent(intent)}`);
}

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
  current_file_total_bytes: number;
  current_file_transferred_bytes: number;
  current_file_source: string;
  current_file_target: string;
  speed_bytes_per_sec: number;
  eta_seconds: number;
  pending_conflict: string | null;
  error: string | null;
}

export async function taskCreate(
  taskType: string,
  sources: string[],
  target: string
): Promise<string> {
  return apiFetch<string>("/tasks/create", {
    method: 'POST',
    body: JSON.stringify({ taskType, sources, target })
  });
}

export async function taskExecute(taskId: string): Promise<TaskInfo> {
  return apiFetch<TaskInfo>(`/tasks/${taskId}/execute`, { method: 'POST' });
}

export async function taskGet(taskId: string): Promise<TaskInfo | null> {
  return apiFetch<TaskInfo | null>(`/tasks/${taskId}/status`);
}

export async function taskList(): Promise<TaskInfo[]> {
  return apiFetch<TaskInfo[]>("/tasks");
}

export async function taskCancel(taskId: string): Promise<boolean> {
  return apiFetch<boolean>(`/tasks/${taskId}/cancel`, { method: 'POST' });
}

export async function taskClearFinished(): Promise<void> {
  return apiFetch<void>("/tasks/clear-finished", { method: 'POST' });
}

export async function resolveTaskConflict(taskId: string, resolution: string): Promise<boolean> {
  return apiFetch<boolean>(`/tasks/${taskId}/resolve-conflict`, {
    method: 'POST',
    body: JSON.stringify({ resolution })
  });
}

// ===== Phase 4: Bookmarks & Hotlist =====

export interface Bookmark {
  name: string;
  path: string;
}

export async function getBookmarks(): Promise<Bookmark[]> {
  return apiFetch<Bookmark[]>("/bookmarks");
}

export async function saveBookmarks(bookmarks: Bookmark[]): Promise<void> {
  return apiFetch<void>("/bookmarks", {
    method: 'POST',
    body: JSON.stringify({ bookmarks })
  });
}

export async function addBookmark(bookmark: Bookmark): Promise<void> {
  const current = await getBookmarks();
  await saveBookmarks([...current, bookmark]);
}

export async function removeBookmark(path: string): Promise<void> {
  const current = await getBookmarks();
  await saveBookmarks(current.filter(b => b.path !== path));
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

export async function searchFiles(params: SearchParams): Promise<SearchResult[]> {
  return apiFetch<SearchResult[]>("/fs/search", {
    method: 'POST',
    body: JSON.stringify({ params })
  });
}

// ===== Phase 4: Terminal =====

export async function openTerminal(path: string): Promise<void> {
  return apiFetch<void>("/system/open-terminal", {
    method: 'POST',
    body: JSON.stringify({ path })
  });
}

export async function openFile(path: string): Promise<void> {
  return apiFetch<void>("/system/open-file", {
    method: 'POST',
    body: JSON.stringify({ path })
  });
}

export interface AppInfo {
  name: string;
  desktop_entry: string;
  icon: string | null;
  is_default: boolean;
}

export async function getOpenWithApps(path: string): Promise<AppInfo[]> {
  return apiFetch<AppInfo[]>(`/system/open-with?path=${encodeURIComponent(path)}`);
}

export async function openFileWithApp(path: string, desktopEntry: string): Promise<void> {
  return apiFetch<void>("/system/open-file-with", {
    method: 'POST',
    body: JSON.stringify({ path, desktopEntry })
  });
}

export async function setDefaultApp(path: string, desktopEntry: string): Promise<void> {
  return apiFetch<void>("/system/set-default-app", {
    method: 'POST',
    body: JSON.stringify({ path, desktopEntry })
  });
}

export async function executeCommand(command: string, currentDir: string): Promise<string> {
  return apiFetch<string>("/system/execute", {
    method: 'POST',
    body: JSON.stringify({ command, currentDir })
  });
}

// ===== Phase 5: Settings =====

// Removed duplicate interfaces - now in types.ts

export async function loadSettings(): Promise<AppConfig> {
  return apiFetch<AppConfig>("/settings");
}

export async function saveSettings(newConfig: AppConfig): Promise<void> {
  return apiFetch<void>("/settings", {
    method: 'POST',
    body: JSON.stringify({ newConfig })
  });
}

// ===== Network Operations =====

export async function mapNetworkDrive(path: string, letter: string, persistent: boolean): Promise<void> {
  return apiFetch<void>("/system/map-network-drive", {
    method: 'POST',
    body: JSON.stringify({ path, letter, persistent })
  });
}

export async function disconnectNetworkDrive(pathOrLetter: string): Promise<void> {
  return apiFetch<void>("/system/disconnect-network-drive", {
    method: 'POST',
    body: JSON.stringify({ pathOrLetter })
  });
}

export async function getOS(): Promise<string> {
  return apiFetch<string>("/system/os");
}

export async function getSystemCapabilities(): Promise<SystemCapabilities> {
  return apiFetch<SystemCapabilities>("/system/capabilities");
}

export async function openConfigDir(): Promise<void> {
  return apiFetch<void>("/system/open-config-dir", { method: 'POST' });
}

export async function loadLanguageFile(lang: string): Promise<Record<string, any>> {
  return apiFetch<Record<string, any>>(`/system/language/${lang}`);
}

export interface LanguageInfo {
  code: string;
  name: string;
}

export async function listLanguages(): Promise<LanguageInfo[]> {
  return apiFetch<LanguageInfo[]>("/system/languages");
}

export async function saveTextFile(path: string, text: string): Promise<OpResult> {
  return apiFetch<OpResult>(`/fs/text?path=${encodeURIComponent(path)}`, {
    method: 'PUT',
    body: JSON.stringify({ text })
  });
}

export async function convertPreview(path: string): Promise<PreviewConversionStatus> {
  return apiFetch<PreviewConversionStatus>("/preview/convert", {
    method: 'POST',
    body: JSON.stringify({ path })
  });
}

export async function remuxPreview(path: string): Promise<PreviewConversionStatus> {
  return apiFetch<PreviewConversionStatus>("/preview/remux", {
    method: 'POST',
    body: JSON.stringify({ path })
  });
}

// Hands the path off to a `nexuscmd://` link, purely client-side. This only
// does something if the browser's own machine has the one-time local opener
// installed (see docs/LOCAL_FILE_OPENER.md) - typically true when a desktop
// mounts the same NAS shares at the same absolute paths as this headless LXC,
// so no path translation is needed. It's a no-op if nothing is registered.
export function openOnThisComputer(path: string): void {
  window.location.href = `nexuscmd://${encodeURIComponent(path)}`;
}

export function convertFileSrc(filePath: string) {
  return `${API}/fs/raw?path=${encodeURIComponent(filePath)}`;
}

export function listenToTaskProgress(taskId: string, onProgress: (data: any) => void) {
  const eventSource = new EventSource(`${API}/tasks/${taskId}/progress`);

  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    onProgress(data);
    if (data.status === 'Completed' || data.status === 'Failed' || data.status === 'Cancelled') {
      eventSource.close();
    }
  };

  eventSource.onerror = (error) => {
    console.error('SSE Error:', error);
    eventSource.close();
  };

  return () => eventSource.close();
}

export interface UsersGroups {
  users: string[];
  groups: string[];
  currentUser?: string;
  currentGroup?: string;
}

export async function getUsersGroups(): Promise<UsersGroups> {
  return apiFetch<UsersGroups>("/fs/users-groups");
}

export async function setFileProperties(
  path: string,
  params: { permissions?: string; owner?: string; group?: string }
): Promise<{ success: boolean }> {
  return apiFetch<{ success: boolean }>("/fs/set-properties", {
    method: "POST",
    body: JSON.stringify({ path, ...params }),
  });
}

export async function getSystemUser(): Promise<{ username: string }> {
  return apiFetch<{ username: string }>("/system/user");
}

export async function elevateOperation(params: {
  action: string;
  path: string;
  target?: string;
  password?: string;
  permissions?: string;
  owner?: string;
  group?: string;
}): Promise<{ success: boolean }> {
  return apiFetch<{ success: boolean }>("/fs/elevate-operation", {
    method: "POST",
    body: JSON.stringify(params),
  });
}
