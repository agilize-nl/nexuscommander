<script lang="ts">
  import { _ } from "$lib/i18n";

  type ActionItem = {
    id: string;
    label: string;
    hint: string;
    trigger: string;
  };

  let {
    visible = false,
    onclose = () => {},
    onaction = (_trigger: string) => {}
  } = $props<{
    visible: boolean;
    onclose: () => void;
    onaction: (trigger: string) => void;
  }>();

  let query = $state("");
  let selectedIndex = $state(0);

  const actions = $derived<ActionItem[]>([
    { id: "view", label: $_("menu.view"), hint: "F3", trigger: "key:F3" },
    { id: "edit", label: $_("menu.edit"), hint: "F4", trigger: "key:F4" },
    { id: "copy", label: $_("menu.copy"), hint: "F5", trigger: "key:F5" },
    { id: "move", label: $_("menu.move"), hint: "F6", trigger: "key:F6" },
    { id: "mkdir", label: $_("menu.mkdir"), hint: "F7", trigger: "key:F7" },
    { id: "delete", label: $_("menu.delete"), hint: "F8", trigger: "key:F8" },
    { id: "tasks", label: $_("menu.task_manager"), hint: "F9", trigger: "action:task-manager" },
    { id: "search", label: $_("menu.search"), hint: "Alt+F7", trigger: "action:search" },
    { id: "hotlist", label: $_("menu.hotlist"), hint: "Ctrl+D", trigger: "action:hotlist" },
    { id: "quick-view", label: $_("menu.quick_view"), hint: "Ctrl+Q", trigger: "action:quick-view" },
    { id: "single-view", label: $_("menu.single_view"), hint: "", trigger: "action:toggle-single-view" },
    { id: "pack", label: $_("menu.pack"), hint: "Alt+F5", trigger: "action:pack" },
    { id: "unpack", label: $_("menu.unpack"), hint: "Alt+F9", trigger: "action:unpack" },
    { id: "compare", label: $_("menu.compare_dirs"), hint: "Shift+F2", trigger: "action:compare-dirs" },
    { id: "swap", label: $_("menu.swap_panels"), hint: "Ctrl+U", trigger: "action:swap-panels" },
    { id: "target-source", label: $_("menu.target_source"), hint: "", trigger: "action:target-source" },
    { id: "toggle-layout", label: $_("menu.toggle_layout"), hint: "", trigger: "action:toggle-layout" },
    { id: "net", label: $_("menu.net_connections"), hint: "", trigger: "action:net-connections" },
    { id: "options", label: $_("menu.options"), hint: "", trigger: "action:options" },
    { id: "help", label: $_("menu.help_contents"), hint: "F1", trigger: "action:help-contents" }
  ]);

  const filteredActions = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter((item) =>
      `${item.label} ${item.hint} ${item.id}`.toLowerCase().includes(q)
    );
  });

  $effect(() => {
    if (visible) {
      query = "";
      selectedIndex = 0;
      requestAnimationFrame(() => {
        document.querySelector<HTMLInputElement>(".action-search")?.focus();
      });
    }
  });

  function close() {
    onclose();
  }

  function runAction(item: ActionItem | undefined) {
    if (!item) return;
    close();
    requestAnimationFrame(() => onaction(item.trigger));
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!visible) return;
    if (e.key === "Escape" || e.key === "F10") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, filteredActions.length - 1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      runAction(filteredActions[selectedIndex]);
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if visible}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="action-backdrop" onclick={close}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <section class="action-palette" onclick={(e) => e.stopPropagation()}>
      <header class="action-header">
        <div>
          <div class="action-title">{$_("fkeys.f10")}</div>
          <div class="action-subtitle">F10</div>
        </div>
        <button class="close-btn" onclick={close} aria-label={$_("dialogs.close")}>×</button>
      </header>

      <input
        class="action-search"
        bind:value={query}
        placeholder={$_("actions.search_placeholder")}
        aria-label={$_("actions.search_placeholder")}
      />

      <div class="action-list">
        {#each filteredActions as item, i}
          <button
            class="action-row"
            class:selected={i === selectedIndex}
            onmouseenter={() => selectedIndex = i}
            onclick={() => runAction(item)}
          >
            <span class="action-label">{item.label}</span>
            {#if item.hint}
              <span class="action-hint">{item.hint}</span>
            {/if}
          </button>
        {/each}
        {#if filteredActions.length === 0}
          <div class="empty">{$_("actions.no_results")}</div>
        {/if}
      </div>
    </section>
  </div>
{/if}

<style>
  .action-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1200;
    display: grid;
    place-items: start center;
    padding-top: min(12vh, 90px);
    background: transparent;
  }

  .action-palette {
    width: min(520px, calc(100vw - 24px));
    max-height: min(620px, calc(100vh - 48px));
    display: flex;
    flex-direction: column;
    background: var(--color-nc-bg-panel);
    border: 1px solid var(--color-nc-border-bright);
    box-shadow: 0 18px 44px rgba(0, 0, 0, 0.42);
  }

  .action-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 12px;
    border-bottom: 1px solid var(--color-nc-border);
  }

  .action-title {
    color: var(--color-nc-text-bright);
    font-size: 13px;
    font-weight: 700;
  }

  .action-subtitle {
    color: var(--color-nc-text-dim);
    font-size: 10px;
    margin-top: 2px;
  }

  .close-btn {
    width: 28px;
    height: 28px;
    border: 1px solid var(--color-nc-border);
    background: var(--color-nc-bg-alt);
    color: var(--color-nc-text);
    cursor: pointer;
    font-size: 18px;
    line-height: 1;
  }

  .close-btn:hover {
    background: var(--color-nc-bg-hover);
    color: var(--color-nc-text-bright);
  }

  .action-search {
    margin: 10px 12px;
    padding: 8px 10px;
    background: var(--color-nc-bg-deep);
    border: 1px solid var(--color-nc-border);
    color: var(--color-nc-text-bright);
    font: inherit;
    outline: none;
  }

  .action-search:focus {
    border-color: var(--color-nc-accent);
  }

  .action-list {
    overflow-y: auto;
    padding: 4px 6px 8px;
  }

  .action-row {
    width: 100%;
    min-height: 32px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 6px 8px;
    border: 0;
    background: transparent;
    color: var(--color-nc-text);
    text-align: left;
    cursor: pointer;
  }

  .action-row:hover,
  .action-row.selected {
    background: var(--color-nc-bg-selected);
    color: var(--color-nc-text-bright);
  }

  .action-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .action-hint {
    color: var(--color-nc-accent);
    font-size: 10px;
    flex-shrink: 0;
  }

  .empty {
    padding: 14px 8px;
    color: var(--color-nc-text-dim);
  }
</style>
