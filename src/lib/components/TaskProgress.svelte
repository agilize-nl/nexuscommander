<script lang="ts">
  import { taskList, taskCancel, taskClearFinished, resolveTaskConflict, type TaskInfo } from "$lib/ipc";
  import { formatSize } from "$lib/utils";
  import { _ } from "$lib/i18n";
  import { createSmartPoller } from "$lib/utils/smartPoller";

  let tasks: TaskInfo[] = $state([]);
  let collapsed = $state(true);
  let forcedVisible = $state(false);

  const poller = createSmartPoller({ poll: refreshTasks });

  $effect(() => {
    return () => poller.destroy();
  });

  async function refreshTasks(): Promise<boolean> {
    try {
      const newList = await taskList();
      // Keep collapsed state based on active tasks if it was true and now there are tasks
      if (collapsed && newList.some(t => t.status === "Running" || t.status === "WaitingForInput")) {
        // Option: auto-expand. For now let's stay collapsed unless user clicks.
      }
      tasks = newList;
      return newList.some(
        (t) => t.status === "Running" || t.status === "Queued" || t.status === "WaitingForInput"
      );
    } catch {
      // Silently ignore — might not be in Tauri context
      return false;
    }
  }

  export function notifyTaskStarted() {
    poller.kick();
  }

  export async function open() {
    await refreshTasks();
    poller.kick();
    forcedVisible = true;
    collapsed = false;
  }

  export async function toggle() {
    await refreshTasks();
    poller.kick();
    forcedVisible = true;
    collapsed = !collapsed;
  }

  async function handleCancel(id: string) {
    await taskCancel(id);
    await refreshTasks();
  }

  async function handleClear() {
    await taskClearFinished();
    await refreshTasks();
  }

  async function handleResolve(id: string, resolution: string) {
    await resolveTaskConflict(id, resolution);
    await refreshTasks();
  }

  function formatSpeed(bytesPerSec: number): string {
    if (!bytesPerSec || bytesPerSec === 0) return "";
    return `${formatSize(bytesPerSec)}/s`;
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
      case "Queued": return "⏳";
      case "Running": return "⚡";
      case "Completed": return "✅";
      case "Failed": return "❌";
      case "Cancelled": return "🚫";
      case "WaitingForInput": return "❓";
      default: return "•";
    }
  }

  function getProgressPercent(task: TaskInfo): number {
    if (task.total_bytes === 0) return 0;
    return Math.min(100, (task.transferred_bytes / task.total_bytes) * 100);
  }

  let activeTasks = $derived(
    tasks.filter((t) => t.status === "Running" || t.status === "Queued" || t.status === "WaitingForInput")
  );
  let hasAnyTasks = $derived(tasks.length > 0);
  // forcedVisible stays true forever once F9/open() has been used; only show
  // the empty bar while the user hasn't collapsed it, so F9-collapse with no
  // tasks running actually hides the "0 background transfers" bar.
  let isVisible = $derived(hasAnyTasks || (forcedVisible && !collapsed));
  let hasFinished = $derived(
    tasks.some(
      (t) => t.status === "Completed" || t.status === "Failed" || t.status === "Cancelled"
    )
  );

  // Auto-clear finished tasks after a short delay
  $effect(() => {
    const finishedSuccess = tasks.filter(t => t.status === "Completed");
    if (finishedSuccess.length > 0) {
      const timer = setTimeout(() => {
        handleClear();
      }, 1000);
      return () => clearTimeout(timer);
    }
    
    // For failed or cancelled tasks, maybe wait longer or require manual clear?
    // Let's clear cancelled ones after 5s, but keep failed ones for visibility.
    const finishedCancelled = tasks.filter(t => t.status === "Cancelled");
    if (finishedCancelled.length > 0) {
      const timer = setTimeout(() => {
        handleClear();
      }, 1000);
      return () => clearTimeout(timer);
    }
  });
</script>

{#if isVisible}
  <div class="task-bar">
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="task-header" onclick={() => (collapsed = !collapsed)}>
      <span class="task-indicator">
        {#if activeTasks.length > 0}
          <span class="pulse"></span>
        {/if}
        {activeTasks.length > 0
          ? `${activeTasks.length} ${$_('tasks.running').toLowerCase()}`
          : `${tasks.length} ${$_('tasks.title').toLowerCase()}`}
      </span>
      <span class="task-toggle">{collapsed ? "▲" : "▼"}</span>
    </div>

    {#if !collapsed}
      <div class="task-list">
        {#if tasks.length === 0}
          <div class="task-empty">{$_('tasks.title')}</div>
        {/if}
        {#each tasks as task}
          <div class="task-item" class:failed={task.status === "Failed"}>
            <div class="task-row">
              <span class="task-status">{getStatusIcon(task.status)}</span>
              <span class="task-type">{task.task_type}</span>
              <span class="task-file">{task.current_file || "—"}</span>
              
              {#if task.status === "Running"}
                <span class="task-stats">
                  <span class="task-speed">{formatSpeed(task.speed_bytes_per_sec)}</span>
                  <span class="task-eta">{formatETA(task.eta_seconds)}</span>
                </span>
              {/if}

              <span class="task-progress-text">
                {task.processed_files}/{task.total_files}
              </span>
              {#if task.status === "Running" || task.status === "Queued" || task.status === "WaitingForInput"}
                <button class="task-cancel" onclick={() => handleCancel(task.id)} title={$_('tasks.cancel_task')}>
                  ✕
                </button>
              {/if}
            </div>

            {#if task.status === "WaitingForInput"}
              <div class="task-conflict">
                <div class="conflict-msg">{$_('tasks.conflict_file')} <strong>{task.pending_conflict}</strong></div>
                <div class="conflict-actions">
                  <button onclick={() => handleResolve(task.id, "overwrite")}>{$_('tasks.overwrite')}</button>
                  <button onclick={() => handleResolve(task.id, "skip")}>{$_('tasks.skip')}</button>
                  <button onclick={() => handleResolve(task.id, "overwrite_all")}>{$_('tasks.overwrite_all')}</button>
                  <button onclick={() => handleResolve(task.id, "skip_all")}>{$_('tasks.skip_all')}</button>
                </div>
              </div>
            {/if}

            {#if task.status === "Running" || task.status === "WaitingForInput" || task.status === "Completed"}
              <div class="progress-bar">
                <div
                  class="progress-fill"
                  style="width: {getProgressPercent(task)}%"
                  class:waiting={task.status === "WaitingForInput"}
                ></div>
              </div>
            {/if}
            {#if task.error}
              <div class="task-error">{task.error}</div>
            {/if}
          </div>
        {/each}
        {#if hasFinished}
          <button class="task-clear" onclick={handleClear}>{$_('tasks.clear_all')}</button>
        {/if}
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

  .task-empty {
    padding: 8px 10px;
    color: var(--color-nc-text-dim);
  }

  .pulse {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-nc-accent);
    animation: pulse 1.2s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.5; transform: scale(0.8); }
  }

  .task-toggle {
    color: var(--color-nc-text-dim);
    font-size: 9px;
  }

  .task-list {
    border-top: 1px solid var(--color-nc-border);
    max-height: 200px;
    overflow-y: auto;
  }

  .task-item {
    padding: 6px 10px;
    border-bottom: 1px solid var(--color-nc-border);
  }

  .task-item.failed {
    background: rgba(255, 60, 60, 0.05);
  }

  .task-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .task-status { font-size: 12px; }

  .task-type {
    font-weight: 600;
    color: var(--color-nc-text);
    text-transform: uppercase;
    font-size: 10px;
    letter-spacing: 0.05em;
  }

  .task-file {
    flex: 1;
    color: var(--color-nc-text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .task-progress-text {
    color: var(--color-nc-text-dim);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    width: 60px;
    text-align: right;
  }

  .task-stats {
    display: flex;
    gap: 10px;
    color: var(--color-nc-accent);
    font-variant-numeric: tabular-nums;
    font-size: 10px;
    white-space: nowrap;
  }

  .task-eta {
    color: var(--color-nc-text-dim);
    min-width: 40px;
    text-align: right;
  }

  .task-cancel {
    background: transparent;
    border: 1px solid var(--color-nc-border);
    color: var(--color-nc-text-dim);
    font-size: 10px;
    cursor: pointer;
    border-radius: 2px;
    width: 18px;
    height: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s;
  }

  .task-cancel:hover {
    background: var(--color-nc-danger);
    color: white;
    border-color: var(--color-nc-danger);
  }

  .progress-bar {
    height: 3px;
    background: var(--color-nc-bg);
    border-radius: 2px;
    margin-top: 4px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--color-nc-accent-dim), var(--color-nc-accent));
    border-radius: 2px;
    transition: width 0.3s ease;
  }

  .progress-fill.waiting {
    background: linear-gradient(90deg, #f59e0b, #d97706);
    animation: pulse-orange 1.5s infinite;
  }

  @keyframes pulse-orange {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.7; }
  }

  .task-conflict {
    margin-top: 6px;
    padding: 6px;
    background: rgba(245, 158, 11, 0.1);
    border: 1px solid rgba(245, 158, 11, 0.2);
    border-radius: 4px;
  }

  .conflict-msg {
    margin-bottom: 6px;
    color: #fbbf24;
  }

  .conflict-actions {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }

  .conflict-actions button {
    background: var(--color-nc-bg-panel);
    border: 1px solid var(--color-nc-border);
    color: var(--color-nc-text);
    padding: 2px 8px;
    font-size: 10px;
    border-radius: 2px;
    cursor: pointer;
    transition: all 0.15s;
  }

  .conflict-actions button:hover {
    background: var(--color-nc-accent);
    color: white;
    border-color: var(--color-nc-accent);
  }

  .task-error {
    color: var(--color-nc-danger);
    font-size: 10px;
    margin-top: 3px;
    padding-left: 20px;
  }

  .task-clear {
    display: block;
    width: 100%;
    padding: 5px;
    background: transparent;
    border: none;
    color: var(--color-nc-text-dim);
    font-size: 11px;
    cursor: pointer;
    transition: all 0.15s;
  }

  .task-clear:hover {
    background: var(--color-nc-bg-hover);
    color: var(--color-nc-accent);
  }
</style>
