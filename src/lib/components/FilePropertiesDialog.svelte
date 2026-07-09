<script lang="ts">
  import type { FileEntry } from "$lib/types";
  import { fade, scale } from "svelte/transition";
  import { onMount } from "svelte";
  import { File, Folder } from "lucide-svelte";
  import { _, locale } from "$lib/i18n";
  import { getUsersGroups, setFileProperties } from "$lib/ipc";
  import { openDialog, pendingElevatedAction } from "$lib/stores";

  let props = $props<{
    entry: FileEntry;
    path: string;
    onclose: () => void;
  }>();

  // Active Tab: 'properties' | 'attributes'
  let activeTab = $state<'properties' | 'attributes'>('properties');

  // Dragging state
  let pos = $state({ x: 0, y: 0 });
  let dragging = $state(false);
  let dragStart = { x: 0, y: 0 };

  // Attribute states
  let ownerRead = $state(false);
  let ownerWrite = $state(false);
  let ownerExecute = $state(false);

  let groupRead = $state(false);
  let groupWrite = $state(false);
  let groupExecute = $state(false);

  let otherRead = $state(false);
  let otherWrite = $state(false);
  let otherExecute = $state(false);

  let suid = $state(false);
  let sgid = $state(false);
  let sticky = $state(false);

  let allowExecuteAsProgram = $state(false);
  let octalInputVal = $state("");

  let users = $state<string[]>([]);
  let groups = $state<string[]>([]);
  let selectedOwner = $state("");
  let selectedGroup = $state("");

  // Initial values, used to only submit what actually changed on save.
  let initialOctal = "";
  let initialOwner = "";
  let initialGroup = "";

  // Parent directory path
  let parentPath = $derived.by(() => {
    const idx = props.path.lastIndexOf('/');
    if (idx <= 0) return "/";
    return props.path.slice(0, idx + 1);
  });

  // Load backend users and groups + initialize permissions
  onMount(() => {
    updateFromOctal(props.entry.permissions || "0755");
    initialOctal = getOctalFromState();
    selectedOwner = props.entry.owner || "";
    selectedGroup = props.entry.group || "";
    initialOwner = selectedOwner;
    initialGroup = selectedGroup;
    loadUsersAndGroups();
  });

  // Moves `name` to the front of the list (if present) so the logged-in
  // user doesn't have to scroll to the bottom of a long /etc/passwd-order list.
  function moveToFront(list: string[], name: string | null | undefined): string[] {
    if (!name || !list.includes(name)) return list;
    return [name, ...list.filter((v) => v !== name)];
  }

  async function loadUsersAndGroups() {
    try {
      const data = await getUsersGroups();
      users = data.users;
      groups = data.groups;

      // Ensure current owner/group are present in selection options
      if (selectedOwner && !users.includes(selectedOwner)) {
        users = [selectedOwner, ...users];
      }
      if (selectedGroup && !groups.includes(selectedGroup)) {
        groups = [selectedGroup, ...groups];
      }

      users = moveToFront(users, data.currentUser);
      groups = moveToFront(groups, data.currentGroup);
    } catch (e) {
      console.error("Failed to load users and groups:", e);
      users = [selectedOwner];
      groups = [selectedGroup];
    }
  }

  // Format dates in detailed local format: "di, 05 december 2023 13:19:38 UT+0200"
  function formatDetailedDate(timestamp: number | undefined): string {
    if (!timestamp) return "—";
    const d = new Date(timestamp);
    const dateStr = d.toLocaleString($locale || 'en', {
      weekday: 'short',
      day: '2-digit',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    const offset = -d.getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '-';
    const absOffset = Math.abs(offset);
    const hours = String(Math.floor(absOffset / 60)).padStart(2, '0');
    const mins = String(absOffset % 60).padStart(2, '0');

    return `${dateStr} UT${sign}${hours}${mins}`;
  }

  // Format file size exactly: "403,5 K (413.182)"
  function formatDetailedSize(bytes: number): string {
    const bytesLabel = $_("size_units.bytes") || "bytes";
    if (bytes === 0) return `0 ${bytesLabel}`;
    const lang = $locale || 'en';

    const k = $_("size_units.k") || "K";
    const m = $_("size_units.m") || "M";
    const g = $_("size_units.g") || "G";
    const t_unit = $_("size_units.t") || "T";
    const units = ["", k, m, g, t_unit];

    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const size = bytes / Math.pow(1024, i);
    const unit = units[i];

    let sizeStr = "";
    if (i === 0) {
      sizeStr = `${Math.round(size)}`;
    } else {
      sizeStr = size < 10
        ? size.toLocaleString(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
        : Math.round(size).toString();
    }

    const unitLabel = unit ? ` ${unit}` : ` ${bytesLabel}`;
    return `${sizeStr}${unitLabel} (${bytes.toLocaleString(lang)})`;
  }

  // Size on disk aligning to standard filesystem block size (4KB)
  function getSizeOnDisk(size: number): number {
    if (size === 0) return 0;
    return Math.ceil(size / 4096) * 4096;
  }

  // File extension mime mapping
  function getMediaType(entry: FileEntry): string {
    if (entry.is_dir) return "inode/directory";
    const ext = entry.extension.toLowerCase();
    const mimeMap: Record<string, string> = {
      pdf: "application/pdf",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      txt: "text/plain",
      html: "text/html",
      htm: "text/html",
      css: "text/css",
      js: "application/javascript",
      ts: "application/typescript",
      json: "application/json",
      zip: "application/zip",
      rar: "application/x-rar-compressed",
      tar: "application/x-tar",
      gz: "application/gzip",
      mp3: "audio/mpeg",
      mp4: "video/mp4",
      mkv: "video/x-matroska",
    };
    return mimeMap[ext] || `application/octet-stream`;
  }

  // Update permissions from octal digits input
  function updateFromOctal(octal: string) {
    const clean = octal.trim();
    let extra = 0;
    let own = 0;
    let grp = 0;
    let oth = 0;

    if (clean.length === 4) {
      extra = parseInt(clean[0], 8) || 0;
      own = parseInt(clean[1], 8) || 0;
      grp = parseInt(clean[2], 8) || 0;
      oth = parseInt(clean[3], 8) || 0;
    } else {
      const padded = clean.padStart(3, "0");
      own = parseInt(padded[padded.length - 3], 8) || 0;
      grp = parseInt(padded[padded.length - 2], 8) || 0;
      oth = parseInt(padded[padded.length - 1], 8) || 0;
    }

    suid = (extra & 4) !== 0;
    sgid = (extra & 2) !== 0;
    sticky = (extra & 1) !== 0;

    ownerRead = (own & 4) !== 0;
    ownerWrite = (own & 2) !== 0;
    ownerExecute = (own & 1) !== 0;

    groupRead = (grp & 4) !== 0;
    groupWrite = (grp & 2) !== 0;
    groupExecute = (grp & 1) !== 0;

    otherRead = (oth & 4) !== 0;
    otherWrite = (oth & 2) !== 0;
    otherExecute = (oth & 1) !== 0;

    allowExecuteAsProgram = ownerExecute || groupExecute || otherExecute;
  }

  function getOctalFromState(): string {
    let extra = 0;
    if (suid) extra += 4;
    if (sgid) extra += 2;
    if (sticky) extra += 1;

    let own = 0;
    if (ownerRead) own += 4;
    if (ownerWrite) own += 2;
    if (ownerExecute) own += 1;

    let grp = 0;
    if (groupRead) grp += 4;
    if (groupWrite) grp += 2;
    if (groupExecute) grp += 1;

    let oth = 0;
    if (otherRead) oth += 4;
    if (otherWrite) oth += 2;
    if (otherExecute) oth += 1;

    if (extra > 0) {
      return `${extra}${own}${grp}${oth}`;
    }
    return `${own}${grp}${oth}`;
  }

  // Update octal value when checkboxes are toggled
  $effect(() => {
    const _ = [
      ownerRead, ownerWrite, ownerExecute,
      groupRead, groupWrite, groupExecute,
      otherRead, otherWrite, otherExecute,
      suid, sgid, sticky
    ];
    octalInputVal = getOctalFromState();
  });

  // Calculate live mode string (e.g. -rwxrwxr-x)
  let currentModeString = $derived.by(() => {
    const type = props.entry.is_symlink ? "l" : props.entry.is_dir ? "d" : "-";

    const r1 = ownerRead ? "r" : "-";
    const w1 = ownerWrite ? "w" : "-";
    let x1 = ownerExecute ? "x" : "-";
    if (suid) x1 = ownerExecute ? "s" : "S";

    const r2 = groupRead ? "r" : "-";
    const w2 = groupWrite ? "w" : "-";
    let x2 = groupExecute ? "x" : "-";
    if (sgid) x2 = groupExecute ? "s" : "S";

    const r3 = otherRead ? "r" : "-";
    const w3 = otherWrite ? "w" : "-";
    let x3 = otherExecute ? "x" : "-";
    if (sticky) x3 = otherExecute ? "t" : "T";

    return `${type}${r1}${w1}${x1}${r2}${w2}${x2}${r3}${w3}${x3}`;
  });

  function handleOctalChange(val: string) {
    octalInputVal = val;
    if (/^[0-7]{3,4}$/.test(val)) {
      updateFromOctal(val);
    }
  }

  function toggleAllowExecute(checked: boolean) {
    ownerExecute = checked;
    groupExecute = checked;
    otherExecute = checked;
  }

  // Keyboard navigation & drag
  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onclose();
    } else if (e.key === "Enter") {
      e.preventDefault();
      handleSave();
    }
  }

  function startDrag(e: MouseEvent) {
    if ((e.target as HTMLElement).closest('.win-btn-mini')) return;
    dragging = true;
    dragStart = { x: e.clientX - pos.x, y: e.clientY - pos.y };
  }

  function handleMouseMove(e: MouseEvent) {
    if (dragging) {
      pos.x = e.clientX - dragStart.x;
      pos.y = e.clientY - dragStart.y;
    }
  }

  function stopDrag() {
    dragging = false;
  }

  // Save chown and chmod changes to backend and refresh UI
  async function handleSave() {
    // The checkbox state is the source of truth: the octal text field may
    // hold a partially typed (invalid) value that never reached the checkboxes.
    const octal = getOctalFromState();
    const changes: { permissions?: string; owner?: string; group?: string } = {};
    if (octal !== initialOctal) changes.permissions = octal;
    if (selectedOwner && selectedOwner !== initialOwner) changes.owner = selectedOwner;
    if (selectedGroup && selectedGroup !== initialGroup) changes.group = selectedGroup;

    if (Object.keys(changes).length === 0) {
      props.onclose();
      return;
    }

    try {
      await setFileProperties(props.path, changes);
      window.dispatchEvent(new CustomEvent("nc:refresh-panels"));
      props.onclose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("EACCES") || msg.includes("EPERM") || msg.toLowerCase().includes("permission denied")) {
        pendingElevatedAction.set({
          type: "properties",
          value: "",
          paths: [props.path],
          sourceDir: "",
          ...changes,
        });
        openDialog({
          type: "permission_denied",
          inputValue: props.path,
        });
      } else {
        alert($_('file_properties.save_failed', { error: msg }));
      }
    }
  }
</script>

<svelte:window onmousemove={handleMouseMove} onmouseup={stopDrag} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div 
  class="dialog-overlay" 
  onclick={props.onclose} 
  onkeydown={handleKeydown}
  in:fade={{ duration: 150 }} 
  out:fade={{ duration: 100 }}
>
  <div 
    class="dialog-box" 
    onclick={(e) => e.stopPropagation()}
    in:scale={{ start: 0.95, duration: 150 }} 
    out:scale={{ start: 0.95, duration: 100 }}
    style="transform: translate({pos.x}px, {pos.y}px);"
  >
    <!-- Header -->
    <div class="dialog-header" onmousedown={startDrag}>
      <span class="dialog-title">{$_('file_properties.title')}</span>
      <div class="header-controls">
        <button class="win-btn-mini close" onclick={props.onclose} aria-label="Close">×</button>
      </div>
    </div>

    <!-- Tabs Nav -->
    <div class="tabs-bar">
      <button
        class="tab-btn"
        class:active={activeTab === 'properties'}
        onclick={() => activeTab = 'properties'}
      >
        {$_('file_properties.tab_properties')}
      </button>
      <button
        class="tab-btn"
        class:active={activeTab === 'attributes'}
        onclick={() => activeTab = 'attributes'}
      >
        {$_('file_properties.tab_attributes')}
      </button>
    </div>

    <!-- Dialog Tab Container -->
    <div class="inner-card">
      {#if activeTab === 'properties'}
        <!-- Properties Tab -->
        <div class="properties-top">
          <div class="icon-wrapper">
            {#if props.entry.is_dir}
              <Folder size={40} color="var(--color-nc-accent)" />
            {:else}
              {#if props.entry.extension.toLowerCase() === 'pdf'}
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path>
                  <polyline points="14 2 14 8 20 8"></polyline>
                  <text x="7" y="16" fill="#ef4444" font-size="6" font-weight="bold" font-family="sans-serif">PDF</text>
                </svg>
              {:else}
                <File size={40} color="var(--color-nc-text-dim)" />
              {/if}
            {/if}
          </div>
          <div class="name-text" title={props.entry.name}>{props.entry.name}</div>
        </div>

        <div class="grid-divider"></div>

        <div class="properties-grid">
          <div class="grid-row">
            <span class="label">{$_('file_properties.path')}:</span>
            <span class="value select-all">{parentPath}</span>
          </div>
          <div class="grid-row">
            <span class="label">{$_('file_properties.type')}:</span>
            <span class="value">{props.entry.is_dir ? $_('file_properties.directory') : $_('file_properties.file')}</span>
          </div>
          {#if !props.entry.is_dir}
            <div class="grid-row">
              <span class="label">{$_('file_properties.media_type')}:</span>
              <span class="value">{getMediaType(props.entry)}</span>
            </div>
          {/if}
          <div class="grid-row">
            <span class="label">{$_('file_properties.size')}:</span>
            <span class="value">{formatDetailedSize(props.entry.size)}</span>
          </div>
          <div class="grid-row">
            <span class="label">{$_('file_properties.size_on_disk')}:</span>
            <span class="value">{formatDetailedSize(getSizeOnDisk(props.entry.size))}</span>
          </div>

          <div class="grid-divider"></div>

          <div class="grid-row">
            <span class="label">{$_('file_properties.created')}:</span>
            <span class="value">{formatDetailedDate(props.entry.created || props.entry.modified)}</span>
          </div>
          <div class="grid-row">
            <span class="label">{$_('file_properties.modified')}:</span>
            <span class="value">{formatDetailedDate(props.entry.modified)}</span>
          </div>
          <div class="grid-row">
            <span class="label">{$_('file_properties.accessed')}:</span>
            <span class="value">{formatDetailedDate(props.entry.accessed || props.entry.modified)}</span>
          </div>
          {#if props.entry.changed}
            <div class="grid-row">
              <span class="label">{$_('file_properties.status_changed')}:</span>
              <span class="value">{formatDetailedDate(props.entry.changed)}</span>
            </div>
          {/if}
        </div>
      {:else}
        <!-- Attributes Tab -->
        <div class="filename-row">
          <span class="label">{$_('file_properties.file_name')}</span>
          <span class="value name-display">{props.entry.name}</span>
        </div>

        <div class="attr-divider"></div>

        <!-- Permissions Table Grid -->
        <table class="perms-table">
          <thead>
            <tr>
              <th></th>
              <th>{$_('file_properties.read')}</th>
              <th>{$_('file_properties.write')}</th>
              <th>{$_('file_properties.execute')}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="row-hdr">{$_('file_properties.owner')}</td>
              <td><input type="checkbox" bind:checked={ownerRead} /></td>
              <td><input type="checkbox" bind:checked={ownerWrite} /></td>
              <td><input type="checkbox" bind:checked={ownerExecute} /></td>
            </tr>
            <tr>
              <td class="row-hdr">{$_('file_properties.group')}</td>
              <td><input type="checkbox" bind:checked={groupRead} /></td>
              <td><input type="checkbox" bind:checked={groupWrite} /></td>
              <td><input type="checkbox" bind:checked={groupExecute} /></td>
            </tr>
            <tr>
              <td class="row-hdr">{$_('file_properties.other')}</td>
              <td><input type="checkbox" bind:checked={otherRead} /></td>
              <td><input type="checkbox" bind:checked={otherWrite} /></td>
              <td><input type="checkbox" bind:checked={otherExecute} /></td>
            </tr>
          </tbody>
        </table>

        <div class="attr-divider"></div>

        <!-- Bit Modifiers -->
        <div class="bits-row">
          <span class="row-label">{$_('file_properties.bits')}:</span>
          <label class="bit-cb"><input type="checkbox" bind:checked={suid} /> SUID</label>
          <label class="bit-cb"><input type="checkbox" bind:checked={sgid} /> SGID</label>
          <label class="bit-cb"><input type="checkbox" bind:checked={sticky} /> Sticky</label>
        </div>

        <div class="execute-row">
          <span class="row-label">{$_('file_properties.execute')}:</span>
          <label class="exec-cb">
            <input type="checkbox" bind:checked={allowExecuteAsProgram} onchange={(e) => toggleAllowExecute((e.target as HTMLInputElement).checked)} />
            {$_('file_properties.allow_execute')}
          </label>
        </div>

        <div class="octal-row">
          <div class="octal-field">
            <span class="row-label">{$_('file_properties.octal')}:</span>
            <input
              type="text"
              class="octal-input"
              value={octalInputVal}
              oninput={(e) => handleOctalChange((e.target as HTMLInputElement).value)}
              maxLength={4}
            />
          </div>
          <div class="text-field">
            <span class="row-label">{$_('file_properties.text_mode')}:</span>
            <span class="mode-text">{currentModeString}</span>
          </div>
        </div>

        <!-- Owner & Group selectors -->
        <div class="owner-section-divider">
          <span class="divider-label">{$_('file_properties.owner')}</span>
        </div>

        <div class="owner-grid">
          <div class="grid-row">
            <span class="label">{$_('file_properties.owner')}</span>
            <select class="attr-select" bind:value={selectedOwner}>
              {#each users as user}
                <option value={user}>{user}</option>
              {/each}
            </select>
          </div>
          <div class="grid-row">
            <span class="label">{$_('file_properties.group')}</span>
            <select class="attr-select" bind:value={selectedGroup}>
              {#each groups as group}
                <option value={group}>{group}</option>
              {/each}
            </select>
          </div>
        </div>
      {/if}
    </div>

    <!-- Footer buttons -->
    <div class="dialog-footer">
      <button class="btn btn-primary" onclick={handleSave}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="9 10 4 15 9 20"></polyline>
          <path d="M20 4v7a4 4 0 0 1-4 4H4"></path>
        </svg>
        {$_('dialogs.ok')}
      </button>
      <button class="btn btn-secondary" onclick={props.onclose}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
        {$_('dialogs.cancel')}
      </button>
    </div>
  </div>
</div>

<style>
  .dialog-overlay {
    position: fixed;
    inset: 0;
    background: transparent;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 11000;
  }

  .dialog-box {
    background: var(--color-nc-bg-panel);
    border: 1px solid var(--color-nc-border-bright);
    border-radius: 12px;
    width: 460px;
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    color: var(--color-nc-text);
  }

  .dialog-header {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 10px 16px;
    background: var(--color-nc-bg-header);
    border-bottom: 1px solid var(--color-nc-border);
    cursor: move;
    position: relative;
  }

  .dialog-title {
    font-weight: 700;
    font-size: 13px;
    color: var(--color-nc-text-bright);
  }

  .header-controls {
    position: absolute;
    right: 12px;
    display: flex;
    gap: 6px;
  }

  .win-btn-mini {
    width: 20px;
    height: 20px;
    background: var(--color-nc-bg-alt);
    border: none;
    border-radius: 50%;
    color: var(--color-nc-text-dim);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    font-size: 11px;
    transition: all 0.15s;
  }

  .win-btn-mini:hover {
    background: var(--color-nc-bg-hover);
    color: var(--color-nc-text-bright);
  }

  .win-btn-mini.close:hover {
    background: var(--color-nc-danger);
    color: white;
  }

  .tabs-bar {
    display: flex;
    gap: 4px;
    padding: 8px 16px 0 16px;
    background: var(--color-nc-bg-header);
    border-bottom: 1px solid var(--color-nc-border);
  }

  .tab-btn {
    padding: 6px 14px;
    font-size: 12px;
    font-weight: 500;
    border: 1px solid transparent;
    border-bottom: none;
    border-top-left-radius: 6px;
    border-top-right-radius: 6px;
    background: transparent;
    color: var(--color-nc-text-dim);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .tab-btn:hover {
    color: var(--color-nc-text-bright);
    background: var(--color-nc-bg-hover);
  }

  .tab-btn.active {
    font-weight: 600;
    color: var(--color-nc-text-bright);
    background: var(--color-nc-bg-deep);
    border-color: var(--color-nc-border);
    margin-bottom: -1px;
    position: relative;
    z-index: 2;
  }

  .inner-card {
    background: var(--color-nc-bg-deep);
    border: 1px solid var(--color-nc-border);
    border-radius: 8px;
    padding: 16px;
    margin: 16px;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  /* Properties tab styles */
  .properties-top {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  .icon-wrapper {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .name-text {
    font-size: 14px;
    font-weight: 600;
    color: var(--color-nc-text-bright);
    word-break: break-all;
  }

  .properties-grid {
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 12px;
  }

  .grid-row {
    display: grid;
    grid-template-columns: 100px 1fr;
    gap: 12px;
    align-items: baseline;
  }

  .grid-row .label {
    color: var(--color-nc-text-dim);
    text-align: left;
  }

  .grid-row .value {
    color: var(--color-nc-text-bright);
    word-break: break-all;
  }

  .select-all {
    user-select: all;
  }

  .grid-divider {
    height: 1px;
    background: var(--color-nc-border);
    margin: 10px 0;
  }

  /* Attributes tab styles */
  .filename-row {
    display: flex;
    align-items: baseline;
    gap: 20px;
    font-size: 12px;
  }

  .name-display {
    font-weight: 600;
    color: var(--color-nc-text-bright);
    word-break: break-all;
  }

  .attr-divider {
    height: 1px;
    background: var(--color-nc-border);
    margin: 10px 0;
  }

  .perms-table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 8px;
  }

  .perms-table th {
    font-size: 11px;
    font-weight: 500;
    color: var(--color-nc-text-dim);
    text-align: center;
    padding: 4px;
    width: 25%;
  }

  .perms-table td {
    padding: 4px;
    text-align: center;
  }

  .perms-table td.row-hdr {
    text-align: left;
    font-size: 12px;
    color: var(--color-nc-text-bright);
    font-weight: 500;
    width: 25%;
  }

  .perms-table input[type="checkbox"],
  .bits-row input[type="checkbox"],
  .execute-row input[type="checkbox"] {
    width: 14px;
    height: 14px;
    accent-color: var(--color-nc-accent);
    cursor: pointer;
  }

  .bits-row {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 12px;
    margin-bottom: 8px;
  }

  .row-label {
    min-width: 60px;
    color: var(--color-nc-text-dim);
  }

  .bit-cb, .exec-cb {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--color-nc-text-bright);
    cursor: pointer;
  }

  .execute-row {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 12px;
    margin-bottom: 10px;
  }

  .octal-row {
    display: flex;
    gap: 20px;
    font-size: 12px;
    align-items: center;
    margin-bottom: 4px;
  }

  .octal-field, .text-field {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .octal-input {
    width: 65px;
    background: var(--color-nc-bg-panel);
    border: 1px solid var(--color-nc-border);
    border-radius: 4px;
    padding: 3px 6px;
    color: var(--color-nc-text-bright);
    font-family: var(--font-family-mono);
    font-size: 12px;
    outline: none;
  }

  .octal-input:focus {
    border-color: var(--color-nc-accent);
  }

  .mode-text {
    font-family: var(--font-family-mono);
    color: var(--color-nc-accent);
    font-weight: 600;
  }

  .owner-section-divider {
    display: flex;
    align-items: center;
    margin: 12px 0 8px 0;
  }

  .owner-section-divider::before,
  .owner-section-divider::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--color-nc-border);
  }

  .owner-section-divider .divider-label {
    padding: 0 10px;
    font-size: 10px;
    font-weight: 600;
    color: var(--color-nc-text-dim);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .owner-grid {
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 12px;
  }

  .attr-select {
    width: 100%;
    background: var(--color-nc-bg-panel);
    border: 1px solid var(--color-nc-border);
    border-radius: 4px;
    padding: 3px 6px;
    color: var(--color-nc-text-bright);
    font-size: 12px;
    outline: none;
    cursor: pointer;
  }

  .attr-select:focus {
    border-color: var(--color-nc-accent);
  }

  /* Footer */
  .dialog-footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 10px 16px;
    background: var(--color-nc-bg-header);
    border-top: 1px solid var(--color-nc-border);
  }

  .btn {
    padding: 5px 14px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 1px solid var(--color-nc-border);
  }

  .btn-primary {
    background: var(--color-nc-accent);
    color: white;
    border-color: var(--color-nc-accent);
  }

  .btn-primary:hover {
    filter: brightness(1.1);
    box-shadow: 0 4px 12px var(--color-nc-accent-glow);
  }

  .btn-secondary {
    background: var(--color-nc-bg-alt);
    color: var(--color-nc-text);
  }

  .btn-secondary:hover {
    background: var(--color-nc-bg-hover);
    color: var(--color-nc-text-bright);
  }
</style>
