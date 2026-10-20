<script lang="ts">
  import { uploadStore, cancelItem, cancelAll, clearFinished, type UploadItem } from "$lib/upload/uploadStore";
  import { formatSize } from "$lib/utils";
  import { _ } from "$lib/i18n";

  let uploadState = $derived($uploadStore);
  let hasAnyItems = $derived(uploadState.items.length > 0);
  let activeItems = $derived(uploadState.items.filter(i => i.status === 'uploading' || i.status === 'queued'));
  let hasFinished = $derived(uploadState.items.some(i => i.status === 'done' || i.status === 'skipped' || i.status === 'error' || i.status === 'cancelled'));
  let collapsed = $state(true);

  // Auto-expand when a new upload starts
  $effect(() => {
    if (uploadState.active) {
      collapsed = false;
    }
  });

  function getProgressPercent(): number {
    if (uploadState.totalBytes === 0) return 0;
    return Math.min(100, (uploadState.sentBytes / uploadState.totalBytes) * 100);
  }

  function formatSpeed(bps: number): string {
    if (!bps || bps === 0) return "";
    return `${formatSize(bps)}/s`;
  }

  function formatETA(seconds: number): string {
    if (!seconds || seconds === 0) return "";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    const pad = (n: number) => n.toString().padStart(2, "0");
    if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
    return `${pad(m)}:${pad(s)}`;
  }

  function getStatusIcon(status: string): string {
    switch (status) {
      case "queued": return "⏳";
      case "uploading": return "⚡";
      case "done": return "✅";
      case "skipped": return "⏭️";
      case "error": return "❌";
      case "cancelled": return "🚫";
      default: return "•";
    }
  }
</script>

{#if hasAnyItems}
  <div class="task-bar">
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="task-header" onclick={() => (collapsed = !collapsed)}>
      <span class="task-indicator">
        {#if uploadState.active}
          <span class="pulse"></span>
        {/if}
        {uploadState.active
          ? `${activeItems.length} ${$_('upload.uploading').toLowerCase()}`
          : `${uploadState.items.length} ${$_('upload.title').toLowerCase()}`}
      </span>
      <span class="header-stats">
        {#if uploadState.active}
          <span class="task-speed">{formatSpeed(uploadState.speedBps)}</span>
          <span class="task-eta">{formatETA(uploadState.etaSeconds)}</span>
        {/if}
        <span class="task-toggle">{collapsed ? "▲" : "▼"}</span>
      </span>
    </div>

    {#if !collapsed}
      <div class="task-list">
        {#each uploadState.items as item}
          <div class="task-item" class:failed={item.status === 'error'}>
            <div class="task-row">
              <span class="task-status">{getStatusIcon(item.status)}</span>
              <span class="task-type">{$_("upload.title")}</span>
              <span class="task-file" title={item.rel}>{item.name}</span>
              
              {#if item.status === 'uploading'}
                <span class="task-progress-text">
                  {formatSize(item.sent)} / {formatSize(item.size)}
                </span>
                <button class="task-cancel" onclick={() => cancelItem(item.id)}>✕</button>
              {:else if item.status === 'queued'}
                <span class="task-progress-text">{$_("tasks.status.queued")}</span>
                <button class="task-cancel" onclick={() => cancelItem(item.id)}>✕</button>
              {:else}
                <span class="task-progress-text">{formatSize(item.size)}</span>
              {/if}
            </div>

            {#if item.status === 'uploading'}
              <div class="progress-bar">
                <div
                  class="progress-fill"
                  style="width: {(item.sent / item.size) * 100}%"
                ></div>
              </div>
            {/if}

            {#if item.error}
              <div class="task-error">{item.error}</div>
            {/if}
          </div>
        {/each}

        <!-- Total Progress Bar -->
        {#if uploadState.active}
          <div class="total-progress-container">
            <div class="progress-bar">
              <div class="progress-fill total" style="width: {getProgressPercent()}%"></div>
            </div>
          </div>
        {/if}

        <div class="footer-actions">
          {#if uploadState.active}
            <button class="task-clear" onclick={cancelAll}>{$_('upload.cancel_all')}</button>
          {:else if hasFinished}
            <button class="task-clear" onclick={clearFinished}>{$_('tasks.clear_all')}</button>
          {/if}
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .task-bar {
    background: var(--color-nc-bg-panel);
    border-top: 1px solid var(--color-nc-border);
    font-size: 11px;
  }

  .task-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 10px;
    cursor: pointer;
    transition: background 0.15s;
  }

  .task-header:hover {
    background: var(--color-nc-bg-hover);
  }

  .task-indicator {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--color-nc-accent);
    font-weight: 500;
  }

  .header-stats {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .task-speed {
    color: var(--color-nc-text-bright);
    font-weight: 600;
  }

  .task-eta {
    color: var(--color-nc-text-dim);
  }

  .task-list {
    max-height: 240px;
    overflow-y: auto;
    border-top: 1px solid var(--color-nc-border);
    background: var(--color-nc-bg-deep);
  }

  .task-item {
    padding: 6px 10px;
    border-bottom: 1px solid var(--color-nc-border);
  }

  .task-item.failed {
    background: rgba(255, 68, 68, 0.05);
  }

  .task-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .task-status {
    width: 14px;
    text-align: center;
  }

  .task-type {
    text-transform: uppercase;
    font-weight: 600;
    color: var(--color-nc-text-dim);
    font-size: 9px;
    background: var(--color-nc-bg-header);
    padding: 1px 4px;
    border-radius: 2px;
  }

  .task-file {
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--color-nc-text-bright);
  }

  .task-progress-text {
    color: var(--color-nc-text-dim);
    font-family: var(--font-family-mono);
  }

  .task-cancel {
    background: none;
    border: none;
    color: var(--color-nc-text-dim);
    cursor: pointer;
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 2px;
  }

  .task-cancel:hover {
    background: rgba(255, 68, 68, 0.2);
    color: var(--color-nc-danger);
  }

  .progress-bar {
    height: 3px;
    background: var(--color-nc-bg-header);
    border-radius: 1px;
    margin-top: 4px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: var(--color-nc-accent);
    transition: width 0.15s ease-out;
  }

  .progress-fill.total {
    background: linear-gradient(90deg, var(--color-nc-accent-dim), var(--color-nc-accent));
  }

  .total-progress-container {
    padding: 6px 10px;
    border-bottom: 1px solid var(--color-nc-border);
    background: var(--color-nc-bg);
  }

  .task-error {
    color: var(--color-nc-danger);
    font-size: 10px;
    margin-top: 3px;
    padding-left: 22px;
    word-break: break-all;
  }

  .footer-actions {
    display: flex;
    justify-content: flex-end;
    padding: 6px 10px;
    background: var(--color-nc-bg-panel);
  }

  .task-clear {
    background: var(--color-nc-bg-header);
    border: 1px solid var(--color-nc-border-bright);
    color: var(--color-nc-text-bright);
    padding: 2px 8px;
    border-radius: 2px;
    cursor: pointer;
    font-size: 10px;
  }

  .task-clear:hover {
    background: var(--color-nc-bg-hover);
  }

  .pulse {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-nc-accent);
    animation: blink 1.2s infinite;
  }

  @keyframes blink {
    0% { opacity: 0.2; }
    50% { opacity: 1; }
    100% { opacity: 0.2; }
  }
</style>
