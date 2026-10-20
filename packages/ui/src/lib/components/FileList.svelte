<script lang="ts">
  import { shellShortcut } from "../shortcuts";
  import { onMount, tick } from "svelte";
  import { fade } from "svelte/transition";
  import { _ } from "../i18n";
  import {
    readDirectory,
    getHomeDir,
    getParentDir,
    getPathInfo,
    getDrives,
    createDirectory,
    deleteEntries,
    renameEntry,
    calculateDirSize,
    calculateDirSizes,
    isArchive,
    readArchive,
    archiveTest,
    hasCapability,
    openTerminal,
    openFile,
    openInEditor,
    getSystemCapabilities,
    openOnThisComputer,
    getOpenWithApps,
    openFileWithApp,
    setDefaultApp,
    loadSettings,
    saveSettings,
    getHomeDir as getHomeFromIpc,
    getParentInfo,
    type AppConfig,
    type AppInfo,
    type ColumnConfig
  } from "../ipc";
  import ContextMenu from "./ContextMenu.svelte";
  import DriveBar from "./DriveBar.svelte";
  import FolderTabs, { type Tab } from "./FolderTabs.svelte";
  import { formatSize, formatDate, formatPermissions, getFileColor } from "../utils";
  import { isCoarsePointer } from "../utils/touch";
  import { getFileIconPath, getLucideIconName } from "../iconMap";
  import type { DriveInfo, FileEntry, SortColumn, MenuItem, OpResult } from "../types";
  import {
    clipboardStore,
    type ClipboardState,
    activePanel,
    leftPanelPath,
    rightPanelPath,
    openDialog,
    closeDialog,
    dialogState,
    isOverlayActive,
    openDropMenu,
    closeDropMenu,
    clearClipboard,
    openContextMenu,
  } from "../stores";

  import type { OpenRequest } from "../types";

  interface Props {
    side: "left" | "right";
    onselectionchange?: (path: string | null) => void;
    onopenrequest?: (request: OpenRequest) => void;
    initialPath?: string;
    /** The shell's config store; its schema is app-local. */
    appConfigStore: any;
    /** The shell's `updateSettings(mutator)`, built on createSettingsUpdater. */
    updateSettings: (mutator: (cfg: any) => void) => void;
    /**
     * Renders a file/folder icon. Injected so desktop can supply its
     * icon-theme renderer (DynamicIcon, which pulls in @iconify) without
     * forcing those packs into web's bundle; falling back to the built-in
     * lucide/iconMap rendering when absent.
     */
    iconRenderer?: any;
    /**
     * Called when files are dropped from outside the app. Web parks the
     * traversal result for its uploader; desktop receives OS paths from
     * Tauri and has nothing to stage.
     */
    onexternaldrop?: (result: any) => void;
    showUpload?: boolean;
    /** Browser file/folder download of the selection (web only). */
    showDownload?: boolean;
    /**
     * Called with the current selection (or cursor item) when the user
     * triggers Download. Kept shell-neutral: FileList never imports
     * `apps/web/src/lib/download/*` directly — the web callback decides
     * single-file vs. zip-bundle (browser-download plan §4.3).
     */
    onDownload?: (request: { dir: string; entries: FileEntry[] }) => void;
    /**
     * Paste (Ctrl+V). The shell runs it the way it runs a drop — through its
     * task queue, whose conflict dialog asks before an existing file is
     * replaced. Rejects when the transfer could not be started.
     */
    onpaste?: (request: { operation: "copy" | "move"; sources: string[]; targetDir: string }) => Promise<void>;
  }
  let {
    side,
    onselectionchange,
    onopenrequest,
    initialPath,
    appConfigStore,
    updateSettings,
    iconRenderer: IconRenderer = undefined,
    onexternaldrop,
    showUpload = false,
    showDownload = false,
    onDownload,
    onpaste,
  }: Props = $props();

  function wildcardToRegex(pattern: string): RegExp {
    const subPatterns = pattern
      .split(/[;,]/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (subPatterns.length === 0) return /^.*$/i;

    const regexParts = subPatterns.map((p) => {
      const escaped = p
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
      return `(?:^${escaped}$)`;
    });

    return new RegExp(regexParts.join("|"), "i");
  }

  // ---------- State ----------
  let currentPath = $state("");
  let pathEditActive = $state(false);
  let pathEditValue = $state("");
  let pathInputEl: HTMLInputElement | undefined = $state(undefined);
  let pathEditTimer: ReturnType<typeof setTimeout> | null = null;
  let panelEl: HTMLDivElement | undefined = $state(undefined);
  let isSearchResultsView = $state(false);
  let entries: FileEntry[] = $state([]);
  let selectedIndex = $state(0);
  let selectionAnchor = $state(0);
  let selectedEntries = $state(new Set<string>()); // Names of entries marked/selected
  let lastTouchFocusIndex: number | null = $state(null);

  /**
   * Performs an incremental update on currentEntries using freshEntries.
   * Preserves object references for unchanged files to optimize reactivity and DOM updates.
   */
  function reconcileEntries(currentEntries: FileEntry[], freshEntries: FileEntry[]): FileEntry[] {
    const freshMap = new Map(freshEntries.map((e) => [e.name, e]));
    const updatedList: FileEntry[] = [];

    for (const existing of currentEntries) {
      const fresh = freshMap.get(existing.name);
      if (fresh) {
        if (
          existing.size !== fresh.size ||
          existing.modified !== fresh.modified ||
          existing.permissions !== fresh.permissions ||
          existing.is_dir !== fresh.is_dir ||
          existing.is_symlink !== fresh.is_symlink ||
          existing.extension !== fresh.extension ||
          existing.owner !== fresh.owner ||
          existing.group !== fresh.group
        ) {
          existing.size = fresh.size;
          existing.modified = fresh.modified;
          existing.permissions = fresh.permissions;
          existing.is_dir = fresh.is_dir;
          existing.is_symlink = fresh.is_symlink;
          existing.extension = fresh.extension;
          existing.owner = fresh.owner;
          existing.group = fresh.group;
        }
        updatedList.push(existing);
        freshMap.delete(existing.name);
      }
    }

    for (const newEntry of freshMap.values()) {
      updatedList.push(newEntry);
    }

    return updatedList;
  }

  let savedSelection = $state<string[]>([]); // Saved filenames
  let sortColumn: SortColumn = $state("name");
  let sortAsc = $state(true);
  let loading = $state(false);
  let error: string | null = $state(null);
  let isActive = $state(false);
  let overlayActive = $state(false);
  let driveFreeSpace = $state("");
  let isInArchive = $state(false);
  isOverlayActive.subscribe(v => overlayActive = v);
  let history = $state<string[]>([]);
  let historyIndex = $state(0);
  
  // Size calculation tracking
  let calculatingDirs = $state(new Set<string>()); // Set of entry names
  let calculatedDirs = $state(new Set<string>());  // Set of entry names
  let dirSizes = $state<Record<string, number>>({});
  let isMassCalculating = false;
  // In-flight dir-size requests, aborted when navigating away so the server
  // stops working on a size calc nobody is looking at anymore.
  const dirSizeControllers = new Set<AbortController>();
  function abortDirSizeCalcs() {
    for (const c of dirSizeControllers) c.abort();
    dirSizeControllers.clear();
  }

  function cancelDirSizeCalcs() {
    abortDirSizeCalcs();
    calculatingDirs = new Set();
    isMassCalculating = false;
  }

  // Clipboard state (reactive)
  let clipState = $state<ClipboardState>({ paths: [], operation: null, sourceDir: "" });
  clipboardStore.subscribe(v => clipState = v);


  // Settings state
  // Settings state handled by $appConfigStore
  const selectionMode = $derived($appConfigStore?.behavior_selection_mode || "NC");
  // Desktop's AppConfig uses unprefixed show_parent_dir_row/show_folders_with_brackets;
  // web's uses layout_show_parent_dir_row/layout_show_folder_brackets (config schema is
  // app-local, see CLAUDE.md). Check both so the setting actually takes effect on both
  // shells rather than silently no-op'ing on whichever one didn't write this key.
  const showParentDirRow = $derived(
    ($appConfigStore?.layout_show_parent_dir_row ?? $appConfigStore?.show_parent_dir_row) !== false
  );
  const showFolderBrackets = $derived(
    ($appConfigStore?.layout_show_folder_brackets ?? $appConfigStore?.show_folders_with_brackets) !== false
  );
  const showFileSizesInBytes = $derived($appConfigStore?.show_file_sizes_in_bytes ?? false);
  const DEFAULT_COLUMNS: ColumnConfig[] = [
    { caption: "Name", width: 220, align: "<-", field_contents: "[NC().GETFILENAME{}]" },
    { caption: "Ext", width: 60, align: "<-", field_contents: "[NC().GETFILEEXT{}]" },
    { caption: "Size", width: 80, align: "->", field_contents: "[NC().GETFILESIZE{}]" },
    { caption: "Date", width: 130, align: "->", field_contents: "[NC().GETFILETIME{}]" },
  ];

  let savedColumns = $state<ColumnConfig[]>([]);
  let availableDrives = $state<DriveInfo[]>([]);

  // No more local settings state

  // Tab state
  let tabs = $state<Tab[]>([]);
  let activeTabId = $state("");
  let tabsLoaded = false;

  // Transient feedback toast for actions that would otherwise fail silently
  // (e.g. Pack/Unpack/Test Archive/Split with no valid selection).
  let actionToast = $state<{ok: boolean, msg: string} | null>(null);
  let actionToastTimer: ReturnType<typeof setTimeout> | null = null;

  export function showActionToast(ok: boolean, msg: string, durationMs = 4000) {
    if (actionToastTimer) clearTimeout(actionToastTimer);
    actionToast = { ok, msg };
    actionToastTimer = setTimeout(() => (actionToast = null), durationMs);
  }

  // Drag & Drop state
  let isDraggingOver = $state(false);
  let isMouseInPanel = false;

  function createTab(path: string): Tab {
    const id = Math.random().toString(36).substring(2, 9);
    const label = path === "/" ? "/" : path.split("/").pop() || "/";
    return { id, path, label };
  }

  function handleTabSelect(id: string) {
    const tab = tabs.find(t => t.id === id);
    if (tab) {
      activeTabId = id;
      currentPath = tab.path;
      loadDirectory(currentPath);
      persistTabs();
    }
  }

  function handleTabClose(id: string) {
    const tabToClose = tabs.find(t => t.id === id);
    if (tabToClose?.locked) return; // Cannot close locked tab

    if (tabs.length === 1) return;
    const index = tabs.findIndex(t => t.id === id);
    tabs = tabs.filter(t => t.id !== id);
    if (activeTabId === id) {
      const newActive = tabs[Math.max(0, index - 1)];
      handleTabSelect(newActive.id);
    }
    persistTabs();
  }

  function handleTabNew() {
    const newTab = createTab(currentPath);
    tabs = [...tabs, newTab];
    activeTabId = newTab.id;
    persistTabs();
  }

  function handleTabCloseCurrent() {
    if (!activeTabId) return;
    handleTabClose(activeTabId);
  }

  function getFullPath(entry: FileEntry) {
    if (entry.path) return entry.path;
    return currentPath === "/" ? `/${entry.name}` : `${currentPath}/${entry.name}`;
  }

  function getSiblingPaths() {
    if (isSearchResultsView) return [];
    return filteredEntries
      .filter((entry) => !entry.is_dir && entry.name !== "..")
      .map((entry) => getFullPath(entry));
  }

  function requestOpen(path: string, intent: "open" | "view" | "edit") {
    if (onopenrequest) {
      onopenrequest({ path, intent, siblingPaths: getSiblingPaths() });
      return true;
    }
    return false;
  }

  function handleTabReorder(from: number, to: number) {
    const newTabs = [...tabs];
    const item = newTabs.splice(from, 1)[0];
    newTabs.splice(to, 0, item);
    tabs = newTabs;
    persistTabs();
  }

  function handleTabDuplicate(id: string) {
    const tabIdx = tabs.findIndex(t => t.id === id);
    if (tabIdx > -1) {
      const tab = tabs[tabIdx];
      const newTab = createTab(tab.path);
      newTab.label = tab.label;
      newTab.customLabel = tab.customLabel;
      const newTabs = [...tabs];
      newTabs.splice(tabIdx + 1, 0, newTab);
      tabs = newTabs;
      persistTabs();
    }
  }

  function handleTabRename(id: string, newName: string) {
    tabs = tabs.map(t => t.id === id ? { ...t, customLabel: newName || undefined } : t);
    persistTabs();
  }

  function handleTabLock(id: string, locked: boolean) {
    tabs = tabs.map(t => t.id === id ? { ...t, locked } : t);
    persistTabs();
  }

  function handleTabCloseOthers(id: string) {
    tabs = tabs.filter(t => t.id === id || t.locked);
    if (!tabs.some(t => t.id === activeTabId)) {
      handleTabSelect(id);
    }
    persistTabs();
  }

  /** Persists the current tab state for this side to global settings. */
  async function persistTabs() {
    if (!$appConfigStore) return;
    const latestConfig = await loadSettings().catch(() => $appConfigStore);
    const nextConfig = JSON.parse(JSON.stringify(latestConfig || $appConfigStore));

    if (side === "left") {
      nextConfig.left_tabs = tabs.map(t => ({
        id: t.id,
        path: t.path,
        label: t.label,
        custom_label: t.customLabel || null,
        locked: t.locked || false
      }));
      nextConfig.left_active_tab = activeTabId;
    } else {
      nextConfig.right_tabs = tabs.map(t => ({
        id: t.id,
        path: t.path,
        label: t.label,
        custom_label: t.customLabel || null,
        locked: t.locked || false
      }));
      nextConfig.right_active_tab = activeTabId;
    }
    appConfigStore.set(nextConfig);
    await saveSettings(nextConfig);
  }

  // ---------- Drag & Drop Handlers ----------
  function handleDragStart(e: DragEvent, index: number) {
    handlePanelFocus();

    // If dragging a non-selected item, treat it as the only selection
    // But usually standard is to drag the whole selection if the item is part of it.
    let pathsToDrag: string[] = [];
    const entry = filteredEntries[index];
    if (!entry || entry.name === "..") { e.preventDefault(); return; }

    if (entry && selectedEntries.has(entry.name)) {
      pathsToDrag = entries
        .filter((e) => selectedEntries.has(e.name))
        .map((e) => getFullPath(e));
    } else if (entry) {
      pathsToDrag = [getFullPath(entry)];
    }

    if (e.dataTransfer) {
      e.dataTransfer.setData("application/x-nexus-commander-paths", JSON.stringify(pathsToDrag));
      e.dataTransfer.setData("application/x-nexus-commander-source", side);
      
      // Mitigation for missing GDK dnd cursors
      document.body.classList.add("dragging-copy");
      
      if (isInArchive) {
        e.dataTransfer.setData("application/x-nexus-commander-is-archive", "true");
      }

      e.dataTransfer.effectAllowed = "copyMove";

      // Visual feedback
      const dragIcon = document.createElement("div");
      dragIcon.style.padding = "4px 8px";
      dragIcon.style.background = "var(--color-nc-accent)";
      dragIcon.style.color = "white";
      dragIcon.style.borderRadius = "44px";
      dragIcon.style.fontSize = "12px";
      dragIcon.innerText = pathsToDrag.length > 1 ? $_("filelist.dragging_items", { n: pathsToDrag.length }) : entry.name;
      document.body.appendChild(dragIcon);
      e.dataTransfer.setDragImage(dragIcon, 0, 0);
      setTimeout(() => document.body.removeChild(dragIcon), 0);
    }
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer) {
      const isInternal = e.dataTransfer.types.includes("application/x-nexus-commander-paths");
      const isFiles = e.dataTransfer.types.includes("Files");
      if (isInternal || isFiles) {
        e.dataTransfer.dropEffect = "copy";
      } else {
        e.dataTransfer.dropEffect = "none";
      }
    }
  }

  function handleDragEnter(e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer) {
      const isInternal = e.dataTransfer.types.includes("application/x-nexus-commander-paths");
      const isFiles = e.dataTransfer.types.includes("Files");
      if (isInternal || isFiles) {
        isDraggingOver = true;
      }
    }
  }

  function handleDragLeave(e: DragEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (
      e.clientX < rect.left ||
      e.clientX >= rect.right ||
      e.clientY < rect.top ||
      e.clientY >= rect.bottom
    ) {
      isDraggingOver = false;
    }
  }

  async function handleDrop(e: DragEvent) {
    e.preventDefault();
    isDraggingOver = false;
    document.body.classList.remove("dragging-copy", "dragging-move", "dragging-none");

    if (!e.dataTransfer) return;

    const sourceSide = e.dataTransfer.getData("application/x-nexus-commander-source");
    const pathsData = e.dataTransfer.getData("application/x-nexus-commander-paths");

    if (sourceSide && sourceSide !== side && pathsData) {
      // Internal drop from other pane
      const files = JSON.parse(pathsData);
      const isFromArchive = e.dataTransfer.getData("application/x-nexus-commander-is-archive") === "true";
      
      openDropMenu({
        x: e.clientX,
        y: e.clientY,
        files,
        isExternal: false,
        targetDir: currentPath,
        side,
        forceCopy: isFromArchive // Custom flag for DropMenu
      });
    } else if (e.dataTransfer.types.includes("Files")) {
      // External drag & drop from the OS. What happens to the payload is
      // shell-specific — web walks the DataTransfer and stages an upload —
      // so the shell returns the names to show, or null to ignore the drop.
      if (!onexternaldrop) return;
      try {
        const names = await onexternaldrop(e.dataTransfer);
        if (!names || names.length === 0) return;

        openDropMenu({
          x: e.clientX,
          y: e.clientY,
          files: names,
          isExternal: true,
          targetDir: currentPath,
          side,
          forceCopy: true
        });
      } catch (err) {
        console.error("External drop failed:", err);
      }
    }
  }

  /**
   * Open the drop menu for files this panel did not receive through a DOM
   * drag event. Desktop calls this from its Tauri file-drop listener, which
   * hands over OS paths rather than a DataTransfer.
   */
  export function externalDropAt(files: string[], x: number, y: number) {
    if (files.length === 0) return;
    openDropMenu({
      x,
      y,
      files,
      isExternal: true,
      targetDir: currentPath,
      side,
    });
  }

  /** Whether the pointer is currently over this panel (drop targeting). */
  export function isPointerInside(): boolean {
    return isMouseInPanel;
  }

  // Tauri OS File Drop Listener

  onMount(() => {
    // Standard HTML5 File Drop is handled via handleDrop / handleDragOver in Template
    // The previous Tauri listeners were redundant or specialized for OS-level drops
    // In a PWA, we rely on the standard drag events already implemented.

    return () => {
      // Cleanup drag classes if the component unmounts during a drag
      document.body.classList.remove("dragging-copy", "dragging-move", "dragging-none");
    };
  });

  function updateActiveTabPath(path: string) {
    tabs = tabs.map(t => t.id === activeTabId && !t.locked ? { ...t, path, label: path === "/" ? "/" : path.split("/").pop() || "/" } : t);
  }

  function isGvfsRootPath(path: string) {
    return /^\/run\/user\/\d+\/gvfs\/?$/.test(path);
  }

  function getVisiblePath(path: string) {
    return isGvfsRootPath(path) ? "/" : path;
  }

  // ---------- // Context Menu logic is now global via stores.ts

  type ContextPointEvent = Pick<MouseEvent | PointerEvent, "clientX" | "clientY" | "preventDefault" | "stopPropagation">;

  async function showContextMenu(e: ContextPointEvent, index: number | null) {
    e.preventDefault();
    e.stopPropagation();
    
    handlePanelFocus();
    
    const { entries: opEntries, paths } = getOperationEntries();

    let menuOptions: MenuItem[] = [];

    if (index !== null) {
      selectedIndex = index;
      const entry = filteredEntries[index];

      // The parent-dir row is not a real entry: copy/move/delete/rename/properties
      // would all target ".." itself. Offer only what makes sense for it.
      if (entry.name === "..") {
        menuOptions = [
          { label: $_('common.open'), action: () => enterEntry(index), shortcut: "Ctrl+Alt+Enter", mnemonicIndex: 0 },
          { isSeparator: true },
          { label: $_('common.refresh'), action: refresh, shortcut: "Ctrl+R", mnemonicIndex: 0 }
        ];
        openContextMenu(e.clientX, e.clientY, menuOptions);
        return;
      }

      const is_arch = entry.name.toLowerCase().endsWith(".zip") || entry.name.toLowerCase().endsWith(".tar") || entry.name.toLowerCase().endsWith(".gz");

      // Build "Open with" submenu dynamically
      let openWithItems: MenuItem[] = [];
      const fullPath = getFullPath(entry);

      if (!entry.is_dir) {
        let systemApps: AppInfo[] = [];
        try {
          let desktopOpenAvailable = true;
          try {
            if (hasCapability("getSystemCapabilities")) {
              const caps = await getSystemCapabilities();
              desktopOpenAvailable = Boolean(caps?.desktopOpenAvailable);
            }
          } catch {
            desktopOpenAvailable = true;
          }

          if (desktopOpenAvailable && hasCapability("getOpenWithApps")) {
            systemApps = await getOpenWithApps(fullPath);
          }
        } catch {
          systemApps = [];
        }

        if (systemApps && systemApps.length > 0) {
          openWithItems.push(...systemApps.map((app: AppInfo) => ({
            label: app.name,
            iconPath: app.icon || undefined,
            checked: app.is_default,
            radio: true,
            onToggle: async (checked: boolean) => {
              if (checked) {
                await setDefaultApp(fullPath, app.desktop_entry);
                if (showContextMenu) showContextMenu(e, index);
              }
            },
            action: async () => {
              await openFileWithApp(fullPath, app.desktop_entry);
            },
            mnemonicIndex: 0
          })));
        }

        // Diverse systeemeigen opties
        const nativeActions: MenuItem[] = [];

        // 1. Systeemtoepassing (standaard)
        nativeActions.push({
          label: $_('common.system_default') || "Systeemtoepassing (standaard)",
          action: () => openFile(fullPath).catch((err: any) => {
            error = $_("filelist.open_error", { error: err?.message || err });
          }),
          mnemonicIndex: 0
        });

        // 2. Systeemeigen teksteditor
        if (hasCapability("openInEditor")) {
          nativeActions.push({
            label: $_('filelist.system_editor') || "Systeemeigen teksteditor",
            action: () => openInEditor(fullPath).catch((err: any) => {
              error = $_("filelist.editor_error", { error: err?.message || err });
            }),
            mnemonicIndex: 0
          });
        }

        // 3. Systeemeigen terminal (in map van bestand)
        if (hasCapability("openTerminal")) {
          nativeActions.push({
            label: $_('filelist.system_terminal') || "Systeemeigen terminal",
            action: () => openTerminal(currentPath).catch((err: any) => {
              error = $_("filelist.terminal_error", { error: err?.message || err });
            }),
            mnemonicIndex: 0
          });
        }

        // 4. Systeemeigen bestandsbeheerder (open map in OS bestandsbeheerder)
        nativeActions.push({
          label: $_('filelist.system_file_manager') || "Systeemeigen bestandsbeheerder",
          action: () => openFile(currentPath).catch((err: any) => {
            error = $_("filelist.file_manager_error", { error: err?.message || err });
          }),
          mnemonicIndex: 0
        });

        // 5. Openen op deze computer (voor web clients)
        if (hasCapability("openOnThisComputer")) {
          nativeActions.push({
            label: $_('common.open_on_computer'),
            action: () => openOnThisComputer(fullPath),
            mnemonicIndex: 0
          });
        }

        if (openWithItems.length > 0 && nativeActions.length > 0) {
          openWithItems.push({ isSeparator: true } as MenuItem);
        }
        openWithItems.push(...nativeActions);

        // Ingebouwde Nexus Commander editors/viewers
        openWithItems.push({ isSeparator: true } as MenuItem);
        openWithItems.push({
          label: $_('filelist.internal_editor'),
          action: () => requestOpen(fullPath, "edit"),
          mnemonicIndex: 0
        });
        openWithItems.push({
          label: $_('filelist.internal_viewer') || "Interne viewer",
          action: () => requestOpen(fullPath, "view"),
          mnemonicIndex: 0
        });
      } else if (entry.name !== "..") {
        // Mappen: systeemeigen opties
        let dirApps: AppInfo[] = [];
        try {
          if (hasCapability("getOpenWithApps")) {
            dirApps = await getOpenWithApps(fullPath);
          }
        } catch {}

        if (dirApps && dirApps.length > 0) {
          openWithItems.push(...dirApps.map((app: AppInfo) => ({
            label: app.name,
            iconPath: app.icon || undefined,
            checked: app.is_default,
            radio: true,
            onToggle: async (checked: boolean) => {
              if (checked) {
                await setDefaultApp(fullPath, app.desktop_entry);
                if (showContextMenu) showContextMenu(e, index);
              }
            },
            action: async () => {
              await openFileWithApp(fullPath, app.desktop_entry);
            },
            mnemonicIndex: 0
          })));
          openWithItems.push({ isSeparator: true } as MenuItem);
        }

        openWithItems.push({
          label: $_('filelist.system_file_manager') || "Systeemeigen bestandsbeheerder",
          action: () => openFile(fullPath).catch((err: any) => {
            error = $_("filelist.file_manager_error", { error: err?.message || err });
          }),
          mnemonicIndex: 0
        });
        if (hasCapability("openTerminal")) {
          openWithItems.push({
            label: $_('filelist.system_terminal') || "Systeemeigen terminal",
            action: () => openTerminal(fullPath).catch((err: any) => {
              error = $_("filelist.terminal_error", { error: err?.message || err });
            }),
            mnemonicIndex: 0
          });
        }
        if (hasCapability("openInEditor")) {
          openWithItems.push({
            label: $_('filelist.system_editor') || "Systeemeigen teksteditor",
            action: () => openInEditor(fullPath).catch((err: any) => {
              error = $_("filelist.editor_error", { error: err?.message || err });
            }),
            mnemonicIndex: 0
          });
        }
      }

      menuOptions = [
        { label: $_('common.open'), action: () => { const entry = filteredEntries[selectedIndex]; const fullPath = getFullPath(entry); if (!entry.is_dir && requestOpen(fullPath, "open")) return; enterEntry(selectedIndex); }, shortcut: "Ctrl+Alt+Enter", mnemonicIndex: 0 },
        ...(openWithItems.length > 0 ? [{
          label: $_('common.open_with'),
          mnemonicIndex: 5,
          items: openWithItems
        }] : []),
        ...(!entry.is_dir && hasCapability("openOnThisComputer") ? [{
          label: $_('common.open_on_computer'),
          action: () => openOnThisComputer(getFullPath(entry)),
          mnemonicIndex: 8
        }] : []),
        ...(!entry.is_dir ? [
          { label: $_('filelist.f3'), action: () => requestOpen(getFullPath(entry), "view"), shortcut: "F3", mnemonicIndex: 0 },
          { label: $_('filelist.f4'), action: () => requestOpen(getFullPath(entry), "edit"), shortcut: "F4", mnemonicIndex: 0 },
        ] : []),
        { isSeparator: true },
        {
          label: (entry && selectedEntries.has(entry.name)) ? ($_('menu.unselect_group') || "Unmark") : ($_('menu.select_group') || "Mark"),
          action: () => toggleSelection(index),
          shortcut: "Insert",
          mnemonicIndex: 0
        },
        ...(selectedEntries.size > 0 ? [{ label: $_('menu.unselect_all'), action: unselectAll, mnemonicIndex: 0 }] : []),
        { isSeparator: true },
        { label: $_('menu.pack'), action: handlePack, mnemonicIndex: 0 },
        ...(is_arch ? [{ label: $_('menu.unpack'), action: handleUnpack, mnemonicIndex: 0 }] : []),
        ...(showDownload ? [{ label: $_('menu.download'), action: handleDownload, mnemonicIndex: 0 }] : []),
        { isSeparator: true },
        { label: $_('menu.move'), action: handleMove, shortcut: "F6", mnemonicIndex: 0 },
        { label: $_('menu.copy'), action: handleCopy, shortcut: "F5", mnemonicIndex: 0 },
        { label: $_('menu.delete'), action: handleDelete, shortcut: "F8", mnemonicIndex: 0 },
        { label: $_('fkeys.f2'), action: startRename, shortcut: "F2", mnemonicIndex: 0 },
        { isSeparator: true },
        { label: $_('common.cut'), action: handleCut, mnemonicIndex: 0, shortcut: "Ctrl+X" },
        { label: $_('common.copy'), action: handleCopyClipboard, mnemonicIndex: 0, shortcut: "Ctrl+C" },
        { label: $_('common.paste'), action: handlePaste, mnemonicIndex: 0, shortcut: "Ctrl+V" },
        { isSeparator: true },
        { label: $_('file_properties.title'), action: handleShowProperties, shortcut: "Alt+Enter", mnemonicIndex: 5 }
      ];
    } else {
      let clip: any;
      clipboardStore.subscribe(v => clip = v)();

      menuOptions = [
        { label: $_('menu.mkdir'), action: handleMkDir, shortcut: "F7", mnemonicIndex: 4 },
        { label: $_('common.refresh'), action: refresh, shortcut: "Ctrl+R", mnemonicIndex: 0 },
        { label: $_('menu.open_terminal'), action: () => openTerminal(currentPath).catch((err: any) => { error = $_("filelist.terminal_error", { error: err?.message || err }); }), shortcut: "Shift+F4", mnemonicIndex: 5 },
        { isSeparator: true },
        ...(showUpload ? [{ label: $_('menu.upload_files'), action: () => window.dispatchEvent(new CustomEvent('nc:menu-action', { detail: 'upload-files' })), mnemonicIndex: 0 }] : []),
        { label: $_('common.paste'), action: handlePaste, mnemonicIndex: 0, shortcut: "Ctrl+V" }
      ];
    }

    openContextMenu(e.clientX, e.clientY, menuOptions);
  }

  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let longPressStart: { x: number; y: number } | null = null;
  let suppressNextClick = false;

  function clearLongPressTimer() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    longPressStart = null;
  }

  function handleLongPressStart(e: PointerEvent, index: number | null) {
    if (overlayActive || !isCoarsePointer(e) || e.button !== 0) return;
    clearLongPressTimer();
    longPressStart = { x: e.clientX, y: e.clientY };
    longPressTimer = setTimeout(() => {
      suppressNextClick = true;
      showContextMenu(e, index);
    }, 560);
  }

  function handleLongPressMove(e: PointerEvent) {
    if (!longPressStart) return;
    const dx = Math.abs(e.clientX - longPressStart.x);
    const dy = Math.abs(e.clientY - longPressStart.y);
    if (dx > 10 || dy > 10) clearLongPressTimer();
  }

  function handleLongPressEnd() {
    clearLongPressTimer();
    if (suppressNextClick) {
      setTimeout(() => {
        suppressNextClick = false;
      }, 0);
    }
  }

  function handlePathLongPressStart(e: PointerEvent) {
    if (overlayActive || !isCoarsePointer(e) || e.button !== 0) return;
    clearLongPressTimer();
    longPressStart = { x: e.clientX, y: e.clientY };
    longPressTimer = setTimeout(() => {
      suppressNextClick = true;
      startPathEdit(e);
    }, 560);
  }

  function handleCut() {
    if (checkReadOnly()) return;
    const { paths } = getOperationEntries();
    clipboardStore.set({ paths, operation: "cut", sourceDir: currentPath });
  }

  function handleCopyClipboard() {
    const { paths } = getOperationEntries();
    clipboardStore.set({ paths, operation: "copy", sourceDir: currentPath });
  }

  async function handlePaste() {
    if (checkReadOnly()) return;
    let clip: any;
    clipboardStore.subscribe(v => clip = v)();
    if (!clip?.paths.length || !clip.operation) return;
    if (!onpaste) {
      showActionToast(false, $_("errors.feature_unavailable"), 4000);
      return;
    }

    // Not copyEntries/moveEntries: those replaced an existing file of the
    // same name without a question on desktop, and refused outright on web.
    // The shell's task queue asks — overwrite, skip or keep both — in both.
    try {
      await onpaste({
        operation: clip.operation === "copy" ? "copy" : "move",
        sources: clip.paths,
        targetDir: currentPath,
      });
      // The move is the queue's to finish and to report now.
      if (clip.operation === "cut") clearClipboard();
    } catch (e: any) {
      showActionToast(false, e?.message || String(e), 6000);
    } finally {
      // Partial operations also change listings, including the source of a move.
      window.dispatchEvent(new CustomEvent("nc:refresh-panels"));
    }
  }

  function handleShowProperties() {
    const entry = filteredEntries[selectedIndex];
    if (!entry) return;
    openDialog({
      type: "properties",
      entries: [entry],
      sourcePaths: [getFullPath(entry)],
      sourceDir: currentPath
    });
  }

  // Quick search / Filter state
  let filterText = $state("");
  let showQuickSearch = $state(false);
  let searchInputEl = $state<HTMLInputElement>();

  const configuredViewMode = $derived(
    side === "left"
      ? ($appConfigStore?.layout_left_view_mode || $appConfigStore?.left_view_mode || "full")
      : ($appConfigStore?.layout_right_view_mode || $appConfigStore?.right_view_mode || "full")
  );

  let viewMode = $state<"brief" | "full">("full");

  $effect(() => {
    viewMode = configuredViewMode;
  });

  let filteredEntries = $derived(
    filterText 
      ? entries.filter(e => e.name === ".." || e.name.toLowerCase().includes(filterText.toLowerCase())) 
      : entries
  );

  function handleQuickSearch(e: KeyboardEvent) {
    if (e.key === "Escape") {
      showQuickSearch = false;
      filterText = "";
      e.preventDefault();
    } else if (e.ctrlKey && e.key === "r") {
      e.preventDefault();
      refresh();
    } else if (e.key === "Enter") {
      if (filteredEntries.length > 0) {
        selectedIndex = 0;
        scrollToIndex(0);
      }
      showQuickSearch = false;
      e.preventDefault();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (e.key === "ArrowDown" && selectedIndex < filteredEntries.length - 1) {
        selectedIndex++;
      } else if (e.key === "ArrowUp" && selectedIndex > 0) {
        selectedIndex--;
      }
      scrollToIndex(selectedIndex);
    }
  }

  function getOriginalIndex(filteredIdx: number): number {
    if (!filterText) return filteredIdx;
    const item = filteredEntries[filteredIdx];
    if (!item) return -1;
    return entries.findIndex(e => e === item);
  }

  function handleEntryClick(e: MouseEvent, index: number) {
    if (overlayActive) return;
    if (suppressNextClick) {
      e.preventDefault();
      e.stopPropagation();
      suppressNextClick = false;
      return;
    }
    
    // Prevent browser from selecting text when using standard multi-select modifiers
    if (e.shiftKey || e.ctrlKey) {
      e.preventDefault();
    }
    
    handlePanelFocus();
    const entry = filteredEntries[index];
    if (!entry) return;
    const touchInput = isCoarsePointer(e);

    if (touchInput) {
      e.preventDefault();
      if (selectedEntries.size > 0) {
        if (entry.name === "..") {
          selectedIndex = index;
          selectionAnchor = index;
          lastTouchFocusIndex = index;
          return;
        }
        if (selectedEntries.has(entry.name)) {
          selectedEntries.delete(entry.name);
        } else {
          selectedEntries.add(entry.name);
        }
        selectedEntries = new Set(selectedEntries);
        selectedIndex = index;
        selectionAnchor = index;
        lastTouchFocusIndex = index;
        return;
      }

      if (lastTouchFocusIndex === index && selectedIndex === index) {
        enterEntry(index);
        lastTouchFocusIndex = null;
        return;
      }

      selectedIndex = index;
      selectionAnchor = index;
      lastTouchFocusIndex = index;
      return;
    }

    // Mode-aware logic
    if (selectionMode === "Windows" && !e.shiftKey && !e.ctrlKey) {
      if (entry.name !== "..") {
        if (selectedEntries.has(entry.name)) {
          selectedEntries.delete(entry.name);
        } else {
          selectedEntries.add(entry.name);
        }
        selectedEntries = new Set(selectedEntries);
      }
      selectedIndex = index;
      selectionAnchor = index;
      return;
    }

    if (e.shiftKey) {
      // Range selection
      const start = Math.min(selectionAnchor, index);
      const end = Math.max(selectionAnchor, index);
      
      for (let i = start; i <= end; i++) {
        const item = filteredEntries[i];
        if (item && item.name !== "..") {
          selectedEntries.add(item.name);
        }
      }
      selectedEntries = new Set(selectedEntries);
      selectedIndex = index;
    } else if (e.ctrlKey) {
      // Toggle selection
      if (entry.name !== "..") {
        if (selectedEntries.has(entry.name)) {
          selectedEntries.delete(entry.name);
        } else {
          selectedEntries.add(entry.name);
        }
        selectedEntries = new Set(selectedEntries);
      }
      selectedIndex = index;
      selectionAnchor = index;
    } else {
      // Regular click: moves cursor.
      selectedEntries = new Set();
      selectedIndex = index;
      selectionAnchor = index;
    }
  }



  // Viewer state (exposed to parent via callback)


  $effect(() => {
    if (!isActive) return;
    const entry = filteredEntries[selectedIndex];
    if (entry && !entry.is_dir) {
      const fullPath = getFullPath(entry);
      onselectionchange?.(fullPath);
    } else {
      onselectionchange?.(null);
    }
  });

  // Virtual scrolling state
  let scrollContainer: HTMLDivElement | undefined = $state(undefined);
  let scrollTop = $state(0);
  let containerHeight = $state(600);

  // Reactive appConfig store subscription for Svelte 5 prop store
  let cfgState = $state<any>(null);
  $effect(() => {
    if (appConfigStore?.subscribe) {
      const unsub = appConfigStore.subscribe((val: any) => {
        cfgState = val;
      });
      return unsub;
    }
  });

  // Dynamically scale row height and icon size with pane font size
  let fontSize = $derived.by(() => {
    const fromStore = cfgState?.font_pane_size ?? $appConfigStore?.font_pane_size;
    if (fromStore) {
      const num = Number(fromStore);
      if (!isNaN(num) && num > 0) return num;
    }
    if (typeof document !== "undefined") {
      const raw = getComputedStyle(document.documentElement)
        .getPropertyValue("--font-pane-size")
        .trim();
      const parsed = parseFloat(raw);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    return 12;
  });

  let ROW_HEIGHT = $derived.by(() => {
    // Proportional scaling for row height with generous vertical padding
    // e.g. 11px font -> 28px row, 12px font -> 30px row, 14px font -> 33px row, 16px font -> 37px row, 20px font -> 44px row
    const scaled = Math.round(fontSize * 1.8 + 8);
    return Math.max(isCoarsePointer() ? 44 : 24, scaled);
  });

  let ICON_SIZE = $derived(Math.max(14, Math.round(ROW_HEIGHT * 0.65)));
  const OVERSCAN = 5;

  // Subscribe to active panel store
  activePanel.subscribe((value) => {
    isActive = value === side;
    if (isActive) {
      tick().then(() => {
        const active = document.activeElement;
        const isTyping = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.getAttribute('contenteditable') === 'true');
        if (!isTyping) {
          panelEl?.focus();
        }
      });
    }
  });

  // Inline rename state
  let renamingIndex: number | null = $state(null);
  let renameValue = $state("");
  let renameInput: HTMLInputElement | undefined = $state(undefined);
  let renameInProgress = $state(false);

  // ---------- Virtual scrolling calculations ----------
  let visibleStart = $derived(Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN));
  let visibleEnd = $derived(
    Math.min(filteredEntries.length, Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + OVERSCAN)
  );
  let visibleEntries = $derived(filteredEntries.slice(visibleStart, visibleEnd));
  let totalHeight = $derived(filteredEntries.length * ROW_HEIGHT);
  let offsetY = $derived(visibleStart * ROW_HEIGHT);

  // ---------- Lifecycle ----------
  onMount(() => {
    // Settings are handled by the global appConfigStore subscription/effect

    // Listen for settings changes via store updates (or manually trigger refresh if needed)
    const handleSettings = (e: any) => {
      savedColumns = [];
      refresh().catch(console.error);
    };
    window.addEventListener("nc:settings-changed", handleSettings);

    const handleColumnsSync = (e: any) => {
      if (e.detail.sender !== side) {
        savedColumns = e.detail.columns;
      }
    };
    window.addEventListener("nc:columns-sync", handleColumnsSync);

    // Note: select-all/test-archive/split/combine/etc. are dispatched only
    // from MenuBar.svelte and ActionPalette.svelte, which +page.svelte already
    // routes to the active panel's handler — a duplicate local listener here
    // used to fire every one of those a second time (e.g. testing an archive
    // twice over the network for a single menu click).

    const initializeTabs = (path: string, restoredTabs?: Tab[], restoredActiveId?: string) => {
      const initialPath = getVisiblePath(path || "/");
      if (restoredTabs && restoredTabs.length > 0) {
        tabs = restoredTabs.map(t => {
          const tabPath = getVisiblePath(t.path);
          return {
            ...t,
            path: tabPath,
            label: isGvfsRootPath(t.path) ? (tabPath === "/" ? "/" : tabPath.split("/").pop() || "/") : t.label
          };
        });
        activeTabId = restoredActiveId && restoredTabs.some(t => t.id === restoredActiveId)
          ? restoredActiveId
          : restoredTabs[0].id;
      } else {
        const initialTab = createTab(initialPath);
        tabs = [initialTab];
        activeTabId = initialTab.id;
      }
      currentPath = initialPath;
      tabsLoaded = true;
      history = [initialPath];
      loadDirectory(initialPath, { persistTabsOnLoad: false });
    };

    // Load initial tabs after settings are available
    $effect(() => {
      if (!$appConfigStore || tabsLoaded) return;
      
      const savedTabs = side === "left" ? $appConfigStore.left_tabs : $appConfigStore.right_tabs;
      const savedActive = side === "left" ? $appConfigStore.left_active_tab : $appConfigStore.right_active_tab;

      if (savedTabs && savedTabs.length > 0) {
        const restoredTabs = savedTabs.map(t => ({
          id: t.id,
          path: t.path,
          label: t.label,
          customLabel: t.custom_label || undefined,
          locked: t.locked
        }));
        const activeId = restoredTabs.some(t => t.id === savedActive) ? savedActive : restoredTabs[0].id;
        const activeTab = restoredTabs.find(t => t.id === activeId);
        initializeTabs(activeTab?.path || "/", restoredTabs, activeId);
      } else {
        if (initialPath) {
          initializeTabs(initialPath);
        } else {
          tabsLoaded = true;
          getHomeDir()
            .then((home) => initializeTabs(home || "/"))
            .catch(() => initializeTabs("/"));
        }
      }
    });

    // Observe container resizes for virtual scrolling
    let ro: ResizeObserver | undefined;
    if (scrollContainer) {
      ro = new ResizeObserver((es) => {
        containerHeight = es[0]?.contentRect.height ?? 600;
      });
      ro.observe(scrollContainer);
    }

    const handleFeed = (e: any) => {
      if (e.detail.side === side) {
        feedResults(e.detail.results, e.detail.query);
      }
    };
    window.addEventListener("nc:feed-to-listbox", handleFeed);

    // The current folder can disappear: an ejected USB stick, a deleted
    // directory, an unmounted share. Removable media are polled, because they
    // vanish while the window has focus. Everything else is checked when the
    // window regains focus — polling every path every five seconds kept
    // network mounts busy (a NAS never spun down) and, when a share briefly
    // dropped, threw the panel back to the home folder without a word.
    const isRemovablePath = (p: string) => p.startsWith("/media/") || p.startsWith("/run/media/");

    const nearestExistingAncestor = async (path: string): Promise<string> => {
      let candidate = path;
      for (let depth = 0; depth < 64 && candidate !== "/"; depth++) {
        candidate = await getParentDir(candidate);
        if (!candidate) break;
        const info = await getPathInfo(candidate).catch(() => null);
        if (info?.exists) return candidate;
      }
      return "/";
    };

    let checkingPath = false;
    const checkPathValidity = async () => {
      if (!currentPath || currentPath === "/" || isSearchResultsView || loading || checkingPath) return;
      checkingPath = true;
      const checked = currentPath;
      try {
        let gone = false;
        if (isRemovablePath(checked)) {
          const activeDrives = await getDrives().catch(() => []);
          gone = !activeDrives.some((d) => checked === d.path || checked.startsWith(d.path + "/"));
        }
        if (!gone) {
          const info = await getPathInfo(checked);
          gone = !!info && info.exists === false;
        }
        // The user may have navigated away while this was in flight.
        if (gone && currentPath === checked) {
          const target = await nearestExistingAncestor(checked);
          entries = [];
          showActionToast(false, $_("filelist.path_gone", { path: checked, target }), 6000);
          loadDirectory(target);
        }
      } catch {
        // Silently ignore transient errors to prevent list flickering
      } finally {
        checkingPath = false;
      }
    };
    const pathCheckInterval = setInterval(() => {
      if (isRemovablePath(currentPath)) checkPathValidity();
    }, 5000);
    window.addEventListener("focus", checkPathValidity);

    return () => {
      ro?.disconnect();
      window.removeEventListener("nc:settings-changed", handleSettings);
      window.removeEventListener("nc:columns-sync", handleColumnsSync);
      window.removeEventListener("nc:feed-to-listbox", handleFeed);
      clearInterval(pathCheckInterval);
      window.removeEventListener("focus", checkPathValidity);
      clearPathEditTimer();
    };
  });

  /** Set the view mode (brief/full). */
  export function setViewMode(mode: "brief" | "full") {
    viewMode = mode;
  }

  /** Get the current view mode. */
  export function getViewMode(): "brief" | "full" {
    return viewMode;
  }

  async function loadAvailableDrives() {
    try {
      availableDrives = await getDrives();
    } catch (e) {
      console.error("Failed to load drives:", e);
    }
  }

  /** Feed a custom list of search results to the panel. */
  export function feedResults(newEntries: FileEntry[], queryContext: string) {
    loading = false;
    error = null;
    isSearchResultsView = true;
    entries = newEntries;
    sortEntries();
    currentPath = `${$_("search.results_prefix")}: ${queryContext}`;
    updateActiveTabPath(currentPath);
    selectedIndex = 0;
    selectedEntries = new Set();
    
    // Update the panel path store with descriptive text
    if (side === "left") {
      leftPanelPath.set(currentPath);
    } else {
      rightPanelPath.set(currentPath);
    }
  }

  // ---------- Core methods ----------
  function clearPathEditTimer() {
    if (pathEditTimer) {
      clearTimeout(pathEditTimer);
      pathEditTimer = null;
    }
  }

  function resetPathEditTimer() {
    clearPathEditTimer();
    pathEditTimer = setTimeout(() => {
      if (pathEditActive) {
        cancelPathEdit();
      }
    }, 10000);
  }

  async function startPathEdit(e?: ContextPointEvent) {
    if (overlayActive) return;
    e?.preventDefault();
    e?.stopPropagation();
    pathEditValue = currentPath;
    pathEditActive = true;
    resetPathEditTimer();
    await tick();
    pathInputEl?.focus();
    pathInputEl?.select();
    if (e) showPathInputMenu(e);
  }

  async function commitPathEdit() {
    clearPathEditTimer();
    const nextPath = pathEditValue.trim();
    pathEditActive = false;
    if (nextPath && nextPath !== currentPath) {
      await loadDirectory(nextPath);
    }
  }

  function cancelPathEdit() {
    clearPathEditTimer();
    pathEditActive = false;
    pathEditValue = currentPath;
  }

  function handlePathEditKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitPathEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelPathEdit();
    } else {
      resetPathEditTimer();
    }
  }

  function getSelectedPathText() {
    if (!pathInputEl) return pathEditValue;
    const start = pathInputEl.selectionStart ?? 0;
    const end = pathInputEl.selectionEnd ?? pathEditValue.length;
    return start !== end ? pathEditValue.slice(start, end) : pathEditValue;
  }

  function showPathInputMenu(e: ContextPointEvent) {
    e.preventDefault();
    e.stopPropagation();
    pathInputEl?.focus();
    resetPathEditTimer();

    openContextMenu(e.clientX, e.clientY, [
      {
        label: $_("filelist.path_cut"),
        shortcut: "Ctrl+X",
        action: () => {
          const selected = getSelectedPathText();
          void navigator.clipboard?.writeText(selected);
          pathInputEl?.setRangeText("", pathInputEl.selectionStart ?? 0, pathInputEl.selectionEnd ?? 0, "start");
          pathEditValue = pathInputEl?.value ?? pathEditValue;
          resetPathEditTimer();
        }
      },
      {
        label: $_("filelist.path_copy"),
        shortcut: "Ctrl+C",
        action: () => {
          void navigator.clipboard?.writeText(getSelectedPathText());
          resetPathEditTimer();
        }
      },
      {
        label: $_("filelist.path_paste"),
        shortcut: "Ctrl+V",
        action: () => {
          void navigator.clipboard?.readText().then((text) => {
            pathInputEl?.focus();
            pathInputEl?.setRangeText(text, pathInputEl.selectionStart ?? 0, pathInputEl.selectionEnd ?? 0, "end");
            pathEditValue = pathInputEl?.value ?? pathEditValue;
            resetPathEditTimer();
          });
        }
      },
      { isSeparator: true },
      {
        label: $_("filelist.path_select_all"),
        shortcut: "Ctrl+A",
        action: () => {
          pathInputEl?.focus();
          pathInputEl?.select();
          resetPathEditTimer();
        }
      }
    ]);
  }

  async function loadDirectory(path: string, options: { persistTabsOnLoad?: boolean } = {}) {
    if (!path) return;
    clearPathEditTimer();
    pathEditActive = false;
    if (isGvfsRootPath(path)) {
      const home = await getHomeDir().catch(() => "/");
      await loadDirectory(home || "/", options);
      return;
    }
    const isRefresh = currentPath === path;
    if (loading && isRefresh) return; // Prevent redundant refreshes

    // Store currently focused entry name before refresh to restore cursor precisely
    const focusedEntryName = filteredEntries[selectedIndex]?.name;

    if (!isRefresh) {
      loading = true;
      entries = [];
      // Clear size calculation state only when changing directory
      cancelDirSizeCalcs();
      calculatedDirs = new Set();
      dirSizes = {};
    }

    isSearchResultsView = false;
    error = null;
    renamingIndex = null;

    try {
      let result;
      const archive = await isArchive(path);
      isInArchive = archive;
      if (archive) {
        result = await readArchive(path);
      } else {
        result = await readDirectory(path);
      }
      
      if (showParentDirRow && path !== "/" && !isSearchResultsView) {
        try {
          const parentInfo = await getParentInfo(path);
          parentInfo.name = ".."; // Force name for logic
          result = [parentInfo, ...result];
        } catch (e) {
          // Fallback if parent info is unavailable
          result = [
            {
              name: "..",
              is_dir: true,
              is_symlink: false,
              size: 0,
              modified: 0,
              extension: "",
              permissions: "",
              owner: "",
              group: ""
            },
            ...result
          ];
        }
      }

      if (isRefresh && entries.length > 0) {
        // Reconcile fresh result into existing entries to preserve object references
        entries = reconcileEntries(entries, result);

        // Prune dirSizes cache for removed or modified directories
        const freshMap = new Map(result.map((e) => [e.name, e]));
        const nextDirSizes: Record<string, number> = {};
        const nextCalculated = new Set<string>();
        for (const dirName of calculatedDirs) {
          const fresh = freshMap.get(dirName);
          if (fresh && fresh.is_dir && dirSizes[dirName] !== undefined) {
            nextDirSizes[dirName] = dirSizes[dirName];
            nextCalculated.add(dirName);
          }
        }
        dirSizes = nextDirSizes;
        calculatedDirs = nextCalculated;
      } else {
        entries = result;
      }

      sortEntries();

      // Drop marks for entries that are gone (deleted, moved away, renamed).
      // Without this the status bar keeps counting them and F8/F6 operate on an
      // empty set, because getOperationEntries() filters marks against `entries`.
      if (isRefresh && selectedEntries.size > 0) {
        const liveNames = new Set(entries.map((e) => e.name));
        const nextSelection = new Set<string>();
        for (const name of selectedEntries) {
          if (liveNames.has(name)) nextSelection.add(name);
        }
        if (nextSelection.size !== selectedEntries.size) {
          selectedEntries = nextSelection;
        }
      }

      // Restore focused index accurately after refresh
      if (isRefresh && focusedEntryName) {
        const newIndex = filteredEntries.findIndex((e) => e.name === focusedEntryName);
        if (newIndex !== -1) {
          selectedIndex = newIndex;
        } else {
          selectedIndex = Math.min(selectedIndex, Math.max(0, filteredEntries.length - 1));
        }
      }
      
      if (currentPath !== path) {
        if (historyIndex < history.length - 1) {
          history = history.slice(0, historyIndex + 1);
        }
        history = [...history, path];
        historyIndex = history.length - 1;
      }

      currentPath = path;
      updateActiveTabPath(path);
      if (options.persistTabsOnLoad !== false) {
        persistTabs();
      }
      if (!isRefresh) {
        selectedIndex = 0;
        selectedEntries = new Set();
      }

      // Update the panel path store
      if (side === "left") {
        leftPanelPath.set(path);
      } else {
        rightPanelPath.set(path);
      }

      if (!isRefresh && scrollContainer) {
        await tick();
        scrollContainer.scrollTop = 0;
      }
    } catch (e: any) {
      error = typeof e === "string" ? e : e.message || "Failed to read directory";
    } finally {
      loading = false;

      // Sync side-effect: update global panel path stores
      if (side === "left") leftPanelPath.set(path);
      else rightPanelPath.set(path);

      if (!error) updateActiveTabPath(path);
      
      tick().then(() => {
        if (isActive) {
          const active = document.activeElement;
          const isTyping = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.getAttribute('contenteditable') === 'true');
          if (!isTyping) {
            panelEl?.focus();
          }
        }
      });
    }
  }

  /** Refresh the current directory. */
  export async function refresh() {
    await loadDirectory(currentPath);
  }

  /** Navigate this panel to a concrete directory path. */
  export async function navigateTo(path: string) {
    await loadDirectory(path);
  }

  /** Get the current path of this panel. */
  export function getPath(): string {
    return currentPath;
  }

  /** Get the list of selected entries (or the cursor entry if none selected). */
  function getOperationEntries(): { entries: FileEntry[]; paths: string[] } {
    let opEntries: FileEntry[];
    if (selectedEntries.size > 0) {
      opEntries = entries.filter((e) => selectedEntries.has(e.name) && e.name !== "..");
    } else if (filteredEntries[selectedIndex]) {
      opEntries = [filteredEntries[selectedIndex]];
    } else {
      opEntries = [];
    }
    opEntries = opEntries.filter((e) => e.name !== "..");
    const paths = opEntries.map((e) => getFullPath(e));
    return { entries: opEntries, paths };
  }

  // ---------- Sorting ----------
  /**
   * Size to sort on. A directory's `size` field stays 0 — its real size only
   * exists once it has been calculated, and lives in `dirSizes` (the same
   * source the FILESIZE column renders). Uncalculated directories sort as -1 so
   * they stay grouped together instead of interleaving with calculated ones.
   */
  function sortSize(entry: FileEntry): number {
    if (!entry.is_dir) return entry.size;
    return calculatedDirs.has(entry.name) ? dirSizes[entry.name] : -1;
  }

  /** Re-sort after directory sizes arrive, keeping the cursor on the same entry. */
  function resortAfterDirSizes() {
    if (sortColumn !== "size") return;
    const selectedName = filteredEntries[selectedIndex]?.name;
    sortEntries();
    if (selectedName !== undefined) {
      const idx = filteredEntries.findIndex((e) => e.name === selectedName);
      if (idx >= 0) selectedIndex = idx;
    }
  }

  function sortEntries() {
    entries = [...entries].sort((a, b) => {
      if (a.name === "..") return -1;
      if (b.name === "..") return 1;
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      let cmp = 0;
      switch (sortColumn) {
        case "name":
          cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
          break;
        case "extension":
          cmp = a.extension.toLowerCase().localeCompare(b.extension.toLowerCase());
          break;
        case "size":
          cmp = sortSize(a) - sortSize(b);
          if (cmp === 0) cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
          break;
        case "modified":
          cmp = a.modified - b.modified;
          break;
      }
      return sortAsc ? cmp : -cmp;
    });
  }

  /** Sort by column (exposed for MenuBar). */
  export function handleSort(column: SortColumn) {
    if (overlayActive) return;
    if (sortColumn === column) {
      sortAsc = !sortAsc;
    } else {
      sortColumn = column;
      sortAsc = true;
    }
    sortEntries();
  }

  // ---------- Navigation ----------
  async function enterEntry(index: number) {
    const entry = filteredEntries[index];
    if (!entry) return;

    if (entry.name === "..") {
      await goUp();
      return;
    }

    const fullPath = getFullPath(entry);

    if (entry.is_dir) {
      const currentTab = tabs.find(t => t.id === activeTabId);
      if (currentTab?.locked) {
        // Double commander logic: Navigating from locked tab opens a new tab
        const newTab = createTab(fullPath);
        tabs = [...tabs, newTab];
        activeTabId = newTab.id;
        await loadDirectory(fullPath);
      } else {
        await loadDirectory(fullPath);
      }
    } else {
      // Check if it's an archive
      try {
        const archive = await isArchive(fullPath);
        if (archive) {
          // Load archive contents as if it were a directory
          const currentTab = tabs.find(t => t.id === activeTabId);
          if (currentTab?.locked) {
            const newTab = createTab(fullPath);
            tabs = [...tabs, newTab];
            activeTabId = newTab.id;
          }
          await loadDirectory(fullPath);
          return;
        }
      } catch {
        // Not an archive, ignore
      }
      if (requestOpen(fullPath, "open")) {
        return;
      }

      try {
        await openFile(fullPath);
      } catch (e: any) {
        error = e?.message || $_("media_viewer.open_failed");
      }
    }
  }

  /** Go up one directory. */
  export async function goUp() {
    const parent = await getParentDir(currentPath);
    if (parent !== currentPath) {
      const oldDir = currentPath.split("/").pop() || "";
      
      const currentTab = tabs.find(t => t.id === activeTabId);
      if (currentTab?.locked) {
        // Double commander logic: Navigating from locked tab opens a new tab
        const newTab = createTab(parent);
        tabs = [...tabs, newTab];
        activeTabId = newTab.id;
        await loadDirectory(parent);
      } else {
        await loadDirectory(parent);
      }
      
      // Try to select the directory we came from
      const idx = filteredEntries.findIndex((e) => e.name === oldDir);
      if (idx >= 0) {
        selectedIndex = idx;
        scrollToIndex(idx);
      }
    }
  }

  function scrollToIndex(index: number) {
    if (!scrollContainer) return;
    const rowTop = index * ROW_HEIGHT;
    const rowBottom = rowTop + ROW_HEIGHT;

    if (rowTop < scrollContainer.scrollTop) {
      scrollContainer.scrollTop = rowTop;
    } else if (rowBottom > scrollContainer.scrollTop + containerHeight) {
      scrollContainer.scrollTop = rowBottom - containerHeight;
    }
  }

  function handlePanelFocus() {
    activePanel.set(side);
    panelEl?.focus();
  }

  // Ctrl+wheel resizes the pane font, the way most file managers do.
  function handleFileListWheel(e: WheelEvent) {
    if (!e.ctrlKey) return;

    e.preventDefault();
    e.stopPropagation();

    const currentSize = Number($appConfigStore?.font_pane_size) || 11;
    const direction = e.deltaY < 0 ? 1 : -1;
    const nextSize = Math.max(8, Math.min(24, currentSize + direction));

    if (nextSize === currentSize) return;

    updateSettings((cfg) => {
      cfg.font_pane_size = nextSize;
    });
  }

  function handleScroll() {
    if (scrollContainer) {
      scrollTop = scrollContainer.scrollTop;
    }
  }

  function checkReadOnly(): boolean {
    if (isInArchive) {
      alert($_("errors.archive_readonly") || "Archives are read-only.");
      return true;
    }
    return false;
  }

  // ---------- Inline rename ----------
  async function startRename() {
    if (checkReadOnly()) return;
    const entry = filteredEntries[selectedIndex];
    if (!entry || entry.name === "..") return;

    renamingIndex = selectedIndex;
    renameValue = entry.name;
    await tick();
    renameInput?.focus();
    if (!entry.is_dir && renameValue.includes(".") && renameValue.lastIndexOf(".") > 0) {
      renameInput?.setSelectionRange(0, renameValue.lastIndexOf("."));
    } else {
      renameInput?.select();
    }
  }

  async function confirmRename() {
    if (renamingIndex === null || renameInProgress) return;

    const oldEntry = filteredEntries[renamingIndex];
    const newName = renameValue;
    if (!oldEntry || newName === oldEntry.name || !newName.trim()) {
      renamingIndex = null;
      return;
    }

    // A "/" turned the rename into a move to another directory, and an
    // existing name was silently replaced. Both backends now refuse the
    // latter too; checking here keeps the input open so the name can be fixed.
    if (newName.includes("/") || newName.includes("\0") || newName === "." || newName === "..") {
      showActionToast(false, $_("errors.invalid_name"), 5000);
      return;
    }
    if (entries.some((e) => e !== oldEntry && e.name === newName)) {
      showActionToast(false, $_("errors.name_exists", { name: newName }), 5000);
      return;
    }

    const from = getFullPath(oldEntry);
    const to =
      currentPath === "/"
        ? `/${newName}`
        : `${currentPath}/${newName}`;

    renameInProgress = true;
    try {
      const result = await renameEntry(from, to);
      renamingIndex = null;
      if (result.success) {
        await refresh();
        // Select the renamed entry after the refreshed listing has been sorted.
        const idx = filteredEntries.findIndex((e) => e.name === newName);
        if (idx >= 0) {
          selectedIndex = idx;
          scrollToIndex(idx);
        }
      } else {
        error = result.message;
      }
    } catch (e: any) {
      renamingIndex = null;
      error = typeof e === "string" ? e : e?.message || "Failed to rename entry";
    } finally {
      renameInProgress = false;
    }
  }

  function cancelRename() {
    if (renameInProgress) return;
    renamingIndex = null;
  }

  function handleRenameKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      // Do not let Enter reach the panel's global keyboard navigation handler:
      // it could try to open the entry using the old name while the rename is
      // still in flight.
      e.preventDefault();
      e.stopPropagation();
      void confirmRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancelRename();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
      e.stopPropagation();
      renameInput?.select();
    }
  }

  // ---------- CRUD Operations (triggered via dialogs) ----------
  function handleMkDir() {
    if (checkReadOnly()) return;
    openDialog({
      type: "mkdir",
      inputValue: "",
      sourceDir: currentPath,
    });
  }

  function handleDelete(permanent = false) {
    if (checkReadOnly()) return;
    const { entries: opEntries, paths } = getOperationEntries();
    if (opEntries.length === 0) return;
    openDialog({
      type: "delete",
      entries: opEntries,
      sourcePaths: paths,
      sourceDir: currentPath,
      isPermanent: permanent,
    });
  }

  function handleCopy() {
    const { entries: opEntries, paths } = getOperationEntries();
    if (opEntries.length === 0) return;
    // Default target is the opposite panel's path
    let target = "";
    const unsub = (side === "left" ? rightPanelPath : leftPanelPath).subscribe(
      (v) => (target = v)
    );
    unsub();
    openDialog({
      type: "copy",
      entries: opEntries,
      sourcePaths: paths,
      targetDir: target,
      inputValue: target,
      sourceDir: currentPath,
    });
  }

  function handleMove() {
    if (checkReadOnly()) return;
    const { entries: opEntries, paths } = getOperationEntries();
    if (opEntries.length === 0) return;
    let target = "";
    const unsub = (side === "left" ? rightPanelPath : leftPanelPath).subscribe(
      (v) => (target = v)
    );
    unsub();
    openDialog({
      type: "move",
      entries: opEntries,
      sourcePaths: paths,
      targetDir: target,
      inputValue: target,
      sourceDir: currentPath,
    });
  }

  /** Open pack (Alt+F5) dialog. */
  /** Download the selection (or cursor item) — browser-download plan §4.3. */
  export function handleDownload() {
    const { entries: opEntries } = getOperationEntries();
    if (opEntries.length === 0) {
      showActionToast(false, $_('errors.nothing_selected') || "Nothing is selected.");
      return;
    }
    onDownload?.({ dir: currentPath, entries: opEntries });
  }

  export function handlePack() {
    const { entries: opEntries, paths } = getOperationEntries();
    if (opEntries.length === 0) {
      showActionToast(false, $_('errors.nothing_selected') || "Nothing is selected.");
      return;
    }
    const defaultName = opEntries.length === 1
      ? (opEntries[0].name + ".zip")
      : "archive.zip";
    const target = currentPath === "/" ? `/${defaultName}` : `${currentPath}/${defaultName}`;
    openDialog({
      type: "pack",
      entries: opEntries,
      sourcePaths: paths,
      targetDir: currentPath,
      inputValue: target,
      sourceDir: currentPath,
    });
  }

  /** Open unpack (Alt+F9) dialog. */
  export function handleUnpack() {
    let archivePath = "";
    const entry = filteredEntries[selectedIndex];

    if (isInArchive) {
      // Derive actual archive file path on disk when navigating inside an archive
      const parts = currentPath.split("::");
      archivePath = parts[0];
      if (!archivePath.includes(".")) {
        const match = currentPath.match(/^(.*?\.(?:zip|tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz|tar\.zst|tzst|zst|7z|rar))(?:\/|$)/i);
        if (match) archivePath = match[1];
        else archivePath = currentPath;
      }
    } else if (entry) {
      archivePath = getFullPath(entry);
    }

    if (!archivePath) {
      showActionToast(false, $_('errors.select_file_first') || "Select a file first.");
      return;
    }
    
    // Default target is the opposite panel's path
    let target = "";
    const unsub = (side === "left" ? rightPanelPath : leftPanelPath).subscribe(
      (v) => (target = v)
    );
    unsub();

    openDialog({
      type: "unpack",
      entries: entry ? [entry] : [],
      sourcePaths: [archivePath],
      targetDir: target,
      inputValue: target,
      sourceDir: currentPath,
    });
  }

  /** Test the integrity of an archive. */
  export async function handleTestArchive() {
    // QSF-008: both shells implement archive_test now, but the capability stays
    // optional — a shell that omits it must degrade, not fail at invoke time.
    if (!hasCapability("archiveTest")) {
      showActionToast(false, $_('errors.feature_unavailable'), 5000);
      return;
    }
    const entry = filteredEntries[selectedIndex];
    if (!entry || entry.is_dir) {
      showActionToast(false, $_('errors.select_file_first') || "Select a file first.");
      return;
    }
    const fullPath = getFullPath(entry);
    try {
      const ok = await archiveTest(fullPath);
      showActionToast(
        ok,
        ok
          ? ($_('archive.test_passed') || "Archive integrity check passed.")
          : ($_('archive.test_failed') || "Archive is corrupted or invalid."),
        ok ? 4000 : 6000
      );
    } catch (e: any) {
      showActionToast(false, ($_('archive.test_error', { error: e }) || `Test failed: ${e}`), 6000);
    }
  }

  /** Split selected file. */
  export function handleSplitFile() {
    // QSF-008: optional capability — see handleTestArchive.
    if (!hasCapability("splitFile")) {
      showActionToast(false, $_('errors.feature_unavailable'), 5000);
      return;
    }
    const entry = filteredEntries[selectedIndex];
    if (!entry || entry.is_dir) {
      showActionToast(false, $_('errors.select_file_first') || "Select a file first.");
      return;
    }
    const fullPath = getFullPath(entry);
    
    // Default to 1.44MB for small files, or larger chunks for big files
    let defaultChunk = "1457664"; // 1.44 MB
    if (entry.size > 100 * 1024 * 1024) {
        defaultChunk = "104857600"; // 100 MB
    }

    openDialog({
      type: "split",
      entries: [entry],
      sourcePaths: [fullPath],
      targetDir: currentPath,
      inputValue: defaultChunk, 
      sourceDir: currentPath,
    });
  }

  /** Combine selected files. */
  export function handleCombineFiles() {
    // QSF-008: optional capability — see handleTestArchive.
    if (!hasCapability("combineFiles")) {
      showActionToast(false, $_('errors.feature_unavailable'), 5000);
      return;
    }
    const { entries: opEntries, paths } = getOperationEntries();
    if (opEntries.length === 0) {
      showActionToast(false, $_('errors.nothing_selected') || "Nothing is selected.");
      return;
    }

    let defaultName = opEntries[0].name.replace(/\.\d+$/, "");
    const target = currentPath === "/" ? `/${defaultName}` : `${currentPath}/${defaultName}`;

    openDialog({
      type: "combine",
      entries: opEntries,
      sourcePaths: paths,
      targetDir: currentPath,
      inputValue: target,
      sourceDir: currentPath,
    });
  }

  /** Calculate directory size (Space bar on a dir). */
  async function calcDirSize() {
    const entry = filteredEntries[selectedIndex];
    if (!entry || !entry.is_dir) return;
    const fullPath = getFullPath(entry);

    const controller = new AbortController();
    dirSizeControllers.add(controller);
    try {
      calculatingDirs.add(entry.name);
      calculatingDirs = new Set(calculatingDirs);

      const size = await calculateDirSize(fullPath, controller.signal);

      // Update ONLY the size dictionary. Svelte will only update the specific DOM node bound to this.
      dirSizes[entry.name] = size;
      dirSizes = { ...dirSizes }; // Trigger Svelte reactivity

      calculatedDirs.add(entry.name);
      calculatedDirs = new Set(calculatedDirs);

      resortAfterDirSizes();
    } catch (e: any) {
      // Silently ignore permission errors and cancellations
    } finally {
      calculatingDirs.delete(entry.name);
      calculatingDirs = new Set(calculatingDirs);
      dirSizeControllers.delete(controller);
    }
  }

  /** Calculate all directory sizes in the current pane (Alt+Shift+Enter). */
  async function calcAllDirSizes() {
    if (isMassCalculating) return;

    const targetPath = currentPath;
    const entriesToCalc = [...entries].filter(e => e.is_dir && e.name !== ".." && e.name !== ".");

    if (entriesToCalc.length === 0) return;

    isMassCalculating = true;
    for (const entry of entriesToCalc) calculatingDirs.add(entry.name);
    calculatingDirs = new Set(calculatingDirs);

    // A single batched request lets the server bound its own concurrency and
    // keeps the browser's connection pool free for navigation/other requests.
    const controller = new AbortController();
    dirSizeControllers.add(controller);
    try {
      const paths = entriesToCalc.map(e => targetPath === "/" ? `/${e.name}` : `${targetPath}/${e.name}`);
      const results = hasCapability("calculateDirSizes")
        ? await calculateDirSizes(paths, controller.signal)
        : await Promise.all(
            paths.map(async (path) => {
              try {
                return { path, size: await calculateDirSize(path, controller.signal) };
              } catch (e: any) {
                return { path, error: typeof e === "string" ? e : e?.message || String(e) };
              }
            }),
          );

      if (currentPath === targetPath && dirSizeControllers.has(controller)) {
        for (let i = 0; i < results.length; i++) {
          const entry = entriesToCalc[i];
          const result = results[i];
          if (result.size !== undefined) {
            dirSizes[entry.name] = result.size;
            calculatedDirs.add(entry.name);
          }
          calculatingDirs.delete(entry.name);
        }
        dirSizes = { ...dirSizes };
        calculatedDirs = new Set(calculatedDirs);
        calculatingDirs = new Set(calculatingDirs);

        resortAfterDirSizes();
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        console.warn(`Failed to calculate directory sizes for ${targetPath}:`, err);
      }
      if (currentPath === targetPath && dirSizeControllers.has(controller)) {
        calculatingDirs = new Set();
      }
    } finally {
      const isCurrentController = dirSizeControllers.has(controller);
      dirSizeControllers.delete(controller);
      if (currentPath === targetPath && isCurrentController) {
        isMassCalculating = false;
      }
    }
  }


  /** Open Multi-Rename Tool (Ctrl+M). */
  export function handleMultiRename() {
    let opEntries: FileEntry[];
    if (selectedEntries.size > 0) {
      opEntries = entries.filter((e) => selectedEntries.has(e.name) && e.name !== "..");
    } else {
      const allUsable = entries.filter((e) => e.name !== "..");
      if (allUsable.length > 0) {
        opEntries = allUsable;
      } else {
        opEntries = [];
      }
    }
    if (opEntries.length === 0) return;
    window.dispatchEvent(new CustomEvent("nc:open-multi-rename", { 
      detail: { entries: opEntries, path: currentPath, side } 
    }));
  }



  /** Select entries by their names. Used for directory comparison. */
  export function selectByNames(names: string[]) {
    const existingNames = new Set(entries.map((e) => e.name));
    const nextSet = new Set<string>();
    names.forEach((name) => {
      if (name !== ".." && existingNames.has(name)) {
        nextSet.add(name);
      }
    });
    selectedEntries = nextSet;
  }

  /** Select entries matching a wildcard pattern. */
  export function handleSelectGroup(pattern?: string) {
    if (pattern === undefined) {
      openDialog({
        type: "select_group",
        entries: [],
        sourcePaths: [],
        targetDir: "",
        inputValue: "*",
        sourceDir: currentPath
      });
      return;
    }
    const regex = wildcardToRegex(pattern);
    const nextSet = new Set(selectedEntries);
    entries.forEach((entry) => {
      if (entry.name !== ".." && regex.test(entry.name)) {
        nextSet.add(entry.name);
      }
    });
    selectedEntries = nextSet;
  }

  /** Unselect entries matching a wildcard pattern. */
  export function handleUnselectGroup(pattern?: string) {
    if (pattern === undefined) {
      openDialog({
        type: "unselect_group",
        entries: [],
        sourcePaths: [],
        targetDir: "",
        inputValue: "*",
        sourceDir: currentPath
      });
      return;
    }
    const regex = wildcardToRegex(pattern);
    const nextSet = new Set(selectedEntries);
    entries.forEach((entry) => {
      if (regex.test(entry.name)) {
        nextSet.delete(entry.name);
      }
    });
    selectedEntries = nextSet;
  }

  /** Select all entries (Ctrl+Num +). */
  export function selectAll() {
    const nextSet = new Set(selectedEntries);
    entries.forEach((entry) => {
      if (entry.name !== "..") {
        nextSet.add(entry.name);
      }
    });
    selectedEntries = nextSet;
  }

  /** Select all files only. */
  export function selectAllFiles() {
    const nextSet = new Set(selectedEntries);
    entries.forEach((entry) => {
      if (!entry.is_dir && entry.name !== "..") {
        nextSet.add(entry.name);
      }
    });
    selectedEntries = nextSet;
  }

  /** Unselect all entries (Ctrl+Num - or /). */
  export function unselectAll() {
    selectedEntries = new Set();
  }

  /** Unselect all files only. */
  export function unselectAllFiles() {
    const nextSet = new Set(selectedEntries);
    entries.forEach((entry) => {
      if (!entry.is_dir) {
        nextSet.delete(entry.name);
      }
    });
    selectedEntries = nextSet;
  }

  /** Select entries with same extension as focused item (Alt+Num +). */
  export function selectSameExtension() {
    const entry = filteredEntries[selectedIndex];
    if (!entry || entry.name === "..") return;
    const ext = entry.extension.toLowerCase();
    const nextSet = new Set(selectedEntries);
    entries.forEach((e) => {
      if (e.name !== ".." && e.extension.toLowerCase() === ext) {
        nextSet.add(e.name);
      }
    });
    selectedEntries = nextSet;
  }

  /** Unselect entries with same extension as focused item (Alt+Num -). */
  export function unselectSameExtension() {
    const entry = filteredEntries[selectedIndex];
    if (!entry || entry.name === "..") return;
    const ext = entry.extension.toLowerCase();
    const nextSet = new Set(selectedEntries);
    entries.forEach((e) => {
      if (e.extension.toLowerCase() === ext) {
        nextSet.delete(e.name);
      }
    });
    selectedEntries = nextSet;
  }

  /** Invert selection (Num *). */
  export function invertSelection() {
    const nextSet = new Set(selectedEntries);
    filteredEntries.forEach((entry) => {
      if (entry.name === "..") return;
      if (nextSet.has(entry.name)) {
        nextSet.delete(entry.name);
      } else {
        nextSet.add(entry.name);
      }
    });
    selectedEntries = nextSet;
  }

  /** Go back in history (Alt + Left). */
  export async function goBack() {
    if (historyIndex > 0) {
      historyIndex--;
      const path = history[historyIndex];
      await loadDirectory(path);
    }
  }

  /** Go forward in history (Alt + Right). */
  export async function goForward() {
    if (historyIndex < history.length - 1) {
      historyIndex++;
      const path = history[historyIndex];
      await loadDirectory(path);
    }
  }

  /** Save current selection filenames. */
  export function handleSaveSelection() {
    savedSelection = Array.from(selectedEntries).filter((name) => name !== "..");
  }

  /** Restore selection from saved filenames. */
  export function handleRestoreSelection() {
    if (savedSelection.length === 0) return;
    const existingNames = new Set(entries.map((e) => e.name));
    const nextSet = new Set(selectedEntries);
    savedSelection.forEach((name) => {
      if (existingNames.has(name)) {
        nextSet.add(name);
      }
    });
    selectedEntries = nextSet;
  }

  // ---------- Keyboard Navigation Engine ----------
  function handleKeydown(e: KeyboardEvent) {
    if (!isActive) return;

    // Don't intercept if renaming
    if (renamingIndex !== null) return;

    // Don't intercept if an overlay is open
    if (overlayActive) return;

    // Don't intercept native text controls or CodeMirror's nested
    // contenteditable node. The listener lives on window, so the event target
    // can be a child of the editable element rather than the element itself.
    const target = e.target;
    // MenuBar and FunctionKeyBar intentionally dispatch shortcuts on `window`.
    // `window` is an EventTarget but not an HTMLElement, so calling `.closest()`
    // on it used to throw before the requested file action could run.
    if (target instanceof HTMLElement && (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable ||
      target.closest('[contenteditable="true"]')
    )) {
      return;
    }

    if (showQuickSearch) return;

    if (e.key === "Escape" && calculatingDirs.size > 0) {
      e.preventDefault();
      cancelDirSizeCalcs();
      return;
    }

    if (e.defaultPrevented || shellShortcut(e)) return;
    if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      const sort = ({ F3: "name", F4: "extension", F5: "modified", F6: "size" } as const)[e.key as "F3" | "F4" | "F5" | "F6"];
      if (sort) { e.preventDefault(); handleSort(sort); return; }
    }
    // Unassigned modified function keys must never fall through to copy/move/delete.
    if (/^F\d+$/.test(e.key) && (e.ctrlKey || e.metaKey)) return;
    if (/^F\d+$/.test(e.key) && e.altKey && !["F5", "F9"].includes(e.key)) return;

    switch (e.key) {
      case "ArrowRight":
        if (e.altKey) {
          e.preventDefault();
          goForward();
        }
        break;

      case "ArrowLeft":
        if (e.altKey) {
          e.preventDefault();
          goBack();
        }
        break;

      case "ArrowDown":
        e.preventDefault();
        if (selectedIndex < filteredEntries.length - 1) {
          if (e.shiftKey) toggleSelection(selectedIndex);
          selectedIndex++;
          scrollToIndex(selectedIndex);
        }
        break;

      case "ArrowUp":
        e.preventDefault();
        if (selectedIndex > 0) {
          if (e.shiftKey) toggleSelection(selectedIndex);
          selectedIndex--;
          scrollToIndex(selectedIndex);
        }
        break;

      case "Enter":
      case "NumpadEnter":
        e.preventDefault();
        if ((e.altKey || e.ctrlKey) && e.shiftKey) {
          calcAllDirSizes();
        } else if (e.ctrlKey && e.altKey) {
          const entry = filteredEntries[selectedIndex];
          if (!entry) break;
          if (!entry.is_dir && requestOpen(getFullPath(entry), "open")) break;
          enterEntry(selectedIndex);
        } else if (e.altKey) {
          handleShowProperties();
        } else if (filteredEntries[selectedIndex]) {
          enterEntry(selectedIndex);
        }
        break;

      case "Backspace":
        e.preventDefault();
        goUp();
        break;

      case "Home":
        e.preventDefault();
        selectedIndex = 0;
        scrollToIndex(0);
        break;

      case "End":
        e.preventDefault();
        selectedIndex = Math.max(0, filteredEntries.length - 1);
        scrollToIndex(selectedIndex);
        break;

      case "PageDown":
        e.preventDefault();
        {
          const pageSize = Math.max(1, Math.floor(containerHeight / ROW_HEIGHT) - 1);
          selectedIndex = Math.max(0, Math.min(selectedIndex + pageSize, filteredEntries.length - 1));
          scrollToIndex(selectedIndex);
        }
        break;

      case "PageUp":
        e.preventDefault();
        {
          const pageSize = Math.max(1, Math.floor(containerHeight / ROW_HEIGHT) - 1);
          selectedIndex = Math.max(selectedIndex - pageSize, 0);
          scrollToIndex(selectedIndex);
        }
        break;

      case " ":
        e.preventDefault();
        // On directories: calculate size. On any entry: toggle selection + move down.
        if (filteredEntries[selectedIndex]?.is_dir) {
          calcDirSize();
        }
        toggleSelection(selectedIndex);
        if (selectedIndex < filteredEntries.length - 1) selectedIndex++;
        scrollToIndex(selectedIndex);
        break;

      case "Insert":
        e.preventDefault();
        toggleSelection(selectedIndex);
        if (selectedIndex < filteredEntries.length - 1) selectedIndex++;
        scrollToIndex(selectedIndex);
        break;

      case "Tab":
        e.preventDefault();
        e.stopImmediatePropagation();
        // Switch to opposite panel
        activePanel.set(side === "left" ? "right" : "left");
        break;

      case "+":
        if (e.ctrlKey) {
          e.preventDefault();
          selectAll();
        } else if (e.altKey) {
          e.preventDefault();
          selectSameExtension();
        } else {
          e.preventDefault();
          openDialog({
            type: "select_group",
            inputValue: "*",
            sourceDir: currentPath,
          });
        }
        break;

      case "-":
        if (e.ctrlKey) {
          e.preventDefault();
          unselectAll();
        } else if (e.altKey) {
          e.preventDefault();
          unselectSameExtension();
        } else {
          e.preventDefault();
          openDialog({
            type: "unselect_group",
            inputValue: "*",
            sourceDir: currentPath,
          });
        }
        break;

      case "*":
        e.preventDefault();
        invertSelection();
        break;

      case "/":
        e.preventDefault();
        unselectAll();
        break;

      case "F2":
        e.preventDefault();
        if (e.shiftKey) {
          window.dispatchEvent(new CustomEvent("nc:menu-action", { detail: "compare-dirs" }));
        } else {
          startRename();
        }
        break;

      case "F3":
        e.preventDefault();
        {
          const entry = filteredEntries[selectedIndex];
          if (!entry) break;
          const fullPath = getFullPath(entry);
          if (!entry.is_dir && requestOpen(fullPath, "view")) break;
          enterEntry(selectedIndex);
        }
        break;

      case "F4":
        e.preventDefault();
        {
          const entry = filteredEntries[selectedIndex];
          if (!entry) break;
          const fullPath = getFullPath(entry);
          if (!entry.is_dir && requestOpen(fullPath, "edit")) break;
          enterEntry(selectedIndex);
        }
        break;

      case "F5":
        if (e.altKey) {
          e.preventDefault();
          handlePack();
        } else {
          e.preventDefault();
          handleCopy();
        }
        break;

      case "F6":
        e.preventDefault();
        handleMove();
        break;

      case "F7":
        e.preventDefault();
        handleMkDir();
        break;

      case "Delete":
      case "F8":
        e.preventDefault();
        handleDelete(e.shiftKey);
        break;

      case "F9":
        if (e.altKey) {
          e.preventDefault();
          if (e.shiftKey) handleTestArchive();
          else handleUnpack();
        }
        // Plain F9 is handled globally in +page.svelte (taskProgress.toggle());
        // dispatching "task-manager" here too would force it open right after
        // the toggle, cancelling out every other press.
        break;

      case "F10":
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("nc:menu-action", { detail: "command-palette" }));
        break;

      default:
        // Ctrl+key shortcuts
        if (e.ctrlKey && !e.altKey && !e.metaKey) {
          switch (e.key.toLowerCase()) {
            case "f":
              e.preventDefault();
              showQuickSearch = true;
              tick().then(() => searchInputEl?.focus());
              break;
            case "a":
              e.preventDefault();
              selectAll();
              break;
            case "u":
              e.preventDefault();
              window.dispatchEvent(new CustomEvent("nc:menu-action", { detail: e.shiftKey ? "equalize-panels" : "swap-panels" }));
              break;
            case "d":
              e.preventDefault();
              window.dispatchEvent(new CustomEvent("nc:menu-action", { detail: "hotlist" }));
              break;
            case "m":
              e.preventDefault();
              handleMultiRename();
              break;
            case "c":
              e.preventDefault();
              handleCopyClipboard();
              break;
            case "x":
              e.preventDefault();
              handleCut();
              break;
            case "v":
              e.preventDefault();
              handlePaste();
              break;
            case "q":
              e.preventDefault();
              window.dispatchEvent(new CustomEvent("nc:menu-action", { detail: "quick-view" }));
              break;
            case "n":
              e.preventDefault();
              handleSort("name");
              break;
            case "e":
              e.preventDefault();
              handleSort("extension");
              break;
            case "s":
              e.preventDefault();
              handleSort("size");
              break;
            case "t":
              e.preventDefault();
              handleTabNew();
              break;
            case "w":
              e.preventDefault();
              handleTabCloseCurrent();
              break;
          }
          
          return;
        }

        // Quick search
        if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
          const char = e.key.toLowerCase();
          const startIdx = selectedIndex + 1;
          let found = -1;
          for (let i = 0; i < filteredEntries.length; i++) {
            const idx = (startIdx + i) % filteredEntries.length;
            if (filteredEntries[idx].name.toLowerCase().startsWith(char)) {
              found = idx;
              break;
            }
          }
          if (found >= 0) {
            selectedIndex = found;
            scrollToIndex(found);
          }
        }
        break;
    }
  }

  function toggleSelection(filteredIdx: number) {
    const entry = filteredEntries[filteredIdx];
    if (!entry || entry.name === "..") return;

    const newSet = new Set(selectedEntries);
    if (newSet.has(entry.name)) {
      newSet.delete(entry.name);
    } else {
      newSet.add(entry.name);
    }
    selectedEntries = newSet;
  }

  function getSortIndicator(column: SortColumn): string {
    if (sortColumn !== column) return "";
    return sortAsc ? " ▲" : " ▼";
  }

  // ---------- Derived stats ----------
  let totalFiles = $derived(entries.filter((e) => !e.is_dir).length);
  let totalDirs = $derived(entries.filter((e) => e.is_dir && e.name !== "..").length);
  let totalSize = $derived(
    entries.filter((e) => !e.is_dir).reduce((sum, e) => sum + e.size, 0)
  );
  // Derive both from the live entry list, never from the raw name set: a mark
  // whose entry is gone (deleted/moved) must not survive in the status bar even
  // if some refresh path forgets to prune it.
  let markedEntries = $derived(
    selectedEntries.size === 0
      ? []
      : entries.filter((e) => e.name !== ".." && selectedEntries.has(e.name))
  );
  let selectedCount = $derived(markedEntries.length);
  let selectedSize = $derived(
    markedEntries.reduce((sum, e) => (e.is_dir ? sum : sum + e.size), 0)
  );

  // ---------- Dialog confirmation handler ----------
  // The main page orchestrates this, but we need to expose refresh and path.
  // We listen to the dialog store and handle confirmations centrally.
  let currentDialog = $state<typeof $dialogState | null>(null);

  // ---------- Columns Logic ----------
  function evaluateField(field: string, entry: FileEntry): string {
    if (!field) return "";
    
    // Support both natural names and legacy tags
    const cleanField = field
      .replace(/[\[\]]/g, "") // remove brackets
      .replace(/\(\)/g, "")   // remove parentheses
      .replace(/GET/i, "")    // remove GET keyword
      .replace(/\{.*?\}/g, "") // remove parameters in curly braces
      .replace(/^(NC|DC)\./i, "") // remove NC. or DC. prefix
      .trim()
      .toUpperCase();
    
    switch (cleanField) {
      case "FILENAME": return isSearchResultsView ? (entry.path || entry.name) : entry.name;
      case "FILEEXT": return entry.extension;
      case "FILESIZE":
        if (entry.is_dir) {
          const size = calculatedDirs.has(entry.name) ? dirSizes[entry.name] : undefined;
          return size !== undefined ? (formatSize(size, showFileSizesInBytes) || "0") : "<DIR>";
        }
        return formatSize(entry.size, showFileSizesInBytes) || "0";
      case "FILETIME": return formatDate(entry.modified);
      case "FILEATTR": return formatPermissions(entry);
      case "FILEPERM": return formatPermissions(entry);
      case "FILEOWNER": return entry.owner;
      case "FILEGROUP": return entry.group;
      case "FILEPATH": return entry.path || currentPath;
      case "FILECREATIONTIME": return entry.created ? formatDate(entry.created) : "";
      case "FILELASTACCESSTIME": return entry.accessed ? formatDate(entry.accessed) : "";
      case "FILECHANGETIME": return entry.changed ? formatDate(entry.changed) : "";
      case "FILELINKTO": return entry.link_target || "";
      case "FILENAMENOEXT": {
        const lastDot = entry.name.lastIndexOf('.');
        return lastDot > 0 ? entry.name.substring(0, lastDot) : entry.name;
      }
      case "FILETYPE": {
        if (entry.is_dir) return $_('panel.directory') || "Directory";
        return entry.extension ? (entry.extension.toUpperCase() + " " + ($_('panel.file') || "File")) : ($_('panel.file') || "File");
      }
      case "FILECOMMENT": return "";
      case "FILECOMPRESSEDSIZE": return formatSize(entry.compressed_size || entry.size, showFileSizesInBytes);
      default: return field;
    }
  }

  let dynamicColumns = $derived.by(() => {
    const configuredColumns = $appConfigStore?.columns;
    const source = (savedColumns && savedColumns.length > 0)
      ? savedColumns
      : (configuredColumns && configuredColumns.length > 0)
        ? configuredColumns
        : DEFAULT_COLUMNS;
    
    return source.map((c, i) => {
      const field = c.field_contents.toUpperCase();
      let label = c.caption;
      
      // Map standard fields to translated labels
      if (field.includes("FILENAME")) label = $_('panel.name') || "Name";
      else if (field.includes("FILEEXT")) label = $_('panel.ext') || "Ext";
      else if (field.includes("FILESIZE")) label = $_('panel.size') || "Size";
      else if (field.includes("FILETIME")) label = $_('panel.date') || "Date";
      else if (field.includes("FILEATTR")) label = $_('panel.attr') || "Attr";

      if (typeof label === "string" && label.includes(".")) {
        const fallbackLabels: Record<string, string> = {
          "panel.name": "Name",
          "panel.ext": "Ext",
          "panel.size": "Size",
          "panel.date": "Date",
          "panel.attr": "Attr",
        };
        label = fallbackLabels[label] || label;
      }

      return {
        id: `col-${i}`,
        label,
        width: c.width,
        minWidth: 50,
        field: c.field_contents,
        align: c.align
      };
    });
  });

  function getColStyle(col: any) {
    return `width: ${col.width}px; flex-shrink: 0;`;
  }

  // Resizing logic
  let resizingColIdx = $state<number | null>(null);
  let startX = 0;
  let startWidth = 0;

  function handleResizeStart(e: MouseEvent, index: number) {
    e.preventDefault();
    e.stopPropagation();
    
    // Ensure savedColumns is initialized with current columns from config if it's empty
    if (!savedColumns || savedColumns.length === 0) {
      const source = ($appConfigStore?.columns && $appConfigStore.columns.length > 0)
        ? $appConfigStore.columns
        : DEFAULT_COLUMNS;
      // We must deep copy/clone so we don't mutate the store state during dragging
      savedColumns = JSON.parse(JSON.stringify(source));
    }
    
    const col = dynamicColumns[index];
    if (!col) return;
    
    resizingColIdx = index;
    startX = e.clientX;
    startWidth = Number(col.width);
    window.addEventListener("mousemove", handleResizeMove);
    window.addEventListener("mouseup", handleResizeEnd);
  }

  function handleResizeMove(e: MouseEvent) {
    if (resizingColIdx === null) return;
    const diff = e.clientX - startX;
    const newWidth = Math.max(50, startWidth + diff);
    
    if (savedColumns && savedColumns.length > 0) {
      savedColumns[resizingColIdx].width = newWidth;
      
      // Notify other pane to sync widths
      window.dispatchEvent(new CustomEvent("nc:columns-sync", {
        detail: { columns: savedColumns, sender: side }
      }));
    }
  }

  async function handleResizeEnd() {
    resizingColIdx = null;
    window.removeEventListener("mousemove", handleResizeMove);
    window.removeEventListener("mouseup", handleResizeEnd);
    
    // Persist changes to settings
    if (!$appConfigStore) return;
    
    // Sanitize: strip proxies and ensure correct types
    const cleanColumns = JSON.parse(JSON.stringify(savedColumns));
    updateSettings((cfg) => {
      cfg.columns = cleanColumns.map((c: any) => ({
        ...c,
        width: Math.round(Number(c.width)) || 100
      }));
    });

    // Reset savedColumns to let dynamicColumns derive directly from the updated store
    savedColumns = [];
    window.dispatchEvent(new CustomEvent("nc:columns-sync", {
      detail: { columns: [], sender: side }
    }));
  }

  function getOptimalColWidth(index: number): number {
    const col = dynamicColumns[index];
    if (!col) return 100;
    
    const isName = col.field.toUpperCase().includes("FILENAME");
    const isDate = col.field.toUpperCase().includes("FILETIME");
    
    let maxText = col.label;
    let maxWidth = 0;
    
    // Scan all entries to find max length
    for (const entry of entries) {
      let val = "";
      if (isName) {
        if (entry.name === "..") {
          val = "[..]";
        } else if (entry.is_dir && showFolderBrackets) {
          val = `[${entry.name}]`;
        } else {
          val = entry.name;
        }
      } else if (col.field.toUpperCase().includes("FILESIZE") && entry.is_dir && calculatingDirs.has(entry.name)) {
        val = "???";
      } else {
        val = evaluateField(col.field, entry) || "";
      }
      
      if (val.length > maxText.length) {
        maxText = val;
      }
    }
    
    // Use canvas measurement
    try {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (ctx) {
        const rootStyle = getComputedStyle(document.documentElement);
        let fontFamily = rootStyle.getPropertyValue("--font-pane-name").trim() || "Inter, sans-serif";
        const fontSize = rootStyle.getPropertyValue("--font-pane-size").trim() || "12px";
        if (isDate) {
          fontFamily = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace';
        }
        ctx.font = `${fontSize} ${fontFamily}`;
        
        // Measure each value to find the true pixel max
        maxWidth = ctx.measureText(col.label).width;
        for (const entry of entries) {
          let val = "";
          if (isName) {
            if (entry.name === "..") val = "[..]";
            else if (entry.is_dir && showFolderBrackets) val = `[${entry.name}]`;
            else val = entry.name;
          } else if (col.field.toUpperCase().includes("FILESIZE") && entry.is_dir && calculatingDirs.has(entry.name)) {
            val = "???";
          } else {
            val = evaluateField(col.field, entry) || "";
          }
          const w = ctx.measureText(val).width;
          if (w > maxWidth) maxWidth = w;
        }
      }
    } catch (e) {
      // Fallback
      maxWidth = maxText.length * 8;
    }
    
    // Add extra padding (icon, spacing, symlink icon, resizer gap)
    let padding = 16; 
    if (isName) {
      padding += 32; // Icon (16px) + gaps
      if (entries.some(e => e.is_symlink)) {
        padding += 16;
      }
    }
    
    return Math.max(50, Math.ceil(maxWidth + padding));
  }

  async function handleResizeDoubleClick(e: MouseEvent, index: number) {
    e.preventDefault();
    e.stopPropagation();
    
    // Ensure savedColumns is initialized
    if (!savedColumns || savedColumns.length === 0) {
      const source = ($appConfigStore?.columns && $appConfigStore.columns.length > 0)
        ? $appConfigStore.columns
        : DEFAULT_COLUMNS;
      savedColumns = JSON.parse(JSON.stringify(source));
    }
    
    const optimalWidth = getOptimalColWidth(index);
    savedColumns[index].width = optimalWidth;
    
    // Notify other pane to sync widths
    window.dispatchEvent(new CustomEvent("nc:columns-sync", {
      detail: { columns: savedColumns, sender: side }
    }));
    
    // Persist changes to settings
    if ($appConfigStore) {
      const cleanColumns = JSON.parse(JSON.stringify(savedColumns));
      updateSettings((cfg) => {
        cfg.columns = cleanColumns.map((c: any) => ({
          ...c,
          width: Math.round(Number(c.width)) || 100
        }));
      });

      // Reset savedColumns to let dynamicColumns derive directly from the updated store
      savedColumns = [];
      window.dispatchEvent(new CustomEvent("nc:columns-sync", {
        detail: { columns: [], sender: side }
      }));
    }
  }

  function getColClass(id: string) {
    return `col-${id}`;
  }

  function getCellClass(id: string) {
    return `cell-${id}`;
  }
</script>


<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  bind:this={panelEl}
  tabindex="-1"
  class="file-panel {side}"
  class:active={isActive}
  onclick={handlePanelFocus}
>
  <DriveBar {currentPath} onselect={(p) => { if (!overlayActive) loadDirectory(p); }} onspacechange={(s) => driveFreeSpace = s} />



  <!-- Quick Search Overlay -->
  {#if showQuickSearch}
    <div class="quick-search-overlay" transition:fade={{ duration: 100 }}>
      <span class="search-icon">🔍</span>
      <input
        bind:this={searchInputEl}
        type="text"
        bind:value={filterText}
        placeholder={$_("filelist.filter_placeholder")}
        onkeydown={handleQuickSearch}
        onblur={() => { if (!filterText) showQuickSearch = false; }}
      />
      {#if filterText}
        <button class="clear-search" onclick={() => filterText = ""}>✕</button>
      {/if}
    </div>
  {/if}

  {#if $appConfigStore?.show_folder_tabs}
    <FolderTabs
      {tabs}
      {activeTabId}
      onselect={handleTabSelect}
      onclose={handleTabClose}
      onnew={handleTabNew}
      onreorder={handleTabReorder}
      onduplicate={handleTabDuplicate}
      onrename={handleTabRename}
      onlock={handleTabLock}
      oncloseothers={handleTabCloseOthers}
    />
  {/if}

  <div class="path-toolbar">
  <!-- Directory Header -->
  <div class="panel-header">
    <button class="up-btn" onclick={() => { if (overlayActive) return; goUp(); }} title={$_("filelist.go_up")}>↑</button>
    <div
      class="path-display"
      title={currentPath}
      onpointerdown={handlePathLongPressStart}
      onpointermove={handleLongPressMove}
      onpointerup={handleLongPressEnd}
      onpointercancel={handleLongPressEnd}
      oncontextmenu={startPathEdit}
    >
      {#if pathEditActive}
        <input
          bind:this={pathInputEl}
          class="path-input"
          type="text"
          bind:value={pathEditValue}
          spellcheck="false"
          oninput={resetPathEditTimer}
          onkeydown={handlePathEditKeydown}
          onpointerdown={handlePathLongPressStart}
          onpointermove={handleLongPressMove}
          onpointerup={handleLongPressEnd}
          onpointercancel={handleLongPressEnd}
          oncontextmenu={showPathInputMenu}
          onclick={(e) => { e.stopPropagation(); resetPathEditTimer(); }}
        />
      {:else}
        {#each currentPath.split("/").filter(Boolean) as part, i}
          <span class="crumb" onclick={() => { if (overlayActive) return; loadDirectory("/" + currentPath.split("/").filter(Boolean).slice(0, i + 1).join("/")); }}>
            {part}
          </span>
          <span class="sep">/</span>
        {:else}
          <span class="crumb root-crumb" onclick={() => { if (overlayActive) return; loadDirectory("/"); }}>/</span>
        {/each}
      {/if}
    </div>
    <div class="header-ops">
      <button class="op-btn" onclick={() => { if (overlayActive) return; invertSelection(); }} title={$_("filelist.invert_selection")}>*</button>
      <button class="op-btn search-op-btn" onclick={() => { if (overlayActive) return; showQuickSearch = true; tick().then(() => searchInputEl?.focus()); }} title={$_("filelist.filter_hint")}>⌕</button>
      <button class="op-btn" onclick={() => { if (overlayActive) return; loadDirectory("/"); }} title={$_("filelist.go_root")}>/</button>
      <button class="op-btn" onclick={() => { if (overlayActive) return; goUp(); }} title={$_("filelist.go_parent")}>..</button>
      <button class="op-btn" onclick={async () => { if (overlayActive) return; const home = await getHomeDir(); loadDirectory(home); }} title={$_("filelist.go_home")}>~</button>
      <button class="op-btn" onclick={() => { if (overlayActive) return; goBack(); }} title={$_("filelist.go_back")}>&lt;</button>
    </div>
  </div>
  </div>

  <!-- Column Headers -->
  <div class="column-headers" class:resizing={resizingColIdx !== null}>
    {#each dynamicColumns as col, i}
      <div 
        class="col-header-container" 
        style={getColStyle(col)}
      >
        <button
          class="col-header"
          onclick={() => {
            const f = col.field.toUpperCase();
            if (f.includes("FILENAME")) handleSort("name");
            else if (f.includes("FILEEXT")) handleSort("extension");
            else if (f.includes("FILESIZE")) handleSort("size");
            else if (f.includes("FILETIME")) handleSort("modified");
          }}
        >
          {col.label}{getSortIndicator(
            col.field.toUpperCase().includes("FILENAME") ? "name" : 
            col.field.toUpperCase().includes("FILEEXT") ? "extension" : 
            col.field.toUpperCase().includes("FILESIZE") ? "size" : 
            col.field.toUpperCase().includes("FILETIME") ? "modified" : "name"
          )}
        </button>
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div 
          class="col-resizer" 
          onmousedown={(e) => handleResizeStart(e, i)}
          ondblclick={(e) => handleResizeDoubleClick(e, i)}
        ></div>
      </div>
    {/each}
    <div class="col-filler" style="flex: 1;"></div>
  </div>

  <!-- Virtual Scrolling File List -->
  <div
    class="file-list"
    class:drag-over={isDraggingOver}
    ondragover={handleDragOver}
    ondragenter={handleDragEnter}
    ondragleave={handleDragLeave}
    ondrop={handleDrop}
    onmouseenter={() => isMouseInPanel = true}
    onmouseleave={() => isMouseInPanel = false}
    bind:this={scrollContainer}
    onscroll={handleScroll}
    onwheel={handleFileListWheel}
    onpointerdown={(e) => handleLongPressStart(e, null)}
    onpointermove={handleLongPressMove}
    onpointerup={handleLongPressEnd}
    onpointercancel={handleLongPressEnd}
    onpointerleave={handleLongPressEnd}
    oncontextmenu={(e) => {
      if (isCoarsePointer()) {
        e.preventDefault();
        return;
      }
      showContextMenu(e, null);
    }}
    style="--row-icon-size: {ICON_SIZE}px;"
  >
      {#if loading && entries.length === 0}
        <div class="loading-overlay" transition:fade>
          <div class="spinner"></div>
          <p>{$_("filelist.loading")}</p>
        </div>
      {:else if error}
        <div class="error-msg">
          <span class="error-icon">⚠️</span>
          <p>{error}</p>
          <button class="refresh-btn" onclick={() => { if (overlayActive) return; refresh(); }}>{$_("filelist.try_again")}</button>
        </div>
      {:else if filteredEntries.length === 0}
            <div class="empty-state">
              <span class="empty-icon">📂</span>
              <p>{$_("filelist.empty")}</p>
              <button class="refresh-btn" onclick={() => { if (overlayActive) return; refresh(); }}>{$_("filelist.refresh")}</button>
            </div>
      {:else}
        <!-- Virtual scroll spacer -->
        <div style="height: {totalHeight}px; position: relative;">
          <div style="position: absolute; top: {offsetY}px; left: 0; right: 0;">
            {#each visibleEntries as entry, vi (entry.name)}
              {@const i = visibleStart + vi}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                class="file-row"
                class:selected={i === selectedIndex}
                class:marked={selectedEntries.has(entry.name)}
                class:dir={entry.is_dir}
                class:brief-mode={viewMode === "brief"}
                class:alt-row={$appConfigStore?.show_alternating_row_colors && (i % 2 === 1)}
                class:is-active-left={side === "left" && isActive}
                class:is-active-right={side === "right" && isActive}
                class:is-cut={clipState.operation === 'cut' && clipState.paths.includes(getFullPath(entry))}
                draggable={renamingIndex === null}
                ondragstart={(e) => { if (overlayActive || renamingIndex !== null) { e.preventDefault(); return; } handleDragStart(e, i); }}
                onpointerdown={(e) => {
                  if (renamingIndex !== null) return;
                  e.stopPropagation();
                  handleLongPressStart(e, i);
                }}
                onpointermove={handleLongPressMove}
                onpointerup={handleLongPressEnd}
                onpointercancel={handleLongPressEnd}
                onclick={(e) => {
                  if (renamingIndex !== null && renamingIndex === i) return;
                  handleEntryClick(e, i);
                }}
                ondblclick={() => { if (overlayActive || renamingIndex !== null) return; enterEntry(i); }}

                oncontextmenu={(e) => {
                  if (overlayActive) { e.preventDefault(); return; }
                  if (isCoarsePointer()) {
                    e.preventDefault();
                    return;
                  }
                  if ($appConfigStore?.behavior_selection_mode === "Windows") {
                    // Windows mode: right-click shows context menu
                    showContextMenu(e, i);
                  } else {
                    // NC mode: right-click selects/marks
                    e.preventDefault();
                    e.stopPropagation();
                    if (entry.name !== "..") {
                      if (selectedEntries.has(entry.name)) {
                        selectedEntries.delete(entry.name);
                      } else {
                        selectedEntries.add(entry.name);
                      }
                      selectedEntries = new Set(selectedEntries);
                    }
                    selectedIndex = i;
                    selectionAnchor = i;
                  }
                }}
                style="height: {ROW_HEIGHT}px;"
              >
            <!-- Dynamic Cells -->
            {#each dynamicColumns as col}
              <div 
                class="cell" 
                class:cell-name={col.field.toUpperCase().includes("FILENAME")}
                style="{getColStyle(col as any)} justify-content: {col.align === '->' ? 'flex-end' : 'flex-start'};"
              >
                {#if col.field.toUpperCase().includes("FILENAME")}
                  <span class="dir-icon">
                    {#if entry.name === ".."}
                      <span class="up-arrow">↑</span>
                    {:else if IconRenderer}
                      <IconRenderer
                        name={entry.name}
                        ext={entry.extension}
                        isDir={entry.is_dir}
                        theme={$appConfigStore?.icon_theme || "material"}
                        size={ICON_SIZE}
                      />
                    {:else if $appConfigStore?.icon_theme === 'lucide'}
                      {#if entry.is_dir}📁{:else}📄{/if}
                    {:else}
                      <img
                        src={getFileIconPath(entry.name, entry.extension, entry.is_dir, $appConfigStore?.icon_theme || "material")}
                        alt=""
                        width={ICON_SIZE}
                        height={ICON_SIZE}
                        class="file-icon-img"
                      />
                    {/if}
                  </span>
                  {#if renamingIndex === i}
                    <!-- svelte-ignore a11y_autofocus -->
                    <input
                      bind:this={renameInput}
                      class="rename-input"
                      bind:value={renameValue}
                      onclick={(e) => e.stopPropagation()}
                      onpointerdown={(e) => e.stopPropagation()}
                      onpointerup={(e) => e.stopPropagation()}
                      onpointermove={(e) => e.stopPropagation()}
                      onmousedown={(e) => e.stopPropagation()}
                      onmouseup={(e) => e.stopPropagation()}
                      ondblclick={(e) => e.stopPropagation()}
                      oncontextmenu={(e) => e.stopPropagation()}
                      ondragstart={(e) => e.stopPropagation()}
                      onblur={cancelRename}
                      onkeydown={handleRenameKeydown}
                    />
                  {:else}
                    <span class={getFileColor(entry)}>
                      {#if entry.name === ".."}
                        [..]
                      {:else if entry.is_dir && showFolderBrackets}
                        [{entry.name}]
                      {:else}
                        {entry.name}
                      {/if}
                      {#if entry.is_symlink}
                        <span class="symlink-indicator" title={$_("filelist.symlink_title")}>🔗</span>
                      {/if}
                    </span>
                  {/if}
                {:else}
                  {#if col.field.toUpperCase().includes("FILESIZE") && entry.is_dir && calculatingDirs.has(entry.name)}
                    <span class="size-calculating">???</span>
                  {:else}
                    {evaluateField(col.field, entry)}
                  {/if}
                {/if}
              </div>
            {/each}
            <div class="cell-filler" style="flex: 1;"></div>
          </div>
        {/each}
        </div>
      </div>
    {/if}
  </div>

  <!-- Global Drop Menu Modal removed from here and moved to +page.svelte -->

  <div class="panel-status">
    <div>{$_("filelist.items", { n: filteredEntries.filter((e) => e.name !== "..").length })}</div>
    <div class="status-sep">|</div>
    <div>{$_("filelist.dirs", { n: totalDirs })}</div>
    <div class="status-sep">|</div>
    <div>{$_("filelist.files", { n: totalFiles })}</div>
    {#if selectedCount > 0}
      <div class="status-sep">|</div>
      <div class="status-selected">{$_("filelist.selected", { n: selectedCount, s: formatSize(selectedSize, showFileSizesInBytes) })}</div>
    {/if}
    <div style="flex: 1;"></div>
    <div>{$_("filelist.total", { s: formatSize(totalSize, showFileSizesInBytes) })}</div>
    {#if driveFreeSpace}
      <div class="status-sep">|</div>
      <div>{driveFreeSpace}</div>
    {/if}
  </div>

  {#if actionToast}
    <div class="test-result-toast" class:error={!actionToast.ok} transition:fade>
      <div class="toast-icon">{actionToast.ok ? "✅" : "❌"}</div>
      <div class="toast-msg">{actionToast.msg}</div>
    </div>
  {/if}
</div>

<style lang="css">
  .file-panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    background: var(--color-nc-bg-panel);
    border: 1px solid var(--color-nc-border);
    overflow: hidden;
    position: relative;
    color: var(--color-nc-text);
    font-family: var(--font-main-name);
    font-size: var(--font-main-size);
    outline: none;
  }

  .file-panel.active {
    border-color: var(--color-nc-accent);
    box-shadow: inset 0 0 0 1px var(--color-nc-accent-glow);
  }

  /* Breadcrumbs */
  .breadcrumbs {
    display: flex;
    align-items: center;
    padding: 4px 10px;
    background: var(--color-nc-bg-header);
    border-bottom: 1px solid var(--color-nc-border);
    font-size: 11px;
    color: var(--color-nc-text-dim);
    white-space: nowrap;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .breadcrumbs::-webkit-scrollbar { display: none; }

  .crumb {
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 3px;
  }
  .crumb:hover {
    background: var(--color-nc-bg-hover);
    color: var(--color-nc-text-bright);
  }
  .sep {
    padding: 0 2px;
    opacity: 0.5;
  }

  /* Quick Search Overlay */
  .quick-search-overlay {
    position: absolute;
    bottom: 30px;
    right: 20px;
    background: var(--color-nc-bg-deep);
    border: 1px solid var(--color-nc-accent);
    border-radius: 4px;
    padding: 4px 8px;
    display: flex;
    align-items: center;
    gap: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    z-index: 100;
  }
  .quick-search-overlay input {
    background: transparent;
    border: none;
    color: var(--color-nc-text-bright);
    font-family: var(--font-main-name);
    font-size: var(--font-main-size);
    outline: none;
    width: 150px;
  }
  .search-icon { font-size: 12px; opacity: 0.7; }
  .clear-search {
    background: none;
    border: none;
    color: var(--color-nc-text-dim);
    cursor: pointer;
    font-size: 12px;
    padding: 2px;
  }
  .clear-search:hover { color: var(--color-nc-text-bright); }

  /* Directory Header */
  .panel-header {
    display: flex;
    align-items: center;
    height: 26px;
    background: linear-gradient(
      180deg,
      var(--color-nc-bg-header) 0%,
      var(--color-nc-bg-panel) 100%
    );
    border-bottom: 1px solid var(--color-nc-border);
    padding: 0 4px;
    gap: 4px;
  }

  .up-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    background: transparent;
    border: 1px solid var(--color-nc-border);
    color: var(--color-nc-text-dim);
    font-size: 12px;
    cursor: pointer;
    border-radius: 2px;
    transition: all 0.15s ease;
  }

  .up-btn:hover {
    background: var(--color-nc-bg-hover);
    color: var(--color-nc-accent);
    border-color: var(--color-nc-accent-dim);
  }

  .path-display {
    flex: 1;
    font-family: var(--font-header-name);
    font-size: var(--font-header-size);
    color: var(--color-nc-text-bright);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: left;
    display: flex;
    align-items: center;
    min-width: 0;
  }

  .path-input {
    width: 100%;
    height: 20px;
    min-width: 0;
    box-sizing: border-box;
    border: 1px solid var(--color-nc-accent);
    background: var(--color-nc-bg-panel);
    color: var(--color-nc-text);
    -webkit-text-fill-color: var(--color-nc-text);
    caret-color: var(--color-nc-accent);
    font: inherit;
    padding: 1px 4px;
    outline: none;
    user-select: text;
  }

  .path-input::selection {
    background: var(--color-nc-accent) !important;
    color: #ffffff !important;
    -webkit-text-fill-color: #ffffff !important;
  }

  .header-ops {
    display: flex;
    align-items: center;
    gap: 2px;
    margin-left: 4px;
  }

  .dir-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    margin-right: 8px;
    opacity: 0.8;
    flex-shrink: 0;
  }

  .up-arrow {
    color: var(--color-nc-accent);
    font-weight: bold;
    font-size: var(--row-icon-size, 14px);
    margin-right: 0;
    line-height: 1;
  }
  .op-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 20px;
    height: 20px;
    background: transparent;
    border: 1px solid transparent;
    color: var(--color-nc-text-dim);
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    border-radius: 2px;
    transition: all 0.1s;
    padding: 0 4px;
  }

  .op-btn:hover {
    background: var(--color-nc-bg-hover);
    color: var(--color-nc-accent);
    border-color: var(--color-nc-border);
  }

  /* Column Headers */
  .column-headers {
    display: flex;
    height: 22px;
    background: var(--color-nc-bg-panel);
    border-bottom: 1px solid var(--color-nc-border);
    font-size: var(--font-header-size);
  }

  .col-header-container {
    display: flex;
    align-items: center;
    position: relative;
    border-right: 1px solid var(--color-nc-border);
  }

  .col-header {
    display: flex;
    align-items: center;
    padding: 0 6px;
    background: transparent;
    border: none;
    flex: 1;
    height: 100%;
    color: var(--color-nc-text-dim);
    font-family: var(--font-header-name);
    font-size: var(--font-header-size);
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.15s ease;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .col-header:hover {
    background: var(--color-nc-bg-hover);
    color: var(--color-nc-accent);
  }

  .col-name { min-width: 0; }
  .col-size { justify-content: flex-end; }

  .col-resizer {
    position: absolute;
    top: 0;
    right: -3px;
    width: 6px;
    height: 100%;
    cursor: col-resize;
    z-index: 10;
    transition: background 0.15s;
  }

  .col-resizer:hover, .column-headers.resizing .col-resizer {
    background: var(--color-nc-accent);
  }

  .column-headers.resizing {
    cursor: col-resize;
    user-select: none;
  }

  /* File List - Virtual Scrolling Container */
  .file-list {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    background: var(--color-nc-bg);
    position: relative;
    transition: all 0.2s ease;
  }

  .file-list.drag-over {
    background: rgba(var(--color-nc-accent-rgb), 0.05);
    box-shadow: inset 0 0 0 2px var(--color-nc-accent);
  }


  .file-row {
    display: flex;
    align-items: center;
    cursor: default;
    transition: background 0.06s ease;
    border-bottom: 1px solid transparent;
    box-sizing: border-box;
    user-select: none;
    -webkit-user-select: none;
  }
  
  .file-row::selection {
    background: transparent;
  }

  .file-row.is-cut {
    opacity: 0.5;
  }

  .file-row:hover {
    background: var(--color-nc-bg-hover);
  }

  .file-row.alt-row:not(.selected):not(:hover) {
    background: var(--color-nc-bg-alt);
  }

  .file-row.selected {
    background: var(--color-nc-bg-selected);
    border-bottom-color: var(--color-nc-border);
  }

  .file-panel.active .file-row.selected {
    background: var(--color-nc-bg-active);
    box-shadow: inset 3px 0 0 var(--color-nc-accent);
  }

  .file-row.brief-mode {
    display: inline-flex;
    width: 200px; /* Fixed width for brief columns */
    border-right: 1px solid var(--color-nc-border);
  }

  .file-row.brief-mode .cell:not(.cell-name) {
    display: none;
  }

  .file-row.marked {
    color: var(--color-nc-marked) !important;
  }

  .file-row.marked .cell-name {
    color: var(--color-nc-marked) !important;
    font-weight: 600;
  }

  .symlink-indicator {
    color: var(--color-nc-accent);
    font-size: 10px;
    opacity: 0.8;
  }

  .cell {
    display: flex;
    align-items: center;
    padding: 0 8px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: var(--font-pane-name);
    font-size: var(--font-pane-size);
    user-select: none;
  }


  .cell-name { min-width: 0; gap: 7.2px; }
  .cell-ext { color: var(--color-nc-text-dim); font-size: var(--font-pane-size); }
  .cell-size {
    justify-content: flex-end;
    color: var(--color-nc-text-dim);
    font-size: var(--font-pane-size);
    font-variant-numeric: tabular-nums;
  }
  .cell-date {
    color: var(--color-nc-text-dim);
    font-size: var(--font-pane-size);
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  }
  .cell-perm { color: var(--color-nc-text-dim); font-size: 10px; }

  .dir-icon { font-size: max(13px, var(--font-pane-size, 12px)); flex-shrink: 0; display: flex; align-items: center; }

  .file-icon-img {
    display: block;
    flex-shrink: 0;
  }

  /* Inline Rename */
  .rename-input {
    width: 100%;
    padding: 1px 4px;
    background: var(--color-nc-bg-deep);
    border: 1px solid var(--color-nc-accent);
    border-radius: 2px;
    color: var(--color-nc-text-bright);
    font-family: var(--font-pane-name);
    font-size: var(--font-pane-size);
    outline: none;
    box-shadow: 0 0 0 2px var(--color-nc-accent-glow);
    user-select: text;
    -webkit-user-select: text;
    cursor: text;
  }

  .rename-input::selection {
    background: var(--color-nc-accent) !important;
    color: #ffffff !important;
    -webkit-text-fill-color: #ffffff !important;
  }

  /* Status Bar */
  .panel-status {
    display: flex;
    align-items: center;
    min-height: 22px;
    height: auto;
    background: var(--color-nc-bg-panel);
    border-top: 1px solid var(--color-nc-border);
    padding: 2px 8px;
    font-family: var(--font-status-name, var(--font-pane-name));
    font-size: var(--font-status-size, var(--font-pane-size));
    color: var(--color-nc-text-dim);
    gap: 6px;
    flex-shrink: 0;
  }

  .status-selected {
    color: var(--color-nc-marked);
    font-weight: 500;
  }

  .status-sep {
    color: var(--color-nc-border);
  }

  /* Loading / Error / Empty */
  .loading,
  .error,
  .empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    font-size: 13px;
    color: var(--color-nc-text-dim);
    gap: 8px;
  }

  .loading-spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid var(--color-nc-border);
    border-top-color: var(--color-nc-accent);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .error {
    color: var(--color-nc-danger);
  }

  .error-msg {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: 32px 20px;
    text-align: center;
    gap: 12px;
    color: var(--color-nc-text);
  }

  .error-icon {
    font-size: 32px;
    line-height: 1;
  }

  .error-msg p {
    color: var(--color-nc-danger);
    font-size: 13px;
    font-weight: 500;
    max-width: 380px;
    word-break: break-word;
    margin: 0;
    line-height: 1.4;
  }
  /* Drive Selector */
  .drive-selector {
    position: relative;
    margin-right: 4px;
  }

  .drive-btn {
    background: var(--color-nc-bg-header);
    border: 1px solid var(--color-nc-border-bright);
    color: var(--color-nc-accent);
    padding: 2px 8px;
    border-radius: 3px;
    font-size: 11px;
    font-weight: bold;
    cursor: pointer;
    white-space: nowrap;
  }

  .drive-menu {
    position: absolute;
    top: 100%;
    left: 0;
    margin-top: 4px;
    background: var(--color-nc-bg-panel);
    border: 1px solid var(--color-nc-border-bright);
    border-radius: 4px;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
    z-index: 1000;
    min-width: 250px;
    padding: 4px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .drive-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: transparent;
    border: none;
    color: var(--color-nc-text);
    text-align: left;
    cursor: pointer;
    border-radius: 3px;
    font-size: 12px;
  }

  .drive-item:hover {
    background: var(--color-nc-bg-hover);
    color: var(--color-nc-text-bright);
  }

  .drive-path {
    font-size: 10px;
    color: var(--color-nc-text-dim);
    margin-left: auto;
  }
  .root-crumb {
    font-weight: bold;
    color: var(--color-nc-accent);
  }

  .empty-dir {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 60px 20px;
    color: var(--color-nc-text-dim);
    text-align: center;
  }

  .empty-icon {
    font-size: 48px;
    margin-bottom: 16px;
    opacity: 0.3;
  }

  .empty-sub {
    font-size: 11px;
    margin-top: 8px;
    max-width: 250px;
    line-height: 1.5;
  }

  .refresh-btn {
    margin-top: 20px;
    padding: 6px 20px;
    background: var(--color-nc-bg-header);
    border: 1px solid var(--color-nc-border-bright);
    color: var(--color-nc-accent);
    border-radius: 4px;
    cursor: pointer;
    font-weight: 600;
  }

  .refresh-btn:hover {
    background: var(--color-nc-bg-hover);
    border-color: var(--color-nc-accent);
  }

  /* Size calculation pulse */
  @keyframes pulse-size {
    0% { opacity: 0.3; }
    50% { opacity: 1; }
    100% { opacity: 0.3; }
  }
  .size-calculating {
    animation: pulse-size 1.2s infinite;
    color: var(--color-nc-accent);
    letter-spacing: 2px;
    font-weight: bold;
    display: inline-block;
    min-width: 30px;
  }

  /* Test Result Toast */
  .test-result-toast {
    position: absolute;
    bottom: 40px;
    left: 50%;
    transform: translateX(-50%);
    background: var(--color-nc-bg-deep);
    border: 1px solid var(--color-nc-accent);
    box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    border-radius: 6px;
    padding: 8px 16px;
    display: flex;
    align-items: center;
    gap: 12px;
    z-index: 1000;
    pointer-events: none;
    min-width: 250px;
  }

  .test-result-toast.error {
    border-color: var(--color-nc-danger);
  }

  .toast-msg {
    font-size: 12px;
    color: var(--color-nc-text-bright);
    font-weight: 500;
  }
</style>
