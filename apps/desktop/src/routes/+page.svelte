<script lang="ts">
  import { shellShortcut, isTextTarget } from "@nexus/ui/shortcuts";
  import { onMount, tick, type Component } from "svelte";
  import { get } from "svelte/store";
  import { getCurrentWindow, type Color } from "@tauri-apps/api/window";
  import { listen } from "@tauri-apps/api/event";
  import { initTheme, currentTheme, themes } from "$lib/theme";

  import "../app.css";
  import MenuBar from "@nexus/ui/components/MenuBar.svelte";
  import Toolbar from "@nexus/ui/components/Toolbar.svelte";
  import TwinPanels from "@nexus/ui/components/TwinPanels.svelte";
  import FileList from "@nexus/ui/components/FileList.svelte";
  import FunctionKeyBar from "@nexus/ui/components/FunctionKeyBar.svelte";
  import Dialog from "@nexus/ui/components/Dialog.svelte";
  import FileViewer from "@nexus/ui/components/FileViewer.svelte";
  import TaskProgress from "@nexus/ui/components/TaskProgress.svelte";
  import TransferQueue from "@nexus/ui/components/TransferQueue.svelte";
  import HotlistModal from "@nexus/ui/components/HotlistModal.svelte";
  import SearchModal from "@nexus/ui/components/SearchModal.svelte";
  import OptionsDialog from "@nexus/ui/components/OptionsDialog.svelte";
import DynamicIcon from "$lib/components/DynamicIcon.svelte";
import MultiRenameModal from "@nexus/ui/components/MultiRenameModal.svelte";
import NetworkConnectionsModal from "@nexus/ui/components/NetworkConnectionsModal.svelte";
import DropMenuModal from "@nexus/ui/components/DropMenuModal.svelte";
import HelpDialog from "@nexus/ui/components/HelpDialog.svelte";
import AboutDialog from "@nexus/ui/components/AboutDialog.svelte";
import { LucideLayers, LucideCpu } from "lucide-svelte";
import packageInfo from "../../package.json";
import PackProgressDialog from "$lib/components/PackProgressDialog.svelte";
import UnpackProgressDialog from "$lib/components/UnpackProgressDialog.svelte";
import ActionPalette from "@nexus/ui/components/ActionPalette.svelte";
import MiniPlayer from "@nexus/ui/components/MiniPlayer.svelte";
import { isAudioPath, playPlaylist } from "$lib/playerStore";
import type { OpenRequest } from "$lib/types";
import { loadLanguage, _ } from "$lib/i18n";
  import { describeTaskError } from "@nexus/ui/taskErrors";
import {
    dialogState,
    openDialog,
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
    dropMenuState,
    closeDropMenu,
    globalContextMenuStore,
    closeContextMenu,
    appConfigStore,
    updateSettings,
    activeOf,
    getActivePanelPath,
    runPanelAction
  } from "$lib/stores";
  import ContextMenu from "@nexus/ui/components/ContextMenu.svelte";
  import {
    getHomeDir,
    createDirectory,
    deleteEntries,
    copyEntries,
    moveEntries,
    openTerminal,
    openFile,
    loadSettings,
    saveSettings,
    archivePack,
    archiveUnpack,
    splitFile,
    combineFiles,
    compareDirectories,
    taskCreate,
    taskExecute,
    taskGet,
    exitApp,
    restartAsRoot,
    isRunningAsRoot,
    type AppConfig,
    type FileOpOptions
  } from "$lib/ipc";

  let isRoot = $state(false);
  let isVertical = $state(true);
  let currentActivePanel = $state("left");
  const activeViewMode = $derived(
    currentActivePanel === "left"
      ? (($appConfigStore?.left_view_mode as "brief" | "full") || "full")
      : (($appConfigStore?.right_view_mode as "brief" | "full") || "full")
  );
  const isSingleView = $derived($appConfigStore?.is_single_view ?? false);

  // appConfig is now sourced from the store
  const appConfig = $derived($appConfigStore);

  // Automatically apply configuration when the store changes
  $effect(() => {
    if (appConfig) {
      applyConfig(appConfig);
      if (appConfig.theme) {
        currentTheme.set(appConfig.theme as any);
        if (typeof window !== "undefined") {
          localStorage.setItem("nc-theme", appConfig.theme);
        }
      }
    }
  });

  let saveTimeout: any;

  const debouncedSaveBounds = async () => {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
      try {
        const win = getCurrentWindow();
        const pos = await win.outerPosition();
        const size = await win.outerSize();
        
        updateSettings((cfg) => {
          cfg.window_x = pos.x;
          cfg.window_y = pos.y;
          cfg.window_width = size.width;
          cfg.window_height = size.height;
        });
        console.log("Window bounds auto-saved:", { pos, size });
      } catch (e) {
        console.error("Failed to auto-save window bounds:", e);
      }
    }, 500);
  };

  const saveBoundsImmediately = async () => {
    clearTimeout(saveTimeout);
    try {
      const win = getCurrentWindow();
      const pos = await win.outerPosition();
      const size = await win.outerSize();
      
      updateSettings((cfg) => {
        cfg.window_x = pos.x;
        cfg.window_y = pos.y;
        cfg.window_width = size.width;
        cfg.window_height = size.height;
      });
      console.log("Window bounds saved on close:", { pos, size });
    } catch (e) {
      console.error("Failed to save bounds on close:", e);
    }
  };

  const handleExit = async () => {
    await saveBoundsImmediately();
    await exitApp();
  };

  /**
   * Elevation reports why it did not happen — a dismissed polkit prompt, a
   * failed authentication or the in-app confirmation being declined all come
   * back as an error. Swallowing that into the console left the user staring at
   * an unchanged window with no idea whether anything had been attempted.
   */
  const startAsRoot = async () => {
    try {
      await restartAsRoot();
    } catch (e: any) {
      console.error("Elevated restart failed:", e);
      const errStr = typeof e === "string" ? e : e?.message || String(e);
      activeOf(leftPanel, rightPanel)?.showActionToast?.(false, $_("dialogs.elevation_failed", { error: errStr }), 6000);
    }
  };

  // Must stay in sync with the startup script in app.html and with
  // theme_startup_color()/native_window_theme() in src-tauri/src/lib.rs. Rust paints
  // the native frame before the webview exists; this repaints it on every later
  // theme change, when Rust is no longer in the loop.
  const startupColors: Record<string, Color> = {
    "midnight": "#0a0e17",
    "dracula": "#21222c",
    "solarized-dark": "#00212b",
    "gruvbox": "#1d2021",
    "ocean": "#0f111a",
    "nortonly": "#003870",
    "github-light": "#f6f8fa",
    "solarized-light": "#fdf6e3",
    "gruvbox-light": "#fbf1c7",
    "catppuccin-latte": "#ffffff",
    "arctic-light": "#ffffff"
  };

  const setWindowStartupColor = async (theme: string) => {
    try {
      const lightThemes = new Set([
        "github-light",
        "solarized-light",
        "gruvbox-light",
        "catppuccin-latte",
        "arctic-light"
      ]);
      const win = getCurrentWindow();
      await Promise.all([
        win.setBackgroundColor(startupColors[theme] || startupColors.midnight),
        win.setTheme(lightThemes.has(theme) ? "light" : "dark")
      ]);
    } catch (e) {
      console.error("Failed to set startup window theme:", e);
    }
  };

  // The window ships hidden (`visible: false` in tauri.conf.json). Reveal it only
  // once the saved theme and language have actually painted, otherwise the user
  // sees a default-themed, untranslated frame first. Two rAFs: the first schedules
  // the paint, the second fires after it committed.
  //
  // Each rAF is capped by a timer because WebKitGTK runs no animation frames for a
  // window that is still hidden — the frames we are waiting for cannot commit until
  // the window is mapped, which is the thing this function is supposed to do. Left
  // unbounded, the await never resolved and every start sat there until the 3s
  // fallback in src-tauri/src/lib.rs showed the window instead (measured: 8.2s with
  // the older 8s fallback, 1.2s with this cap). The theme and language are already
  // on the DOM by the time `tick()` resolves, and the frame itself is painted in the
  // saved theme by theme_startup_color() plus the inline script in app.html, so the
  // timeout path reveals the same pixels — only without the extra frame of proof.
  const nextFrame = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 50);
      requestAnimationFrame(() => {
        clearTimeout(timer);
        resolve();
      });
    });

  const revealWindow = async () => {
    await tick();
    await nextFrame();
    await nextFrame();
    try {
      await getCurrentWindow().show();
    } catch (e) {
      console.error("Failed to show window:", e);
    }
  };

  onMount(() => {
    initTheme();

    // Check if running as root
    isRunningAsRoot().then(r => isRoot = r).catch(() => isRoot = false);

    // Load the saved theme and language before mounting and revealing the UI.
    const startApp = async () => {
      try {
        const cfg = await loadSettings();
        currentTheme.set(cfg.theme as any);
        await setWindowStartupColor(cfg.theme);

        // Language detection on first run / if empty
        let lang = cfg.language;
        let detectedLanguage = false;
        if (!lang || lang === "" || lang === "doublecmd.pot") {
          lang = navigator.language || "en";
          cfg.language = lang;
          detectedLanguage = true;
        }
        await loadLanguage(lang);
        applyConfig(cfg);
        appConfigStore.set(cfg);
        if (detectedLanguage) {
          updateSettings((c) => {
            c.language = lang;
          });
        }
      } catch (e) {
        console.error(e);
      } finally {
        await revealWindow();
      }
    };
    void startApp();

    const handleSettingsChanged = (e: CustomEvent<AppConfig>) => {
      appConfigStore.set(e.detail);
      currentTheme.set(e.detail.theme as any);
      setWindowStartupColor(e.detail.theme);
    };

    const unsubAP = activePanel.subscribe(v => currentActivePanel = v);

    const handleOpenMultiRename = (e: CustomEvent<{entries: any[], path: string, side: string}>) => {
      multiRenameData = e.detail;
    };

    const handleMenuAction = (e: CustomEvent<string>) => {
      const action = e.detail;
      if (anyOverlayOpen && action !== "task-manager" && !(showOptions && action === "help-options")) return;
      // Toolbar buttons dispatch through the same event as MenuBar/ActionPalette.
      if (action === "refresh") handleToolbarRefresh();
      else if (action === "go-home") handleToolbarHome();
      else if (action === "go-up") handleToolbarUp();
      else if (action === "toggle-menu-bar") handleToolbarToggleMenu();
      else if (action === "toggle-view-mode") handleToolbarBrief();
      else if (action === "exit") handleExit();
      else if (action === "start-as-root") {
        // The menu entry is disabled while elevated; this also covers any other
        // sender, so an already-root process never re-prompts polkit.
        if (!isRoot) startAsRoot();
      }
      else if (action === "hotlist") showHotlist = true;
      else if (action === "search") showSearch = true;
      else if (action === "net-connections" || action === "net-disconnect") showNetwork = true;
      else if (action === "compare-dirs") handleCompareDirs();
      else if (action === "equalize-panels") twinPanels?.equalizePanels?.();
      else if (action === "toggle-layout") twinPanels?.toggleLayout?.();
      else if (action === "view-tree") {
        twinPanels?.toggleActiveTree?.();
      } else if (action === "quick-view") {
        twinPanels?.toggleQuickView?.();
      } else if (action === "task-manager") {
        taskProgress?.open?.();
      }
      else if (action === "toggle-single-view") {
        twinPanels?.toggleSingleView?.();
      }
      else if (action === "view-brief") {
        twinPanels?.setViewMode?.("brief");
      }
      else if (action === "view-full") {
        twinPanels?.setViewMode?.("full");
      }
      else if (action === "command-palette") {
        showActionPalette = true;
      }
      else if (action === "swap-panels") {
        let lp = "", rp = "";
        const unsub1 = leftPanelPath.subscribe((v) => (lp = v));
        const unsub2 = rightPanelPath.subscribe((v) => (rp = v));
        unsub1(); unsub2();
        leftPanelPath.set(rp);
        rightPanelPath.set(lp);
        window.dispatchEvent(new CustomEvent("nc:swap-panels"));
      } else if (action === "target-source") {
        let ap: string = "left";
        const unsub = activePanel.subscribe((v) => (ap = v));
        unsub();
        let activePath = "";
        const unsub2 = (ap === "left" ? leftPanelPath : rightPanelPath).subscribe(
          (v) => (activePath = v),
        );
        unsub2();
        if (ap === "left") {
          rightPanelPath.set(activePath);
        } else {
          leftPanelPath.set(activePath);
        }
        window.dispatchEvent(new CustomEvent("nc:target-source"));
      }
      // Selection and per-file archive actions go to the active panel; the
      // list itself lives in @nexus/ui so both shells route the same set.
      else if (runPanelAction(action, leftPanel, rightPanel)) { /* handled */ }
      else if (action === "options") {
        showOptions = true;
      } else if (action === "help-contents") {
        initialHelpTopic = "intro";
        showHelp = true;
      } else if (action === "help-options") {
        initialHelpTopic = "options";
        showHelp = true;
      } else if (action === "help-shortcuts") {
        initialHelpTopic = "shortcuts";
        showHelp = true;
      } else if (action === "technical-support") {
        initialHelpTopic = "tech-support";
        showHelp = true;
      } else if (action === "about") {
        showAbout = true;
      }
      else if (action === "multi-rename") {
        activeOf(leftPanel, rightPanel)?.handleMultiRename?.();
      } else if (action === "open-terminal") {
        const path = getActivePanelPath();
        if (path) openTerminal(path).catch(reportActionError);
      } else if (action === "pack") {
        activeOf(leftPanel, rightPanel)?.handlePack?.();
      } else if (action === "unpack") {
        activeOf(leftPanel, rightPanel)?.handleUnpack?.();
      } else if (action === "select-group") {
        activeOf(leftPanel, rightPanel)?.handleSelectGroup?.();
      } else if (action === "unselect-group") {
        activeOf(leftPanel, rightPanel)?.handleUnselectGroup?.();
      } else if (action.startsWith("sort-")) {
        const col = ({ "sort-ext": "extension", "sort-date": "modified" } as Record<string, string>)[action] || action.split("-")[1] as any;
        activeOf(leftPanel, rightPanel)?.handleSort?.(col);
      }
    };

    const handleKeydown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || showActionPalette) return;
      const action = shellShortcut(e);
      if (!action) return;
      if (action !== "toggle-tasks" && (anyOverlayOpen || isTextTarget(e.target))) return;
      e.preventDefault();
      if (action === "toggle-tasks") taskProgress?.toggle?.();
      else handleMenuAction(new CustomEvent("nc:menu-action", { detail: action }));
    };

    // FilePropertiesDialog dispatches this after a successful chmod/chown so both
    // panels pick up the new permissions/owner.
    const handleRefreshPanels = () => {
      handleToolbarRefresh();
    };

    // External changes can occur while the application is in the background.
    // Refresh both panes as soon as the window becomes active again.
    const handleWindowFocus = () => {
      handleToolbarRefresh().catch(console.error);
    };

    window.addEventListener("nc:menu-action", handleMenuAction as EventListener);
    window.addEventListener("nc:settings-changed", handleSettingsChanged as EventListener);
    window.addEventListener("nc:open-multi-rename", handleOpenMultiRename as EventListener);
    window.addEventListener("nc:refresh-panels", handleRefreshPanels);
    window.addEventListener("nc:exit", handleExit as EventListener);
    window.addEventListener("keydown", handleKeydown);
    window.addEventListener("focus", handleWindowFocus);


    let unlistenResize: () => void;
    let unlistenMove: () => void;
    let unlistenClose: () => void;

    const win = getCurrentWindow();
    win.listen("tauri://resize", debouncedSaveBounds).then(u => unlistenResize = u);
    win.listen("tauri://move", debouncedSaveBounds).then(u => unlistenMove = u);
    win.listen("tauri://close-requested", async () => {
      await handleExit();
    }).then(u => unlistenClose = u);

    let unlistenSettings: () => void;
    listen<AppConfig>("settings-changed", (event) => {
      appConfigStore.set(event.payload);
      currentTheme.set(event.payload.theme as any);
      setWindowStartupColor(event.payload.theme);
      applyConfig(event.payload);
    }).then(u => unlistenSettings = u);

    // OS-level drops arrive as Tauri events rather than DOM drag events, so
    // the shell receives them and hands the paths to whichever panel the
    // pointer is over. The panel itself only knows about DOM drops.
    let unlistenDrop: () => void;
    listen<{ paths: string[] }>("tauri://file-drop", (event) => {
      const target = rightPanel?.isPointerInside?.()
        ? rightPanel
        : leftPanel?.isPointerInside?.()
          ? leftPanel
          : $activePanel === "right"
            ? rightPanel
            : leftPanel;
      target?.externalDropAt?.(
        event.payload.paths,
        window.innerWidth / 2,
        window.innerHeight / 2,
      );
    }).then(u => unlistenDrop = u);

    return () => {
      if (unlistenDrop) unlistenDrop();
      window.removeEventListener("nc:menu-action", handleMenuAction as EventListener);
      window.removeEventListener("nc:settings-changed", handleSettingsChanged as EventListener);
      window.removeEventListener("nc:open-multi-rename", handleOpenMultiRename as EventListener);
      window.removeEventListener("nc:refresh-panels", handleRefreshPanels);
      window.removeEventListener("nc:exit", handleExit as EventListener);
      window.removeEventListener("keydown", handleKeydown);
      window.removeEventListener("focus", handleWindowFocus);
      if (unlistenResize) unlistenResize();
      if (unlistenMove) unlistenMove();
      if (unlistenClose) unlistenClose();
      if (unlistenSettings) unlistenSettings();
      clearTimeout(saveTimeout);
      if (unsubAP) unsubAP();
    };
  });
  function applyConfig(cfg: AppConfig) {
    if (cfg.language) loadLanguage(cfg.language);
    
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
      
      if (cfg.font_status_name) root.style.setProperty("--font-status-name", cfg.font_status_name);
      if (cfg.font_status_size) root.style.setProperty("--font-status-size", `${cfg.font_status_size}px`);

      // Derive row height and icon size from pane font size
      const paneSize = Number(cfg.font_pane_size) || 12;
      const rowHeight = Math.round(paneSize * 1.8 + 8);
      const iconSize  = Math.max(14, Math.round(rowHeight * 0.65));
      root.style.setProperty("--row-height", `${rowHeight}px`);
      root.style.setProperty("--icon-size",  `${iconSize}px`);

      // Language
      if (cfg.language) {
        loadLanguage(cfg.language);
      }
    }
  }

  let twinPanels: any = $state(null);
  let leftPanel: any = $state(null);
  let rightPanel: any = $state(null);
  let taskProgress: any = $state(null);
  let showHotlist = $state(false);
  let showSearch = $state(false);
  let showOptions = $state(false);
  let showNetwork = $state(false);
  let multiRenameData = $state<{entries: any[], path: string, side: string} | null>(null);
  let showHelp = $state(false);
  let showAbout = $state(false);
  let showPackProgress = $state(false);
  let showUnpackProgress = $state(false);
  let showActionPalette = $state(false);
  let initialHelpTopic = $state("intro");
  const watchedTaskRefreshes = new Set<string>();

  // Viewer state
  let viewerPath: string | null = $state(null);
  let viewerSiblingPaths: string[] = $state([]);

  function handleViewFile(path: string, siblingPaths: string[]) {
    if (isAudioPath(path)) {
      const choice = appConfig?.audio_player || "builtin";
      if (choice === "system") {
        openFile(path).catch((err) => {
          console.error("System audio player failed:", err);
          window.alert($_("audio.system_open_failed"));
          playPlaylist(siblingPaths, path);
        });
      } else {
        playPlaylist(siblingPaths, path);
      }
      return;
    }
    viewerPath = path;
    viewerSiblingPaths = siblingPaths;
  }

  function closeViewer() {
    viewerPath = null;
    viewerSiblingPaths = [];
  }

  // Editor state
  let editorPath: string | null = $state(null);
  let TextEditorModal: Component<{
    path: string;
    onclose: () => void;
  }> | null = $state(null);
  let editorLoadRequest = 0;

  async function handleEditFile(path: string, siblingPaths: string[]) {
    const request = ++editorLoadRequest;

    try {
      const component = TextEditorModal
        ?? (await import("$lib/components/TextEditorModal.svelte")).default;

      // A second edit request may have selected another file while the editor
      // chunk was loading. Only the newest request is allowed to open it.
      if (request !== editorLoadRequest) return;

      TextEditorModal = component;
      editorPath = path;
    } catch (e) {
      reportActionError(e);
    }
  }

  // The shared FileList reports every open through one request rather than
  // separate view/edit callbacks; "open" means launch the system handler,
  // which is what desktop's own double-click path used to do inline.
  function handleOpenRequest(request: OpenRequest) {
    if (request.intent === "edit") {
      handleEditFile(request.path, request.siblingPaths ?? []);
    } else if (request.intent === "view") {
      handleViewFile(request.path, request.siblingPaths ?? []);
    } else if (isAudioPath(request.path)) {
      handleViewFile(request.path, request.siblingPaths ?? []);
    } else {
      openFile(request.path).catch(reportActionError);
    }
  }

  function closeEditor() {
    editorLoadRequest += 1;
    editorPath = null;
    refreshPanels();
  }

  // Dialog state
  let dlgType = $state<typeof $dialogState.type>(null);
  let dlgInputValue = $state("");
  let dlgEntries = $state<typeof $dialogState.entries>([]);
  let dlgSourcePaths = $state<string[]>([]);
  let dlgTargetDir = $state("");
  let dlgSourceDir = $state("");
  let dlgIsPermanent = $state(false);
  let transferQueueRunning = $state(false);

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
    showNetwork || 
    !!multiRenameData || 
    !!viewerPath ||
    dropMenu.visible ||
    gMenu.visible ||
    showHelp ||
    // TaskProgress's conflict dialog opens on its own (a running task hits a
    // collision), so it has to announce itself rather than be opened by us.
    // Without this the panels kept answering arrow keys, Tab and F-keys
    // underneath a modal asking whether to overwrite a file.
    $taskConflictActive
  );


  $effect(() => {
    isOverlayActive.set(anyOverlayOpen);
  });

  /**
   * Extract, then phrase the outcome from the report instead of from "nothing
   * threw" (P2.3).
   *
   * The backend defaults to leaving existing files alone, so an extraction can
   * finish cleanly and still not have produced the file the user came for. Saying
   * "successful" in that case is the reporting half of the bug the staging
   * protocol fixed: the destination is intact, but the user has to be told why.
   */
  async function unpackAndReport(
    archivePath: string,
    destDir: string,
    entriesFilter: string[] | undefined,
    successMessage: string
  ) {
    const report = await archiveUnpack(archivePath, destDir, entriesFilter);
    const panel = activeOf(leftPanel, rightPanel);
    if (report.skipped_count > 0) {
      panel?.showActionToast?.(false, $_("archive.extract_skipped", { n: report.skipped_count }), 8000);
      return;
    }
    if (report.kept_both_count > 0) {
      panel?.showActionToast?.(true, $_("archive.extract_kept_both", { n: report.kept_both_count }), 8000);
      return;
    }
    panel?.showActionToast?.(true, successMessage);
  }

  async function handleDialogConfirm(value: string, options?: any) {
    const type = dlgType;
    const paths = [...dlgSourcePaths];
    const sourceDir = dlgSourceDir;
    let refreshAfterConfirm = true;
    closeDialog();

    try {
      switch (type) {
        case "mkdir": {
          if (!value.trim()) return;
          const fullPath = sourceDir === "/"
            ? `/${value.trim()}`
            : `${sourceDir}/${value.trim()}`;
          await createDirectory(fullPath);
          break;
        }
        case "delete": {
          await startBackgroundTask("delete", paths, value || "trash");
          refreshAfterConfirm = false;
          break;
        }
        case "copy": {
          if (!value.trim()) return;
          const isArchiveSource = paths.some(p => p.match(/\.(zip|tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz|tar\.zst|tzst|zst|7z|rar)(\/|::).+/i));

          if (isArchiveSource) {
            let archivePath = paths[0] || sourceDir;
            const match = archivePath.match(/^(.*?\.(?:zip|tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz|tar\.zst|tzst|zst|7z|rar))(?:\/|::|$)/i);
            if (match) archivePath = match[1];

            const entryNames = paths.map(p => {
              const parts = p.split(/\.(?:zip|tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz|tar\.zst|tzst|zst|7z|rar)[\/:]+/i);
              return parts.length > 1 ? parts[1] : "";
            }).filter(n => n.length > 0);

            const entriesFilter = entryNames.length > 0 ? entryNames : (dlgEntries && dlgEntries.length > 0 ? dlgEntries.map(e => e.name) : undefined);

            showUnpackProgress = true;
            await tick();
            try {
              await unpackAndReport(
                archivePath,
                value.trim(),
                entriesFilter,
                $_("archive.extract_done")
              );
            } catch (e: any) {
              console.error("Archive extraction error:", e);
              const errStr = typeof e === "string" ? e : e?.message || String(e);
              if (errStr.includes("Permission denied") || errStr.includes("EACCES") || errStr.includes("os error 13")) {
                openDialog({
                  type: "permission_denied",
                  inputValue: value.trim(),
                  sourcePaths: [archivePath],
                  targetDir: value.trim()
                });
                refreshAfterConfirm = false;
              } else {
                activeOf(leftPanel, rightPanel)?.showActionToast?.(false, $_("archive.extract_failed", { error: errStr }), 6000);
              }
            } finally {
              showUnpackProgress = false;
            }
          } else {
            await startBackgroundTask("copy", paths, value.trim());
            refreshAfterConfirm = false;
          }
          break;
        }
        case "move": {
          if (!value.trim()) return;
          await startBackgroundTask("move", paths, value.trim());
          refreshAfterConfirm = false;
          break;
        }
        case "pack": {
          if (!value.trim()) return;
          showPackProgress = true;
          try {
            await archivePack(paths, value.trim(), options);
            activeOf(leftPanel, rightPanel)?.showActionToast?.(true, $_("archive.pack_done"));
          } catch (e: any) {
            console.error("Pack error:", e);
            const errStr = typeof e === "string" ? e : e?.message || String(e);
            activeOf(leftPanel, rightPanel)?.showActionToast?.(false, $_("archive.pack_failed", { error: errStr }), 6000);
          } finally {
            showPackProgress = false;
          }
          break;
        }
        case "unpack": {
          if (!value.trim()) return;
          const entryNames = paths.map(p => {
            const parts = p.split(/\.(?:zip|tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz|tar\.zst|tzst|zst|7z|rar)[\/:]+/i);
            return parts.length > 1 ? parts[1] : "";
          }).filter(n => n.length > 0);

          const entriesFilter = entryNames.length > 0 ? entryNames : (dlgEntries && dlgEntries.length > 0 ? dlgEntries.map(e => e.name) : undefined);

          let archivePath = paths[0];
          const match = archivePath.match(/^(.*?\.(?:zip|tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz|tar\.zst|tzst|zst|7z|rar))(?:\/|::|$)/i);
          if (match) archivePath = match[1];

          showUnpackProgress = true;
          await tick();
          try {
            await unpackAndReport(
              archivePath,
              value.trim(),
              entriesFilter,
              $_("archive.extract_done")
            );
          } catch (e: any) {
            console.error("Unpack error:", e);
            const errStr = typeof e === "string" ? e : e?.message || String(e);
            if (errStr.includes("Permission denied") || errStr.includes("EACCES") || errStr.includes("os error 13")) {
              openDialog({
                type: "permission_denied",
                inputValue: value.trim(),
                sourcePaths: [archivePath],
                targetDir: value.trim()
              });
              refreshAfterConfirm = false;
            } else {
              activeOf(leftPanel, rightPanel)?.showActionToast?.(false, $_("archive.extract_failed", { error: errStr }), 6000);
            }
          } finally {
            showUnpackProgress = false;
          }
          break;
        }
        case "permission_denied": {
          // Straight to the elevated restart. This used to open the shared
          // password dialog first and then discard what was typed: pkexec asks
          // for the password itself, in the system's own prompt, so the field
          // only taught users to type their password where nothing used it.
          refreshAfterConfirm = false;
          if (!isRoot) await startAsRoot();
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
      }
    } catch (e: any) {
      console.error("Operation failed:", e);
      const errStr = typeof e === "string" ? e : e?.message || String(e);
      activeOf(leftPanel, rightPanel)?.showActionToast?.(false, $_("dialogs.operation_failed", { error: errStr }), 6000);
    }

    if (refreshAfterConfirm) await refreshPanels();
  }

  async function handleMultiRenameComplete() {
    multiRenameData = null;
    await refreshPanels();
  }

  function handleDialogCancel() {
    closeDialog();
  }

  async function handleDropMenuAction(action: "copy" | "move") {
    const { files, targetDir } = dropMenu;
    closeDropMenu();
    if (files.length === 0) return;
    try {
      await transferEntries(action, files, targetDir);
    } catch (e) {
      reportActionError(e);
    }
  }

  /**
   * Copy or move `files` into `targetDir` the way a drop does: archive
   * members are extracted, everything else goes through the task queue, whose
   * conflict dialog asks before an existing file is replaced. Paste uses this
   * too — it used to call copy_entries/move_entries, which replaced an
   * existing file of the same name without a question.
   *
   * Throws when the background task could not be started; extraction reports
   * its own failures.
   */
  async function transferEntries(action: "copy" | "move", files: string[], targetDir: string) {
    const isArchiveSource = files.some(p => p.match(/\.(zip|tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz|tar\.zst|tzst|zst|7z|rar)(\/|::).+/i));
    if (isArchiveSource) {
      let archivePath = files[0];
      const match = archivePath.match(/^(.*?\.(?:zip|tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz|tar\.zst|tzst|zst|7z|rar))(?:\/|::|$)/i);
      if (match) archivePath = match[1];

      const entryNames = files.map(p => {
        const parts = p.split(/\.(?:zip|tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz|tar\.zst|tzst|zst|7z|rar)[\/:]+/i);
        return parts.length > 1 ? parts[1] : "";
      }).filter(n => n.length > 0);

      const entriesFilter = entryNames.length > 0 ? entryNames : undefined;

      showUnpackProgress = true;
      await tick();
      try {
        await unpackAndReport(archivePath, targetDir, entriesFilter, $_("archive.extract_done"));
        await refreshPanels();
      } catch (e: any) {
        console.error("Archive extraction failed:", e);
        const errStr = typeof e === "string" ? e : e?.message || String(e);
        if (errStr.includes("Permission denied") || errStr.includes("EACCES") || errStr.includes("os error 13")) {
          openDialog({
            type: "permission_denied",
            inputValue: targetDir,
            sourcePaths: [archivePath],
            targetDir: targetDir
          });
        } else {
          activeOf(leftPanel, rightPanel)?.showActionToast?.(false, $_("archive.extract_failed", { error: errStr }), 6000);
        }
      } finally {
        showUnpackProgress = false;
      }
      return;
    }
    await startBackgroundTask(action, files, targetDir);
  }

  function handlePaste(request: { operation: "copy" | "move"; sources: string[]; targetDir: string }) {
    return transferEntries(request.operation, request.sources, request.targetDir);
  }

  async function startBackgroundTask(
    action: "copy" | "move" | "delete",
    sources: string[],
    target: string
  ) {
    const taskId = await taskCreate(action, sources, target);
    startTrackedTask(taskId);
  }

  function startTrackedTask(taskId: string) {
    // `taskExecute` starts asynchronously and returns its initial task record.
    // Inspect that record as well as transport failures: a scheduler rejection
    // can already be Failed before TaskProgress observes it.
    taskExecute(taskId)
      .then((task) => {
        if (task?.status === "Failed" && task.error) {
          activeOf(leftPanel, rightPanel)?.showActionToast?.(false, describeTaskError(task, $_).message, 8000);
        }
      })
      .catch(reportActionError);
    taskProgress?.notifyTaskStarted?.();
    watchTaskRefresh(taskId);
  }

  async function waitForTerminalTask(taskId: string) {
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const task = await taskGet(taskId);
      if (!task) throw new Error($_("tasks.task_gone"));
      if (task.status === "Completed" || task.status === "Failed" || task.status === "Cancelled") {
        return task;
      }
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
          startTrackedTask(taskId);
          const task = await waitForTerminalTask(taskId);
          if (task.status !== "Completed") {
            return;
          }
          removeQueuedOperation(operation.id);
        } catch (error) {
          reportActionError(error);
          return;
        }
      }
    } finally {
      transferQueueRunningId.set(null);
      transferQueueRunning = false;
    }
  }

  function watchTaskRefresh(taskId: string) {
    if (watchedTaskRefreshes.has(taskId)) return;
    watchedTaskRefreshes.add(taskId);

    void (async () => {
      try {
        while (true) {
          await new Promise((r) => setTimeout(r, 1000));
          const task = await taskGet(taskId);
          if (!task) {
            await refreshPanels();
            return;
          }
          if (task.status === "Completed" || task.status === "Failed" || task.status === "Cancelled") {
            await refreshPanels();
            return;
          }
        }
      } catch (e) {
        console.error("Task refresh watcher failed:", e);
      } finally {
        watchedTaskRefreshes.delete(taskId);
      }
    })();
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
    await twinPanels?.refreshAll?.();
  }

  function handleDriveSelect(path: string) {
    let ap = "left";
    const unsub = activePanel.subscribe(v => ap = v);
    unsub();

    if (ap === "left") {
      leftPanelPath.set(path);
    } else {
      rightPanelPath.set(path);
    }
  }
  async function handleToolbarRefresh() {
    await twinPanels?.refreshAll?.();
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
    if (appConfig) applyConfig(appConfig);
  }

  function handleToolbarBrief() {
    updateSettings((cfg) => {
      if (currentActivePanel === "left") {
        cfg.left_view_mode = cfg.left_view_mode === "brief" ? "full" : "brief";
      } else {
        cfg.right_view_mode = cfg.right_view_mode === "brief" ? "full" : "brief";
      }
    });
  }

  function handleSaveOptions(newOptions: FileOpOptions) {
    updateSettings((cfg) => {
      cfg.file_op_options = newOptions;
    });
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
</script>

<div class="app-shell">
  {#if appConfig === null || appConfig.layout_show_menu}
    <MenuBar showExit showElevate isRoot={isRoot} />
  {/if}
  
  <Toolbar
    viewMode={activeViewMode}
    isVertical={isVertical}
    isSingleView={isSingleView}
    isRoot={isRoot}
    showExit={true}
  />
  <TwinPanels
    bind:this={twinPanels}
    bind:leftPanel={leftPanel}
    bind:rightPanel={rightPanel}
    bind:isVertical={isVertical}
    fileList={FileList}
    fileListProps={{
      onopenrequest: handleOpenRequest,
      appConfigStore,
      updateSettings,
      iconRenderer: DynamicIcon,
      onpaste: handlePaste,
    }}
    layout={{
      leftMode: appConfig?.left_mode as "list" | "tree" | "quickview" | undefined,
      rightMode: appConfig?.right_mode as "list" | "tree" | "quickview" | undefined,
      isVertical: appConfig?.is_vertical_layout,
      singleView: appConfig?.is_single_view,
      panelRatio: appConfig?.panel_ratio,
    }}
    onpersistlayout={(s) => updateSettings((cfg) => {
      cfg.left_mode = s.leftMode;
      cfg.right_mode = s.rightMode;
      cfg.is_vertical_layout = s.isVertical;
      cfg.is_single_view = s.singleView;
      cfg.panel_ratio = s.panelRatio;
    })}
    onpersistviewmode={(side, mode) => updateSettings((cfg) => {
      if (side === "left") cfg.left_view_mode = mode;
      else cfg.right_view_mode = mode;
    })}
  />
  <!-- A task refused for permissions can only be redone from an elevated
       instance; restart_as_root asks for confirmation itself. -->
  <TaskProgress
    bind:this={taskProgress}
    onpermissiondenied={startAsRoot}
    canelevate={() => !isRoot}
  />
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
    fileOpOptions={appConfig?.file_op_options}
    onsaveoptions={handleSaveOptions}
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

  <!-- File Viewer Overlay -->
  {#if viewerPath}
    <FileViewer path={viewerPath} siblingPaths={viewerSiblingPaths} onclose={closeViewer} />
  {/if}

  <!-- Text Editor Overlay -->
  {#if editorPath && TextEditorModal}
    <TextEditorModal path={editorPath} onclose={closeEditor} />
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
      onapply={(cfg) => updateSettings((c) => Object.assign(c, cfg))}
      showSavedViews
      iconPreview={DynamicIcon}
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

  {#if gMenu.visible}
    <ContextMenu 
      options={gMenu.options} 
      x={gMenu.x} 
      y={gMenu.y} 
      onclose={closeContextMenu} 
    />
  {/if}
  {#if showHelp}
    <HelpDialog startTopic={initialHelpTopic} onclose={() => showHelp = false} />
  {/if}
  {#if showAbout}
    <AboutDialog
      version={packageInfo.version}
      platformTech={[
        { name: "Tauri v2", icon: LucideLayers, detail: "about.tech_tauri" },
        { name: "Rust", icon: LucideCpu, detail: "about.tech_rust" }
      ]}
      onclose={() => showAbout = false}
    />
  {/if}
  {#if showPackProgress}
    <PackProgressDialog onclose={() => showPackProgress = false} />
  {/if}
  {#if showUnpackProgress}
    <UnpackProgressDialog onclose={() => showUnpackProgress = false} />
  {/if}
  {#if showActionPalette}
    <ActionPalette
      visible={showActionPalette}
      onclose={() => showActionPalette = false}
      onaction={handleActionPaletteAction}
      shortcutHint="F10 / F12 / Ctrl+P"
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
</style>
