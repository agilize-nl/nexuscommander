<script lang="ts">
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { onMount, onDestroy } from "svelte";
  import { scale } from "svelte/transition";
  import { _ } from "$lib/i18n";

  interface UnpackProgress {
    current_file: string;
    current_file_num: number;
    total_files: number;
    total_progress: number;
    bytes_written: number;
    started_at: number;
  }

  interface Props {
    onclose: () => void;
  }

  let props: Props = $props();

  let progress = $state<UnpackProgress | null>(null);
  let runningTime = $state("00:00");
  let unlisten: UnlistenFn | null = null;
  let percent = $derived(Math.max(0, Math.min(100, progress?.total_progress ?? 0)));

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
    runningTime = formatTime(now - startedAt);
  }

  let interval: any;

  onMount(() => {
    listen<UnpackProgress>("unpack-progress", (event) => {
      progress = event.payload;
      if (progress) {
        updateTimes(progress.started_at);
      }
    }).then((u) => (unlisten = u));

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
      <h3>{$_("dialog.unpack_progress_title")}</h3>
    </div>

    <div class="dialog-content">
      {#if progress}
        <div class="current-file">
          <span class="label">{$_("dialog.unpack_current_file")}</span>
          <span class="value">{progress.current_file || "..."}</span>
        </div>

        <div class="progress-section">
          <div class="progress-bar-container">
            <div class="progress-bar" style="width: {percent}%"></div>
          </div>
          <div class="progress-labels">
            <span>{percent.toFixed(1)}%</span>
            <span>{progress.current_file_num} / {progress.total_files}</span>
          </div>
        </div>

        <div class="stats-grid">
          <div class="stat">
            <span class="stat-label">{$_("dialog.unpack_written")}</span>
            <span class="stat-value">{formatBytes(progress.bytes_written)}</span>
          </div>
          <div class="stat">
            <span class="stat-label">{$_("dialog.unpack_running")}</span>
            <span class="stat-value">{runningTime}</span>
          </div>
        </div>
      {:else}
        <div class="loading">{$_("dialog.unpack_starting")}</div>
      {/if}

      <div class="dialog-actions">
        <button class="hide-btn" onclick={props.onclose}>
          {$_("dialog.hide")}
        </button>
      </div>
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
    grid-template-columns: 1fr 1fr;
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

  .hide-btn {
    padding: 8px 20px;
    background: var(--color-nc-bg, #22223a);
    border: 1px solid var(--color-nc-border, #3a3a5a);
    border-radius: 4px;
    color: var(--color-nc-text-bright, #fff);
    font-size: 13px;
    cursor: pointer;
    transition:
      background 0.2s,
      border-color 0.2s;
  }

  .hide-btn:hover {
    background: var(--color-nc-bg-header, #16162a);
    border-color: var(--color-nc-accent, #6366f1);
  }
</style>
