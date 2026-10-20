<script lang="ts">
  import { shellShortcut, isTextTarget } from "@nexus/ui/shortcuts";
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { initTheme, currentTheme, themes } from "$lib/theme";

  import "../app.css";
  import MenuBar from "@nexus/ui/components/MenuBar.svelte";
  import Toolbar from "@nexus/ui/components/Toolbar.svelte";
  import TwinPanels from "@nexus/ui/components/TwinPanels.svelte";
  import FileList from "@nexus/ui/components/FileList.svelte";
  import FunctionKeyBar from "@nexus/ui/components/FunctionKeyBar.svelte";
  import Dialog from "@nexus/ui/components/Dialog.svelte";
  import HeadlessFileModal from "$lib/components/HeadlessFileModal.svelte";
  import MiniPlayer from "@nexus/ui/components/MiniPlayer.svelte";
  import TaskProgress from "@nexus/ui/components/TaskProgress.svelte";
  import TransferQueue from "@nexus/ui/components/TransferQueue.svelte";
  import UploadProgress from "$lib/components/UploadProgress.svelte";
  import UploadConflictModal from "$lib/components/UploadConflictModal.svelte";
  import { startUpload, registerRefreshCallback, pendingExternalDrop, conflictState } from "$lib/upload/uploadStore";
  import DownloadProgress from "$lib/components/DownloadProgress.svelte";
  import { downloadSingleFile } from "$lib/download/downloadClient";
  import { startZipDownload } from "$lib/download/downloadStore";
  import { formatSize } from "@nexus/ui/utils";
  import HotlistModal from "@nexus/ui/components/HotlistModal.svelte";
  import SearchModal from "@nexus/ui/components/SearchModal.svelte";
  import OptionsDialog from "@nexus/ui/components/OptionsDialog.svelte";
import MultiRenameModal from "@nexus/ui/components/MultiRenameModal.svelte";
import NetworkConnectionsModal from "@nexus/ui/components/NetworkConnectionsModal.svelte";
import DropMenuModal from "@nexus/ui/components/DropMenuModal.svelte";
import TaskProgressPopUp from "$lib/components/TaskProgressPopUp.svelte";
import AboutDialog from "@nexus/ui/components/AboutDialog.svelte";
import { Server, Palette } from "lucide-svelte";
import packageInfo from "../../package.json";
import HelpDialog from "@nexus/ui/components/HelpDialog.svelte";
import ActionPalette from "@nexus/ui/components/ActionPalette.svelte";
import { loadLanguage, _ } from "$lib/i18n";
import { describeTaskError } from "@nexus/ui/taskErrors";
import type { TaskInfo } from "@nexus/ui/ipc-contract";
  import {
    dialogState,
    closeDialog,
    activePanel,
    leftPanelPath,
    rightPanelPath,
    isOverlayActive,
    taskConflictActive,
    addQueuedOperation,
    removeQueuedOperation,
    transferQueue,
    transferQueueOpen,
    transferQueueRunningId,
    clipboardStore,
    dropMenuState,
    closeDropMenu,
    globalContextMenuStore,
    closeContextMenu,
    appConfigStore,
    updateSettings,
    pendingElevatedAction,
    openDialog,
    activeOf,
    getActivePanelPath,
    runPanelAction
  } from "$lib/stores";
  import ContextMenu from "@nexus/ui/components/ContextMenu.svelte";
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
        font_pane_size: cfg.font_pane_size ?? 11,
        font_status_name: cfg.font_status_name || "Inter, sans-serif",
        font_status_size: cfg.font_status_size ?? 11
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

    // Files may have changed while the app was in the background.
    // Keep both panes current as soon as the window becomes active again.
    const handleWindowFocus = () => {
      refreshPanels().catch(console.error);
    };
    window.addEventListener("focus", handleWindowFocus);

    const handleMenuAction = (e: CustomEvent<string>) => {
      const action = e.detail;
      if (get(isOverlayActive) && action !== "task-manager" && !(showOptions && action === "help-options")) return;
      // Toolbar buttons dispatch through the same event as MenuBar/ActionPalette.
      if (action === "refresh") handleToolbarRefresh();
      else if (action === "go-home") handleToolbarHome();
      else if (action === "go-up") handleToolbarUp();
      else if (action === "toggle-menu-bar") handleToolbarToggleMenu();
      else if (action === "hotlist") showHotlist = true;
      else if (action === "search") showSearch = true;
      else if (action === "task-manager") taskProgress?.open?.();
      else if (action === "command-palette") showActionPalette = true;
      else if (action === "swap-panels") handleSwapPanels();
      else if (action === "target-source") handleTargetSource();
      else if (action === "net-connections" || action === "net-disconnect") showNetwork = true;
      else if (action === "compare-dirs") handleCompareDirs();
      else if (action === "equalize-panels") twinPanels?.equalizePanels?.();
      else if (action === "toggle-layout") twinPanels?.toggleLayout?.();
      else if (action === "view-brief") twinPanels?.setViewMode?.("brief");
      else if (action === "view-full") twinPanels?.setViewMode?.("full");
      else if (action === "toggle-view-mode") twinPanels?.toggleViewMode?.();
      else if (action === "toggle-single-view") twinPanels?.toggleSingleView?.();
      else if (action === "view-tree") {
        twinPanels?.toggleActiveTree?.();
      } else if (action === "quick-view") {
        twinPanels?.toggleQuickView?.();
      }
      else if (action === "multi-rename") {
        activeOf(leftPanel, rightPanel)?.handleMultiRename?.();
      } else if (action === "open-terminal") {
        const path = getActivePanelPath();
        if (path) openTerminal(path).catch(reportActionError);
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
      } else if (action === "help-options") {
        helpTopic = "options";
        showHelp = true;
      } else if (action === "help-shortcuts") {
        helpTopic = "shortcuts";
        showHelp = true;
      } else if (action === "technical-support") {
        helpTopic = "tech-support"; // We should create this one too
        showHelp = true;
      } else if (runPanelAction(action, leftPanel, rightPanel)) {
        // Selection and per-file archive actions go to the active panel; the
        // list itself lives in @nexus/ui so both shells route the same set.
      } else if (action === "edit-config") {
        openConfigDir().catch(console.error);
      } else if (action.startsWith("sort-")) {
        const col = ({ "sort-ext": "extension", "sort-date": "modified" } as Record<string, string>)[action] || action.split("-")[1] as any;
        activeOf(leftPanel, rightPanel)?.handleSort?.(col);
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
      if (e.defaultPrevented || showActionPalette) return;
      const action = shellShortcut(e);
      if (!action) return;
      if (action !== "toggle-tasks" && (get(isOverlayActive) || isTextTarget(e.target))) return;
      e.preventDefault();
      if (action === "toggle-tasks") taskProgress?.toggle?.();
      else handleMenuAction(new CustomEvent("nc:menu-action", { detail: action }));
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
      window.removeEventListener("focus", handleWindowFocus);
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
      if (cfg.font_status_name) root.style.setProperty("--font-status-name", cfg.font_status_name);
      if (cfg.font_status_size) root.style.setProperty("--font-status-size", `${cfg.font_status_size}px`);
      if (cfg.font_pane_size) {
        root.style.setProperty("--font-pane-size", `${cfg.font_pane_size}px`);
        const paneSize = Number(cfg.font_pane_size) || 12;
        const rowHeight = Math.round(paneSize * 1.8 + 8);
        const iconSize  = Math.max(14, Math.round(rowHeight * 0.65));
        root.style.setProperty("--row-height", `${rowHeight}px`);
        root.style.setProperty("--icon-size",  `${iconSize}px`);
      }
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
  // View mode of the active panel — the shared Toolbar renders its icon from this.
  const toolbarViewMode = $derived(
    $activePanel === "left"
      ? (($appConfigStore?.layout_left_view_mode as "brief" | "full") || "full")
      : (($appConfigStore?.layout_right_view_mode as "brief" | "full") || "full")
  );
  let helpTopic = $state("intro");
  let multiRenameData = $state<{entries: any[], path: string, side: string} | null>(null);
  let activeForegroundTaskId = $state<string | null>(null);
  let transferQueueRunning = $state(false);
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

  /**
   * Run a created task and report a failure the user would otherwise never see.
   *
   * `taskExecute` starts asynchronously and returns its initial task record.
   * A task rejected before the poller observes it must still report its error;
   * transport failures remain the `.catch` path.
   */
  function runTrackedTask(taskId: string) {
    trackBlockingFileOperation(taskId);
    taskExecute(taskId)
      .then((task) => {
        if (task?.status === "Failed" && task.error) {
          activeOf(leftPanel, rightPanel)?.showActionToast?.(false, describeTaskError(task, $_).message, 8000);
        }
      })
      .catch((e) => {
        console.error(e);
        removeBlockingFileOperation(taskId);
      });
    taskProgress?.notifyTaskStarted?.();
  }

  async function waitForTerminalTask(taskId: string) {
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const task = await taskGet(taskId);
      if (!task) throw new Error($_("tasks.task_gone"));
      if (TERMINAL_TASK_STATUSES.has(task.status)) return task;
    }
  }

  function handleQueueDialog(value: string) {
    const sources = [...dlgSourcePaths];
    if (!sources.length) return;

    if (dlgType === "delete") {
      const target = value === "permanent" ? "permanent" : "trash";
      addQueuedOperation({ kind: "delete", sources, target });
    } else if (dlgType === "copy" || dlgType === "move") {
      const target = value.trim();
      if (!target) return;
      addQueuedOperation({ kind: dlgType, sources, target });
    } else {
      return;
    }

    closeDialog();

    // Adding through F2 is an immediate, sequential queue: start the head
    // operation now, while later additions remain queued behind it. Permanent
    // deletes still require the explicit confirmation in TransferQueue.
    if (get(transferQueue).some((operation) => operation.kind === "delete" && operation.target === "permanent")) {
      transferQueueOpen.set(true);
      return;
    }
    void runTransferQueue();
  }

  async function runTransferQueue() {
    if (transferQueueRunning) return;
    transferQueueRunning = true;

    try {
      while (true) {
        const operation = get(transferQueue)[0];
        if (!operation) {
          transferQueueOpen.set(false);
          return;
        }

        transferQueueRunningId.set(operation.id);
        try {
          const taskId = await taskCreate(operation.kind, operation.sources, operation.target);
          runTrackedTask(taskId);
          const task = await waitForTerminalTask(taskId);
          if (task.status !== "Completed") {
            return;
          }
          removeQueuedOperation(operation.id);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          activeOf(leftPanel, rightPanel)?.showActionToast?.(false, message, 8000);
          return;
        }
      }
    } finally {
      transferQueueRunningId.set(null);
      transferQueueRunning = false;
    }
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
  let dlgIsPermanent = $state(false);

  dialogState.subscribe((s) => {
    dlgType = s.type;
    dlgInputValue = s.inputValue;
    dlgEntries = s.entries;
    dlgSourcePaths = s.sourcePaths;
    dlgTargetDir = s.targetDir;
    dlgSourceDir = s.sourceDir;
    dlgIsPermanent = s.isPermanent ?? false;
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
    $transferQueueOpen ||
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
    $conflictState.visible ||
    // TaskProgress's conflict dialog opens on its own (a running task hits a
    // collision), so it has to announce itself rather than be opened by us.
    $taskConflictActive
  );


  $effect(() => {
    isOverlayActive.set(anyOverlayOpen);
  });

  // `options` is the shared pack dialog's `packOptions` (format, compression
  // level, follow_links). It was being dropped here, which is how the backend
  // ended up building a ZIP whatever format the user selected (P2.1/QSF-005).
  async function handleDialogConfirm(value: string, options?: any) {
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

              if (action.type === "delete") {
                // A failed permanent-delete task: replay every source. Ones
                // already removed before the failure are a no-op for `rm -rf`.
                for (const path of action.paths) {
                  await elevateOperation({ action: "delete", path, password: value });
                }
                pendingElevatedAction.set(null);
                break;
              }

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
                activeOf(leftPanel, rightPanel)?.showActionToast?.(false, $_('dialogs.elevation_failed', { error: errMsg }), 8000);
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
          // `value` is the dialog's chosen mode ("trash" | "permanent"), and
          // `target === "trash"` is the convention both backends read it by
          // (task_queue.rs::execute_delete on desktop, runDelete on web). This
          // used to pass "" for both, so the dialog's "move to trash" ran a
          // permanent, unrecoverable delete.
          const taskId = await taskCreate("delete", paths, value || "trash");
          runTrackedTask(taskId);
          break;
        }
        case "copy": {
          if (!value.trim()) return;
          const taskId = await taskCreate("copy", paths, value.trim());
          runTrackedTask(taskId);
          break;
        }
        case "move": {
          if (!value.trim()) return;
          const taskId = await taskCreate("move", paths, value.trim());
          runTrackedTask(taskId);
          break;
        }
        case "pack": {
          if (!value.trim()) return;
          await archivePack(paths, value.trim(), options);
          break;
        }
        case "unpack": {
          if (!value.trim()) return;
          // P2.3: extraction leaves existing files alone by default, so it can
          // finish cleanly without having produced the file the user came for.
          // Reporting the skip is the only way they find out.
          const report = await archiveUnpack(paths[0], value.trim());
          const panel = activeOf(leftPanel, rightPanel);
          if (report?.skipped_count > 0) {
            panel?.showActionToast?.(false, $_("archive.extract_skipped", { n: report.skipped_count }), 8000);
          } else if (report?.kept_both_count > 0) {
            panel?.showActionToast?.(true, $_("archive.extract_kept_both", { n: report.kept_both_count }), 8000);
          }
          break;
        }
        case "select_group": {
          if (!value.trim()) return;
          activeOf(leftPanel, rightPanel)?.handleSelectGroup?.(value.trim());
          break;
        }
        case "unselect_group": {
          if (!value.trim()) return;
          activeOf(leftPanel, rightPanel)?.handleUnselectGroup?.(value.trim());
          break;
        }
        case "split": {
          if (!value.trim()) return;
          const chunkSize = parseInt(value.trim());
          if (isNaN(chunkSize) || chunkSize <= 0) return;
          // Never discard an OpResult: a failed split that only reaches the
          // console leaves the user believing the parts were written.
          const res = await splitFile(paths[0], chunkSize, sourceDir);
          activeOf(leftPanel, rightPanel)?.showActionToast?.(
            res.success,
            res.success ? $_("archive.split_done", { detail: res.message }) : $_("archive.split_failed", { error: res.message }),
            res.success ? 5000 : 8000
          );
          break;
        }
        case "combine": {
          if (!value.trim()) return;
          const res = await combineFiles(paths, value.trim());
          activeOf(leftPanel, rightPanel)?.showActionToast?.(
            res.success,
            res.success ? $_("archive.combine_done", { detail: res.message }) : $_("archive.combine_failed", { error: res.message }),
            res.success ? 5000 : 8000
          );
          break;
        }
        case "confirm_download": {
          const pending = pendingBundleDownload;
          pendingBundleDownload = null;
          if (pending) await startZipDownload(pending.dir, pending.items, pending.name);
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
        activeOf(leftPanel, rightPanel)?.showActionToast?.(false, $_('dialogs.operation_failed', { error: msg }), 8000);
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
    pendingBundleDownload = null;
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
      runTrackedTask(taskId);
      refreshPanels().catch(console.error);
      closeDropMenu();
      scheduleForegroundTaskPopup(taskId);
      return taskId;
    } catch (e) {
      console.error(`${action} failed:`, e);
      closeDropMenu();
    }
  }

  // Paste runs like an internal drop: through the task queue, whose conflict
  // dialog asks before an existing file is replaced. It used to POST
  // /fs/copy|move, which refused any existing name without offering a choice.
  async function handlePaste({ operation, sources, targetDir }: { operation: "copy" | "move"; sources: string[]; targetDir: string }) {
    const taskId = await taskCreate(operation, sources, targetDir);
    runTrackedTask(taskId);
    scheduleForegroundTaskPopup(taskId);
  }

  function reportActionError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    activeOf(leftPanel, rightPanel)?.showActionToast?.(false, message, 6000);
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
      reportActionError(e);
    }
  }

  async function refreshPanels() {
    await new Promise((r) => setTimeout(r, 100));
    await Promise.all([
      leftPanel?.refresh?.(),
      rightPanel?.refresh?.(),
    ]);
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
    updateSettings((cfg) => {
      cfg.layout_show_menu = !cfg.layout_show_menu;
    });
    if ($appConfigStore) {
      applyConfig($appConfigStore);
    }
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
    updateSettings((cfg) => {
      cfg.file_op_options = newOptions;
    });
  }

  // Walking a browser DataTransfer and staging the result for the uploader is
  // web-only, so the shared FileList delegates it here and just shows the
  // names we return.
  async function handleExternalDrop(dt: DataTransfer): Promise<string[] | null> {
    const { collectFromDataTransfer } = await import("$lib/upload/webkitEntries");
    const result = await collectFromDataTransfer(dt);
    if (result.files.length === 0 && result.emptyDirs.length === 0) return null;

    pendingExternalDrop.set(result);
    return [...result.files.map((f) => f.rel), ...result.emptyDirs];
  }

  // Web persists straight to the server and announces the change, because
  // several components here listen for nc:settings-changed rather than the
  // store. Desktop routes the same config through updateSettings instead.
  async function handleApplyOptions(cleanConfig: any) {
    await saveSettings(cleanConfig);
    appConfigStore.set(cleanConfig);
    window.dispatchEvent(
      new CustomEvent("nc:settings-changed", { detail: cleanConfig }),
    );
  }

  // Escalation is the one part of the properties dialog the shells cannot
  // share: here we park the change and route the user through the
  // permission_denied → sudo_password flow, which replays it as root.
  // Browser-download plan §4.3 — the web-only decision between the
  // single-file fast path and the zip-bundle path. FileList never imports
  // this: it only calls the onDownload callback with dir + entries.
  const LARGE_SELECTION_CONFIRM_BYTES = 200 * 1024 * 1024;
  const LARGE_SELECTION_CONFIRM_COUNT = 25;
  let pendingBundleDownload: { dir: string; items: string[]; name: string } | null = null;

  function bundleDisplayName(dir: string, items: string[]): string {
    if (items.length === 1) return items[0];
    return `${items.length} bestanden`;
  }

  async function handleDownload(request: { dir: string; entries: any[] }) {
    const { dir, entries } = request;
    if (entries.length === 0) return;

    if (entries.length === 1 && !entries[0].is_dir) {
      const sep = dir === "/" ? "" : "/";
      downloadSingleFile(`${dir}${sep}${entries[0].name}`);
      return;
    }

    const items = entries.map((e) => e.name);
    const name = bundleDisplayName(dir, items);
    const estimatedBytes = entries.reduce((sum, e) => sum + (e.is_dir ? 0 : (e.size || 0)), 0);

    if (items.length >= LARGE_SELECTION_CONFIRM_COUNT || estimatedBytes >= LARGE_SELECTION_CONFIRM_BYTES) {
      pendingBundleDownload = { dir, items, name };
      openDialog({
        type: "confirm_download",
        inputValue: $_("download.confirm_large_selection", { count: items.length, size: formatSize(estimatedBytes) }),
      });
      return;
    }

    await startZipDownload(dir, items, name);
  }

  // Only a *permanent* delete is offered for elevation: the endpoint's delete
  // is `rm -rf`, so replaying a move-to-trash through it would turn the
  // recoverable choice the user made into the unrecoverable one.
  function canElevateTask(task: TaskInfo): boolean {
    return task.task_type === "Delete" && task.target === "permanent";
  }

  function handleTaskPermissionDenied(task: TaskInfo) {
    pendingElevatedAction.set({ type: "delete", value: "", paths: [...task.sources], sourceDir: "" });
    openDialog({
      type: "permission_denied",
      inputValue: task.sources.length === 1
        ? task.sources[0]
        : `${task.sources[0]} (${$_("dialog.more_items", { n: task.sources.length - 1 })})`,
    });
  }

  function handlePropertiesPermissionDenied(
    path: string,
    changes: { permissions?: string; owner?: string; group?: string }
  ) {
    pendingElevatedAction.set({
      type: "properties",
      value: "",
      paths: [path],
      sourceDir: "",
      ...changes,
    });
    openDialog({ type: "permission_denied", inputValue: path });
  }
  import TitleBar from "$lib/components/TitleBar.svelte";
</script>

<div class="app-shell">
  <TitleBar />
  {#if $appConfigStore === null || $appConfigStore.layout_show_menu !== false}
    <MenuBar showUpload showDownload />
  {/if}
  
  <Toolbar
    viewMode={toolbarViewMode}
    isVertical={$appConfigStore?.layout_is_vertical ?? true}
    isSingleView={$appConfigStore?.layout_single_view ?? false}
    showUpload={true}
  />
  <div class="panels-stage">
    <TwinPanels
      bind:this={twinPanels}
      bind:leftPanel
      bind:rightPanel
      fileList={FileList}
      fileListProps={{
        onopenrequest: handleOpenRequest,
        appConfigStore,
        updateSettings,
        onexternaldrop: handleExternalDrop,
        showUpload: true,
        showDownload: true,
        onDownload: handleDownload,
        onpaste: handlePaste,
      }}
      responsive={true}
      layout={{
        isVertical: $appConfigStore?.layout_is_vertical,
        singleView: $appConfigStore?.layout_single_view,
        panelRatio: $appConfigStore?.layout_panel_ratio,
      }}
      onpersistlayout={(s) => updateSettings((cfg) => {
        cfg.layout_is_vertical = s.isVertical;
        cfg.layout_single_view = s.singleView;
        cfg.layout_panel_ratio = s.panelRatio;
      })}
      onpersistviewmode={(side, mode) => updateSettings((cfg) => {
        if (side === "left") cfg.layout_left_view_mode = mode;
        else cfg.layout_right_view_mode = mode;
      })}
    />
    {#if blockingFileOperationIds.length > 0}
      <div class="file-operation-blocker" aria-hidden="true"></div>
    {/if}
  </div>
  <TaskProgress
    bind:this={taskProgress}
    onpermissiondenied={handleTaskPermissionDenied}
    canelevate={canElevateTask}
  />
  <UploadProgress />
  <DownloadProgress />

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
    isPermanent={dlgIsPermanent}
    onconfirm={handleDialogConfirm}
    oncancel={handleDialogCancel}
    onqueue={handleQueueDialog}
    queueAvailable={dlgType !== "copy" || !dlgSourcePaths.some((path) => path.includes("::"))}
    queueUnavailableReason={dlgType === "copy" && dlgSourcePaths.some((path) => path.includes("::")) ? $_("queue.archive_unavailable") : undefined}
    fileOpOptions={$appConfigStore?.file_op_options}
    onsaveoptions={handleSaveOptions}
    onpermissiondenied={handlePropertiesPermissionDenied}
  />

  {#if $transferQueueOpen}
    <TransferQueue
      running={transferQueueRunning}
      onexecute={runTransferQueue}
      onclose={() => transferQueueOpen.set(false)}
    />
  {/if}

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
    onexpand={() => taskProgress?.open?.()}
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
    <OptionsDialog
      appConfig={$appConfigStore}
      folderBracketsKey="layout_show_folder_brackets"
      parentRowKey="layout_show_parent_dir_row"
      onapply={handleApplyOptions}
      onclose={() => showOptions = false}
    />
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
    <AboutDialog
      version={packageInfo.version}
      platformTech={[
        { name: "Node.js", icon: Server, detail: "about.tech_node" },
        { name: "Vanilla CSS", icon: Palette, detail: "about.tech_css" }
      ]}
      onclose={() => showAbout = false}
    />
  {/if}

  {#if showHelp}
    <HelpDialog startTopic={helpTopic} onclose={() => showHelp = false} />
  {/if}

  <ActionPalette
    visible={showActionPalette}
    onclose={() => showActionPalette = false}
    onaction={handleActionPaletteAction}
    shortcutHint="F10"
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
