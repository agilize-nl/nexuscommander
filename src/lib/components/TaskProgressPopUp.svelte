<script lang="ts">
  import { fade, fly } from "svelte/transition";
  import { formatSize } from "$lib/utils";
  import { _ } from "$lib/i18n";
  import { taskGet, taskCancel, resolveTaskConflict, type TaskInfo } from "$lib/ipc";
  import { createSmartPoller } from "$lib/utils/smartPoller";

  interface Props {
    taskId: string | null;
    onclose: () => void;
  }

  let { taskId, onclose }: Props = $props();

  let taskInfo = $state<TaskInfo | null>(null);
  let closeScheduled = false;

  const poller = createSmartPoller({ poll: pollOnce });

  $effect(() => {
    if (taskId) {
      closeScheduled = false;
      poller.kick();
    }
  });

  $effect(() => {
    return () => poller.destroy();
  });

  async function pollOnce(): Promise<boolean> {
    if (!taskId) return false;
    try {
      const info = await taskGet(taskId);
      if (!info) {
        onclose();
        return false;
      }
      taskInfo = info;
      if (info.status === "Completed" || info.status === "Failed" || info.status === "Cancelled") {
        // Auto-close only on success, and only once per task.
        if (info.status === "Completed" && !closeScheduled) {
          closeScheduled = true;
          setTimeout(onclose, 2000);
        }
        return false;
      }
      return true;
    } catch (e) {
      console.error("Polling failed:", e);
      return false;
    }
  }

  async function handleStop() {
    if (taskId) {
      await taskCancel(taskId);
      onclose();
    }
  }

  async function handleResolve(resolution: string) {
    if (taskId) {
      await resolveTaskConflict(taskId, resolution);
      poller.kick();
    }
  }

  function getOverallProgress(): number {
    if (!taskInfo || taskInfo.total_bytes === 0) return 0;
    return (taskInfo.transferred_bytes / taskInfo.total_bytes) * 100;
  }

  function getFileProgress(): number {
    if (!taskInfo || taskInfo.current_file_total_bytes === 0) return 0;
    return (taskInfo.current_file_transferred_bytes / taskInfo.current_file_total_bytes) * 100;
  }

  function formatSpeed(bytesPerSec: number): string {
    const kb = $_("size_units.kb") || "KB";
    const mb = $_("size_units.mb") || "MB";
    if (bytesPerSec < 1024 * 1024) {
      return `${(bytesPerSec / 1024).toFixed(1)} ${kb}/s`;
    }
    return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} ${mb}/s`;
  }

  function formatTime(seconds: number): string {
    if (isNaN(seconds) || seconds === Infinity) return "--:--:--";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
</script>

{#if taskId && taskInfo}
  <div class="progress-popup-overlay" transition:fade={{ duration: 200 }}>
    <div class="progress-card" transition:fly={{ y: 20, duration: 300 }}>
      <div class="card-header">
        <span class="status-title">
          {Math.round(getOverallProgress())}% {taskInfo.task_type}ing
          {#if taskInfo.status === "Completed"} (Done){/if}
          {#if taskInfo.status === "Failed"} (Error){/if}
          {#if taskInfo.status === "WaitingForInput"} (Conflict){/if}
        </span>
        <div class="header-controls">
          <button class="win-btn-mini">_</button>
          <button class="win-btn-mini">□</button>
          <button class="win-btn-mini close" onclick={onclose}>×</button>
        </div>
      </div>

      <div class="card-body">
        <div class="info-grid">
          <div class="info-row">
            <span class="label">From:</span>
            <span class="value" title={taskInfo.current_file_source}>{taskInfo.current_file_source || '—'}</span>
          </div>
          <div class="info-row">
            <span class="label">To:</span>
            <span class="value" title={taskInfo.current_file_target}>{taskInfo.current_file_target || '—'}</span>
          </div>
          <div class="metrics-row">
            <span class="metric">Speed: <strong>{formatSpeed(taskInfo.speed_bytes_per_sec || 0)}</strong></span>
            <span class="metric">ETA: <strong>{formatTime(taskInfo.eta_seconds || 0)}</strong></span>
          </div>
        </div>

        {#if taskInfo.status === "WaitingForInput"}
          <div class="conflict-container">
            <div class="conflict-details">
              <div class="conflict-title">{$_('tasks.conflict_file')}</div>
              <div class="conflict-filename">{taskInfo.pending_conflict}</div>
            </div>
            <div class="conflict-buttons">
              <button class="btn-conflict" onclick={() => handleResolve("overwrite")}>
                {$_('tasks.overwrite')}
              </button>
              <button class="btn-conflict" onclick={() => handleResolve("skip")}>
                {$_('tasks.skip')}
              </button>
              <button class="btn-conflict" onclick={() => handleResolve("overwrite_all")}>
                {$_('tasks.overwrite_all')}
              </button>
              <button class="btn-conflict" onclick={() => handleResolve("skip_all")}>
                {$_('tasks.skip_all')}
              </button>
            </div>
          </div>
        {/if}

        {#if taskInfo.error}
          <div class="error-container">
            <div class="error-title">{$_('tasks.error_details')}</div>
            <div class="error-message">{taskInfo.error}</div>
          </div>
        {/if}

        <!-- Per-file progress -->
        <div class="progress-track">
          <div class="progress-fill" class:waiting={taskInfo.status === "WaitingForInput"} style="width: {getFileProgress()}%"></div>
          <div class="progress-label">
            {formatSize(taskInfo.current_file_transferred_bytes || 0)} / {formatSize(taskInfo.current_file_total_bytes || 0)} ({Math.round(getFileProgress())}%)
          </div>
        </div>

        <!-- Overall progress -->
        <div class="progress-track total">
          <div class="progress-fill total" class:waiting={taskInfo.status === "WaitingForInput"} style="width: {getOverallProgress()}%"></div>
          <div class="progress-label total">
            {formatSize(taskInfo.transferred_bytes || 0)} / {formatSize(taskInfo.total_bytes || 0)} ({Math.round(getOverallProgress())}%)
          </div>
        </div>

        <div class="card-footer">
          <div class="footer-left">
            <button class="btn-action">To panel</button>
            <button class="btn-action">View all</button>
          </div>
          <div class="footer-center">
            {taskInfo.processed_files} / {taskInfo.total_files}
          </div>
          <div class="footer-right">
            <button class="btn-action danger" onclick={handleStop}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
              Cancel
            </button>
            <button class="btn-action" aria-label="Pause/Resume">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .progress-popup-overlay {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 3000;
    pointer-events: none; /* Let clicks pass through outside the card */
  }

  .progress-card {
    pointer-events: auto;
    width: 480px;
    background: var(--color-nc-bg-panel);
    border: 1px solid var(--color-nc-border-bright);
    border-radius: 12px;
    box-shadow: 
      0 20px 50px rgba(0, 0, 0, 0.4),
      0 0 0 1px rgba(255, 255, 255, 0.1);
    overflow: hidden;
    color: var(--color-nc-text);
  }

  .card-header {
    background: var(--color-nc-bg-header);
    padding: 8px 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--color-nc-border);
  }

  .status-title {
    font-size: 13px;
    font-weight: 700;
    color: var(--color-nc-text-bright);
  }

  .header-controls {
    display: flex;
    gap: 4px;
  }

  .win-btn-mini {
    width: 20px;
    height: 20px;
    background: var(--color-nc-bg-alt);
    border: none;
    border-radius: 50%;
    color: var(--color-nc-text-dim);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    font-size: 12px;
  }

  .win-btn-mini:hover {
    background: var(--color-nc-bg-hover);
    color: var(--color-nc-text-bright);
  }

  .win-btn-mini.close:hover {
    background: var(--color-nc-danger);
    color: white;
  }

  .card-body {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .info-grid {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .info-row {
    display: flex;
    gap: 8px;
    font-size: 11px;
  }

  .info-row .label {
    min-width: 40px;
    color: var(--color-nc-text-dim);
  }

  .info-row .value {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-nc-text);
  }

  .metrics-row {
    display: flex;
    gap: 16px;
    font-size: 11px;
    margin-top: 4px;
    color: var(--color-nc-text-dim);
  }

  .metrics-row strong {
    color: var(--color-nc-accent);
  }

  .progress-track {
    position: relative;
    height: 28px;
    background: var(--color-nc-bg-deep);
    border: 1px solid var(--color-nc-border);
    border-radius: 14px;
    overflow: hidden;
    box-shadow: inset 0 2px 4px rgba(0,0,0,0.2);
  }

  .progress-fill {
    height: 100%;
    background: var(--color-nc-accent-dim);
    transition: width 0.3s ease;
  }

  .progress-fill.total {
    background: var(--color-nc-accent);
  }

  .progress-label {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 600;
    color: var(--color-nc-text-bright);
    mix-blend-mode: difference; /* Ensures visibility on any bar color */
    pointer-events: none;
  }

  /* Specific fix for light theme where mix-blend-mode might be tricky with colors */
  :global([data-theme="github-light"]) .progress-label {
     mix-blend-mode: normal;
     color: #475569; /* Dark slate for light theme */
  }

  .card-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 4px;
  }

  .footer-left, .footer-right {
    display: flex;
    gap: 6px;
  }

  .footer-center {
    font-size: 11px;
    color: var(--color-nc-text-dim);
  }

  .btn-action {
    background: var(--color-nc-bg-alt);
    border: 1px solid var(--color-nc-border);
    color: var(--color-nc-text);
    font-size: 10px;
    padding: 3px 8px;
    border-radius: 6px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .btn-action:hover {
    background: var(--color-nc-bg-hover);
    border-color: var(--color-nc-border-bright);
  }

  .btn-action.danger:hover {
    background: var(--color-nc-danger);
    color: white;
    border-color: var(--color-nc-danger);
  }

  .conflict-container {
    background: rgba(235, 172, 0, 0.1);
    border: 1px solid #ebac00;
    border-radius: 8px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-bottom: 4px;
  }

  .conflict-details {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .conflict-title {
    font-size: 11px;
    color: var(--color-nc-text-dim);
    text-transform: uppercase;
    font-weight: bold;
    letter-spacing: 0.5px;
  }

  .conflict-filename {
    font-size: 12px;
    color: var(--color-nc-text-bright);
    font-weight: 500;
    word-break: break-all;
  }

  .conflict-buttons {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
  }

  .btn-conflict {
    background: var(--color-nc-bg-alt);
    border: 1px solid var(--color-nc-border-bright);
    color: var(--color-nc-text-bright);
    font-size: 11px;
    padding: 6px;
    border-radius: 4px;
    cursor: pointer;
    font-weight: 600;
    text-align: center;
    transition: all 0.15s ease;
  }

  .btn-conflict:hover {
    background: var(--color-nc-bg-hover);
    border-color: var(--color-nc-accent);
  }

  .progress-fill.waiting {
    background: #ebac00 !important;
  }

  .error-container {
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid var(--color-nc-danger);
    border-radius: 8px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 4px;
  }

  .error-title {
    font-size: 11px;
    color: var(--color-nc-danger);
    text-transform: uppercase;
    font-weight: bold;
    letter-spacing: 0.5px;
  }

  .error-message {
    font-size: 12px;
    color: var(--color-nc-text-bright);
    word-break: break-all;
    white-space: pre-wrap;
  }
</style>
