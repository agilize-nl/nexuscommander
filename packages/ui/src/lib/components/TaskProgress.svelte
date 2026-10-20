<script lang="ts">
  import {
    taskList,
    taskCancel,
    taskPause,
    taskResume,
    taskClearFinished,
    resolveTaskConflict,
    hasCapability,
    type TaskInfo
  } from "../ipc";
  import { formatSize } from "../utils";
  import { taskConflictActive } from "../stores";
  import { _ } from "../i18n";
  import { createSmartPoller } from "../utils/smartPoller";
  import { describeTaskError } from "../taskErrors";
  import { scale, fade } from "svelte/transition";

  let {
    onpermissiondenied,
    canelevate = () => true,
  }: {
    /**
     * Offered on a task that failed with `permission_denied`. The shells
     * escalate differently — desktop restarts through pkexec, web replays the
     * operation through sudo — so this is a callback, not a capability.
     */
    onpermissiondenied?: (task: TaskInfo) => void;
    /** Whether this shell can escalate this particular task at all. */
    canelevate?: (task: TaskInfo) => boolean;
  } = $props();

  let tasks: TaskInfo[] = $state([]);
  let collapsed = $state(false); // Modal visible by default when active tasks exist
  let forcedVisible = $state(false);
  let showViewAll = $state(false);
  let selectedTaskId = $state<string | null>(null);

  const canPause = hasCapability("taskPause");

  const poller = createSmartPoller({ poll: refreshTasks });

  $effect(() => {
    // Kick on mount so already-running tasks (e.g. started elsewhere, or
    // still in flight after a desktop app restart) surface without the
    // user having to press F9 first. Harmless on web: the bar only
    // becomes visible once a real task exists or open()/toggle() has run.
    poller.kick();
    return () => poller.destroy();
  });

  async function refreshTasks(): Promise<boolean> {
    try {
      const newList = await taskList();
      tasks = newList;
      return newList.some(
        (t) => t.status === "Running" || t.status === "Queued" || t.status === "WaitingForInput" || t.status === "Paused"
      );
    } catch {
      // Silently ignore — might not be in Tauri context
      return false;
    }
  }

  export function notifyTaskStarted() {
    poller.kick();
    collapsed = false; // Show modal when task starts
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
    try {
      await taskCancel(id);
      await refreshTasks();
    } finally {
      // A normal task start may show the dialog automatically. Once the user
      // cancels it, do not keep a finished-task view forced open.
      forcedVisible = false;
    }
  }

  function handleClose(task: TaskInfo) {
    if (task.status === "Completed" || task.status === "Failed" || task.status === "Cancelled") {
      // A finished task cannot be cancelled. Failed tasks are retained so the
      // error can be reviewed or cleared later, but must not keep the modal
      // open and block the file panels.
      collapsed = true;
      forcedVisible = false;
      return;
    }
    void handleCancel(task.id);
  }

  async function handleTogglePause(task: TaskInfo) {
    if (task.status === "Paused") {
      await taskResume(task.id);
    } else if (task.status === "Running") {
      await taskPause(task.id);
    }
    await refreshTasks();
  }

  // The automatic sweep keeps failed tasks so their error can be read; the
  // user's own "Clear finished" dismisses them too.
  async function handleClear(includeFailed = false) {
    await taskClearFinished(includeFailed);
    await refreshTasks();
  }

  async function handleResolve(id: string, resolution: string) {
    await resolveTaskConflict(id, resolution);
    await refreshTasks();
  }

  function formatSpeed(bytesPerSec: number): string {
    if (!bytesPerSec || bytesPerSec === 0) return "0 B/s";
    return `${formatSize(bytesPerSec)}/s`;
  }

  function formatETA(seconds: number): string {
    if (!seconds || seconds === 0) return "00:00:00";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    const pad = (n: number) => n.toString().padStart(2, "0");
    if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`;
    return `00:${pad(m)}:${pad(s)}`;
  }

  function getActionTitle(task: TaskInfo): string {
    switch (task.task_type) {
      case "Copy": return $_("tasks.copying");
      case "Move": return $_("tasks.moving");
      case "Delete": return $_("tasks.deleting");
      default: return $_("tasks.processing");
    }
  }

  function getTypeLabel(task: TaskInfo): string {
    return $_(`tasks.type.${task.task_type.toLowerCase()}`);
  }

  function getStatusLabel(task: TaskInfo): string {
    return $_(`tasks.status.${task.status.toLowerCase()}`);
  }

  function isFinished(task: TaskInfo): boolean {
    return task.status === "Completed" || task.status === "Failed" || task.status === "Cancelled";
  }

  // "0% Deleting" over a task that already failed read as if it were still
  // running. A finished task says what it was and how it ended instead.
  function getTitle(task: TaskInfo): string {
    if (isFinished(task)) return `${getTypeLabel(task)} — ${getStatusLabel(task)}`;
    return `${getOverallPercent(task)}% ${getActionTitle(task)}`;
  }

  function getOverallPercent(task: TaskInfo): number {
    if (task.total_bytes > 0) {
      return Math.min(100, Math.round((task.transferred_bytes / task.total_bytes) * 100));
    }
    if (task.total_files > 0) {
      return Math.min(100, Math.round((task.processed_files / task.total_files) * 100));
    }
    return 0;
  }

  // The two backends name the same number differently — desktop reports
  // `current_file_bytes`, web `current_file_transferred_bytes` — and this
  // component read only the desktop spelling while gating on a field only web
  // sets, so the per-file line sat at "0 / N (0%)" for the whole transfer on
  // web and never appeared at all on desktop.
  function currentFileBytes(task: TaskInfo): number {
    return task.current_file_bytes ?? task.current_file_transferred_bytes ?? 0;
  }

  function currentFileTotalBytes(task: TaskInfo): number {
    return task.current_file_total_bytes ?? 0;
  }

  function getCurrentFilePercent(task: TaskInfo): number {
    if (currentFileTotalBytes(task) > 0) {
      return Math.min(100, Math.round((currentFileBytes(task) / currentFileTotalBytes(task)) * 100));
    }
    if (task.total_files > 0) {
      return Math.min(100, Math.round((task.processed_files / task.total_files) * 100));
    }
    return 0;
  }

  let activeTasks = $derived(
    tasks.filter((t) => t.status === "Running" || t.status === "Queued" || t.status === "WaitingForInput" || t.status === "Paused")
  );
  let primaryTask = $derived(
    (selectedTaskId ? tasks.find((t) => t.id === selectedTaskId) : null) ||
    activeTasks[0] ||
    tasks[tasks.length - 1]
  );
  let hasActive = $derived(activeTasks.length > 0);
  // A task that failed is kept until the user clears it (see the auto-clear
  // effect below), so it must also make the panel visible on its own. An
  // operation can fail in less than one poll interval — a folder move the
  // engine refuses, a permission error — in which case no active task is ever
  // observed, and gating purely on `hasActive` meant the error was set on the
  // task record and never shown to anyone. Only *failed* tasks force the panel
  // open: completed and cancelled ones stay silent, so this does not turn the
  // dialog into a popup after every successful copy.
  let hasFailed = $derived(tasks.some((t) => t.status === "Failed"));
  // Recent tasks remain available when the user explicitly opens the task
  // view, but the automatic transfer dialog only belongs to active work.
  let isVisible = $derived(hasActive || hasFailed || forcedVisible);

  let conflictingTask = $derived(tasks.find(t => t.status === "WaitingForInput"));

  // Tell the shells a modal is up, so panel keyboard navigation stops while
  // the user is being asked an irreversible question.
  $effect(() => {
    taskConflictActive.set(!!conflictingTask);
    return () => taskConflictActive.set(false);
  });

  /**
   * The button that gets focus when the conflict dialog appears.
   *
   * It is bound to the *safest* resolution, not the visually primary one: keep
   * both for a file (the only answer that cannot lose data), skip for a
   * directory (where merging is the primary and there is no keep-both). The
   * dialog used to open with focus still on whatever was behind it, so the
   * first Enter or Space went somewhere unrelated — and every button here
   * decides what happens to someone's file.
   */
  let conflictFocusTarget = $state<HTMLButtonElement | undefined>();

  $effect(() => {
    if (conflictingTask) conflictFocusTarget?.focus();
  });

  let hasFinished = $derived(
    tasks.some((t) => t.status === "Completed" || t.status === "Failed" || t.status === "Cancelled")
  );
  let primaryIsFinished = $derived(!!primaryTask && isFinished(primaryTask));
  let primaryError = $derived(
    primaryTask?.status === "Failed" && (primaryTask.error || primaryTask.error_kind)
      ? describeTaskError(primaryTask, $_)
      : null
  );
  let primaryCanElevate = $derived(
    !!primaryError &&
      primaryError.kind === "permission_denied" &&
      !!onpermissiondenied &&
      canelevate(primaryTask)
  );
  let primaryIsPausable = $derived(
    canPause && !!primaryTask && (primaryTask.status === "Running" || primaryTask.status === "Paused")
  );

  // Auto-clear successfully finished / cancelled tasks after a short delay.
  // Failed tasks stay until the user clears them, so errors remain visible.
  $effect(() => {
    const autoClearable = tasks.some((t) => t.status === "Completed" || t.status === "Cancelled");
    if (autoClearable) {
      const timer = setTimeout(() => {
        handleClear();
      }, 1000);
      return () => clearTimeout(timer);
    }
  });

  function truncatePath(path: string | undefined, maxLen = 65): string {
    if (!path) return "—";
    if (path.length <= maxLen) return path;
    return "..." + path.slice(-(maxLen - 3));
  }
</script>

{#if conflictingTask}
  <div class="conflict-overlay" transition:fade={{ duration: 150 }}>
    <div
      class="task-conflict popup-dialog"
      transition:scale={{ duration: 150, start: 0.95 }}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="nc-conflict-title"
      aria-describedby="nc-conflict-filename"
    >
      <div class="conflict-title" id="nc-conflict-title">
        {conflictingTask.conflict_is_dir ? $_("tasks.conflict_dir") : $_("tasks.conflict_file")}
      </div>
      <div class="conflict-filename" id="nc-conflict-filename">{conflictingTask.pending_conflict}</div>
      <div class="conflict-actions">
        {#if conflictingTask.conflict_is_dir}
          <button class="primary" onclick={() => handleResolve(conflictingTask!.id, "overwrite")}>{$_("tasks.merge")}</button>
          <button onclick={() => handleResolve(conflictingTask!.id, "overwrite_all")}>{$_("tasks.merge_all")}</button>
        {:else}
          <button class="primary" onclick={() => handleResolve(conflictingTask!.id, "overwrite")}>{$_("tasks.overwrite")}</button>
          <button onclick={() => handleResolve(conflictingTask!.id, "overwrite_all")}>{$_("tasks.overwrite_all")}</button>
        {/if}
        <!-- P1.6: keep-both is the only resolution that cannot lose data, so it
             sits ahead of skip. Directories merge rather than duplicate, so it is
             offered for file conflicts only. -->
        {#if !conflictingTask.conflict_is_dir}
          <button bind:this={conflictFocusTarget} onclick={() => handleResolve(conflictingTask!.id, "keep_both")}>{$_("tasks.keep_both")}</button>
          <button onclick={() => handleResolve(conflictingTask!.id, "keep_both_all")}>{$_("tasks.keep_both_all")}</button>
          <button onclick={() => handleResolve(conflictingTask!.id, "skip")}>{$_("tasks.skip")}</button>
        {:else}
          <button bind:this={conflictFocusTarget} onclick={() => handleResolve(conflictingTask!.id, "skip")}>{$_("tasks.skip")}</button>
        {/if}
        <button onclick={() => handleResolve(conflictingTask!.id, "skip_all")}>{$_("tasks.skip_all")}</button>
        <button class="danger" onclick={() => handleCancel(conflictingTask!.id)}>{$_("tasks.cancel")}</button>
      </div>
    </div>
  </div>
{/if}

{#if isVisible}
  {#if !collapsed && primaryTask}
    <div class="modal-backdrop" transition:fade={{ duration: 150 }}>
      <div class="transfer-dialog" transition:scale={{ duration: 180, start: 0.94 }}>

        <!-- Header -->
        <div class="dialog-header">
          <div class="dialog-title">
            {getTitle(primaryTask)}
          </div>
          <div class="dialog-controls">
            <button class="win-btn minimize" onclick={() => (collapsed = true)} title={$_("tasks.minimize_to_panel")}>
              ─
            </button>
            <button
              class="win-btn maximize"
              class:active={showViewAll}
              onclick={() => (showViewAll = !showViewAll)}
              title={$_("tasks.view_all_tasks")}
            >
              {showViewAll ? "⤓" : "⤢"}
            </button>
            <button class="win-btn close" onclick={() => handleClose(primaryTask)} title={primaryIsFinished ? $_("tasks.minimize_to_panel") : $_("tasks.cancel_operation")}>
              ✕
            </button>
          </div>
        </div>

        {#if showViewAll}
          <!-- Tasks list view -->
          <div class="view-all-list">
            <div class="list-title-row">
              <span class="list-title">{$_("tasks.active_recent", { n: tasks.length })}</span>
              {#if hasFinished}
                <button class="list-clear-btn" onclick={() => handleClear(true)}>{$_("tasks.clear_finished")}</button>
              {/if}
            </div>
            {#if tasks.length === 0}
              <div class="empty-tasks-msg">{$_("tasks.empty")}</div>
            {:else}
              {#each tasks as task}
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <div
                  class="task-list-row"
                  class:active={task.id === primaryTask?.id}
                  onclick={() => (selectedTaskId = task.id)}
                  role="button"
                  tabindex="0"
                  onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { selectedTaskId = task.id; } }}
                >
                  <span class="task-badge">{getTypeLabel(task)}</span>
                  <span class="task-status-badge status-{task.status.toLowerCase()}">{getStatusLabel(task)}</span>
                  <span class="task-name" title={task.current_file || task.target || task.sources?.[0]}>
                    {task.current_file || (task.sources && task.sources.length > 1 ? $_("tasks.items", { n: task.sources.length }) : task.sources?.[0]) || task.target}
                  </span>
                  <span class="task-pct">{getOverallPercent(task)}%</span>
                  {#if task.status === "Running" || task.status === "Queued" || task.status === "WaitingForInput" || task.status === "Paused"}
                    <button
                      class="task-row-cancel"
                      onclick={(e) => { e.stopPropagation(); handleCancel(task.id); }}
                      title={$_("tasks.cancel_operation")}
                    >✕</button>
                  {/if}
                </div>
              {/each}
            {/if}
          </div>
        {/if}

        <!-- Details Body -->
        <div class="dialog-body">
          <div class="info-row">
            <span class="info-label">{$_("tasks.from")}</span>
            <span class="info-value" title={primaryTask.sources?.join(', ') || primaryTask.current_file}>
              {#if primaryTask.sources && primaryTask.sources.length > 1}
                {truncatePath(primaryTask.sources[0])} <span class="more-sources-tag">({$_("dialog.more_items", { n: primaryTask.sources.length - 1 })})</span>
              {:else}
                {truncatePath(primaryTask.sources?.[0] || primaryTask.current_file)}
              {/if}
            </span>
          </div>

          {#if primaryTask.task_type !== "Delete"}
            <div class="info-row">
              <span class="info-label">{$_("tasks.to")}</span>
              <span class="info-value" title={primaryTask.target}>
                {truncatePath(primaryTask.target)}
              </span>
            </div>
          {/if}

          {#if showViewAll && primaryTask.sources && primaryTask.sources.length > 1}
            <div class="sources-preview-box">
              <div class="sources-preview-title">
                {$_("dialog.files", { n: primaryTask.sources.length }) || `Files (${primaryTask.sources.length})`}:
              </div>
              <div class="sources-preview-list">
                {#each primaryTask.sources as src}
                  <div class="sources-preview-item" title={src}>{truncatePath(src, 55)}</div>
                {/each}
              </div>
            </div>
          {/if}

          <!-- Speed, ETA and the per-file bar describe work in progress; on a
               finished task they only showed "0 B/s, 00:00:00" next to an error. -->
          {#if !primaryIsFinished}
            <div class="info-row speed-row">
              <span>{$_("tasks.speed_eta", { speed: formatSpeed(primaryTask.speed_bytes_per_sec), eta: formatETA(primaryTask.eta_seconds) })}</span>
            </div>

            <!-- Current File Progress Bar (Top Pill) -->
            <div class="pill-progress-track">
              <div
                class="pill-progress-fill"
                style="width: {getCurrentFilePercent(primaryTask)}%"
                class:paused={primaryTask.status === "Paused"}
              ></div>
              <span class="pill-progress-label">
                {#if currentFileTotalBytes(primaryTask) > 0}
                  {formatSize(currentFileBytes(primaryTask))}/{formatSize(currentFileTotalBytes(primaryTask))} ({getCurrentFilePercent(primaryTask)}%)
                {:else}
                  {formatSize(primaryTask.transferred_bytes)} ({getCurrentFilePercent(primaryTask)}%)
                {/if}
              </span>
            </div>
          {/if}

          <!-- Overall Progress Bar (Bottom Pill) -->
          <div class="pill-progress-track">
            <div
              class="pill-progress-fill"
              style="width: {getOverallPercent(primaryTask)}%"
              class:paused={primaryTask.status === "Paused"}
            ></div>
            <span class="pill-progress-label">
              {#if primaryTask.total_bytes > 0}
                {formatSize(primaryTask.transferred_bytes)}/{formatSize(primaryTask.total_bytes)} ({getOverallPercent(primaryTask)}%)
              {:else}
                {primaryTask.processed_files} / {primaryTask.total_files} ({getOverallPercent(primaryTask)}%)
              {/if}
            </span>
          </div>

          {#if primaryError}
            <div class="task-error-box" role="alert">
              <div class="task-error-msg">{primaryError.message}</div>
              <div class="task-error-hint">{primaryError.hint}</div>
              {#if primaryTask.processed_files > 0}
                <div class="task-error-hint">
                  {$_("tasks.error_partial", { done: primaryTask.processed_files, total: primaryTask.total_files })}
                </div>
              {/if}
              {#if primaryCanElevate}
                <button class="footer-btn task-error-action" onclick={() => onpermissiondenied?.(primaryTask)}>
                  {$_("tasks.elevate")}
                </button>
              {/if}
              {#if primaryError.detail}
                <details class="task-error-details">
                  <summary>{$_("tasks.error_details")}</summary>
                  <code>{primaryError.detail}</code>
                </details>
              {/if}
            </div>
          {/if}
        </div>

        <!-- Footer Actions Bar -->
        <div class="dialog-footer">
          <div class="footer-left">
            <button class="footer-btn to-panel-btn" onclick={() => (collapsed = true)}>
              {$_("tasks.to_panel")}
            </button>
            <button
              class="footer-btn view-all-btn"
              class:active={showViewAll}
              onclick={() => (showViewAll = !showViewAll)}
            >
              {$_("tasks.view_all")}
            </button>
          </div>

          <div class="footer-center">
            {primaryTask.processed_files} / {primaryTask.total_files || 1}
          </div>

          <div class="footer-right">
            {#if primaryIsFinished}
              <button class="footer-btn cancel-btn" onclick={() => handleClear(true)}>
                {$_("tasks.clear_finished")}
              </button>
            {:else}
              <button class="footer-btn cancel-btn" onclick={() => handleCancel(primaryTask.id)}>
                ✕ {$_("tasks.cancel")}
              </button>
            {/if}
            {#if primaryIsPausable}
              <button
                class="footer-btn pause-btn"
                onclick={() => handleTogglePause(primaryTask)}
                title={primaryTask.status === "Paused" ? $_("tasks.resume") : $_("tasks.pause")}
              >
                {primaryTask.status === "Paused" ? "▶" : "⏸"}
              </button>
            {/if}
          </div>
        </div>

      </div>
    </div>
  {:else}
    <!-- Collapsed Bottom Panel Dock Bar -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="task-dock-bar" onclick={() => (collapsed = false)}>
      <div class="dock-left">
        {#if hasActive}
          <span class="pulse-indicator"></span>
        {/if}
        <span class="dock-title">
          {#if primaryTask}
            {getTitle(primaryTask)} — {primaryTask.current_file || primaryTask.target}
          {:else}
            {$_("tasks.count", { n: tasks.length })}
          {/if}
        </span>
      </div>
      <div class="dock-right">
        {#if hasActive && primaryTask}
          <span class="dock-speed">{formatSpeed(primaryTask.speed_bytes_per_sec)}</span>
        {/if}
        <button class="dock-expand-btn" onclick={(e) => { e.stopPropagation(); collapsed = false; }}>
          ▲
        </button>
      </div>
    </div>
  {/if}
{/if}

<style>
  /* ----- Modal Backdrop & Window Container ----- */
  .modal-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.35);
    backdrop-filter: blur(2px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
  }

  .transfer-dialog {
    width: 480px;
    max-width: 92vw;
    background: color-mix(in srgb, var(--color-nc-bg-panel) 94%, var(--color-nc-accent) 6%);
    border: 1px solid color-mix(in srgb, var(--color-nc-border) 80%, var(--color-nc-accent) 20%);
    border-radius: 14px;
    box-shadow: 0 12px 36px rgba(0, 0, 0, 0.3);
    color: var(--color-nc-text);
    font-family: inherit;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    user-select: none;
  }

  /* ----- Header ----- */
  .dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px 6px 14px;
    position: relative;
  }

  .dialog-title {
    flex: 1;
    text-align: center;
    font-weight: 700;
    font-size: 15px;
    letter-spacing: -0.01em;
    color: var(--color-nc-text);
  }

  .dialog-controls {
    display: flex;
    align-items: center;
    gap: 6px;
    position: absolute;
    right: 12px;
    top: 10px;
  }

  .win-btn {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: none;
    background: color-mix(in srgb, var(--color-nc-text) 10%, transparent);
    color: var(--color-nc-text-dim);
    font-size: 11px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all 0.15s ease;
    line-height: 1;
    padding: 0;
  }

  .win-btn:hover {
    background: color-mix(in srgb, var(--color-nc-text) 20%, transparent);
    color: var(--color-nc-text);
  }

  .win-btn.close:hover {
    background: #ef4444;
    color: #ffffff;
  }

  /* ----- Details Body ----- */
  .dialog-body {
    padding: 8px 18px 14px 18px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
  }

  .info-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    color: var(--color-nc-text);
    line-height: 1.35;
  }

  .info-label {
    font-weight: 500;
    color: var(--color-nc-text-dim);
    min-width: 42px;
  }

  .info-value {
    font-family: monospace;
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-nc-text);
  }

  .speed-row {
    margin-top: 2px;
    font-size: 13px;
    color: var(--color-nc-text-dim);
    font-variant-numeric: tabular-nums;
  }

  /* ----- Pill Progress Bars ----- */
  .pill-progress-track {
    position: relative;
    height: 24px;
    border-radius: 12px;
    background: color-mix(in srgb, var(--color-nc-text) 12%, var(--color-nc-bg-panel));
    overflow: hidden;
    margin-top: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.1);
  }

  .pill-progress-fill {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    border-radius: 12px;
    background: var(--color-nc-accent, #1890ff);
    transition: width 0.25s ease-out;
  }

  .pill-progress-fill.paused {
    background: #f59e0b;
  }

  .pill-progress-label {
    position: relative;
    z-index: 1;
    font-size: 12px;
    font-weight: 500;
    color: var(--color-nc-text);
    font-variant-numeric: tabular-nums;
    text-shadow: 0 0 3px color-mix(in srgb, var(--color-nc-bg-panel) 80%, transparent);
  }

  /* ----- Task Error ----- */
  .task-error-box {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 4px;
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid color-mix(in srgb, var(--color-nc-danger) 45%, transparent);
    background: color-mix(in srgb, var(--color-nc-danger) 8%, var(--color-nc-bg-panel));
    user-select: text;
  }

  .task-error-msg {
    color: var(--color-nc-danger);
    font-size: 12px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .task-error-hint {
    color: var(--color-nc-text);
    font-size: 12px;
  }

  .task-error-action {
    align-self: flex-start;
    margin-top: 2px;
    border-color: var(--color-nc-accent);
  }

  .task-error-details {
    font-size: 11px;
    color: var(--color-nc-text-dim);
  }

  .task-error-details summary {
    cursor: pointer;
  }

  .task-error-details code {
    display: block;
    margin-top: 4px;
    font-family: monospace;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .win-btn.maximize.active {
    color: var(--color-nc-accent);
  }

  .view-all-btn.active {
    background: color-mix(in srgb, var(--color-nc-accent) 22%, var(--color-nc-bg-panel));
    border-color: var(--color-nc-accent);
    color: var(--color-nc-text-bright);
  }

  /* ----- View All List ----- */
  .view-all-list {
    padding: 8px 18px;
    border-bottom: 1px solid var(--color-nc-border);
    max-height: 140px;
    overflow-y: auto;
    background: color-mix(in srgb, var(--color-nc-bg) 50%, transparent);
  }

  .list-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 4px;
    gap: 8px;
  }

  .list-title {
    font-size: 11px;
    font-weight: 600;
    color: var(--color-nc-text-dim);
    text-transform: uppercase;
  }

  .list-clear-btn {
    background: transparent;
    border: none;
    color: var(--color-nc-accent);
    font-size: 10px;
    cursor: pointer;
    padding: 0;
    white-space: nowrap;
  }

  .list-clear-btn:hover {
    text-decoration: underline;
  }

  .task-list-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    padding: 4px 8px;
    border-radius: 4px;
    cursor: pointer;
    transition: background 0.15s ease;
    user-select: none;
  }

  .task-list-row:hover {
    background: color-mix(in srgb, var(--color-nc-accent) 10%, transparent);
  }

  .task-list-row.active {
    background: color-mix(in srgb, var(--color-nc-accent) 20%, transparent);
    outline: 1px solid color-mix(in srgb, var(--color-nc-accent) 40%, transparent);
  }

  .task-badge {
    font-weight: 700;
    font-size: 10px;
    text-transform: uppercase;
    color: var(--color-nc-accent);
  }

  .task-status-badge {
    font-size: 9px;
    font-weight: 600;
    text-transform: uppercase;
    padding: 1px 4px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--color-nc-text) 10%, transparent);
    color: var(--color-nc-text-dim);
  }

  .task-status-badge.status-running {
    background: color-mix(in srgb, var(--color-nc-accent) 20%, transparent);
    color: var(--color-nc-accent);
  }

  .task-status-badge.status-paused {
    background: color-mix(in srgb, #f59e0b 20%, transparent);
    color: #f59e0b;
  }

  .task-status-badge.status-waitingforinput {
    background: color-mix(in srgb, #ec4899 20%, transparent);
    color: #ec4899;
  }

  .task-status-badge.status-completed {
    background: color-mix(in srgb, #10b981 20%, transparent);
    color: #10b981;
  }

  .task-status-badge.status-failed {
    background: color-mix(in srgb, var(--color-nc-danger, #ef4444) 20%, transparent);
    color: var(--color-nc-danger, #ef4444);
  }

  .task-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .task-pct {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }

  .task-row-cancel {
    background: transparent;
    border: none;
    color: var(--color-nc-text-dim);
    cursor: pointer;
  }

  .task-row-cancel:hover {
    color: var(--color-nc-danger, #ef4444);
  }

  .more-sources-tag {
    font-size: 11px;
    color: var(--color-nc-text-dim);
    margin-left: 4px;
  }

  .sources-preview-box {
    margin-top: 6px;
    background: color-mix(in srgb, var(--color-nc-bg) 60%, transparent);
    border: 1px solid var(--color-nc-border);
    border-radius: 6px;
    padding: 6px 8px;
    max-height: 80px;
    overflow-y: auto;
  }

  .sources-preview-title {
    font-size: 10px;
    font-weight: 600;
    color: var(--color-nc-text-dim);
    text-transform: uppercase;
    margin-bottom: 4px;
  }

  .sources-preview-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .sources-preview-item {
    font-family: monospace;
    font-size: 11px;
    color: var(--color-nc-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .empty-tasks-msg {
    padding: 8px 0;
    text-align: center;
    font-size: 11px;
    color: var(--color-nc-text-dim);
  }

  /* ----- Footer Actions ----- */
  .dialog-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 18px 14px 18px;
    font-size: 12px;
  }

  .footer-left, .footer-right {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .footer-center {
    font-weight: 500;
    color: var(--color-nc-text);
    font-variant-numeric: tabular-nums;
  }

  .footer-btn {
    background: color-mix(in srgb, var(--color-nc-text) 10%, var(--color-nc-bg-panel));
    border: 1px solid transparent;
    color: var(--color-nc-text);
    padding: 4px 12px;
    font-size: 12px;
    font-weight: 500;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.15s ease;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    min-height: 28px;
  }

  .to-panel-btn {
    border: 1px dotted var(--color-nc-text-dim);
    background: color-mix(in srgb, var(--color-nc-text) 6%, var(--color-nc-bg-panel));
  }

  .footer-btn:hover {
    background: color-mix(in srgb, var(--color-nc-text) 18%, var(--color-nc-bg-panel));
    color: var(--color-nc-text);
  }

  .to-panel-btn:hover {
    border-color: var(--color-nc-accent);
    color: var(--color-nc-accent);
  }

  .cancel-btn:hover {
    background: color-mix(in srgb, var(--color-nc-danger, #ef4444) 15%, var(--color-nc-bg-panel));
    color: var(--color-nc-danger, #ef4444);
  }

  .pause-btn {
    min-width: 32px;
    padding: 4px 8px;
  }

  /* ----- Conflict Overlay ----- */
  .conflict-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(3px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10005;
  }

  .task-conflict.popup-dialog {
    padding: 18px 24px;
    background: var(--color-nc-bg-panel);
    border: 1px solid var(--color-nc-border);
    border-radius: 12px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
    min-width: 380px;
    max-width: 520px;
  }

  .conflict-title {
    color: var(--color-nc-text-dim);
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    text-align: center;
  }

  .conflict-filename {
    margin: 4px 0 14px;
    color: var(--color-nc-text);
    font-size: 13px;
    font-weight: 500;
    text-align: center;
    line-height: 1.4;
    word-break: break-all;
  }

  .conflict-actions {
    display: flex;
    justify-content: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .conflict-actions button {
    background: color-mix(in srgb, var(--color-nc-text) 10%, var(--color-nc-bg-panel));
    border: 1px solid transparent;
    color: var(--color-nc-text);
    padding: 6px 14px;
    font-size: 12px;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.15s;
  }

  .conflict-actions button.primary {
    background: var(--color-nc-accent);
    color: #ffffff;
    font-weight: 600;
  }

  .conflict-actions button.danger {
    background: color-mix(in srgb, var(--color-nc-danger, #ef4444) 15%, var(--color-nc-bg-panel));
    color: var(--color-nc-danger, #ef4444);
  }

  .conflict-actions button:hover {
    filter: brightness(1.1);
  }

  /* ----- Bottom Panel Dock Bar (Minimized mode) ----- */
  .task-dock-bar {
    position: fixed;
    bottom: 24px;
    right: 24px;
    background: color-mix(in srgb, var(--color-nc-bg-panel) 92%, var(--color-nc-accent) 8%);
    border: 1px solid var(--color-nc-border);
    border-radius: 20px;
    padding: 6px 14px;
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 12px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
    cursor: pointer;
    z-index: 9990;
    transition: all 0.2s ease;
  }

  .task-dock-bar:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
    border-color: var(--color-nc-accent);
  }

  .dock-left {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .pulse-indicator {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--color-nc-accent);
    animation: pulse 1.2s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.4; transform: scale(0.85); }
  }

  .dock-title {
    font-weight: 600;
    color: var(--color-nc-text);
  }

  .dock-right {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--color-nc-text-dim);
  }

  .dock-speed {
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }

  .dock-expand-btn {
    background: transparent;
    border: none;
    color: var(--color-nc-text-dim);
    font-size: 10px;
    cursor: pointer;
    padding: 2px 4px;
  }
</style>
