/**
 * NexusIpc — the transport-agnostic contract between the shared UI (`@nexus/ui`)
 * and each app shell. It is the UNION of both `ipc.ts` implementations:
 *
 *   - apps/desktop → Tauri `invoke()` adapter
 *   - apps/web     → HTTP `fetch()` adapter
 *
 * Design rules (see docs/NEXUS_MIGRATIEPLAN_MONOREPO_2026-07-23.md, Fase 2):
 *   - Methods present in BOTH shells are required.
 *   - Methods present in ONE shell are optional (`?`) → the UI must feature-detect
 *     (`getIpc().setFileProperties?.(…)`) and degrade gracefully instead of crashing.
 *   - Members use METHOD syntax on purpose: it gives bivariant parameter checking so
 *     both adapters (which narrow some params, e.g. taskType) conform without casts.
 *   - Diverging return shapes are widened here (superset types with optional fields,
 *     or unions) so a single interface describes both transports honestly.
 *   - App-specific config schemas (AppConfig) diverge structurally and stay app-local;
 *     `loadSettings`/`saveSettings` are intentionally loose here.
 */

// ===== Shared value types (identical across both shells) =====

/** A single file or directory entry. Superset of both shells (web adds the optional stat fields). */
export interface FileEntry {
  name: string;
  is_dir: boolean;
  is_symlink: boolean;
  size: number;
  modified: number;
  extension: string;
  permissions: string;
  owner: string;
  group: string;
  /** Full path, set for virtual listings (e.g. search results spanning directories). */
  path?: string;
  // web-only optional stat fields (desktop omits them; keep optional so both conform):
  created?: number;
  accessed?: number;
  changed?: number;
  link_target?: string;
  compressed_size?: number;
}

export interface PathInfo {
  exists: boolean;
  is_dir: boolean;
  canonical: string;
}

export interface DriveInfo {
  path: string;
  name: string;
  drive_type: string;
  total_space: number;
  available_space: number;
}

export interface ComparisonResult {
  only_in_left: string[];
  only_in_right: string[];
  different: string[];
  identical: string[];
}

// ===== P1.1 — operation specification and structured outcome =====
//
// Mirror of apps/desktop/src-tauri/src/engine/{spec,outcome}.rs, which is the
// source of truth. The Rust side has tests asserting these exact wire spellings
// (snake_case variants, `state` as the CommitOutcome discriminant).
//
// Everything here is OPTIONAL on the wire. Nothing produces a CommitOutcome yet
// — P1.4 onwards do — and the web shell's Express backend has its own,
// unrelated implementation (QSF-026), so requiring these fields would break it
// for no gain. The UI must feature-detect, exactly as it does for any other
// capability, and must not grow an `if (isDesktop)` branch to tell the two
// backends apart.

export type OperationKind =
  | "copy"
  | "move"
  | "rename"
  | "delete"
  | "write"
  | "create_archive"
  | "extract_archive";

export type ConflictPolicy = "ask" | "skip" | "replace" | "keep_both" | "merge";

/** `follow` carries a depth bound; the other two are bare. */
export type SymlinkPolicy = "preserve" | "reject" | { follow: { max_depth: number } };

/**
 * How far a write is pushed before the operation claims to have committed.
 * Only `sync_file` and above make a durability claim — a readback proves the
 * page cache agrees, not that the data reached the platter. UI copy must not
 * imply otherwise.
 */
export type Durability = "none" | "flush_only" | "sync_file" | "sync_file_and_directory";

export interface MetadataPolicy {
  timestamps: boolean;
  permissions: boolean;
  ownership: boolean;
  extended_attributes: boolean;
  preserve_sparse: boolean;
  on_unsupported: "warn_and_continue" | "fail";
}

export interface VerificationPolicy {
  byte_count: boolean;
  digest: boolean;
  durability: Durability;
}

/** What the user asked for. Immutable once created; per-item decisions live in the plan. */
export interface OperationSpec {
  sources: string[];
  destination: string | null;
  kind: OperationKind;
  conflict: ConflictPolicy;
  symlinks: SymlinkPolicy;
  metadata: MetadataPolicy;
  verification: VerificationPolicy;
  policy_version: number;
}

export interface JournalEntry {
  path: string;
  reason: string;
}

/** Durable record of a partially committed recursive operation. */
export interface Journal {
  committed: string[];
  skipped: JournalEntry[];
  failed: JournalEntry[];
  remaining: string[];
  orphaned_staging: string[];
}

/**
 * What actually happened. Discriminated on `state`.
 *
 * `partially_committed` and `copied_source_retained` are **not** success:
 * a directory tree cannot be committed atomically, so an interrupted tree
 * operation has to be able to say so rather than implying it finished.
 */
export type CommitOutcome =
  | { state: "committed" }
  | { state: "skipped"; reason: string }
  | { state: "cancelled_before_commit" }
  | { state: "rolled_back"; reason: string }
  | { state: "copied_source_retained"; source: string; reason: string }
  | { state: "partially_committed"; journal: Journal }
  | { state: "manual_recovery_required"; detail: string; paths: string[] };

/** Every outcome except these two must reach the user, not just the console. */
export function outcomeNeedsAttention(outcome: CommitOutcome): boolean {
  return outcome.state !== "committed" && outcome.state !== "skipped";
}

export interface OpResult {
  success: boolean;
  message: string;
  /**
   * Structured result (P1.1). Absent until the operation runs through the
   * engine; `success`/`message` remain the fallback for every path that has not
   * been migrated yet. When present it is authoritative — `success: false` with
   * `state: "rolled_back"` says something quite different from `success: false`
   * with `state: "manual_recovery_required"`.
   */
  outcome?: CommitOutcome;
}

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

/**
 * Why a task failed. Both backends classify their own errors (Rust from
 * `io::ErrorKind`, Express from Node's errno code) so the UI can explain the
 * failure instead of printing the raw message. `source_retained` is desktop-only:
 * a move that copied the data but could not remove the original.
 */
export type TaskErrorKind =
  | "permission_denied"
  | "not_found"
  | "no_space"
  | "read_only"
  | "busy"
  | "source_retained"
  | "other";

/** Task queue item. Superset: fields unique to one shell are optional. */
export interface TaskInfo {
  id: string;
  task_type: "Copy" | "Move" | "Delete";
  status:
    | "Queued"
    | "Running"
    | "Paused"
    | "Completed"
    | "Failed"
    | "Cancelled"
    | "WaitingForInput";
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
  error: string | null;
  /** Absent from a backend that predates the classification: treat as "other". */
  error_kind?: TaskErrorKind | null;
  /** What the failure is about — for a refused delete, the directory blocking it. */
  error_path?: string | null;
  // desktop-only:
  conflict_is_dir?: boolean;
  current_file_bytes?: number;
  // web-only per-file progress fields:
  current_file_total_bytes?: number;
  current_file_transferred_bytes?: number;
  current_file_source?: string;
  current_file_target?: string;
}

export interface Bookmark {
  name: string;
  path: string;
}

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

export interface AppInfo {
  name: string;
  desktop_entry: string;
  icon: string | null;
  is_default: boolean;
}

export interface DirSizeResult {
  path: string;
  size?: number;
  error?: string;
}

export interface UsersGroups {
  users: string[];
  groups: string[];
  currentUser?: string;
  currentGroup?: string;
}

export interface HelpTopic {
  id: string;
  label: string;
  labelKey?: string;
  file?: string;
  children?: HelpTopic[];
}

export interface HealthInfo {
  status: string;
  version: string;
}

export interface LanguageInfo {
  code: string;
  name: string;
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

/** Options accepted by `archivePack` (desktop only; web ignores). */
export interface ArchivePackOptions {
  format?: string;
  compression_level?: number;
  solid_archive?: boolean;
  follow_links?: boolean;
}

export interface ArchiveFormatCapability {
  format: string;
  canPack: boolean;
  canUnpack: boolean;
  canRead: boolean;
  minCompressionLevel: number;
  maxCompressionLevel: number;
  defaultCompressionLevel: number;
}

/**
 * What extraction does when an entry's name is already taken in the destination
 * (P2.3). Both backends default to `skip` when this is omitted: extraction is
 * the one mutation whose colliding names are chosen by the archive rather than
 * by the user, so replacing has to be asked for.
 */
export type ExtractConflict = "skip" | "replace" | "keep_both";

/**
 * What an extraction actually did.
 *
 * `archiveUnpack` used to resolve to `void`, which made "extracted all 400
 * entries" and "extracted nothing, every name was taken" the same value. Both
 * are legitimate outcomes of a safe extraction and only one is what the user
 * asked for, so the caller has to be able to tell them apart — the same reason
 * an `OpResult` may not be discarded.
 *
 * Counts are exact; the `_sample` arrays are capped at 100 entries so a large
 * archive extracted over a populated directory cannot hand the webview one array
 * element per entry.
 */
export interface UnpackReport {
  /** Entries published under the name the archive asked for. */
  promoted: number;
  /** Entries that replaced an existing file (`replace` only). */
  replaced: number;
  /** Entries left alone because something was already there (`skip` only). */
  skipped_count: number;
  /** Entries published under a different name (`keep_both` only). */
  kept_both_count: number;
  /** Destination-relative paths that were skipped, capped. */
  skipped_sample: string[];
  /** Destination-relative paths as actually published, capped. */
  kept_both_sample: string[];
}

// ===== The contract =====

export interface NexusIpc {
  // --- Read operations (both) ---
  readDirectory(path: string): Promise<FileEntry[]>;
  getHomeDir(): Promise<string>;
  getParentDir(path: string): Promise<string>;
  getPathInfo(path: string): Promise<PathInfo>;
  /** Desktop: `getDrives`; web aliases its `fetchDrives` to this name. */
  getDrives(): Promise<DriveInfo[]>;
  compareDirectories(leftPath: string, rightPath: string): Promise<ComparisonResult>;

  // --- CRUD (both) ---
  createDirectory(path: string): Promise<OpResult>;
  /** `mode` is desktop-only (trash vs permanent); web ignores it. */
  deleteEntry(path: string, recursive?: boolean, mode?: string): Promise<OpResult>;
  deleteEntries(paths: string[], recursive?: boolean, mode?: string): Promise<OpResult[]>;
  renameEntry(from: string, to: string): Promise<OpResult>;
  batchRename(renames: [string, string][]): Promise<OpResult[]>;
  copyFile(src: string, dst: string): Promise<OpResult>;
  copyEntries(sources: string[], targetDir: string): Promise<OpResult[]>;
  moveEntries(sources: string[], targetDir: string): Promise<OpResult[]>;
  /** `signal` is web-only (abortable HTTP); desktop ignores it. */
  calculateDirSize(path: string, signal?: AbortSignal): Promise<number>;
  /** Return type differs: desktop `void`, web `OpResult`. */
  saveTextFile(path: string, text: string): Promise<void | OpResult>;

  // --- Archive (both) ---
  isArchive(path: string): Promise<boolean>;
  readArchive(path: string): Promise<FileEntry[]>;
  /** `options` is desktop-only. */
  archivePack(sources: string[], destPath: string, options?: ArchivePackOptions): Promise<void>;
  /**
   * `entries` is a desktop-only selective-extraction filter; web extracts the
   * whole archive and ignores it. `conflict` defaults to `"skip"` on both.
   */
  archiveUnpack(
    srcPath: string,
    destDir: string,
    entries?: string[],
    conflict?: ExtractConflict
  ): Promise<UnpackReport>;
  getArchiveCapabilities?(): Promise<ArchiveFormatCapability[]>;

  // --- Viewer (both) ---
  readFileForViewer(path: string, encoding?: string): Promise<ViewerContent>;

  // --- Task queue (both) ---
  taskCreate(taskType: string, sources: string[], target: string): Promise<string>;
  taskExecute(taskId: string): Promise<TaskInfo>;
  taskGet(taskId: string): Promise<TaskInfo | null>;
  taskList(): Promise<TaskInfo[]>;
  taskCancel(taskId: string): Promise<boolean>;
  /**
   * Drop finished tasks. Failed ones are kept unless `includeFailed`: the
   * automatic sweep must not discard an error nobody has read yet, but the
   * user's own "Clear finished" has to be able to dismiss it.
   */
  taskClearFinished(includeFailed?: boolean): Promise<void>;
  resolveTaskConflict(taskId: string, resolution: string): Promise<boolean>;

  // --- Bookmarks (both) ---
  getBookmarks(): Promise<Bookmark[]>;
  saveBookmarks(bookmarks: Bookmark[]): Promise<void>;
  addBookmark(bookmark: Bookmark): Promise<void>;
  removeBookmark(path: string): Promise<void>;

  // --- Search (both; return type differs: desktop jobId string, web result array) ---
  searchFiles(params: SearchParams): Promise<string | SearchResult[]>;

  // --- System / open (both) ---
  openTerminal(path: string): Promise<void>;
  openFile(path: string): Promise<void>;
  getOpenWithApps(path: string): Promise<AppInfo[]>;
  openFileWithApp(path: string, desktopEntry: string): Promise<void>;
  setDefaultApp(path: string, desktopEntry: string): Promise<void>;
  mapNetworkDrive(path: string, letter: string, persistent: boolean): Promise<void>;
  disconnectNetworkDrive(pathOrLetter: string): Promise<void>;
  loadLanguageFile(lang: string): Promise<Record<string, any>>;

  // --- Settings (both; config schema is app-specific → intentionally loose) ---
  loadSettings(): Promise<any>;
  saveSettings(config: any): Promise<void>;

  // ===== Optional — desktop-only capabilities =====
  sortDrives?(drives: DriveInfo[]): DriveInfo[];
  archiveCancelPack?(): Promise<void>;
  searchCancel?(jobId: string): Promise<void>;
  /**
   * Streaming search (desktop). When `searchFiles` resolves to a jobId string, the
   * UI subscribes to incremental results + a completion signal through this and gets
   * back an unlisten function. Web adapters that resolve `searchFiles` to a full
   * result array omit this.
   */
  searchListen?(
    jobId: string,
    onResult: (result: SearchResult) => void,
    onDone: () => void,
  ): Promise<() => void>;
  openInEditor?(path: string): Promise<void>;
  editConfigFile?(): Promise<void>;
  getHelpTopics?(): Promise<HelpTopic[]>;
  getHelpContent?(file: string, lang?: string): Promise<string>;
  exitApp?(): Promise<void>;
  restartAsRoot?(): Promise<void>;
  isRunningAsRoot?(): Promise<boolean>;
  /** Web's task queue has no pause/resume; the UI hides those controls without it. */
  taskPause?(taskId: string): Promise<boolean>;
  taskResume?(taskId: string): Promise<boolean>;

  // ===== Optional — web-only capabilities =====
  //
  // QSF-008: `archive_test`, `split_file` and `combine_files` are now implemented
  // in both web and desktop backends. `check_is_binary` and `get_os` remain web-only
  // for now; call sites must feature-detect with `hasCapability(...)` where optional.
  archiveTest?(path: string): Promise<boolean>;
  splitFile?(path: string, chunkSize: number, destDir: string): Promise<OpResult>;
  combineFiles?(sources: string[], destPath: string): Promise<OpResult>;
  checkIsBinary?(path: string): Promise<boolean>;
  getOS?(): Promise<string>;

  getHealth?(): Promise<HealthInfo>;
  getParentInfo?(path: string): Promise<FileEntry>;
  calculateDirSizes?(paths: string[], signal?: AbortSignal): Promise<DirSizeResult[]>;
  resolveOpenAction?(path: string, intent?: "open" | "view" | "edit"): Promise<ResolvedOpenAction>;
  executeCommand?(command: string, currentDir: string): Promise<string>;
  getSystemCapabilities?(): Promise<SystemCapabilities>;
  openConfigDir?(): Promise<void>;
  listLanguages?(): Promise<LanguageInfo[]>;
  convertPreview?(path: string): Promise<PreviewConversionStatus>;
  remuxPreview?(path: string): Promise<PreviewConversionStatus>;
  openOnThisComputer?(path: string): void;
  convertFileSrc?(filePath: string): string;
  listenToTaskProgress?(taskId: string, onProgress: (data: any) => void): () => void;

  // ===== Optional — file properties / permissions =====
  // web has these today; desktop gains set_permissions/chown in Fase 4.
  getUsersGroups?(): Promise<UsersGroups>;
  /**
   * Desktop reports a refused chmod/chown as `OpResult { success: false }`, not
   * as a rejected promise, so `message` is part of the contract: a caller that
   * only awaits this call cannot tell success from failure without reading
   * `success`, and FilePropertiesDialog used to close on both.
   */
  setFileProperties?(
    path: string,
    params: { permissions?: string; owner?: string; group?: string }
  ): Promise<{ success: boolean; message?: string }>;
  /** Actual on-disk allocation (blocks×512). Desktop: get_size_on_disk command. */
  getSizeOnDisk?(path: string): Promise<number>;
  getSystemUser?(): Promise<{ username: string }>;
  elevateOperation?(params: {
    action: string;
    path: string;
    target?: string;
    password?: string;
    permissions?: string;
    owner?: string;
    group?: string;
  }): Promise<{ success: boolean }>;
  /** Fase 4 desktop additions (Tauri chmod/chown). */
  setPermissions?(path: string, mode: string): Promise<OpResult>;
  chown?(path: string, uid: number, gid: number): Promise<OpResult>;
}
