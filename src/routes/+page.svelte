<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { initTheme, currentTheme, themes } from "$lib/theme";

  import "../app.css";
  import MenuBar from "$lib/components/MenuBar.svelte";
  import Toolbar from "$lib/components/Toolbar.svelte";
  import TwinPanels from "$lib/components/TwinPanels.svelte";
  import FunctionKeyBar from "$lib/components/FunctionKeyBar.svelte";
  import Dialog from "$lib/components/Dialog.svelte";
  import HeadlessFileModal from "$lib/components/HeadlessFileModal.svelte";
  import MiniPlayer from "$lib/components/MiniPlayer.svelte";
  import TaskProgress from "$lib/components/TaskProgress.svelte";
  import UploadProgress from "$lib/components/UploadProgress.svelte";
  import UploadConflictModal from "$lib/components/UploadConflictModal.svelte";
  import { startUpload, registerRefreshCallback, pendingExternalDrop, conflictState } from "$lib/upload/uploadStore";
  import HotlistModal from "$lib/components/HotlistModal.svelte";
  import SearchModal from "$lib/components/SearchModal.svelte";
  import OptionsDialog from "$lib/components/OptionsDialog.svelte";
import MultiRenameModal from "$lib/components/MultiRenameModal.svelte";
import NetworkConnectionsModal from "$lib/components/NetworkConnectionsModal.svelte";
import DropMenuModal from "$lib/components/DropMenuModal.svelte";
import TaskProgressPopUp from "$lib/components/TaskProgressPopUp.svelte";
import AboutDialog from "$lib/components/AboutDialog.svelte";
import HelpViewer from "$lib/components/HelpViewer.svelte";
import ActionPalette from "$lib/components/ActionPalette.svelte";
import { loadLanguage, _ } from "$lib/i18n";
  import {
    dialogState,
    closeDialog,
    activePanel,
    leftPanelPath,
    rightPanelPath,
    isOverlayActive,
    clipboardStore,
    dropMenuState,
    closeDropMenu,
    globalContextMenuStore,
    closeContextMenu,
    appConfigStore,
    persistSettings,
    pendingElevatedAction,
    openDialog
  } from "$lib/stores";
  import ContextMenu from "$lib/components/ContextMenu.svelte";
  import {
    createDirectory,
    moveEntries,
    openTerminal,
    loadSettings,
    saveSettings,
    archivePack,
    archiveUnpack,
    compareDirectories,
    taskCreate,
    taskExecute,
    taskGet,
    archiveTest,
    splitFile,
    combineFiles,
    openConfigDir,
    getHomeDir,
    elevateOperation,
    type AppConfig,
    type OpenRequest
  } from "$lib/ipc";

  // Removed local appConfig state, now using $appConfigStore
  let installPrompt: any = $state(null);
  let fileInputEl = $state<HTMLInputElement | null>(null);
  let folderInputEl = $state<HTMLInputElement | null>(null);


  const handleBeforeInstallPrompt = (e: any) => {
    e.preventDefault();
    installPrompt = e;
  };

  const installPWA = async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === 'accepted') {
      installPrompt = null;
    }
  };
  let saveTimeout: any;
  let taskProgress: any;

  const debouncedSaveBounds = async () => {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
      try {
        const appConfig = get(appConfigStore);
        if (appConfig) {
          // Window position/size is handled by browser/OS for PWAs
          // We can still save some state if needed, but not outerPosition/outerSize
          await saveSettings(appConfig);
        }
      } catch (e) {
        console.error("Failed to auto-save settings:", e);
      }
    }, 500);
  };

  const saveBoundsImmediately = async () => {
    clearTimeout(saveTimeout);
    try {
      const appConfig = get(appConfigStore);
      if (appConfig) {
        await saveSettings(appConfig);
      }
    } catch (e) {
      console.error("Failed to save settings on close:", e);
    }
  };

  function getActivePanelSide(): "left" | "right" {
    let side: "left" | "right" = "left";
    const unsub = activePanel.subscribe(v => side = v as "left" | "right");
    unsub();
    return side;
  }

  function getPanelPath(side: "left" | "right"): string {
    const panel = side === "left" ? leftPanel : rightPanel;
    const fromPanel = panel?.getPath?.();
    if (fromPanel) return fromPanel;

    let path = "";
    const unsub = (side === "left" ? leftPanelPath : rightPanelPath).subscribe(v => path = v);
    unsub();
    return path;
  }

  async function handleSwapPanels() {
    const lp = getPanelPath("left");
    const rp = getPanelPath("right");
    if (!lp || !rp || lp === rp) return;
    await Promise.all([
      leftPanel?.navigateTo?.(rp),
      rightPanel?.navigateTo?.(lp)
    ]);
  }

  async function handleTargetSource() {
    const side = getActivePanelSide();
    const activePath = getPanelPath(side);
    if (!activePath) return;
    if (side === "left") {
      await rightPanel?.navigateTo?.(activePath);
    } else {
      await leftPanel?.navigateTo?.(activePath);
    }
  }

  onMount(() => {
    initTheme();

    // Load initial settings
    loadSettings().then(cfg => {
      const merged = { 
        ...cfg,
        layout_show_menu: cfg.layout_show_menu ?? true,
        layout_show_toolbar: cfg.layout_show_toolbar ?? true,
        show_folder_tabs: cfg.show_folder_tabs ?? true,
        layout_single_view: cfg.layout_single_view ?? false,
        left_tabs: cfg.left_tabs ?? [],
        right_tabs: cfg.right_tabs ?? [],
        left_active_tab: cfg.left_active_tab ?? "",
        right_active_tab: cfg.right_active_tab ?? "",
        font_main_name: cfg.font_main_name || "Inter, sans-serif",
        font_main_size: cfg.font_main_size ?? 11,
        font_menu_name: cfg.font_menu_name || "Inter, sans-serif",
        font_menu_size: cfg.font_menu_size ?? 11,
        font_drive_name: cfg.font_drive_name || "Inter, sans-serif",
        font_drive_size: cfg.font_drive_size ?? 11,
        font_tab_name: cfg.font_tab_name || "Inter, sans-serif",
        font_tab_size: cfg.font_tab_size ?? 11,
        font_header_name: cfg.font_header_name || "Inter, sans-serif",
        font_header_size: cfg.font_header_size ?? 11,
        font_pane_name: cfg.font_pane_name || "Inter, sans-serif",
        font_pane_size: cfg.font_pane_size ?? 11
      };
      appConfigStore.set(merged);
      currentTheme.set(merged.theme as any || "midnight");
      loadLanguage(merged.language || "en");
      applyConfig(merged);
    }).catch(console.error);

    const handleSettingsRequestSave = async (e: any) => {
      const cfg = e.detail;
      try {
        await saveSettings(cfg);
      } catch (err) {
        console.error("Failed to save settings:", err);
      }
    };
    window.addEventListener("nc:save-settings", handleSettingsRequestSave);

    const handleSettingsChanged = (e: any) => {
      const cfg = e.detail;
      appConfigStore.set(cfg);
      currentTheme.set(cfg.theme as any);
      applyConfig(cfg);
    };
    window.addEventListener("nc:settings-changed", handleSettingsChanged);

    const handleOpenMultiRename = (e: CustomEvent<{entries: any[], path: string, side: string}>) => {
      multiRenameData = e.detail;
    };

    const handleRefreshPanels = () => {
      refreshPanels().catch(console.error);
    };
    window.addEventListener("nc:refresh-panels", handleRefreshPanels);

    const handleMenuAction = (e: CustomEvent<string>) => {
      const action = e.detail;
      if (get(isOverlayActive) && action !== "task-manager") return;
      if (action === "hotlist") showHotlist = true;
      else if (action === "search") showSearch = true;
      else if (action === "task-manager") taskProgress?.open?.();
      else if (action === "command-palette") showActionPalette = true;
      else if (action === "swap-panels") handleSwapPanels();
      else if (action === "target-source") handleTargetSource();
      else if (action === "net-connections") showNetwork = true;
      else if (action === "compare-dirs") handleCompareDirs();
      else if (action === "toggle-layout") twinPanels?.toggleLayout?.();
      else if (action === "toggle-view-mode") twinPanels?.toggleViewMode?.();
      else if (action === "toggle-single-view") twinPanels?.toggleSingleView?.();
      else if (action === "view-tree") {
        let ap = "left";
        const unsub = activePanel.subscribe(v => ap = v);
        unsub();
        if (ap === "left") twinPanels?.toggleLeftTree?.();
        else twinPanels?.toggleRightTree?.();
      } else if (action === "quick-view") {
        twinPanels?.toggleQuickView?.();
      }
      else if (action === "multi-rename") {
        let ap = "left";
        const unsub = activePanel.subscribe(v => ap = v);
        unsub();
        if (ap === "left") leftPanel?.handleMultiRename?.();
        else rightPanel?.handleMultiRename?.();
      } else if (action === "open-terminal") {
        let ap = "left";
        const unsubPanel = activePanel.subscribe(v => ap = v);
        unsubPanel();
        let path = "";
        const unsubPath = (ap === "left" ? leftPanelPath : rightPanelPath).subscribe(v => path = v);
        unsubPath();
        if (path) openTerminal(path).catch(console.error);
      } else if (action === "upload-files") {
        fileInputEl?.click();
      } else if (action === "upload-folder") {
        folderInputEl?.click();
      } else if (action === "options") {
        showOptions = true;
      } else if (action === "about") {
        showAbout = true;
      } else if (action === "help-contents") {
        helpTopic = "intro";
        showHelp = true;
      } else if (action === "help-shortcuts") {
        helpTopic = "shortcuts";
        showHelp = true;
      } else if (action === "technical-support") {
        helpTopic = "tech-support"; // We should create this one too
        showHelp = true;
      } else if (action === "pack") {
        let ap = "left";
        const unsub = activePanel.subscribe(v => ap = v);
        unsub();
        if (ap === "left") leftPanel?.handlePack?.();
        else rightPanel?.handlePack?.();
      } else if (action === "unpack") {
        let ap = "left";
        const unsub = activePanel.subscribe(v => ap = v);
        unsub();
        if (ap === "left") leftPanel?.handleUnpack?.();
        else rightPanel?.handleUnpack?.();
      } else if (action === "select-all") {
        let ap = "left";
        const unsub = activePanel.subscribe(v => ap = v);
        unsub();
        if (ap === "left") leftPanel?.selectAll?.();
        else rightPanel?.selectAll?.();
      } else if (action === "unselect-all") {
        let ap = "left";
        const unsub = activePanel.subscribe(v => ap = v);
        unsub();
        if (ap === "left") leftPanel?.unselectAll?.();
        else rightPanel?.unselectAll?.();
      } else if (action === "invert-selection") {
        let ap = "left";
        const unsub = activePanel.subscribe(v => ap = v);
        unsub();
        if (ap === "left") leftPanel?.invertSelection?.();
        else rightPanel?.invertSelection?.();
      } else if (action === "select-all-files") {
        let ap = "left";
        const unsub = activePanel.subscribe(v => ap = v);
        unsub();
        if (ap === "left") leftPanel?.selectAllFiles?.();
        else rightPanel?.selectAllFiles?.();
      } else if (action === "unselect-all-files") {
        let ap = "left";
        const unsub = activePanel.subscribe(v => ap = v);
        unsub();
        if (ap === "left") leftPanel?.unselectAllFiles?.();
        else rightPanel?.unselectAllFiles?.();
      } else if (action === "select-same-ext") {
        let ap = "left";
        const unsub = activePanel.subscribe(v => ap = v);
        unsub();
        if (ap === "left") leftPanel?.selectSameExtension?.();
        else rightPanel?.selectSameExtension?.();
      } else if (action === "unselect-same-ext") {
        let ap = "left";
        const unsub = activePanel.subscribe(v => ap = v);
        unsub();
        if (ap === "left") leftPanel?.unselectSameExtension?.();
        else rightPanel?.unselectSameExtension?.();
      } else if (action === "save-selection") {
        let ap = "left";
        const unsub = activePanel.subscribe(v => ap = v);
        unsub();
        if (ap === "left") leftPanel?.handleSaveSelection?.();
        else rightPanel?.handleSaveSelection?.();
      } else if (action === "restore-selection") {
        let ap = "left";
        const unsub = activePanel.subscribe(v => ap = v);
        unsub();
        if (ap === "left") leftPanel?.handleRestoreSelection?.();
        else rightPanel?.handleRestoreSelection?.();
      } else if (action === "test-archive") {
        let ap = "left";
        const unsub = activePanel.subscribe(v => ap = v);
        unsub();
        if (ap === "left") leftPanel?.handleTestArchive?.();
        else rightPanel?.handleTestArchive?.();
      } else if (action === "split") {
        let ap = "left";
        const unsub = activePanel.subscribe(v => ap = v);
        unsub();
        if (ap === "left") leftPanel?.handleSplitFile?.();
        else rightPanel?.handleSplitFile?.();
      } else if (action === "combine") {
        let ap = "left";
        const unsub = activePanel.subscribe(v => ap = v);
        unsub();
        if (ap === "left") leftPanel?.handleCombineFiles?.();
        else rightPanel?.handleCombineFiles?.();
      } else if (action === "select-group") {
        let ap = "left";
        const unsub = activePanel.subscribe(v => ap = v);
        unsub();
        if (ap === "left") leftPanel?.handleSelectGroup?.();
        else rightPanel?.handleSelectGroup?.();
      } else if (action === "unselect-group") {
        let ap = "left";
        const unsub = activePanel.subscribe(v => ap = v);
        unsub();
        if (ap === "left") leftPanel?.handleUnselectGroup?.();
        else rightPanel?.handleUnselectGroup?.();
      } else if (action === "edit-config") {
        openConfigDir().catch(console.error);
      } else if (action.startsWith("sort-")) {
        const col = action.split("-")[1] as any;
        let ap = "left";
        const unsub = activePanel.subscribe(v => ap = v);
        unsub();
        if (ap === "left") leftPanel?.handleSort?.(col);
        else rightPanel?.handleSort?.(col);
      } else if (action === "toggle-folder-brackets") {
        const appConfig = get(appConfigStore);
        if (appConfig) {
          appConfig.layout_show_folder_brackets = !appConfig.layout_show_folder_brackets;
          appConfigStore.set(appConfig);
          saveSettings(appConfig).catch(console.error);
          applyConfig(appConfig);
          // Dispatch settings changed event for other components
          window.dispatchEvent(new CustomEvent("nc:settings-changed", { detail: appConfig }));
        }
      }
    };


    const handleKeydown = (e: KeyboardEvent) => {
      if (showActionPalette) return;
      if (e.key === "F1") {
        e.preventDefault();
        helpTopic = "intro";
        showHelp = true;
      } else if (e.key === "F9" && !e.altKey) {
        e.preventDefault();
        taskProgress?.toggle?.();
      } else if (e.key === "F10") {
        e.preventDefault();
        if (get(isOverlayActive)) return;
        showActionPalette = true;
      }
    };

    window.addEventListener("nc:menu-action", handleMenuAction as EventListener);
    window.addEventListener("nc:settings-changed", handleSettingsChanged as EventListener);
    window.addEventListener("nc:open-multi-rename", handleOpenMultiRename as EventListener);
    window.addEventListener("keydown", handleKeydown);
    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    registerRefreshCallback(() => {
      refreshPanels().catch(console.error);
    });

    const handlePaste = (e: ClipboardEvent) => {
      if (get(isOverlayActive)) return;
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }
      const files = e.clipboardData?.files;
      if (!files || files.length === 0) return;
      
      const internalClipboard = get(clipboardStore);
      if (internalClipboard && internalClipboard.paths && internalClipboard.paths.length > 0) {
        return;
      }
      
      e.preventDefault();
      const side = getActivePanelSide();
      const targetPath = getPanelPath(side);
      if (!targetPath) return;
      
      const uploadFiles = Array.from(files).map((f) => {
        let name = f.name;
        if (name === 'image.png' || name === 'image.jpg') {
          const now = new Date();
          const pad = (n: number) => n.toString().padStart(2, '0');
          const dateStr = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
          name = `screenshot-${dateStr}.${name.split('.').pop()}`;
        }
        return { file: f, rel: name };
      });
      
      startUpload(side, targetPath, uploadFiles);
    };

    window.addEventListener("paste", handlePaste);
    window.addEventListener("resize", debouncedSaveBounds);
    window.addEventListener("beforeunload", () => {
      saveBoundsImmediately();
    });

    return () => {
      window.removeEventListener("nc:save-settings", handleSettingsRequestSave);
      window.removeEventListener("nc:settings-changed", handleSettingsChanged as EventListener);
      window.removeEventListener("nc:menu-action", handleMenuAction as EventListener);
      window.removeEventListener("nc:open-multi-rename", handleOpenMultiRename as EventListener);
      window.removeEventListener("nc:refresh-panels", handleRefreshPanels);
      window.removeEventListener("keydown", handleKeydown);
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("resize", debouncedSaveBounds);
      window.removeEventListener("paste", handlePaste);
      clearTimeout(saveTimeout);
    };
  });

  function applyConfig(cfg: AppConfig) {
    if (typeof document !== "undefined") {
      const root = document.documentElement;

      // Fonts
      if (cfg.font_main_name) {
        root.style.setProperty("--font-main-name", cfg.font_main_name);
      }
      if (cfg.font_main_size) {
        root.style.setProperty("--font-main-size", `${cfg.font_main_size}px`);
      }
      
      if (cfg.font_menu_name) root.style.setProperty("--font-menu-name", cfg.font_menu_name);
      if (cfg.font_menu_size) root.style.setProperty("--font-menu-size", `${cfg.font_menu_size}px`);
      
      if (cfg.font_drive_name) root.style.setProperty("--font-drive-name", cfg.font_drive_name);
      if (cfg.font_drive_size) root.style.setProperty("--font-drive-size", `${cfg.font_drive_size}px`);
      
      if (cfg.font_tab_name) root.style.setProperty("--font-tab-name", cfg.font_tab_name);
      if (cfg.font_tab_size) root.style.setProperty("--font-tab-size", `${cfg.font_tab_size}px`);
      
      if (cfg.font_header_name) root.style.setProperty("--font-header-name", cfg.font_header_name);
      if (cfg.font_header_size) root.style.setProperty("--font-header-size", `${cfg.font_header_size}px`);
      
      if (cfg.font_pane_name) root.style.setProperty("--font-pane-name", cfg.font_pane_name);
      if (cfg.font_pane_size) root.style.setProperty("--font-pane-size", `${cfg.font_pane_size}px`);
    }
  }

  let twinPanels: any = $state(null);
  let leftPanel: any = $state(null);
  let rightPanel: any = $state(null);
  let showHotlist = $state(false);
  let showSearch = $state(false);
  let showOptions = $state(false);
  let showAbout = $state(false);
  let showNetwork = $state(false);
  let showHelp = $state(false);
  let showActionPalette = $state(false);
  let helpTopic = $state("intro");
  let multiRenameData = $state<{entries: any[], path: string, side: string} | null>(null);
  let activeForegroundTaskId = $state<string | null>(null);
  let foregroundTaskTimer: ReturnType<typeof setTimeout> | null = null;
  let blockingFileOperationIds = $state<string[]>([]);
  const blockingFileOperationTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const FOREGROUND_PROGRESS_DELAY_MS = 800;
  const FOREGROUND_PROGRESS_MIN_BYTES = 32 * 1024 * 1024;
  const FOREGROUND_PROGRESS_MIN_FILES = 25;
  const FILE_OPERATION_OVERLAY_POLL_MS = 500;
  const TERMINAL_TASK_STATUSES = new Set(["Completed", "Failed", "Cancelled"]);

  let openRequest: OpenRequest | null = $state(null);

  function handleOpenRequest(request: OpenRequest) {
    openRequest = request;
  }

  function closeOpenRequest() {
    openRequest = null;
  }

  function clearForegroundTaskTimer() {
    if (foregroundTaskTimer) {
      clearTimeout(foregroundTaskTimer);
      foregroundTaskTimer = null;
    }
  }

  function closeForegroundTaskPopup() {
    clearForegroundTaskTimer();
    activeForegroundTaskId = null;
  }

  function removeBlockingFileOperation(taskId: string) {
    const timer = blockingFileOperationTimers.get(taskId);
    if (timer) clearTimeout(timer);
    blockingFileOperationTimers.delete(taskId);
    blockingFileOperationIds = blockingFileOperationIds.filter((id) => id !== taskId);
  }

  function clearBlockingFileOperations() {
    for (const timer of blockingFileOperationTimers.values()) {
      clearTimeout(timer);
    }
    blockingFileOperationTimers.clear();
    blockingFileOperationIds = [];
  }

  async function pollBlockingFileOperation(taskId: string) {
    try {
      const task = await taskGet(taskId);
      if (!task || TERMINAL_TASK_STATUSES.has(task.status)) {
        removeBlockingFileOperation(taskId);
        // The initial refreshPanels() after task creation fires long before
        // a slow copy/move (e.g. extracting an archive entry into the other
        // panel) actually finishes, so the destination looks empty until a
        // manual refresh. Refresh again now that the task has truly ended.
        refreshPanels().catch(console.error);
        return;
      }
    } catch (e) {
      console.error("Failed to inspect blocking file operation:", e);
    }

    const timer = setTimeout(() => {
      pollBlockingFileOperation(taskId);
    }, FILE_OPERATION_OVERLAY_POLL_MS);
    blockingFileOperationTimers.set(taskId, timer);
  }

  function trackBlockingFileOperation(taskId: string) {
    if (!blockingFileOperationIds.includes(taskId)) {
      blockingFileOperationIds = [...blockingFileOperationIds, taskId];
    }
    pollBlockingFileOperation(taskId);
  }

  function scheduleForegroundTaskPopup(taskId: string) {
    clearForegroundTaskTimer();
    activeForegroundTaskId = null;

    foregroundTaskTimer = setTimeout(async () => {
      foregroundTaskTimer = null;

      try {
        const task = await taskGet(taskId);
        if (!task || TERMINAL_TASK_STATUSES.has(task.status)) return;

        const knownLargeTask =
          task.total_bytes >= FOREGROUND_PROGRESS_MIN_BYTES ||
          task.total_files >= FOREGROUND_PROGRESS_MIN_FILES;
        const stillActiveAfterDelay =
          task.status === "Queued" ||
          task.status === "Running" ||
          task.status === "WaitingForInput";

        if (knownLargeTask || stillActiveAfterDelay) {
          activeForegroundTaskId = taskId;
        }
      } catch (e) {
        console.error("Failed to inspect foreground task:", e);
      }
    }, FOREGROUND_PROGRESS_DELAY_MS);
  }

  $effect(() => {
    return () => {
      clearForegroundTaskTimer();
      clearBlockingFileOperations();
    };
  });

  // Dialog state
  let dlgType = $state<typeof $dialogState.type>(null);
  let dlgInputValue = $state("");
  let dlgEntries = $state<typeof $dialogState.entries>([]);
  let dlgSourcePaths = $state<string[]>([]);
  let dlgTargetDir = $state("");
  let dlgSourceDir = $state("");

  dialogState.subscribe((s) => {
    dlgType = s.type;
    dlgInputValue = s.inputValue;
    dlgEntries = s.entries;
    dlgSourcePaths = s.sourcePaths;
    dlgTargetDir = s.targetDir;
    dlgSourceDir = s.sourceDir;
  });

  // Drop Menu state
  let dropMenu = $state<typeof $dropMenuState>({
    visible: false,
    x: 0,
    y: 0,
    files: [],
    isExternal: false,
    targetDir: "",
    side: "left",
    forceCopy: false
  });

  dropMenuState.subscribe(s => {
    dropMenu = s;
  });

  // Context Menu state
  let gMenu = $state({ visible: false, x: 0, y: 0, options: [] as any[] });
  globalContextMenuStore.subscribe(s => gMenu = s);


  // Global overlay detection
  let anyOverlayOpen = $derived(
    !!dlgType || 
    showHotlist || 
    showSearch || 
    showOptions || 
    showAbout ||
    showNetwork || 
    !!multiRenameData || 
    !!openRequest ||
    dropMenu.visible ||
    blockingFileOperationIds.length > 0 ||
    showHelp ||
    showActionPalette ||
    $conflictState.visible
  );


  $effect(() => {
    isOverlayActive.set(anyOverlayOpen);
  });

  async function handleDialogConfirm(value: string) {
    const type = dlgType;
    const paths = [...dlgSourcePaths];
    const sourceDir = dlgSourceDir;
    closeDialog();

    try {
      switch (type) {
        case "permission_denied": {
          openDialog({
            type: "sudo_password",
            inputValue: "",
          });
          break;
        }
        case "sudo_password": {
          const action = get(pendingElevatedAction);
          if (action) {
            try {
              const apiAction = action.type === "properties" ? "set-properties" : action.type;

              await elevateOperation({
                action: apiAction,
                path: action.paths[0] || (action.sourceDir === "/" ? `/${action.value.trim()}` : `${action.sourceDir}/${action.value.trim()}`),
                target: action.value.trim(),
                password: value,
                permissions: action.permissions,
                owner: action.owner,
                group: action.group
              });
              pendingElevatedAction.set(null);
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              if (errMsg.toLowerCase().includes("incorrect password")) {
                // Keep the pending action so the user can retry.
                openDialog({ type: "sudo_password", inputValue: "" });
              } else {
                pendingElevatedAction.set(null);
                alert($_('dialogs.elevation_failed', { error: errMsg }));
              }
            }
          }
          break;
        }
        case "mkdir": {
          if (!value.trim()) return;
          const fullPath = sourceDir === "/"
            ? `/${value.trim()}`
            : `${sourceDir}/${value.trim()}`;
          await createDirectory(fullPath);
          break;
        }
        case "delete": {
          const taskId = await taskCreate("delete", paths, "");
          trackBlockingFileOperation(taskId);
          taskExecute(taskId).catch((e) => {
            console.error(e);
            removeBlockingFileOperation(taskId);
          });
          taskProgress?.notifyTaskStarted?.();
          break;
        }
        case "copy": {
          if (!value.trim()) return;
          const taskId = await taskCreate("copy", paths, value.trim());
          trackBlockingFileOperation(taskId);
          taskExecute(taskId).catch((e) => {
            console.error(e);
            removeBlockingFileOperation(taskId);
          });
          taskProgress?.notifyTaskStarted?.();
          break;
        }
        case "move": {
          if (!value.trim()) return;
          const taskId = await taskCreate("move", paths, value.trim());
          trackBlockingFileOperation(taskId);
          taskExecute(taskId).catch((e) => {
            console.error(e);
            removeBlockingFileOperation(taskId);
          });
          taskProgress?.notifyTaskStarted?.();
          break;
        }
        case "pack": {
          if (!value.trim()) return;
          await archivePack(paths, value.trim());
          break;
        }
        case "unpack": {
          if (!value.trim()) return;
          await archiveUnpack(paths[0], value.trim());
          break;
        }
        case "select_group": {
          if (!value.trim()) return;
          let ap = "left";
          const unsub = activePanel.subscribe(v => ap = v);
          unsub();
          if (ap === "left") leftPanel?.handleSelectGroup?.(value.trim());
          else rightPanel?.handleSelectGroup?.(value.trim());
          break;
        }
        case "unselect_group": {
          if (!value.trim()) return;
          let ap = "left";
          const unsub = activePanel.subscribe(v => ap = v);
          unsub();
          if (ap === "left") leftPanel?.handleUnselectGroup?.(value.trim());
          else rightPanel?.handleUnselectGroup?.(value.trim());
          break;
        }
        case "split": {
          if (!value.trim()) return;
          const chunkSize = parseInt(value.trim());
          if (isNaN(chunkSize) || chunkSize <= 0) return;
          await splitFile(paths[0], chunkSize, sourceDir);
          break;
        }
        case "combine": {
          if (!value.trim()) return;
          await combineFiles(paths, value.trim());
          break;
        }
      }
    } catch (e) {
      console.error("Operation failed:", e);
      const msg = e instanceof Error ? e.message : String(e);
      const isPermissionError = msg.includes("EACCES") || msg.includes("EPERM") || msg.toLowerCase().includes("permission denied") || msg.toLowerCase().includes("forbidden");
      // Only offer elevation for actions the server's elevate-operation endpoint supports.
      if (isPermissionError && type === "mkdir") {
        pendingElevatedAction.set({ type, value, paths, sourceDir });
        openDialog({
          type: "permission_denied",
          inputValue: sourceDir === "/" ? `/${value.trim()}` : `${sourceDir}/${value.trim()}`,
          sourcePaths: paths,
          sourceDir: sourceDir,
        });
      } else {
        alert($_('dialogs.operation_failed', { error: msg }));
      }
    }

    await refreshPanels();
  }

  async function handleMultiRenameComplete() {
    multiRenameData = null;
    await refreshPanels();
  }

  function handleDialogCancel() {
    pendingElevatedAction.set(null);
    closeDialog();
  }

  async function handleDropMenuAction(action: "copy" | "move"): Promise<string | void> {
    const { files, targetDir, side, isExternal } = dropMenu;
    if (files.length === 0) return;

    if (isExternal) {
      const dropData = get(pendingExternalDrop);
      if (dropData) {
        startUpload(side, targetDir, dropData.files, dropData.emptyDirs);
        pendingExternalDrop.set(null);
      }
      closeDropMenu();
      return;
    }

    try {
      const taskId = await taskCreate(action, files, targetDir);
      trackBlockingFileOperation(taskId);
      taskExecute(taskId).catch((e) => {
        console.error(e);
        removeBlockingFileOperation(taskId);
      });
      taskProgress?.notifyTaskStarted?.();
      refreshPanels().catch(console.error);
      closeDropMenu();
      scheduleForegroundTaskPopup(taskId);
      return taskId;
    } catch (e) {
      console.error(`${action} failed:`, e);
      closeDropMenu();
    }
  }

  async function handleCompareDirs() {
    let lp = "", rp = "";
    const unsub1 = leftPanelPath.subscribe(v => lp = v);
    const unsub2 = rightPanelPath.subscribe(v => rp = v);
    unsub1(); unsub2();

    try {
      const result = await compareDirectories(lp, rp);
      // TC behavior: Select files that are different or only in current panel
      leftPanel?.selectByNames?.([...result.only_in_left, ...result.different]);
      rightPanel?.selectByNames?.([...result.only_in_right, ...result.different]);
    } catch (e) {
      console.error("Comparison failed:", e);
    }
  }

  async function refreshPanels() {
    await new Promise((r) => setTimeout(r, 100));
    leftPanel?.refresh?.();
    rightPanel?.refresh?.();
  }

  function handleFilePickerChange(e: Event) {
    const input = e.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    
    const side = getActivePanelSide();
    const targetPath = getPanelPath(side);
    if (!targetPath) return;

    const files = Array.from(input.files).map(f => ({
      file: f,
      rel: f.webkitRelativePath || f.name
    }));

    startUpload(side, targetPath, files);
    input.value = ""; // Reset input
  }

  function handleDriveSelect(path: string) {
    twinPanels?.navigateActive?.(path);
  }
  async function handleToolbarRefresh() {
    twinPanels?.refreshAll();
  }

  async function handleToolbarHome() {
    const home = await getHomeDir();
    twinPanels?.goHome(home);
  }

  function handleToolbarUp() {
    twinPanels?.goUp();
  }

  async function handleToolbarToggleMenu() {
    if ($appConfigStore) {
      $appConfigStore.layout_show_menu = !$appConfigStore.layout_show_menu;
      persistSettings();
      applyConfig($appConfigStore);
    }
  }

  function handleToolbarBrief() {
    twinPanels?.setViewMode("brief");
  }

  function handleToolbarFull() {
    twinPanels?.setViewMode("full");
  }

  function handleToolbarSingleView() {
    twinPanels?.toggleSingleView?.();
  }

  function handleToolbarHotlist() {
    showHotlist = true;
  }

  function handleToolbarOptions() {
    showOptions = true;
  }

  function handleActionPaletteAction(trigger: string) {
    const [kind, value] = trigger.split(":", 2);
    if (kind === "key") {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: value,
          bubbles: true,
          cancelable: true,
        })
      );
      return;
    }
    if (kind === "action") {
      window.dispatchEvent(new CustomEvent("nc:menu-action", { detail: value }));
    }
  }

  function handleSaveOptions(newOptions: any) {
    if ($appConfigStore) {
      $appConfigStore.file_op_options = newOptions;
      persistSettings();
    }
  }
  import TitleBar from "$lib/components/TitleBar.svelte";
</script>

<div class="app-shell">
  <TitleBar />
  {#if $appConfigStore === null || $appConfigStore.layout_show_menu !== false}
    <MenuBar />
  {/if}
  
  <Toolbar 
    onrefresh={handleToolbarRefresh}
    onhome={handleToolbarHome}
    onup={handleToolbarUp}
    ontogglemenu={handleToolbarToggleMenu}
    onbrief={handleToolbarBrief}
    onfull={handleToolbarFull}
    onsingleview={handleToolbarSingleView}
    onhotlist={handleToolbarHotlist}
    onoptions={handleToolbarOptions}
  />
  <div class="panels-stage">
    <TwinPanels bind:this={twinPanels} bind:leftPanel bind:rightPanel onopenrequest={handleOpenRequest} />
    {#if blockingFileOperationIds.length > 0}
      <div class="file-operation-blocker" aria-hidden="true"></div>
    {/if}
  </div>
  <TaskProgress bind:this={taskProgress} />
  <UploadProgress />

  <MiniPlayer />

  <FunctionKeyBar />

  <!-- Modal Dialog -->
  <Dialog
    type={dlgType}
    inputValue={dlgInputValue}
    entries={dlgEntries}
    sourcePaths={dlgSourcePaths}
    targetDir={dlgTargetDir}
    sourceDir={dlgSourceDir}
    onconfirm={handleDialogConfirm}
    oncancel={handleDialogCancel}
    fileOpOptions={$appConfigStore?.file_op_options}
    onsaveoptions={handleSaveOptions}
  />

  <DropMenuModal
    visible={dropMenu.visible}
    files={dropMenu.files}
    targetDir={dropMenu.targetDir}
    isExternal={dropMenu.isExternal}
    side={dropMenu.side}
    forceCopy={dropMenu.forceCopy}
    onaction={handleDropMenuAction}
    oncancel={closeDropMenu}
  />

  <TaskProgressPopUp 
    taskId={activeForegroundTaskId} 
    onclose={closeForegroundTaskPopup} 
  />

  <UploadConflictModal />

  <input
    type="file"
    multiple
    style="display: none;"
    bind:this={fileInputEl}
    onchange={handleFilePickerChange}
  />
  <input
    type="file"
    webkitdirectory
    style="display: none;"
    bind:this={folderInputEl}
    onchange={handleFilePickerChange}
  />

  {#if openRequest}
    <HeadlessFileModal
      path={openRequest.path}
      intent={openRequest.intent}
      siblingPaths={openRequest.siblingPaths ?? []}
      onclose={closeOpenRequest}
      onsaved={refreshPanels}
    />
  {/if}

  <!-- Hotlist Modal -->
  {#if showHotlist}
    <HotlistModal onclose={() => showHotlist = false} />
  {/if}

  <!-- Search Modal -->
  {#if showSearch}
    <SearchModal onclose={() => showSearch = false} />
  {/if}
  
  <!-- Options Dialog -->
  {#if showOptions}
    <OptionsDialog onclose={() => showOptions = false} />
  {/if}

  {#if multiRenameData}
    <MultiRenameModal 
      entries={multiRenameData.entries} 
      currentPath={multiRenameData.path}
      onclose={() => multiRenameData = null}
      oncomplete={handleMultiRenameComplete}
    />
  {/if}

  {#if showNetwork}
    <NetworkConnectionsModal onclose={() => showNetwork = false} onselect={handleDriveSelect} />
  {/if}

  {#if showAbout}
    <AboutDialog onclose={() => showAbout = false} />
  {/if}

  {#if showHelp}
    <HelpViewer startTopic={helpTopic} onclose={() => showHelp = false} />
  {/if}

  <ActionPalette
    visible={showActionPalette}
    onclose={() => showActionPalette = false}
    onaction={handleActionPaletteAction}
  />

  {#if gMenu.visible}
    <ContextMenu 
      options={gMenu.options} 
      x={gMenu.x} 
      y={gMenu.y} 
      onclose={closeContextMenu} 
    />
  {/if}
</div>


<style>
  .app-shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
    width: 100vw;
    overflow: hidden;
    background: var(--color-nc-bg-deep);
  }

  .panels-stage {
    position: relative;
    display: flex;
    flex: 1;
    width: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .file-operation-blocker {
    position: absolute;
    inset: 0;
    z-index: 900;
    background: transparent;
    pointer-events: all;
    cursor: progress;
  }
</style>
