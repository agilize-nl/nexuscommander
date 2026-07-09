<script lang="ts">
  import type { DialogType, FileEntry } from "$lib/types";
  import { formatSize } from "$lib/utils";
  import { fade, scale } from "svelte/transition";
  import { XCircle, Play, Triangle } from "lucide-svelte";
  import { _ } from "$lib/i18n";
  import { getSystemUser } from "$lib/ipc";

  interface Props {
    type: DialogType;
    inputValue?: string;
    entries?: FileEntry[];
    sourcePaths?: string[];
    targetDir?: string;
    sourceDir?: string;
    onconfirm: (value: string) => void;
    oncancel: () => void;
    fileOpOptions?: any;
    onsaveoptions?: (options: any) => void;
  }

  let props: Props = $props();

  const isArchiveSource = $derived(
    props.sourcePaths && props.sourcePaths.some(p => p.includes("::"))
  );

  let value = $state("");
  let inputEl: HTMLInputElement | undefined = $state(undefined);

  let systemUsername = $state("administrator");

  $effect(() => {
    if (props.type === "sudo_password") {
      getSystemUser()
        .then(data => {
          if (data && data.username) systemUsername = data.username;
        })
        .catch(console.error);
    }
  });

  // Dragging state
  let pos = $state({ x: 0, y: 0 });
  let dragging = $state(false);
  let dragStart = { x: 0, y: 0 };
  const dialogWidth = 500;
  const dialogHeight = 400; // Estimated max height

  $effect(() => {
    if (inputEl && props.type) {
      // Auto-focus input on open
      setTimeout(() => inputEl?.focus(), 50);
    }
  });

  $effect(() => {
    value = props.inputValue || "";
  });

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.oncancel();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      props.onconfirm(value);
      return;
    }
    // Stop all other keys from bubbling to the window
    e.stopPropagation();
  }

  function getTitle(): string {
    switch (props.type) {
      case "permission_denied":
        return $_('dialogs.permission_denied_title');
      case "sudo_password":
        return $_('dialogs.sudo_title');
      case "mkdir":
        return $_('menu.mkdir');
      case "rename":
        return $_('menu.move');
      case "delete":
        return $_('menu.delete');
      case "copy":
        return isArchiveSource ? ($_('dialogs.extract_title') || "Extract Files") : $_('menu.copy');
      case "move":
        return $_('menu.move');
      case "pack":
        return $_('menu.pack');
      case "unpack":
        return $_('menu.unpack');
      case "select_group":
        return $_('dialogs.select_group');
      case "unselect_group":
        return $_('dialogs.unselect_group');
      case "properties":
        return $_('dialogs.properties');
      case "split":
        return $_('menu.split_file');
      case "combine":
        return $_('menu.combine_files');
      default:
        return "";
    }
  }

  import FilePropertiesDialog from "./FilePropertiesDialog.svelte";


  let totalSize = $derived(
    (props.entries || []).reduce((sum, e) => sum + e.size, 0)
  );

  // ---------- Options Panel State ----------
  let showOptions = $state(false);
  let options = $derived(props.fileOpOptions || {
    when_file_exists: "Ask",
    when_dir_exists: "Ask",
    when_cannot_set_property: "Ask",
    exclude_empty_dirs: true,
    verify: false,
    check_free_space: true,
    reserve_space: true,
    follow_links: false,
    correct_links: false,
    copy_attributes: true,
    drop_readonly: false,
    copy_date_time: true,
    copy_ownership: false,
    copy_on_write: false,
  });

  function handleOptionChange(key: string, val: any) {
    if (props.fileOpOptions && props.onsaveoptions) {
      const newOptions = { ...props.fileOpOptions, [key]: val };
      props.onsaveoptions(newOptions);
    }
  }

  function toggleOptions() {
    showOptions = !showOptions;
  }

  // Dragging logic
  function startDrag(e: MouseEvent) {
    if ((e.target as HTMLElement).closest('.close-btn')) return;
    dragging = true;
    dragStart = { x: e.clientX - pos.x, y: e.clientY - dragStart.y };
  }

  function handleMouseMove(e: MouseEvent) {
    if (dragging) {
      let newX = e.clientX - dragStart.x;
      let newY = e.clientY - dragStart.y;

      // Boundary checks
      const dialogEl = document.querySelector('.dialog-box') as HTMLElement;
      const width = dialogEl?.offsetWidth || dialogWidth;
      const height = dialogEl?.offsetHeight || dialogHeight;

      const maxX = window.innerWidth - width;
      const maxY = window.innerHeight - height;

      pos.x = Math.max(0, Math.min(newX, maxX));
      pos.y = Math.max(0, Math.min(newY, maxY));
    }
  }

  function stopDrag() {
    dragging = false;
  }
</script>

<svelte:window onmousemove={handleMouseMove} onmouseup={stopDrag} />

{#if props.type}
  {#if props.type === "properties" && props.entries?.[0]}
    <FilePropertiesDialog 
      entry={props.entries[0]} 
      path={props.sourcePaths?.[0] || props.sourceDir || ""} 
      onclose={props.oncancel} 
    />
  {:else}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div 
      class="dialog-overlay" 
      onclick={props.oncancel} 
      onkeydown={handleKeydown}
      in:fade={{ duration: 150 }} 
      out:fade={{ duration: 100 }}
    >
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div 
        class="dialog-box" 
        onclick={(e) => e.stopPropagation()}
        in:scale={{ start: 0.95, duration: 150 }} 
        out:scale={{ start: 0.95, duration: 100 }}
        style="transform: translate({pos.x}px, {pos.y}px);"
      >
        <div class="dialog-header" onmousedown={startDrag}>
          <span class="dialog-title">{getTitle()}</span>
          <button class="close-btn" onclick={props.oncancel}>✕</button>
        </div>

        <div class="dialog-body">
        {#if props.type === "mkdir"}
          <div class="form-group">
            <label class="dialog-label" for="mkdir-input">{$_('dialogs.mkdir_prompt')}</label>
            <input
              id="mkdir-input"
              type="text"
              class="dialog-input"
              bind:value
              bind:this={inputEl}
              onkeydown={handleKeydown}
              placeholder="New folder"
              spellcheck="false"
            />
          </div>

        {:else if props.type === "rename"}
          <div class="form-group">
            <label class="dialog-label" for="rename-input">{$_('dialogs.rename_prompt')}</label>
            <input
              id="rename-input"
              type="text"
              class="dialog-input"
              bind:value
              bind:this={inputEl}
              onkeydown={handleKeydown}
              spellcheck="false"
            />
          </div>

        {:else if props.type === "delete"}
          <div class="confirm-msg">
            <p>{$_('dialogs.delete_confirm', { n: props.entries?.length || 0 })}</p>
            <div class="item-list">
              {#each (props.entries || []).slice(0, 5) as entry}
                <div class="item-line">
                  <span class="item-icon">{entry.is_dir ? "📁" : "📄"}</span>
                  <span class="item-name">{entry.name}</span>
                </div>
              {/each}
              {#if (props.entries || []).length > 5}
                <div class="item-more">...and {(props.entries || []).length - 5} more</div>
              {/if}
            </div>
          </div>
        {:else if props.type === "copy" || props.type === "move"}
          <div class="transfer-info">
            <p class="dlg-label">
              {#if props.type === "copy" && isArchiveSource}
                {$_("dialogs.extract_to", { n: props.entries?.length || 0 })}
              {:else}
                {$_(props.type === "copy" ? "dialogs.copy_to" : "dialogs.move_to", { n: props.entries?.length || 0 })}
              {/if}
            </p>
            <div class="path-input-wrapper">
              <input type="text" bind:value bind:this={inputEl} class="path-input" />
              <button class="path-history-btn">
                <Triangle size={10} style="transform: rotate(180deg)" fill="currentColor" />
              </button>
            </div>
            
            <div class="item-preview">
              {#each (props.entries || []).slice(0, 3) as entry}
                <div class="preview-line">
                  <span class="file-icon">{entry.is_dir ? "📁" : "📄"}</span>
                  <span class="file-name">{entry.name}</span>
                  <span class="file-size">{formatSize(entry.size)}</span>
                </div>
              {/each}
              {#if (props.entries || []).length > 3}
                <div class="preview-more">...and {(props.entries || []).length - 3} more</div>
              {/if}
            </div>

            <div class="total-stats">
              Total size: {formatSize(totalSize)}
            </div>
          </div>
        {:else if props.type === "pack"}
          <div class="form-group">
            <label class="dialog-label" for="pack-input">
              {$_('dialogs.pack_into', { n: props.entries?.length || 0 })}
            </label>
            <input
              id="pack-input"
              type="text"
              class="dialog-input"
              bind:value
              bind:this={inputEl}
              onkeydown={handleKeydown}
              spellcheck="false"
            />
            <p class="dialog-info">The files will be compressed into a ZIP archive.</p>
          </div>

        {:else if props.type === "unpack"}
          <div class="form-group">
            <label class="dialog-label" for="unpack-input">{$_('dialogs.unpack_to')}</label>
            <input
              id="unpack-input"
              type="text"
              class="dialog-input"
              bind:value
              bind:this={inputEl}
              onkeydown={handleKeydown}
              spellcheck="false"
            />
            <div class="entry-list-summary">
              {#each (props.entries || []).slice(0, 1) as entry}
                <div class="entry-item">
                  <span class="entry-icon">📦</span>
                  <span class="entry-name">{entry.name}</span>
                </div>
              {/each}
            </div>
          </div>

        {:else if props.type === "split"}
          <div class="form-group">
            <label class="dialog-label" for="split-size-input">{$_('dialogs.split_into')}</label>
            <div class="split-input-row">
              <input
                id="split-size-input"
                type="text"
                class="dialog-input"
                bind:value
                bind:this={inputEl}
                onkeydown={handleKeydown}
                spellcheck="false"
              />
              <span class="unit-label">Bytes</span>
            </div>
            <p class="dialog-info">Segments will be named with extension .001, .002, etc.</p>
            <div class="item-preview">
              {#each (props.entries || []).slice(0, 1) as entry}
                <div class="preview-line">
                  <span class="file-icon">📄</span>
                  <span class="file-name">{entry.name}</span>
                  <span class="file-size">{formatSize(entry.size)}</span>
                </div>
              {/each}
            </div>
          </div>

        {:else if props.type === "combine"}
          <div class="form-group">
            <label class="dialog-label" for="combine-target-input">{$_('dialogs.combine_into')}</label>
            <input
              id="combine-target-input"
              type="text"
              class="dialog-input"
              bind:value
              bind:this={inputEl}
              onkeydown={handleKeydown}
              spellcheck="false"
            />
            <div class="item-preview">
              <p class="dlg-label">Source files (will be combined in alphabetical order):</p>
              {#each (props.entries || []).slice(0, 5) as entry}
                <div class="preview-line">
                  <span class="file-icon">📄</span>
                  <span class="file-name">{entry.name}</span>
                  <span class="file-size">{formatSize(entry.size)}</span>
                </div>
              {/each}
              {#if (props.entries || []).length > 5}
                <div class="preview-more">...and {(props.entries || []).length - 5} more</div>
              {/if}
            </div>
          </div>

        {:else if props.type === "select_group" || props.type === "unselect_group"}
          <div class="form-group">
            <label class="dialog-label" for="select-group-input">{$_('dialogs.select_pattern')}</label>
            <input
              id="select-group-input"
              type="text"
              class="dialog-input"
              bind:value
              bind:this={inputEl}
              onkeydown={handleKeydown}
              spellcheck="false"
            />
          </div>
        {:else if props.type === "permission_denied"}
          <div class="permission-denied-container">
            <div class="shield-container">
              <svg width="56" height="56" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <defs>
                  <linearGradient id="shieldBorder" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stop-color="#d4af37" />
                    <stop offset="50%" stop-color="#8a5a16" />
                    <stop offset="100%" stop-color="#d4af37" />
                  </linearGradient>
                  <linearGradient id="yellowCheck" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stop-color="#ffd700" />
                    <stop offset="100%" stop-color="#e5a900" />
                  </linearGradient>
                  <linearGradient id="blackCheck" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stop-color="#444" />
                    <stop offset="100%" stop-color="#111" />
                  </linearGradient>
                  <clipPath id="shieldClip">
                    <path d="M12 2C6.5 2 3 5 3 10C3 15.5 7.5 20.5 12 22C16.5 20.5 21 15.5 21 10C21 5 17.5 2 12 2Z" />
                  </clipPath>
                </defs>
                <path d="M12 1.5C5 1.5 2 5 2 10.5C2 16.8 6.8 21.8 12 23.5C17.2 21.8 22 16.8 22 10.5C22 5 19 1.5 12 1.5Z" fill="url(#shieldBorder)" stroke="#5c3a0b" stroke-width="0.5" />
                <g clip-path="url(#shieldClip)">
                  <rect x="0" y="0" width="12" height="11" fill="url(#yellowCheck)" />
                  <rect x="12" y="0" width="12" height="11" fill="url(#blackCheck)" />
                  <rect x="0" y="11" width="12" height="12" fill="url(#blackCheck)" />
                  <rect x="12" y="11" width="12" height="12" fill="url(#yellowCheck)" />
                </g>
                <path d="M12 2V22" stroke="#5c3a0b" stroke-width="0.5" opacity="0.3" />
                <path d="M3 11H21" stroke="#5c3a0b" stroke-width="0.5" opacity="0.3" />
              </svg>
            </div>
            <div class="permission-info">
              <p>{$_('dialogs.elevate_message')}</p>
              <div class="elevate-path" title={props.inputValue}>{props.inputValue}</div>
            </div>
          </div>
        {:else if props.type === "sudo_password"}
          <div class="sudo-password-container">
            <div class="key-container">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--color-nc-accent)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
              </svg>
            </div>
            <div class="sudo-info">
              <p>{$_('dialogs.sudo_message')}</p>
              <p class="user-prompt">{$_('dialogs.sudo_password_for')} <strong>{systemUsername}</strong>:</p>
              <input
                id="sudo-password-input"
                type="password"
                class="dialog-input sudo-input"
                bind:value
                bind:this={inputEl}
                onkeydown={handleKeydown}
                placeholder={$_('dialogs.sudo_placeholder')}
                spellcheck="false"
              />
            </div>
          </div>
        {/if}

        {#if showOptions && (props.type === "copy" || props.type === "move")}
          <div class="options-panel" in:fade={{ duration: 150 }}>
            <div class="options-grid">
              <div class="options-col-left">
                <div class="option-row select-row">
                  <span class="label">When file exists</span>
                  <select 
                    value={options.when_file_exists} 
                    onchange={(e) => handleOptionChange('when_file_exists', (e.target as HTMLSelectElement).value)}
                  >
                    <option value="Ask">Ask</option>
                    <option value="Overwrite">Overwrite</option>
                    <option value="Skip">Skip</option>
                    <option value="Rename">Rename</option>
                  </select>
                </div>
                <div class="option-row select-row">
                  <span class="label">When directory exists</span>
                  <select 
                    value={options.when_dir_exists}
                    onchange={(e) => handleOptionChange('when_dir_exists', (e.target as HTMLSelectElement).value)}
                  >
                    <option value="Ask">Ask</option>
                    <option value="Overwrite">Overwrite</option>
                    <option value="Skip">Skip</option>
                  </select>
                </div>
              </div>

              <div class="options-col-right">
                <label class="checkbox-label">
                  <input 
                    type="checkbox" 
                    checked={options.verify} 
                    onchange={(e) => handleOptionChange('verify', (e.target as HTMLInputElement).checked)}
                  />
                  Verify
                </label>
                <label class="checkbox-label">
                  <input 
                    type="checkbox" 
                    checked={options.reserve_space} 
                    onchange={(e) => handleOptionChange('reserve_space', (e.target as HTMLInputElement).checked)}
                  />
                  Reserve space
                </label>
              </div>
            </div>
          </div>
        {/if}
      </div>

      {#if props.type !== "properties"}
        <div class="dialog-footer">
          {#if props.type === "copy" || props.type === "move"}
            <button class="btn btn-secondary" onclick={toggleOptions} class:active={showOptions}>{$_('dialogs.options')}</button>
            <div class="footer-spacer"></div>
            <button class="btn btn-secondary" onclick={props.oncancel}>
              <XCircle size={16} color="var(--color-nc-danger)" /> {$_('dialogs.cancel')}
            </button>
            <button class="btn btn-primary" onclick={() => props.onconfirm(value)}>
              <Play size={14} fill="currentColor" /> {props.type === "copy" && isArchiveSource ? ($_("dialogs.extract") || "Extract") : $_('dialogs.start')}
            </button>
          {:else if props.type === "permission_denied"}
            <div class="footer-spacer"></div>
            <button class="btn btn-secondary" onclick={props.oncancel}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
              {$_('dialogs.cancel')}
            </button>
            <button class="btn btn-primary" onclick={() => props.onconfirm("elevate")}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="9 10 4 15 9 20"></polyline>
                <path d="M20 4v7a4 4 0 0 1-4 4H4"></path>
              </svg>
              {$_('dialogs.ok')}
            </button>
          {:else if props.type === "sudo_password"}
            <div class="footer-spacer"></div>
            <button class="btn btn-secondary" onclick={props.oncancel}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
              {$_('dialogs.cancel')}
            </button>
            <button class="btn btn-primary" onclick={() => props.onconfirm(value)}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="9 10 4 15 9 20"></polyline>
                <path d="M20 4v7a4 4 0 0 1-4 4H4"></path>
              </svg>
              {$_('dialogs.authenticate')}
            </button>
          {:else}
            <div class="footer-spacer"></div>
            <button class="btn btn-secondary" onclick={props.oncancel}>
              {#if props.type === "delete"}<XCircle size={16} color="var(--color-nc-danger)" />{/if} {$_('dialogs.cancel')}
            </button>
            <button
              class="btn btn-primary"
              onclick={() => props.onconfirm(value)}
              class:btn-danger={props.type === "delete"}
            >
              {#if props.type === "delete"}
                <XCircle size={16} color="white" /> {$_('menu.delete')}
              {:else}
                <Play size={14} fill="currentColor" /> {$_('dialogs.ok')}
              {/if}
            </button>
          {/if}
        </div>
      {/if}
    </div>
  </div>
  {/if}
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
    min-width: 480px;
    max-width: 720px;
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
    cursor: move;
  }

  .dialog-title {
    font-weight: 600;
    font-size: 13px;
    color: var(--color-nc-text-bright);
    font-family: var(--font-family-sans);
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
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .dialog-label {
    font-size: 12px;
    color: var(--color-nc-text-dim);
  }

  .dialog-input, .path-input {
    width: 100%;
    padding: 8px 12px;
    background: var(--color-nc-bg-deep);
    border: 1px solid var(--color-nc-border-bright);
    color: var(--color-nc-text-bright);
    font-family: var(--font-family-mono);
    font-size: 12px;
    outline: none;
    border-radius: 4px;
  }

  .dialog-input:focus, .path-input:focus {
    border-color: var(--color-nc-accent);
    box-shadow: 0 0 0 2px var(--color-nc-accent-glow);
  }

  .path-input-wrapper {
    display: flex;
    gap: 4px;
    margin-top: 4px;
    margin-bottom: 12px;
  }

  .path-history-btn {
    padding: 0 8px;
    background: var(--color-nc-bg-header);
    border: 1px solid var(--color-nc-border-bright);
    color: var(--color-nc-text-dim);
    border-radius: 4px;
    cursor: pointer;
  }

  .path-history-btn:hover {
    color: var(--color-nc-text-bright);
    background: var(--color-nc-bg-hover);
  }

  .item-preview {
    background: var(--color-nc-bg-deep);
    border: 1px solid var(--color-nc-border);
    border-radius: 4px;
    padding: 4px;
    margin-bottom: 12px;
    max-height: 100px;
    overflow-y: auto;
  }

  .preview-line {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    padding: 4px 8px;
    border-radius: 2px;
  }

  .preview-line:hover {
    background: var(--color-nc-bg-hover);
  }

  .file-name {
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .file-size {
    color: var(--color-nc-text-dim);
  }

  .total-stats {
    font-size: 11px;
    color: var(--color-nc-text-dim);
    text-align: right;
  }

  .dialog-footer {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    background: var(--color-nc-bg-panel);
    border-top: 1px solid var(--color-nc-border);
  }

  .footer-spacer {
    flex: 1;
  }

  .btn {
    padding: 6px 16px;
    border: 1px solid var(--color-nc-border-bright);
    border-radius: 4px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 8px;
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

  .btn-danger {
    background: var(--color-nc-danger);
    border-color: #ff3333;
    color: white;
  }

  .btn-danger:hover {
    background: #ff3333;
    box-shadow: 0 0 10px rgba(255, 85, 85, 0.3);
  }

  .options-panel {
    margin-top: 16px;
    padding-top: 16px;
    border-top: 1px solid var(--color-nc-border);
  }

  .options-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
  }

  .option-row {
    margin-bottom: 8px;
  }

  .select-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .select-row select {
    background: var(--color-nc-bg-deep);
    color: var(--color-nc-text-bright);
    border: 1px solid var(--color-nc-border-bright);
    padding: 2px 4px;
    border-radius: 2px;
    font-size: 11px;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--color-nc-text);
    cursor: pointer;
    margin-bottom: 6px;
  }

  .confirm-msg p {
    margin-bottom: 12px;
    color: var(--color-nc-text-bright);
  }

  .item-list {
    background: var(--color-nc-bg-deep);
    border: 1px solid var(--color-nc-border);
    border-radius: 4px;
    padding: 8px;
    max-height: 150px;
    overflow-y: auto;
  }

  .item-line {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 4px;
    font-size: 12px;
  }

  .dialog-info {
    font-size: 11px;
    color: var(--color-nc-text-dim);
    font-style: italic;
  }

  .entry-list-summary {
    background: var(--color-nc-bg-deep);
    border: 1px solid var(--color-nc-border);
    border-radius: 4px;
    padding: 8px;
    margin-top: 8px;
  }

  .entry-item {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--color-nc-text-bright);
  }

  .split-input-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .unit-label {
    font-size: 11px;
    color: var(--color-nc-text-dim);
    font-weight: 500;
  }

  .permission-denied-container {
    display: flex;
    gap: 20px;
    align-items: flex-start;
    padding: 8px 0;
  }

  .shield-container {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 4px;
  }

  .permission-info {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 12px;
    font-size: 13px;
    color: var(--color-nc-text);
  }

  .permission-info p {
    margin: 0;
    line-height: 1.4;
  }

  .elevate-path {
    font-weight: 500;
    color: var(--color-nc-text-bright);
    word-break: break-all;
    background: var(--color-nc-bg-deep);
    border: 1px solid var(--color-nc-border);
    border-radius: 4px;
    padding: 6px 10px;
    font-family: var(--font-family-mono);
    font-size: 12px;
  }

  .sudo-password-container {
    display: flex;
    gap: 20px;
    align-items: flex-start;
    padding: 8px 0;
  }

  .key-container {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 4px;
    background: var(--color-nc-bg-deep);
    border: 1px solid var(--color-nc-border);
    border-radius: 8px;
    width: 56px;
    height: 56px;
  }

  .sudo-info {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 13px;
    color: var(--color-nc-text);
  }

  .sudo-info p {
    margin: 0;
    line-height: 1.4;
  }

  .sudo-info .user-prompt {
    font-weight: 500;
    color: var(--color-nc-text-bright);
    margin-top: 4px;
  }

  .sudo-input {
    margin-top: 4px;
  }
</style>
