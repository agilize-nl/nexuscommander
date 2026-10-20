<script lang="ts">
  import type { DialogType, FileEntry } from "../types";
  import { formatSize } from "../utils";
  import { fade, scale } from "svelte/transition";
  import { XCircle, Play, Triangle, ListPlus } from "lucide-svelte";
  import { _ } from "../i18n";
  import { readDirectory } from "../ipc";
  import { getIpc } from "../ipc-registry";
  import FilePropertiesDialog, { type PropertyChanges } from "./FilePropertiesDialog.svelte";

  interface Props {
    type: DialogType;
    inputValue?: string;
    entries?: FileEntry[];
    sourcePaths?: string[];
    targetDir?: string;
    sourceDir?: string;
    isPermanent?: boolean;
    onconfirm: (value: string, options?: any) => void;
    oncancel: () => void;
    /** Adds the current copy/move/delete choice to the session transfer queue. */
    onqueue?: (value: string) => void;
    /** False for operations that cannot safely use taskCreate(), such as archive extraction. */
    queueAvailable?: boolean;
    queueUnavailableReason?: string;
    fileOpOptions?: any;
    onsaveoptions?: (options: any) => void;
    /** Forwarded to FilePropertiesDialog; see its prop docs. */
    onpermissiondenied?: (path: string, changes: PropertyChanges) => void;
  }

  let props: Props = $props();

  // A source path containing "::" points inside an archive, so a "copy" is
  // really an extraction and the dialog says so.
  const isArchiveSource = $derived(
    props.sourcePaths && props.sourcePaths.some((p) => p.includes("::"))
  );

  let value = $state("");
  let inputEl: HTMLInputElement | undefined = $state(undefined);
  let confirmBtnEl: HTMLButtonElement | undefined = $state(undefined);
  let isPermanentDelete = $state(false);
  let showAllEntries = $state(false);

  // Only the web shell escalates by asking for a password, so only it
  // implements getSystemUser; the placeholder covers shells that do not.
  let systemUsername = $state("administrator");

  $effect(() => {
    if (props.type !== "sudo_password") return;
    getIpc()
      .getSystemUser?.()
      .then((data) => {
        if (data?.username) systemUsername = data.username;
      })
      .catch(console.error);
  });

  // Dragging state
  let pos = $state({ x: 0, y: 0 });
  let dragging = $state(false);
  let dragStart = { x: 0, y: 0 };
  const dialogWidth = 500;
  const dialogHeight = 400; // Estimated max height

  $effect(() => {
    if (inputEl && props.type) {
      setTimeout(() => inputEl?.focus(), 50);
    } else if (confirmBtnEl && (props.type === "error" || props.type === "confirm" || props.type === "confirm_download")) {
      setTimeout(() => confirmBtnEl?.focus(), 50);
    }
  });

  $effect(() => {
    // Dialog remains mounted while it is closed.  Reading `type` makes this
    // run for every close/open cycle too, including when the next dialog has
    // the same empty inputValue as the previous one (such as mkdir).
    const { type, inputValue } = props;
    void type;
    value = inputValue || "";
  });

  $effect(() => {
    if (props.type) showAllEntries = false;
  });

  $effect(() => {
    if (props.type === "delete") {
      isPermanentDelete = !!props.isPermanent;
    }
  });

  $effect(() => {
    if (props.type === "pack") {
      packDestDir = props.targetDir || "";
    }
  });

  /**
   * Whether the focused element answers Enter/Space itself.
   *
   * This handler is also bound on `<svelte:window>`, so it saw every Enter in
   * the dialog — including one pressed while the *Cancel* button had focus.
   * It called `preventDefault()`, which suppressed the button's own click, and
   * then ran `onconfirm` anyway: tabbing to Cancel and pressing Enter started
   * the delete or the permission change. Anything focusable that has its own
   * activation behaviour must be left to it.
   */
  function focusIsSelfHandling(): boolean {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === "button" || tag === "a" || tag === "select" || tag === "textarea") return true;
    if (tag === "input") {
      const type = (el as HTMLInputElement).type;
      return type === "checkbox" || type === "radio" || type === "button";
    }
    return el.getAttribute("role") === "button";
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.oncancel();
      return;
    }
    if (
      e.key === "F2" &&
      props.queueAvailable &&
      props.onqueue &&
      (props.type === "copy" || props.type === "move" || props.type === "delete")
    ) {
      e.preventDefault();
      // FileList also registers a handler on window. The shell overlay blocks
      // it, while this additionally prevents sibling window listeners from
      // acting on the same event.
      e.stopImmediatePropagation();
      queueCurrentOperation();
      return;
    }
    if (e.key === "Enter") {
      if (focusIsSelfHandling()) {
        // Let the focused control act; only stop the key escaping to the app.
        e.stopPropagation();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (props.type === "pack") {
        const fullPath = packDestDir ? (packDestDir.endsWith("/") ? packDestDir + value.split("/").pop() : packDestDir + "/" + value.split("/").pop()) : value;
        props.onconfirm(fullPath, packOptions);
      } else if (props.type === "delete") {
        props.onconfirm(isPermanentDelete ? "permanent" : "trash");
      } else {
        props.onconfirm(value);
      }
      return;
    }
    if (props.type === "delete" && (e.key === "Delete" || e.key === "F8") && e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      isPermanentDelete = true;
      return;
    }
    // Stop all other keys from bubbling to the window
    e.stopPropagation();
  }

  function queueCurrentOperation() {
    if (!props.queueAvailable || !props.onqueue) return;
    if (props.type === "copy" || props.type === "move") {
      const target = value.trim();
      if (!target) return;
      props.onqueue(target);
    } else if (props.type === "delete") {
      props.onqueue(isPermanentDelete ? "permanent" : "trash");
    }
  }

  function getTitle(): string {
    switch (props.type) {
      case "mkdir":
        return $_("dialog.mkdir_title");
      case "rename":
        return $_("dialog.rename_title");
      case "delete":
        return $_("dialog.delete_title");
      case "copy":
        return isArchiveSource ? $_("dialogs.extract_title") : $_("dialog.copy_title");
      case "move":
        return $_("dialog.move_title");
      case "pack":
        return $_("dialog.pack_title");
      case "unpack":
        return $_("dialog.unpack_title");
      case "select_group":
        return $_("dialog.select_group_title");
      case "unselect_group":
        return $_("dialog.unselect_group_title");
      case "properties":
        return $_("dialog.properties_title");
      case "split":
        return $_("dialog.split_title");
      case "combine":
        return $_("dialog.combine_title");
      case "confirm":
        return $_("dialog.confirm");
      case "confirm_download":
        return $_("download.title");
      case "error":
        return $_("dialog.error") || "Error";
      case "permission_denied":
        return $_("dialogs.permission_denied_title");
      case "sudo_password":
        return $_("dialogs.sudo_title");
      default:
        return "";
    }
  }

  let totalSize = $derived(
    (props.entries || []).reduce((sum, e) => sum + e.size, 0)
  );

  // ---------- Options Panel State ----------
  let showOptions = $state(false);
  let packDestDir = $state("");
  let packDestDirFocused = $state(false);
  let packDestPickerPath = $state("");
  let packDestPickerEntries = $state<FileEntry[]>([]);
  let packDestPickerLoading = $state(false);

  async function loadPickerDir(path: string) {
    packDestPickerLoading = true;
    try {
      const entries = await readDirectory(path);
      packDestPickerEntries = entries
        .filter((e: FileEntry) => e.is_dir)
        .sort((a: FileEntry, b: FileEntry) => a.name.localeCompare(b.name));
      packDestPickerPath = path;
    } catch {
      packDestPickerEntries = [];
    }
    packDestPickerLoading = false;
  }

  function handlePackDestFocus() {
    packDestDirFocused = true;
    const basePath = packDestDir || "/";
    const dir = packDestDir.endsWith("/") ? packDestDir : basePath.substring(0, basePath.lastIndexOf("/")) || "/";
    loadPickerDir(dir || "/");
  }

  function handlePackDestBlur() {
    setTimeout(() => { packDestDirFocused = false; }, 200);
  }

  function selectPickerFolder(folder: FileEntry) {
    const newPath = packDestPickerPath + "/" + folder.name;
    packDestDir = newPath;
    packDestDirFocused = false;
    loadPickerDir(newPath);
  }

  function goUpPicker() {
    if (packDestPickerPath && packDestPickerPath !== "/") {
      const parent = packDestPickerPath.substring(0, packDestPickerPath.lastIndexOf("/")) || "/";
      loadPickerDir(parent);
    }
  }

  let packOptions = $state({
    format: "zip",
    compression_level: 6,
    solid_archive: false,
    follow_links: true,
  });
  let options = $derived(props.fileOpOptions || {
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
  });

  const whenOptions = $derived([
    { value: "Ask", label: $_("dialog.ask") },
    { value: "Overwrite", label: $_("dialog.overwrite") },
    { value: "Skip", label: $_("dialog.skip") },
    { value: "Rename", label: $_("dialog.rename") },
  ]);

  /**
   * Every format the pack dialog knows how to describe, in display order.
   *
   * This is a *description* table, not a claim: which of these the dialog offers
   * comes from `archiveFormats` below, which filters against what the backend
   * says it can actually write (P2.1). Offering `TAR.ZST` on a host without
   * `zstd` installed is how the user ends up with a failed pack or, worse, a
   * silent substitution.
   */
  const knownArchiveFormats = [
    { value: "zip", label: "ZIP", info: "dialog.pack_info_zip" },
    { value: "tar.gz", label: "TAR.GZ", info: "dialog.pack_info_tar_gz" },
    { value: "tar.bz2", label: "TAR.BZ2", info: "dialog.pack_info_tar_bz2" },
    { value: "tar.xz", label: "TAR.XZ", info: "dialog.pack_info_tar_xz" },
    { value: "tar.zst", label: "TAR.ZST", info: "dialog.pack_info_tar_zst" },
  ];

  /**
   * `null` until the capability call answers — the list falls back to every known
   * format meanwhile, so a slow or absent `getArchiveCapabilities` degrades to the
   * old behaviour instead of an empty dropdown.
   */
  let packableFormats = $state<Set<string> | null>(null);

  $effect(() => {
    if (props.type !== "pack") return;
    getIpc()
      .getArchiveCapabilities?.()
      .then((caps) => {
        packableFormats = new Set(caps.filter((c) => c.canPack).map((c) => c.format));
      })
      .catch(console.error);
  });

  let archiveFormats = $derived(
    packableFormats === null
      ? knownArchiveFormats
      : knownArchiveFormats.filter((f) => packableFormats!.has(f.value))
  );

  // If the selected format turns out not to be packable, move to one that is
  // rather than leaving a selection the backend will refuse.
  $effect(() => {
    if (props.type !== "pack" || archiveFormats.length === 0) return;
    if (!archiveFormats.some((f) => f.value === packOptions.format)) {
      handlePackOptionChange("format", archiveFormats[0].value);
    }
  });

  const compressionLevels = [
    { value: 0, label: "Store" },
    { value: 1, label: "Fastest" },
    { value: 3, label: "Fast" },
    { value: 6, label: "Normal" },
    { value: 9, label: "Maximum" },
  ];

  function handleOptionChange(key: string, val: any) {
    if (props.fileOpOptions && props.onsaveoptions) {
      const newOptions = { ...props.fileOpOptions, [key]: val };
      props.onsaveoptions(newOptions);
    }
  }

  function handlePackOptionChange(key: string, val: any) {
    packOptions = { ...packOptions, [key]: val };
    if (key === "format") {
      const ext = "." + val;
      // Robust extension replacement for archives (including .tar.*)
      const archiveExts = [".zip", ".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst"];
      let basename = value;
      
      // Try to find if value ends with any of the known extensions
      for (const knownExt of archiveExts) {
        if (value.toLowerCase().endsWith(knownExt)) {
          basename = value.substring(0, value.length - knownExt.length);
          break;
        }
      }
      
      // If no known archive extension was found, but it has a dot, try to strip last part if it looks like an extension
      if (basename === value) {
        const lastDot = value.lastIndexOf(".");
        if (lastDot > 0 && lastDot > value.lastIndexOf("/")) {
           basename = value.substring(0, lastDot);
        }
      }
      
      value = basename + ext;
    }
  }

  function getDefaultExtension(): string {
    return "." + packOptions.format;
  }

  function toggleOptions() {
    showOptions = !showOptions;
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
      const dialogEl = document.querySelector('.dialog-box') as HTMLElement;
      const width = dialogEl?.offsetWidth || dialogWidth;
      const height = dialogEl?.offsetHeight || dialogHeight;

      const maxX = window.innerWidth - width;
      const maxY = window.innerHeight - height;

      pos.x = Math.max(0, Math.min(newX, maxX));
      pos.y = Math.max(0, Math.min(newY, maxY));
    }
  }

  function stopDrag() {
    dragging = false;
  }
</script>

<svelte:window onmousemove={handleMouseMove} onmouseup={stopDrag} onkeydown={(e) => props.type && handleKeydown(e)} />

{#if props.type === "properties" && props.entries?.[0]}
  <FilePropertiesDialog
    entry={props.entries[0]}
    path={props.sourcePaths?.[0] || props.sourceDir || ""}
    onclose={props.oncancel}
    onpermissiondenied={props.onpermissiondenied}
  />
{:else if props.type}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="dialog-overlay"
    onclick={props.oncancel}
    onkeydown={handleKeydown}
    in:fade={{ duration: 150 }}
    out:fade={{ duration: 100 }}
  >
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div 
      class={"dialog-box " + props.type} 
      onclick={(e) => e.stopPropagation()}
      in:scale={{ start: 0.95, duration: 150 }} 
      out:scale={{ start: 0.95, duration: 100 }}
      style="transform: translate({pos.x}px, {pos.y}px);"
    >
      <div class="dialog-header" onmousedown={startDrag}>
        <span class="dialog-title">{getTitle()}</span>
        <button class="close-btn" onclick={props.oncancel}>✕</button>
      </div>

      <div class="dialog-body">
        {#if props.type === "mkdir"}
          <div class="form-group">
            <label class="dialog-label" for="mkdir-input">{$_("dialog.mkdir_label")}</label>
            <input
              id="mkdir-input"
              type="text"
              class="dialog-input"
              bind:value
              bind:this={inputEl}
              onkeydown={handleKeydown}
              placeholder={$_("menu.files.new_folder")}
              spellcheck="false"
            />
          </div>

        {:else if props.type === "rename"}
          <div class="form-group">
            <label class="dialog-label" for="rename-input">{$_("dialog.rename_label")}</label>
            <input
              id="rename-input"
              type="text"
              class="dialog-input"
              bind:value
              bind:this={inputEl}
              onkeydown={handleKeydown}
              spellcheck="false"
            />
          </div>

        {:else if props.type === "delete"}
          {@const count = props.entries?.length || 0}
          <div class="confirm-msg">
            {#if isPermanentDelete}
               <p style="color: var(--color-nc-error); font-weight: bold;">
                 {count === 1
                   ? ($_("dialog.delete_permanent_prompt_single") || "Are you sure you want to PERMANENTLY delete 1 item?")
                   : ($_("dialog.delete_permanent_prompt", { n: count }) || `Are you sure you want to PERMANENTLY delete ${count} items?`)}
               </p>
            {:else}
               <p>
                 {count === 1
                   ? ($_("dialog.delete_trash_prompt_single") || "Are you sure you want to move 1 item to the trash?")
                   : ($_("dialog.delete_trash_prompt", { n: count }) || `Are you sure you want to move ${count} items to the trash?`)}
               </p>
            {/if}
            
            <div class="item-list">
              {#each (showAllEntries ? (props.entries || []) : (props.entries || []).slice(0, 5)) as entry}
                <div class="item-line">
                  <span class="item-icon">{entry.is_dir ? "📁" : "📄"}</span>
                  <span class="item-name">{entry.name}</span>
                </div>
              {/each}
              {#if (props.entries || []).length > 5}
                <button
                  type="button"
                  class="preview-more-btn"
                  onclick={() => (showAllEntries = !showAllEntries)}
                >
                  {showAllEntries
                    ? "▲ " + ($_("dialog.show_less") || "Show less")
                    : $_("dialog.more_items", { n: (props.entries || []).length - 5 })}
                </button>
              {/if}
            </div>
            
            <div style="margin-top: 16px;">
              <label class="checkbox-label" style="justify-content: center;">
                <input 
                  type="checkbox" 
                  bind:checked={isPermanentDelete} 
                />
                {$_("dialog.delete_permanently")}
              </label>
            </div>
          </div>
        {:else if props.type === "copy" || props.type === "move"}
          {@const count = props.entries?.length || 0}
          <div class="transfer-info">
            <p class="dlg-label">
              {#if props.type === "copy" && isArchiveSource}
                {$_("dialogs.extract_to", { n: count })}
              {:else if count === 1}
                {props.type === "copy"
                  ? ($_("dialog.copy_to_single") || "Copy 1 item to:")
                  : ($_("dialog.move_to_single") || "Move 1 item to:")}
              {:else}
                {$_(props.type === "copy" ? "dialog.copy_to" : "dialog.move_to", { n: count })}
              {/if}
            </p>
            <div class="path-input-wrapper">
              <input type="text" bind:value bind:this={inputEl} class="path-input" />
              <button class="path-history-btn">
                <Triangle size={10} style="transform: rotate(180deg)" fill="currentColor" />
              </button>
            </div>
            
            <div class="item-preview">
              {#each (showAllEntries ? (props.entries || []) : (props.entries || []).slice(0, 3)) as entry}
                <div class="preview-line">
                  <span class="file-icon">{entry.is_dir ? "📁" : "📄"}</span>
                  <span class="file-name">{entry.name}</span>
                  <span class="file-size">{formatSize(entry.size)}</span>
                </div>
              {/each}
              {#if (props.entries || []).length > 3}
                <button
                  type="button"
                  class="preview-more-btn"
                  onclick={() => (showAllEntries = !showAllEntries)}
                >
                  {showAllEntries
                    ? "▲ " + ($_("dialog.show_less") || "Show less")
                    : $_("dialog.more_items", { n: (props.entries || []).length - 3 })}
                </button>
              {/if}
            </div>
            
            <div class="total-stats">
              {$_("dialog.total_size", { s: formatSize(totalSize) })}
            </div>
            {#if !props.queueAvailable && props.queueUnavailableReason}
              <p class="queue-unavailable">{props.queueUnavailableReason}</p>
            {/if}
          </div>
        {:else if props.type === "pack"}
          <div class="form-group">
            <label class="dialog-label" for="pack-dest-input">
              {$_("dialog.pack_destination")}
            </label>
            <div class="folder-picker-container">
              <input
                id="pack-dest-input"
                type="text"
                class="dialog-input"
                bind:value={packDestDir}
                onfocus={handlePackDestFocus}
                onblur={handlePackDestBlur}
                spellcheck="false"
                placeholder="/home"
              />
              <button class="folder-picker-btn" onclick={handlePackDestFocus}>
                <Triangle size={10} style="transform: rotate(180deg)" fill="currentColor" />
              </button>
              {#if packDestDirFocused}
                <div class="folder-picker-dropdown" transition:fade={{ duration: 100 }}>
                  <div class="picker-toolbar">
                    <button class="picker-btn" onclick={goUpPicker} title={$_("toolbar.up")}>↑</button>
                    <span class="picker-path">{packDestPickerPath}</span>
                  </div>
                  <div class="picker-list">
                    {#if packDestPickerLoading}
                      <div class="picker-loading">{$_("common.loading")}</div>
                    {:else if packDestPickerEntries.length === 0}
                      <div class="picker-empty">{$_("filelist.empty")}</div>
                    {:else}
                      {#each packDestPickerEntries as folder}
                        <button
                          class="picker-item"
                          onclick={() => selectPickerFolder(folder)}
                        >
                          📁 {folder.name}
                        </button>
                      {/each}
                    {/if}
                  </div>
                </div>
              {/if}
            </div>
          </div>
          <div class="form-group">
            <label class="dialog-label" for="pack-input">
              {$_("dialog.pack_prompt", { n: props.entries?.length || 0 })}
            </label>
            <input
              id="pack-input"
              type="text"
              class="dialog-input"
              bind:value
              bind:this={inputEl}
              onkeydown={handleKeydown}
              spellcheck="false"
            />
            <div class="pack-advanced-options">
              <div class="pack-option-group">
                <span class="pack-option-label">{$_("dialog.pack_format")}:</span>
                <div class="custom-select-box">
                  <select
                    value={packOptions.format}
                    onchange={(e) => handlePackOptionChange('format', (e.target as HTMLSelectElement).value)}
                  >
                    {#each archiveFormats as fmt}
                      <option value={fmt.value}>{fmt.label}</option>
                    {/each}
                  </select>
                  <div class="info-content" data-label={archiveFormats.find(f => f.value === packOptions.format)?.label}>
                    {$_(archiveFormats.find(f => f.value === packOptions.format)?.info ?? "") }
                  </div>
                  <Triangle size={10} style="transform: rotate(180deg)" fill="currentColor" class="select-arrow" />
                </div>
              </div>

              <div class="pack-option-group">
                <span class="pack-option-label">{$_("dialog.pack_level")}:</span>
                <select
                  class="dialog-input"
                  value={packOptions.compression_level}
                  onchange={(e) => handlePackOptionChange('compression_level', parseInt((e.target as HTMLSelectElement).value))}
                >
                  {#each compressionLevels as lvl}
                    <option value={lvl.value}>{lvl.label}</option>
                  {/each}
                </select>
              </div>
            </div>

            <div class="pack-options-row">
              <label class="checkbox-label">
                <input 
                  type="checkbox" 
                  checked={packOptions.follow_links} 
                  onchange={(e) => handlePackOptionChange('follow_links', (e.target as HTMLInputElement).checked)}
                />
                {$_("dialog.pack_follow_links")}
              </label>
            </div>
          </div>

        {:else if props.type === "unpack"}
          <div class="form-group">
            <label class="dialog-label" for="unpack-input">{$_("dialog.unpack_to")}</label>
            <input
              id="unpack-input"
              type="text"
              class="dialog-input"
              bind:value
              bind:this={inputEl}
              onkeydown={handleKeydown}
              spellcheck="false"
            />
          </div>

        {:else if props.type === "split"}
          <div class="form-group">
            <label class="dialog-label" for="split-size-input">{$_("dialog.split_prompt")}</label>
            <div class="split-input-row">
              <input
                id="split-size-input"
                type="text"
                class="dialog-input"
                bind:value
                bind:this={inputEl}
                onkeydown={handleKeydown}
                spellcheck="false"
              />
              <span class="unit-label">{$_("dialog.split_unit")}</span>
            </div>
            <p class="dialog-info">{$_("dialog.split_info")}</p>
          </div>

        {:else if props.type === "combine"}
          <div class="form-group">
            <label class="dialog-label" for="combine-target-input">{$_("dialog.combine_prompt")}</label>
            <input
              id="combine-target-input"
              type="text"
              class="dialog-input"
              bind:value
              bind:this={inputEl}
              onkeydown={handleKeydown}
              spellcheck="false"
            />
          </div>

        {:else if props.type === "select_group" || props.type === "unselect_group"}
          <div class="form-group">
            <label class="dialog-label" for="select-group-input">{$_("dialog.select_wildcard")}</label>
            <input
              id="select-group-input"
              type="text"
              class="dialog-input"
              bind:value
              bind:this={inputEl}
              onkeydown={handleKeydown}
              spellcheck="false"
            />
          </div>
        {:else if props.type === "confirm" || props.type === "confirm_download"}
          <div class="confirm-msg">
            <p>{value}</p>
          </div>
        {:else if props.type === "error"}
          <div class="error-msg-dialog">
            <div class="error-dialog-icon">⚠️</div>
            <div class="error-dialog-text">
              <p>{value}</p>
            </div>
          </div>
        {:else if props.type === "permission_denied"}
          <div class="permission-denied-container">
            <div class="shield-container">
              <svg width="56" height="56" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <defs>
                  <linearGradient id="shieldBorder" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stop-color="#d4af37" />
                    <stop offset="50%" stop-color="#8a5a16" />
                    <stop offset="100%" stop-color="#d4af37" />
                  </linearGradient>
                  <linearGradient id="yellowCheck" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stop-color="#ffd700" />
                    <stop offset="100%" stop-color="#e5a900" />
                  </linearGradient>
                  <linearGradient id="blackCheck" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stop-color="#444" />
                    <stop offset="100%" stop-color="#111" />
                  </linearGradient>
                  <clipPath id="shieldClip">
                    <path d="M12 2C6.5 2 3 5 3 10C3 15.5 7.5 20.5 12 22C16.5 20.5 21 15.5 21 10C21 5 17.5 2 12 2Z" />
                  </clipPath>
                </defs>
                <path d="M12 1.5C5 1.5 2 5 2 10.5C2 16.8 6.8 21.8 12 23.5C17.2 21.8 22 16.8 22 10.5C22 5 19 1.5 12 1.5Z" fill="url(#shieldBorder)" stroke="#5c3a0b" stroke-width="0.5" />
                <g clip-path="url(#shieldClip)">
                  <rect x="0" y="0" width="12" height="11" fill="url(#yellowCheck)" />
                  <rect x="12" y="0" width="12" height="11" fill="url(#blackCheck)" />
                  <rect x="0" y="11" width="12" height="12" fill="url(#blackCheck)" />
                  <rect x="12" y="11" width="12" height="12" fill="url(#yellowCheck)" />
                </g>
                <path d="M12 2V22" stroke="#5c3a0b" stroke-width="0.5" opacity="0.3" />
                <path d="M3 11H21" stroke="#5c3a0b" stroke-width="0.5" opacity="0.3" />
              </svg>
            </div>
            <div class="permission-info">
              <p>{$_('dialogs.elevate_message')}</p>
              <div class="elevate-path" title={props.inputValue}>{props.inputValue}</div>
            </div>
          </div>
        {:else if props.type === "sudo_password"}
          <div class="sudo-password-container">
            <div class="key-container">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--color-nc-accent)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
              </svg>
            </div>
            <div class="sudo-info">
              <p>{$_('dialogs.sudo_message')}</p>
              <p class="user-prompt">{$_('dialogs.sudo_password_for')} <strong>{systemUsername}</strong>:</p>
              <input
                id="sudo-password-input"
                type="password"
                class="dialog-input sudo-input"
                bind:value
                bind:this={inputEl}
                onkeydown={handleKeydown}
                placeholder={$_('dialogs.sudo_placeholder')}
                spellcheck="false"
              />
            </div>
          </div>
        {/if}

        {#if showOptions && (props.type === "copy" || props.type === "move")}
          <div class="options-panel" in:fade={{ duration: 150 }}>
            <div class="options-grid">
              <div class="options-col-left">
                <div class="option-row select-row">
                  <span class="label">{$_("dialog.when_file_exists")}</span>
                  <select 
                    value={options.when_file_exists} 
                    onchange={(e) => handleOptionChange('when_file_exists', (e.target as HTMLSelectElement).value)}
                  >
                    {#each whenOptions as opt}
                      <option value={opt.value}>{opt.label}</option>
                    {/each}
                  </select>
                </div>
                <div class="option-row select-row">
                  <span class="label">{$_("dialog.when_dir_exists")}</span>
                  <select 
                    value={options.when_dir_exists}
                    onchange={(e) => handleOptionChange('when_dir_exists', (e.target as HTMLSelectElement).value)}
                  >
                    {#each whenOptions.filter(o => o.value !== 'Rename') as opt}
                      <option value={opt.value}>{opt.label}</option>
                    {/each}
                  </select>
                </div>
              </div>

              <div class="options-col-right">
                <label class="checkbox-label">
                  <input 
                    type="checkbox" 
                    checked={options.verify} 
                    onchange={(e) => handleOptionChange('verify', (e.target as HTMLInputElement).checked)}
                  />
                  {$_("dialog.verify")}
                </label>
                <label class="checkbox-label">
                  <input 
                    type="checkbox" 
                    checked={options.reserve_space} 
                    onchange={(e) => handleOptionChange('reserve_space', (e.target as HTMLInputElement).checked)}
                  />
                  {$_("dialog.reserve_space")}
                </label>
              </div>
            </div>
          </div>
        {/if}
      </div>

      <div class="dialog-footer">
        {#if props.type === "error"}
          <div class="footer-spacer"></div>
          <button class="dialog-btn confirm" bind:this={confirmBtnEl} onclick={() => props.oncancel ? props.oncancel() : props.onconfirm("ok")}>
            <Play size={14} fill="currentColor" style="margin-right: 4px;" /> {$_("dialog.ok")}
          </button>
        {:else if props.type === "permission_denied"}
          <div class="footer-spacer"></div>
          <button class="dialog-btn cancel" onclick={props.oncancel}>
            {$_("dialog.cancel")}
          </button>
          <button class="dialog-btn confirm" onclick={() => props.onconfirm("elevate")}>
            <Play size={14} fill="currentColor" style="margin-right: 4px;" /> {$_("dialog.ok")}
          </button>
        {:else if props.type === "sudo_password"}
          <div class="footer-spacer"></div>
          <button class="dialog-btn cancel" onclick={props.oncancel}>
            {$_("dialog.cancel")}
          </button>
          <button class="dialog-btn confirm" onclick={() => props.onconfirm(value)}>
            <Play size={14} fill="currentColor" style="margin-right: 4px;" /> {$_("dialogs.authenticate")}
          </button>
        {:else}
          {#if props.type === "copy" || props.type === "move"}
            <button class="btn btn-secondary" onclick={toggleOptions} class:active={showOptions}>{$_("dialog.options_btn")}</button>
            <div class="footer-spacer"></div>
          {:else}
            <div class="footer-spacer"></div>
          {/if}
          <button class="dialog-btn cancel" onclick={props.oncancel}>
            {#if props.type === "delete"}<XCircle size={16} color="var(--color-nc-danger)" />{/if}
            {$_("dialog.cancel")}
          </button>
          {#if props.queueAvailable && (props.type === "copy" || props.type === "move" || props.type === "delete")}
            <button
              class="dialog-btn queue"
              onclick={queueCurrentOperation}
              aria-keyshortcuts="F2"
              title={`${$_("queue.add")} (F2)`}
            >
              <span class="queue-shortcut">F2</span>
              <ListPlus size={16} /> {$_("queue.add")}
            </button>
          {/if}
          <button class="dialog-btn confirm" onclick={() => {
            if (props.type === "pack") {
              const fullPath = packDestDir ? (packDestDir.endsWith("/") ? packDestDir + value.split("/").pop() : packDestDir + "/" + value.split("/").pop()) : value;
              props.onconfirm(fullPath, packOptions);
            } else if (props.type === "delete") {
              props.onconfirm(isPermanentDelete ? "permanent" : "trash");
            } else {
              props.onconfirm(value);
            }
          }}>
            <Play size={14} fill="currentColor" style="margin-right: 4px;" />
            {props.type === "copy" && isArchiveSource ? $_("dialogs.extract") : $_("dialog.ok")}
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .dialog-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 5000;
  }

  .dialog-box {
    background: var(--color-nc-bg-deep);
    border: 1px solid var(--color-nc-border-bright);
    border-radius: 8px;
    width: 440px;
    max-width: calc(100vw - 32px);
    max-height: calc(100vh - 40px);
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    position: relative;

    &.pack {
      width: 550px;
    }
    &.error, &.confirm, &.select_group, &.unselect_group, &.mkdir, &.rename {
      width: 440px;
    }
  }

  .error-msg-dialog {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 6px 0;
  }

  .error-dialog-icon {
    font-size: 26px;
    line-height: 1;
    flex-shrink: 0;
  }

  .error-dialog-text {
    flex: 1;
    font-size: 13px;
    color: var(--color-nc-text-bright);
    line-height: 1.5;
    word-break: break-word;
  }

  .error-dialog-text p {
    margin: 0;
  }

  .dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    background: var(--color-nc-bg-header);
    border-bottom: 1px solid var(--color-nc-border);
    cursor: move;
    flex-shrink: 0;
  }

  .dialog-title {
    font-weight: 600;
    font-size: 13px;
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

  .dialog-body {
    padding: 16px;
    background: var(--color-nc-bg);
    color: var(--color-nc-text);
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .dialog-label {
    font-size: 12px;
    color: var(--color-nc-text-dim);
    margin-bottom: 4px;
    display: block;
  }

  .dialog-input, .path-input {
    width: 100%;
    padding: 8px 12px;
    background: var(--color-nc-bg-deep);
    border: 1px solid var(--color-nc-border-bright);
    color: var(--color-nc-text-bright);
    font-family: var(--font-family-mono);
    font-size: 12px;
    outline: none;
    border-radius: 4px;
  }

  .dialog-input:focus, .path-input:focus {
    border-color: var(--color-nc-accent);
    box-shadow: 0 0 0 2px var(--color-nc-accent-glow);
  }

  .path-input-wrapper {
    display: flex;
    gap: 4px;
    margin-top: 4px;
    margin-bottom: 12px;
  }

  .path-history-btn, .folder-picker-btn {
    padding: 0 8px;
    background: var(--color-nc-bg-header);
    border: 1px solid var(--color-nc-border-bright);
    color: var(--color-nc-text-dim);
    border-radius: 4px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .path-history-btn:hover, .folder-picker-btn:hover {
    color: var(--color-nc-text-bright);
    background: var(--color-nc-bg-hover);
  }

  .folder-picker-container {
    position: relative;
    display: flex;
    gap: 4px;
  }

  .folder-picker-dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    background: var(--color-nc-bg-deep);
    border: 1px solid var(--color-nc-border-bright);
    border-radius: 4px;
    max-height: 200px;
    overflow-y: auto;
    z-index: 100;
    margin-top: 2px;
  }

  .picker-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    background: var(--color-nc-bg-header);
    border-bottom: 1px solid var(--color-nc-border);
  }

  .picker-btn {
    background: none;
    border: 1px solid var(--color-nc-border);
    color: var(--color-nc-text-bright);
    padding: 2px 6px;
    border-radius: 3px;
    cursor: pointer;
  }

  .picker-btn:hover {
    background: var(--color-nc-bg-hover);
  }

  .picker-path {
    font-size: 11px;
    color: var(--color-nc-text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .picker-list {
    max-height: 160px;
    overflow-y: auto;
  }

  .pack-advanced-options {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 16px;
  }

  .pack-option-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .custom-select-box {
    position: relative;
    width: 100%;
    min-height: 48px;
    background: var(--color-nc-bg-deep);
    border: 1px solid var(--color-nc-border-bright);
    border-radius: 4px;
    overflow: hidden;
  }

  .custom-select-box select {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0;
    cursor: pointer;
    z-index: 2;
  }

  .custom-select-box .info-content {
    padding: 8px 12px;
    padding-right: 30px;
    display: flex;
    flex-direction: column;
    pointer-events: none;
    line-height: 1.4;
  }

  .custom-select-box .info-content::before {
    content: attr(data-label);
    font-weight: 600;
    color: var(--color-nc-text-bright);
    font-size: 13px;
  }
  
  .custom-select-box :global(.select-arrow) {
    position: absolute;
    right: 10px;
    top: 50%;
    transform: translateY(-50%) rotate(180deg);
    color: var(--color-nc-text-dim);
    pointer-events: none;
  }

  /* We'll update the JS to set data-label/info if needed, but for now we can use JS variables in Svelte */

  .picker-item {
    display: flex;
    align-items: center;
    width: 100%;
    padding: 6px 10px;
    background: none;
    border: none;
    border-bottom: 1px solid var(--color-nc-border);
    color: var(--color-nc-text);
    font-size: 13px;
    cursor: pointer;
    text-align: left;
    gap: 8px;
  }

  .picker-item:hover {
    background: var(--color-nc-bg-hover);
    color: var(--color-nc-text-bright);
  }

  .picker-loading, .picker-empty {
    padding: 10px;
    color: var(--color-nc-text-dim);
    font-size: 12px;
    text-align: center;
  }

  .item-preview {
    background: var(--color-nc-bg-deep);
    border: 1px solid var(--color-nc-border);
    border-radius: 4px;
    padding: 4px;
    margin-bottom: 12px;
    max-height: 100px;
    overflow-y: auto;
  }

  .preview-line {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    padding: 4px 8px;
    border-radius: 2px;
  }

  .preview-line:hover {
    background: var(--color-nc-bg-hover);
  }

  .file-name {
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .file-size {
    color: var(--color-nc-text-dim);
  }

  .total-stats {
    font-size: 11px;
    color: var(--color-nc-text-dim);
    text-align: right;
  }

  .preview-more-btn {
    display: block;
    width: 100%;
    background: transparent;
    border: none;
    color: var(--color-nc-accent);
    font-size: 11px;
    padding: 4px 8px;
    text-align: center;
    cursor: pointer;
    border-radius: 3px;
    margin-top: 2px;
  }

  .preview-more-btn:hover {
    background: var(--color-nc-bg-hover);
    text-decoration: underline;
  }

  .dialog-footer {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    background: var(--color-nc-bg-panel);
    border-top: 1px solid var(--color-nc-border);
    flex-shrink: 0;
  }

  .footer-spacer {
    flex: 1;
  }

  .dialog-btn {
    padding: 6px 16px;
    border: 1px solid var(--color-nc-border-bright);
    border-radius: 4px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.1s ease;
    min-width: 80px;
  }

  .confirm {
    background: var(--color-nc-accent-dim);
    border-color: var(--color-nc-accent);
    color: white;
  }

  .queue {
    gap: 5px;
    background: var(--color-nc-bg-header);
    color: var(--color-nc-text);
  }

  .queue:hover {
    background: var(--color-nc-bg-hover);
    border-color: var(--color-nc-accent);
  }

  .queue-shortcut {
    padding: 1px 4px;
    border: 1px solid currentColor;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 700;
    line-height: 1;
  }

  .queue-unavailable {
    margin: 10px 0 0;
    font-size: 11px;
    color: var(--color-nc-text-dim);
  }

  .confirm:hover {
    background: var(--color-nc-accent);
    box-shadow: 0 0 10px var(--color-nc-accent-glow);
  }

  .cancel {
    background: var(--color-nc-bg-header);
    color: var(--color-nc-text-dim);
  }

  .cancel:hover {
    background: var(--color-nc-bg-hover);
    color: var(--color-nc-text-bright);
  }

  .btn {
    padding: 6px 12px;
    border: 1px solid var(--color-nc-border);
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
    background: var(--color-nc-bg-header);
    color: var(--color-nc-text);
  }

  .btn:hover {
    background: var(--color-nc-bg-hover);
  }

  .btn.active {
    background: var(--color-nc-accent-dim);
    border-color: var(--color-nc-accent);
    color: white;
  }

  .options-panel {
    margin-top: 16px;
    padding-top: 16px;
    border-top: 1px solid var(--color-nc-border);
  }

  .options-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
  }

  .option-row {
    margin-bottom: 8px;
  }

  .select-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .select-row select {
    background: var(--color-nc-bg-deep);
    color: var(--color-nc-text-bright);
    border: 1px solid var(--color-nc-border-bright);
    padding: 2px 4px;
    border-radius: 2px;
    font-size: 11px;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--color-nc-text);
    cursor: pointer;
    margin-bottom: 6px;
  }

  .confirm-msg p {
    margin-bottom: 12px;
    color: var(--color-nc-text-bright);
  }

  .item-list {
    background: var(--color-nc-bg-deep);
    border: 1px solid var(--color-nc-border);
    border-radius: 4px;
    padding: 8px;
    max-height: 150px;
    overflow-y: auto;
  }

  .item-line {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 4px;
    font-size: 12px;
  }

  .dialog-info {
    font-size: 11px;
    color: var(--color-nc-text-dim);
    font-style: italic;
    margin-top: 4px;
  }

  .split-input-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  /* Web-only escalation flow (permission_denied / sudo_password);
     inert on shells that never raise those dialog types. */
  .permission-denied-container {
    display: flex;
    gap: 20px;
    align-items: flex-start;
    padding: 8px 0;
  }
  .shield-container {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 4px;
  }
  .permission-info {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 12px;
    font-size: 13px;
    color: var(--color-nc-text);
  }
  .permission-info p {
    margin: 0;
    line-height: 1.4;
  }
  .elevate-path {
    font-weight: 500;
    color: var(--color-nc-text-bright);
    word-break: break-all;
    background: var(--color-nc-bg-deep);
    border: 1px solid var(--color-nc-border);
    border-radius: 4px;
    padding: 6px 10px;
    font-family: var(--font-family-mono);
    font-size: 12px;
  }
  .sudo-password-container {
    display: flex;
    gap: 20px;
    align-items: flex-start;
    padding: 8px 0;
  }
  .key-container {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 4px;
    background: var(--color-nc-bg-deep);
    border: 1px solid var(--color-nc-border);
    border-radius: 8px;
    width: 56px;
    height: 56px;
  }
  .sudo-info {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 13px;
    color: var(--color-nc-text);
  }
  .sudo-info p {
    margin: 0;
    line-height: 1.4;
  }
  .sudo-info .user-prompt {
    font-weight: 500;
    color: var(--color-nc-text-bright);
    margin-top: 4px;
  }
  .sudo-input {
    margin-top: 4px;
  }
</style>
