<script lang="ts">
  import TreeView from "@nexus/ui/components/TreeView.svelte";
  import FileViewer from "@nexus/ui/components/FileViewer.svelte";
  import { _ } from "../i18n";
  import { leftPanelPath, rightPanelPath, activePanel } from "../stores";
  import type { TwinPanelsLayout } from "../types";

  interface Props {
    /**
     * FileList hasn't moved to @nexus/ui yet (each app still has its own
     * FileList.svelte with app-specific callback props — desktop takes
     * `onviewfile`/`oneditfile`, web takes `onopenrequest`). Until that
     * component is shared too, the shell injects its own FileList here.
     */
    fileList: any;
    /** App-specific FileList callback props, spread onto every FileList instance. */
    fileListProps?: Record<string, any>;
    leftPanel?: any;
    rightPanel?: any;
    isVertical?: boolean;
    /** Layout state handed in by the shell to restore on first load (see onpersistlayout). */
    layout?: Partial<TwinPanelsLayout>;
    /**
     * Called whenever the component's persisted layout state changes (modes,
     * vertical/horizontal split, single view, panel ratio). The two apps' AppConfig
     * schemas use different key names for this state and updateSettings is app-local,
     * so this component never touches appConfigStore directly — the shell decides
     * what (if anything) to persist.
     */
    onpersistlayout?: (state: TwinPanelsLayout) => void;
    /** Called by setViewMode()/toggleViewMode() so the shell can persist per-side view mode. */
    onpersistviewmode?: (side: "left" | "right", mode: "brief" | "full") => void;
    /**
     * Enables viewport-driven responsive behavior (narrow/portrait breakpoints).
     * Desktop windows aren't orientation-driven, so this defaults to off; web passes true.
     */
    responsive?: boolean;
  }

  let {
    fileList,
    fileListProps = {},
    leftPanel = $bindable(),
    rightPanel = $bindable(),
    isVertical = $bindable(true),
    layout,
    onpersistlayout,
    onpersistviewmode,
    responsive = false,
  }: Props = $props();

  let leftMode = $state<"list" | "tree" | "quickview">("list");
  let rightMode = $state<"list" | "tree" | "quickview">("list");
  let quickviewSide = $state<"left" | "right" | null>(null);
  let singleView = $state(false);
  let leftFlex = $state(1);
  let rightFlex = $state(1);
  let dividerDragging = $state(false);
  let containerEl: HTMLDivElement | undefined = $state(undefined);

  // Restore-once from the shell-provided layout: `layout` is rebuilt by the shell
  // every time its own config store changes, so we gate on `restored` (a plain,
  // non-reactive flag) rather than re-applying every time — otherwise a persisted
  // round-trip (onpersistlayout -> app config -> layout prop) would keep clobbering
  // whatever the user just changed. `isVertical` is used as the "config has loaded"
  // sentinel since both shells always populate it once their settings are ready.
  let restored = false;
  $effect(() => {
    if (!restored && layout?.isVertical !== undefined) {
      if (layout.leftMode) leftMode = layout.leftMode;
      if (layout.rightMode) rightMode = layout.rightMode;
      quickviewSide = leftMode === "quickview" ? "left" : rightMode === "quickview" ? "right" : null;
      isVertical = layout.isVertical;
      if (layout.singleView !== undefined) singleView = layout.singleView;
      if (layout.panelRatio) {
        leftFlex = layout.panelRatio * 2;
        rightFlex = (1 - layout.panelRatio) * 2;
      }
      restored = true;
    }
  });

  function persistLayout() {
    onpersistlayout?.({
      leftMode,
      rightMode,
      isVertical,
      singleView,
      panelRatio: leftFlex / (leftFlex + rightFlex),
    });
  }

  $effect(() => {
    // Auto-persist on mode/orientation/single-view changes, once restored (mirrors
    // desktop's former persistSession()). Panel-ratio changes from divider drags are
    // persisted explicitly in onUp() below since they aren't tracked here.
    // Every tracked value is read unconditionally first: putting them in one `||`
    // chain short-circuits on `leftMode` (always a non-empty string), so Svelte
    // never registered `isVertical`/`singleView` as dependencies and toggling
    // single view never reached the shell's config — leaving the toolbar icon stale.
    void leftMode;
    void rightMode;
    void isVertical;
    void singleView;
    if (restored) {
      persistLayout();
    }
  });

  let lp = $state("/");
  let rp = $state("/");
  let selectedFilePath = $state<string | null>(null);

  const unsubL = leftPanelPath.subscribe(v => lp = v);
  const unsubR = rightPanelPath.subscribe(v => rp = v);

  export function toggleActiveTree() {
    let side = "left";
    const unsubscribe = activePanel.subscribe(value => side = value);
    unsubscribe();
    if (side === "left") toggleLeftTree();
    else toggleRightTree();
  }

  export function equalizePanels() {
    leftFlex = 1;
    rightFlex = 1;
    persistLayout();
  }

  export function toggleLeftTree() {
    leftMode = leftMode === "tree" ? "list" : "tree";
    if (quickviewSide === "left") quickviewSide = null;
  }

  export function toggleRightTree() {
    rightMode = rightMode === "tree" ? "list" : "tree";
    if (quickviewSide === "right") quickviewSide = null;
  }

  export function toggleQuickView() {
    // Turning off always targets the side we actually put into quickview,
    // regardless of which panel is "active" right now (activePanel can
    // drift away from that side via Tab/focus in the meantime).
    if (quickviewSide === "left") {
      leftMode = "list";
      quickviewSide = null;
      return;
    }
    if (quickviewSide === "right") {
      rightMode = "list";
      quickviewSide = null;
      return;
    }

    let ap = "left";
    const unsub = activePanel.subscribe(v => ap = v);
    unsub();

    if (ap === "left") {
      rightMode = "quickview";
      quickviewSide = "right";
    } else {
      leftMode = "quickview";
      quickviewSide = "left";
    }
  }

  function handleSelectionChange(path: string | null) {
    selectedFilePath = path;
  }

  export function toggleLayout() {
    isVertical = !isVertical;
  }

  export function toggleSingleView() {
    singleView = !singleView;
  }

  /** Refresh both panels. */
  export async function refreshAll() {
    await Promise.all([
      leftPanel?.refresh?.(),
      rightPanel?.refresh?.(),
    ]);
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
    onpersistviewmode?.(ap as "left" | "right", mode);
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
      onpersistviewmode?.(ap as "left" | "right", nextMode);
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
      navigateLeft(path);
    } else {
      navigateRight(path);
    }
  }

  // FileList is still app-local (see the `fileList` prop above), and desktop's copy
  // doesn't implement `navigateTo()` yet — only web's does. Fall back to setting the
  // path store directly (desktop's pre-merge behavior) when the method isn't there,
  // so both shells stay correct until FileList itself moves to packages/ui.
  export function navigateLeft(path: string) {
    if (leftPanel?.navigateTo) {
      leftPanel.navigateTo(path);
    } else {
      leftPanelPath.set(path);
    }
  }

  export function navigateRight(path: string) {
    if (rightPanel?.navigateTo) {
      rightPanel.navigateTo(path);
    } else {
      rightPanelPath.set(path);
    }
  }

  const dividerPercent = $derived(Math.round((leftFlex / (leftFlex + rightFlex)) * 100));

  const activeSide = $derived($activePanel);
  const showLeftPanel = $derived(!singleView || activeSide === "left");
  const showRightPanel = $derived(!singleView || activeSide === "right");

  // Responsive/portrait handling is web-only by design: gated behind `responsive` so
  // desktop (whose windows aren't orientation-driven) never observes viewport size.
  let viewportWidth = $state(typeof window !== "undefined" ? window.innerWidth : 1024);
  let viewportHeight = $state(typeof window !== "undefined" ? window.innerHeight : 768);
  // On narrow (mobile) viewports, dual view remains available (the user can still
  // toggle it), but the split direction follows device orientation instead of the
  // desktop `isVertical` preference: stacked ("onder elkaar") in portrait, side by
  // side ("naast elkaar") in landscape.
  const narrowViewport = $derived(responsive && viewportWidth <= 760);
  const isPortrait = $derived(viewportHeight > viewportWidth);
  const effectiveVertical = $derived(responsive ? (narrowViewport ? !isPortrait : isVertical) : isVertical);

  // Panel resize via divider drag (pointer events + capture + clamp 0.2-0.8).
  function startDrag(e: PointerEvent) {
    e.preventDefault();
    // Captured up front: `e.currentTarget` is only valid while the browser is
    // dispatching this pointerdown event, and becomes null immediately after -
    // referencing it later (from onUp/onLost) would throw.
    const dividerEl = e.currentTarget as HTMLElement;
    const pointerId = e.pointerId;
    dividerEl.setPointerCapture?.(pointerId);
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

    function onUp() {
      dividerDragging = false;
      persistLayout();
      dividerEl.releasePointerCapture?.(pointerId);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      dividerEl.removeEventListener("lostpointercapture", onUp);
    }

    // Some WebView backends (WebKitGTK, WebView2) can drop pointer capture
    // without ever delivering "pointerup" to window - e.g. the button is
    // released outside the OS window, or focus switches mid-drag. Without
    // this the drag state never clears and the divider stays glued to the
    // cursor until the app restarts.
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    dividerEl.addEventListener("lostpointercapture", onUp);
  }
</script>

<!-- `<svelte:window>` cannot live inside a block, so the size is always tracked;
     only `responsive` shells actually read it (see `effectiveVertical`). -->
<svelte:window bind:innerWidth={viewportWidth} bind:innerHeight={viewportHeight} />

<div class="twin-panels" class:horizontal-split={!effectiveVertical} class:single-view={singleView} bind:this={containerEl}>
  {#if showLeftPanel}
    <div class="panel-wrapper" style="flex: {singleView ? 1 : leftFlex};">
      {#if leftMode === "list"}
        {@const FileListComponent = fileList}
        <FileListComponent side="left" bind:this={leftPanel} {...fileListProps} onselectionchange={handleSelectionChange} />
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
      ondblclick={equalizePanels}
    >
      {#if dividerDragging}
        <div class="panel-divider-percent">{dividerPercent}%</div>
      {/if}
    </div>
  {/if}

  {#if showRightPanel}
    <div class="panel-wrapper" style="flex: {singleView ? 1 : rightFlex};">
      {#if rightMode === "list"}
        {@const FileListComponent = fileList}
        <FileListComponent side="right" bind:this={rightPanel} {...fileListProps} onselectionchange={handleSelectionChange} />
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
  }

  .panel-divider:hover::after,
  .panel-divider.dragging::after {
    height: 50px;
  }

  .horizontal-split .panel-divider:hover::after,
  .horizontal-split .panel-divider.dragging::after {
    width: 50px;
    height: 2px;
  }

  .panel-divider-percent {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    white-space: nowrap;
    padding: 2px 6px;
    border-radius: 3px;
    background: var(--color-nc-bg-deep);
    color: var(--color-nc-text);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    pointer-events: none;
    z-index: 1;
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
