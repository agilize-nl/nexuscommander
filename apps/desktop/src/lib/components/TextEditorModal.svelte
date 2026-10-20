<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { readFileForViewer, saveTextFile } from "$lib/ipc";
  import FileEditor from "@nexus/ui/components/FileEditor.svelte";
  import { _ } from "$lib/i18n";

  interface Props {
    path: string;
    onclose: () => void;
  }
  let { path, onclose }: Props = $props();

  let text = $state("");
  let originalText = $state("");
  let loading = $state(true);
  let saving = $state(false);
  // A load failure means there is nothing to edit, so it replaces the editor.
  // A save failure must not: the user's unsaved text is still in the editor.
  let loadError: string | null = $state(null);
  let saveError: string | null = $state(null);
  let justSaved = $state(false);
  let savedTimer: ReturnType<typeof setTimeout> | undefined;
  let isDirty = $derived(text !== originalText);

  onMount(() => {
    loadContent();
  });

  onDestroy(() => clearTimeout(savedTimer));

  async function loadContent() {
    loading = true;
    loadError = null;
    try {
      const res = await readFileForViewer(path);
      if (res.mode === "Text" && res.text !== undefined && res.text !== null) {
        text = res.text;
        originalText = res.text;
      } else {
        loadError = $_("editor.not_text_file");
      }
    } catch (e: any) {
      loadError = e?.message || String(e);
    } finally {
      loading = false;
    }
  }

  async function handleSave() {
    if (saving || loading || loadError) return;
    saving = true;
    saveError = null;
    try {
      await saveTextFile(path, text);
      originalText = text;
      justSaved = true;
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => (justSaved = false), 2000);
    } catch (e: any) {
      saveError = `${$_("editor.save_failed")}: ${e?.message || String(e)}`;
    } finally {
      saving = false;
    }
  }

  function handleClose() {
    if (isDirty) {
      const confirmClose = confirm(
        $_("editor.unsaved_changes") || "You have unsaved changes. Do you want to close without saving?"
      );
      if (!confirmClose) return;
    }
    onclose();
  }

  // Backs up the in-editor Mod-s binding for when focus sits outside CodeMirror
  // (e.g. right after clicking the header).
  function handleKeydown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      handleSave();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleClose();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="editor-modal-backdrop">
  <div class="editor-modal-window">
    <header class="editor-modal-header">
      <div class="editor-modal-title">
        <span class="editor-icon">📝</span>
        <span class="editor-filename">{path.split('/').pop() || path}</span>
        {#if isDirty}<span class="dirty-indicator">*</span>{/if}
        {#if justSaved && !isDirty}<span class="saved-indicator">{$_("editor.saved")}</span>{/if}
      </div>
      <div class="editor-modal-actions">
        <button class="editor-btn save" onclick={handleSave} disabled={loading || saving || !!loadError || !isDirty}>
          {saving ? $_("editor.saving") : $_("editor.save")}
        </button>
        <button class="editor-btn close" onclick={handleClose}>
          ✕
        </button>
      </div>
    </header>

    <div class="editor-modal-body">
      {#if loading}
        <div class="status-msg">{$_("help_dialog.loading") || "Loading..."}</div>
      {:else if loadError}
        <div class="status-msg error">{loadError}</div>
      {:else}
        {#if saveError}
          <div class="save-error" role="alert">
            <span>{saveError}</span>
            <button class="save-error-dismiss" onclick={() => (saveError = null)} aria-label={$_("editor.dismiss")}>✕</button>
          </div>
        {/if}
        <FileEditor {path} value={text} onChange={(val) => text = val} onSave={handleSave} />
      {/if}
    </div>

    <div class="editor-modal-footer">
      <span>{$_("editor.shortcuts_hint")}</span>
      <span>{path}</span>
    </div>
  </div>
</div>

<style>
  .editor-modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1100;
    display: grid;
    place-items: center;
    background: rgba(0, 0, 0, 0.4);
    padding: 20px;
  }

  .editor-modal-window {
    width: 90vw;
    height: 85vh;
    display: flex;
    flex-direction: column;
    background: var(--color-nc-bg-panel);
    border: 1px solid var(--color-nc-border-bright);
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
  }

  .editor-modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 12px;
    background: var(--color-nc-bg-deep);
    border-bottom: 1px solid var(--color-nc-border);
  }

  .editor-modal-title {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--color-nc-text-bright);
    font-size: var(--font-main-size);
    font-weight: 700;
    font-family: inherit;
  }

  .dirty-indicator {
    color: var(--color-nc-accent);
    margin-left: 4px;
  }

  .saved-indicator {
    margin-left: 8px;
    color: var(--color-nc-success);
    font-size: var(--font-main-size);
    font-weight: 500;
  }

  .save-error {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 12px;
    background: var(--color-nc-bg-alt);
    border-bottom: 1px solid var(--color-nc-danger);
    color: var(--color-nc-danger);
    font-size: var(--font-main-size);
  }

  .save-error-dismiss {
    border: none;
    background: none;
    color: inherit;
    cursor: pointer;
    font-size: var(--font-main-size);
    padding: 0 4px;
  }

  .editor-modal-actions {
    display: flex;
    gap: 8px;
  }

  .editor-btn {
    padding: 5px 14px;
    font-size: var(--font-main-size);
    font-family: inherit;
    border: 1px solid var(--color-nc-border);
    background: var(--color-nc-bg-alt);
    color: var(--color-nc-text);
    cursor: pointer;
  }

  .editor-btn:hover:not(:disabled) {
    background: var(--color-nc-bg-hover);
    color: var(--color-nc-text-bright);
  }

  .editor-btn.save {
    background: var(--color-nc-accent);
    color: var(--color-nc-bg-deep);
    border-color: transparent;
    font-weight: 600;
  }

  .editor-btn.save:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .editor-btn.close {
    width: 26px;
    height: 26px;
    padding: 0;
    display: grid;
    place-items: center;
    font-size: var(--font-main-size);
  }

  .editor-modal-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--color-nc-bg);
  }

  .status-msg {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    color: var(--color-nc-text-dim);
    font-size: var(--font-main-size);
  }

  .status-msg.error {
    color: var(--color-nc-danger);
  }

  .editor-modal-footer {
    display: flex;
    justify-content: space-between;
    padding: 6px 12px;
    background: var(--color-nc-bg-deep);
    border-top: 1px solid var(--color-nc-border);
    color: var(--color-nc-text-dim);
    font-size: var(--font-main-size);
  }
</style>
