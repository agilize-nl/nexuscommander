<script lang="ts">
  import { getDrives, sortDrives, hasCapability } from "../ipc";
  import type { DriveInfo } from "../types";
  import { HardDrive, Network, Usb } from "lucide-svelte";
  import { onMount, onDestroy } from "svelte";
  import { _ } from "../i18n";

  interface Props {
    currentPath?: string;
    onselect?: (path: string) => void;
    onspacechange?: (spaceText: string) => void;
  }
  let { currentPath = "/", onselect, onspacechange }: Props = $props();

  let drives: DriveInfo[] = $state([]);
  let pollInterval: ReturnType<typeof setInterval> | null = null;

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
      if (currentDrive && (currentDrive.available_space > 0 || currentDrive.total_space > 0)) {
        onspacechange(formatSpace(currentDrive.available_space, currentDrive.total_space));
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
    try {
      const rawDrives = (await getDrives()).filter((drive) => !isHiddenDrive(drive));
      if (hasCapability("sortDrives")) {
        drives = sortDrives(rawDrives);
      } else {
        // No native sort capability → non-Network drives keep their original
        // order, Network drives are appended sorted alphabetically.
        const local = rawDrives.filter((d) => d.drive_type !== "Network");
        const network = rawDrives.filter((d) => d.drive_type === "Network");
        network.sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
        );
        drives = [...local, ...network];
      }
    } catch (e) {
      console.error("Failed to load drives:", e);
    }
  }

  onMount(() => {
    loadDrives();
    if (typeof window !== "undefined") {
      window.addEventListener("focus", loadDrives);
      pollInterval = setInterval(loadDrives, 10000);
    }
  });

  onDestroy(() => {
    if (typeof window !== "undefined") {
      window.removeEventListener("focus", loadDrives);
      if (pollInterval) clearInterval(pollInterval);
    }
  });

  function formatBytes(bytes: number) {
    if (bytes === 0) return "";
    const k = $_("size_units.k") || "K";
    const m = $_("size_units.m") || "M";
    const g = $_("size_units.g") || "G";
    const t = $_("size_units.t") || "T";
    const tbs = bytes / (1024 * 1024 * 1024 * 1024);
    if (tbs >= 1) return `${tbs.toFixed(1)} ${t}`;
    const gbs = bytes / (1024 * 1024 * 1024);
    if (gbs >= 1) return `${gbs.toFixed(1)} ${g}`;
    const mbs = bytes / (1024 * 1024);
    if (mbs >= 1) return `${mbs.toFixed(1)} ${m}`;
    return `${Math.round(bytes / 1024)} ${k}`;
  }

  function formatSpace(available: number, total: number = 0) {
    if (available === 0 && total === 0) return "";
    const freeLabel = $_("drive_bar.free");
    const totalLabel = $_("drive_bar.total") || "total";
    const freeText = available > 0 ? `${formatBytes(available)} ${freeLabel}` : "";
    const totalText = total > 0 ? `${formatBytes(total)} ${totalLabel}` : "";

    if (totalText && freeText) {
      return `${totalText} | ${freeText}`;
    }
    return totalText || freeText;
  }
</script>

<style>
  .drive-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 28px;
    background: var(--color-nc-bg-deep, #f8fafc);
    border-bottom: 1px solid var(--color-nc-border, #e2e8f0);
    padding: 0 4px;
    user-select: none;
    flex-shrink: 0;
  }
  .drive-list {
    display: flex;
    align-items: center;
    gap: 3px;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .drive-list::-webkit-scrollbar {
    display: none;
  }

  .drive-btn {
    display: flex;
    align-items: center;
    gap: 5px;
    height: 22px;
    padding: 0 7px;
    border-radius: 4px;
    font-family: var(--font-drive-name);
    font-size: var(--font-drive-size);
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.15s ease;
    background: var(--color-nc-drive-bg, #f1f5f9);
    border: 1px solid var(--color-nc-drive-border, #cbd5e1);
    color: var(--color-nc-drive-text, #334155);
  }

  .drive-btn:hover {
    background: var(--color-nc-drive-hover-bg, #e2e8f0);
    border-color: var(--color-nc-drive-hover-border, #94a3b8);
    color: var(--color-nc-drive-hover-text, #0f172a);
  }

  /* Type-specific icon and border accents for inactive state */
  .drive-btn.type-local {
    border-color: var(--color-nc-drive-local-border, #cbd5e1);
  }
  .drive-btn.type-local .icon {
    color: var(--color-nc-drive-local-icon, #0284c7);
  }

  .drive-btn.type-network {
    border-color: var(--color-nc-drive-network-border, #bfdbfe);
    background: var(--color-nc-drive-network-bg, #eff6ff);
  }
  .drive-btn.type-network .icon {
    color: var(--color-nc-drive-network-icon, #3b82f6);
  }

  .drive-btn.type-removable {
    border-color: var(--color-nc-drive-removable-border, #bbf7d0);
    background: var(--color-nc-drive-removable-bg, #f0fdf4);
  }
  .drive-btn.type-removable .icon {
    color: var(--color-nc-drive-removable-icon, #22c55e);
  }

  .drive-btn.active {
    background: var(--color-nc-drive-active-bg, #ffffff) !important;
    color: var(--color-nc-drive-active-text, #0f172a) !important;
    font-weight: 600;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  }
  .drive-btn.type-local.active {
    border: 1px solid var(--color-nc-drive-local-active-border, #0284c7);
  }
  .drive-btn.type-local.active .icon {
    color: var(--color-nc-drive-local-icon, #0284c7);
  }
  .drive-btn.type-network.active {
    border: 1px solid var(--color-nc-drive-network-active-border, #3b82f6);
  }
  .drive-btn.type-network.active .icon {
    color: var(--color-nc-drive-network-icon, #3b82f6);
  }
  .drive-btn.type-removable.active {
    border: 1px solid var(--color-nc-drive-removable-active-border, #22c55e);
  }
  .drive-btn.type-removable.active .icon {
    color: var(--color-nc-drive-removable-icon, #22c55e);
  }

  .icon {
    display: flex;
    align-items: center;
    opacity: 0.9;
  }
  .free-space {
    font-family: var(--font-drive-name);
    font-size: var(--font-drive-size);
    color: var(--color-nc-text-dim);
    padding: 0 8px;
    white-space: nowrap;
    opacity: 0.8;
  }
</style>

<div class="drive-bar">
  <div class="drive-list">
    {#each drives as drive}
      <button
        class="drive-btn"
        class:type-local={drive.drive_type === 'Local'}
        class:type-network={drive.drive_type === 'Network'}
        class:type-removable={drive.drive_type !== 'Local' && drive.drive_type !== 'Network'}
        class:active={currentDrive?.path === drive.path}
        onclick={() => onselect?.(drive.path)}
        title={`${drive.name} (${drive.path}) - ${drive.drive_type}`}
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

  {#if !onspacechange && currentDrive && (currentDrive.available_space > 0 || currentDrive.total_space > 0)}
    <div class="free-space">
      {formatSpace(currentDrive.available_space, currentDrive.total_space)}
    </div>
  {/if}
</div>
