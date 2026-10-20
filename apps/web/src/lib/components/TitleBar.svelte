<script lang="ts">
  import { onMount } from "svelte";
  import { getHealth } from "$lib/ipc";
  import packageInfo from "../../../package.json";

  let version = $state(packageInfo.version || "");

  onMount(() => {
    getHealth().then((h) => {
      if (h?.version) version = h.version;
    }).catch(() => {});

    // In a PWA, we can't easily detect maximized state without WCO
    // For now, we'll let the OS handle window controls.
    return () => {};
  });

  function minimize() {
    // Placeholder - Browser handles this
  }

  function toggleMaximize() {
    // Placeholder - Browser handles this
  }

  function close() {
    window.close();
  }
</script>

<div class="titlebar">
  <div class="titlebar-left" data-tauri-drag-region>
    <img src="/logo.png" alt="Nexus Commander" class="titlebar-logo" />
  </div>
  
  <div class="titlebar-center" data-tauri-drag-region>
    Nexus Commander{#if version}<span class="titlebar-version">v{version}</span>{/if}
  </div>

  <div class="titlebar-right no-pwa-controls">
    <!-- These are usually hidden in PWA mode as the OS provides them -->
  </div>
</div>

<style>
  .titlebar {
    height: 30px;
    background: var(--color-nc-bg-header);
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid var(--color-nc-border);
    user-select: none;
    flex-shrink: 0;
    position: relative;
    z-index: 600;
  }

  .titlebar-center {
    position: absolute;
    left: 50%;
    top: 0;
    transform: translateX(-50%);
    display: flex;
    justify-content: center;
    align-items: center;
    max-width: calc(100% - 32px);
    font-size: 11px;
    font-weight: 600;
    color: var(--color-nc-text-dim);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    height: 100%;
    cursor: default;
  }

  .titlebar-right {
    display: flex;
    height: 100%;
  }

  .titlebar-left {
    flex: 1;
    height: 100%;
    display: flex;
    align-items: center;
    padding-left: 8px;
  }

  .titlebar-logo {
    width: 18px;
    height: 18px;
    object-fit: contain;
    border-radius: 4px;
  }

  .titlebar-version {
    margin-left: 6px;
    font-weight: 400;
    text-transform: none;
    letter-spacing: normal;
    opacity: 0.6;
    font-size: 10px;
  }
</style>
