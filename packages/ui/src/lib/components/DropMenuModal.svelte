<script lang="ts">
  import { fade, fly } from "svelte/transition";
  import { formatSize } from "../utils";
  import { _ } from "../i18n";

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

  // ---------- Options Panel State ----------
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
  const iconStart = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" style="display:inline-block; vertical-align:middle; margin-right:4px;"><path d="M8 5v14l11-7z"/></svg>`;
  const iconCancel = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block; vertical-align:middle; margin-right:4px;"><circle cx="12" cy="12" r="10" fill="#cc4444" stroke="none"/><line x1="15" y1="9" x2="9" y2="15" stroke="white"/><line x1="9" y1="9" x2="15" y2="15" stroke="white"/></svg>`;
</script>

<svelte:window onkeydown={handleKeydown} />

{#if props.visible}
  <!-- Modal: no backdrop click handler, so a stray click outside cannot cancel
       the pending drop action. Close via ×, Cancel or Escape. -->
  <div class="modal-overlay" transition:fade={{ duration: 150 }}>
    <div
      class="modal-content"
      transition:fade={{ duration: 150 }}
    >
      <div class="modal-header">
        <span class="modal-title">
          {props.isExternal ? $_("drop_menu.title_import") : props.forceCopy ? $_("drop_menu.title_extract") : $_("drop_menu.title_transfer")}
        </span>
        <div class="window-controls">
          <button class="win-btn" disabled>_</button>
          <button class="win-btn" disabled>□</button>
          <button class="win-btn close" onclick={props.oncancel}>×</button>
        </div>
      </div>

      <div class="modal-body">
        <p class="modal-label">
          {props.files.length === 1
            ? ($_("drop_menu.items_to_single") || "1 item to:")
            : $_("drop_menu.items_to", { n: props.files.length })}
        </p>
        <div class="target-path-wrapper">
          <input type="text" class="target-input" value={props.targetDir} readonly />
        </div>
        <div class="classic-choice-footer">
          <button
            class="btn btn-options"
            class:active={showOptions}
            onclick={toggleOptions}
          >
            {$_("drop_menu.options")}
          </button>
          <div class="footer-spacer"></div>

          <button class="btn btn-cancel" onclick={props.oncancel}>
            {@html iconCancel} {$_("drop_menu.cancel")}
          </button>

          {#if !props.forceCopy}
            <button class="btn btn-move" onclick={() => startAction("move")}>
              {@html iconStart} {$_("drop_menu.move_here")}
            </button>
          {/if}

          <button class="btn btn-copy" onclick={() => startAction("copy")}>
            {@html iconStart} {props.forceCopy ? $_("drop_menu.extract_here") : $_("drop_menu.copy_here")}
          </button>
        </div>

        {#if showOptions}
          <div class="options-panel" transition:fade={{ duration: 150 }}>
            <div class="options-grid">
              <div class="options-col-left">
                <div class="option-row select-row">
                  <span class="label">{$_("drop_menu.when_file_exists")}</span>
                  <select bind:value={options.whenFileExists}>
                    <option>{$_("drop_menu.ask")}</option>
                    <option>{$_("drop_menu.overwrite")}</option>
                    <option>{$_("drop_menu.skip")}</option>
                    <option>{$_("drop_menu.rename")}</option>
                  </select>
                </div>
                <div class="option-row select-row">
                  <span class="label">{$_("drop_menu.when_dir_exists")}</span>
                  <select bind:value={options.whenDirExists}>
                    <option>{$_("drop_menu.ask")}</option>
                    <option>{$_("drop_menu.merge")}</option>
                    <option>{$_("drop_menu.skip")}</option>
                  </select>
                </div>
                <div class="option-row select-row">
                  <span class="label">{$_("drop_menu.when_cannot_set_property")}</span>
                  <select bind:value={options.whenCannotSetProperty}>
                    <option>{$_("drop_menu.ask")}</option>
                    <option>{$_("drop_menu.ignore_all")}</option>
                  </select>
                </div>
                <div class="option-row template-row">
                  <span class="label">{$_("drop_menu.file_name_template")}</span>
                  <div class="template-box">
                    <span>*.*</span>
                    <button class="mini-btn">▼</button>
                  </div>
                </div>
              </div>

              <div class="options-col-right">
                <label class="checkbox-label">
                  <input type="checkbox" bind:checked={options.verify} />
                  <span>{$_("drop_menu.verify")}</span>
                </label>
                <label class="checkbox-label">
                  <input type="checkbox" bind:checked={options.checkFreeSpace} />
                  <span>{$_("drop_menu.check_free_space")}</span>
                </label>
                <label class="checkbox-label">
                  <input type="checkbox" bind:checked={options.reserveSpace} />
                  <span>{$_("drop_menu.reserve_space")}</span>
                </label>
                <label class="checkbox-label">
                  <input type="checkbox" bind:checked={options.copyAttributes} />
                  <span>{$_("drop_menu.copy_attributes")}</span>
                </label>
                <label class="checkbox-label">
                  <input type="checkbox" bind:checked={options.copyDateTime} />
                  <span>{$_("drop_menu.copy_date_time")}</span>
                </label>
                <label class="checkbox-label">
                  <input type="checkbox" bind:checked={options.copyOwnership} />
                  <span>{$_("drop_menu.copy_ownership")}</span>
                </label>
              </div>
            </div>
            <div class="options-footer">
              <button class="btn-save-default">{$_("drop_menu.save_default")}</button>
            </div>
          </div>
        {/if}

        <div class="file-preview">
          {#each props.files.slice(0, 10) as file}
            <div class="preview-item">{file.split('/').pop()}</div>
          {/each}
          {#if props.files.length > 10}
            <div class="preview-more">{$_("drop_menu.and_more", { n: props.files.length - 10 })}</div>
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
    background: rgba(0, 0, 0, 0.7);
    backdrop-filter: blur(8px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2000;
  }

  .modal-content {
    background: var(--color-nc-bg-panel);
    border: 1px solid var(--color-nc-border-bright);
    border-radius: 8px;
    width: 580px;
    max-height: 90vh;
    box-shadow:
      0 30px 90px rgba(0, 0, 0, 0.6),
      0 0 0 1px rgba(255, 255, 255, 0.05);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    background: linear-gradient(180deg, var(--color-nc-bg-header) 0%, var(--color-nc-bg-panel) 100%);
    border-bottom: 1px solid var(--color-nc-border);
    flex-shrink: 0;
  }

  .window-controls {
    display: flex;
    gap: 4px;
  }

  .win-btn {
    width: 22px;
    height: 22px;
    padding: 0;
    margin: 0;
    background: transparent;
    border: none;
    color: var(--color-nc-text-dim);
    font-size: 14px;
    cursor: default;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    transition: background 0.15s ease, color 0.15s ease;
  }

  .win-btn.close {
    cursor: pointer;
    font-size: 18px;
    color: var(--color-nc-text);
  }

  .win-btn.close:hover {
    background: var(--color-nc-danger);
    color: white;
  }

  .modal-title {
    font-weight: 600;
    font-size: 14px;
    color: var(--color-nc-text-bright);
    letter-spacing: 0.01em;
  }

  .modal-body {
    padding: 16px;
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }

  .modal-label {
    font-size: 15px;
    font-weight: 500;
    color: var(--color-nc-text);
    margin-bottom: 8px;
  }

  .target-path-wrapper {
    margin-bottom: 14px;
  }

  .target-input {
    width: 100%;
    padding: 8px 12px;
    background: var(--color-nc-bg-deep);
    border: 1px solid var(--color-nc-border-bright);
    border-radius: 6px;
    color: var(--color-nc-text-bright);
    font-family: var(--font-family-mono);
    font-size: 14px;
    outline: none;
  }

  .classic-choice-footer {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 14px;
    margin-bottom: 14px;
    padding-top: 12px;
    border-top: 1px solid var(--color-nc-border);
  }

  .footer-spacer {
    flex: 1;
  }

  .btn {
    padding: 6px 14px;
    border: 1px solid var(--color-nc-border-bright);
    background: var(--color-nc-bg-header);
    color: var(--color-nc-text-bright);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    border-radius: 6px;
    transition: all 0.15s ease;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
  }

  .btn:hover {
    background: var(--color-nc-bg-hover);
    border-color: var(--color-nc-accent);
    color: var(--color-nc-text-bright);
  }

  .btn:active {
    background: var(--color-nc-bg-selected);
    transform: translateY(1px);
  }

  .btn-copy {
    min-width: 95px;
    background: var(--color-nc-accent);
    border-color: var(--color-nc-accent);
    color: #ffffff;
  }

  .btn-copy:hover {
    filter: brightness(1.1);
    box-shadow: 0 2px 8px var(--color-nc-accent-glow);
    border-color: var(--color-nc-accent);
    color: #ffffff;
  }

  .btn-move {
    min-width: 95px;
  }

  .file-preview {
    margin-top: 14px;
    background: var(--color-nc-bg-deep);
    border: 1px solid var(--color-nc-border);
    border-radius: 6px;
    padding: 10px 12px;
    font-size: 13px;
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
    opacity: 0.75;
    margin-top: 2px;
  }

  /* Options Panel */
  .options-panel {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px dashed var(--color-nc-border);
  }

  .options-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }

  .option-row {
    margin-bottom: 8px;
  }

  .select-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .select-row .label {
    font-size: 13px;
    white-space: nowrap;
    color: var(--color-nc-text);
  }

  .select-row select {
    flex: 1;
    font-size: 13px;
    padding: 4px 6px;
    background: var(--color-nc-bg-deep);
    color: var(--color-nc-text-bright);
    border: 1px solid var(--color-nc-border-bright);
    border-radius: 4px;
    outline: none;
  }

  .select-row select:focus {
    border-color: var(--color-nc-accent);
  }

  .template-row .label {
    display: block;
    font-size: 13px;
    margin-bottom: 4px;
    color: var(--color-nc-text);
  }

  .template-box {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 8px;
    background: var(--color-nc-bg-deep);
    border: 1px solid var(--color-nc-border-bright);
    border-radius: 4px;
    font-size: 13px;
    color: var(--color-nc-text-dim);
    height: 28px;
  }

  .mini-btn {
    padding: 0 6px;
    background: var(--color-nc-bg-header);
    border: 1px solid var(--color-nc-border-bright);
    color: var(--color-nc-text);
    font-size: 11px;
    height: 20px;
    line-height: 1;
    border-radius: 3px;
    cursor: pointer;
  }

  .mini-btn:hover {
    background: var(--color-nc-bg-hover);
    color: var(--color-nc-text-bright);
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--color-nc-text);
    cursor: pointer;
    margin-bottom: 6px;
  }

  .checkbox-label input {
    margin: 0;
    accent-color: var(--color-nc-accent);
  }

  .options-footer {
    margin-top: 14px;
    text-align: center;
  }

  .btn-save-default {
    background: var(--color-nc-bg-header);
    border: 1px solid var(--color-nc-border-bright);
    border-radius: 4px;
    font-size: 13px;
    padding: 5px 14px;
    color: var(--color-nc-text);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .btn-save-default:hover {
    background: var(--color-nc-bg-hover);
    color: var(--color-nc-text-bright);
    border-color: var(--color-nc-accent);
  }

  .btn.active {
    background: var(--color-nc-accent-dim);
    border-color: var(--color-nc-accent);
    color: #ffffff;
  }

  .modal-footer-sep {
    height: 8px;
  }
</style>
