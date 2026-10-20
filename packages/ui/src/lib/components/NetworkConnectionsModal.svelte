<script lang="ts">
  import { onMount } from "svelte";
  import { getDrives, sortDrives, hasCapability, mapNetworkDrive, disconnectNetworkDrive, getOS } from "../ipc";
  import type { DriveInfo } from "../types";
  import { _ } from "../i18n";

  interface Props {
    onclose: () => void;
    onselect?: (path: string) => void;
  }
  let { onclose, onselect }: Props = $props();

  let drives = $state<DriveInfo[]>([]);
  let os = $state<string>("");
  let loading = $state(true);
  let error = $state<string | null>(null);

  // Form state
  let path = $state("");
  let driveLetter = $state("");
  let persistent = $state(true);
  let submitting = $state(false);

  async function loadData() {
    loading = true;
    try {
      // QSF-008: desktop has no get_os backend command. Without it we keep the
      // POSIX presentation rather than letting the whole dialog fail to load.
      const [d, platform] = await Promise.all([
        getDrives(),
        hasCapability("getOS") ? getOS() : Promise.resolve("")
      ]);
      // Desktop provides drive sorting; web has no such capability → use as-is.
      drives = hasCapability("sortDrives") ? sortDrives(d) : d;
      os = platform;
    } catch (e: any) {
      error = e.message || e;
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    loadData();
  });

  async function handleConnect() {
    if (!path) return;
    submitting = true;
    error = null;
    try {
      await mapNetworkDrive(path, driveLetter, persistent);
      path = "";
      driveLetter = "";
      await loadData();
    } catch (e: any) {
      error = e.message || e;
    } finally {
      submitting = false;
    }
  }

  async function handleDisconnect(drive: DriveInfo) {
    try {
      await disconnectNetworkDrive(drive.path);
      await loadData();
    } catch (e: any) {
      error = e.message || e;
    }
  }

  const windowsLetters = "EFGHIJKLMNOPQRSTUVWXYZ".split("");
</script>

<div class="modal-overlay" onclick={onclose} onkeydown={(e) => { e.stopPropagation(); if (e.key === "Escape") onclose(); }} role="button" tabindex="-1">
  <div class="modal-box" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()} role="none">
    <div class="modal-header">
      <span class="modal-title">{$_('network.title')}</span>
    </div>

    <div class="modal-body">
      {#if error}
        <div class="error-msg">{error}</div>
      {/if}

      <section class="connect-form">
        <h3>{$_('network.connect_title')}</h3>
        <div class="form-row">
          <div class="input-group">
            <label for="path">{$_('network.folder_label', { example: os === 'windows' ? '\\\\server\\share' : 'smb://server/share' })}</label>
            <input id="path" type="text" bind:value={path} placeholder={os === 'windows' ? '\\\\server\\share' : 'smb://server/share'} />
          </div>
          {#if os === 'windows'}
            <div class="input-group letter">
              <label for="letter">{$_('network.drive_label')}</label>
              <select id="letter" bind:value={driveLetter}>
                <option value="">({$_('network.none')})</option>
                {#each windowsLetters as l}
                  <option value={l}>{l}:</option>
                {/each}
              </select>
            </div>
          {/if}
        </div>
        <div class="form-row">
          <label class="checkbox-label">
            <input type="checkbox" bind:checked={persistent} />
            {$_('network.persistent')}
          </label>
          <button class="btn-connect" onclick={handleConnect} disabled={submitting || !path}>
            {submitting ? $_('network.connecting') : $_('network.connect_btn')}
          </button>
        </div>
      </section>

      <section class="drive-list">
        <h3>{$_('network.active_title')}</h3>
        <div class="scroll-area">
          {#if loading}
            <div class="loading">{$_('network.loading_drives')}</div>
          {:else if drives.length === 0}
            <div class="empty">{$_('network.no_connections')}</div>
          {:else}
            <table class="drives-table">
              <thead>
                <tr>
                  <th>{$_('network.col_drive')}</th>
                  <th>{$_('network.col_path')}</th>
                  <th>{$_('network.col_type')}</th>
                  <th>{$_('network.col_action')}</th>
                </tr>
              </thead>
              <tbody>
                {#each drives as drive}
                  <tr class="drive-row" onclick={() => { onselect?.(drive.path); onclose(); }}>
                    <td><span class="drive-icon">{#if drive.drive_type === 'Network'}🌐{:else if drive.drive_type === 'Local'}🖥️{:else if drive.drive_type === 'Removable'}🔌{:else}💾{/if}</span> {drive.name}</td>
                    <td>{drive.path}</td>
                    <td><span class="badge {drive.drive_type.toLowerCase()}">{drive.drive_type}</span></td>
                    <td>
                      {#if drive.drive_type === 'Network' || drive.drive_type === 'Removable'}
                        <button class="btn-disconnect" onclick={(e) => { e.stopPropagation(); handleDisconnect(drive); }}>{$_('network.disconnect')}</button>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
        </div>
      </section>
    </div>

    <div class="modal-footer">
      <button class="btn-close" onclick={onclose}>{$_('common.close')}</button>
    </div>
  </div>
</div>

<style>
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: transparent;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1100;
  }

  .modal-box {
    background: var(--color-nc-bg-panel);
    border: 1px solid var(--color-nc-border-bright);
    border-radius: 12px;
    width: 700px;
    max-width: 90vw;
    display: flex;
    flex-direction: column;
    box-shadow: 0 30px 90px rgba(0, 0, 0, 0.6);
    overflow: hidden;
  }

  .modal-header {
    background: linear-gradient(180deg, var(--color-nc-bg-header) 0%, var(--color-nc-bg-panel) 100%);
    padding: 16px 20px;
    border-bottom: 1px solid var(--color-nc-border);
  }

  .modal-title {
    font-weight: 600;
    font-size: 16px;
    color: var(--color-nc-text-bright);
  }

  .modal-body {
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 24px;
    max-height: 70vh;
    overflow-y: auto;
  }

  h3 {
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-nc-accent);
    margin-bottom: 12px;
  }

  .error-msg {
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid var(--color-nc-danger);
    color: var(--color-nc-danger);
    padding: 10px;
    border-radius: 4px;
    font-size: 13px;
  }

  .form-row {
    display: flex;
    gap: 16px;
    align-items: flex-end;
    margin-bottom: 12px;
  }

  .input-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 1;
  }

  .input-group.letter {
    flex: 0 0 100px;
  }

  label {
    font-size: 12px;
    color: var(--color-nc-text-dim);
  }

  input[type="text"], select {
    background: var(--color-nc-bg);
    border: 1px solid var(--color-nc-border);
    border-radius: 4px;
    padding: 8px 12px;
    color: var(--color-nc-text-bright);
    font-size: 13px;
    outline: none;
  }

  input:focus, select:focus {
    border-color: var(--color-nc-accent);
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    font-size: 13px;
    cursor: pointer;
    color: var(--color-nc-text);
  }

  .btn-connect {
    background: var(--color-nc-accent-dim);
    color: var(--color-nc-text-bright);
    border: 1px solid var(--color-nc-accent);
    padding: 8px 24px;
    border-radius: 4px;
    cursor: pointer;
    font-weight: 500;
  }

  .btn-connect:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Drive List */
  .scroll-area {
    border: 1px solid var(--color-nc-border);
    border-radius: 6px;
    background: var(--color-nc-bg);
    min-height: 150px;
  }

  .drives-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }

  .drives-table th {
    background: var(--color-nc-bg-deep);
    padding: 8px 12px;
    text-align: left;
    font-size: 11px;
    color: var(--color-nc-text);
    text-transform: uppercase;
  }

  .drives-table td {
    padding: 10px 12px;
    border-bottom: 1px solid var(--color-nc-border);
  }

  .drive-row {
    cursor: pointer;
    transition: background 0.1s;
  }

  .drive-row:hover {
    background: var(--color-nc-bg-hover);
  }

  .drive-icon {
    font-size: 14px;
    margin-right: 4px;
  }

  .badge {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 10px;
    text-transform: uppercase;
    font-weight: 600;
  }

  .badge.local { background: rgba(59, 130, 246, 0.2); color: #60a5fa; }
  .badge.network { background: rgba(16, 185, 129, 0.2); color: #34d399; }
  .badge.removable { background: rgba(245, 158, 11, 0.2); color: #fbbf24; }

  .btn-disconnect {
    background: transparent;
    border: 1px solid var(--color-nc-danger);
    color: var(--color-nc-danger);
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    cursor: pointer;
  }

  .btn-disconnect:hover {
    background: var(--color-nc-danger);
    color: white;
  }

  .modal-footer {
    padding: 16px 20px;
    background: var(--color-nc-bg-deep);
    border-top: 1px solid var(--color-nc-border);
    display: flex;
    justify-content: flex-end;
  }

  .btn-close {
    background: var(--color-nc-bg-panel);
    border: 1px solid var(--color-nc-border-bright);
    color: var(--color-nc-text);
    padding: 8px 24px;
    border-radius: 4px;
    cursor: pointer;
  }
</style>
