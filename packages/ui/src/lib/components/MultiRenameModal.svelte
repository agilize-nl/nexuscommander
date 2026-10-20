<script lang="ts">
  import type { FileEntry } from "../types";
  import { batchRename } from "../ipc";
  import { _ } from "../i18n";

  interface Props {
    entries: FileEntry[];
    currentPath: string;
    onclose: () => void;
    oncomplete: () => void;
  }

  let { entries, currentPath, onclose, oncomplete }: Props = $props();

  // Search & Replace
  let findText = $state("");
  let replaceText = $state("");
  let matchCase = $state(false);
  let useRegex = $state(false);

  // Character Removal
  let removeFirst = $state(0);
  let removeLast = $state(0);

  // Prefix & Suffix
  let prefixText = $state("");
  let suffixText = $state("");

  // Letter Case
  let caseChange = $state<"none" | "lower" | "upper" | "title" | "first_upper" | "camel" | "pascal">("none");

  // Numbering / Counter
  let useCounter = $state(false);
  let startNumber = $state(1);
  let stepNumber = $state(1);
  let counterDigits = $state(1);
  let counterPosition = $state<"suffix" | "prefix" | "replace">("suffix");

  // Status
  let isRenaming = $state(false);
  let errorMessage = $state("");

    function toCamelCase(str: string): string {
    const words = str
      .replace(/([a-z\d])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z\d]+)/g, "$1 $2")
      .split(/[\s_\-]+/)
      .filter(Boolean);

    if (words.length === 0) return str;

    return words
      .map((word, i) => {
        const lower = word.toLowerCase();
        if (i === 0) return lower;
        return lower.charAt(0).toUpperCase() + lower.slice(1);
      })
      .join("");
  }

    function toPascalCase(str: string): string {
    const words = str
      .replace(/([a-z\d])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z\d]+)/g, "$1 $2")
      .split(/[\s_\-]+/)
      .filter(Boolean);

    if (words.length === 0) return str;

    return words
      .map((word) => {
        const lower = word.toLowerCase();
        return lower.charAt(0).toUpperCase() + lower.slice(1);
      })
      .join("");
  }

  function toTitleCase(str: string): string {
    return str.replace(/\\w\\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.slice(1).toLowerCase());
  }

  let previewRenames = $derived.by(() => {
    return entries.map((entry, index) => {
      const isDir = entry.is_dir;
      let baseName = entry.name;
      let ext = "";

      if (!isDir) {
        const lastDot = entry.name.lastIndexOf(".");
        if (lastDot > 0) {
          baseName = entry.name.substring(0, lastDot);
          ext = entry.name.substring(lastDot);
        }
      }

      // 1. Remove first X characters
      if (removeFirst > 0) {
        baseName = baseName.substring(Math.min(removeFirst, baseName.length));
      }

      // 2. Remove last X characters
      if (removeLast > 0) {
        baseName = baseName.substring(0, Math.max(0, baseName.length - removeLast));
      }

      // 3. Search and Replace
      if (findText) {
        if (useRegex) {
          try {
            const reg = new RegExp(findText, matchCase ? "g" : "gi");
            baseName = baseName.replace(reg, replaceText);
          } catch {
            // Invalid regex while typing - ignore
          }
        } else {
          if (matchCase) {
            baseName = baseName.replaceAll(findText, replaceText);
          } else {
            const escaped = findText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const reg = new RegExp(escaped, "gi");
            baseName = baseName.replace(reg, replaceText);
          }
        }
      }

      // 4. Prefix & Suffix
      if (prefixText) {
        baseName = prefixText + baseName;
      }
      if (suffixText) {
        baseName = baseName + suffixText;
      }

      // 5. Letter Case Conversion
      if (caseChange === "lower") {
        baseName = baseName.toLowerCase();
      } else if (caseChange === "upper") {
        baseName = baseName.toUpperCase();
      } else if (caseChange === "title") {
        baseName = toTitleCase(baseName);
      } else if (caseChange === "first_upper") {
        baseName = baseName.charAt(0).toUpperCase() + baseName.slice(1);
      } else if (caseChange === "camel") {
        baseName = toCamelCase(baseName);
      } else if (caseChange === "pascal") {
        baseName = toPascalCase(baseName);
      }

      // 6. Numbering / Counter
      if (useCounter) {
        const num = startNumber + index * stepNumber;
        const numStr = String(num).padStart(Math.max(1, counterDigits), "0");
        if (counterPosition === "prefix") {
          baseName = `${numStr}_${baseName}`;
        } else if (counterPosition === "replace") {
          baseName = numStr;
        } else {
          baseName = `${baseName}_${numStr}`;
        }
      }

      let newName = `${baseName}${ext}`;
      if (!newName.trim()) {
        newName = entry.name;
      }

      const cleanPath = currentPath.replace(/[\\/]+$/, "");
      const from = entry.path || (cleanPath === "" ? `/${entry.name}` : `${cleanPath}/${entry.name}`);
      const to = cleanPath === "" ? `/${newName}` : `${cleanPath}/${newName}`;

      return {
        oldName: entry.name,
        newName: newName,
        from,
        to,
        changed: entry.name !== newName
      };
    });
  });

  let duplicateNames = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const item of previewRenames) {
      counts.set(item.newName, (counts.get(item.newName) || 0) + 1);
    }
    const dupSet = new Set<string>();
    for (const [name, count] of counts.entries()) {
      if (count > 1) dupSet.add(name);
    }
    return dupSet;
  });

  let hasConflicts = $derived(duplicateNames.size > 0);
  let changedCount = $derived(previewRenames.filter((r) => r.changed).length);

  async function handleRename() {
    if (isRenaming) return;
    const renames: [string, string][] = previewRenames
      .filter((r) => r.changed)
      .map((r) => [r.from, r.to]);

    if (renames.length === 0) {
      onclose();
      return;
    }

    if (hasConflicts) {
      errorMessage = $_("multi_rename.conflict_warning") || "Warning: Duplicate target filenames detected!";
      return;
    }

    try {
      errorMessage = "";
      isRenaming = true;
      const results = await batchRename(renames);
      const failures = (results || []).filter((r) => r && r.success === false);
      if (failures.length > 0) {
        errorMessage = failures.map((f) => f.message).join("\n");
        isRenaming = false;
        return;
      }
      isRenaming = false;
      oncomplete();
    } catch (e: any) {
      console.error("Batch rename failed:", e);
      const msg = e?.message || String(e);
      errorMessage = $_("multi_rename.rename_failed", { error: msg }) || `Batch rename failed: ${msg}`;
      isRenaming = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onclose();
    } else if (e.key === "Enter" && !e.shiftKey && (e.target as HTMLElement).tagName !== "TEXTAREA") {
      e.preventDefault();
      handleRename();
    }
  }
</script>

<div
  class="modal-overlay"
  onclick={onclose}
  onkeydown={handleKeydown}
  role="button"
  tabindex="-1"
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div 
    class="modal-box" 
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => e.stopPropagation()}
    role="dialog"
    aria-modal="true"
    tabindex="-1"
  >
    <div class="modal-header">
      <span class="modal-title">{$_("multi_rename.title")}</span>
      <button class="close-btn" onclick={onclose}>✕</button>
    </div>

    <div class="modal-body">
      {#if errorMessage}
        <div class="error-banner">
          <span class="error-icon">⚠️</span>
          <span class="error-text">{errorMessage}</span>
        </div>
      {/if}

      <div class="controls-grid">
        <!-- 1. Search & Replace -->
        <div class="control-panel">
          <div class="panel-header">{$_("multi_rename.replace")}</div>
          <div class="panel-row">
            <div class="field-col">
              <label for="find-input">{$_("multi_rename.replace")}</label>
              <input id="find-input" type="text" bind:value={findText} placeholder={$_("multi_rename.placeholder_find")} spellcheck="false" />
            </div>
            <div class="field-col">
              <label for="replace-input">{$_("multi_rename.with")}</label>
              <input id="replace-input" type="text" bind:value={replaceText} placeholder={$_("multi_rename.placeholder_replace")} spellcheck="false" />
            </div>
          </div>
          <div class="options-row">
            <label class="checkbox-label">
              <input type="checkbox" bind:checked={matchCase} />
              {$_("multi_rename.match_case")}
            </label>
            <label class="checkbox-label">
              <input type="checkbox" bind:checked={useRegex} />
              {$_("multi_rename.use_regex")}
            </label>
          </div>
        </div>

        <!-- 2. Remove & Add Characters -->
        <div class="control-panel">
          <div class="panel-header">{$_("multi_rename.remove_first")} / {$_("multi_rename.remove_last")}</div>
          <div class="panel-row">
            <div class="field-col">
              <label for="remove-first">{$_("multi_rename.remove_first")}</label>
              <div class="number-input-wrap">
                <input id="remove-first" type="number" min="0" max="100" bind:value={removeFirst} />
                <span class="unit">{$_("multi_rename.chars")}</span>
              </div>
            </div>
            <div class="field-col">
              <label for="remove-last">{$_("multi_rename.remove_last")}</label>
              <div class="number-input-wrap">
                <input id="remove-last" type="number" min="0" max="100" bind:value={removeLast} />
                <span class="unit">{$_("multi_rename.chars")}</span>
              </div>
            </div>
          </div>
          <div class="panel-row">
            <div class="field-col">
              <label for="prefix-input">{$_("multi_rename.prefix")}</label>
              <input id="prefix-input" type="text" bind:value={prefixText} placeholder={$_("multi_rename.prefix")} spellcheck="false" />
            </div>
            <div class="field-col">
              <label for="suffix-input">{$_("multi_rename.suffix")}</label>
              <input id="suffix-input" type="text" bind:value={suffixText} placeholder={$_("multi_rename.suffix")} spellcheck="false" />
            </div>
          </div>
        </div>

        <!-- 3. Case & Numbering -->
        <div class="control-panel span-2">
          <div class="panel-header">{$_("multi_rename.case_change")} & {$_("multi_rename.append_counter")}</div>
          <div class="panel-row">
            <div class="field-col">
              <label for="case-select">{$_("multi_rename.case_change")}</label>
              <select id="case-select" bind:value={caseChange}>
                <option value="none">{$_("multi_rename.case_no_change")}</option>
                <option value="lower">{$_("multi_rename.case_lower")}</option>
                <option value="upper">{$_("multi_rename.case_upper")}</option>
                <option value="title">{$_("multi_rename.case_title")}</option>
                <option value="first_upper">{$_("multi_rename.case_first_upper")}</option>
                <option value="camel">{$_("multi_rename.case_camel")}</option>
                <option value="pascal">{$_("multi_rename.case_pascal")}</option>
              </select>
            </div>
            <div class="field-col">
              <label class="checkbox-label counter-toggle">
                <input type="checkbox" bind:checked={useCounter} />
                <strong>{$_("multi_rename.append_counter")}</strong>
              </label>
              {#if useCounter}
                <div class="counter-fields">
                  <div class="sub-field">
                    <label for="start-num">{$_("multi_rename.counter_start")}</label>
                    <input id="start-num" type="number" bind:value={startNumber} />
                  </div>
                  <div class="sub-field">
                    <label for="step-num">{$_("multi_rename.counter_step")}</label>
                    <input id="step-num" type="number" bind:value={stepNumber} />
                  </div>
                  <div class="sub-field">
                    <label for="digits-num">{$_("multi_rename.counter_digits")}</label>
                    <input id="digits-num" type="number" min="1" max="8" bind:value={counterDigits} />
                  </div>
                  <div class="sub-field">
                    <label for="pos-select">{$_("multi_rename.counter_position")}</label>
                    <select id="pos-select" bind:value={counterPosition}>
                      <option value="suffix">{$_("multi_rename.counter_pos_suffix")}</option>
                      <option value="prefix">{$_("multi_rename.counter_pos_prefix")}</option>
                      <option value="replace">{$_("multi_rename.counter_pos_replace")}</option>
                    </select>
                  </div>
                </div>
              {/if}
            </div>
          </div>
        </div>
      </div>

      <!-- Live Preview Area -->
      <div class="preview-section">
        <div class="preview-header">
          <span class="preview-title">{$_("multi_rename.preview")}</span>
          <span class="items-count" class:has-changed={changedCount > 0}>
            {$_("multi_rename.items_summary", { n: entries.length, changed: changedCount })}
          </span>
        </div>
        <div class="preview-scroll">
          <table class="preview-table">
            <thead>
              <tr>
                <th class="th-old">{$_("multi_rename.col_old")}</th>
                <th class="th-arrow"></th>
                <th class="th-new">{$_("multi_rename.col_new")}</th>
              </tr>
            </thead>
            <tbody>
              {#each previewRenames as item}
                {@const isConflict = duplicateNames.has(item.newName)}
                <tr class:changed={item.changed} class:conflict={isConflict}>
                  <td class="td-old">{item.oldName}</td>
                  <td class="td-arrow">{item.changed ? "➔" : ""}</td>
                  <td class="td-new">
                    {item.newName}
                    {#if isConflict}
                      <span class="conflict-tag">⚠ {$_("multi_rename.duplicate")}</span>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="modal-footer">
      <button class="btn btn-cancel" onclick={onclose} disabled={isRenaming}>
        {$_("common.cancel")}
      </button>
      <button class="btn btn-ok" onclick={handleRename} disabled={isRenaming || hasConflicts || changedCount === 0}>
        {#if isRenaming}
          <span class="spinner-small"></span>
        {/if}
        {$_("multi_rename.start")}
      </button>
    </div>
  </div>
</div>

<style>
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.7);
    backdrop-filter: blur(6px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 5000;
  }

  .modal-box {
    background: var(--color-nc-bg-panel);
    border: 1px solid var(--color-nc-border-bright);
    border-radius: 8px;
    width: 820px;
    max-width: calc(100vw - 32px);
    height: 85vh;
    max-height: 740px;
    display: flex;
    flex-direction: column;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
    overflow: hidden;
    color: var(--color-nc-text);
    font-family: var(--font-family-sans);
    outline: none;
  }

  .modal-header {
    background: var(--color-nc-bg-header);
    padding: 8px 14px;
    border-bottom: 1px solid var(--color-nc-border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
  }

  .modal-title {
    font-weight: 600;
    font-size: 14px;
    color: var(--color-nc-text-bright);
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

  .modal-body {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: 12px;
    gap: 10px;
  }

  .error-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    background: rgba(239, 68, 68, 0.15);
    border: 1px solid var(--color-nc-danger);
    border-radius: 6px;
    padding: 8px 12px;
    color: var(--color-nc-danger);
    font-size: 12px;
    font-weight: 500;
  }

  .controls-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    flex-shrink: 0;
  }

  .control-panel {
    background: var(--color-nc-bg-deep);
    border: 1px solid var(--color-nc-border);
    border-radius: 6px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .control-panel.span-2 {
    grid-column: span 2;
  }

  .panel-header {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--color-nc-text-dim);
    border-bottom: 1px solid var(--color-nc-border);
    padding-bottom: 4px;
    margin-bottom: 2px;
  }

  .panel-row {
    display: flex;
    gap: 10px;
  }

  .field-col {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .field-col label {
    font-size: 11px;
    color: var(--color-nc-text-dim);
  }

  input[type="text"],
  input[type="number"],
  select {
    background: var(--color-nc-bg);
    border: 1px solid var(--color-nc-border);
    border-radius: 4px;
    padding: 5px 8px;
    color: var(--color-nc-text-bright);
    font-size: 12px;
    outline: none;
    width: 100%;
    box-sizing: border-box;
    font-family: inherit;
  }

  input[type="text"]:focus,
  input[type="number"]:focus,
  select:focus {
    border-color: var(--color-nc-accent);
  }

  .number-input-wrap {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .number-input-wrap input {
    width: 60px;
  }

  .unit {
    font-size: 11px;
    color: var(--color-nc-text-dim);
  }

  .options-row {
    display: flex;
    gap: 16px;
    margin-top: 2px;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--color-nc-text);
    cursor: pointer;
    user-select: none;
  }

  .counter-toggle {
    margin-bottom: 4px;
  }

  .counter-fields {
    display: flex;
    gap: 8px;
    align-items: flex-end;
  }

  .sub-field {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .sub-field label {
    font-size: 10px;
    color: var(--color-nc-text-dim);
  }

  .sub-field input[type="number"] {
    width: 55px;
  }

  .sub-field select {
    min-width: 130px;
  }

  /* Preview Section */
  .preview-section {
    flex: 1;
    min-height: 180px;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--color-nc-border);
    border-radius: 6px;
    overflow: hidden;
    background: var(--color-nc-bg);
  }

  .preview-header {
    background: var(--color-nc-bg-deep);
    padding: 6px 12px;
    border-bottom: 1px solid var(--color-nc-border);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .preview-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--color-nc-text-dim);
  }

  .items-count {
    font-size: 12px;
    color: var(--color-nc-text-dim);
  }

  .items-count.has-changed {
    color: var(--color-nc-accent);
    font-weight: 500;
  }

  .preview-scroll {
    flex: 1;
    overflow-y: auto;
  }

  .preview-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    font-family: var(--font-family-mono, monospace);
  }

  .preview-table th {
    position: sticky;
    top: 0;
    background: var(--color-nc-bg-header);
    padding: 6px 10px;
    text-align: left;
    color: var(--color-nc-text-dim);
    font-size: 11px;
    font-family: var(--font-family-sans);
    border-bottom: 1px solid var(--color-nc-border);
    z-index: 2;
  }

  .th-old { width: 46%; }
  .th-arrow { width: 8%; text-align: center; }
  .th-new { width: 46%; }

  .preview-table td {
    padding: 5px 10px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    color: var(--color-nc-text);
    word-break: break-all;
  }

  .td-arrow {
    text-align: center;
    color: var(--color-nc-accent);
    font-size: 11px;
  }

  .preview-table tr.changed td.td-new {
    color: var(--color-nc-marked);
    font-weight: 500;
  }

  .preview-table tr.conflict {
    background: rgba(239, 68, 68, 0.12);
  }

  .preview-table tr.conflict td.td-new {
    color: var(--color-nc-danger);
    font-weight: 600;
  }

  .conflict-tag {
    display: inline-block;
    font-size: 10px;
    background: var(--color-nc-danger);
    color: #fff;
    padding: 1px 4px;
    border-radius: 3px;
    margin-left: 6px;
    vertical-align: middle;
  }

  .modal-footer {
    padding: 10px 14px;
    background: var(--color-nc-bg-deep);
    border-top: 1px solid var(--color-nc-border);
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    flex-shrink: 0;
  }

  .btn {
    padding: 6px 18px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid var(--color-nc-border-bright);
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-cancel {
    background: var(--color-nc-bg-panel);
    color: var(--color-nc-text);
  }

  .btn-cancel:hover:not(:disabled) {
    background: var(--color-nc-bg);
  }

  .btn-ok {
    background: var(--color-nc-accent-dim);
    color: var(--color-nc-text-bright);
    border-color: var(--color-nc-accent);
  }

  .btn-ok:hover:not(:disabled) {
    background: var(--color-nc-accent);
    color: #fff;
  }

  .spinner-small {
    width: 12px;
    height: 12px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
