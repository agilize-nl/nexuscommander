<script lang="ts">
  import {
    clearTransferQueue,
    moveQueuedOperation,
    removeQueuedOperation,
    transferQueue,
    transferQueueRunningId,
    updateQueuedOperationTarget,
  } from "../stores";
  import { _ } from "../i18n";
  import { ListPlus, Trash2, ChevronUp, ChevronDown, XCircle, AlertTriangle } from "lucide-svelte";
  import { fade, scale } from "svelte/transition";

  interface Props {
    running?: boolean;
    onexecute: () => Promise<void>;
    onclose: () => void;
  }

  let props: Props = $props();
  let confirmPermanentDelete = $state(false);
  let submitting = $state(false);

  const permanentDeleteCount = $derived(
    $transferQueue.filter((operation) => operation.kind === "delete" && operation.target === "permanent").length
  );
  const executionDisabled = $derived(props.running || submitting || $transferQueue.length === 0);

  function updateTarget(id: string, event: Event) {
    updateQueuedOperationTarget(id, (event.currentTarget as HTMLInputElement).value);
  }

  function requestExecute() {
    if (executionDisabled) return;
    if (permanentDeleteCount > 0) {
      confirmPermanentDelete = true;
      return;
    }
    void execute();
  }

  async function execute() {
    if (executionDisabled) return;
    confirmPermanentDelete = false;
    submitting = true;
    try {
      await props.onexecute();
    } finally {
      submitting = false;
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (confirmPermanentDelete) confirmPermanentDelete = false;
      else props.onclose();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="queue-backdrop" role="presentation" onclick={props.onclose} transition:fade={{ duration: 150 }}>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="queue-dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="transfer-queue-title"
    onclick={(event) => event.stopPropagation()}
    transition:scale={{ start: 0.96, duration: 150 }}
  >
    <header>
      <div>
        <h2 id="transfer-queue-title">{$_("queue.title")}</h2>
        <p>{$_("queue.description")}</p>
      </div>
      <button class="icon-button" onclick={props.onclose} aria-label={$_("queue.close")}>×</button>
    </header>

    <div class="queue-list">
      {#if $transferQueue.length === 0}
        <div class="empty-state">
          <ListPlus size={28} />
          <p>{$_("queue.empty")}</p>
        </div>
      {:else}
        {#each $transferQueue as operation, index (operation.id)}
          <article class:running={$transferQueueRunningId === operation.id} class="queue-item">
            <div class="queue-order">{index + 1}</div>
            <div class="queue-content">
              <div class="queue-summary">
                <strong>{$_(`queue.kind_${operation.kind}`)}</strong>
                <span>{$_("queue.sources", { n: operation.sources.length })}</span>
              </div>
              <div class="source-list" title={operation.sources.join("\n")}>
                {operation.sources.slice(0, 2).join(", ")}{operation.sources.length > 2 ? ` +${operation.sources.length - 2}` : ""}
              </div>
              {#if operation.kind === "delete"}
                <div class:permanent={operation.target === "permanent"} class="delete-mode">
                  {operation.target === "permanent" ? $_("queue.delete_permanent") : $_("queue.delete_trash")}
                </div>
              {:else}
                <label class="target-field">
                  <span>{$_("queue.target")}</span>
                  <input
                    value={operation.target}
                    oninput={(event) => updateTarget(operation.id, event)}
                    disabled={props.running}
                    aria-label={$_("queue.target")}
                    spellcheck="false"
                  />
                </label>
              {/if}
            </div>
            <div class="queue-actions">
              <button class="icon-button" onclick={() => moveQueuedOperation(operation.id, -1)} disabled={props.running || index === 0} aria-label={$_("queue.move_up")}>
                <ChevronUp size={16} />
              </button>
              <button class="icon-button" onclick={() => moveQueuedOperation(operation.id, 1)} disabled={props.running || index === $transferQueue.length - 1} aria-label={$_("queue.move_down")}>
                <ChevronDown size={16} />
              </button>
              <button class="icon-button danger" onclick={() => removeQueuedOperation(operation.id)} disabled={props.running} aria-label={$_("queue.remove")}>
                <Trash2 size={16} />
              </button>
            </div>
          </article>
        {/each}
      {/if}
    </div>

    <footer>
      <button class="button secondary" onclick={() => clearTransferQueue()} disabled={props.running || $transferQueue.length === 0}>
        <Trash2 size={15} /> {$_("queue.clear")}
      </button>
      <div class="footer-spacer"></div>
      <button class="button secondary" onclick={props.onclose}>{$_("queue.close")}</button>
      <button class="button primary" onclick={requestExecute} disabled={executionDisabled}>
        <ListPlus size={16} /> {props.running ? $_("queue.running") : $_("queue.execute")}
      </button>
    </footer>

    {#if confirmPermanentDelete}
      <div class="confirmation-backdrop">
        <div class="confirmation" role="alertdialog" aria-modal="true" aria-labelledby="queue-permanent-title">
          <AlertTriangle size={28} />
          <h3 id="queue-permanent-title">{$_("queue.permanent_title")}</h3>
          <p>{$_("queue.permanent_confirm", { n: permanentDeleteCount })}</p>
          <div class="confirmation-actions">
            <button class="button secondary" onclick={() => confirmPermanentDelete = false}>{$_("dialog.cancel")}</button>
            <button class="button danger-button" onclick={execute}>
              <XCircle size={16} /> {$_("queue.execute")}
            </button>
          </div>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .queue-backdrop,
  .confirmation-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1200;
    display: grid;
    place-items: center;
    padding: 20px;
    background: color-mix(in srgb, var(--color-nc-bg) 60%, transparent);
  }

  .queue-dialog {
    width: min(760px, 100%);
    max-height: min(680px, calc(100vh - 40px));
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--color-nc-bg-panel);
    border: 1px solid var(--color-nc-border-bright);
    border-radius: 7px;
    color: var(--color-nc-text);
  }

  header,
  footer {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 16px;
    background: var(--color-nc-bg-header);
  }

  header {
    border-bottom: 1px solid var(--color-nc-border);
  }

  h2,
  h3,
  p {
    margin: 0;
  }

  h2 { font-size: 16px; }
  header p { margin-top: 3px; font-size: 12px; color: var(--color-nc-text-dim); }

  .queue-list {
    min-height: 160px;
    overflow: auto;
    padding: 10px;
  }

  .queue-item {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px;
    border: 1px solid var(--color-nc-border);
    border-radius: 5px;
    background: var(--color-nc-bg);
  }

  .queue-item + .queue-item { margin-top: 8px; }
  .queue-item.running { border-color: var(--color-nc-accent); }

  .queue-order {
    display: grid;
    flex: 0 0 24px;
    width: 24px;
    height: 24px;
    place-items: center;
    border-radius: 50%;
    background: var(--color-nc-bg-hover);
    color: var(--color-nc-text-dim);
    font-size: 12px;
  }

  .queue-content { min-width: 0; flex: 1; }
  .queue-summary { display: flex; gap: 8px; font-size: 13px; }
  .queue-summary span, .source-list { color: var(--color-nc-text-dim); font-size: 12px; }
  .source-list { overflow: hidden; margin-top: 3px; text-overflow: ellipsis; white-space: nowrap; }

  .target-field { display: grid; grid-template-columns: 72px 1fr; gap: 7px; align-items: center; margin-top: 8px; font-size: 12px; color: var(--color-nc-text-dim); }
  .target-field input {
    min-width: 0;
    padding: 5px 7px;
    border: 1px solid var(--color-nc-border);
    border-radius: 3px;
    background: var(--color-nc-bg-panel);
    color: var(--color-nc-text);
    font: inherit;
  }

  .delete-mode { margin-top: 8px; color: var(--color-nc-text-dim); font-size: 12px; }
  .delete-mode.permanent { color: var(--color-nc-danger); font-weight: 600; }

  .queue-actions { display: flex; flex-direction: column; gap: 3px; }
  .icon-button {
    display: inline-grid;
    width: 30px;
    height: 30px;
    place-items: center;
    border: 1px solid var(--color-nc-border);
    border-radius: 4px;
    background: var(--color-nc-bg-panel);
    color: var(--color-nc-text);
    cursor: pointer;
  }
  .icon-button:hover:not(:disabled) { background: var(--color-nc-bg-hover); }
  .icon-button.danger:hover:not(:disabled) { color: var(--color-nc-danger); }
  button:disabled { cursor: default; opacity: .55; }

  .empty-state { display: grid; min-height: 140px; place-content: center; justify-items: center; gap: 8px; color: var(--color-nc-text-dim); text-align: center; }

  footer { border-top: 1px solid var(--color-nc-border); }
  .footer-spacer { flex: 1; }
  .button { display: inline-flex; align-items: center; gap: 6px; padding: 7px 11px; border: 1px solid var(--color-nc-border); border-radius: 4px; cursor: pointer; font: inherit; font-size: 13px; }
  .secondary { background: var(--color-nc-bg-panel); color: var(--color-nc-text); }
  .secondary:hover:not(:disabled) { background: var(--color-nc-bg-hover); }
  .primary { background: var(--color-nc-accent-dim); border-color: var(--color-nc-accent); color: white; }
  .primary:hover:not(:disabled) { background: var(--color-nc-accent); }

  .confirmation-backdrop { z-index: 1; background: color-mix(in srgb, var(--color-nc-bg) 72%, transparent); }
  .confirmation { width: min(390px, 100%); padding: 22px; border: 1px solid var(--color-nc-border-bright); border-radius: 6px; background: var(--color-nc-bg-panel); }
  .confirmation :global(svg) { color: var(--color-nc-danger); }
  .confirmation p { margin-top: 10px; color: var(--color-nc-text-dim); }
  .confirmation-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
  .danger-button { background: var(--color-nc-danger); border-color: var(--color-nc-danger); color: white; }

  @media (max-width: 560px) {
    .queue-backdrop { padding: 8px; }
    .queue-actions { flex-direction: row; }
    .queue-item { flex-wrap: wrap; }
    .queue-content { flex-basis: calc(100% - 42px); }
    footer { flex-wrap: wrap; }
    .footer-spacer { display: none; }
  }
</style>
