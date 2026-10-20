<script lang="ts">
  import { downloadBatches, dismissDownload } from "$lib/download/downloadStore";
  import { formatSize } from "$lib/utils";
  import { _ } from "$lib/i18n";

  let batches = $derived($downloadBatches);
  let hasAnyBatches = $derived(batches.length > 0);
  let activeBatches = $derived(batches.filter((b) => b.status === "preparing" || b.status === "streaming"));
  let collapsed = $state(true);

  $effect(() => {
    if (activeBatches.length > 0) {
      collapsed = false;
    }
  });

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
      case "preparing": return "⏳";
      case "streaming": return "⚡";
      case "server_complete": return "✅";
      case "error": return "❌";
      default: return "•";
    }
  }

  function statusLabel(status: string): string {
    switch (status) {
      case "preparing": return $_('download.preparing');
      case "streaming": return $_('download.streaming');
      case "server_complete": return $_('download.server_completed');
      case "error": return $_('download.failed');
      default: return status;
    }
  }
</script>

{#if hasAnyBatches}
  <div class="task-bar">
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="task-header" onclick={() => (collapsed = !collapsed)}>
      <span class="task-indicator">
        {#if activeBatches.length > 0}
          <span class="pulse"></span>
        {/if}
        {activeBatches.length > 0
          ? `${activeBatches.length} ${$_('download.streaming').toLowerCase()}`
          : `${batches.length} ${$_('download.title').toLowerCase()}`}
      </span>
      <span class="header-stats">
        <span class="task-toggle">{collapsed ? "▲" : "▼"}</span>
      </span>
    </div>

    {#if !collapsed}
      <div class="task-list">
        {#each batches as batch}
          <div class="task-item" class:failed={batch.status === 'error'}>
            <div class="task-row">
              <span class="task-status">{getStatusIcon(batch.status)}</span>
              <span class="task-type">{$_('download.title')}</span>
              <span class="task-file" title={batch.name}>{batch.name}</span>

              {#if batch.status === 'streaming'}
                <span class="task-progress-text">
                  {formatSize(batch.readBytes)} / {formatSize(batch.totalBytes)}
                </span>
                <span class="task-speed">{formatSpeed(batch.speedBps)}</span>
                <span class="task-eta">{formatETA(batch.etaSeconds)}</span>
              {:else}
                <span class="task-progress-text">{statusLabel(batch.status)}</span>
              {/if}

              <button class="task-cancel" onclick={() => dismissDownload(batch.id)} title={$_('download.dismiss')}>✕</button>
            </div>

            {#if batch.status === 'streaming' && batch.totalBytes > 0}
              <div class="progress-bar">
                <div
                  class="progress-fill"
                  style="width: {Math.min(100, (batch.readBytes / batch.totalBytes) * 100)}%"
                ></div>
              </div>
            {/if}

            {#if batch.error}
              <div class="task-error">{batch.error}</div>
            {/if}
          </div>
        {/each}
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

  .task-error {
    color: var(--color-nc-danger);
    font-size: 10px;
    margin-top: 3px;
    padding-left: 22px;
    word-break: break-all;
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
