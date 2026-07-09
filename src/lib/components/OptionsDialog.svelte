<script lang="ts">
  import { fade } from "svelte/transition";
  import { scale } from "svelte/transition";
  import { Globe, Palette, Layout, CheckCircle, XCircle, Columns, FolderUp, Type, Plus, Trash2, ArrowUp, ArrowDown } from "lucide-svelte";
  import { Settings as SettingsIcon } from "lucide-svelte";
  import { 
    loadSettings, 
    saveSettings, 
    type AppConfig, 
    openConfigDir,
    listLanguages,
    type LanguageInfo,
    type ColumnConfig
  } from "$lib/ipc";
  import { loadLanguage, _ } from "$lib/i18n";
  import { appConfigStore } from "$lib/stores";

  let { onclose } = $props();

  let activeCategoryId = $state("general");
  let availableLangs = $state<LanguageInfo[]>([]);
  let saving = $state(false);
  let saveStatus = $state("");

  // resizable and draggable state
  let pos = $state({ x: 100, y: 100 });
  let size = $state({ width: 850, height: 600 });
  let dragging = $state(false);
  let resizing = $state(false);
  let dragStart = { x: 0, y: 0 };
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
    "Times New Roman, serif"
  ];
  let fontPickerTarget = $state<"main" | "menu" | "drive" | "tab" | "header" | "pane" | null>(null);

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
    fontPickerTarget = null;
  }

  const DEFAULT_COLUMNS: ColumnConfig[] = [
    { caption: "Name", width: 220, align: "<-", field_contents: "[NC().GETFILENAME{}]" },
    { caption: "Ext", width: 60, align: "<-", field_contents: "[NC().GETFILEEXT{}]" },
    { caption: "Size", width: 80, align: "->", field_contents: "[NC().GETFILESIZE{}]" },
    { caption: "Date", width: 130, align: "->", field_contents: "[NC().GETFILETIME{}]" },
  ];

  // This object mirrors our Rust AppConfig struct perfectly
  let config = $state<AppConfig>({
    upload_on_conflict: "ask",
    language: "en",
    layout_show_menu: true,
    layout_show_folder_brackets: false,
    layout_show_parent_dir_row: true,
    layout_show_toolbar: true,
    layout_is_vertical: true,
    layout_single_view: false,
    layout_panel_ratio: 0.5,
    layout_left_view_mode: "full",
    layout_right_view_mode: "full",
    theme: "midnight",
    icon_theme: "material",
    behavior_selection_mode: "NC",
    custom_columns: "Default",
    show_folder_tabs: true,
    show_alternating_row_colors: true,
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
    columns: [...DEFAULT_COLUMNS],
    left_tabs: [],
    right_tabs: [],
    left_active_tab: "",
    right_active_tab: "",
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
      copy_on_write: false
    }
  });

  $effect(() => {
    if ($appConfigStore) {
      // Normalize legacy language strings
      const c = JSON.parse(JSON.stringify($appConfigStore));
      if (c.language === "doublecmd.pot" || c.language === "doublecmd.en.po") c.language = "en";
      else if (c.language === "doublecmd.de.po") c.language = "de";
      else if (c.language === "doublecmd.fr.po") c.language = "fr";

      // Ensure all font fields have fallback values
      c.font_main_name = c.font_main_name || "Inter, sans-serif";
      c.font_main_size = c.font_main_size ?? 11;
      c.font_menu_name = c.font_menu_name || "Inter, sans-serif";
      c.font_menu_size = c.font_menu_size ?? 11;
      c.font_drive_name = c.font_drive_name || "Inter, sans-serif";
      c.font_drive_size = c.font_drive_size ?? 11;
      c.font_tab_name = c.font_tab_name || "Inter, sans-serif";
      c.font_tab_size = c.font_tab_size ?? 11;
      c.font_header_name = c.font_header_name || "Inter, sans-serif";
      c.font_header_size = c.font_header_size ?? 11;
      c.font_pane_name = c.font_pane_name || "Inter, sans-serif";
      c.font_pane_size = c.font_pane_size ?? 11;

      // Normalize existing column fields to natural names
      if (c.columns && c.columns.length > 0) {
        c.columns = c.columns.map((col: any) => ({
          ...col,
          field_contents: normalizeField(col.field_contents)
        }));
      } else {
        c.columns = [...DEFAULT_COLUMNS];
      }
      c.upload_on_conflict = c.upload_on_conflict ?? "ask";
      config = c;
    }
    
    listLanguages().then(langs => availableLangs = langs);
  });

  const fieldOptions = $derived([
    { label: $_('common.name'), value: "FileName" },
    { label: $_('common.ext'), value: "FileExt" },
    { label: $_('common.size'), value: "FileSize" },
    { label: $_('common.date'), value: "FileTime" },
    { label: $_('common.attr'), value: "FileAttr" },
    { label: $_('common.perm'), value: "FilePerm" },
    { label: $_('common.owner'), value: "FileOwner" },
    { label: $_('common.group'), value: "FileGroup" },
    { label: $_('common.path'), value: "FilePath" },
    { label: $_('common.created'), value: "FileCreationTime" },
    { label: $_('common.accessed'), value: "FileLastAccessTime" },
    { label: $_('common.changed'), value: "FileChangeTime" },
    { label: $_('common.link_target'), value: "FileLinkTo" },
    { label: $_('common.no_ext'), value: "FileNameNoExt" },
    { label: $_('common.type'), value: "FileType" },
    { label: $_('common.comment'), value: "FileComment" },
    { label: $_('common.compressed_size'), value: "FileCompressedSize" },
  ]);

  const categories = $derived([
    { id: "general", label: $_('options.general'), icon: Globe },
    { id: "appearance", label: $_('options.appearance'), icon: Palette },
    { id: "interface", label: $_('options.interface'), icon: Layout },
    { id: "custom_columns", label: $_('options.custom_columns'), icon: Columns },
  ]);

  function normalizeField(field: string): string {
    if (!field) return "";
    // If it looks like a tag (NC/DC, brackets, or GET), clean it
    if (field.includes("()") || field.includes("[") || field.includes("DC.") || field.includes("NC.")) {
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
    const opt = fieldOptions.find(o => o.value === value);
    return opt ? opt.label : value;
  }

  function onFieldChange(index: number, newValue: string) {
    config.columns[index].field_contents = newValue;
    config.columns[index].caption = getFieldLabel(newValue);
  }

  function handleFieldInput(index: number, newValue: string) {
    const norm = normalizeField(newValue);
    const label = getFieldLabel(norm);
    if (label !== norm || fieldOptions.some(o => o.value === norm)) {
      config.columns[index].caption = label;
    }
  }

  async function handleApply(closeAfter = false) {
    try {
      saving = true;
      saveStatus = $_('options.saving');
      
      // Sanitize config: ensure numbers are numbers and strip Svelte proxies
      const cleanConfig = JSON.parse(JSON.stringify(config));
      
      // Ensure numeric fields are actually numbers and have valid defaults
      cleanConfig.font_main_size = Number(cleanConfig.font_main_size) || 11;
      cleanConfig.font_menu_size = Number(cleanConfig.font_menu_size) || 11;
      cleanConfig.font_drive_size = Number(cleanConfig.font_drive_size) || 11;
      cleanConfig.font_tab_size = Number(cleanConfig.font_tab_size) || 11;
      cleanConfig.font_header_size = Number(cleanConfig.font_header_size) || 11;
      cleanConfig.font_pane_size = Number(cleanConfig.font_pane_size) || 11;
      
      if (cleanConfig.columns) {
        cleanConfig.columns = cleanConfig.columns.map((c: any) => ({
          ...c,
          width: Number(c.width) || 100
        }));
      }

      await saveSettings(cleanConfig);
      appConfigStore.set(cleanConfig);
      saveStatus = $_('options.saved');
      
      // Dispatch a settings changed event so other components can react
      window.dispatchEvent(new CustomEvent("nc:settings-changed", { detail: cleanConfig }));
      
      if (closeAfter) {
        close();
      } else {
        setTimeout(() => saveStatus = "", 3000);
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

  function handleHelp() {
    window.dispatchEvent(new CustomEvent('nc:open-help', { detail: 'options' }));
  }

  // Dragging logic
  function startDrag(e: MouseEvent) {
    if ((e.target as HTMLElement).closest('.close-btn')) return;
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
    resizeStart = { width: size.width, height: size.height, x: e.clientX, y: e.clientY };
  }

  // Column management
  function addColumn() {
    config.columns = [...config.columns, {
      caption: "Name",
      width: 100,
      align: "<-",
      field_contents: "FileName"
    }];
  }

  function removeColumn(index: number) {
    config.columns = config.columns.filter((_: ColumnConfig, i: number) => i !== index);
  }

  function moveColumn(index: number, direction: 'up' | 'down') {
    const newCols = [...config.columns];
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex >= 0 && targetIndex < newCols.length) {
      [newCols[index], newCols[targetIndex]] = [newCols[targetIndex], newCols[index]];
      config.columns = newCols;
    }
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
      setTimeout(() => wasInteracting = false, 100);
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
  onclick={handleBackdropClick} 
  onkeydown={handleKeydown}
  onmousedown={(e: MouseEvent) => { if (dragging || resizing) e.preventDefault(); }}
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
      <div class="title">{$_('options.title')}</div>
      <button class="close-btn" onclick={(e) => { e.stopPropagation(); close(); }}>✕</button>
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
            onclick={() => activeCategoryId = category.id}
          >
            <span class="icon">
              <Icon size={16} />
            </span>
            {category.label}
          </div>
        {/each}
      </div>

      <div class="content-area">
        <div class="panel-header">{categories.find(c => c.id === activeCategoryId)?.label}</div>
        
        <div class="panel-body">
          
          {#if activeCategoryId === 'general'}
            <div class="form-group">
              <label for="lang">{$_('options.language_interface')}:</label>
              <select 
                id="lang" 
                bind:value={config.language} 
                class="input-element"
                onchange={(e) => loadLanguage((e.target as HTMLSelectElement).value)}
              >
                {#each availableLangs as lang}
                  <option value={lang.code}>{lang.name}</option>
                {/each}
              </select>
            </div>

            <div class="form-group" style="margin-top: 24px;">
              <p><strong>{$_('options.selection_style')}</strong></p>
              <label class="radio-label">
                <input type="radio" bind:group={config.behavior_selection_mode} value="NC" />
                {$_('options.nc_mode')}
              </label>
              <label class="radio-label">
                <input type="radio" bind:group={config.behavior_selection_mode} value="Windows" />
                {$_('options.windows_mode')}
              </label>
            </div>

            <div class="form-group" style="margin-top: 24px;">
              <p><strong>{$_('options.behaviors')}</strong></p>
              <label for="upload-conflict-select">{$_('upload.when_exists')}</label>
              <select id="upload-conflict-select" bind:value={config.upload_on_conflict} class="input-element">
                <option value="ask">{$_('upload.policy_ask')}</option>
                <option value="overwrite">{$_('upload.policy_overwrite')}</option>
                <option value="overwrite_newer">{$_('upload.policy_overwrite_newer')}</option>
                <option value="overwrite_size_differs">{$_('upload.policy_overwrite_size_differs')}</option>
                <option value="skip">{$_('upload.policy_skip')}</option>
                <option value="rename_all">{$_('upload.policy_rename_all')}</option>
              </select>
            </div>

          {:else if activeCategoryId === 'appearance'}
            <div class="form-group">
              <label for="theme-select">{$_('options.select_theme')}</label>
              <select id="theme-select" bind:value={config.theme} class="input-element">
                <optgroup label={$_('options.dark_themes')}>
                  <option value="midnight">Midnight</option>
                  <option value="dracula">Dracula</option>
                  <option value="ocean">Ocean</option>
                  <option value="solarized-dark">Solarized Dark</option>
                  <option value="gruvbox">Gruvbox Dark</option>
                  <option value="nortonly">Nortonly</option>
                </optgroup>
                <optgroup label={$_('options.light_themes')}>
                  <option value="github-light">GitHub Light</option>
                  <option value="solarized-light">Solarized Light</option>
                  <option value="gruvbox-light">Gruvbox Light</option>
                  <option value="catppuccin-latte">Catppuccin Latte</option>
                  <option value="arctic-light">Arctic Light</option>
                </optgroup>
              </select>
            </div>

            <div class="form-group" style="margin-top: 20px;">
              <label for="icon-theme-select">{$_('options.icon_theme')}</label>
              <select id="icon-theme-select" bind:value={config.icon_theme} class="input-element">
                <option value="material">Material Icons</option>
                <option value="papirus">Papirus</option>
                <option value="lucide">{$_('options.lucide_icons')}</option>
              </select>
              <div class="icon-preview" style="margin-top: 12px; display: flex; gap: 8px; align-items: center; padding: 8px; background: var(--color-nc-bg-panel); border-radius: 4px;">
                {#if config.icon_theme === 'lucide'}
                  <span style="font-size: 11px; color: var(--color-nc-text-dim);">{$_('options.lucide_desc')}</span>
                {:else}
                  <img src="/icons/{config.icon_theme}/folder.svg" alt="folder" width="16" height="16" />
                  <img src="/icons/{config.icon_theme}/javascript.svg" alt="js" width="16" height="16" />
                  <img src="/icons/{config.icon_theme}/python.svg" alt="py" width="16" height="16" />
                  <img src="/icons/{config.icon_theme}/rust.svg" alt="rs" width="16" height="16" />
                  <img src="/icons/{config.icon_theme}/markdown.svg" alt="md" width="16" height="16" />
                  <img src="/icons/{config.icon_theme}/image.svg" alt="img" width="16" height="16" />
                  <img src="/icons/{config.icon_theme}/zip.svg" alt="zip" width="16" height="16" />
                  <img src="/icons/{config.icon_theme}/pdf.svg" alt="pdf" width="16" height="16" />
                {/if}
              </div>
            </div>

            <div class="fonts-container" style="margin-top: 24px; border-top: 1px solid var(--color-nc-border); padding-top: 24px;">
              <h3 style="margin: 0 0 16px 0; font-size: 14px; font-family: var(--font-family-sans); color: var(--color-nc-text-bright);">{$_('options.typography')}</h3>
              
              <div class="font-section">
                <div class="section-label">{$_('options.font_main')}</div>
                <div class="font-controls">
                  <input type="text" bind:value={config.font_main_name} class="input-element font-name-input" />
                  <div class="number-stepper">
                    <input type="number" bind:value={config.font_main_size} class="input-element size-input" />
                    <div class="stepper-btns">
                      <button class="stepper-btn" onclick={() => config.font_main_size++}>▴</button>
                      <button class="stepper-btn" onclick={() => config.font_main_size--}>▾</button>
                    </div>
                  </div>
                  <button class="btn browse-btn" onclick={() => openFontPicker("main")}>...</button>
                </div>
              </div>

              <div class="font-section">
                <div class="section-label">{$_('options.font_menu')}</div>
                <div class="font-controls">
                  <input type="text" bind:value={config.font_menu_name} class="input-element font-name-input" />
                  <div class="number-stepper">
                    <input type="number" bind:value={config.font_menu_size} class="input-element size-input" />
                    <div class="stepper-btns">
                      <button class="stepper-btn" onclick={() => config.font_menu_size++}>▴</button>
                      <button class="stepper-btn" onclick={() => config.font_menu_size--}>▾</button>
                    </div>
                  </div>
                  <button class="btn browse-btn" onclick={() => openFontPicker("menu")}>...</button>
                </div>
              </div>

              <div class="font-section">
                <div class="section-label">{$_('options.font_drive')}</div>
                <div class="font-controls">
                  <input type="text" bind:value={config.font_drive_name} class="input-element font-name-input" />
                  <div class="number-stepper">
                    <input type="number" bind:value={config.font_drive_size} class="input-element size-input" />
                    <div class="stepper-btns">
                      <button class="stepper-btn" onclick={() => config.font_drive_size++}>▴</button>
                      <button class="stepper-btn" onclick={() => config.font_drive_size--}>▾</button>
                    </div>
                  </div>
                  <button class="btn browse-btn" onclick={() => openFontPicker("drive")}>...</button>
                </div>
              </div>

              <div class="font-section">
                <div class="section-label">{$_('options.font_tab')}</div>
                <div class="font-controls">
                  <input type="text" bind:value={config.font_tab_name} class="input-element font-name-input" />
                  <div class="number-stepper">
                    <input type="number" bind:value={config.font_tab_size} class="input-element size-input" />
                    <div class="stepper-btns">
                      <button class="stepper-btn" onclick={() => config.font_tab_size++}>▴</button>
                      <button class="stepper-btn" onclick={() => config.font_tab_size--}>▾</button>
                    </div>
                  </div>
                  <button class="btn browse-btn" onclick={() => openFontPicker("tab")}>...</button>
                </div>
              </div>

              <div class="font-section">
                <div class="section-label">{$_('options.font_header')}</div>
                <div class="font-controls">
                  <input type="text" bind:value={config.font_header_name} class="input-element font-name-input" />
                  <div class="number-stepper">
                    <input type="number" bind:value={config.font_header_size} class="input-element size-input" />
                    <div class="stepper-btns">
                      <button class="stepper-btn" onclick={() => config.font_header_size++}>▴</button>
                      <button class="stepper-btn" onclick={() => config.font_header_size--}>▾</button>
                    </div>
                  </div>
                  <button class="btn browse-btn" onclick={() => openFontPicker("header")}>...</button>
                </div>
              </div>

              <div class="font-section">
                <div class="section-label">{$_('options.font_pane')}</div>
                <div class="font-controls">
                  <input type="text" bind:value={config.font_pane_name} class="input-element font-name-input" />
                  <div class="number-stepper">
                    <input type="number" bind:value={config.font_pane_size} class="input-element size-input" />
                    <div class="stepper-btns">
                      <button class="stepper-btn" onclick={() => config.font_pane_size++}>▴</button>
                      <button class="stepper-btn" onclick={() => config.font_pane_size--}>▾</button>
                    </div>
                  </div>
                  <button class="btn browse-btn" onclick={() => openFontPicker("pane")}>...</button>
                </div>
              </div>

              {#if fontPickerTarget}
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div class="font-picker-overlay" onclick={() => fontPickerTarget = null}>
                  <div class="font-picker-menu" onclick={e => e.stopPropagation()}>
                    <div class="picker-header">{$_('options.select_font')}</div>
                    <div class="picker-list">
                      {#each fontList as font}
                        <button class="picker-item" onclick={() => selectFont(font)}>
                          {font}
                        </button>
                      {/each}
                    </div>
                  </div>
                </div>
              {/if}
            </div>

          {:else if activeCategoryId === 'interface'}
            <div class="form-group">
              <label class="checkbox-label">
                <input type="checkbox" bind:checked={config.layout_show_menu} />
                {$_('options.show_menu')}
              </label>
              <label class="checkbox-label">
                <input type="checkbox" bind:checked={config.show_folder_tabs} />
                {$_('options.show_tabs')}
              </label>
              <label class="checkbox-label">
                <input type="checkbox" bind:checked={config.layout_show_folder_brackets} />
                {$_('menu.show_folder_brackets')}
              </label>
              <label class="checkbox-label">
                <input type="checkbox" bind:checked={config.layout_show_parent_dir_row} />
                {$_('options.show_parent_row')}
              </label>
              <label class="checkbox-label">
                <input type="checkbox" bind:checked={config.show_alternating_row_colors} />
                {$_('options.show_alternating_colors')}
              </label>
            </div>

          {:else if activeCategoryId === 'custom_columns'}
            <div class="form-group">
              <div class="grid-layout" style="grid-template-columns: auto 1fr;">
                <label for="col-view">{$_('options.columns_view')}</label>
                <div style="display: flex; gap: 8px;">
                  <select id="col-view" bind:value={config.custom_columns} class="input-element" style="flex: 1;">
                    <option value="Default">{$_('options.col_default')}</option>
                    <option value="Development">{$_('options.col_development')}</option>
                    <option value="Media">{$_('options.col_media')}</option>
                  </select>
                  <button class="btn">{$_('common.save')}</button>
                  <button class="btn">{$_('options.save_as')}</button>
                  <button class="btn">{$_('menu.edit')}</button>
                  <button class="btn">{$_('menu.delete')}</button>
                </div>
              </div>

              <!-- Dynamic Columns Table -->
              <div class="table-container">
                <table class="columns-table">
                  <thead>
                    <tr>
                      <th style="width: 30px;">#</th>
                      <th>{$_('options.caption')}</th>
                      <th style="width: 80px;">{$_('options.width')}</th>
                      <th style="width: 60px;">{$_('options.align')}</th>
                      <th>{$_('options.field_contents')}</th>
                      <th style="width: 100px;">{$_('options.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each config.columns as col, i}
                      <tr>
                        <td>{i + 1}</td>
                        <td><input type="text" bind:value={col.caption} class="table-input" /></td>
                        <td><input type="number" bind:value={col.width} class="table-input" /></td>
                        <td>
                          <select bind:value={col.align} class="table-input">
                            <option value="<-">{$_('options.left')}</option>
                            <option value="->">{$_('options.right')}</option>
                          </select>
                        </td>
                        <td>
                          <div style="display: flex; gap: 4px;">
                            <input 
                              type="text" 
                              bind:value={col.field_contents} 
                              class="table-input" 
                              list="field-suggestions"
                              oninput={(e) => handleFieldInput(i, (e.target as HTMLInputElement).value)}
                            />
                            <select 
                              class="mini-select" 
                              onchange={(e) => onFieldChange(i, (e.target as HTMLSelectElement).value)}
                            >
                              <option value="">{$_('common.choose')}</option>
                              {#each fieldOptions as opt}
                                <option value={opt.value} selected={col.field_contents === opt.value}>{opt.label}</option>
                              {/each}
                            </select>
                          </div>
                        </td>
                        <td>
                          <div class="row-actions">
                            <button class="icon-btn" onclick={() => moveColumn(i, 'up')} disabled={i === 0}>
                              <ArrowUp size={12}/>
                            </button>
                            <button class="icon-btn" onclick={() => moveColumn(i, 'down')} disabled={i === config.columns.length - 1}>
                              <ArrowDown size={12}/>
                            </button>
                            <button class="icon-btn danger" onclick={() => removeColumn(i)}>
                              <Trash2 size={12}/>
                            </button>
                          </div>
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>

              <div style="margin-top: 12px; display: flex; justify-content: flex-end;">
                <button class="btn" onclick={addColumn}>
                  <Plus size={14}/> {$_('options.new')}
                </button>
              </div>
            </div>
          {/if}

        </div>
      </div>
    </div>

    <div class="footer">
      <div class="footer-left">
        <button class="btn help-btn" onclick={handleHelp}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
          </svg>
          {$_('menu.help')}
        </button>
        {#if saveStatus}
          <span class="save-status" class:error={saveStatus.includes("Error")}>
            {saveStatus}
          </span>
        {/if}
      </div>
      <div class="footer-right">
        <button class="btn ok-btn" onclick={() => handleApply(true)} disabled={saving}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 10l-5 5 5 5"></path>
            <path d="M20 4v7a4 4 0 0 1-4 4H4"></path>
          </svg>
          {$_('dialogs.ok')}
        </button>
        <button class="btn cancel-btn" onclick={close}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--color-nc-danger)" stroke-width="3">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="15" y1="9" x2="9" y2="15"></line>
            <line x1="9" y1="9" x2="15" y2="15"></line>
          </svg>
          {$_('dialogs.cancel')}
        </button>
        <button class="btn apply-btn" onclick={() => handleApply(false)} disabled={saving}>
          {$_('dialogs.apply')}
        </button>
      </div>
    </div>
    
    <!-- Resize handle -->
    <div class="resize-handle" onmousedown={startResize}></div>
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
    background: transparent;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 5000;
  }

  .modal {
    width: 850px;
    height: 600px;
    max-width: 90vw;
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
    padding: 10px 16px;
    background: var(--color-nc-bg-header);
    border-bottom: 1px solid var(--color-nc-border);
  }

  .title {
    font-size: 14px;
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
    min-height: 400px;
    background: var(--color-nc-bg);
  }
  
  .sidebar { 
    width: 180px; 
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
    padding: 8px 16px; 
    font-size: 13px; 
    font-family: var(--font-family-sans);
    color: var(--color-nc-text);
    cursor: pointer; 
    transition: background 0.15s ease;
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
    padding: 8px 16px; 
    font-size: 13px; 
    font-weight: 600;
    font-family: var(--font-family-sans);
    border-bottom: 1px solid var(--color-nc-border);
  }
  
  .panel-body { 
    padding: 24px; 
    overflow-y: auto; 
    font-size: 13px; 
    color: var(--color-nc-text);
  }
  
  .footer { 
    display: flex; 
    justify-content: space-between; 
    padding: 10px 16px; 
    border-top: 1px solid var(--color-nc-border); 
    background: var(--color-nc-bg-panel);
    align-items: center;
  }
  
  .footer-left, .footer-right { 
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
    padding: 4px 12px;
    border: 1px solid #888;
    background: linear-gradient(180deg, #fdfdfd 0%, #d0d0d0 100%);
    color: #111;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
    box-shadow: 0 1px 1px rgba(0,0,0,0.1);
    border-radius: 2px;
    transition: all 0.1s ease;
  }

  :global(.dark) .btn {
    background: linear-gradient(180deg, #44546a 0%, #2c3e50 100%);
    border-color: #556677;
    color: #f8fafc;
  }

  .btn:hover {
    filter: brightness(1.1);
    border-color: #667788;
  }

  .btn:active {
    filter: brightness(0.9);
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
  
  .checkbox-label, .radio-label { 
    display: flex; 
    align-items: center; 
    gap: 10px; 
    cursor: pointer; 
    font-family: var(--font-family-sans);
  }

  .checkbox-label input, .radio-label input {
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
  
  .grid-layout { 
    display: grid; 
    grid-template-columns: 180px 1fr; 
    align-items: center; 
    gap: 12px; 
  }



  /* Custom columns table */
  .table-container {
    flex: 1;
    overflow-y: auto;
    border: 1px solid var(--color-nc-border);
    background: var(--color-nc-bg-deep);
  }

  .columns-table {
    width: 100%;
    border-collapse: collapse;
  }

  .columns-table th, .columns-table td {
    border: 1px solid var(--color-nc-border);
    padding: 4px 8px;
    text-align: left;
    font-size: 12px;
    font-family: var(--font-family-sans);
    color: var(--color-nc-text);
  }

  .columns-table th {
    background: var(--color-nc-bg-header);
    color: var(--color-nc-text-bright);
    font-weight: 500;
    position: sticky;
    top: 0;
    z-index: 10;
  }

  .table-input {
    width: 100%;
    background: transparent;
    border: 1px solid transparent;
    color: var(--color-nc-text-bright);
    font-size: 12px;
    padding: 2px 6px;
    outline: none;
    border-radius: 2px;
  }

  .table-input:focus {
    background: var(--color-nc-bg-header);
    border-color: var(--color-nc-accent-dim);
  }



  .row-actions {
    display: flex;
    gap: 4px;
  }

  .icon-btn {
    background: none;
    border: 1px solid var(--color-nc-border);
    color: var(--color-nc-text-dim);
    border-radius: 4px;
    padding: 2px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .icon-btn:hover:not(:disabled) {
    background: var(--color-nc-bg-hover);
    color: var(--color-nc-text-bright);
  }

  .icon-btn.danger:hover {
    color: var(--color-nc-danger);
    border-color: var(--color-nc-danger);
  }

  .icon-btn:disabled {
    opacity: 0.3;
    cursor: default;
  }

  .resize-handle {
    position: absolute;
    bottom: 0;
    right: 0;
    width: 16px;
    height: 16px;
    cursor: nwse-resize;
    background: linear-gradient(135deg, transparent 50%, var(--color-nc-text-dim) 50%, var(--color-nc-text-dim) 60%, transparent 60%, transparent 70%, var(--color-nc-text-dim) 70%);
  }

  .mini-select {
    background: var(--color-nc-bg-header);
    border: 1px solid var(--color-nc-border-bright);
    color: var(--color-nc-text-bright);
    font-size: 10px;
    border-radius: 3px;
    padding: 0 4px;
    cursor: pointer;
    width: 24px;
    appearance: none;
    background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='gray' stroke-width='4' stroke-linecap='round' stroke-linejoin='round'%3e%3cpolyline points='6 9 12 15 18 9'%3e%3c/polyline%3e%3c/svg%3e");
    background-repeat: no-repeat;
    background-position: center;
    background-size: 10px;
  }

  .mini-select:hover {
    color: var(--color-nc-text-bright);
    border-color: var(--color-nc-accent);
    background-color: var(--color-nc-bg-hover);
  }



  select.table-input {
    appearance: none;
    background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='gray' stroke-width='4' stroke-linecap='round' stroke-linejoin='round'%3e%3cpolyline points='6 9 12 15 18 9'%3e%3c/polyline%3e%3c/svg%3e");
    background-repeat: no-repeat;
    background-position: right 4px center;
    background-size: 8px;
    padding-right: 16px;
  }
</style>
