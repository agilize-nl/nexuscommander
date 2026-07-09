<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { fade, scale } from "svelte/transition";
  import { searchFiles, type SearchResult } from "$lib/ipc";
  import { activePanel, leftPanelPath, rightPanelPath } from "$lib/stores";
  import { _ } from "$lib/i18n";

  const { onclose } = $props<{ onclose?: () => void }>();

  let pathQuery = $state("");
  let contentQuery = $state("");
  let startDir = $state("");
  let useRegex = $state(false);

  let results = $state<SearchResult[]>([]);
  let searching = $state(false);
  let inputEl = $state<HTMLInputElement>();
  onMount(() => {
    let ap: "left" | "right" = "left";
    const unsub = activePanel.subscribe(v => ap = v);
    unsub();
    let cp = "";
    const unsub2 = (ap === "left" ? leftPanelPath : rightPanelPath).subscribe(v => cp = v);
    unsub2();
    startDir = cp;

    inputEl?.focus();
  });

  onDestroy(() => {
  });

  async function handleSearch() {
    if (!pathQuery.trim()) return;
    results = [];
    searching = true;
    try {
      const resp = await searchFiles({
        query: pathQuery.trim(),
        start_dir: startDir,
        use_regex: useRegex,
        content_query: contentQuery.trim() || null,
      });
      results = resp;
    } finally {
      searching = false;
    }
  }

  function handleJump(path: string) {
    let ap: "left" | "right" = "left";
    const unsub = activePanel.subscribe(v => ap = v);
    unsub();
    // Navigate the panel to the directory containing the file
    const parentDir = path.substring(0, path.lastIndexOf("/")) || "/";
    if (ap === "left") {
      leftPanelPath.set(parentDir);
    } else {
      rightPanelPath.set(parentDir);
    }
    close();
  }

  function handleFeedToListbox() {
    let ap: "left" | "right" = "left";
    const unsub = activePanel.subscribe(v => ap = v);
    unsub();

    const targetSide = ap === "left" ? "right" : "left";
    window.dispatchEvent(new CustomEvent("nc:feed-to-listbox", {
      detail: {
        side: targetSide,
        results: results.map(r => ({
          name: r.name,
          path: r.path,
          is_dir: r.is_dir,
          size: r.size,
          modified: r.modified,
          is_symlink: false,
          extension: r.name.includes('.') ? r.name.split('.').pop() || '' : '',
          permissions: "",
          owner: "",
          group: ""
        })),
        query: pathQuery
      }
    }));
    close();
  }

  function close() {
    onclose?.();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
      return;
    }
    e.stopPropagation();
  }
</script>



<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="modal-backdrop" onclick={close} onkeydown={handleKeydown} in:fade={{ duration: 150 }} out:fade={{ duration: 100 }} role="presentation">
  <div class="modal" onclick={(e) => e.stopPropagation()} in:scale={{ start: 0.95, duration: 150 }} out:scale={{ start: 0.95, duration: 100 }}>
    <header class="modal-header">
      <div class="title">{$_('search.title')}</div>
      <button class="close-btn" onclick={close}>✕</button>
    </header>

    <div class="content">
      <form class="search-form" onsubmit={(e) => { e.preventDefault(); handleSearch(); }}>
        <div class="field">
          <label for="searchfor">{$_('search.search_for')}</label>
          <input 
            id="searchfor"
            bind:this={inputEl}
            type="text" 
            bind:value={pathQuery} 
            placeholder={$_('search.placeholder_pattern')} 
          />
        </div>

        <div class="field">
          <label for="startdir">{$_('search.start_from')}</label>
          <input 
            id="startdir"
            type="text" 
            bind:value={startDir} 
          />
        </div>

        <div class="field">
          <label for="findtext">{$_('search.find_text')}</label>
          <input 
            id="findtext"
            type="text" 
            bind:value={contentQuery}
            placeholder={$_('search.placeholder_content')} 
          />
        </div>

        <div class="options">
          <label class="checkbox">
            <input type="checkbox" bind:checked={useRegex} />
            {$_('search.regex')}
          </label>
        </div>

        <div class="actions">
          <button type="submit" class="primary-btn" disabled={searching || !pathQuery.trim()}>
            {searching ? $_('search.searching') : $_('search.start_search')}
          </button>
          {#if results.length > 0 && !searching}
            <button class="secondary-btn" onclick={handleFeedToListbox}>
              {$_('search.feed_to_listbox')}
            </button>
          {/if}
        </div>
      </form>

      <div class="results-container">
        {#if results.length === 0}
          <div class="empty-state">
            {searching ? $_('search.searching') : $_('search.no_results')}
          </div>
        {:else}
          {#each results as res}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="list-item" onclick={() => handleJump(res.path)}>
              <span class="res-icon" class:dir={res.is_dir}>
                {res.is_dir ? "📁" : "📄"}
              </span>
              <div class="res-info">
                <span class="res-name">{res.name}</span>
                <span class="res-path">{res.path}</span>
              </div>
            </div>
          {/each}
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: transparent;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .modal {
    width: 600px;
    max-width: 90vw;
    background: var(--color-nc-bg-panel);
    border: 1px solid var(--color-nc-border-bright);
    border-radius: 8px;
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.05);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 16px;
    background: var(--color-nc-bg-header);
    border-bottom: 1px solid var(--color-nc-border);
  }

  .title {
    font-size: 14px;
    font-weight: 600;
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

  .content {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .search-form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .field {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .field label {
    width: 160px;
    text-align: right;
    font-size: 13px;
    color: var(--color-nc-text);
    font-family: var(--font-family-sans);
  }

  .field input[type="text"] {
    flex: 1;
    background: var(--color-nc-bg-deep);
    border: 1px solid var(--color-nc-border);
    color: var(--color-nc-text-bright);
    padding: 6px 10px;
    border-radius: 4px;
    font-family: var(--font-family-mono);
    font-size: 13px;
    outline: none;
  }

  .field input[type="text"]:focus {
    border-color: var(--color-nc-accent);
    box-shadow: 0 0 0 2px var(--color-nc-accent-glow);
  }

  .options {
    margin-left: 172px; /* aligns with inputs */
    display: flex;
    gap: 16px;
  }

  .checkbox {
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-family-sans);
    font-size: 13px;
    color: var(--color-nc-text);
    cursor: pointer;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 4px;
    gap: 8px;
  }

  .primary-btn {
    background: var(--color-nc-accent-dim);
    color: var(--color-nc-text-bright);
    border: 1px solid var(--color-nc-accent);
    padding: 6px 16px;
    border-radius: 4px;
    font-family: var(--font-family-sans);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
  }

  .primary-btn:hover:not(:disabled) {
    background: var(--color-nc-accent);
  }

  .primary-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .secondary-btn {
    background: var(--color-nc-bg-header);
    color: var(--color-nc-text);
    border: 1px solid var(--color-nc-border-bright);
    padding: 6px 16px;
    border-radius: 4px;
    font-family: var(--font-family-sans);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }

  .secondary-btn:hover {
    background: var(--color-nc-bg-hover);
    border-color: var(--color-nc-accent);
    color: var(--color-nc-text-bright);
  }

  /* Results */
  .results-container {
    background: var(--color-nc-bg-deep);
    border: 1px solid var(--color-nc-border);
    border-radius: 4px;
    height: 300px;
    overflow-y: auto;
  }

  .empty-state {
    padding: 32px;
    text-align: center;
    color: var(--color-nc-text-dim);
    font-family: var(--font-family-sans);
    font-style: italic;
  }

  .list-item {
    display: flex;
    align-items: center;
    padding: 8px 12px;
    gap: 12px;
    border-bottom: 1px solid var(--color-nc-border);
    cursor: pointer;
  }

  .list-item:hover {
    background: var(--color-nc-bg-hover);
  }

  .res-icon {
    font-size: 14px;
  }

  .res-info {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .res-name {
    font-weight: 600;
    color: var(--color-nc-text-bright);
    font-size: 13px;
  }

  .res-path {
    font-size: 11px;
    color: var(--color-nc-text-dim);
    font-family: var(--font-family-mono);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
