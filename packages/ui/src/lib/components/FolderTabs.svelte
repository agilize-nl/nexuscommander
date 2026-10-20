<script lang="ts">
  import { X as CloseIcon } from "lucide-svelte";
  import { Lock as LockIcon } from "lucide-svelte";
  import ContextMenu from "@nexus/ui/components/ContextMenu.svelte";
  import { _ } from "../i18n";
  import { isCoarsePointer } from "../utils/touch";
  import type { MenuItem } from "../types";

  export interface Tab {
    id: string;
    path: string;
    label: string;
    customLabel?: string;
    locked?: boolean;
  }

  interface Props {
    tabs: Tab[];
    activeTabId: string;
    onselect: (id: string) => void;
    onclose: (id: string) => void;
    onnew: () => void;
    onreorder?: (from: number, to: number) => void;
    onduplicate?: (id: string) => void;
    onrename?: (id: string, newName: string) => void;
    onlock?: (id: string, locked: boolean) => void;
    oncloseothers?: (id: string) => void;
  }

  let { 
    tabs, 
    activeTabId, 
    onselect, 
    onclose, 
    onnew,
    onreorder,
    onduplicate,
    onrename,
    onlock,
    oncloseothers
  }: Props = $props();

  function scrollIntoView(node: HTMLElement, active: boolean) {
    if (active) {
      node.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }
  }

  // --- Drag & Drop ---
  let draggedIdx = $state<number | null>(null);
  let dragOverIdx = $state<number | null>(null);

  function handleDragStart(e: DragEvent, index: number) {
    draggedIdx = index;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", index.toString());
    }
  }

  function handleDragOver(e: DragEvent, index: number) {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "move";
    }
    dragOverIdx = index;
  }

  function handleDrop(e: DragEvent, index: number) {
    e.preventDefault();
    dragOverIdx = null;
    if (draggedIdx !== null && draggedIdx !== index && onreorder) {
      onreorder(draggedIdx, index);
    }
    draggedIdx = null;
  }

  // --- Context Menu ---
  let menuVisible = $state(false);
  let menuX = $state(0);
  let menuY = $state(0);
  let menuOptions = $state<MenuItem[]>([]);
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let longPressStart: { x: number; y: number } | null = null;
  let suppressNextClick = false;

  function moveTab(tab: Tab, delta: -1 | 1) {
    const from = tabs.findIndex(t => t.id === tab.id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= tabs.length) return;
    onreorder?.(from, to);
  }

  function showContextMenu(e: MouseEvent | PointerEvent, tab: Tab) {
    e.preventDefault();
    e.stopPropagation();

    const tabIndex = tabs.findIndex(t => t.id === tab.id);
    const options: MenuItem[] = [
      { label: $_('folder_tabs.new_tab'), action: () => onnew() },
      { label: $_('folder_tabs.duplicate_tab'), action: () => onduplicate?.(tab.id) },
      { label: $_('folder_tabs.rename_tab'), action: () => triggerRename(tab) },
      { label: tab.locked ? $_('folder_tabs.unlock_tab') : $_('folder_tabs.lock_tab'), action: () => onlock?.(tab.id, !tab.locked) }
    ];

    if (onreorder && tabs.length > 1) {
      options.push({ isSeparator: true });
      if (tabIndex > 0) options.push({ label: $_('folder_tabs.move_left'), action: () => moveTab(tab, -1) });
      if (tabIndex >= 0 && tabIndex < tabs.length - 1) options.push({ label: $_('folder_tabs.move_right'), action: () => moveTab(tab, 1) });
    }

    options.push(
      { isSeparator: true },
      { label: $_('folder_tabs.close_tab'), action: () => { if (!tab.locked) onclose(tab.id); } },
      { label: $_('folder_tabs.close_others'), action: () => oncloseothers?.(tab.id) }
    );
    menuOptions = options;

    menuX = e.clientX;
    menuY = e.clientY;
    menuVisible = true;
  }

  function clearLongPressTimer() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    longPressStart = null;
  }

  function handleLongPressStart(e: PointerEvent, tab: Tab) {
    if (!isCoarsePointer(e) || e.button !== 0) return;
    clearLongPressTimer();
    longPressStart = { x: e.clientX, y: e.clientY };
    longPressTimer = setTimeout(() => {
      suppressNextClick = true;
      showContextMenu(e, tab);
    }, 560);
  }

  function handleLongPressMove(e: PointerEvent) {
    if (!longPressStart) return;
    const dx = Math.abs(e.clientX - longPressStart.x);
    const dy = Math.abs(e.clientY - longPressStart.y);
    if (dx > 10 || dy > 10) clearLongPressTimer();
  }

  function handleLongPressEnd() {
    clearLongPressTimer();
    if (suppressNextClick) {
      setTimeout(() => {
        suppressNextClick = false;
      }, 0);
    }
  }

  function triggerRename(tab: Tab) {
    const newName = prompt($_('folder_tabs.rename_prompt'), tab.customLabel || tab.label);
    if (newName !== null && onrename) {
      onrename(tab.id, newName.trim());
    }
  }
</script>

<div class="folder-tabs">
  <div class="tabs-container">
    {#each tabs as tab, i (tab.id)}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div 
        class="tab" 
        class:active={tab.id === activeTabId}
        class:locked={tab.locked}
        class:drag-over={dragOverIdx === i}
        draggable="true"
        onclick={(e) => {
          if (suppressNextClick) {
            e.preventDefault();
            e.stopPropagation();
            suppressNextClick = false;
            return;
          }
          onselect(tab.id);
        }}
        ondblclick={() => triggerRename(tab)}
        oncontextmenu={(e) => {
          if (isCoarsePointer()) {
            e.preventDefault();
            return;
          }
          showContextMenu(e, tab);
        }}
        onpointerdown={(e) => handleLongPressStart(e, tab)}
        onpointermove={handleLongPressMove}
        onpointerup={handleLongPressEnd}
        onpointercancel={handleLongPressEnd}
        ondragstart={(e) => handleDragStart(e, i)}
        ondragover={(e) => handleDragOver(e, i)}
        ondragleave={() => dragOverIdx = null}
        ondrop={(e) => handleDrop(e, i)}
        use:scrollIntoView={tab.id === activeTabId}
      >
        {#if tab.locked}
          <div class="lock-icon" title={$_('folder_tabs.locked')}><LockIcon size={10} /></div>
        {/if}
        <span class="tab-label" class:custom-label={!!tab.customLabel} title={tab.path}>
          {tab.customLabel || tab.label}
        </span>
        {#if tabs.length > 1 && !tab.locked}
          <button 
            class="close-btn" 
            onclick={(e) => { e.stopPropagation(); onclose(tab.id); }}
            title={$_('folder_tabs.close_tab')}
            aria-label={$_('folder_tabs.close_tab')}
          >
            <CloseIcon size={12} />
          </button>
        {/if}
      </div>
    {/each}
    <button class="new-tab-btn" onclick={onnew} title={$_('folder_tabs.new_tab')}>+</button>
  </div>
</div>

{#if menuVisible}
  <ContextMenu
    options={menuOptions}
    x={menuX}
    y={menuY}
    onclose={() => (menuVisible = false)}
  />
{/if}

<style>
  .folder-tabs {
    display: flex;
    background: var(--color-nc-bg-deep);
    border-bottom: 1px solid var(--color-nc-border);
    padding: 2px 2px 0 2px;
    height: 28px;
    overflow: hidden;
  }

  .tabs-container {
    display: flex;
    gap: 1px;
    overflow-x: auto;
    scrollbar-width: none; 
  }

  .tabs-container::-webkit-scrollbar {
    display: none;
  }

  .tab {
    display: flex;
    align-items: center;
    background: var(--color-nc-bg-alt);
    border: 1px solid var(--color-nc-border);
    border-bottom: 1px solid var(--color-nc-border);
    border-radius: 4px 4px 0 0;
    padding: 0 8px;
    height: 25px;
    min-width: 80px;
    max-width: 180px;
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.15s ease;
    position: relative;
    font-family: var(--font-tab-name);
    font-size: var(--font-tab-size);
    color: var(--color-nc-text);
    user-select: none;
  }

  .tab:hover {
    background: var(--color-nc-bg-hover);
    color: var(--color-nc-text-bright);
    border-bottom-color: var(--color-nc-border);
  }

  .tab.active {
    background: var(--color-nc-bg-panel);
    color: var(--color-nc-text-bright);
    border-top: 2px solid var(--color-nc-accent);
    border-bottom: 1px solid var(--color-nc-bg-panel); /* Bridge the container border */
    margin-bottom: -1px;
    padding-top: 0;
    z-index: 2;
    font-weight: 600;
  }



  .drag-over {
    border-left: 2px solid var(--color-nc-accent);
  }

  .tab-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    user-select: none;
  }

  .custom-label {
    font-style: italic;
    color: var(--color-nc-accent-bright, #66b2ff);
  }

  .lock-icon {
    display: flex;
    align-items: center;
    margin-right: 4px;
    color: var(--color-nc-warning, #f39c12);
    opacity: 0.8;
  }

  .close-btn {
    background: none;
    border: none;
    color: var(--color-nc-text);
    margin-left: 6px;
    padding: 2px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 2px;
    opacity: 0.6;
    cursor: pointer;
  }

  .close-btn:hover {
    background: rgba(255, 255, 255, 0.1);
    color: var(--color-nc-danger);
    opacity: 1;
  }

  .new-tab-btn {
    background: none;
    border: none;
    color: var(--color-nc-text);
    font-size: 16px;
    font-weight: bold;
    padding: 0 8px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .new-tab-btn:hover {
    color: var(--color-nc-text-bright);
  }
</style>
