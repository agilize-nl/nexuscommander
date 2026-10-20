<script lang="ts">
  import { isOverlayActive } from "../stores";
  import { hasCapability } from "../ipc";
  import { _ } from "../i18n";
  import { displayShortcut } from "../shortcuts";

  // Which optional entries this shell's +page actually wires up. Everything
  // not listed here is handled by both shells and is always shown.
  let {
    showUpload = false,
    showDownload = false,
    showExit = false,
    showElevate = false,
    showStubTools = false,
    isRoot = false,
  } = $props<{
    /** Browser file/folder upload (web only). */
    showUpload?: boolean;
    /** Browser file/folder download of the selection (web only). */
    showDownload?: boolean;
    /** The shell can quit itself (desktop only). */
    showExit?: boolean;
    /** The shell can restart with elevated privileges (desktop only). */
    showElevate?: boolean;
    /**
     * The shell is already elevated. The elevate entry stays visible but goes
     * dead: restarting root-as-root would only re-prompt polkit for nothing.
     */
    isRoot?: boolean;
    /**
     * Command history and panel sync. No shell listens for these actions yet,
     * so they are kept behind a flag rather than leaking dead entries into
     * web's menu. The FTP entries that used to sit here were dropped in v0.8.34.
     */
    showStubTools?: boolean;
  }>();

  interface MenuItem {
    name: string;
    shortcut: string;
    description: string;
    action?: string;
    separator?: boolean;
    disabled?: boolean;
  }

  interface Menu {
    label: string;
    items: MenuItem[];
    action?: string;
  }

  const menus: Menu[] = $derived([
    {
      label: $_("menu.files.label"),
      items: [
        {
          name: $_("menu.files.view"),
          shortcut: "F3",
          description: $_("menu.desc.f3"),
          action: "F3",
        },
        {
          name: $_("menu.files.edit"),
          shortcut: "F4",
          description: $_("menu.desc.f4"),
          action: "F4",
        },
        { name: "", shortcut: "", description: "", separator: true },
        {
          name: $_("menu.files.copy"),
          shortcut: "F5",
          description: $_("menu.desc.f5"),
          action: "F5",
        },
        {
          name: $_("menu.files.move"),
          shortcut: "F6",
          description: $_("menu.desc.f6"),
          action: "F6",
        },
        {
          name: $_("menu.files.new_folder"),
          shortcut: "F7",
          description: $_("menu.desc.f7"),
          action: "F7",
        },
        {
          name: $_("menu.files.delete"),
          shortcut: "F8",
          description: $_("menu.desc.f8"),
          action: "F8",
        },
        { name: "", shortcut: "", description: "", separator: true },
        {
          name: $_("menu.files.pack"),
          shortcut: "Alt+F5",
          description: $_("menu.desc.pack"),
          action: "pack",
        },
        {
          name: $_("menu.files.unpack"),
          shortcut: "Alt+F9",
          description: $_("menu.desc.unpack"),
          action: "unpack",
        },
        {
          name: $_("menu.files.test_archive"),
          shortcut: "Alt+Shift+F9",
          description: $_("menu.desc.test_archive"),
          action: "test-archive",
          disabled: !hasCapability("archiveTest"),
        },
        ...(showDownload
          ? [
              {
                name: $_("menu.files.download"),
                shortcut: "",
                description: $_("menu.desc.download_selection"),
                action: "download-selection",
              },
            ]
          : []),
        { name: "", shortcut: "", description: "", separator: true },
        {
          name: $_("menu.files.split"),
          shortcut: "",
          description: $_("menu.desc.split"),
          action: "split",
          disabled: !hasCapability("splitFile"),
        },
        {
          name: $_("menu.files.combine"),
          shortcut: "",
          description: $_("menu.desc.combine"),
          action: "combine",
          disabled: !hasCapability("combineFiles"),
        },
        { name: "", shortcut: "", description: "", separator: true },
        {
          name: $_("menu.files.calculate_space"),
          shortcut: "Space",
          description: $_("menu.desc.space"),
          action: " ",
        },
        {
          name: $_("menu.files.calculate_space_all"),
          shortcut: "Alt+Shift+Enter",
          description: $_("menu.desc.calculate_space_all"),
          action: "calculate-space-all",
        },
        {
          name: $_("menu.multi_rename"),
          shortcut: "Ctrl+M",
          description: $_("menu.desc.multi_rename"),
          action: "multi-rename",
        },
        ...(showUpload
          ? [
              { name: "", shortcut: "", description: "", separator: true },
              {
                name: $_("menu.files.upload_files"),
                shortcut: "",
                description: $_("menu.desc.upload_files"),
                action: "upload-files",
              },
              {
                name: $_("menu.files.upload_folder"),
                shortcut: "",
                description: $_("menu.desc.upload_folder"),
                action: "upload-folder",
              },
            ]
          : []),
        ...(showElevate
          ? [
              { name: "", shortcut: "", description: "", separator: true },
              {
                name: $_("menu.files.start_as_root"),
                shortcut: "",
                description: isRoot
                  ? $_("menu.files.start_as_root_active")
                  : $_("menu.desc.start_as_root"),
                action: "start-as-root",
                disabled: isRoot,
              },
            ]
          : []),
        ...(showExit
          ? [
              { name: "", shortcut: "", description: "", separator: true },
              {
                name: $_("menu.files.exit"),
                shortcut: "Alt+F4",
                description: $_("menu.desc.exit"),
                action: "exit",
              },
            ]
          : []),
      ],
    },
    {
      label: $_("menu.selection.label"),
      items: [
        {
          name: $_("menu.selection.select_all"),
          shortcut: "Ctrl+Num +",
          description: $_("menu.desc.select_all"),
          action: "select-all",
        },
        {
          name: $_("menu.selection.unselect_all"),
          shortcut: "Ctrl+Num -",
          description: $_("menu.desc.unselect_all"),
          action: "unselect-all",
        },
        {
          name: $_("menu.selection.select_all_files"),
          shortcut: "",
          description: $_("menu.desc.select_all_files"),
          action: "select-all-files",
        },
        {
          name: $_("menu.selection.unselect_all_files"),
          shortcut: "",
          description: $_("menu.desc.unselect_all_files"),
          action: "unselect-all-files",
        },
        { name: "", shortcut: "", description: "", separator: true },
        {
          name: $_("menu.selection.select_group"),
          shortcut: "Num +",
          description: $_("menu.desc.select_group"),
          action: "select-group",
        },
        {
          name: $_("menu.selection.unselect_group"),
          shortcut: "Num -",
          description: $_("menu.desc.unselect_group"),
          action: "unselect-group",
        },
        {
          name: $_("menu.selection.invert"),
          shortcut: "Num *",
          description: $_("menu.desc.invert_selection"),
          action: "invert-selection",
        },
        {
          name: $_("menu.selection.restore_selection"),
          shortcut: "",
          description: $_("menu.desc.restore_selection"),
          action: "restore-selection",
        },
        { name: "", shortcut: "", description: "", separator: true },
        {
          name: $_("menu.selection.select_same_ext"),
          shortcut: "Alt+Num +",
          description: $_("menu.desc.select_same_ext"),
          action: "select-same-ext",
        },
        {
          name: $_("menu.selection.unselect_same_ext"),
          shortcut: "Alt+Num -",
          description: $_("menu.desc.unselect_same_ext"),
          action: "unselect-same-ext",
        },
        { name: "", shortcut: "", description: "", separator: true },
        {
          name: $_("menu.compare_dirs"),
          shortcut: "Shift+F2",
          description: $_("menu.desc.compare_dirs"),
          action: "compare-dirs",
        },
      ],
    },
    {
      label: $_("menu.commands.label"),
      items: [
        {
          name: $_("menu.commands.search"),
          shortcut: "Alt+F7",
          description: $_("menu.desc.search"),
          action: "search",
        },
        {
          name: $_("menu.commands.hotlist"),
          shortcut: "Ctrl+D",
          description: $_("menu.desc.hotlist"),
          action: "hotlist",
        },
        ...(showStubTools
          ? [
              {
                name: $_("menu.commands.history"),
                shortcut: "Alt+Down",
                description: $_("menu.desc.history"),
                action: "history",
              },
              { name: "", shortcut: "", description: "", separator: true },
              {
                name: $_("menu.commands.sync_panels"),
                shortcut: "",
                description: $_("menu.desc.sync_panels"),
                action: "sync-panels",
              },
            ]
          : []),
        {
          name: $_("menu.commands.swap_panels"),
          shortcut: "Ctrl+U",
          description: $_("menu.desc.swap_panels"),
          action: "swap-panels",
        },
        {
          name: $_("menu.commands.target_equals_source"),
          shortcut: "",
          description: $_("menu.desc.target_source"),
          action: "target-source",
        },
        { name: "", shortcut: "", description: "", separator: true },
        {
          name: $_("menu.commands.job_list"),
          shortcut: "Ctrl+J",
          description: $_("menu.desc.task_manager"),
          action: "task-manager",
        },
        { name: "", shortcut: "", description: "", separator: true },
        {
          name: $_("menu.open_terminal"),
          shortcut: "",
          description: $_("menu.desc.open_terminal"),
          action: "open-terminal",
        },
      ],
    },
    {
      label: $_("menu.network"),
      items: [
        {
          name: $_("menu.net_connections"),
          shortcut: "",
          description: $_("menu.desc.net_connections"),
          action: "net-connections",
        },
        {
          name: $_("menu.net_disconnect"),
          shortcut: "",
          description: $_("menu.desc.net_disconnect"),
          action: "net-disconnect",
        },
      ],
    },
    {
      label: $_("menu.show"),
      items: [
        {
          name: $_("menu.view_brief"),
          shortcut: "Ctrl+F1",
          description: $_("menu.desc.view_brief"),
          action: "view-brief",
        },
        {
          name: $_("menu.view_full"),
          shortcut: "Ctrl+F2",
          description: $_("menu.desc.view_full"),
          action: "view-full",
        },
        {
          name: $_("menu.single_view"),
          shortcut: "",
          description: $_("menu.desc.toggle_single_view"),
          action: "toggle-single-view",
        },
        {
          name: $_("menu.view_tree"),
          shortcut: "Ctrl+F8",
          description: $_("menu.desc.view_tree"),
          action: "view-tree",
        },
        {
          name: $_("menu.quick_view"),
          shortcut: "Ctrl+Q",
          description: $_("menu.desc.quick_view"),
          action: "quick-view",
        },
        { name: "", shortcut: "", description: "", separator: true },
        {
          name: $_("menu.toggle_layout"),
          shortcut: "",
          description: $_("menu.desc.toggle_layout"),
          action: "toggle-layout",
        },
        { name: "", shortcut: "", description: "", separator: true },
        {
          name: $_("menu.sort_name"),
          shortcut: "Ctrl+F3",
          description: $_("menu.desc.sort_name"),
          action: "sort-name",
        },
        {
          name: $_("menu.sort_ext"),
          shortcut: "Ctrl+F4",
          description: $_("menu.desc.sort_ext"),
          action: "sort-ext",
        },
        {
          name: $_("menu.sort_date"),
          shortcut: "Ctrl+F5",
          description: $_("menu.desc.sort_date"),
          action: "sort-date",
        },
        {
          name: $_("menu.sort_size"),
          shortcut: "Ctrl+F6",
          description: $_("menu.desc.sort_size"),
          action: "sort-size",
        },
      ],
    },
    {
      label: $_("menu.configuration.label"),
      action: "options",
      items: [],
    },
    {
      label: $_("menu.help.label"),
      items: [
        {
          name: $_("menu.help.contents"),
          shortcut: "F1",
          description: $_("menu.desc.help_contents"),
          action: "help-contents",
        },
        {
          name: $_("menu.help.keyboard"),
          shortcut: "",
          description: $_("menu.desc.help_shortcuts"),
          action: "help-shortcuts",
        },
        { name: "", shortcut: "", description: "", separator: true },
        {
          name: $_("menu.technical_support"),
          shortcut: "",
          description: $_("menu.desc.technical_support"),
          action: "technical-support",
        },
        { name: "", shortcut: "", description: "", separator: true },
        {
          name: $_("menu.help.about"),
          shortcut: "",
          description: $_("menu.desc.about"),
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

  async function handleItemClick(item: MenuItem) {
    if (overlayActive) return;
    if (item.separator || !item.action || item.disabled) return;
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
    } else if (item.action === "calculate-space-all") {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          altKey: true,
          shiftKey: true,
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
      // Everything else, including exit and start-as-root, goes through the
      // one dispatch mechanism the shells share; the +page handler decides
      // what quitting or elevating means on that platform.
      // Dispatch a custom event for the action
      window.dispatchEvent(
        new CustomEvent("nc:menu-action", { detail: item.action }),
      );
    }
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
                class:disabled={item.disabled}
                aria-disabled={item.disabled ? "true" : undefined}
                onclick={() => handleItemClick(item)}
                onmouseenter={() => (hoveredItem = ii)}
                onmouseleave={() => (hoveredItem = null)}
                title={item.description}
              >
                <span class="item-label">{item.name}</span>
                {#if item.shortcut}
                  <span class="item-shortcut">{displayShortcut(item.shortcut, $_)}</span>
                {/if}
              </div>
            {/if}
          {/each}
        </div>
      {/if}
    </div>
  {/each}

  <div class="spacer"></div>
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
    backdrop-filter: blur(12px);
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

  /* Disabled entries keep their place in the menu but take no hover or press
     feedback, so the row cannot look clickable while the click is dropped. */
  .dropdown-item.disabled {
    cursor: default;
    opacity: 0.45;
  }

  .dropdown-item.disabled:hover,
  .dropdown-item.disabled:active {
    background: transparent;
    box-shadow: none;
  }

  .dropdown-item.disabled:hover .item-label {
    color: var(--color-nc-text);
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

  /* ----- Right side ----- */
  .spacer {
    flex: 1;
  }
</style>
