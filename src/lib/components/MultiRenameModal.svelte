<script lang="ts">
  import type { FileEntry } from "$lib/types";
  import { batchRename } from "$lib/ipc";
  import { formatSize } from "$lib/utils";
  import { _ } from "$lib/i18n";

  interface Props {
    entries: FileEntry[];
    currentPath: string;
    onclose: () => void;
    oncomplete: () => void;
  }

  let { entries, currentPath, onclose, oncomplete }: Props = $props();

  let findText = $state("");
  let replaceText = $state("");
  let startNumber = $state(1);
  let stepNumber = $state(1);
  let useCounter = $state(false);

  let previewRenames = $derived.by(() => {
    return entries.map((entry, index) => {
      let newName = entry.name;
      
      // 1. Search and Replace
      if (findText) {
        newName = newName.replaceAll(findText, replaceText);
      }

      // 2. Counter
      if (useCounter) {
        const counter = startNumber + index * stepNumber;
        const extIdx = newName.lastIndexOf(".");
        if (extIdx > 0 && !entry.is_dir) {
          const base = newName.substring(0, extIdx);
          const ext = newName.substring(extIdx);
          newName = `${base}_${counter}${ext}`;
        } else {
          newName = `${newName}_${counter}`;
        }
      }

      const from = currentPath === "/" ? `/${entry.name}` : `${currentPath}/${entry.name}`;
      const to = currentPath === "/" ? `/${newName}` : `${currentPath}/${newName}`;

      return {
        oldName: entry.name,
        newName: newName,
        from,
        to,
        changed: entry.name !== newName
      };
    });
  });

  async function handleRename() {
    const renames: [string, string][] = previewRenames
      .filter(r => r.changed)
      .map(r => [r.from, r.to]);

    if (renames.length === 0) {
      onclose();
      return;
    }

    try {
      await batchRename(renames);
      oncomplete();
    } catch (e) {
      console.error("Batch rename failed:", e);
    }
  }
</script>

<div 
  class="modal-overlay" 
  onclick={onclose} 
  onkeydown={(e) => e.key === "Escape" && onclose()}
  role="button"
  tabindex="-1"
>
  <div 
    class="modal-box" 
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => e.stopPropagation()}
    role="none"
  >
    <div class="modal-header">
      <span class="modal-title">{$_('multi_rename.title')}</span>
    </div>

    <div class="modal-body">
      <div class="controls">
        <div class="control-group">
          <label for="find">{$_('multi_rename.replace')}</label>
          <input id="find" type="text" bind:value={findText} placeholder="Text to find..." />
        </div>
        <div class="control-group">
          <label for="replace">{$_('multi_rename.with')}</label>
          <input id="replace" type="text" bind:value={replaceText} placeholder="Replacement..." />
        </div>
        <div class="control-group checkbox-group">
          <label><input type="checkbox" bind:checked={useCounter} /> Append Counter</label>
        </div>
        {#if useCounter}
          <div class="control-group inline">
            <label>Start: <input type="number" bind:value={startNumber} /></label>
            <label>Step: <input type="number" bind:value={stepNumber} /></label>
          </div>
        {/if}
      </div>

      <div class="preview-scroll">
        <table class="preview-table">
          <thead>
            <tr>
              <th>{$_('multi_rename.col_old')}</th>
              <th>{$_('multi_rename.col_new')}</th>
            </tr>
          </thead>
          <tbody>
            {#each previewRenames as item}
              <tr class:changed={item.changed}>
                <td>{item.oldName}</td>
                <td>{item.newName}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>

    <div class="modal-footer">
      <button class="btn btn-cancel" onclick={onclose}>{$_('common.cancel')}</button>
      <button class="btn btn-ok" onclick={handleRename}>{$_('multi_rename.start')}</button>
    </div>
  </div>
</div>

<style>
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: transparent;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1100;
  }

  .modal-box {
    background: var(--color-nc-bg-panel);
    border: 1px solid var(--color-nc-border-bright);
    border-radius: 12px;
    width: 800px;
    max-width: 90vw;
    height: 600px;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 30px 90px rgba(0, 0, 0, 0.6);
    overflow: hidden;
  }

  .modal-header {
    background: linear-gradient(180deg, var(--color-nc-bg-header) 0%, var(--color-nc-bg-panel) 100%);
    padding: 16px 20px;
    border-bottom: 1px solid var(--color-nc-border);
  }

  .modal-title {
    font-weight: 600;
    font-size: 16px;
    color: var(--color-nc-text-bright);
  }

  .modal-body {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    padding: 20px;
    gap: 20px;
  }

  .controls {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    background: var(--color-nc-bg-deep);
    padding: 16px;
    border-radius: 8px;
    border: 1px solid var(--color-nc-border);
  }

  .control-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .control-group label {
    font-size: 12px;
    color: var(--color-nc-text-dim);
  }

  .control-group input[type="text"],
  .control-group input[type="number"] {
    background: var(--color-nc-bg);
    border: 1px solid var(--color-nc-border);
    border-radius: 4px;
    padding: 8px 12px;
    color: var(--color-nc-text-bright);
    font-size: 13px;
    outline: none;
  }

  .control-group input:focus {
    border-color: var(--color-nc-accent);
  }

  .checkbox-group {
    flex-direction: row;
    align-items: center;
    grid-column: span 2;
  }

  .inline {
    flex-direction: row;
    gap: 20px;
    grid-column: span 2;
  }

  .preview-scroll {
    flex: 1;
    overflow-y: auto;
    border: 1px solid var(--color-nc-border);
    border-radius: 8px;
    background: var(--color-nc-bg);
  }

  .preview-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }

  .preview-table th {
    position: sticky;
    top: 0;
    background: var(--color-nc-bg-deep);
    padding: 8px 12px;
    text-align: left;
    color: var(--color-nc-text-dim);
    font-size: 11px;
    text-transform: uppercase;
    z-index: 10;
  }

  .preview-table td {
    padding: 6px 12px;
    border-bottom: 1px solid var(--color-nc-border);
    color: var(--color-nc-text);
  }

  .preview-table tr.changed td:last-child {
    color: var(--color-nc-accent);
    font-weight: 500;
  }

  .modal-footer {
    padding: 16px 20px;
    background: var(--color-nc-bg-deep);
    border-top: 1px solid var(--color-nc-border);
    display: flex;
    justify-content: flex-end;
    gap: 12px;
  }

  .btn {
    padding: 8px 24px;
    border-radius: 4px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid var(--color-nc-border-bright);
  }

  .btn-cancel {
    background: var(--color-nc-bg-panel);
    color: var(--color-nc-text);
  }

  .btn-ok {
    background: var(--color-nc-accent-dim);
    color: var(--color-nc-text-bright);
    border-color: var(--color-nc-accent);
  }
</style>
