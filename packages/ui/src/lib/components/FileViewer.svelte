<script lang="ts">
  import { readFileForViewer, convertFileSrc, hasCapability, type ViewerContent } from "../ipc";
  import { formatSize } from "../utils";
  import { _ } from "../i18n";

  interface Props {
    path: string;
    siblingPaths?: string[];
    onclose?: () => void;
    embedded?: boolean;
  }
  let { path, siblingPaths = [], onclose, embedded = false }: Props = $props();

  const ENCODING_LIST = [
    "Auto-detect",
    "UTF-8",
    "UTF-8BOM",
    "ANSI",
    "OEM",
    "CP1250",
    "CP1251",
    "CP1252",
    "CP1253",
    "CP1254",
    "CP1255",
    "CP1256",
    "CP1257",
    "CP1258",
    "CP437",
    "CP850",
    "CP852",
    "CP866",
    "CP874",
    "CP932",
    "CP936",
    "CP949",
    "CP950",
    "ISO-8859-1",
    "ISO-8859-2",
    "KOI8-R",
    "KOI8-U",
    "KOI8-RU",
    "UCS-2LE",
    "UCS-2BE",
    "UTF-16LE",
    "UTF-16BE",
    "UTF-32LE",
    "UTF-32BE",
  ];

  let currentPathState = $state("");
  let content: ViewerContent | null = $state(null);
  let loading = $state(true);
  let error: string | null = $state(null);
  let lineNumbers = $state(true);
  let wordWrap = $state(false);
  let currentEncoding = $state("Auto-detect");
  let activeMode: "Text" | "Hex" | "Image" | "Unsupported" = $state("Text");
  let activeModeInitialized = $state(false);
  let activeMenu: "file" | "edit" | "view" | "encoding" | "about" | null = $state(null);

  // Image manipulation state
  const ZOOM_MIN = 0.1;
  const ZOOM_MAX = 8;
  const ZOOM_STEP = 0.25;
  const WHEEL_ZOOM_FACTOR = 1.15;

  let imageZoom = $state(1);
  let imagePanX = $state(0);
  let imagePanY = $state(0);
  let imageRotation = $state(0);
  let imageViewerEl: HTMLDivElement | undefined = $state(undefined);
  let isPanning = $state(false);
  let dragStartX = 0;
  let dragStartY = 0;
  let panStartX = 0;
  let panStartY = 0;

  let zoomPercent = $derived(Math.round(imageZoom * 100));

  let siblingIndex = $derived(siblingPaths.indexOf(currentPathState));
  let canGoPrev = $derived(siblingIndex > 0);
  let canGoNext = $derived(siblingIndex >= 0 && siblingIndex < siblingPaths.length - 1);

  let imageSrc = $derived(hasCapability("convertFileSrc") ? convertFileSrc(currentPathState) : "");

  $effect(() => {
    if (path !== currentPathState) {
      currentPathState = path;
      activeModeInitialized = false;
      currentEncoding = "Auto-detect";
      loadFile(path, "Auto-detect");
    }
  });

  async function loadFile(filePath: string, encoding = currentEncoding) {
    loading = true;
    error = null;
    imageZoom = 1;
    imagePanX = 0;
    imagePanY = 0;
    imageRotation = 0;
    try {
      content = await readFileForViewer(filePath, encoding);
      if (!activeModeInitialized) {
        activeMode = content.mode;
        activeModeInitialized = true;
      }
      if (content.encoding) {
        currentEncoding = content.encoding;
      }
    } catch (e: any) {
      error = typeof e === "string" ? e : e.message || $_("viewer.load_failed");
    } finally {
      loading = false;
    }
  }

  function gotoSibling(delta: number) {
    const newIdx = siblingIndex + delta;
    if (newIdx >= 0 && newIdx < siblingPaths.length) {
      currentPathState = siblingPaths[newIdx];
      activeModeInitialized = false;
      loadFile(currentPathState, currentEncoding);
    }
  }

  function toggleMenu(menu: "file" | "edit" | "view" | "encoding" | "about") {
    activeMenu = activeMenu === menu ? null : menu;
  }

  function closeMenu() {
    activeMenu = null;
  }

  function isSelectedEncoding(enc: string): boolean {
    const active = (content?.encoding || currentEncoding).toUpperCase().replace(/[-_]/g, "");
    const test = enc.toUpperCase().replace(/[-_]/g, "");
    if (test === active) return true;
    if (enc === "Auto-detect" && currentEncoding === "Auto-detect") return true;
    if (enc === "ANSI" && (active === "CP1252" || active === "WIN1252")) return true;
    if (enc === "OEM" && active === "CP437") return true;
    return false;
  }

  async function selectEncoding(enc: string) {
    closeMenu();
    currentEncoding = enc;
    activeMode = "Text";
    await loadFile(currentPathState, enc);
  }

  function clampZoom(zoom: number): number {
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
  }

  function clampPan(x: number, y: number, zoom: number): { x: number; y: number } {
    if (!imageViewerEl) return { x, y };
    const rect = imageViewerEl.getBoundingClientRect();
    const maxX = Math.max((rect.width * (zoom - 1)) / 2, 0);
    const maxY = Math.max((rect.height * (zoom - 1)) / 2, 0);
    return {
      x: Math.max(-maxX, Math.min(maxX, x)),
      y: Math.max(-maxY, Math.min(maxY, y)),
    };
  }

  function applyZoom(nextZoomRaw: number, focalX = 0, focalY = 0) {
    const nextZoom = clampZoom(nextZoomRaw);
    if (nextZoom === imageZoom) return;
    const scaleRatio = nextZoom / imageZoom;
    const nextPanX = focalX - (focalX - imagePanX) * scaleRatio;
    const nextPanY = focalY - (focalY - imagePanY) * scaleRatio;
    imageZoom = nextZoom;
    const clamped = clampPan(nextPanX, nextPanY, nextZoom);
    imagePanX = clamped.x;
    imagePanY = clamped.y;
  }

  function zoomIn() {
    applyZoom(imageZoom + ZOOM_STEP);
  }

  function zoomOut() {
    applyZoom(imageZoom - ZOOM_STEP);
  }

  function zoomReset() {
    imageZoom = 1;
    imagePanX = 0;
    imagePanY = 0;
  }

  function rotateImage() {
    imageRotation = (imageRotation + 90) % 360;
  }

  function getFocalPointFromEvent(e: MouseEvent | WheelEvent) {
    if (!imageViewerEl) return { x: 0, y: 0 };
    const rect = imageViewerEl.getBoundingClientRect();
    return {
      x: e.clientX - rect.left - rect.width / 2,
      y: e.clientY - rect.top - rect.height / 2,
    };
  }

  function handleWheel(e: WheelEvent) {
    e.preventDefault();
    const focal = getFocalPointFromEvent(e);
    const factor = e.deltaY < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR;
    applyZoom(imageZoom * factor, focal.x, focal.y);
  }

  function handleImageDoubleClick(e: MouseEvent) {
    if (imageZoom > 1.01) {
      zoomReset();
      return;
    }
    const focal = getFocalPointFromEvent(e);
    applyZoom(2, focal.x, focal.y);
  }

  function handlePointerDown(e: PointerEvent) {
    if (imageZoom <= 1) return;
    isPanning = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    panStartX = imagePanX;
    panStartY = imagePanY;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }

  function handlePointerMove(e: PointerEvent) {
    if (!isPanning) return;
    const clamped = clampPan(
      panStartX + (e.clientX - dragStartX),
      panStartY + (e.clientY - dragStartY),
      imageZoom,
    );
    imagePanX = clamped.x;
    imagePanY = clamped.y;
  }

  function handlePointerUp() {
    isPanning = false;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (embedded) return;
    if (activeMenu !== null && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
      return;
    }
    if (e.key === "Escape" || e.key === "F3" || e.key === "q" || e.key === "F10") {
      e.preventDefault();
      e.stopPropagation();
      onclose?.();
      return;
    }
    if (e.key === "1") {
      activeMode = "Text";
      return;
    }
    if (e.key === "2") {
      activeMode = "Hex";
      return;
    }
    if (e.key === "3" && (content?.mode === "Image" || content?.mime_type?.startsWith("image/"))) {
      activeMode = "Image";
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "PageUp") {
      if (canGoPrev) {
        e.preventDefault();
        e.stopPropagation();
        gotoSibling(-1);
      }
    } else if (e.key === "ArrowRight" || e.key === "PageDown") {
      if (canGoNext) {
        e.preventDefault();
        e.stopPropagation();
        gotoSibling(1);
      }
    } else if (activeMode === "Image") {
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        zoomIn();
      } else if (e.key === "-") {
        e.preventDefault();
        zoomOut();
      } else if (e.key === "0") {
        e.preventDefault();
        zoomReset();
      } else if (e.key.toLowerCase() === "r") {
        e.preventDefault();
        rotateImage();
      } else {
        e.stopPropagation();
      }
    } else {
      e.stopPropagation();
    }
  }

  let textLines = $derived(
    (() => {
      const c = content as ViewerContent | null;
      return c?.text?.split("\n") ?? [];
    })()
  );

  function parseLineTokens(line: string): { isCtrl: boolean; text: string }[] {
    if (!line) return [];
    const tokens: { isCtrl: boolean; text: string }[] = [];
    let current = "";
    for (let i = 0; i < line.length; i++) {
      const code = line.charCodeAt(i);
      // Control characters 0x00..0x1F except tab (9) and newline/carriage return
      if (code < 32 && code !== 9 && code !== 13) {
        if (current) {
          tokens.push({ isCtrl: false, text: current });
          current = "";
        }
        tokens.push({ isCtrl: true, text: code.toString(16).toUpperCase().padStart(2, "0") });
      } else {
        current += line[i];
      }
    }
    if (current) {
      tokens.push({ isCtrl: false, text: current });
    }
    return tokens;
  }
</script>

{#if !embedded}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="viewer-overlay" onclick={() => onclose?.()} onkeydown={handleKeydown} role="presentation">
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="viewer-container" onclick={(e) => { e.stopPropagation(); closeMenu(); }}>
      <!-- Menu Bar: File  Edit  View  Encoding  About -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="viewer-menubar" onclick={(e) => e.stopPropagation()}>
        <div class="menu-item-wrapper">
          <button class="menubar-btn" class:active={activeMenu === 'file'} onclick={() => toggleMenu('file')}>{$_("viewer.menu_file")}</button>
          {#if activeMenu === 'file'}
            <div class="menu-dropdown">
              <button class="menu-dropdown-item" onclick={() => { gotoSibling(-1); closeMenu(); }} disabled={!canGoPrev}>
                <span>{$_("viewer.prev_file")}</span><kbd>{$_("keys.pgup")}</kbd>
              </button>
              <button class="menu-dropdown-item" onclick={() => { gotoSibling(1); closeMenu(); }} disabled={!canGoNext}>
                <span>{$_("viewer.next_file")}</span><kbd>{$_("keys.pgdn")}</kbd>
              </button>
              <div class="menu-divider"></div>
              <button class="menu-dropdown-item" onclick={() => { loadFile(currentPathState); closeMenu(); }}>
                <span>{$_("viewer.reload")}</span><kbd>F5</kbd>
              </button>
              <button class="menu-dropdown-item" onclick={() => { onclose?.(); closeMenu(); }}>
                <span>{$_("common.close")}</span><kbd>{$_("keys.esc")}</kbd>
              </button>
            </div>
          {/if}
        </div>

        <div class="menu-item-wrapper">
          <button class="menubar-btn" class:active={activeMenu === 'view'} onclick={() => toggleMenu('view')}>{$_("viewer.menu_view")}</button>
          {#if activeMenu === 'view'}
            <div class="menu-dropdown">
              <button class="menu-dropdown-item" onclick={() => { activeMode = 'Text'; closeMenu(); }}>
                <span><span class="bullet-indicator">{activeMode === 'Text' ? '•' : ''}</span>{$_("viewer.mode_text")}</span><kbd>1</kbd>
              </button>
              <button class="menu-dropdown-item" onclick={() => { activeMode = 'Hex'; closeMenu(); }}>
                <span><span class="bullet-indicator">{activeMode === 'Hex' ? '•' : ''}</span>{$_("viewer.mode_hex")}</span><kbd>2</kbd>
              </button>
              {#if content?.mime_type?.startsWith('image/') || hasCapability('convertFileSrc')}
                <button class="menu-dropdown-item" onclick={() => { activeMode = 'Image'; closeMenu(); }}>
                  <span><span class="bullet-indicator">{activeMode === 'Image' ? '•' : ''}</span>{$_("viewer.mode_image")}</span><kbd>3</kbd>
                </button>
              {/if}
              <div class="menu-divider"></div>
              <button class="menu-dropdown-item" onclick={() => { lineNumbers = !lineNumbers; closeMenu(); }}>
                <span><span class="bullet-indicator">{lineNumbers ? '•' : ''}</span>{$_("viewer.line_numbers")}</span><kbd>#</kbd>
              </button>
              <button class="menu-dropdown-item" onclick={() => { wordWrap = !wordWrap; closeMenu(); }}>
                <span><span class="bullet-indicator">{wordWrap ? '•' : ''}</span>{$_("viewer.word_wrap")}</span><kbd>↩</kbd>
              </button>
            </div>
          {/if}
        </div>

        <div class="menu-item-wrapper">
          <button class="menubar-btn" class:active={activeMenu === 'encoding'} onclick={() => toggleMenu('encoding')}>
            {$_("viewer.menu_encoding")}
          </button>
          {#if activeMenu === 'encoding'}
            <div class="menu-dropdown encoding-dropdown">
              {#each ENCODING_LIST as enc}
                <button
                  class="menu-dropdown-item encoding-item"
                  class:selected={isSelectedEncoding(enc)}
                  onclick={() => selectEncoding(enc)}
                >
                  <span class="bullet-indicator">{isSelectedEncoding(enc) ? '•' : ''}</span>
                  <span class="encoding-name">{enc}</span>
                </button>
              {/each}
            </div>
          {/if}
        </div>

        <div class="menu-item-wrapper">
          <button class="menubar-btn" class:active={activeMenu === 'about'} onclick={() => toggleMenu('about')}>{$_("viewer.menu_about")}</button>
          {#if activeMenu === 'about'}
            <div class="menu-dropdown">
              <div class="menu-dropdown-item static-item">
                <span>{$_("viewer.about_text")}</span>
              </div>
            </div>
          {/if}
        </div>
      </div>

      <!-- Viewer Header / Quick Toolbar -->
      <div class="viewer-header">
        <div class="viewer-title">
          <span class="viewer-icon">👁</span>
          <span class="viewer-filename">{content?.file_name ?? $_("common.loading")}</span>
          {#if content}
            <span class="viewer-meta">
              {formatSize(content.file_size)}
            </span>
          {/if}
        </div>

        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="viewer-actions" onclick={(e) => e.stopPropagation()}>
          <!-- Mode switcher tabs -->
          <div class="mode-switch-group">
            <button
              class="mode-btn"
              class:active={activeMode === "Text"}
              onclick={() => activeMode = "Text"}
              title={$_("viewer.view_as_text")}
            >{$_("viewer.mode_text")}</button>
            <button
              class="mode-btn"
              class:active={activeMode === "Hex"}
              onclick={() => activeMode = "Hex"}
              title={$_("viewer.view_as_hex")}
            >{$_("viewer.mode_hex")}</button>
            {#if content?.mime_type?.startsWith("image/") || hasCapability("convertFileSrc")}
              <button
                class="mode-btn"
                class:active={activeMode === "Image"}
                onclick={() => activeMode = "Image"}
                title={$_("viewer.view_as_image")}
              >{$_("viewer.mode_image")}</button>
            {/if}
          </div>

          <!-- Quick Encoding button -->
          <div class="quick-encoding-container">
            <button
              class="viewer-encoding-btn"
              class:active={activeMenu === 'encoding'}
              onclick={() => toggleMenu('encoding')}
              title={$_("viewer.change_encoding")}
            >
              <span class="enc-label">{content?.encoding || currentEncoding}</span>
              <span class="enc-arrow">▾</span>
            </button>
          </div>

          {#if siblingPaths.length > 1}
            <div class="viewer-navigation">
              <button class="viewer-btn" onclick={() => gotoSibling(-1)} disabled={!canGoPrev} title={$_("viewer.prev_file_hint")}>◀</button>
              <span class="viewer-nav-status">{siblingIndex + 1}/{siblingPaths.length}</span>
              <button class="viewer-btn" onclick={() => gotoSibling(1)} disabled={!canGoNext} title={$_("viewer.next_file_hint")}>▶</button>
            </div>
          {/if}

          {#if activeMode === "Text"}
            <button
              class="viewer-btn"
              class:active={lineNumbers}
              onclick={() => (lineNumbers = !lineNumbers)}
              title={$_("viewer.toggle_line_numbers")}
            >#</button>
            <button
              class="viewer-btn"
              class:active={wordWrap}
              onclick={() => (wordWrap = !wordWrap)}
              title={$_("viewer.toggle_word_wrap")}
            >↩</button>
          {/if}

          <button class="viewer-close" onclick={() => onclose?.()} title={$_("viewer.close_hint")}>✕</button>
        </div>
      </div>

      <div class="viewer-body">
        {@render ViewerContentSnippet({ loading, error, content, textLines, lineNumbers, wordWrap, activeMode })}
      </div>

      <div class="viewer-footer">
        <div class="footer-left">
          {#if siblingPaths.length > 1}
            <span class="footer-pos">{siblingIndex + 1}/{siblingPaths.length}</span>
          {/if}
          <span>{$_("viewer.close_keys")}</span>
        </div>
        <div class="footer-center">
          {#if activeMode === "Text"}
            <span>{$_("viewer.lines", { n: textLines.length })}</span>
          {:else if activeMode === "Hex"}
            <span>{$_("viewer.rows", { n: content?.hex_lines?.length ?? 0 })}</span>
          {/if}
        </div>
        <div class="footer-right">
          <button
            class="footer-encoding-badge"
            onclick={(e) => { e.stopPropagation(); toggleMenu('encoding'); }}
            title={$_("viewer.change_encoding")}
          >
            {$_("viewer.encoding_label", { encoding: content?.encoding || currentEncoding })}
          </button>
        </div>
      </div>
    </div>
  </div>
{:else}
  <div class="viewer-container embedded">
    <div class="viewer-header embedded-header">
      <div class="mode-switch-group">
        <button
          class="mode-btn"
          class:active={activeMode === "Text"}
          onclick={() => activeMode = "Text"}
        >{$_("viewer.mode_text")}</button>
        <button
          class="mode-btn"
          class:active={activeMode === "Hex"}
          onclick={() => activeMode = "Hex"}
        >{$_("viewer.mode_hex")}</button>
      </div>

      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="quick-encoding-container" onclick={(e) => e.stopPropagation()}>
        <button
          class="viewer-encoding-btn"
          onclick={() => toggleMenu('encoding')}
        >
          <span class="enc-label">{content?.encoding || currentEncoding}</span>
          <span class="enc-arrow">▾</span>
        </button>
        {#if activeMenu === 'encoding'}
          <div class="menu-dropdown encoding-dropdown embedded-dropdown">
            {#each ENCODING_LIST as enc}
              <button
                class="menu-dropdown-item encoding-item"
                class:selected={isSelectedEncoding(enc)}
                onclick={() => selectEncoding(enc)}
              >
                <span class="bullet-indicator">{isSelectedEncoding(enc) ? '•' : ''}</span>
                <span class="encoding-name">{enc}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>

      {#if activeMode === "Text"}
        <button
          class="viewer-btn"
          class:active={wordWrap}
          onclick={() => (wordWrap = !wordWrap)}
          title={$_("viewer.toggle_word_wrap")}
        >↩</button>
      {/if}
    </div>

    <div class="viewer-body">
      {@render ViewerContentSnippet({ loading, error, content, textLines, lineNumbers, wordWrap, activeMode })}
    </div>
  </div>
{/if}

{#snippet ViewerContentSnippet({ loading, error, content, textLines, lineNumbers, wordWrap, activeMode }: { loading: boolean, error: string | null, content: any, textLines: string[], lineNumbers: boolean, wordWrap: boolean, activeMode: string })}
  {#if loading}
    <div class="viewer-loading">
      <span class="spinner"></span>
      {$_("media_viewer.loading_file")}
    </div>
  {:else if error}
    <div class="viewer-error">{error}</div>
  {:else if activeMode === "Text"}
    <div class="text-viewer" class:wrap={wordWrap}>
      {#each textLines as line, i}
        <div class="text-line">
          {#if lineNumbers}
            <span class="line-num">{i + 1}</span>
          {/if}
          <span class="line-content">
            {#each parseLineTokens(line) as token}
              {#if token.isCtrl}
                <span class="ctrl-box" title={`Control 0x${token.text}`}>
                  <span class="ctrl-top">00</span>
                  <span class="ctrl-bot">{token.text}</span>
                </span>
              {:else}
                {token.text}
              {/if}
            {/each}
            {#if line.length === 0}
              {" "}
            {/if}
          </span>
        </div>
      {/each}
    </div>
  {:else if activeMode === "Hex"}
    <div class="hex-viewer">
      {#each content?.hex_lines ?? [] as line}
        <div class="hex-line">{line}</div>
      {/each}
    </div>
  {:else if activeMode === "Image"}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="image-viewer"
      bind:this={imageViewerEl}
      role="presentation"
      class:is-panning={isPanning}
      class:is-zoomed={imageZoom > 1}
      onwheel={handleWheel}
      onpointerdown={handlePointerDown}
      onpointermove={handlePointerMove}
      onpointerup={handlePointerUp}
      onpointercancel={handlePointerUp}
      ondblclick={handleImageDoubleClick}
    >
      <img
        src={imageSrc}
        alt={content?.file_name}
        class="viewer-image"
        style="transform: scale({imageZoom}) translate({imagePanX / imageZoom}px, {imagePanY / imageZoom}px) rotate({imageRotation}deg);"
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
    background: rgba(0, 0, 0, 0.8);
    backdrop-filter: var(--nc-overlay-blur, blur(6px));
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
    position: relative;
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

  /* Menubar (File  View  Encoding  About) */
  .viewer-menubar {
    display: flex;
    align-items: center;
    background: var(--color-nc-bg-panel);
    border-bottom: 1px solid var(--color-nc-border);
    padding: 2px 8px;
    gap: 4px;
    font-size: 12px;
    user-select: none;
  }

  .menu-item-wrapper {
    position: relative;
  }

  .menubar-btn {
    background: transparent;
    border: none;
    color: var(--color-nc-text);
    padding: 4px 10px;
    font-size: 12px;
    border-radius: 4px;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }

  .menubar-btn:hover,
  .menubar-btn.active {
    background: var(--color-nc-bg-hover);
    color: var(--color-nc-accent);
  }

  .menu-dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    min-width: 180px;
    background: var(--color-nc-bg-panel);
    border: 1px solid var(--color-nc-border-bright);
    border-radius: 6px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
    z-index: 100;
    padding: 4px 0;
    margin-top: 2px;
  }

  .encoding-dropdown {
    min-width: 200px;
    max-height: 70vh;
    overflow-y: auto;
  }

  .embedded-dropdown {
    right: 0;
    left: auto;
  }

  .menu-dropdown-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 4px 14px;
    background: transparent;
    border: none;
    color: var(--color-nc-text);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
    transition: background 0.1s, color 0.1s;
    font-family: inherit;
  }

  .menu-dropdown-item:hover:not(:disabled) {
    background: var(--color-nc-bg-hover);
    color: var(--color-nc-accent);
  }

  .menu-dropdown-item:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .menu-dropdown-item.selected {
    font-weight: 600;
    color: var(--color-nc-accent);
  }

  .bullet-indicator {
    display: inline-block;
    width: 14px;
    font-size: 14px;
    color: var(--color-nc-accent);
    line-height: 1;
  }

  .encoding-name {
    flex: 1;
    font-family: var(--font-family-mono);
    font-size: 11px;
  }

  .menu-dropdown-item kbd {
    font-size: 10px;
    font-family: var(--font-family-mono);
    color: var(--color-nc-text-dim);
    margin-left: 16px;
  }

  .menu-divider {
    height: 1px;
    background: var(--color-nc-border);
    margin: 4px 0;
  }

  .static-item {
    cursor: default;
    color: var(--color-nc-text-dim);
    font-size: 11px;
  }

  /* Header Toolbar */
  .viewer-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 16px;
    background: linear-gradient(
      180deg,
      var(--color-nc-bg-header) 0%,
      var(--color-nc-bg-panel) 100%
    );
    border-bottom: 1px solid var(--color-nc-border);
    gap: 12px;
  }

  .embedded-header {
    padding: 6px 12px;
    background: var(--color-nc-bg-panel);
    gap: 8px;
    justify-content: flex-start;
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
    gap: 6px;
    flex-shrink: 0;
  }

  /* Mode Switch Group */
  .mode-switch-group {
    display: inline-flex;
    background: var(--color-nc-bg);
    border: 1px solid var(--color-nc-border);
    border-radius: 4px;
    padding: 1px;
  }

  .mode-btn {
    padding: 2px 8px;
    background: transparent;
    border: none;
    color: var(--color-nc-text-dim);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    border-radius: 3px;
    transition: all 0.15s;
  }

  .mode-btn:hover {
    color: var(--color-nc-text-bright);
  }

  .mode-btn.active {
    background: var(--color-nc-accent);
    color: #fff;
  }

  /* Quick Encoding selector */
  .quick-encoding-container {
    position: relative;
  }

  .viewer-encoding-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 8px;
    height: 24px;
    background: var(--color-nc-bg);
    border: 1px solid var(--color-nc-border);
    color: var(--color-nc-text);
    font-family: var(--font-family-mono);
    font-size: 11px;
    cursor: pointer;
    border-radius: 4px;
    transition: all 0.15s;
  }

  .viewer-encoding-btn:hover,
  .viewer-encoding-btn.active {
    border-color: var(--color-nc-accent);
    color: var(--color-nc-accent);
  }

  .enc-label {
    max-width: 110px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .enc-arrow {
    font-size: 9px;
    color: var(--color-nc-text-dim);
  }

  .viewer-navigation {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .viewer-nav-status {
    font-size: 11px;
    color: var(--color-nc-text-dim);
    min-width: 45px;
    text-align: center;
    user-select: none;
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
    margin-left: 4px;
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
    user-select: none;
  }

  .footer-left {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .footer-pos {
    font-family: var(--font-family-mono);
    font-weight: 600;
    color: var(--color-nc-text);
  }

  .footer-center {
    font-family: var(--font-family-mono);
  }

  .footer-right {
    display: flex;
    align-items: center;
  }

  .footer-encoding-badge {
    background: var(--color-nc-bg);
    border: 1px solid var(--color-nc-border);
    color: var(--color-nc-accent);
    font-family: var(--font-family-mono);
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 3px;
    cursor: pointer;
    transition: all 0.15s;
  }

  .footer-encoding-badge:hover {
    border-color: var(--color-nc-accent);
    background: var(--color-nc-bg-hover);
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

  /* Text Viewer & Control Character Box */
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

  /* Control Character Box (as seen in screenshot: [00 01], [00 03]) */
  .ctrl-box {
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    vertical-align: -2px;
    margin: 0 1px;
    padding: 1px 2px;
    border: 1px solid var(--color-nc-border-bright);
    border-radius: 2px;
    background: var(--color-nc-bg-panel);
    color: var(--color-nc-accent);
    font-family: var(--font-family-mono);
    font-size: 7px;
    line-height: 1;
    user-select: none;
  }

  .ctrl-top, .ctrl-bot {
    line-height: 0.95;
    font-weight: 600;
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

  .image-viewer.is-zoomed {
    cursor: grab;
  }

  .image-viewer.is-panning {
    cursor: grabbing;
  }

  .viewer-image {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    transform-origin: center center;
    user-select: none;
    border-radius: 4px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
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
