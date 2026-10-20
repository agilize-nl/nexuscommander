/**
 * Shared UI-state types (@nexus/ui). The transport/value types (FileEntry, PathInfo,
 * DriveInfo, ComparisonResult, OpResult) live in ipc-contract and are re-exported here.
 *
 * App-specific DTOs stay in each app's own types.ts / ipc.ts:
 *   - AppConfig, FileOpOptions, ColumnConfig, TabConfig (config schema diverges per shell)
 *   - web-only: ConflictPolicy, SystemCapabilities, ResolvedOpenAction, PreviewConversionStatus
 */
export type {
  FileEntry,
  PathInfo,
  DriveInfo,
  ComparisonResult,
  OpResult,
} from "./ipc-contract";

import type { FileEntry } from "./ipc-contract";

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

/**
 * Persisted layout state for TwinPanels. The two apps' AppConfig schemas use
 * different key names for this same state, so TwinPanels itself never reads/writes
 * appConfigStore — the shell translates to/from this shape via the `layout` prop
 * and the `onpersistlayout` callback.
 */
export type TwinPanelsLayout = {
  leftMode: "list" | "tree" | "quickview";
  rightMode: "list" | "tree" | "quickview";
  isVertical: boolean;
  singleView: boolean;
  panelRatio: number;
};

/**
 * Types of dialogs that can be shown. Superset of both shells:
 * desktop adds "confirm"; web adds "permission_denied" | "sudo_password".
 */
export type DialogType =
  | "mkdir"
  | "rename"
  | "delete"
  | "copy"
  | "move"
  | "pack"
  | "unpack"
  | "split"
  | "combine"
  | "select_group"
  | "unselect_group"
  | "properties"
  | "confirm"
  | "confirm_download"
  | "error"
  | "permission_denied"
  | "sudo_password"
  | null;

/** Dialog state. `isPermanent` is desktop-only (Shift+Del) and optional. */
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
  /** Whether the user requested a permanent delete (via Shift+Del) */
  isPermanent?: boolean;
}

/** MenuItem for ContextMenu */
export type MenuItem =
  | {
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
    }
  | {
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

/**
 * A request from a file panel to open something. The shells decide what each
 * intent means: desktop opens its viewer/editor windows or hands "open" to
 * the OS, web routes all three through HeadlessFileModal.
 */
export interface OpenRequest {
  path: string;
  intent: "open" | "view" | "edit";
  siblingPaths?: string[];
}
