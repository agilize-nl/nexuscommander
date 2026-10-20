<script lang="ts">
  import { onMount } from "svelte";
  import { fade, scale } from "svelte/transition";
  import {
    Globe,
    Palette,
    Layout,
    CheckCircle,
    XCircle,
    Columns,
    FolderUp,
    Type,
    Plus,
    Trash2,
    ArrowUp,
    ArrowDown,
  } from "lucide-svelte";
  import { Settings as SettingsIcon } from "lucide-svelte";
  import { loadSettings } from "../ipc";
  import { _, availableLocales } from "../i18n";

  // The config schema is app-local (the two shells name their layout keys
  // differently), so this dialog never touches a config store itself: the
  // shell hands in the current config and takes the sanitized result back.
  const {
    appConfig = null,
    onapply,
    onclose,
    showSavedViews = false,
    folderBracketsKey = "show_folders_with_brackets",
    parentRowKey = "show_parent_dir_row",
    iconPreview: IconPreview = undefined,
  } = $props<{
    appConfig?: any;
    /** Persist the sanitized config, the shell's way. */
    onapply: (config: any) => void | Promise<void>;
    onclose?: () => void;
    /**
     * Saved column views (save/save-as/rename/delete). Desktop-only for now:
     * web's config has no column_views map to store them in.
     */
    showSavedViews?: boolean;
    folderBracketsKey?: string;
    parentRowKey?: string;
    /**
     * Renders the icon-theme previews. Injected rather than imported so web,
     * which has no icon themes and no @iconify dependency, does not pull the
     * icon packs into its bundle.
     */
    iconPreview?: any;
  }>();

  type AppConfig = any;
  type ColumnConfig = any;

  let activeCategoryId = $state("general");
  let saveStatus = $state("");
  let saving = $state(false);


  // Dragging state
  let pos = $state({ x: 0, y: 0 });
  let dragging = $state(false);
  let dragStart = { x: 0, y: 0 };

  // Resizing state
  let size = $state({ width: 550, height: 400 });
  let resizing = $state(false);
  let resizeStart = { width: 0, height: 0, x: 0, y: 0 };

  // Font Picker state
  const fontList = [
    "Inter, sans-serif",
    "JetBrains Mono, monospace",
    "Fira Code, monospace",
    "Segoe UI, sans-serif",
    "Roboto, sans-serif",
    "DejaVu Sans Mono, monospace",
    "Courier New, monospace",
    "Arial, sans-serif",
    "Verdana, sans-serif",
    "Tahoma, sans-serif",
    "Georgia, serif",
    "Times New Roman, serif",
  ];
  let fontPickerTarget = $state<
    | "main"
    | "menu"
    | "drive"
    | "tab"
    | "header"
    | "pane"
    | "status"
    | "editor"
    | "viewer"
    | null
  >(null);

  function openFontPicker(target: typeof fontPickerTarget) {
    fontPickerTarget = target;
  }

  function selectFont(font: string) {
    if (fontPickerTarget === "main") config.font_main_name = font;
    else if (fontPickerTarget === "menu") config.font_menu_name = font;
    else if (fontPickerTarget === "drive") config.font_drive_name = font;
    else if (fontPickerTarget === "tab") config.font_tab_name = font;
    else if (fontPickerTarget === "header") config.font_header_name = font;
    else if (fontPickerTarget === "pane") config.font_pane_name = font;
    else if (fontPickerTarget === "status") config.font_status_name = font;
    fontPickerTarget = null;
  }

  const DEFAULT_COLUMNS: ColumnConfig[] = [
    {
      caption: "Name",
      width: 220,
      align: "<-",
      field_contents: "[NC().GETFILENAME{}]",
    },
    {
      caption: "Ext",
      width: 60,
      align: "<-",
      field_contents: "[NC().GETFILEEXT{}]",
    },
    {
      caption: "Size",
      width: 80,
      align: "->",
      field_contents: "[NC().GETFILESIZE{}]",
    },
    {
      caption: "Date",
      width: 130,
      align: "->",
      field_contents: "[NC().GETFILETIME{}]",
    },
  ];

  // This object mirrors our Rust AppConfig struct perfectly
  let config = $state<AppConfig>({
    language: "en",
    start_as_root: false,
    layout_show_menu: true,
    audio_player: "builtin",
    color_background: "#1e293b",
    color_text: "#f8fafc",
    theme: "midnight",
    icon_theme: "material",
    behavior_selection_mode: "NC",
    custom_columns: "Default",
    show_folder_tabs: true,
    show_folders_with_brackets: true,
    show_parent_dir_row: true,
    show_alternating_row_colors: true,
    show_file_sizes_in_bytes: false,
    font_family: "Inter, sans-serif",
    font_main_name: "Inter, sans-serif",
    font_main_size: 11,
    font_menu_name: "Inter, sans-serif",
    font_menu_size: 11,
    font_drive_name: "Inter, sans-serif",
    font_drive_size: 11,
    font_tab_name: "Inter, sans-serif",
    font_tab_size: 11,
    font_header_name: "Inter, sans-serif",
    font_header_size: 11,
    font_pane_name: "Inter, sans-serif",
    font_pane_size: 11,
    font_status_name: "Inter, sans-serif",
    font_status_size: 11,
    columns: [],
    column_views: {
      Default: [
        {
          caption: "Name",
          width: 665,
          align: "<-",
          field_contents: "FileName",
        },
        { caption: "Ext", width: 50, align: "<-", field_contents: "FileExt" },
        { caption: "Size", width: 70, align: "->", field_contents: "FileSize" },
        {
          caption: "Date",
          width: 283,
          align: "->",
          field_contents: "FileTime",
        },
        {
          caption: "Attr",
          width: 179,
          align: "<-",
          field_contents: "FileAttr",
        },
      ],
    },
    left_tabs: [],
    right_tabs: [],
    left_active_tab: "",
    right_active_tab: "",
    left_mode: "list",
    right_mode: "list",
    left_view_mode: "full",
    right_view_mode: "full",
    is_vertical_layout: true,
    is_single_view: false,
    panel_ratio: 0.5,
    file_op_options: {
      when_file_exists: "Ask",
      when_dir_exists: "Ask",
      when_cannot_set_property: "Ask",
      exclude_empty_dirs: true,
      verify: false,
      check_free_space: true,
      reserve_space: true,
      follow_links: false,
      correct_links: false,
      copy_attributes: true,
      drop_readonly: false,
      copy_date_time: true,
      copy_ownership: false,
      copy_on_write: false,
    },
  });

  const fieldOptions = $derived([
    { label: $_("common.name"), value: "FileName" },
    { label: $_("common.ext"), value: "FileExt" },
    { label: $_("common.size"), value: "FileSize" },
    { label: $_("common.date"), value: "FileTime" },
    { label: $_("common.attr"), value: "FileAttr" },
    { label: $_("common.perm"), value: "FilePerm" },
    { label: $_("common.owner"), value: "FileOwner" },
    { label: $_("common.group"), value: "FileGroup" },
  ]);

  const categories = $derived([
    { id: "general", label: $_("options.categories.general"), icon: Globe },
    { id: "appearance", label: $_("options.categories.appearance"), icon: Palette },
    { id: "interface", label: $_("options.categories.interface"), icon: Layout },
    { id: "custom_columns", label: $_("options.categories.columns"), icon: Columns },
  ]);

  function normalizeField(field: string): string {
    if (!field) return "";
    // If it looks like a tag (NC/DC, brackets, or GET), clean it
    if (
      field.includes("()") ||
      field.includes("[") ||
      field.includes("DC.") ||
      field.includes("NC.")
    ) {
      return field
        .replace(/[\[\]]/g, "")
        .replace(/\(\)/g, "")
        .replace(/GET/i, "")
        .replace(/\{\}/g, "")
        .replace(/^(NC|DC)\./i, "");
    }
    return field;
  }

  function getFieldLabel(value: string): string {
    const opt = fieldOptions.find((o) => o.value === value);
    return opt ? opt.label : value;
  }

  function onFieldChange(index: number, newValue: string) {
    config.columns[index].field_contents = newValue;
    config.columns[index].caption = getFieldLabel(newValue);
  }

  const langNames: Record<string, string> = {
    en: "English",
    de: "Deutsch",
    fr: "Français",
    nl: "Nederlands",
    es: "Español",
    it: "Italiano",
    pt: "Português",
    pl: "Polski",
    ru: "Русский"
  };

  onMount(async () => {
    // Load settings from store when dialog opens
    let initialConfig = appConfig;
    if (!initialConfig) {
      try { initialConfig = await loadSettings(); } catch (e) { console.error(e); }
    }
    
    if (initialConfig) {
      config = JSON.parse(JSON.stringify(initialConfig));
      config[folderBracketsKey] ??= true;
      config[parentRowKey] ??= true;

      // Normalize legacy language strings
      if (
        config.language === "doublecmd.pot" ||
        config.language === "doublecmd.en.po"
      )
        config.language = "en";
      else if (config.language === "doublecmd.de.po") config.language = "de";
      else if (config.language === "doublecmd.fr.po") config.language = "fr";

      // Ensure all font fields have fallback values
      config.font_main_name = config.font_main_name || "Inter, sans-serif";
      config.font_main_size = config.font_main_size ?? 11;
      config.font_menu_name = config.font_menu_name || "Inter, sans-serif";
      config.font_menu_size = config.font_menu_size ?? 11;
      config.font_drive_name = config.font_drive_name || "Inter, sans-serif";
      config.font_drive_size = config.font_drive_size ?? 11;
      config.font_tab_name = config.font_tab_name || "Inter, sans-serif";
      config.font_tab_size = config.font_tab_size ?? 11;
      config.font_header_name = config.font_header_name || "Inter, sans-serif";
      config.font_header_size = config.font_header_size ?? 11;
      config.font_pane_name = config.font_pane_name || "Inter, sans-serif";
      config.font_pane_size = config.font_pane_size ?? 11;
      config.font_status_name = config.font_status_name || "Inter, sans-serif";
      config.font_status_size = config.font_status_size ?? 11;

      // Normalize existing column fields to natural names
      if (config.columns && config.columns.length > 0) {
        config.columns = config.columns.map((col: ColumnConfig) => ({
          ...col,
          field_contents: normalizeField(col.field_contents),
        }));
      } else {
        // column_views only exists where saved views do.
        config.columns =
          config.column_views?.[config.custom_columns] ||
          config.column_views?.["Default"] ||
          [];
      }

      // Initialize size from config if available, clamped to current window
      if (config.options_window_width) {
        size.width = Math.min(
          window.innerWidth - 40,
          Math.max(500, config.options_window_width),
        );
      }
      if (config.options_window_height) {
        size.height = Math.min(
          window.innerHeight - 40,
          Math.max(400, config.options_window_height),
        );
      }
    }

  });

  // Web's version dispatched nc:open-help, which nothing listens for. Both
  // shells do handle nc:menu-action, so the button now opens help there.
  function handleHelp() {
    window.dispatchEvent(
      new CustomEvent("nc:menu-action", { detail: "help-options" }),
    );
  }

  async function handleApply(closeAfter = false) {
    try {
      saving = true;
      saveStatus = $_("options.saving");

      // Sanitize config: ensure numbers are numbers and strip Svelte proxies
      const cleanConfig = JSON.parse(JSON.stringify(config));

      // Ensure numeric fields are actually numbers and have valid defaults
      cleanConfig.font_main_size = Number(cleanConfig.font_main_size) || 11;
      cleanConfig.font_menu_size = Number(cleanConfig.font_menu_size) || 11;
      cleanConfig.font_drive_size = Number(cleanConfig.font_drive_size) || 11;
      cleanConfig.font_tab_size = Number(cleanConfig.font_tab_size) || 11;
      cleanConfig.font_header_size = Number(cleanConfig.font_header_size) || 11;
      cleanConfig.font_pane_size = Number(cleanConfig.font_pane_size) || 11;
      cleanConfig.font_status_size = Number(cleanConfig.font_status_size) || 11;

      if (cleanConfig.columns) {
        cleanConfig.columns = cleanConfig.columns.map((c: any) => ({
          ...c,
          width: Number(c.width) || 100,
        }));
      }

      // Save current size to options-specific config
      cleanConfig.options_window_width = size.width;
      cleanConfig.options_window_height = size.height;

      // Update the current view in column_views before saving
      if (cleanConfig.custom_columns && cleanConfig.column_views) {
        cleanConfig.column_views[cleanConfig.custom_columns] = JSON.parse(
          JSON.stringify(cleanConfig.columns),
        );
      }

      await onapply(cleanConfig);

      saveStatus = $_("options.saved");

      if (closeAfter) {
        close();
      } else {
        setTimeout(() => (saveStatus = ""), 3000);
      }
    } catch (e: any) {
      saveStatus = "Error: " + (e.message || e.toString());
      console.error("Save settings error:", e);
    } finally {
      saving = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    // If it's an Escape key, close the dialog
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
      return;
    }

    // Stop all other keys from bubbling to the window
    // so background components don't receive them.
    e.stopPropagation();
  }

  function close() {
    onclose?.();
  }

  // Dragging logic
  function startDrag(e: MouseEvent) {
    if ((e.target as HTMLElement).closest(".close-btn")) return;
    dragging = true;
    dragStart = { x: e.clientX - pos.x, y: e.clientY - pos.y };
  }

  function handleMouseMove(e: MouseEvent) {
    if (dragging) {
      let newX = e.clientX - dragStart.x;
      let newY = e.clientY - dragStart.y;

      // Boundary checks
      const maxX = window.innerWidth - size.width;
      const maxY = window.innerHeight - size.height;

      pos.x = Math.max(0, Math.min(newX, maxX));
      pos.y = Math.max(0, Math.min(newY, maxY));
    }
    if (resizing) {
      const dx = e.clientX - resizeStart.x;
      const dy = e.clientY - resizeStart.y;

      // Calculate new dimensions
      let newWidth = resizeStart.width + dx;
      let newHeight = resizeStart.height + dy;

      // Clamp to window size and minimums
      size.width = Math.min(window.innerWidth - 20, Math.max(500, newWidth));
      size.height = Math.min(window.innerHeight - 20, Math.max(400, newHeight));
    }
  }

  // Resizing logic
  function startResize(e: MouseEvent) {
    e.stopPropagation();
    resizing = true;
    resizeStart = {
      width: size.width,
      height: size.height,
      x: e.clientX,
      y: e.clientY,
    };
  }

  // Column management
  function addColumn() {
    config.columns = [
      ...config.columns,
      {
        caption: "Name",
        width: 100,
        align: "<-",
        field_contents: "FileName",
      },
    ];
  }

  function removeColumn(index: number) {
    config.columns = config.columns.filter((_, i) => i !== index);
  }

  function moveColumn(index: number, direction: "up" | "down") {
    const newCols = [...config.columns];
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex >= 0 && targetIndex < newCols.length) {
      [newCols[index], newCols[targetIndex]] = [
        newCols[targetIndex],
        newCols[index],
      ];
      config.columns = newCols;
    }
  }

  // Preset management
  function handleViewChange(e: Event) {
    const viewName = (e.target as HTMLSelectElement).value;
    // Save current columns to the old view first
    config.column_views[config.custom_columns] = JSON.parse(
      JSON.stringify(config.columns),
    );

    // Switch to new view
    config.custom_columns = viewName;
    if (config.column_views[viewName]) {
      config.columns = JSON.parse(
        JSON.stringify(config.column_views[viewName]),
      );
    }
  }

  function handleSaveAsView() {
    const name = prompt($_("options.columns_view_new_prompt"), $_("options.columns_view_new_default"));
    if (name && name.trim()) {
      const newName = name.trim();
      config.column_views[newName] = JSON.parse(JSON.stringify(config.columns));
      config.custom_columns = newName;
    }
  }

  function handleRenameView() {
    if (config.custom_columns === "Default") {
      alert($_("options.columns_view_default_locked"));
      return;
    }
    const name = prompt($_("options.columns_view_rename_prompt"), config.custom_columns);
    if (name && name.trim() && name.trim() !== config.custom_columns) {
      const newName = name.trim();
      config.column_views[newName] = config.column_views[config.custom_columns];
      delete config.column_views[config.custom_columns];
      config.custom_columns = newName;
    }
  }

  function handleDeleteView() {
    if (config.custom_columns === "Default") {
      alert($_("options.columns_view_default_locked"));
      return;
    }
    if (confirm($_("options.columns_view_delete_confirm", { name: config.custom_columns }))) {
      delete config.column_views[config.custom_columns];
      config.custom_columns = "Default";
      config.columns = JSON.parse(
        JSON.stringify(config.column_views["Default"]),
      );
    }
  }

  function handleSaveView() {
    config.column_views[config.custom_columns] = JSON.parse(
      JSON.stringify(config.columns),
    );
    saveStatus = $_("options.view_cached");
    setTimeout(() => (saveStatus = ""), 2000);
  }

  let wasInteracting = false;
  function handleBackdropClick(e: MouseEvent) {
    if (wasInteracting) return;
    if (e.target === e.currentTarget) {
      close();
    }
  }

  function stopDrag() {
    if (dragging || resizing) {
      wasInteracting = true;
      setTimeout(() => (wasInteracting = false), 100);
    }
    dragging = false;
    resizing = false;
  }
</script>

<svelte:window onmousemove={handleMouseMove} onmouseup={stopDrag} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="modal-backdrop"
  onkeydown={handleKeydown}
  onmousedown={(e: MouseEvent) => {
    if (dragging || resizing) e.preventDefault();
  }}
  in:fade={{ duration: 150 }}
  out:fade={{ duration: 100 }}
  role="presentation"
>
  <div
    class="modal"
    onclick={(e) => e.stopPropagation()}
    onmousedown={(e) => e.stopPropagation()}
    in:scale={{ start: 0.95, duration: 150 }}
    out:scale={{ start: 0.95, duration: 100 }}
    style="transform: translate({pos.x}px, {pos.y}px); width: {size.width}px; height: {size.height}px;"
  >
    <header class="modal-header" onmousedown={startDrag} style="cursor: move;">
      <div class="title">{$_("options.title")}</div>
      <button
        class="close-btn"
        onclick={(e) => {
          e.stopPropagation();
          close();
        }}>✕</button
      >
    </header>

    <div class="main-content" style="flex: 1; height: auto;">
      <div class="sidebar">
        {#each categories as category}
          {@const Icon = category.icon}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="tree-item"
            class:active={activeCategoryId === category.id}
            onclick={() => (activeCategoryId = category.id)}
          >
            <span class="icon">
              <Icon size={16} />
            </span>
            {category.label}
          </div>
        {/each}
      </div>

      <div class="content-area">
        <div class="panel-header">
          {categories.find((c) => c.id === activeCategoryId)?.label}
        </div>

        <div class="panel-body">
          {#if activeCategoryId === "general"}
            <div class="form-group">
              <label for="lang">{$_("options.general.language")}</label>
              <select
                id="lang"
                bind:value={config.language}
                class="input-element"
              >
                {#each availableLocales as langCode}
                  <option value={langCode}>
                    {langNames[langCode] || langCode.toUpperCase()}
                  </option>
                {/each}
              </select>
            </div>

            <div class="form-group" style="margin-top: 24px;">
              <p><strong>{$_("options.general.selection_style")}</strong></p>
              <label class="radio-label">
                <input
                  type="radio"
                  bind:group={config.behavior_selection_mode}
                  value="NC"
                />
                {$_("options.general.nc_mode")}
              </label>
              <label class="radio-label">
                <input
                  type="radio"
                  bind:group={config.behavior_selection_mode}
                  value="Windows"
                />
                {$_("options.general.standard_mode")}
              </label>
              <p class="description-text">{$_("options.general.standard_mode_desc")}</p>
            </div>

            <div class="form-group" style="margin-top: 24px;">
              <p><strong>{$_("options.general.audio_player")}</strong></p>
              <label class="radio-label">
                <input
                  type="radio"
                  bind:group={config.audio_player}
                  value="builtin"
                />
                {$_("options.general.audio_player_builtin")}
              </label>
              <label class="radio-label">
                <input
                  type="radio"
                  bind:group={config.audio_player}
                  value="system"
                />
                {$_("options.general.audio_player_system")}
              </label>
            </div>
          {:else if activeCategoryId === "appearance"}
            <div class="form-group">
              <label for="theme-select">{$_("options.appearance.theme_label")}</label>
              <select
                id="theme-select"
                bind:value={config.theme}
                class="input-element"
              >
                <optgroup label={$_("options.appearance.light_themes")}>
                  <option value="github-light">GitHub Light</option>
                  <option value="solarized-light">Solarized Light</option>
                  <option value="gruvbox-light">Gruvbox Light</option>
                  <option value="catppuccin-latte">Catppuccin Latte</option>
                  <option value="arctic-light">Arctic Light</option>
                </optgroup>
                <optgroup label={$_("options.appearance.dark_themes")}>
                  <option value="midnight">Midnight</option>
                  <option value="dracula">Dracula</option>
                  <option value="ocean">Ocean</option>
                  <option value="solarized-dark">Solarized Dark</option>
                  <option value="gruvbox">Gruvbox Dark</option>
                  <option value="nortonly">Nortonly</option>
                </optgroup>
              </select>
            </div>

            {#if IconPreview}
              <div class="form-group" style="margin-top: 20px;">
                <label for="icon-theme-select">{$_("options.appearance.icon_theme_label")}</label>
                <select
                  id="icon-theme-select"
                  bind:value={config.icon_theme}
                  class="input-element"
                >
                  <option value="material">Material Icons</option>
                  <option value="papirus">Papirus</option>
                  <option value="zorin">Nexus</option>
                  <option value="lucide">Lucide (Simple)</option>
                  <option value="tabler">Tabler</option>
                  <option value="fluent">Fluent UI System Icons</option>
                  <option value="material-symbols">Material Symbols</option>
                  <option value="phosphor">Phosphor</option>
                  <option value="remix">Remix Icon</option>
                </select>
                <div
                  class="icon-preview"
                  style="margin-top: 12px; display: flex; gap: 8px; align-items: center; padding: 8px; background: var(--color-nc-bg-panel); border-radius: 4px;"
                >
                  <IconPreview
                    name="folder"
                    ext=""
                    isDir={true}
                    theme={config.icon_theme}
                    size={16}
                  />
                  <IconPreview
                    name="main.js"
                    ext="js"
                    isDir={false}
                    theme={config.icon_theme}
                    size={16}
                  />
                  <IconPreview
                    name="script.py"
                    ext="py"
                    isDir={false}
                    theme={config.icon_theme}
                    size={16}
                  />
                  <IconPreview
                    name="main.rs"
                    ext="rs"
                    isDir={false}
                    theme={config.icon_theme}
                    size={16}
                  />
                  <IconPreview
                    name="readme.md"
                    ext="md"
                    isDir={false}
                    theme={config.icon_theme}
                    size={16}
                  />
                  <IconPreview
                    name="photo.png"
                    ext="png"
                    isDir={false}
                    theme={config.icon_theme}
                    size={16}
                  />
                  <IconPreview
                    name="archive.zip"
                    ext="zip"
                    isDir={false}
                    theme={config.icon_theme}
                    size={16}
                  />
                  <IconPreview
                    name="doc.pdf"
                    ext="pdf"
                    isDir={false}
                    theme={config.icon_theme}
                    size={16}
                  />
                </div>
              </div>
            {/if}

            <div class="divider"></div>

            <div class="fonts-section-header">{$_("options.appearance.fonts_title")}</div>

            <div class="fonts-container">
              <!-- Font sections for all 7 categories -->
              {#each [
                { label: $_("options.appearance.font_main"), target: "main" as const, name: "font_main_name" as keyof AppConfig, size: "font_main_size" as keyof AppConfig }, 
                { label: $_("options.appearance.font_menu"), target: "menu" as const, name: "font_menu_name" as keyof AppConfig, size: "font_menu_size" as keyof AppConfig }, 
                { label: $_("options.appearance.font_drive"), target: "drive" as const, name: "font_drive_name" as keyof AppConfig, size: "font_drive_size" as keyof AppConfig }, 
                { label: $_("options.appearance.font_tab"), target: "tab" as const, name: "font_tab_name" as keyof AppConfig, size: "font_tab_size" as keyof AppConfig }, 
                { label: $_("options.appearance.font_header"), target: "header" as const, name: "font_header_name" as keyof AppConfig, size: "font_header_size" as keyof AppConfig }, 
                { label: $_("options.appearance.font_pane"), target: "pane" as const, name: "font_pane_name" as keyof AppConfig, size: "font_pane_size" as keyof AppConfig }, 
                { label: $_("options.appearance.font_status"), target: "status" as const, name: "font_status_name" as keyof AppConfig, size: "font_status_size" as keyof AppConfig }
              ] as font}
                <div class="font-section">
                  <div class="section-label">{font.label}</div>
                  <div class="font-controls">
                    <input
                      type="text"
                      bind:value={config[font.name]}
                      class="input-element font-name-input"
                      readonly
                    />
                    <div class="number-stepper">
                      <input
                        type="number"
                        bind:value={config[font.size]}
                        class="input-element size-input"
                      />
                      <div class="stepper-btns">
                        <button
                          class="stepper-btn"
                          onclick={() => (config[font.size] as number)++}
                          >▴</button
                        >
                        <button
                          class="stepper-btn"
                          onclick={() => (config[font.size] as number)--}
                          >▾</button
                        >
                      </div>
                    </div>
                    <button
                      class="btn browse-btn"
                      onclick={() => openFontPicker(font.target)}>...</button
                    >
                  </div>
                </div>
              {/each}

              {#if fontPickerTarget}
                <div
                  class="font-picker-overlay"
                  onclick={() => (fontPickerTarget = null)}
                >
                  <div
                    class="font-picker-menu"
                    onclick={(e) => e.stopPropagation()}
                  >
                    <div class="picker-header">{$_("options.appearance.select_font_title")}</div>
                    <div class="picker-list">
                      {#each fontList as font}
                        <button
                          class="picker-item"
                          onclick={() => selectFont(font)}
                        >
                          {font}
                        </button>
                      {/each}
                    </div>
                  </div>
                </div>
              {/if}
            </div>
          {:else if activeCategoryId === "interface"}
            <div class="form-group">
              <label class="checkbox-label">
                <input type="checkbox" bind:checked={config.layout_show_menu} />
                {$_("options.interface.show_menu")}
              </label>
              <label class="checkbox-label">
                <input type="checkbox" bind:checked={config.show_folder_tabs} />
                {$_("options.interface.show_tabs")}
              </label>
              <label class="checkbox-label">
                <input
                  type="checkbox"
                  bind:checked={config[folderBracketsKey]}
                />
                {$_("options.interface.show_brackets")}
              </label>
              <label class="checkbox-label">
                <input
                  type="checkbox"
                  bind:checked={config[parentRowKey]}
                />
                {$_("options.interface.show_parent_row")}
              </label>
              <label class="checkbox-label">
                <input
                  type="checkbox"
                  bind:checked={config.show_alternating_row_colors}
                />
                {$_("options.interface.show_alternating_rows")}
              </label>
              <label class="checkbox-label">
                <input
                  type="checkbox"
                  bind:checked={config.show_file_sizes_in_bytes}
                />
                {$_("options.interface.show_file_sizes_in_bytes")}
              </label>
	            </div>
          {:else if activeCategoryId === "custom_columns"}
            <div class="form-group">
              {#if showSavedViews}
                <div class="columns-toolbar">
                  <div class="view-selector">
                    <label for="col-view">{$_("options.columns.view_label")}</label>
                    <select
                      id="col-view"
                      value={config.custom_columns}
                      onchange={handleViewChange}
                      class="input-element"
                    >
                      {#each Object.keys(config.column_views ?? {}) as viewName}
                        <option value={viewName}>{viewName}</option>
                      {/each}
                    </select>
                  </div>
                  <div class="toolbar-btns">
                    <button class="btn theme-btn" onclick={handleSaveView}
                      >{$_("options.buttons.save")}</button
                    >
                    <button class="btn theme-btn" onclick={handleSaveAsView}
                      >{$_("options.buttons.save_as")}</button
                    >
                    <button class="btn theme-btn" onclick={handleRenameView}
                      >{$_("options.buttons.rename")}</button
                    >
                    <button class="btn theme-btn" onclick={handleDeleteView}
                      >{$_("options.buttons.delete")}</button
                    >
                  </div>
                </div>
              {/if}

              <!-- Dynamic Columns Table -->
              <div class="table-container">
                <table class="columns-table">
                  <thead>
                    <tr>
                      <th style="width: 30px;">#</th>
                      <th style="width: 180px;">{$_("options.columns.table_header_contents")}</th>
                      <th style="width: 140px;">{$_("options.columns.table_header_caption")}</th>
                      <th style="width: 80px;">{$_("options.columns.table_header_width")}</th>
                      <th style="width: 90px;">{$_("options.columns.table_header_align")}</th>
                      <th style="width: 100px;">{$_("options.columns.table_header_actions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each config.columns as col, i}
                      <tr>
                        <td class="text-center">{i + 1}</td>
                        <td>
                          <select
                            bind:value={col.field_contents}
                            onchange={(e) =>
                              onFieldChange(
                                i,
                                (e.target as HTMLSelectElement).value,
                              )}
                            class="field-select-seamless"
                          >
                            <option value="" disabled selected>{$_("common.choose")}</option>
                            {#each fieldOptions as opt}
                              <option value={opt.value}>{opt.label}</option>
                            {/each}
                          </select>
                        </td>
                        <td
                          ><input
                            type="text"
                            bind:value={col.caption}
                            class="input-element table-input-premium"
                          /></td
                        >
                        <td
                          ><input
                            type="number"
                            bind:value={col.width}
                            class="input-element table-input-premium width-input"
                          /></td
                        >
                        <td>
                          <select
                            bind:value={col.align}
                            class="field-select-seamless align-select-premium"
                          >
                            <option value="<-">{$_("options.left")}</option>
                            <option value="->">{$_("options.right")}</option>
                          </select>
                        </td>
                        <td>
                          <div class="row-actions">
                            <button
                              class="icon-btn"
                              onclick={() => moveColumn(i, "up")}
                              disabled={i === 0}
                            >
                              <ArrowUp size={12} />
                            </button>
                            <button
                              class="icon-btn"
                              onclick={() => moveColumn(i, "down")}
                              disabled={i === config.columns.length - 1}
                            >
                              <ArrowDown size={12} />
                            </button>
                            <button
                              class="icon-btn danger"
                              onclick={() => removeColumn(i)}
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
              <div class="table-footer">
                <button class="btn theme-btn" onclick={addColumn}>
                  <Plus size={14} /> {$_("options.buttons.new")}
                </button>
              </div>
            </div>
          {/if}
        </div>
      </div>
    </div>

    <div class="footer">
      <div class="footer-left">
        <button class="btn help-btn">
          <span class="btn-icon">?</span>
          {$_("menu.help.label")}
        </button>
        {#if saveStatus}
          <span class="save-status" class:error={saveStatus.includes("Error")}>
            {saveStatus}
          </span>
        {/if}
      </div>
      <div class="footer-right">
        <button
          class="btn ok-btn"
          onclick={() => handleApply(true)}
          disabled={saving}
        >
          <span class="btn-icon">⏎</span>
          {$_("options.buttons.ok")}
        </button>
        <button class="btn cancel-btn" onclick={close}>
          <span class="btn-icon danger">ⓧ</span>
          {$_("options.buttons.cancel")}
        </button>
        <button
          class="btn apply-btn"
          onclick={() => handleApply(false)}
          disabled={saving}
        >
          {$_("options.buttons.apply")}
        </button>
        <button class="btn help-btn" onclick={handleHelp}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
          </svg>
          {$_("menu.help.label")}
        </button>
      </div>
    </div>

    <!-- Resize handle -->
    <div class="resize-handle" onmousedown={startResize}>
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="resize-icon"
      >
        <line x1="22" y1="6" x2="6" y2="22"></line>
        <line x1="22" y1="14" x2="14" y2="22"></line>
      </svg>
    </div>
  </div>
</div>

<datalist id="field-suggestions">
  {#each fieldOptions as opt}
    <option value={opt.value}>{opt.label}</option>
  {/each}
</datalist>

<style lang="css">
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 5000;
  }

  .modal {
    width: 520px;
    height: 400px;
    max-width: 95vw;
    max-height: 90vh;
    background: var(--color-nc-bg-deep);
    border: 1px solid var(--color-nc-border-bright);
    border-radius: 6px;
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    position: relative;
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 12px;
    background: var(--color-nc-bg-header);
    border-bottom: 1px solid var(--color-nc-border);
    flex-shrink: 0;
  }

  .title {
    font-size: 13px;
    font-weight: 600;
    color: var(--color-nc-text-bright);
    font-family: var(--font-family-sans);
  }

  .close-btn {
    background: none;
    border: none;
    color: var(--color-nc-text-dim);
    cursor: pointer;
    font-size: 14px;
    padding: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
  }

  .close-btn:hover {
    background: rgba(255, 255, 255, 0.1);
    color: var(--color-nc-text-bright);
  }

  .main-content {
    display: flex;
    flex: 1;
    min-height: 200px;
    background: var(--color-nc-bg);
  }

  .sidebar {
    width: 120px;
    background: var(--color-nc-bg-panel);
    border-right: 1px solid var(--color-nc-border);
    padding: 8px 0;
  }

  .footer-left {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  .save-status {
    font-size: 11px;
    color: var(--color-nc-success);
    font-weight: 500;
  }

  .save-status.error {
    color: var(--color-nc-danger);
  }

  .tree-item {
    display: flex;
    align-items: center;
    padding: 6px 12px;
    font-size: 13px;
    font-family: var(--font-family-sans);
    color: var(--color-nc-text);
    cursor: pointer;
    user-select: none;
    transition: all 0.15s ease;
  }

  .tree-item:hover:not(.active) {
    background: var(--color-nc-bg-hover);
  }

  .tree-item.active {
    background: var(--color-nc-accent-dim);
    color: var(--color-nc-text-bright);
  }

  .tree-item .icon {
    margin-right: 10px;
    display: flex;
    align-items: center;
  }

  .content-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    background: var(--color-nc-bg-deep);
  }

  .panel-header {
    background: var(--color-nc-bg-panel);
    color: var(--color-nc-text-bright);
    padding: 6px 12px;
    font-size: 13px;
    font-weight: 600;
    font-family: var(--font-family-sans);
    border-bottom: 1px solid var(--color-nc-border);
  }

  .panel-body {
    padding: 10px;
    flex: 1;
    overflow-y: auto;
    font-size: 13px;
    color: var(--color-nc-text);
  }

  .panel-body select,
  .panel-body input[type="text"],
  .panel-body input[type="number"],
  .panel-body .view-selector select {
    max-width: 320px;
  }

  .footer {
    display: flex;
    justify-content: space-between;
    padding: 8px 12px;
    border-top: 1px solid var(--color-nc-border);
    background: var(--color-nc-bg-panel);
    align-items: center;
    flex-shrink: 0;
  }

  .footer-left,
  .footer-right {
    display: flex;
    gap: 10px;
  }

  /* Fonts Section Styling */
  .fonts-container {
    display: flex;
    flex-direction: column;
    gap: 20px;
    height: 100%;
  }

  .font-section {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .section-label {
    font-size: 12px;
    color: var(--color-nc-text-dim);
    margin-left: 2px;
  }

  .font-controls {
    display: flex;
    gap: 8px;
    align-items: stretch;
  }

  .font-name-input {
    flex: 1;
    font-family: var(--font-family-sans);
  }

  .number-stepper {
    display: flex;
    align-items: stretch;
    background: var(--color-nc-bg-header);
    border: 1px solid var(--color-nc-border-bright);
    border-radius: 4px;
    overflow: hidden;
    width: 80px;
  }

  .size-input {
    width: 100%;
    border: none !important;
    background: transparent !important;
    padding: 0 8px !important;
    text-align: center;
    -moz-appearance: textfield;
    appearance: textfield;
  }

  .size-input::-webkit-outer-spin-button,
  .size-input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }

  .stepper-btns {
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--color-nc-border);
  }

  .btn {
    padding: 5px 12px;
    border: 1px solid var(--color-nc-border-bright);
    background: var(--color-nc-bg-header);
    color: var(--color-nc-text-bright);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
    border-radius: 4px;
    transition: all 0.15s ease;
  }

  .btn:hover {
    background: var(--color-nc-bg-hover);
    border-color: var(--color-nc-accent);
    color: var(--color-nc-text-bright);
  }

  .btn:active {
    background: var(--color-nc-bg-selected);
    transform: translateY(1px);
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .stepper-btn {
    flex: 1;
    width: 20px;
    background: var(--color-nc-bg-panel);
    border: none;
    color: var(--color-nc-text-dim);
    font-size: 8px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
  }

  .stepper-btn:hover {
    background: var(--color-nc-bg-hover);
    color: var(--color-nc-text-bright);
  }

  .stepper-btn:first-child {
    border-bottom: 1px solid var(--color-nc-border);
  }

  /* Font Picker */
  .font-picker-overlay {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.2);
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .font-picker-menu {
    background: var(--color-nc-bg-panel);
    border: 1px solid var(--color-nc-border-bright);
    border-radius: 4px;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
    width: 250px;
    max-height: 300px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .picker-header {
    padding: 8px 12px;
    background: var(--color-nc-bg-header);
    border-bottom: 1px solid var(--color-nc-border);
    font-size: 11px;
    font-weight: 600;
    color: var(--color-nc-text-bright);
  }

  .picker-list {
    overflow-y: auto;
    padding: 4px 0;
  }

  .picker-item {
    width: 100%;
    padding: 8px 16px;
    text-align: left;
    background: transparent;
    border: none;
    color: var(--color-nc-text);
    font-size: 12px;
    cursor: pointer;
  }

  .picker-item:hover {
    background: var(--color-nc-accent-dim);
    color: white;
  }

  .browse-btn {
    padding: 0 12px;
    min-width: 32px;
  }

  /* Form Layouts */
  .form-group {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .checkbox-label,
  .radio-label {
    display: flex;
    align-items: center;
    gap: 10px;
    cursor: pointer;
    font-family: var(--font-family-sans);
  }

  .checkbox-label input,
  .radio-label input {
    accent-color: var(--color-nc-accent);
    cursor: pointer;
  }

  .input-element {
    padding: 6px 12px;
    background: var(--color-nc-bg-header);
    border: 1px solid var(--color-nc-border-bright);
    border-radius: 4px;
    color: var(--color-nc-text-bright);
    outline: none;
    font-family: var(--font-family-sans);
    cursor: pointer;
  }

  select.input-element {
    appearance: none;
    background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='silver' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3e%3cpolyline points='6 9 12 15 18 9'%3e%3c/polyline%3e%3c/svg%3e");
    background-repeat: no-repeat;
    background-position: right 10px center;
    background-size: 12px;
    padding-right: 32px;
  }

  .input-element:focus {
    border-color: var(--color-nc-accent);
    box-shadow: 0 0 0 2px var(--color-nc-accent-glow);
  }

  option {
    background: var(--color-nc-bg-deep);
    color: var(--color-nc-text-bright);
    padding: 8px;
  }

  .divider {
    height: 1px;
    background: var(--color-nc-border);
    margin: 20px 0;
  }

  .fonts-section-header {
    font-size: 14px;
    font-weight: 700;
    color: var(--color-nc-text-bright);
    margin-bottom: 20px;
    font-family: var(--font-family-sans);
  }

  .columns-toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
    gap: 16px;
  }

  .view-selector {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
  }

  .toolbar-btns {
    display: flex;
    gap: 8px;
  }

  .btn.theme-btn {
    background: var(--color-nc-bg-alt);
    border: 1px solid var(--color-nc-border-bright);
    color: var(--color-nc-text);
    border-radius: 4px;
  }

  .btn.theme-btn:hover {
    background: var(--color-nc-bg-hover);
    color: var(--color-nc-text-bright);
    border-color: var(--color-nc-accent);
  }

  .columns-table {
    width: 100%;
    border-collapse: collapse;
    border: 1px solid var(--color-nc-border);
    background: var(--color-nc-bg-deep);
  }

  .columns-table th,
  .columns-table td {
    border: 1px solid var(--color-nc-border);
    padding: 0;
    vertical-align: middle;
  }

  .columns-table th {
    background: var(--color-nc-bg-header);
    color: var(--color-nc-text-bright);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    padding: 8px 12px;
    text-align: left;
  }

  /* Table Input Enhancements */
  .table-input-premium {
    width: 100%;
    height: 30px;
    padding: 0 12px;
    font-size: 12px;
    background: transparent;
    border: none;
    border-radius: 0;
    color: var(--color-nc-text-bright);
    outline: none;
    display: block;
    transition: background 0.2s ease;
  }

  .table-input-premium:focus {
    background: rgba(255, 255, 255, 0.05);
  }

  .width-input {
    text-align: center;
    font-family: var(--font-family-mono);
  }

  .width-input::-webkit-outer-spin-button,
  .width-input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }

  .align-select-premium {
    height: 30px;
    background: transparent;
    border: none;
    border-radius: 0;
    padding: 0 24px 0 12px;
    font-size: 11px;
    cursor: pointer;
  }

  .align-select-premium:focus {
    background: rgba(255, 255, 255, 0.05);
  }

  .field-select-seamless {
    width: 100%;
    height: 30px;
    padding: 0 24px 0 12px;
    font-size: 11px;
    background-color: transparent;
    border: none;
    border-radius: 0;
    color: var(--color-nc-text-bright);
    cursor: pointer;
    appearance: none;
    background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='silver' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3e%3cpolyline points='6 9 12 15 18 9'%3e%3c/polyline%3e%3c/svg%3e");
    background-repeat: no-repeat;
    background-position: right 8px center;
    background-size: 10px;
    outline: none;
    transition: background 0.2s ease;
  }

  .field-select-seamless:focus {
    background: rgba(255, 255, 255, 0.05);
  }

  .row-actions {
    display: flex;
    justify-content: center;
    gap: 4px;
    padding: 0 8px;
  }

  .btn-icon {
    font-size: 14px;
    font-weight: 400;
    margin-right: 4px;
  }

  .btn-icon.danger {
    color: var(--color-nc-danger);
  }

  .text-center {
    text-align: center !important;
  }

  .browse-btn {
    padding: 0 12px;
    min-width: 38px;
    justify-content: center;
  }
  .resize-handle {
    position: absolute;
    bottom: 0;
    right: 0;
    width: 24px;
    height: 24px;
    cursor: nwse-resize;
    display: flex;
    align-items: flex-end;
    justify-content: flex-end;
    padding: 2px;
    color: var(--color-nc-text-dim);
    z-index: 100;
  }

  .resize-icon {
    opacity: 0.5;
    transform: rotate(0deg);
  }

  .resize-handle:hover .resize-icon {
    color: var(--color-nc-accent);
    opacity: 1;
  }
</style>
