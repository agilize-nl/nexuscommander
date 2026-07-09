<script lang="ts">
  import { onMount, tick } from "svelte";
  import { convertFileSrc } from "$lib/ipc";
  import type { MenuItem } from "../types";
  import ContextMenu from "./ContextMenu.svelte";

  let props = $props<{
    options: MenuItem[];
    x: number;
    y: number;
    onclose: () => void;
    isSubmenu?: boolean;
  }>();


  let menuElement: HTMLElement | null = $state(null);
  let hoveredIndex = $state(-1);
  let submenuVisible = $state(false);
  let submenuX = $state(0);
  let submenuY = $state(0);
  let activeSubmenu: MenuItem[] | undefined = $state(undefined);

  // Ensure menu stays within viewport
  let adjustedX = $state(0);
  let adjustedY = $state(0);

  $effect(() => {
    adjustedX = props.x;
    adjustedY = props.y;

    if (menuElement) {
      const rect = menuElement.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      if (props.x + rect.width > viewportWidth) {
        adjustedX = props.isSubmenu ? props.x - rect.width : viewportWidth - rect.width - 5;
      }
      if (props.y + rect.height > viewportHeight) {
        adjustedY = viewportHeight - rect.height - 5;
      }
    }
  });

  function handleAction(option: MenuItem) {
    if (option.items && option.items.length > 0) return;
    if (option.action) {
      option.action();
      props.onclose();
    }
  }

  async function handleMouseEnter(index: number, e: MouseEvent) {
    hoveredIndex = index;
    const option = props.options[index];
    
    if (option.items && option.items.length > 0) {
      activeSubmenu = option.items;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      submenuX = rect.right;
      submenuY = rect.top;
      submenuVisible = true;
    } else {
      submenuVisible = false;
      activeSubmenu = undefined;
    }
  }

  function toggleSubmenu(index: number, e: MouseEvent) {
    const option = props.options[index];
    if (!option.items || option.items.length === 0) {
      handleAction(option);
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    if (hoveredIndex === index && submenuVisible) {
      submenuVisible = false;
      activeSubmenu = undefined;
      return;
    }

    hoveredIndex = index;
    activeSubmenu = option.items;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    submenuX = rect.right;
    submenuY = rect.top;
    submenuVisible = true;
  }

  function renderLabel(label: string, mnemonicIndex?: number) {
    if (mnemonicIndex === undefined || mnemonicIndex < 0 || mnemonicIndex >= label.length) {
      return label;
    }
    return [
      label.slice(0, mnemonicIndex),
      `<span class="mnemonic">${label[mnemonicIndex]}</span>`,
      label.slice(mnemonicIndex + 1)
    ].join("");
  }
</script>

<svelte:window 
  onclick={props.isSubmenu ? undefined : props.onclose} 
  oncontextmenu={props.isSubmenu ? undefined : props.onclose} 
  onkeydown={(e) => { if (e.key === 'Escape') props.onclose(); }} 
/>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  bind:this={menuElement}
  class="context-menu"
  class:is-submenu={props.isSubmenu}
  style="left: {adjustedX}px; top: {adjustedY}px;"
  onclick={(e) => e.stopPropagation()}
>
  {#each props.options as option, i}
    {#if option.isSeparator}
      <div class="separator"></div>
    {:else}
      <button 
        class="menu-item" 
        class:active={hoveredIndex === i}
        onmouseenter={(e) => handleMouseEnter(i, e)}
        onclick={(e) => toggleSubmenu(i, e)}
      >
        {#if option.iconPath && option.iconPath.startsWith('/')}
          <img 
            class="menu-icon" 
            src={convertFileSrc(option.iconPath)} 
            alt="" 
            onerror={(e) => (e.currentTarget as HTMLImageElement).style.display = 'none'}
          />
        {/if}
        <span class="label">{@html renderLabel(option.label, option.mnemonicIndex)}</span>
        {#if option.checked !== undefined && option.onToggle}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div 
            class="always-toggle-wrapper" 
            class:is-radio={option.radio}
            onclick={(e) => { e.stopPropagation(); option.onToggle?.(!option.checked); }}
          >
            {#if option.radio}
              <div class="radio-outer">
                {#if option.checked}<div class="radio-inner"></div>{/if}
              </div>
            {:else}
              <input type="checkbox" checked={option.checked} readonly />
            {/if}
            <span class="always-text">Always</span>
          </div>
        {/if}
        {#if option.items && option.items.length > 0}
          <span class="arrow">▶</span>
        {:else if option.shortcut}
          <span class="shortcut">{option.shortcut}</span>
        {/if}
      </button>
    {/if}
  {/each}
</div>

{#if submenuVisible && activeSubmenu}
  <ContextMenu 
    options={activeSubmenu} 
    x={submenuX} 
    y={submenuY} 
    onclose={props.onclose} 
    isSubmenu={true}
  />
{/if}

<style>
  .context-menu {
    position: fixed;
    background: rgba(30, 30, 30, 0.95);
    backdrop-filter: var(--nc-overlay-blur, blur(12px) saturate(180%));
    -webkit-backdrop-filter: var(--nc-overlay-blur, blur(12px) saturate(180%));
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6);
    padding: 6px;
    min-width: 220px;
    z-index: 10000;
    display: flex;
    flex-direction: column;
    animation: menuFadeIn 0.12s ease-out;
  }

  @keyframes menuFadeIn {
    from { opacity: 0; transform: scale(0.98) translateY(-4px); }
    to { opacity: 1; transform: scale(1) translateY(0); }
  }
  
  .menu-icon {
    width: 16px;
    height: 16px;
    margin-right: 8px;
    flex-shrink: 0;
    object-fit: contain;
  }

  .menu-item {
    background: transparent;
    border: none;
    color: #eee;
    padding: 7px 12px;
    text-align: left;
    display: flex;
    justify-content: space-between;
    align-items: center;
    cursor: pointer;
    border-radius: 5px;
    font-size: 13.5px;
    transition: background 0.1s, color 0.1s;
    width: 100%;
    position: relative;
    user-select: none;
  }

  .menu-item:hover, .menu-item.active {
    background: #0066cc;
    color: white;
  }

  .separator {
    height: 1px;
    background: rgba(255, 255, 255, 0.1);
    margin: 6px 4px;
  }

  .shortcut {
    font-size: 11px;
    color: #999;
    margin-left: 16px;
    font-weight: 500;
  }

  .menu-item:hover .shortcut, .menu-item.active .shortcut {
    color: rgba(255, 255, 255, 0.8);
  }

  .arrow {
    font-size: 9px;
    margin-left: 12px;
    opacity: 0.6;
  }
  
  .always-toggle-wrapper {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-left: 14px;
    padding: 3px 8px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.08); /* More visible background */
    border: 1px solid rgba(255, 255, 255, 0.15);
    transition: all 0.2s;
  }

  .always-toggle-wrapper:hover {
    background: rgba(255, 255, 255, 0.15);
    border-color: rgba(255, 255, 255, 0.3);
  }

  .always-toggle-wrapper input {
    margin: 0;
    cursor: pointer;
    width: 14px;
    height: 14px;
    accent-color: var(--color-nc-accent);
  }

  .radio-outer {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 1.5px solid rgba(255, 255, 255, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .always-toggle-wrapper:hover .radio-outer {
    border-color: white;
  }

  .radio-inner {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--color-nc-accent);
    box-shadow: 0 0 5px var(--color-nc-accent-glow);
  }

  .always-text {
    font-size: 11px; /* Slightly larger */
    font-weight: 700; /* Bolder */
    color: white; /* High contrast */
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
    user-select: none;
    letter-spacing: 0.2px;
  }

  .menu-item:hover .always-text, .menu-item.active .always-text {
    color: white;
  }

  .label {
    flex-grow: 1;
  }

  :global(.mnemonic) {
    text-decoration: underline;
    text-underline-offset: 2px;
    display: inline-block;
  }

  .is-submenu {
    z-index: 10001;
  }
</style>
