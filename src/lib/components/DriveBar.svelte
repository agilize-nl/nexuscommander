<script lang="ts">
  import { onMount } from "svelte";
  import { HardDrive, Network, Usb } from "lucide-svelte";
  import { fetchDrives as getDrives } from "$lib/ipc";
  import type { DriveInfo } from "$lib/types";
  import { _ } from "$lib/i18n";

  interface Props {
    currentPath?: string;
    onselect?: (path: string) => void;
    onspacechange?: (spaceText: string) => void;
  }
  let { currentPath = "/", onselect, onspacechange }: Props = $props();

  let drives = $state<DriveInfo[]>([]);
  let currentDrive = $derived.by(() => {
    let bestMatch = drives[0];
    let maxLen = 0;
    for (const d of drives) {
      if (currentPath.startsWith(d.path) && d.path.length > maxLen) {
        bestMatch = d;
        maxLen = d.path.length;
      }
    }
    return bestMatch;
  });

  $effect(() => {
    if (onspacechange) {
      if (currentDrive && currentDrive.available_space > 0) {
        onspacechange(formatSpace(currentDrive.available_space));
      } else {
        onspacechange("");
      }
    }
  });

  function isHiddenDrive(drive: DriveInfo) {
    const label = (drive as DriveInfo & { label?: string }).label || "";
    return drive.name === "gvfs"
      || drive.path === "/run/user/1000/gvfs"
      || /^\/run\/user\/\d+\/gvfs\/?$/.test(drive.path)
      || label === "gvfs"
      || /^\/run\/user\/\d+\/gvfs\/?$/.test(label);
  }

  async function loadDrives() {
    const rawDrives = (await getDrives()).filter((drive) => !isHiddenDrive(drive));
    const local = rawDrives.filter((d) => d.drive_type !== "Network");
    const network = rawDrives.filter((d) => d.drive_type === "Network");
    network.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    );
    drives = [...local, ...network];
  }

  onMount(() => {
    loadDrives();
  });

  function formatSpace(bytes: number) {
    if (bytes === 0) return "";
    const freeLabel = $_("drive_bar.free");
    const k = $_("size_units.k") || "K";
    const m = $_("size_units.m") || "M";
    const g = $_("size_units.g") || "G";
    const gbs = bytes / (1024 * 1024 * 1024);
    if (gbs >= 1) return `${gbs.toFixed(1)} ${g} ${freeLabel}`;
    const mbs = bytes / (1024 * 1024);
    if (mbs >= 1) return `${mbs.toFixed(1)} ${m} ${freeLabel}`;
    return `${Math.round(bytes / 1024)} ${k} ${freeLabel}`;
  }
</script>

<div class="drive-bar">
  <div class="drive-list">
    {#each drives as drive}
      <button 
        class="drive-btn" 
        class:active={currentDrive?.path === drive.path}
        onclick={() => onselect?.(drive.path)}
        title={`${drive.name} (${drive.path})`}
      >
        <span class="icon">
          {#if drive.drive_type === 'Network'}
            <Network size={14} />
          {:else if drive.drive_type === 'Removable'}
            <Usb size={14} />
          {:else}
            <HardDrive size={14} />
          {/if}
        </span>
        <span class="label">{drive.name}</span>
      </button>
    {/each}
  </div>
</div>

<style>
  .drive-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 28px;
    background: var(--color-nc-bg-deep);
    border-bottom: 1px solid var(--color-nc-border);
    padding: 0 4px;
    user-select: none;
    flex-shrink: 0;
  }
  .drive-list {
    display: flex;
    align-items: center;
    gap: 2px;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .drive-list::-webkit-scrollbar {
    display: none;
  }
  .drive-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 22px;
    padding: 0 6px;
    background: var(--color-nc-bg-panel);
    border: 1px solid var(--color-nc-border);
    border-radius: 3px;
    color: var(--color-nc-text);
    font-family: var(--font-drive-name);
    font-size: var(--font-drive-size);
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.1s;
  }
  .drive-btn:hover {
    background: var(--color-nc-bg-hover);
    color: var(--color-nc-text-bright);
    border-color: var(--color-nc-border-hover);
  }
  .drive-btn.active {
    background: var(--color-nc-bg-hover);
    color: var(--color-nc-text-bright);
    border-color: var(--color-nc-accent-dim);
    border-bottom: 2px solid var(--color-nc-accent);
    padding-bottom: 0;
    font-weight: 600;
  }
  .icon {
    display: flex;
    align-items: center;
    opacity: 0.8;
  }
  .drive-btn.active .icon {
    opacity: 1;
  }
</style>
