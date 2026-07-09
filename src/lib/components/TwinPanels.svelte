<script lang="ts">
  import FileList from "./FileList.svelte";
  import TreeView from "./TreeView.svelte";
  import FileViewer from "./FileViewer.svelte";
  import { _ } from "$lib/i18n";
  import { leftPanelPath, rightPanelPath, activePanel, appConfigStore, persistSettings } from "$lib/stores";

  import type { OpenRequest } from "$lib/types";

  interface Props {
    onopenrequest?: (request: OpenRequest) => void;
    leftPanel?: any;
    rightPanel?: any;
  }
  let { onopenrequest, leftPanel = $bindable(), rightPanel = $bindable() }: Props = $props();

  let isVertical = $state(true); // default
  let singleView = $state(false);
  let leftFlex = $state(1);
  let rightFlex = $state(1);
  let dividerDragging = $state(false);
  let viewportWidth = $state(typeof window !== "undefined" ? window.innerWidth : 1024);
  let viewportHeight = $state(typeof window !== "undefined" ? window.innerHeight : 768);

  let leftMode = $state<"list" | "tree" | "quickview">("list");
  let rightMode = $state<"list" | "tree" | "quickview">("list");

  let lp = $state("/");
  let rp = $state("/");
  let selectedFilePath = $state<string | null>(null);

  let configLoaded = false;
  // Initialize from config
  $effect(() => {
    if ($appConfigStore && !configLoaded) {
      isVertical = $appConfigStore.layout_is_vertical;
      singleView = $appConfigStore.layout_single_view ?? false;
      const ratio = $appConfigStore.layout_panel_ratio || 0.5;
      leftFlex = ratio * 2;
      rightFlex = (1 - ratio) * 2;
      configLoaded = true;
    }
  });

  function updateLayoutPersistence() {
    if ($appConfigStore) {
      $appConfigStore.layout_is_vertical = isVertical;
      $appConfigStore.layout_single_view = singleView;
      $appConfigStore.layout_panel_ratio = leftFlex / (leftFlex + rightFlex);
      persistSettings();
    }
  }

  const unsubL = leftPanelPath.subscribe(v => lp = v);
  const unsubR = rightPanelPath.subscribe(v => rp = v);

  export function toggleLeftTree() {
    leftMode = leftMode === "tree" ? "list" : "tree";
  }

  export function toggleRightTree() {
    rightMode = rightMode === "tree" ? "list" : "tree";
  }

  export function toggleQuickView() {
    let ap = "left";
    const unsub = activePanel.subscribe(v => ap = v);
    unsub();

    if (ap === "left") {
      rightMode = rightMode === "quickview" ? "list" : "quickview";
    } else {
      leftMode = leftMode === "quickview" ? "list" : "quickview";
    }
  }

  function handleSelectionChange(path: string | null) {
    selectedFilePath = path;
  }

  export function toggleLayout() {
    isVertical = !isVertical;
    updateLayoutPersistence();
  }

  export function toggleSingleView() {
    singleView = !singleView;
    updateLayoutPersistence();
  }

  const activeSide = $derived($activePanel);
  // On narrow (mobile) viewports, dual view remains available (the user can still
  // toggle it), but the split direction follows device orientation instead of the
  // desktop `isVertical` preference: stacked ("onder elkaar") in portrait, side by
  // side ("naast elkaar") in landscape.
  const narrowViewport = $derived(viewportWidth <= 760);
  const isPortrait = $derived(viewportHeight > viewportWidth);
  const effectiveVertical = $derived(narrowViewport ? !isPortrait : isVertical);
  const showLeftPanel = $derived(!singleView || activeSide === "left");
  const showRightPanel = $derived(!singleView || activeSide === "right");

  let containerEl: HTMLDivElement | undefined = $state(undefined);

  // Panel resize via divider drag
  function startDrag(e: PointerEvent) {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dividerDragging = true;
    const startLeftFlex = leftFlex;
    const startRightFlex = rightFlex;
    const totalFlex = startLeftFlex + startRightFlex;

    function onMove(ev: PointerEvent) {
      if (!containerEl) return;
      const rect = containerEl.getBoundingClientRect();
      const ratio = effectiveVertical
        ? (ev.clientX - rect.left) / rect.width
        : (ev.clientY - rect.top) / rect.height;
      const clampedRatio = Math.max(0.2, Math.min(0.8, ratio));
      leftFlex = clampedRatio * totalFlex;
      rightFlex = (1 - clampedRatio) * totalFlex;
    }

    function onUp(ev: PointerEvent) {
      dividerDragging = false;
      updateLayoutPersistence();
      (e.currentTarget as HTMLElement).releasePointerCapture?.(ev.pointerId);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  /** Refresh both panels. */
  export function refreshAll() {
    leftPanel?.refresh?.();
    rightPanel?.refresh?.();
  }

  /** Go up one directory on the active panel. */
  export function goUp() {
    let ap = "left";
    const unsub = activePanel.subscribe(v => ap = v);
    unsub();
    (ap === "left" ? leftPanel : rightPanel)?.goUp?.();
  }

  /** Set view mode (brief/full) on the active panel. */
  export function setViewMode(mode: "brief" | "full") {
    let ap = "left";
    const unsub = activePanel.subscribe(v => ap = v);
    unsub();
    (ap === "left" ? leftPanel : rightPanel)?.setViewMode?.(mode);
    
    if ($appConfigStore) {
      if (ap === "left") {
        $appConfigStore.layout_left_view_mode = mode;
      } else {
        $appConfigStore.layout_right_view_mode = mode;
      }
      persistSettings();
    }
  }

  /** Toggle view mode (brief/full) on the active panel. */
  export function toggleViewMode() {
    let ap = "left";
    const unsub = activePanel.subscribe(v => ap = v);
    unsub();
    const panel = ap === "left" ? leftPanel : rightPanel;
    if (panel) {
      const currentMode = panel.getViewMode?.();
      const nextMode = currentMode === "brief" ? "full" : "brief";
      panel.setViewMode?.(nextMode);
      
      if ($appConfigStore) {
        if (ap === "left") {
          $appConfigStore.layout_left_view_mode = nextMode;
        } else {
          $appConfigStore.layout_right_view_mode = nextMode;
        }
        persistSettings();
      }
    }
  }

  /** Navigate active panel to home. */
  export function goHome(homePath: string) {
    navigateActive(homePath);
  }

  /** Navigate active panel to a concrete directory path. */
  export function navigateActive(path: string) {
    let ap = "left";
    const unsub = activePanel.subscribe(v => ap = v);
    unsub();
    if (ap === "left") {
      leftPanel?.navigateTo?.(path);
    } else {
      rightPanel?.navigateTo?.(path);
    }
  }

  export function navigateLeft(path: string) {
    leftPanel?.navigateTo?.(path);
  }

  export function navigateRight(path: string) {
    rightPanel?.navigateTo?.(path);
  }
</script>

<svelte:window bind:innerWidth={viewportWidth} bind:innerHeight={viewportHeight} />

<div class="twin-panels" class:horizontal-split={!effectiveVertical} class:single-view={singleView} bind:this={containerEl}>
  {#if showLeftPanel}
    <div class="panel-wrapper" style="flex: {singleView ? 1 : leftFlex};">
      {#if leftMode === "list"}
        <FileList side="left" bind:this={leftPanel} {onopenrequest} onselectionchange={handleSelectionChange} />
      {:else if leftMode === "tree"}
        <TreeView rootPath="/" onselect={(path) => navigateLeft(path)} />
      {:else}
        {#if selectedFilePath}
          <FileViewer path={selectedFilePath} embedded={true} />
        {:else}
          <div class="empty-quickview">{$_('panel.no_file_selected')}</div>
        {/if}
      {/if}
    </div>
  {/if}
  {#if !singleView}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="panel-divider"
      class:dragging={dividerDragging}
      onpointerdown={startDrag}
    ></div>
  {/if}
  {#if showRightPanel}
    <div class="panel-wrapper" style="flex: {singleView ? 1 : rightFlex};">
      {#if rightMode === "list"}
        <FileList side="right" bind:this={rightPanel} {onopenrequest} onselectionchange={handleSelectionChange} />
      {:else if rightMode === "tree"}
        <TreeView rootPath="/" onselect={(path) => navigateRight(path)} />
      {:else}
        {#if selectedFilePath}
          <FileViewer path={selectedFilePath} embedded={true} />
        {:else}
          <div class="empty-quickview">{$_('panel.no_file_selected')}</div>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .twin-panels {
    display: flex;
    flex-direction: row;
    flex: 1;
    width: 100%;
    min-width: 0;
    min-height: 0;
    gap: 0;
    padding: 2px;
    overflow: hidden;
  }

  .twin-panels.horizontal-split {
    flex-direction: column;
  }

  .twin-panels.single-view {
    padding: 2px;
  }

  .panel-wrapper {
    display: flex;
    min-width: 0;
    overflow: hidden;
  }

  .panel-divider {
    width: 4px;
    background: var(--color-nc-bg-deep);
    cursor: col-resize;
    transition: background 0.2s ease;
    flex-shrink: 0;
    position: relative;
    touch-action: none;
  }

  .horizontal-split .panel-divider {
    width: 100%;
    height: 4px;
    cursor: row-resize;
  }

  .panel-divider::after {
    content: "";
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 2px;
    height: 30px;
    background: var(--color-nc-border);
    border-radius: 1px;
    transition: all 0.2s ease;
    flex-shrink: 0;
  }

  .horizontal-split .panel-divider::after {
    width: 30px;
    height: 2px;
  }

  .panel-divider:hover,
  .panel-divider.dragging {
    background: var(--color-nc-accent-dim);
    height: 50px;
  }

  .empty-quickview {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    color: var(--color-nc-text-dim);
    font-size: 14px;
    background: var(--color-nc-bg-deep);
  }
</style>
