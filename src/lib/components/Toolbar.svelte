<script lang="ts">
  import { isOverlayActive, appConfigStore, activePanel } from "$lib/stores";
  import { _ } from "$lib/i18n";
  import {
    RefreshCw,
    Home,
    ArrowUp,
    Menu as MenuIcon,
    LayoutGrid,
    PanelTop,
    Rows,
    Star,
    Settings,
    Upload,
    Columns
  } from "lucide-svelte";

  interface Props {
    onrefresh?: () => void;
    onhome?: () => void;
    onup?: () => void;
    ontogglemenu?: () => void;
    onbrief?: () => void;
    onfull?: () => void;
    onsingleview?: () => void;
    onhotlist?: () => void;
    onoptions?: () => void;
  }

  let {
    onrefresh,
    onhome,
    onup,
    ontogglemenu,
    onbrief,
    onfull,
    onsingleview,
    onhotlist,
    onoptions
  }: Props = $props();

  let overlayActive = $state(false);
  isOverlayActive.subscribe(v => overlayActive = v);

  let isVertical = $derived($appConfigStore?.layout_is_vertical ?? true);

  let activeSide = $derived($activePanel);
  let currentViewMode = $derived(
    activeSide === "left"
      ? ($appConfigStore?.layout_left_view_mode || "full")
      : ($appConfigStore?.layout_right_view_mode || "full")
  );

  let isSingleView = $derived($appConfigStore?.layout_single_view ?? false);
</script>

<div class="toolbar">
  <button class="toolbar-btn" onclick={() => { if (overlayActive) return; onrefresh?.(); }} title={$_('menu.show')}>
    <RefreshCw size={18} />
  </button>
  
  <div class="sep"></div>
  
  <button class="toolbar-btn" onclick={() => { if (overlayActive) return; onhome?.(); }} title={$_('menu.hotlist')}>
    <Home size={18} />
  </button>
  
  <button class="toolbar-btn" onclick={() => { if (overlayActive) return; onup?.(); }} title={$_('panel.up')}>
    <ArrowUp size={18} />
  </button>
  
  <div class="sep"></div>
  
  <button class="toolbar-btn" onclick={() => { if (overlayActive) return; ontogglemenu?.(); }} title={$_('menu.toggle_menu_bar')}>
    <MenuIcon size={18} />
  </button>
  
  <div class="sep"></div>
  
  <button 
    class="toolbar-btn" 
    onclick={() => { if (overlayActive) return; window.dispatchEvent(new CustomEvent('nc:menu-action', { detail: 'toggle-view-mode' })); }} 
    title={currentViewMode === 'full' ? $_('menu.view_brief') : $_('menu.view_full')}
  >
    {#if currentViewMode === 'full'}
      <LayoutGrid size={18} />
    {:else}
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <rect x="6" y="6" width="12" height="4" rx="1" />
        <rect x="6" y="14" width="12" height="4" rx="1" />
      </svg>
    {/if}
  </button>

  <button class="toolbar-btn" onclick={() => { if (overlayActive) return; onsingleview?.(); }} title={isSingleView ? $_('menu.dual_view') : $_('menu.single_view')}>
    {#if isSingleView}
      <!-- Dual View icon: PanelTop with a vertical split line in the bottom area -->
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2"/>
        <path d="M3 9h18"/>
        <path d="M12 9v12"/>
      </svg>
    {:else}
      <PanelTop size={18} />
    {/if}
  </button>

  <button 
    class="toolbar-btn" 
    onclick={() => { if (overlayActive) return; window.dispatchEvent(new CustomEvent('nc:menu-action', { detail: 'toggle-layout' })); }} 
    title={isVertical ? $_('menu.layout_horizontal') : $_('menu.layout_vertical')}
  >
    <span class="icon-wrapper" class:rotated={isVertical}>
      <Columns size={18} />
    </span>
  </button>
  
  <div class="sep"></div>
  
  <button class="toolbar-btn" onclick={() => { if (overlayActive) return; onhotlist?.(); }} title={$_('menu.hotlist')}>
    <Star size={18} />
  </button>
  
  <button class="toolbar-btn" onclick={() => { if (overlayActive) return; window.dispatchEvent(new CustomEvent('nc:menu-action', { detail: 'upload-files' })); }} title={$_('menu.upload_files')}>
    <Upload size={18} />
  </button>

  <button class="toolbar-btn" onclick={() => { if (overlayActive) return; onoptions?.(); }} title={$_('menu.options')}>
    <Settings size={18} />
  </button>

  <div class="spacer"></div>
</div>

<style>
  .toolbar {
    display: flex;
    align-items: center;
    height: 34px;
    background: var(--color-nc-bg-header);
    border-bottom: 1px solid var(--color-nc-border);
    padding: 0 6px;
    gap: 2px;
  }

  .toolbar-btn {
    width: 30px;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    outline: none;
    border-radius: 4px;
    color: var(--color-nc-text);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .toolbar-btn:focus {
    outline: none;
  }

  .toolbar-btn:hover {
    background: var(--color-nc-bg-hover);
    color: var(--color-nc-text-bright);
    transform: translateY(-1px);
  }

  .toolbar-btn:active {
    background: var(--color-nc-accent-dim);
    transform: translateY(0);
  }

  .sep {
    width: 1px;
    height: 18px;
    background: var(--color-nc-border);
    margin: 0 4px;
  }

  .spacer {
    flex: 1;
  }

  .icon-wrapper {
    display: flex;
    align-items: center;
    justify-content: center;
    transition: transform 0.25s ease;
  }

  .icon-wrapper.rotated {
    transform: rotate(90deg);
  }
</style>
