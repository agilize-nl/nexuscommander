<script lang="ts">
  import { conflictState, uploadStore, getUniqueRenamePath, applyConflictPolicy } from "$lib/upload/uploadStore";
  import { formatDate, formatSize } from "$lib/utils";
  import { _ } from "$lib/i18n";
  import { XCircle, Play, AlertTriangle, CheckCircle } from "lucide-svelte";
  import { updateSettings } from "$lib/stores";
  import type { ConflictPolicy } from "$lib/types";

  let conflict = $derived($conflictState);
  let visible = $derived(conflict.visible);
  let conflicts = $derived(conflict.conflicts);

  let currentIndex = $state(0);
  let showRenameInput = $state(false);
  let renameValue = $state("");
  let resolutions = $state<Record<string, { action: 'overwrite' | 'skip' | 'rename'; renameTo?: string }>>({});

  // New conflict policy state
  let selectedPolicy = $state<ConflictPolicy>('ask');
  let saveAsDefault = $state(false);

  let currentConflict = $derived(conflicts[currentIndex]);
  let incomingFile = $derived(currentConflict ? $uploadStore.items.find(item => item.rel === currentConflict.rel) : null);

  // Derive comparison variables
  let timeDiff = $derived(
    currentConflict && incomingFile
      ? incomingFile.file.lastModified - currentConflict.modified
      : 0
  );
  let isNewer = $derived(timeDiff > 2000);
  let isOlder = $derived(timeDiff < -2000);
  let isTimeSame = $derived(Math.abs(timeDiff) <= 2000);

  let sizeDiff = $derived(
    currentConflict && incomingFile
      ? incomingFile.file.size - currentConflict.size
      : 0
  );
  let isLarger = $derived(sizeDiff > 0);
  let isSmaller = $derived(sizeDiff < 0);
  let isSizeSame = $derived(sizeDiff === 0);

  let isIdentical = $derived(isTimeSame && isSizeSame);

  function getUsedPaths(): Set<string> {
    const paths = new Set<string>();
    // 1. Initial targeted paths in the upload batch
    for (const item of $uploadStore.items) {
      paths.add(item.rel);
    }
    // 2. Existing files on the server (conflicts)
    for (const conf of conflicts) {
      paths.add(conf.rel);
    }
    // 3. Already decided renameTo destinations in this modal session
    for (const key in resolutions) {
      const res = resolutions[key];
      if (res.action === 'rename' && res.renameTo) {
        paths.add(res.renameTo);
      }
    }
    return paths;
  }

  $effect(() => {
    if (visible) {
      currentIndex = 0;
      showRenameInput = false;
      resolutions = {};
      selectedPolicy = 'ask';
      saveAsDefault = false;
    }
  });

  $effect(() => {
    if (currentConflict) {
      renameValue = getUniqueRenamePath(currentConflict.rel, getUsedPaths());
    }
  });

  function handleResolve(action: 'overwrite' | 'skip' | 'rename') {
    if (!currentConflict) return;

    const resolution = {
      action,
      ...(action === 'rename' ? { renameTo: renameValue } : {})
    };

    resolutions[currentConflict.rel] = resolution;
    
    if (currentIndex === conflicts.length - 1) {
      // Completed last conflict in loop
      if (saveAsDefault) {
        updateSettings((config) => {
          config.upload_on_conflict = selectedPolicy;
        });
      }
      conflict.resolve?.(resolutions);
    } else {
      showRenameInput = false;
      currentIndex++;
    }
  }

  function applyRemainingPolicy() {
    if (selectedPolicy === 'ask') return;
    
    const remainingConflicts = conflicts.slice(currentIndex);
    const items = $uploadStore.items;
    const itemsByRel = new Map<string, any>();
    for (const item of items) {
      itemsByRel.set(item.rel, item);
    }
    
    // Resolve remaining using helper
    const remainingResolutions = applyConflictPolicy(selectedPolicy, remainingConflicts, itemsByRel);
    
    // Merge into our resolutions
    const finalResolutions = { ...resolutions, ...remainingResolutions };
    
    // Save to default config if checkbox is ticked
    if (saveAsDefault) {
      updateSettings((config) => {
        config.upload_on_conflict = selectedPolicy;
      });
    }

    conflict.resolve?.(finalResolutions);
  }

  function handleCancel() {
    conflict.reject?.();
  }
</script>

{#if visible && currentConflict}
  <div class="dialog-overlay">
    <div class="dialog-box">
      <div class="dialog-header">
        <div class="dialog-title flex-row">
          <AlertTriangle size={16} class="text-nc-exec" />
          <span>{$_('upload.conflict_title')} ({currentIndex + 1}/{conflicts.length})</span>
        </div>
        <button class="close-btn" onclick={handleCancel}>✕</button>
      </div>

      <div class="dialog-body">
        <div class="conflict-file-path">{currentConflict.rel}</div>
        
        <div class="policy-selector-container">
          <label class="dialog-label" for="policy-select">{$_('upload.when_exists')}</label>
          <select id="policy-select" bind:value={selectedPolicy} class="dialog-select">
            <option value="ask">{$_('upload.policy_ask')}</option>
            <option value="overwrite">{$_('upload.policy_overwrite')}</option>
            <option value="overwrite_newer">{$_('upload.policy_overwrite_newer')}</option>
            <option value="overwrite_size_differs">{$_('upload.policy_overwrite_size_differs')}</option>
            <option value="skip">{$_('upload.policy_skip')}</option>
            <option value="rename_all">{$_('upload.policy_rename_all')}</option>
          </select>
        </div>

        {#if isIdentical}
          <div class="identical-banner">
            <CheckCircle size={14} class="text-nc-success" />
            <span>{$_('upload.identical')}</span>
          </div>
        {/if}

        <div class="details-grid">
          <div class="details-section existing">
            <div class="details-title">{$_("upload.existing_file")}</div>
            <div class="details-info">
              <span>{$_("upload.size_label")}</span> <strong>{formatSize(currentConflict.size)}</strong>
            </div>
            <div class="details-info">
              <span>{$_("upload.modified_label")}</span> <strong>{formatDate(currentConflict.modified)}</strong>
            </div>
          </div>

          <div class="details-section incoming">
            <div class="details-title">{$_("upload.new_file")}</div>
            {#if incomingFile}
              <div class="details-info">
                <span>{$_("upload.size_label")}</span> 
                <strong>
                  {formatSize(incomingFile.size)}
                  {#if isLarger}
                    <span class="badge badge-accent">{$_('upload.larger')}</span>
                  {:else if isSmaller}
                    <span class="badge badge-dim">{$_('upload.smaller')}</span>
                  {/if}
                </strong>
              </div>
              <div class="details-info">
                <span>{$_("upload.modified_label")}</span> 
                <strong>
                  {formatDate(incomingFile.file.lastModified)}
                  {#if isNewer}
                    <span class="badge badge-accent">{$_('upload.newer')}</span>
                  {:else if isOlder}
                    <span class="badge badge-dim">{$_('upload.older')}</span>
                  {/if}
                </strong>
              </div>
            {:else}
              <div class="details-info">—</div>
            {/if}
          </div>
        </div>

        {#if showRenameInput}
          <div class="rename-container">
            <label class="dialog-label" for="rename-input">{$_("upload.new_name_label")}</label>
            <div class="rename-row">
              <input
                id="rename-input"
                type="text"
                class="dialog-input"
                bind:value={renameValue}
                onkeydown={(e) => e.key === 'Enter' && handleResolve('rename')}
              />
              <button class="btn btn-primary" onclick={() => handleResolve('rename')}>
                <Play size={12} fill="currentColor" /> OK
              </button>
            </div>
          </div>
        {/if}

        <label class="checkbox-label select-none">
          <input type="checkbox" bind:checked={saveAsDefault} />
          {$_('upload.save_as_default')}
        </label>
      </div>

      <div class="dialog-footer">
        <button class="btn btn-secondary" onclick={handleCancel}>
          <XCircle size={16} color="var(--color-nc-danger)" /> {$_('dialogs.cancel')}
        </button>
        <div class="footer-spacer"></div>
        
        {#if selectedPolicy === 'ask'}
          {#if !showRenameInput}
            <button class="btn btn-secondary" onclick={() => showRenameInput = true}>
              {$_('upload.rename')}
            </button>
          {/if}
          <button 
            class="btn {isIdentical ? 'btn-primary' : 'btn-secondary'}" 
            onclick={() => handleResolve('skip')}
          >
            {$_('upload.skip')}
          </button>
          <button 
            class="btn {isIdentical ? 'btn-secondary' : 'btn-primary'}" 
            onclick={() => handleResolve('overwrite')}
          >
            {$_('upload.overwrite')}
          </button>
        {:else}
          <button class="btn btn-primary" onclick={applyRemainingPolicy}>
            {$_('upload.apply_to_remaining').replace('{n}', String(conflicts.length - currentIndex))}
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .dialog-overlay {
    position: fixed;
    inset: 0;
    background: transparent;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 5000;
  }

  .dialog-box {
    background: var(--color-nc-bg-deep);
    border: 1px solid var(--color-nc-border-bright);
    border-radius: 6px;
    width: 480px;
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    position: relative;
  }

  .dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    background: var(--color-nc-bg-header);
    border-bottom: 1px solid var(--color-nc-border);
  }

  .dialog-title {
    font-weight: 600;
    font-size: 13px;
    color: var(--color-nc-text-bright);
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .flex-row {
    display: flex;
    align-items: center;
  }

  .close-btn {
    background: none;
    border: none;
    color: var(--color-nc-text-dim);
    cursor: pointer;
    font-size: 14px;
    padding: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
  }

  .close-btn:hover {
    background: rgba(255, 255, 255, 0.1);
    color: var(--color-nc-text-bright);
  }

  .dialog-body {
    padding: 20px;
    background: var(--color-nc-bg);
    color: var(--color-nc-text);
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .conflict-file-path {
    font-family: var(--font-family-mono);
    font-size: 12px;
    color: var(--color-nc-text-bright);
    background: var(--color-nc-bg-deep);
    padding: 8px 12px;
    border-radius: 4px;
    word-break: break-all;
    border: 1px solid var(--color-nc-border);
  }

  .policy-selector-container {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 4px;
  }

  .dialog-select {
    padding: 6px 10px;
    background: var(--color-nc-bg-deep);
    border: 1px solid var(--color-nc-border-bright);
    color: var(--color-nc-text-bright);
    font-size: 12px;
    outline: none;
    border-radius: 4px;
    cursor: pointer;
  }

  .dialog-select:focus {
    border-color: var(--color-nc-accent);
    box-shadow: 0 0 0 2px var(--color-nc-accent-glow);
  }

  .identical-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    background: rgba(80, 250, 123, 0.15); /* NC Success background glow */
    border: 1px solid var(--color-nc-success);
    color: var(--color-nc-success);
    padding: 8px 12px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
  }

  .badge {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 600;
    margin-left: 6px;
    text-transform: uppercase;
  }

  .badge-accent {
    background: var(--color-nc-accent);
    color: var(--color-nc-bg-deep);
  }

  .badge-dim {
    background: var(--color-nc-bg-hover);
    color: var(--color-nc-text-dim);
    border: 1px solid var(--color-nc-border);
  }

  .details-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    background: var(--color-nc-bg-deep);
    border: 1px solid var(--color-nc-border);
    border-radius: 4px;
    padding: 12px;
  }

  .details-section {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 11px;
  }

  .details-title {
    font-weight: 600;
    color: var(--color-nc-text-bright);
    margin-bottom: 4px;
  }

  .details-info {
    display: flex;
    justify-content: space-between;
    color: var(--color-nc-text);
  }

  .details-info span {
    color: var(--color-nc-text-dim);
  }

  .rename-container {
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: var(--color-nc-bg-deep);
    border: 1px solid var(--color-nc-border);
    border-radius: 4px;
    padding: 8px 12px;
  }

  .rename-row {
    display: flex;
    gap: 8px;
  }

  .dialog-label {
    font-size: 11px;
    color: var(--color-nc-text-dim);
  }

  .dialog-input {
    flex: 1;
    padding: 6px 10px;
    background: var(--color-nc-bg);
    border: 1px solid var(--color-nc-border-bright);
    color: var(--color-nc-text-bright);
    font-family: var(--font-family-mono);
    font-size: 12px;
    outline: none;
    border-radius: 4px;
  }

  .dialog-input:focus {
    border-color: var(--color-nc-accent);
    box-shadow: 0 0 0 2px var(--color-nc-accent-glow);
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--color-nc-text-bright);
    cursor: pointer;
    margin-top: 4px;
  }

  .select-none {
    user-select: none;
  }

  .dialog-footer {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    background: var(--color-nc-bg-panel);
    border-top: 1px solid var(--color-nc-border);
  }

  .footer-spacer {
    flex: 1;
  }

  .btn {
    padding: 6px 14px;
    border: 1px solid var(--color-nc-border-bright);
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
    transition: all 0.1s ease;
  }

  .btn-primary {
    background: var(--color-nc-accent-dim);
    border-color: var(--color-nc-accent);
    color: white;
  }

  .btn-primary:hover {
    background: var(--color-nc-accent);
    box-shadow: 0 0 10px var(--color-nc-accent-glow);
  }

  .btn-secondary {
    background: var(--color-nc-bg-header);
    color: var(--color-nc-text-bright);
  }

  .btn-secondary:hover {
    background: var(--color-nc-bg-hover);
  }
</style>
