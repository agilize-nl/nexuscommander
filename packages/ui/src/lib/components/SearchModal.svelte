<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { fade, scale } from "svelte/transition";
  import { searchFiles, searchCancel, searchListen, hasCapability, type SearchResult } from "../ipc";
  import { activePanel, leftPanelPath, rightPanelPath } from "../stores";
  import { _ } from "../i18n";

  const { onclose } = $props<{ onclose?: () => void }>();

  let pathQuery = $state("");
  let contentQuery = $state("");
  let startDir = $state("");
  let useRegex = $state(false);

  let results = $state<SearchResult[]>([]);
  let searching = $state(false);
  let unlisten: (() => void) | null = null;
  let currentJobId: string | null = null;
  let inputEl = $state<HTMLInputElement>();

  onMount(async () => {
    let ap: "left" | "right" = "left";
    const unsub = activePanel.subscribe(v => ap = v);
    unsub();
    let cp = "";
    const unsub2 = (ap === "left" ? leftPanelPath : rightPanelPath).subscribe(v => cp = v);
    unsub2();
    startDir = cp;

    inputEl?.focus();
  });

  async function stopCurrentSearch() {
    unlisten?.();
    unlisten = null;
    if (currentJobId) {
      const jobId = currentJobId;
      currentJobId = null;
      // Only the streaming (desktop) backend has a cancellable job.
      if (hasCapability("searchCancel")) {
        await searchCancel(jobId).catch(() => {});
      }
    }
  }

  onDestroy(() => {
    void stopCurrentSearch();
  });

  async function handleSearch() {
    if (!pathQuery.trim()) return;
    // Cancel any previous still-running search before starting a new one so
    // closing/re-searching never leaves an orphaned background job.
    await stopCurrentSearch();

    results = [];
    searching = true;

    let resp: string | SearchResult[];
    try {
      resp = await searchFiles({
        query: pathQuery.trim(),
        start_dir: startDir,
        use_regex: useRegex,
        content_query: contentQuery.trim() || null,
      });
    } catch (e) {
      searching = false;
      return;
    }

    if (typeof resp === "string") {
      // Streaming backend (desktop): jobId + incremental events via searchListen.
      currentJobId = resp;
      if (hasCapability("searchListen")) {
        unlisten = await searchListen(
          resp,
          (r) => { results = [...results, r]; },
          () => { searching = false; },
        );
      } else {
        searching = false;
      }
    } else {
      // Request/response backend (web): the full result set is returned at once.
      results = resp;
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
          extension: r.name.includes(".") ? r.name.split(".").pop() || "" : "",
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
      <div class="title">{$_("search.title")}</div>
      <button class="close-btn" onclick={close}>✕</button>
    </header>

    <div class="content">
      <form class="search-form" onsubmit={(e) => { e.preventDefault(); handleSearch(); }}>
        <div class="field">
          <label for="searchfor">{$_("search.label_query")}</label>
          <input
            id="searchfor"
            bind:this={inputEl}
            type="text"
            bind:value={pathQuery}
            placeholder={$_("search.placeholder_query")}
          />
        </div>

        <div class="field">
          <label for="startdir">{$_("search.label_start")}</label>
          <input
            id="startdir"
            type="text"
            bind:value={startDir}
          />
        </div>

        <div class="field">
          <label for="findtext">{$_("search.label_content")}</label>
          <input
            id="findtext"
            type="text"
            bind:value={contentQuery}
            placeholder={$_("search.placeholder_content")}
          />
        </div>

        <div class="options">
          <label class="checkbox">
            <input type="checkbox" bind:checked={useRegex} />
            {$_("search.regex")}
          </label>
        </div>

        <div class="actions">
          <button type="submit" class="primary-btn" disabled={searching || !pathQuery.trim()}>
            {searching ? $_("search.searching") : $_("search.start_btn")}
          </button>
        </div>
      </form>

      {#if results.length > 0}
        <div class="results-actions">
          <button class="feed-btn" onclick={handleFeedToListbox}>
            {$_("search.feed_to_listbox")}
          </button>
        </div>
      {/if}

      <div class="results-container">
        {#if results.length === 0}
          <div class="empty-state">
            {searching ? $_("search.searching") : $_("search.no_results")}
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
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .modal {
    width: 500px;
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
    background: linear-gradient(180deg, var(--color-nc-bg-header) 0%, var(--color-nc-bg-panel) 100%);
    padding: 8px 12px;
    border-bottom: 1px solid var(--color-nc-border);
    flex-shrink: 0;
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
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    padding: 12px;
    gap: 12px;
    min-height: 0;
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
    flex-shrink: 0;
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

  .results-actions {
    display: flex;
    justify-content: flex-end;
  }

  .feed-btn {
    background: transparent;
    color: var(--color-nc-accent);
    border: 1px solid var(--color-nc-accent);
    padding: 4px 10px;
    border-radius: 4px;
    font-family: var(--font-family-sans);
    font-size: 12px;
    cursor: pointer;
  }

  .feed-btn:hover {
    background: var(--color-nc-accent-dim);
  }

  /* Results */
  .results-container {
    background: var(--color-nc-bg-deep);
    border: 1px solid var(--color-nc-border);
    border-radius: 4px;
    flex: 1;
    min-height: 150px;
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
