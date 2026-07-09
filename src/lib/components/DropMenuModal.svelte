<script lang="ts">
  import { fade, fly } from "svelte/transition";
  import { formatSize } from "$lib/utils";
  import { _ } from "$lib/i18n";
  import { taskGet, taskCancel, type TaskInfo } from "$lib/ipc";

  interface Props {
    visible: boolean;
    files: string[];
    targetDir: string;
    isExternal: boolean;
    side: "left" | "right";
    forceCopy?: boolean;
    onaction: (action: "copy" | "move") => Promise<string | void>;
    oncancel: () => void;
  }

  let props: Props = $props();

  let showOptions = $state(false);

  let options = $state({
    whenFileExists: "Ask",
    whenDirExists: "Ask",
    whenCannotSetProperty: "Ask",
    excludeEmptyDirs: true,
    verify: false,
    checkFreeSpace: true,
    reserveSpace: true,
    followLinks: false,
    correctLinks: false,
    copyAttributes: true,
    dropReadonly: false,
    copyDateTime: true,
    copyOwnership: false,
    copyOnWrite: false,
  });

  function toggleOptions() {
    showOptions = !showOptions;
  }

  async function startAction(action: "copy" | "move") {
    await props.onaction(action);
  }


  function handleKeydown(e: KeyboardEvent) {
    if (props.visible) {
      if (e.key === "Escape") props.oncancel();
      if (e.key === "c" || e.key === "C") startAction("copy");
      if (e.key === "m" || e.key === "M") startAction("move");
    }
  }



  // Icons from the reference image
  const iconStart = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="display:inline-block; vertical-align:middle; margin-right:4px;"><path d="M8 5v14l11-7z"/></svg>`;
  const iconCancel = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block; vertical-align:middle; margin-right:4px;"><circle cx="12" cy="12" r="10" fill="#cc4444" stroke="none"/><line x1="15" y1="9" x2="9" y2="15" stroke="white"/><line x1="9" y1="9" x2="15" y2="15" stroke="white"/></svg>`;
</script>

<svelte:window onkeydown={handleKeydown} />

{#if props.visible}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- Modal Overlay (Removing click-to-cancel to make it truly modal) -->
  <div class="modal-overlay" transition:fade={{ duration: 150 }}>
    <div 
      class="modal-content" 
      onclick={(e) => e.stopPropagation()}
      transition:fade={{ duration: 150 }}
    >
      <div class="modal-header">
        <span class="modal-title">
          {props.isExternal ? $_('drop_menu.title_import') : props.forceCopy ? $_('drop_menu.title_extract') : $_('drop_menu.title_transfer')}
        </span>
        <div class="window-controls">
          <button class="win-btn" disabled>_</button>
          <button class="win-btn" disabled>□</button>
          <button class="win-btn close" onclick={props.oncancel}>×</button>
        </div>
      </div>

      <div class="modal-body">
        <p class="modal-label">
          {$_('drop_menu.items_to', { n: props.files.length, s: props.files.length !== 1 ? "s" : "" })}
        </p>
        <div class="target-path-wrapper">
          <input type="text" class="target-input" value={props.targetDir} readonly />
        </div>
        
        <div class="transfer-separator"></div>

        <div class="classic-choice-footer">
            <button 
              class="btn btn-options" 
              class:active={showOptions}
              onclick={toggleOptions}
            >
              {$_('drop_menu.options')}
            </button>
            <div class="footer-spacer"></div>
            
            <button class="btn btn-cancel" onclick={props.oncancel}>
              {@html iconCancel} {$_('drop_menu.cancel')}
            </button>

            {#if !props.forceCopy}
              <button class="btn btn-move" onclick={() => startAction("move")}>
                {@html iconStart} {$_('drop_menu.move_here')}
              </button>
            {/if}

            <button class="btn btn-copy" onclick={() => startAction("copy")}>
              {@html iconStart} {props.forceCopy ? $_('drop_menu.extract_here') : $_('drop_menu.copy_here')}
            </button>
        </div>

        {#if showOptions}
          <div class="options-panel" transition:fade={{ duration: 150 }}>
            <div class="options-grid">
              <div class="options-col-left">
                <div class="option-row select-row">
                  <span class="label">{$_('drop_menu.when_file_exists')}</span>
                  <select bind:value={options.whenFileExists}>
                    <option>{$_('drop_menu.ask')}</option>
                    <option>{$_('drop_menu.overwrite')}</option>
                    <option>{$_('drop_menu.skip')}</option>
                    <option>{$_('drop_menu.rename')}</option>
                  </select>
                </div>
                <div class="option-row select-row">
                  <span class="label">{$_('drop_menu.when_dir_exists')}</span>
                  <select bind:value={options.whenDirExists}>
                    <option>{$_('drop_menu.ask')}</option>
                    <option>{$_('drop_menu.merge')}</option>
                    <option>{$_('drop_menu.skip')}</option>
                  </select>
                </div>
                <div class="option-row select-row">
                  <span class="label">{$_('drop_menu.when_cannot_set_property')}</span>
                  <select bind:value={options.whenCannotSetProperty}>
                    <option>{$_('drop_menu.ask')}</option>
                    <option>{$_('drop_menu.ignore_all')}</option>
                  </select>
                </div>
                <div class="option-row template-row">
                  <span class="label">{$_('drop_menu.file_name_template')}</span>
                  <div class="template-box">
                    <span>*.*</span>
                    <button class="mini-btn">▼</button>
                  </div>
                </div>
              </div>

              <div class="options-col-right">
                <label class="checkbox-label">
                  <input type="checkbox" bind:checked={options.verify} />
                  <span>{$_('drop_menu.verify')}</span>
                </label>
                <label class="checkbox-label">
                  <input type="checkbox" bind:checked={options.checkFreeSpace} />
                  <span>{$_('drop_menu.check_free_space')}</span>
                </label>
                <label class="checkbox-label">
                  <input type="checkbox" bind:checked={options.reserveSpace} />
                  <span>{$_('drop_menu.reserve_space')}</span>
                </label>
                <label class="checkbox-label">
                  <input type="checkbox" bind:checked={options.copyAttributes} />
                  <span>{$_('drop_menu.copy_attributes')}</span>
                </label>
                <label class="checkbox-label">
                  <input type="checkbox" bind:checked={options.copyDateTime} />
                  <span>{$_('drop_menu.copy_date_time')}</span>
                </label>
                <label class="checkbox-label">
                  <input type="checkbox" bind:checked={options.copyOwnership} />
                  <span>{$_('drop_menu.copy_ownership')}</span>
                </label>
              </div>
            </div>
            <div class="options-footer">
              <button class="btn-save-default">{$_('drop_menu.save_default')}</button>
            </div>
          </div>
        {/if}

        <div class="file-preview">
          {#each props.files.slice(0, 10) as file}
            <div class="preview-item">{file.split('/').pop()}</div>
          {/each}
          {#if props.files.length > 10}
            <div class="preview-more">{$_('drop_menu.and_more', { n: props.files.length - 10 })}</div>
          {/if}
        </div>
      </div>

      <div class="modal-footer-sep"></div>
    </div>
  </div>
{/if}

<style>
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: transparent;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2000;
  }

  .modal-content {
    background: var(--color-nc-bg-panel);
    border: 1px solid #ababab;
    border-radius: 8px;
    width: 480px;
    box-shadow: 
      0 30px 90px rgba(0, 0, 0, 0.6),
      0 0 0 1px rgba(255, 255, 255, 0.1);
    overflow: hidden;
  }

  :global(.dark) .modal-content {
    border-color: #444;
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 10px;
    background: linear-gradient(180deg, #fcfcfc 0%, #e0e0e0 100%);
    border-bottom: 1px solid #ababab;
  }

  :global(.dark) .modal-header {
    background: linear-gradient(180deg, #444 0%, #222 100%);
    border-bottom: 1px solid #111;
  }

  .window-controls {
    display: flex;
    gap: 2px;
  }

  .win-btn {
    width: 20px;
    height: 20px;
    padding: 0;
    margin: 0;
    background: transparent;
    border: none;
    color: #666;
    font-size: 14px;
    cursor: default;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 2px;
  }

  .win-btn.close {
    cursor: pointer;
    font-size: 18px;
  }

  .win-btn.close:hover {
    background: #e81123;
    color: white;
  }

  .modal-title {
    font-weight: 600;
    font-size: 11px;
    color: #333;
    letter-spacing: 0.01em;
  }

  :global(.dark) .modal-title {
    color: #eee;
  }



  .modal-body {
    padding: 16px;
  }

  .modal-label {
    font-size: 13px;
    color: var(--color-nc-text);
    margin-bottom: 8px;
  }

  .target-path-wrapper {
    margin-bottom: 16px;
  }

  .target-input {
    width: 100%;
    padding: 6px 10px;
    background: var(--color-nc-bg);
    border: 1px solid var(--color-nc-border-bright);
    border-radius: 4px;
    color: var(--color-nc-text-bright);
    font-family: var(--font-family-mono);
    font-size: 12px;
    outline: none;
  }

  .classic-choice-footer {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 20px;
    padding-top: 12px;
    border-top: 1px solid var(--color-nc-border);
  }

  .footer-spacer {
    flex: 1;
  }

  .btn {
    padding: 3px 10px;
    border: 1px solid var(--color-nc-border-bright);
    background: var(--color-nc-bg-alt);
    color: var(--color-nc-text-bright);
    font-size: 11px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    box-shadow: 0 1px 1px rgba(0,0,0,0.1);
    border-radius: 2px;
  }

  :global(.dark) .btn {
    background: var(--color-nc-bg-alt);
    border-color: var(--color-nc-border-bright);
    color: var(--color-nc-text-bright);
  }

  .btn:hover {
    background: var(--color-nc-bg-hover);
    border-color: var(--color-nc-border-bright);
  }

  :global(.dark) .btn:hover {
    background: var(--color-nc-bg-hover);
    border-color: var(--color-nc-border-bright);
  }

  .btn-copy, .btn-move {
    min-width: 90px;
  }

  .file-preview {
    background: rgba(0, 0, 0, 0.1);
    border: 1px solid var(--color-nc-border);
    border-radius: 4px;
    padding: 8px;
    font-size: 11px;
    color: var(--color-nc-text-dim);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .preview-item {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .preview-more {
    font-style: italic;
    opacity: 0.7;
    margin-top: 2px;
  }

  /* Options Panel */
  .options-panel {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px dotted var(--color-nc-border);
  }

  .options-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }

  .option-row {
    margin-bottom: 6px;
  }

  .select-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .select-row .label {
    font-size: 10px;
    white-space: nowrap;
    color: var(--color-nc-text);
  }

  .select-row select {
    flex: 1;
    font-size: 10px;
    padding: 2px 4px;
    background: var(--color-nc-bg);
    color: var(--color-nc-text-bright);
    border: 1px solid var(--color-nc-border-bright);
    border-radius: 2px;
    outline: none;
  }

  :global(.dark) .select-row select {
    background: var(--color-nc-bg);
    color: var(--color-nc-text-bright);
    border-color: var(--color-nc-border-bright);
  }

  .template-row .label {
    display: block;
    font-size: 10px;
    margin-bottom: 2px;
    color: var(--color-nc-text);
  }

  .template-box {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1px 6px;
    background: var(--color-nc-bg);
    border: 1px solid var(--color-nc-border-bright);
    font-size: 10px;
    color: var(--color-nc-text-dim);
    height: 18px;
    border-radius: 2px;
  }

  :global(.dark) .template-box {
    background: var(--color-nc-bg);
    border-color: var(--color-nc-border-bright);
  }

  .mini-btn {
    padding: 0 2px;
    background: var(--color-nc-bg-alt);
    border: 1px solid var(--color-nc-border-bright);
    color: var(--color-nc-text);
    font-size: 9px;
    height: 14px;
    line-height: 1;
    cursor: pointer;
    border-radius: 2px;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
    color: var(--color-nc-text);
    cursor: pointer;
    margin-bottom: 2px;
  }

  :global(.dark) .checkbox-label {
    color: var(--color-nc-text);
  }

  .checkbox-label input {
    margin: 0;
  }

  .options-footer {
    margin-top: 10px;
    text-align: center;
  }

  .btn-save-default {
    background: var(--color-nc-bg-alt);
    border: 1px solid var(--color-nc-border-bright);
    font-size: 10px;
    padding: 2px 10px;
    color: var(--color-nc-text);
    cursor: pointer;
    border-radius: 2px;
  }

  .btn-save-default:hover {
    background: var(--color-nc-bg-hover);
    color: var(--color-nc-text-bright);
  }

  :global(.dark) .btn-save-default {
    background: var(--color-nc-bg-alt);
    border-color: var(--color-nc-border-bright);
    color: var(--color-nc-text);
  }

  .btn.active {
    background: var(--color-nc-bg-selected);
    box-shadow: inset 0 1px 3px rgba(0,0,0,0.2);
  }

  .modal-footer-sep {
    height: 8px;
  }
</style>
