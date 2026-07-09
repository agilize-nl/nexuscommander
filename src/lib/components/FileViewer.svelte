<script lang="ts">
  import { readFileForViewer, type ViewerContent } from "$lib/ipc";
  import { formatSize } from "$lib/utils";
  import { _ } from "$lib/i18n";

  interface Props {
    path: string;
    onclose?: () => void;
    embedded?: boolean;
  }
  let { path, onclose, embedded = false }: Props = $props();

  let content: ViewerContent | null = $state(null);
  let loading = $state(true);
  let error: string | null = $state(null);
  let lineNumbers = $state(true);
  let wordWrap = $state(false);

  const ZOOM_MIN = 0.1;
  const ZOOM_MAX = 8;
  const ZOOM_STEP = 0.25;
  const WHEEL_ZOOM_FACTOR = 1.15;

  let zoom = $state(1);
  let panX = $state(0);
  let panY = $state(0);
  let rotation = $state(0);
  let isPanning = $state(false);
  let imageViewerEl: HTMLDivElement | undefined = $state(undefined);
  let dragStartX = 0;
  let dragStartY = 0;
  let panStartX = 0;
  let panStartY = 0;

  let zoomPercent = $derived(Math.round(zoom * 100));

  $effect(() => {
    loadFile(path);
  });

  async function loadFile(filePath: string) {
    loading = true;
    error = null;
    zoom = 1;
    panX = 0;
    panY = 0;
    rotation = 0;
    try {
      content = await readFileForViewer(filePath);
    } catch (e: any) {
      error = typeof e === "string" ? e : e.message || "Failed to load file";
    } finally {
      loading = false;
    }
  }

  function clampZoom(z: number): number {
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  }

  function clampPan(x: number, y: number, z: number): { x: number; y: number } {
    if (!imageViewerEl) return { x, y };
    const rect = imageViewerEl.getBoundingClientRect();
    const maxX = Math.max((rect.width * (z - 1)) / 2, 0);
    const maxY = Math.max((rect.height * (z - 1)) / 2, 0);
    return {
      x: Math.max(-maxX, Math.min(maxX, x)),
      y: Math.max(-maxY, Math.min(maxY, y)),
    };
  }

  function applyZoom(nextZoomRaw: number, focalX = 0, focalY = 0) {
    const nextZoom = clampZoom(nextZoomRaw);
    if (nextZoom === zoom) return;
    const scaleRatio = nextZoom / zoom;
    const nextPanX = focalX - (focalX - panX) * scaleRatio;
    const nextPanY = focalY - (focalY - panY) * scaleRatio;
    zoom = nextZoom;
    const clamped = clampPan(nextPanX, nextPanY, nextZoom);
    panX = clamped.x;
    panY = clamped.y;
  }

  function zoomIn() {
    applyZoom(zoom + ZOOM_STEP);
  }

  function zoomOut() {
    applyZoom(zoom - ZOOM_STEP);
  }

  function zoomReset() {
    zoom = 1;
    panX = 0;
    panY = 0;
  }

  function rotateImage() {
    rotation = (rotation + 90) % 360;
  }

  function focalPointFromEvent(e: MouseEvent | WheelEvent): { x: number; y: number } {
    if (!imageViewerEl) return { x: 0, y: 0 };
    const rect = imageViewerEl.getBoundingClientRect();
    return { x: e.clientX - rect.left - rect.width / 2, y: e.clientY - rect.top - rect.height / 2 };
  }

  function handleWheel(e: WheelEvent) {
    e.preventDefault();
    const focal = focalPointFromEvent(e);
    const factor = e.deltaY < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR;
    applyZoom(zoom * factor, focal.x, focal.y);
  }

  function handleImageDoubleClick(e: MouseEvent) {
    if (zoom > 1.01) {
      zoomReset();
      return;
    }
    const focal = focalPointFromEvent(e);
    applyZoom(2, focal.x, focal.y);
  }

  function handlePointerDown(e: PointerEvent) {
    if (zoom <= 1) return;
    isPanning = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    panStartX = panX;
    panStartY = panY;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: PointerEvent) {
    if (!isPanning) return;
    const clamped = clampPan(panStartX + (e.clientX - dragStartX), panStartY + (e.clientY - dragStartY), zoom);
    panX = clamped.x;
    panY = clamped.y;
  }

  function handlePointerUp() {
    isPanning = false;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (embedded) return;
    if (e.key === "Escape" || e.key === "F3" || e.key === "q") {
      e.preventDefault();
      e.stopPropagation();
      onclose?.();
      return;
    }
    e.stopPropagation();
  }

  let textLines = $derived(
    (() => {
      const c = content as ViewerContent | null;
      return c?.text?.split("\n") ?? [];
    })()
  );
</script>
{#if !embedded}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="viewer-overlay" onclick={() => onclose?.()} onkeydown={handleKeydown} role="presentation">
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="viewer-container" onclick={(e) => e.stopPropagation()}>
      <div class="viewer-header">
        <div class="viewer-title">
          <span class="viewer-icon">👁</span>
          <span class="viewer-filename">{content?.file_name ?? "Loading..."}</span>
          {#if content}
            <span class="viewer-meta">
              [{content.mode}] {formatSize(content.file_size)}
            </span>
          {/if}
        </div>
        <div class="viewer-actions">
          {#if content?.mode === "Text"}
            <button
              class="viewer-btn"
              class:active={lineNumbers}
              onclick={() => (lineNumbers = !lineNumbers)}
              title="Toggle line numbers"
            >#</button>
            <button
              class="viewer-btn"
              class:active={wordWrap}
              onclick={() => (wordWrap = !wordWrap)}
              title="Toggle word wrap"
            >↩</button>
          {/if}
          <button class="viewer-close" onclick={() => onclose?.()} title="Close (Esc)">✕</button>
        </div>
      </div>

      <div class="viewer-body">
        {@render ViewerContent({ loading, error, content, textLines, lineNumbers, wordWrap })}
      </div>

      <div class="viewer-footer">
        <span>Press <kbd>Esc</kbd> or <kbd>Q</kbd> to close</span>
        {#if content?.mode === "Text"}
          <span>{textLines.length} lines</span>
        {:else if content?.mode === "Hex"}
          <span>{content?.hex_lines?.length ?? 0} rows</span>
        {/if}
      </div>
    </div>
  </div>
{:else}
  <div class="viewer-container embedded">
    <div class="viewer-body">
      {@render ViewerContent({ loading, error, content, textLines, lineNumbers, wordWrap })}
    </div>
  </div>
{/if}

{#snippet ViewerContent({ loading, error, content, textLines, lineNumbers, wordWrap }: { loading: boolean, error: string | null, content: any, textLines: string[], lineNumbers: boolean, wordWrap: boolean })}
  {#if loading}
    <div class="viewer-loading">
      <span class="spinner"></span>
      Loading file...
    </div>
  {:else if error}
    <div class="viewer-error">{error}</div>
  {:else if content?.mode === "Text"}
    <div class="text-viewer" class:wrap={wordWrap}>
      {#each textLines as line, i}
        <div class="text-line">
          {#if lineNumbers}
            <span class="line-num">{i + 1}</span>
          {/if}
          <span class="line-content">{line || " "}</span>
        </div>
      {/each}
    </div>
  {:else if content?.mode === "Hex"}
    <div class="hex-viewer">
      {#each content.hex_lines ?? [] as line}
        <div class="hex-line">{line}</div>
      {/each}
    </div>
  {:else if content?.mode === "Image"}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="image-viewer"
      class:zoomed={zoom > 1}
      class:panning={isPanning}
      bind:this={imageViewerEl}
      onwheel={handleWheel}
      onpointerdown={handlePointerDown}
      onpointermove={handlePointerMove}
      onpointerup={handlePointerUp}
      onpointercancel={handlePointerUp}
      ondblclick={handleImageDoubleClick}
    >
      <img
        src="data:{content.mime_type};base64,{content.image_data}"
        alt={content.file_name}
        class="viewer-image"
        style="transform: translate({panX}px, {panY}px) scale({zoom}) rotate({rotation}deg);"
        draggable="false"
      />
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="image-zoom-toolbar"
        onpointerdown={(e) => e.stopPropagation()}
        ondblclick={(e) => e.stopPropagation()}
      >
        <button class="zoom-btn" onclick={zoomOut} title={$_('image_viewer.zoom_out')}>&minus;</button>
        <button class="zoom-btn zoom-value" onclick={zoomReset} title={$_('image_viewer.zoom_reset')}>{zoomPercent}%</button>
        <button class="zoom-btn" onclick={zoomIn} title={$_('image_viewer.zoom_in')}>+</button>
        <button class="zoom-btn" onclick={rotateImage} title={$_('image_viewer.rotate')}>⟳</button>
      </div>
    </div>
  {:else}
    <div class="viewer-unsupported">
      <span class="unsupported-icon">⚠</span>
      <p>{content?.text ?? "Unsupported file type"}</p>
    </div>
  {/if}
{/snippet}

<style>
  .viewer-overlay {
    position: fixed;
    inset: 0;
    background: transparent;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2000;
    animation: viewerFadeIn 0.2s ease;
    padding: 20px;
  }

  @keyframes viewerFadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .viewer-container {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    max-width: 1400px;
    max-height: 95vh;
    background: var(--color-nc-bg);
    border: 1px solid var(--color-nc-border-bright);
    border-radius: 8px;
    box-shadow: 0 30px 80px rgba(0, 0, 0, 0.6);
    overflow: hidden;
  }

  .viewer-container.embedded {
    border: none;
    max-height: none;
    border-radius: 0;
    box-shadow: none;
  }

  .viewer-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    background: linear-gradient(
      180deg,
      var(--color-nc-bg-header) 0%,
      var(--color-nc-bg-panel) 100%
    );
    border-bottom: 1px solid var(--color-nc-border);
    gap: 12px;
  }

  .viewer-title {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .viewer-icon { font-size: 16px; }

  .viewer-filename {
    font-family: var(--font-main-name);
    font-size: var(--font-main-size);
    font-weight: 600;
    color: var(--color-nc-text-bright);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .viewer-meta {
    font-size: 11px;
    color: var(--color-nc-text-dim);
    white-space: nowrap;
  }

  .viewer-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }

  .viewer-btn {
    width: 28px;
    height: 24px;
    background: transparent;
    border: 1px solid var(--color-nc-border);
    color: var(--color-nc-text-dim);
    font-size: 13px;
    cursor: pointer;
    border-radius: 3px;
    transition: all 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .viewer-btn:hover {
    background: var(--color-nc-bg-hover);
    color: var(--color-nc-accent);
  }

  .viewer-btn.active {
    background: var(--color-nc-accent-dim);
    border-color: var(--color-nc-accent);
    color: var(--color-nc-text-bright);
  }

  .viewer-close {
    width: 28px;
    height: 24px;
    background: transparent;
    border: 1px solid var(--color-nc-border);
    color: var(--color-nc-text-dim);
    font-size: 13px;
    cursor: pointer;
    border-radius: 3px;
    transition: all 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-left: 8px;
  }

  .viewer-close:hover {
    background: var(--color-nc-danger);
    border-color: var(--color-nc-danger);
    color: white;
  }

  .viewer-body {
    flex: 1;
    overflow: auto;
    background: var(--color-nc-bg-deep);
  }

  .viewer-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 16px;
    background: var(--color-nc-bg-panel);
    border-top: 1px solid var(--color-nc-border);
    font-size: 11px;
    color: var(--color-nc-text-dim);
  }

  .viewer-footer kbd {
    display: inline-block;
    padding: 1px 5px;
    background: var(--color-nc-bg);
    border: 1px solid var(--color-nc-border);
    border-radius: 3px;
    font-family: var(--font-family-mono);
    font-size: 10px;
    color: var(--color-nc-accent);
  }

  /* Text Viewer */
  .text-viewer {
    padding: 0;
    font-family: var(--font-viewer-name);
    font-size: var(--font-viewer-size);
    line-height: 1.5;
    counter-reset: line;
  }

  .text-viewer.wrap .line-content {
    white-space: pre-wrap;
    word-break: break-all;
  }

  .text-line {
    display: flex;
    min-height: 20px;
  }

  .text-line:hover {
    background: var(--color-nc-bg-hover);
  }

  .line-num {
    display: inline-block;
    min-width: 50px;
    padding: 0 12px 0 8px;
    text-align: right;
    color: var(--color-nc-text-dim);
    font-size: 11px;
    opacity: 0.5;
    user-select: none;
    flex-shrink: 0;
    border-right: 1px solid var(--color-nc-border);
    margin-right: 8px;
  }

  .line-content {
    white-space: pre;
    color: var(--color-nc-text);
    padding-right: 16px;
  }

  /* Hex Viewer */
  .hex-viewer {
    padding: 8px;
    font-family: var(--font-viewer-name);
    font-size: var(--font-viewer-size);
    line-height: 1.6;
  }

  .hex-line {
    white-space: pre;
    color: var(--color-nc-text);
  }

  .hex-line:hover {
    background: var(--color-nc-bg-hover);
  }

  /* Image Viewer */
  .image-viewer {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
    height: 100%;
    overflow: hidden;
    touch-action: none;
    background:
      repeating-conic-gradient(
        var(--color-nc-bg) 0% 25%,
        var(--color-nc-bg-panel) 0% 50%
      ) 50% / 20px 20px;
  }

  .image-viewer.zoomed {
    cursor: grab;
  }

  .image-viewer.zoomed.panning {
    cursor: grabbing;
  }

  .viewer-image {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    border-radius: 4px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
    user-select: none;
  }

  .image-zoom-toolbar {
    position: absolute;
    right: 16px;
    bottom: 16px;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px;
    background: var(--color-nc-bg-panel);
    border: 1px solid var(--color-nc-border);
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  }

  .zoom-btn {
    min-width: 26px;
    height: 26px;
    padding: 0 6px;
    background: transparent;
    border: none;
    color: var(--color-nc-text-dim);
    font-size: 14px;
    cursor: pointer;
    border-radius: 3px;
    transition: all 0.15s;
  }

  .zoom-btn:hover {
    background: var(--color-nc-bg-hover);
    color: var(--color-nc-accent);
  }

  .zoom-value {
    min-width: 46px;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }

  /* Loading / Error / Unsupported */
  .viewer-loading,
  .viewer-error,
  .viewer-unsupported {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 12px;
    color: var(--color-nc-text-dim);
    font-size: 14px;
  }

  .viewer-error { color: var(--color-nc-danger); }
  .unsupported-icon { font-size: 32px; }

  .spinner {
    display: inline-block;
    width: 20px;
    height: 20px;
    border: 2px solid var(--color-nc-border);
    border-top-color: var(--color-nc-accent);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
