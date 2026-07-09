import type { ActivePanel, ContextMenuState, DialogState, DropMenuState, MenuItem, AppConfig } from "./types";
import { writable, get } from "svelte/store";

/** Global application configuration. */
export const appConfigStore = writable<AppConfig | null>(null);

/** Signal to the main shell to save the current appConfigStore. */
export function persistSettings() {
  const config = get(appConfigStore);
  if (config) {
    window.dispatchEvent(new CustomEvent("nc:save-settings", { detail: config }));
  }
}

/** Which panel is currently active (focused). */
export const activePanel = writable<ActivePanel>("left");

/** Track the current path for each panel so operations can reference the opposite panel. */
export const leftPanelPath = writable<string>("");
export const rightPanelPath = writable<string>("");

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
export function openDropMenu(state: Partial<DropMenuState> & { files: string[], targetDir: string, side: "left" | "right" }) {
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
  dropMenuState.update(s => ({ ...s, visible: false }));
}

/** Open a dialog. */
export function openDialog(state: Partial<DialogState> & { type: DialogState["type"] }) {
  dialogState.set({
    inputValue: "",
    entries: [],
    sourcePaths: [],
    targetDir: "",
    sourceDir: "",
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
  });
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
  globalContextMenuStore.update(s => ({ ...s, visible: false }));
}

export interface ElevatedAction {
  type: string;
  value: string;
  paths: string[];
  sourceDir: string;
  owner?: string;
  group?: string;
  permissions?: string;
}

export const pendingElevatedAction = writable<ElevatedAction | null>(null);



