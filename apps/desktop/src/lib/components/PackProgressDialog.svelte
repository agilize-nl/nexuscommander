<script lang="ts">
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { onMount, onDestroy } from "svelte";
  import { fade, scale } from "svelte/transition";
  import { _ } from "$lib/i18n";
  import { archiveCancelPack } from "$lib/ipc";

  interface PackProgress {
    current_file: string;
    current_file_num: number;
    total_files: number;
    current_file_progress: number;
    total_progress: number;
    bytes_processed: number;
    total_bytes: number;
    started_at: number;
    bytes_per_second: number;
  }

  interface Props {
    onclose: () => void;
  }

  let props: Props = $props();

  let progress = $state<PackProgress | null>(null);
  let runningTime = $state("00:00");
  let estimatedTime = $state("--:--");
  let unlisten: UnlistenFn | null = null;
  let totalPercent = $derived(Math.max(0, Math.min(100, progress?.total_progress ?? 0)));

  function formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  }

  function formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }

  function updateTimes(startedAt: number) {
    const now = Math.floor(Date.now() / 1000);
    const elapsed = now - startedAt;
    runningTime = formatTime(elapsed);

    if (progress && progress.total_bytes > 0 && progress.bytes_processed > 0 && elapsed > 0) {
      const rate = progress.bytes_processed / elapsed;
      const remaining = progress.total_bytes - progress.bytes_processed;
      const eta = remaining / rate;
      estimatedTime = formatTime(eta);
    }
  }

  let showConfirmCancel = $state(false);
  async function handleCancel() {
    if (!showConfirmCancel) {
      showConfirmCancel = true;
      return;
    }
    await archiveCancelPack();
    showConfirmCancel = false;
    props.onclose();
  }

  let interval: any;

  onMount(() => {
    listen<PackProgress>("pack-progress", (event) => {
      progress = event.payload;
      if (progress) {
        updateTimes(progress.started_at);
      }
    }).then(u => unlisten = u);

    interval = setInterval(() => {
      if (progress) {
        updateTimes(progress.started_at);
      }
    }, 1000);
  });

  onDestroy(() => {
    if (unlisten) unlisten();
    if (interval) clearInterval(interval);
  });
</script>

<div class="dialog-overlay">
  <div class="progress-dialog" transition:scale={{ duration: 150, start: 0.95 }}>
    <div class="dialog-header">
      <h3>{$_("dialog.pack_progress_title") || "Compressing..."}</h3>
    </div>

    <div class="dialog-content">
      {#if progress}
        <div class="current-file">
          <span class="label">{$_("dialog.pack_current_file") || "Current:"}</span>
          <span class="value">{progress.current_file || "..."}</span>
        </div>

        <div class="progress-section">
          <div class="progress-bar-container">
            <div class="progress-bar" style="width: {totalPercent}%"></div>
          </div>
          <div class="progress-labels">
            <span>{totalPercent.toFixed(1)}%</span>
            <span>{progress.current_file_num} / {progress.total_files}</span>
          </div>
        </div>

        <div class="stats-grid">
          <div class="stat">
            <span class="stat-label">{$_("dialog.pack_processed") || "Processed:"}</span>
            <span class="stat-value">{formatBytes(progress.bytes_processed)} / {formatBytes(progress.total_bytes)}</span>
          </div>
          <div class="stat">
            <span class="stat-label">{$_("dialog.pack_speed")}</span>
            <span class="stat-value">{formatBytes(progress.bytes_per_second)}/s</span>
          </div>
          <div class="stat">
            <span class="stat-label">{$_("dialog.pack_running") || "Running:"}</span>
            <span class="stat-value">{runningTime}</span>
          </div>
          <div class="stat">
            <span class="stat-label">{$_("dialog.pack_estimated") || "ETA:"}</span>
            <span class="stat-value">{estimatedTime}</span>
          </div>
        </div>

        <div class="dialog-actions">
          {#if showConfirmCancel}
            <div class="confirm-cancel-box" transition:fade={{ duration: 100 }}>
              <span class="confirm-prefix">{$_("dialog.pack_abort_confirm")}</span>
              <button class="confirm-btn yes" onclick={handleCancel}>
                {$_("dialog.pack_abort_yes")}
              </button>
              <button class="confirm-btn no" onclick={() => showConfirmCancel = false}>
                {$_("dialog.no")}
              </button>
            </div>
          {:else}
            <button class="cancel-btn" onclick={handleCancel}>
              {$_("dialog.cancel") || "Cancel"}
            </button>
          {/if}
        </div>
      {:else}
        <div class="loading">{$_("dialog.pack_starting") || "Starting..."}</div>
      {/if}
    </div>
  </div>
</div>

<style>
  .dialog-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .progress-dialog {
    background: var(--color-nc-bg-deep, #1a1a2e);
    border: 1px solid var(--color-nc-border, #3a3a5a);
    border-radius: 8px;
    width: 420px;
    max-width: 90vw;
    overflow: hidden;
  }

  .dialog-header {
    padding: 16px 20px;
    background: var(--color-nc-bg-header, #16162a);
    border-bottom: 1px solid var(--color-nc-border, #3a3a5a);
  }

  .dialog-header h3 {
    margin: 0;
    color: var(--color-nc-text-bright, #fff);
    font-size: 16px;
    font-weight: 500;
  }

  .dialog-content {
    padding: 20px;
  }

  .current-file {
    margin-bottom: 16px;
    padding: 8px 12px;
    background: var(--color-nc-bg, #22223a);
    border-radius: 4px;
    font-size: 12px;
    overflow: hidden;
  }

  .current-file .label {
    color: var(--color-nc-text-dim, #888);
    margin-right: 8px;
  }

  .current-file .value {
    color: var(--color-nc-text-bright, #fff);
    font-family: var(--font-family-mono, monospace);
    word-break: break-all;
  }

  .progress-section {
    margin-bottom: 16px;
  }

  .progress-bar-container {
    height: 8px;
    background: var(--color-nc-bg, #22223a);
    border-radius: 4px;
    overflow: hidden;
    margin-bottom: 8px;
  }

  .progress-bar {
    height: 100%;
    background: linear-gradient(90deg, var(--color-nc-accent, #6366f1), var(--color-nc-accent-bright, #818cf8));
    border-radius: 4px;
    transition: width 0.3s ease;
  }

  .progress-labels {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    color: var(--color-nc-text-dim, #888);
  }

  .stats-grid {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr 1fr;
    gap: 12px;
  }

  .stat {
    text-align: center;
  }

  .stat-label {
    display: block;
    font-size: 10px;
    color: var(--color-nc-text-dim, #888);
    text-transform: uppercase;
    margin-bottom: 4px;
  }

  .stat-value {
    font-size: 13px;
    color: var(--color-nc-text-bright, #fff);
    font-family: var(--font-family-mono, monospace);
  }

  .loading {
    text-align: center;
    padding: 40px;
    color: var(--color-nc-text-dim, #888);
  }

  .dialog-actions {
    margin-top: 24px;
    display: flex;
    justify-content: flex-end;
    min-height: 36px;
  }

  .cancel-btn {
    padding: 8px 20px;
    background: var(--color-nc-bg, #22223a);
    border: 1px solid var(--color-nc-border, #3a3a5a);
    border-radius: 4px;
    color: var(--color-nc-text-bright, #fff);
    font-size: 13px;
    cursor: pointer;
    transition: all 0.2s;
  }

  .cancel-btn:hover {
    background: #cc3333;
    border-color: #ff4444;
  }

  .confirm-cancel-box {
    display: flex;
    align-items: center;
    gap: 10px;
    background: rgba(255, 68, 68, 0.1);
    padding: 6px 12px;
    border: 1px solid rgba(255, 68, 68, 0.3);
    border-radius: 6px;
    animation: shake 0.4s cubic-bezier(.36,.07,.19,.97) both;
  }

  @keyframes shake {
    10%, 90% { transform: translate3d(-1px, 0, 0); }
    20%, 80% { transform: translate3d(2px, 0, 0); }
    30%, 50%, 70% { transform: translate3d(-3px, 0, 0); }
    40%, 60% { transform: translate3d(3px, 0, 0); }
  }

  .confirm-prefix {
    font-size: 12px;
    font-weight: 600;
    color: #ff4444;
  }

  .confirm-btn {
    padding: 4px 12px;
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
    border: 1px solid transparent;
    transition: all 0.2s;
  }

  .confirm-btn.yes {
    background: #ff4444;
    color: white;
  }

  .confirm-btn.yes:hover {
    background: #ee3333;
  }

  .confirm-btn.no {
    background: transparent;
    border-color: var(--color-nc-border);
    color: var(--color-nc-text-dim);
  }

  .confirm-btn.no:hover {
    background: rgba(255, 255, 255, 0.05);
    color: var(--color-nc-text-bright);
  }
</style>
