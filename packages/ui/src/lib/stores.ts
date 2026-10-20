import { writable, type Writable } from "svelte/store";
import type { ActivePanel, ContextMenuState, DialogState, DropMenuState, MenuItem } from "./types";
import { getIpc } from "./ipc-registry";

/**
 * Shared UI-state Svelte stores (@nexus/ui). These MUST be single instances so the
 * app shell and shared components read/write the same state — hence they live here
 * and both apps bridge to them.
 *
 * The application-configuration store (`appConfigStore`) stays app-local and strongly
 * typed, because the AppConfig schema diverges per shell (see migration Fase 3c /
 * Fase 4). The *persist mechanism* doesn't care about that shape, so it's shared via
 * `createSettingsUpdater` below — each app's stores.ts builds its own `appConfigStore`
 * and derives `updateSettings` from it.
 */

/**
 * Builds an `updateSettings(updater)` function bound to an app-local config store:
 * applies `updater` to a shallow copy, writes it back to the store, then persists via
 * `getIpc().saveSettings()` — debounced when `debounceMs` is set (desktop coalesces
 * rapid successive edits before hitting disk), immediate otherwise (web's prior
 * `persistSettings()` behavior). One timer per call to this factory, so each app's
 * store gets its own independent debounce.
 */
export function createSettingsUpdater<T>(store: Writable<T | null>, debounceMs = 0) {
  let saveTimeout: ReturnType<typeof setTimeout> | undefined;

  return function updateSettings(updater: (config: T) => void) {
    store.update((current) => {
      if (!current) return current;

      const next = { ...current };
      updater(next);

      const persist = async () => {
        try {
          await getIpc().saveSettings(next);
        } catch (e) {
          console.error("Failed to save settings:", e);
        }
      };

      if (debounceMs > 0) {
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(persist, debounceMs);
      } else {
        void persist();
      }

      return next;
    });
  };
}

/** Which panel is currently active (focused). */
export const activePanel = writable<ActivePanel>("left");

/** Read the active side without holding a subscription. */
export function getActiveSide(): ActivePanel {
  let side: ActivePanel = "left";
  const unsub = activePanel.subscribe((v) => (side = v));
  unsub();
  return side;
}

/**
 * Pick whichever of two per-panel values belongs to the active panel. Both
 * app shells route a long list of menu actions to "the focused panel", and
 * writing that out by hand each time is where the two drifted.
 */
export function activeOf<T>(left: T, right: T): T {
  return getActiveSide() === "left" ? left : right;
}

/**
 * Menu actions that are nothing more than a method call on the active file
 * panel, mapped to the method to call. Shared so both shells route the same
 * set — desktop used to handle these inside FileList, where both panels
 * listened and every action fired twice.
 */
export const PANEL_ACTIONS: Record<string, string> = {
  "select-all": "selectAll",
  "unselect-all": "unselectAll",
  "select-all-files": "selectAllFiles",
  "unselect-all-files": "unselectAllFiles",
  "select-same-ext": "selectSameExtension",
  "unselect-same-ext": "unselectSameExtension",
  "invert-selection": "invertSelection",
  "select-group": "handleSelectGroup",
  "unselect-group": "handleUnselectGroup",
  "save-selection": "handleSaveSelection",
  "restore-selection": "handleRestoreSelection",
  "test-archive": "handleTestArchive",
  "split": "handleSplitFile",
  "combine": "handleCombineFiles",
  "pack": "handlePack",
  "unpack": "handleUnpack",
  "download-selection": "handleDownload",
};

/**
 * Run `action` against the active panel if it is one of PANEL_ACTIONS.
 * Returns whether it was handled, so a shell's dispatcher can fall through.
 */
export function runPanelAction(action: string, left: any, right: any): boolean {
  const method = PANEL_ACTIONS[action];
  if (!method) return false;
  activeOf(left, right)?.[method]?.();
  return true;
}

/** Track the current path for each panel so operations can reference the opposite panel. */
export const leftPanelPath = writable<string>("");
export const rightPanelPath = writable<string>("");

/** Current path of the active panel, read without holding a subscription. */
export function getActivePanelPath(): string {
  let path = "";
  const store = getActiveSide() === "left" ? leftPanelPath : rightPanelPath;
  const unsub = store.subscribe((v) => (path = v));
  unsub();
  return path;
}


/** Dialog state for modal operations. */
export const dialogState = writable<DialogState>({
  type: null,
  inputValue: "",
  entries: [],
  sourcePaths: [],
  targetDir: "",
  sourceDir: "",
});

/** Track if any modal/overlay is open globally. */
export const isOverlayActive = writable<boolean>(false);

/**
 * Whether TaskProgress's conflict dialog is up.
 *
 * It is a modal that appears without either shell opening it — a running task
 * hits a name collision and the dialog polls itself into existence — so
 * neither shell's `anyOverlayOpen` knew about it, and FileList went on
 * answering arrow keys, Tab and F-keys behind it. TaskProgress publishes it
 * here; each shell folds it into its own overlay expression rather than
 * writing `isOverlayActive` directly, so there is still exactly one writer of
 * that store per shell.
 */
export const taskConflictActive = writable<boolean>(false);

/** Drop menu state for drag & drop. */
export const dropMenuState = writable<DropMenuState>({
  visible: false,
  x: 0,
  y: 0,
  files: [],
  isExternal: false,
  targetDir: "",
  side: "left",
  forceCopy: false,
});

/** Open the drop menu. */
export function openDropMenu(state: Partial<DropMenuState> & { files: string[]; targetDir: string; side: "left" | "right" }) {
  dropMenuState.set({
    visible: true,
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
    isExternal: false,
    forceCopy: false,
    ...state,
  });
}

/** Close the drop menu. */
export function closeDropMenu() {
  dropMenuState.update((s) => ({ ...s, visible: false }));
}

/** Open a dialog. */
export function openDialog(state: Partial<DialogState> & { type: DialogState["type"] }) {
  dialogState.set({
    inputValue: "",
    entries: [],
    sourcePaths: [],
    targetDir: "",
    sourceDir: "",
    isPermanent: false,
    ...state,
  });
}

/** Close the dialog. */
export function closeDialog() {
  dialogState.set({
    type: null,
    inputValue: "",
    entries: [],
    sourcePaths: [],
    targetDir: "",
    sourceDir: "",
    isPermanent: false,
  });
}

/**
 * A session-only plan for file operations. This is deliberately separate from
 * the backend task queue: no filesystem mutation happens until a shell turns
 * a queued operation into a task.
 */
export type QueuedOperation =
  | {
      id: string;
      kind: "copy" | "move";
      sources: string[];
      target: string;
    }
  | {
      id: string;
      kind: "delete";
      sources: string[];
      target: "trash" | "permanent";
    };

export const transferQueue = writable<QueuedOperation[]>([]);
export const transferQueueOpen = writable(false);
export const transferQueueRunningId = writable<string | null>(null);

function queueId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `queue-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function addQueuedOperation(operation: Omit<QueuedOperation, "id">): string {
  const id = queueId();
  // Clone sources so a later caller-side selection change cannot alter a plan.
  transferQueue.update((operations) => [...operations, { ...operation, id, sources: [...operation.sources] } as QueuedOperation]);
  return id;
}

export function removeQueuedOperation(id: string) {
  transferQueue.update((operations) => operations.filter((operation) => operation.id !== id));
}

export function updateQueuedOperationTarget(id: string, target: string) {
  transferQueue.update((operations) => operations.map((operation) => {
    if (operation.id !== id || operation.kind === "delete") return operation;
    return { ...operation, target };
  }));
}

export function moveQueuedOperation(id: string, direction: -1 | 1) {
  transferQueue.update((operations) => {
    const from = operations.findIndex((operation) => operation.id === id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= operations.length) return operations;
    const next = [...operations];
    [next[from], next[to]] = [next[to], next[from]];
    return next;
  });
}

export function clearTransferQueue() {
  transferQueue.set([]);
}

/** Get the opposite panel's path. */
export function getOppositePanel(current: ActivePanel): ActivePanel {
  return current === "left" ? "right" : "left";
}

/** Clipboard state for Cut/Copy/Paste operations. */
export interface ClipboardState {
  paths: string[];
  operation: "cut" | "copy" | null;
  sourceDir: string;
}

export const clipboardStore = writable<ClipboardState>({
  paths: [],
  operation: null,
  sourceDir: "",
});

export function clearClipboard() {
  clipboardStore.set({ paths: [], operation: null, sourceDir: "" });
}

/** Global context menu state. */
export const globalContextMenuStore = writable<ContextMenuState>({
  visible: false,
  x: 0,
  y: 0,
  options: [],
});

/** Open global context menu. */
export function openContextMenu(x: number, y: number, options: MenuItem[]) {
  globalContextMenuStore.set({ visible: true, x, y, options });
}

/** Close global context menu. */
export function closeContextMenu() {
  globalContextMenuStore.update((s) => ({ ...s, visible: false }));
}
