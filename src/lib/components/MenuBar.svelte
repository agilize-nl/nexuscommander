<script lang="ts">
  import { isOverlayActive } from "$lib/stores";
  import { _ } from "$lib/i18n";

  interface MenuItem {
    name: string;
    shortcut: string;
    description: string;
    action?: string;
    separator?: boolean;
  }

  interface Menu {
    label: string;
    items: MenuItem[];
    action?: string;
  }

  const menus: Menu[] = $derived([
    {
      label: $_('menu.files'),
      items: [
        {
          name: $_('menu.view'),
          shortcut: "F3",
          description: $_('menu.view'),
          action: "F3",
        },
        {
          name: $_('menu.edit'),
          shortcut: "F4",
          description: $_('menu.edit'),
          action: "F4",
        },
        { name: "", shortcut: "", description: "", separator: true },
        {
          name: $_('menu.copy'),
          shortcut: "F5",
          description: $_('menu.copy'),
          action: "F5",
        },
        {
          name: $_('menu.move'),
          shortcut: "F6",
          description: $_('menu.move'),
          action: "F6",
        },
        {
          name: $_('menu.mkdir'),
          shortcut: "F7",
          description: $_('menu.mkdir'),
          action: "F7",
        },
        {
          name: $_('menu.delete'),
          shortcut: "F8",
          description: $_('menu.delete'),
          action: "F8",
        },
        { name: "", shortcut: "", description: "", separator: true },
        {
          name: $_('menu.pack'),
          shortcut: "Alt+F5",
          description: $_('menu.pack'),
          action: "pack",
        },
        {
          name: $_('menu.unpack'),
          shortcut: "Alt+F9",
          description: $_('menu.unpack'),
          action: "unpack",
        },
        {
          name: $_('menu.test_archive'),
          shortcut: "Alt+Shift+F9",
          description: $_('menu.test_archive'),
          action: "test-archive",
        },
        { name: "", shortcut: "", description: "", separator: true },
        {
          name: $_('menu.split_file'),
          shortcut: "",
          description: $_('menu.split_file'),
          action: "split",
        },
        {
          name: $_('menu.combine_files'),
          shortcut: "",
          description: $_('menu.combine_files'),
          action: "combine",
        },
        { name: "", shortcut: "", description: "", separator: true },
        {
          name: $_('menu.calc_space'),
          shortcut: "Space",
          description: $_('menu.calc_space'),
          action: " ",
        },
        {
          name: $_('menu.multi_rename'),
          shortcut: "Ctrl+M",
          description: $_('menu.multi_rename'),
          action: "multi-rename",
        },
        { name: "", shortcut: "", description: "", separator: true },
        {
          name: $_('menu.upload_files'),
          shortcut: "",
          description: $_('menu.upload_files'),
          action: "upload-files",
        },
        {
          name: $_('menu.upload_folder'),
          shortcut: "",
          description: $_('menu.upload_folder'),
          action: "upload-folder",
        },
      ],
    },
    {
      label: $_('menu.mark'),
      items: [
        {
          name: $_('menu.select_all'),
          shortcut: "Ctrl+Num +",
          description: $_('menu.select_all'),
          action: "select-all",
        },
        {
          name: $_('menu.unselect_all'),
          shortcut: "Ctrl+Num −",
          description: $_('menu.unselect_all'),
          action: "unselect-all",
        },
        {
          name: $_('menu.select_all_files'),
          shortcut: "",
          description: $_('menu.select_all_files'),
          action: "select-all-files",
        },
        {
          name: $_('menu.unselect_all_files'),
          shortcut: "",
          description: $_('menu.unselect_all_files'),
          action: "unselect-all-files",
        },
        { name: "", shortcut: "", description: "", separator: true },
        {
          name: $_('menu.select_group'),
          shortcut: "Num +",
          description: $_('menu.select_group'),
          action: "select-group",
        },
        {
          name: $_('menu.unselect_group'),
          shortcut: "Num −",
          description: $_('menu.unselect_group'),
          action: "unselect-group",
        },
        {
          name: $_('menu.select_same_ext'),
          shortcut: "Alt+Num +",
          description: $_('menu.select_same_ext'),
          action: "select-same-ext",
        },
        {
          name: $_('menu.unselect_same_ext'),
          shortcut: "Alt+Num −",
          description: $_('menu.unselect_same_ext'),
          action: "unselect-same-ext",
        },
        { name: "", shortcut: "", description: "", separator: true },
        {
          name: $_('menu.invert_selection'),
          shortcut: "Num *",
          description: $_('menu.invert_selection'),
          action: "invert-selection",
        },
        {
          name: $_('menu.restore_selection'),
          shortcut: "",
          description: $_('menu.restore_selection'),
          action: "restore-selection",
        },
        { name: "", shortcut: "", description: "", separator: true },
        {
          name: $_('menu.compare_dirs'),
          shortcut: "Shift+F2",
          description: $_('menu.compare_dirs'),
          action: "compare-dirs",
        },
      ],
    },
    {
      label: $_('menu.commands'),
      items: [
        {
          name: $_('menu.search'),
          shortcut: "Alt+F7",
          description: $_('menu.search'),
          action: "search",
        },
        {
          name: $_('menu.hotlist'),
          shortcut: "Ctrl+D",
          description: $_('menu.hotlist'),
          action: "hotlist",
        },
        { name: "", shortcut: "", description: "", separator: true },
        {
          name: $_('menu.task_manager'),
          shortcut: "",
          description: $_('menu.task_manager'),
          action: "task-manager",
        },
        { name: "", shortcut: "", description: "", separator: true },
        {
          name: $_('menu.swap_panels'),
          shortcut: "Ctrl+U",
          description: $_('menu.swap_panels'),
          action: "swap-panels",
        },
        {
          name: $_('menu.target_source'),
          shortcut: "Ctrl+→",
          description: $_('menu.target_source'),
          action: "target-source",
        },
        {
          name: $_('menu.compare_dirs'),
          shortcut: "Shift+F2",
          description: $_('menu.compare_dirs'),
          action: "compare-dirs",
        },
        { name: "", shortcut: "", description: "", separator: true },
        {
          name: $_('menu.open_terminal'),
          shortcut: "",
          description: $_('menu.open_terminal'),
          action: "open-terminal",
        },
      ],
    },
    {
      label: $_('menu.network'),
      items: [
        {
          name: $_('menu.net_connections'),
          shortcut: "",
          description: $_('menu.net_connections'),
          action: "net-connections",
        },
        {
          name: $_('menu.net_disconnect'),
          shortcut: "",
          description: $_('menu.net_disconnect'),
          action: "net-disconnect",
        },
      ],
    },
    {
      label: $_('menu.show'),
      items: [
        {
          name: $_('menu.view_brief'),
          shortcut: "Ctrl+F1",
          description: $_('menu.view_brief'),
          action: "view-brief",
        },
        {
          name: $_('menu.view_full'),
          shortcut: "Ctrl+F2",
          description: $_('menu.view_full'),
          action: "view-full",
        },
        {
          name: $_('menu.single_view'),
          shortcut: "",
          description: $_('menu.single_view'),
          action: "toggle-single-view",
        },
        {
          name: $_('menu.view_tree'),
          shortcut: "Ctrl+F8",
          description: $_('menu.view_tree'),
          action: "view-tree",
        },
        {
          name: $_('menu.quick_view'),
          shortcut: "Ctrl+Q",
          description: $_('menu.quick_view'),
          action: "quick-view",
        },
        { name: "", shortcut: "", description: "", separator: true },
        {
          name: $_('menu.toggle_layout'),
          shortcut: "",
          description: $_('menu.toggle_layout'),
          action: "toggle-layout",
        },
        { name: "", shortcut: "", description: "", separator: true },
        {
          name: $_('menu.sort_name'),
          shortcut: "Ctrl+F3",
          description: $_('menu.sort_name'),
          action: "sort-name",
        },
        {
          name: $_('menu.sort_ext'),
          shortcut: "Ctrl+F4",
          description: $_('menu.sort_ext'),
          action: "sort-ext",
        },
        {
          name: $_('menu.sort_date'),
          shortcut: "Ctrl+F5",
          description: $_('menu.sort_date'),
          action: "sort-date",
        },
        {
          name: $_('menu.sort_size'),
          shortcut: "Ctrl+F6",
          description: $_('menu.sort_size'),
          action: "sort-size",
        },
      ],
    },
    {
      label: $_('menu.configuration'),
      action: "options",
      items: [],
    },
    {
      label: $_('menu.help'),
      items: [
        {
          name: $_('menu.help_contents'),
          shortcut: "F1",
          description: $_('menu.help_contents'),
          action: "help-contents",
        },
        {
          name: $_('menu.help_shortcuts'),
          shortcut: "",
          description: $_('menu.help_shortcuts'),
          action: "help-shortcuts",
        },
        { name: "", shortcut: "", description: "", separator: true },
        {
          name: $_('menu.technical_support'),
          shortcut: "",
          description: $_('menu.technical_support'),
          action: "technical-support",
        },
        { name: "", shortcut: "", description: "", separator: true },
        {
          name: $_('menu.about'),
          shortcut: "",
          description: $_('menu.about'),
          action: "about",
        },
      ],
    },
  ]);

  let openMenuIndex: number | null = $state(null);
  let hoveredItem: number | null = $state(null);
  let overlayActive = $state(false);
  isOverlayActive.subscribe((v) => (overlayActive = v));
  function toggleMenu(index: number) {
    if (overlayActive) return;
    const menu = menus[index];
    if (menu.action) {
      openMenuIndex = null;
      handleItemClick({ name: menu.label, action: menu.action, shortcut: "", description: "" });
      return;
    }
    if (openMenuIndex === index) {
      openMenuIndex = null;
    } else {
      openMenuIndex = index;
    }
  }

  function handleMenuHover(index: number) {
    if (overlayActive) return;
    const menu = menus[index];
    if (menu.action) {
      openMenuIndex = null;
      return;
    }
    // If a menu is already open, switch to the hovered one
    if (openMenuIndex !== null) {
      openMenuIndex = index;
    }
  }

  function handleItemClick(item: MenuItem) {
    if (overlayActive) return;
    if (item.separator || !item.action) return;
    openMenuIndex = null;

    // For F-key actions, dispatch a synthetic keyboard event
    if (/^F\d+$/.test(item.action)) {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: item.action,
          bubbles: true,
          cancelable: true,
        }),
      );
    } else if (item.action === " ") {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: " ",
          bubbles: true,
          cancelable: true,
        }),
      );
    } else if (item.action === "select-all") {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "+",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    } else if (item.action === "unselect-all") {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "-",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    } else if (item.action === "select-group") {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "+",
          bubbles: true,
          cancelable: true,
        }),
      );
    } else if (item.action === "unselect-group") {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "-",
          bubbles: true,
          cancelable: true,
        }),
      );
    } else if (item.action === "invert-selection") {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "*",
          bubbles: true,
          cancelable: true,
        }),
      );
    } else {
      // Dispatch a custom event for the action
      window.dispatchEvent(
        new CustomEvent("nc:menu-action", { detail: item.action }),
      );
    }
  }

  function closeMenu() {
    openMenuIndex = null;
  }

  function handleGlobalClick(e: MouseEvent) {
    if (openMenuIndex !== null) {
      // Check if clicked outside menubar
      const target = e.target as HTMLElement;
      if (!target.closest(".menubar")) {
        openMenuIndex = null;
      }
    }
  }

  function handleGlobalKeydown(e: KeyboardEvent) {
    if (openMenuIndex !== null && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      openMenuIndex = null;
    }
  }
</script>

<svelte:window onclick={handleGlobalClick} onkeydown={handleGlobalKeydown} />

<nav class="menubar">
  {#each menus as menu, mi}
    <div class="menu-wrapper">
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <button
        class="menu-trigger"
        class:open={openMenuIndex === mi}
        onclick={() => toggleMenu(mi)}
        onmouseenter={() => handleMenuHover(mi)}
      >
        {menu.label}
      </button>

      {#if openMenuIndex === mi}
        <div class="dropdown">
          {#each menu.items as item, ii}
            {#if item.separator}
              <div class="dropdown-sep"></div>
            {:else}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                class="dropdown-item"
                onclick={() => handleItemClick(item)}
                onmouseenter={() => (hoveredItem = ii)}
                onmouseleave={() => (hoveredItem = null)}
                title={item.description}
              >
                <span class="item-label">{item.name}</span>
                {#if item.shortcut}
                  <span class="item-shortcut">{item.shortcut}</span>
                {/if}
              </div>
            {/if}
          {/each}
        </div>
      {/if}
    </div>
  {/each}

</nav>

<style>
  .menubar {
    display: flex;
    align-items: center;
    height: 28px;
    background: linear-gradient(
      180deg,
      var(--color-nc-bg-header) 0%,
      var(--color-nc-bg-panel) 100%
    );
    border-bottom: 1px solid var(--color-nc-border);
    padding: 0 4px;
    gap: 0;
    position: relative;
    z-index: 500;
    user-select: none;
  }

  .menu-wrapper {
    position: relative;
  }

  .menu-trigger {
    padding: 3px 10px;
    background: transparent;
    border: none;
    color: var(--color-nc-text);
    font-family: var(--font-menu-name);
    font-size: var(--font-menu-size);
    font-weight: 500;
    cursor: pointer;
    border-radius: 3px;
    transition: all 0.12s ease;
    letter-spacing: 0.02em;
    height: 24px;
    display: flex;
    align-items: center;
  }

  .menu-trigger:hover {
    background: var(--color-nc-bg-hover);
    color: var(--color-nc-text-bright);
  }

  .menu-trigger.open {
    background: var(--color-nc-accent-dim);
    color: var(--color-nc-text-bright);
    box-shadow: 0 0 0 1px var(--color-nc-accent-glow);
  }

  /* ----- Dropdown ----- */
  .dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    min-width: 280px;
    background: var(--color-nc-bg-panel);
    border: 1px solid var(--color-nc-border-bright);
    border-radius: 6px;
    box-shadow:
      0 8px 32px rgba(0, 0, 0, 0.45),
      0 0 0 1px var(--color-nc-accent-glow);
    padding: 4px 0;
    z-index: 1000;
    animation: dropIn 0.12s ease;
    backdrop-filter: var(--nc-overlay-blur, blur(12px));
  }

  @keyframes dropIn {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .dropdown-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 5px 16px 5px 12px;
    cursor: pointer;
    transition: all 0.08s ease;
    gap: 24px;
  }

  .dropdown-item:hover {
    background: var(--color-nc-accent-dim);
    box-shadow: inset 3px 0 0 var(--color-nc-accent);
  }

  .dropdown-item:active {
    background: var(--color-nc-accent);
  }

  .item-label {
    font-family: var(--font-menu-name);
    font-size: var(--font-menu-size);
    color: var(--color-nc-text);
    white-space: nowrap;
  }

  .dropdown-item:hover .item-label {
    color: var(--color-nc-text-bright);
  }

  .item-shortcut {
    font-family: var(--font-family-mono);
    font-size: 10.5px;
    color: var(--color-nc-text-dim);
    padding: 1px 6px;
    background: var(--color-nc-bg);
    border: 1px solid var(--color-nc-border);
    border-radius: 3px;
    white-space: nowrap;
    letter-spacing: 0.03em;
  }

  .dropdown-item:hover .item-shortcut {
    background: var(--color-nc-bg-panel);
    border-color: var(--color-nc-accent-dim);
    color: var(--color-nc-accent);
  }

  .dropdown-sep {
    height: 1px;
    margin: 4px 10px;
    background: linear-gradient(
      90deg,
      transparent 0%,
      var(--color-nc-border) 20%,
      var(--color-nc-border) 80%,
      transparent 100%
    );
  }

  @media (max-width: 640px) {
    .menu-trigger {
      padding: 3px 6px;
      font-size: 12px;
    }
  }

  @media (max-width: 400px) {
    .menu-trigger {
      padding: 3px 4px;
      font-size: 11px;
    }
  }
</style>
