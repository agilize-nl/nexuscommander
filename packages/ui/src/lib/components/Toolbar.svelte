<script lang="ts">
  import { isOverlayActive } from "../stores";
  import { _ } from "../i18n";
  import {
    RefreshCw,
    Home,
    ArrowUp,
    Menu as MenuIcon,
    LayoutGrid,
    PanelTop,
    Star,
    Settings,
    Upload,
    Columns,
    LogOut
  } from "lucide-svelte";

  /**
   * Shared toolbar. Every button dispatches the same `nc:menu-action` window
   * event the MenuBar/ActionPalette already use, so the app shell has a single
   * dispatch mechanism instead of a mix of events and callback props.
   *
   * Layout state comes in as props: each shell derives it from its own
   * `appConfigStore` (the config schemas differ per app and stay app-local).
   */
  interface Props {
    isRoot?: boolean;
    isVertical?: boolean;
    viewMode?: "brief" | "full";
    isSingleView?: boolean;
    /** Web shell: upload button (no equivalent on desktop). */
    showUpload?: boolean;
    /** Desktop shell: exit button (the browser closes its own tab). */
    showExit?: boolean;
  }

  let {
    isRoot = false,
    isVertical = true,
    viewMode = "full",
    isSingleView = false,
    showUpload = false,
    showExit = false
  }: Props = $props();

  let overlayActive = $state(false);
  isOverlayActive.subscribe(v => overlayActive = v);

  function act(action: string) {
    if (overlayActive) return;
    window.dispatchEvent(new CustomEvent("nc:menu-action", { detail: action }));
  }
</script>

<div class="toolbar">
  {#if isRoot}
    <span class="root-indicator" title={$_("toolbar.running_as_root")}>ROOT</span>
    <div class="sep"></div>
  {/if}

  <button class="toolbar-btn" onclick={() => act("refresh")} title={$_("toolbar.refresh")}>
    <RefreshCw size={18} />
  </button>

  <div class="sep"></div>

  <button class="toolbar-btn" onclick={() => act("go-home")} title={$_("toolbar.home")}>
    <Home size={18} />
  </button>

  <button class="toolbar-btn" onclick={() => act("go-up")} title={$_("toolbar.up")}>
    <ArrowUp size={18} />
  </button>

  <div class="sep"></div>

  <button class="toolbar-btn" onclick={() => act("toggle-menu-bar")} title={$_("toolbar.toggle_menu")}>
    <MenuIcon size={18} />
  </button>

  <div class="sep"></div>

  <button
    class="toolbar-btn"
    onclick={() => act("toggle-view-mode")}
    title={viewMode === "full" ? $_("menu.view_brief") : $_("menu.view_full")}
  >
    {#if viewMode === "full"}
      <LayoutGrid size={18} />
    {:else}
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <rect x="6" y="6" width="12" height="4" rx="1" />
        <rect x="6" y="14" width="12" height="4" rx="1" />
      </svg>
    {/if}
  </button>

  <button
    class="toolbar-btn"
    onclick={() => act("toggle-single-view")}
    title={isSingleView ? $_("menu.dual_view") : $_("menu.single_view")}
  >
    {#if isSingleView}
      <!-- Dual View icon: PanelTop with a vertical split line in the bottom area -->
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M3 9h18" />
        <path d="M12 9v12" />
      </svg>
    {:else}
      <PanelTop size={18} />
    {/if}
  </button>

  <button
    class="toolbar-btn"
    onclick={() => act("toggle-layout")}
    title={isVertical ? $_("menu.layout_horizontal") : $_("menu.layout_vertical")}
  >
    <span class="icon-wrapper" class:rotated={isVertical}>
      <Columns size={18} />
    </span>
  </button>

  <div class="sep"></div>

  <button class="toolbar-btn" onclick={() => act("hotlist")} title={$_("toolbar.hotlist")}>
    <Star size={18} />
  </button>

  {#if showUpload}
    <button class="toolbar-btn" onclick={() => act("upload-files")} title={$_("menu.upload_files")}>
      <Upload size={18} />
    </button>
  {/if}

  <button class="toolbar-btn" onclick={() => act("options")} title={$_("toolbar.options")}>
    <Settings size={18} />
  </button>

  <div class="spacer"></div>

  {#if showExit}
    <button class="toolbar-btn btn-exit" onclick={() => act("exit")} title={$_("toolbar.exit")}>
      <LogOut size={18} />
    </button>
  {/if}
</div>

<style>
  .toolbar {
    display: flex;
    align-items: center;
    height: 34px;
    background: var(--color-nc-bg-header);
    border-bottom: 1px solid var(--color-nc-border);
    padding: 0 6px;
    gap: 2px;
  }

  .toolbar-btn {
    width: 30px;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    outline: none;
    border-radius: 4px;
    color: var(--color-nc-text);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .toolbar-btn:focus {
    outline: none;
  }

  .toolbar-btn:hover {
    background: var(--color-nc-bg-hover);
    color: var(--color-nc-text-bright);
    transform: translateY(-1px);
  }

  .toolbar-btn:active {
    background: var(--color-nc-accent-dim);
    transform: translateY(0);
  }

  .icon-wrapper {
    display: flex;
    align-items: center;
    justify-content: center;
    transition: transform 0.25s ease;
  }

  .icon-wrapper.rotated {
    transform: rotate(90deg);
  }

  .btn-exit:hover {
    color: var(--color-nc-danger);
    background: rgba(239, 68, 68, 0.1);
  }

  .sep {
    width: 1px;
    height: 18px;
    background: var(--color-nc-border);
    margin: 0 4px;
  }

  .spacer {
    flex: 1;
  }

  .root-indicator {
    font-size: 10px;
    font-weight: bold;
    color: #fff;
    background: #dc2626;
    padding: 2px 6px;
    border-radius: 3px;
    margin-right: 4px;
    height: fit-content;
    align-self: center;
  }
</style>
