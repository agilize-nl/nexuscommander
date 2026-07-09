<script lang="ts">
  import { onMount } from "svelte";
  import { fade, scale } from "svelte/transition";
  import { getBookmarks, saveBookmarks, type Bookmark } from "$lib/ipc";
  import { activePanel, leftPanelPath, rightPanelPath } from "$lib/stores";
  import { _ } from "$lib/i18n";

  const { onclose } = $props<{ onclose?: () => void }>();

  let bookmarks = $state<Bookmark[]>([]);
  let newName = $state("");
  let inputEl = $state<HTMLInputElement>();

  onMount(async () => {
    bookmarks = await getBookmarks();
    inputEl?.focus();
  });

  async function handleAdd() {
    let cp = "";
    let rp = "";
    let ap: "left" | "right" = "left";
    
    const unsub1 = leftPanelPath.subscribe(v => cp = v);
    const unsub2 = rightPanelPath.subscribe(v => rp = v);
    const unsub3 = activePanel.subscribe(v => ap = v);
    unsub1(); unsub2(); unsub3();

    const currentPath = ap === "left" ? cp : rp;
    const name = newName.trim() || currentPath.split("/").pop() || currentPath;
    
    // Check if already exists
    if (!bookmarks.some(b => b.path === currentPath)) {
      const newBm = { name, path: currentPath };
      bookmarks = [...bookmarks, newBm];
      await saveBookmarks(bookmarks);
    }
    newName = "";
    inputEl?.focus();
  }

  async function handleRemove(index: number) {
    bookmarks = bookmarks.filter((_, i) => i !== index);
    await saveBookmarks(bookmarks);
  }

  function handleJump(path: string) {
    let ap: "left" | "right" = "left";
    const unsub3 = activePanel.subscribe(v => ap = v);
    unsub3();

    if (ap === "left") {
      leftPanelPath.set(path);
    } else {
      rightPanelPath.set(path);
    }
    close();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
      return;
    }
    e.stopPropagation();
  }

  function close() {
    onclose?.();
  }
</script>



<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="modal-backdrop" onclick={close} onkeydown={handleKeydown} in:fade={{ duration: 150 }} out:fade={{ duration: 100 }} role="presentation">
  <div class="modal" onclick={(e) => e.stopPropagation()} in:scale={{ start: 0.95, duration: 150 }} out:scale={{ start: 0.95, duration: 100 }}>
    <header class="modal-header">
      <div class="title">{$_('hotlist.title')}</div>
      <button class="close-btn" onclick={close}>✕</button>
    </header>

    <div class="content">
      <form class="add-bar" onsubmit={(e) => { e.preventDefault(); handleAdd(); }}>
        <input 
          bind:this={inputEl}
          type="text" 
          bind:value={newName} 
          placeholder={$_('hotlist.path')} 
        />
        <button type="submit" class="add-btn">{$_('hotlist.add_current')}</button>
      </form>

      <div class="list-container">
        {#if bookmarks.length === 0}
          <div class="empty-state">{$_('common.coming_soon')}</div>
        {:else}
          {#each bookmarks as bm, i}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="list-item" onclick={() => handleJump(bm.path)}>
              <span class="bm-icon">★</span>
              <div class="bm-info">
                <span class="bm-name">{bm.name}</span>
                <span class="bm-path">{bm.path}</span>
              </div>
              <button class="remove-btn" onclick={(e) => { e.stopPropagation(); handleRemove(i); }} title={$_('hotlist.remove')}>✕</button>
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

  .add-bar {
    display: flex;
    gap: 8px;
  }

  input {
    flex: 1;
    background: var(--color-nc-bg-deep);
    border: 1px solid var(--color-nc-border);
    color: var(--color-nc-text-bright);
    padding: 8px 12px;
    border-radius: 4px;
    font-family: var(--font-family-mono);
    font-size: 13px;
    outline: none;
  }

  input:focus {
    border-color: var(--color-nc-accent);
    box-shadow: 0 0 0 2px var(--color-nc-accent-glow);
  }

  .add-btn {
    background: var(--color-nc-accent-dim);
    color: var(--color-nc-text-bright);
    border: 1px solid var(--color-nc-accent);
    padding: 0 16px;
    border-radius: 4px;
    font-family: var(--font-family-sans);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
  }

  .add-btn:hover {
    background: var(--color-nc-accent);
  }

  .list-container {
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
    transition: background 0.1s;
  }

  .list-item:hover {
    background: var(--color-nc-bg-hover);
  }

  .bm-icon {
    color: var(--color-nc-warning);
    font-size: 16px;
  }

  .bm-info {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .bm-name {
    font-weight: 600;
    color: var(--color-nc-text-bright);
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .bm-path {
    font-size: 11px;
    color: var(--color-nc-text-dim);
    font-family: var(--font-family-mono);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .remove-btn {
    opacity: 1;
    background: rgba(255, 85, 85, 0.2);
    color: var(--color-nc-danger);
    border: 1px solid rgba(255, 85, 85, 0.3);
    width: 24px;
    height: 24px;
    border-radius: 4px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.1s;
  }

  @media (hover: hover) and (pointer: fine) {
    .remove-btn {
      opacity: 0;
    }

    .list-item:hover .remove-btn {
      opacity: 1;
    }
  }

  .remove-btn:hover {
    background: var(--color-nc-danger);
    color: white;
  }
</style>
