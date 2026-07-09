<script lang="ts">
  import { openFile, resolveOpenAction, getSystemCapabilities, convertPreview, remuxPreview, convertFileSrc, readFileForViewer, saveTextFile, openOnThisComputer, type ResolvedOpenAction, type PreviewConversionStatus, type SystemCapabilities, type ViewerContent } from "$lib/ipc";
  import FileViewer from "./FileViewer.svelte";
  import FileEditor from "./FileEditor.svelte";
  import { formatSize } from "$lib/utils";
  import { playPlaylist } from "$lib/playerStore";

  interface Props {
    path: string;
    intent?: "open" | "view" | "edit";
    siblingPaths?: string[];
    onclose?: () => void;
    onsaved?: () => void;
  }

  let { path, intent = "open", siblingPaths = [], onclose, onsaved }: Props = $props();

  let currentPath = $state("");
  let currentIntent = $state<"open" | "view" | "edit">("open");
  let capabilities: SystemCapabilities | null = $state(null);
  let resolved: ResolvedOpenAction | null = $state(null);
  let loading = $state(true);
  // Stays false while we don't yet know the file kind, so opening an audio
  // file (which hands off to the persistent mini-player) never flashes this
  // modal's large frame on screen before closing again.
  let visible = $state(false);
  let error: string | null = $state(null);
  let editorValue = $state("");
  let originalValue = $state("");
  let editorReadOnly = $state(false);
  let isSaving = $state(false);
  let conversion: PreviewConversionStatus | null = $state(null);
  let shellEl: HTMLDivElement | undefined = $state(undefined);

  const rawUrl = $derived(convertFileSrc(currentPath));
  const isDirty = $derived(editorValue !== originalValue);
  const siblingIndex = $derived(siblingPaths.indexOf(currentPath));
  const canGoPrev = $derived(siblingPaths.indexOf(currentPath) > 0);
  const canGoNext = $derived(siblingPaths.indexOf(currentPath) >= 0 && siblingPaths.indexOf(currentPath) < siblingPaths.length - 1);

  async function loadCurrent() {
    loading = true;
    error = null;
    conversion = null;
    resolved = null;
    editorReadOnly = false;
    try {
      capabilities = await getSystemCapabilities();
      const nextResolved = await resolveOpenAction(currentPath, currentIntent);
      resolved = nextResolved;

      if (nextResolved.action === "desktop-app") {
        await openFile(currentPath);
        onclose?.();
        return;
      }

      if (nextResolved.action === "media-player" && nextResolved.media_kind === "audio") {
        // Audio hands off to the persistent mini-player so playback survives
        // closing this modal and browsing to other folders.
        playPlaylist(siblingPaths.length > 0 ? siblingPaths : [currentPath], currentPath);
        onclose?.();
        return;
      }

      visible = true;

      if (nextResolved.action === "editor") {
        const content = await readFileForViewer(currentPath);
        if (content.mode !== "Text" || content.text === null) {
          throw new Error("This file cannot be opened in the built-in editor.");
        }
        originalValue = content.text;
        editorValue = content.text;
      } else if (nextResolved.action === "converted-preview") {
        conversion = await convertPreview(currentPath);
      } else if (nextResolved.action === "media-remux") {
        conversion = await remuxPreview(currentPath);
      }
    } catch (e: any) {
      visible = true;
      error = typeof e === "string" ? e : e.message || "Failed to open file";
      if (resolved?.action === "editor") {
        editorReadOnly = true;
      }
    } finally {
      loading = false;
    }
  }

  async function saveCurrentFile() {
    if (isSaving || editorReadOnly) return;
    isSaving = true;
    error = null;
    try {
      await saveTextFile(currentPath, editorValue);
      originalValue = editorValue;
      onsaved?.();
    } catch (e: any) {
      error = typeof e === "string" ? e : e.message || "Failed to save file";
    } finally {
      isSaving = false;
    }
  }

  async function saveAs() {
    const targetPath = window.prompt("Save as", currentPath);
    if (!targetPath) return;
    isSaving = true;
    error = null;
    try {
      await saveTextFile(targetPath, editorValue);
      currentPath = targetPath;
      originalValue = editorValue;
      onsaved?.();
    } catch (e: any) {
      error = typeof e === "string" ? e : e.message || "Failed to save file";
    } finally {
      isSaving = false;
    }
  }

  function copyPath() {
    void navigator.clipboard?.writeText(currentPath);
  }

  function openRaw() {
    window.open(rawUrl, "_blank", "noopener,noreferrer");
  }

  function copyStreamUrl() {
    void navigator.clipboard?.writeText(new URL(rawUrl, window.location.origin).toString());
  }

  function gotoSibling(offset: -1 | 1) {
    const currentIndex = siblingPaths.indexOf(currentPath);
    if (currentIndex < 0) return;
    const nextPath = siblingPaths[currentIndex + offset];
    if (!nextPath) return;
    currentPath = nextPath;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!visible) return;
    if (e.key === "Escape") {
      e.preventDefault();
      onclose?.();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && resolved?.action === "editor") {
      e.preventDefault();
      void saveCurrentFile();
    }
    if (e.key === "ArrowLeft" && canGoPrev && (resolved?.action === "image-viewer" || resolved?.action === "media-player" || resolved?.action === "media-remux")) {
      e.preventDefault();
      gotoSibling(-1);
    }
    if (e.key === "ArrowRight" && canGoNext && (resolved?.action === "image-viewer" || resolved?.action === "media-player" || resolved?.action === "media-remux")) {
      e.preventDefault();
      gotoSibling(1);
    }
  }

  $effect(() => {
    currentPath = path;
    currentIntent = intent;
  });

  $effect(() => {
    currentPath;
    currentIntent;
    void loadCurrent();
  });

  // Without this, focus stays on <body> while the modal is up, and browsers
  // send unhandled scroll keys (Space/PageUp/PageDown/Home/End/arrows) to
  // whichever file-list panel last held scroll position instead of eating
  // them here — the background panel visibly scrolls through the modal's
  // transparent surround even though clicks on it are correctly blocked.
  $effect(() => {
    if (visible && shellEl) {
      shellEl.focus();
    }
  });
</script>

<svelte:window onkeydown={handleKeydown} />

{#if visible}
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="modal-overlay" onclick={() => onclose?.()} role="presentation">
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-shell" bind:this={shellEl} tabindex="-1" onclick={(e) => e.stopPropagation()}>
    <div class="modal-header">
      <div class="modal-heading">
        <div class="modal-title">{resolved?.file_name ?? currentPath.split("/").pop() ?? currentPath}</div>
        <div class="modal-meta">
          {resolved ? `${resolved.action} • ${formatSize(resolved.file_size)}` : currentPath}
        </div>
      </div>
      <div class="modal-actions">
        {#if resolved?.action === "editor"}
          <button class="tool-btn" onclick={() => void saveCurrentFile()} disabled={isSaving || !isDirty || editorReadOnly}>Save</button>
          <button class="tool-btn" onclick={saveAs} disabled={isSaving}>Save As</button>
        {/if}
        {#if resolved?.media_kind === "video"}
          <button class="tool-btn" onclick={copyStreamUrl} title="Copy a URL you can paste into VLC/mpv's 'Open network stream'">Copy stream URL</button>
        {/if}
        <button class="tool-btn" onclick={() => openOnThisComputer(currentPath)} title="Open with a local app on this device, if the one-time local opener is installed">On this computer</button>
        <button class="tool-btn" onclick={copyPath}>Copy path</button>
        <a class="tool-btn link-btn" href={rawUrl} download={resolved?.file_name ?? true}>Download</a>
        <button class="close-btn" onclick={() => onclose?.()}>X</button>
      </div>
    </div>

    <div class="modal-body">
      {#if loading}
        <div class="empty-state">Loading file...</div>
      {:else if error}
        <div class="empty-state error-state">
          <p>{error}</p>
          <div class="fallback-actions">
            <button class="tool-btn" onclick={openRaw}>Open raw</button>
            {#if resolved?.media_kind === "video"}
              <button class="tool-btn" onclick={copyStreamUrl}>Copy stream URL</button>
            {/if}
            <a class="tool-btn link-btn" href={rawUrl} download={resolved?.file_name ?? true}>Download</a>
          </div>
        </div>
      {:else if resolved?.action === "editor"}
        <div class="editor-body">
          <FileEditor path={currentPath} value={editorValue} readOnly={editorReadOnly} onChange={(value) => editorValue = value} />
        </div>
      {:else if resolved?.action === "text-viewer"}
        <FileViewer path={currentPath} embedded={true} />
      {:else if resolved?.action === "image-viewer"}
        <div class="image-shell">
          <FileViewer path={currentPath} embedded={true} />
          {#if siblingPaths.length > 1}
            <div class="image-browser">
              <button class="nav-btn" onclick={() => gotoSibling(-1)} title="Previous image" disabled={!canGoPrev}>Prev</button>
              <span class="browser-status">{siblingIndex + 1}/{siblingPaths.length}</span>
              <button class="nav-btn" onclick={() => gotoSibling(1)} title="Next image" disabled={!canGoNext}>Next</button>
            </div>
          {/if}
        </div>
      {:else if resolved?.action === "pdf-viewer"}
        <iframe class="preview-frame" src={rawUrl} title={resolved.file_name}></iframe>
      {:else if resolved?.action === "media-player"}
        <!-- Audio never reaches here: loadCurrent() hands it off to the persistent mini-player. -->
        <div class="media-shell">
          {#if canGoPrev}
            <button class="nav-btn" onclick={() => gotoSibling(-1)} title="Previous file">Prev</button>
          {/if}
          <!-- svelte-ignore a11y_media_has_caption -->
          <video class="media-player" controls autoplay src={rawUrl}></video>
          {#if canGoNext}
            <button class="nav-btn" onclick={() => gotoSibling(1)} title="Next file">Next</button>
          {/if}
        </div>
      {:else if resolved?.action === "converted-preview"}
        {#if conversion}
          <div class="converted-preview">
            <div class="conversion-label">{conversion.message}</div>
            <iframe class="preview-frame" src={conversion.previewUrl} title={resolved.file_name}></iframe>
          </div>
        {:else}
          <div class="empty-state">Generating preview...</div>
        {/if}
      {:else if resolved?.action === "media-remux"}
        {#if conversion}
          <div class="media-shell">
            {#if canGoPrev}
              <button class="nav-btn" onclick={() => gotoSibling(-1)} title="Previous file">Prev</button>
            {/if}
            <!-- svelte-ignore a11y_media_has_caption -->
            <video class="media-player" controls autoplay src={conversion.previewUrl}></video>
            {#if canGoNext}
              <button class="nav-btn" onclick={() => gotoSibling(1)} title="Next file">Next</button>
            {/if}
          </div>
        {:else}
          <div class="empty-state">Repackaging for browser playback...</div>
        {/if}
      {:else}
        <div class="empty-state">
          <p>{resolved?.reason ?? "This file cannot be previewed in the current runtime."}</p>
          <div class="fallback-actions">
            <button class="tool-btn" onclick={openRaw}>Open raw</button>
            {#if resolved?.media_kind === "video"}
              <button class="tool-btn" onclick={copyStreamUrl}>Copy stream URL</button>
            {/if}
            <a class="tool-btn link-btn" href={rawUrl} download={resolved?.file_name ?? true}>Download</a>
          </div>
        </div>
      {/if}
    </div>

    <div class="modal-footer">
      <span>{capabilities?.headless ? "Headless runtime" : "Desktop runtime"}</span>
      {#if resolved?.action === "editor"}
        <span>{isDirty ? "Unsaved changes" : "Saved"}</span>
      {:else if resolved?.mime_type}
        <span>{resolved.mime_type}</span>
      {/if}
    </div>
  </div>
</div>
{/if}

<style>
  .modal-overlay {
    position: fixed;
    inset: 0;
    z-index: 2200;
    background: rgba(0, 0, 0, 0.55);
    padding: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .modal-shell {
    width: min(1500px, 100%);
    height: min(92vh, 100%);
    display: flex;
    flex-direction: column;
    border: 1px solid var(--color-nc-border-bright);
    border-radius: 8px;
    overflow: hidden;
    background: var(--color-nc-bg);
    box-shadow: 0 30px 90px rgba(0, 0, 0, 0.45);
    outline: none;
  }

  .modal-header,
  .modal-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 16px;
    background: var(--color-nc-bg-panel);
    border-bottom: 1px solid var(--color-nc-border);
  }

  .modal-footer {
    border-top: 1px solid var(--color-nc-border);
    border-bottom: none;
    color: var(--color-nc-text-dim);
    font-size: 11px;
  }

  .modal-heading {
    min-width: 0;
  }

  .modal-title {
    font-weight: 700;
    color: var(--color-nc-text-bright);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .modal-meta {
    font-size: 11px;
    color: var(--color-nc-text-dim);
  }

  .modal-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .tool-btn,
  .close-btn,
  .link-btn {
    appearance: none;
    border: 1px solid var(--color-nc-border);
    background: var(--color-nc-bg);
    color: var(--color-nc-text);
    padding: 6px 10px;
    border-radius: 4px;
    cursor: pointer;
    text-decoration: none;
    font-size: 12px;
  }

  .tool-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .close-btn {
    min-width: 34px;
  }

  .modal-body {
    flex: 1;
    min-height: 0;
    display: flex;
    background: var(--color-nc-bg-deep);
  }

  .editor-body,
  .converted-preview,
  .image-shell {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .preview-frame {
    border: none;
    width: 100%;
    height: 100%;
    background: white;
  }

  .media-shell {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 20px;
  }

  .media-player {
    max-width: 100%;
    max-height: 100%;
    width: min(960px, 100%);
  }

  .nav-btn {
    border: 1px solid var(--color-nc-border);
    background: var(--color-nc-bg-panel);
    color: var(--color-nc-text);
    padding: 8px 12px;
    border-radius: 4px;
    cursor: pointer;
  }

  .nav-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .image-browser {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 8px 14px;
    border-top: 1px solid var(--color-nc-border);
    background: var(--color-nc-bg-panel);
    flex-shrink: 0;
  }

  .browser-status {
    min-width: 72px;
    text-align: center;
    color: var(--color-nc-text-dim);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .empty-state {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    gap: 16px;
    padding: 24px;
    text-align: center;
    color: var(--color-nc-text-dim);
  }

  .error-state {
    color: #ffb4b4;
  }

  .fallback-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: center;
  }

  .conversion-label {
    padding: 10px 16px;
    font-size: 12px;
    color: var(--color-nc-text-dim);
    border-bottom: 1px solid var(--color-nc-border);
    background: var(--color-nc-bg-panel);
  }

  :global(.modal-body .viewer-container.embedded) {
    flex: 1;
    display: flex;
  }

  :global(.modal-body .viewer-body) {
    flex: 1;
  }
</style>
