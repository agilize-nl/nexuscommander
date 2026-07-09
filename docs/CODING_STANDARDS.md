# NexusCommander Coding Standards

## Dialogs and Overlays

### 1. Visual Consistency
All dialogs must follow the standardized UI pattern established in the `OptionsDialog` component. This includes:
- **Colors**: Use the design system CSS variables (e.g., `--color-nc-bg-deep`, `--color-nc-text-bright`, `--color-nc-accent`).
- **Header**: Standard height, dragging cursor on hover, and a consistent close button.
- **Footer**: Consistent button styles and alignment.
- **Micro-animations**: Use Svelte `scale` and `fade` transitions for opening and closing.

### 2. Boundaries and Positioning
**Rule**: No dialog or interactive overlay may fall outside the visible boundaries of the application window.
**Implementation Requirements**:
- Dragging logic must check against `window.innerWidth` and `window.innerHeight`.
- The dialog's position (`x`, `y`) must be clamped.
- Keep modal backdrops visually transparent; depth should come from the dialog panel's `box-shadow`, not from a darkened or blurred background overlay.

### 3. Focus and Interaction
- Dialogs must auto-focus their primary input or button on Mount.
- Escape key must always close the dialog.
- Enter key should trigger the primary action (OK/Confirm).

### 4. Background Interaction Blocking
**Rule**: Open modals must completely block interactions with the background UI.
**Implementation Requirements**:
- All background interactive elements must check the global `overlayActive` state: `if (overlayActive) return;`.
- Use a high `z-index` (e.g., `5000`) for top-level modals.

## Settings and Persistence

### 1. Unified Configuration
- All application settings must be defined in the `AppConfig` interface in `src/lib/ipc.ts` and the `DEFAULT_CONFIG` in `server/routes/settings.js`.
- Configuration is stored as JSON in `~/.config/nexuscommander/config.json`.

### 2. Immediate Feedback and Persistence
- When a setting is changed in the Options dialog, it should trigger the `nc:settings-changed` custom event.
- The UI must react to this event immediately (e.g., updating fonts or themes via CSS variables).
- Use `currentTheme` Svelte store for synchronized theme application across components.

## File Manipulation and Archives

### 1. Performance and Safety
- **Backend I/O**: Use Node.js `fs/promises` for non-blocking file operations.
- **Streaming**: For large file operations (Split/Combine), use Node.js `ReadStream` and `WriteStream` with appropriate pipe logic to minimize memory footprint.
- **Error Handling**: Map system errors (ENOENT, EACCES) to localized user-friendly messages.

### 2. Virtual Path Resolution
- Archives (ZIP/TAR(.GZ/.BZ2/.XZ)/7Z/RAR) are treated as virtual directories, addressed as `<archive-path>::<inner-path>`. `splitVirtualPath()` (`server/lib/archivePaths.js`) is the single source of truth for parsing this — it also accepts a nested-slash form (`archive.zip/inner/path`) for callers that concatenate paths with `/`. It intentionally only matches when there is at least one path segment *after* the archive file: a source whose path *is* the archive file itself (e.g. copying/moving `backup.zip` selected from a normal folder) must stay a plain file operation, not be treated as "inside" an archive.
- Backend routes in `server/routes/archive.js` handle browsing (`check`/`read`, per-directory listing with implicit folders derived from entry names) and `server/lib/taskExecutor.js` handles copy/move: sources located inside an archive (non-empty inner path) are extracted to a temporary staging directory first, then copied through the normal `collectEntries`/`copyOneFile` pipeline (so conflict resolution, progress and cancellation work identically to on-disk copies). The staging directory is always cleaned up in a `finally` block.
- **Archives are read-only**: Move/Delete/Rename/Mkdir on a source located inside an archive must be rejected with a clear error — only copy/extract is allowed.
- **Zip-slip guard**: any extracted entry path must resolve to inside the staging directory (`resolved === dest || resolved.startsWith(dest + path.sep)` — never a bare `startsWith`, which a sibling directory with a matching prefix, e.g. `dest` vs `dest-evil`, would bypass).

### 3. Privileged Operations (sudo elevation)
When a filesystem operation fails with a permission error, the UI may offer to retry it with elevated rights. The established flow is:

1. Detect `EACCES`/`EPERM`/"permission denied" in the error message.
2. Store the pending operation in the `pendingElevatedAction` store (`src/lib/stores.ts`).
3. Open the `permission_denied` dialog, then the `sudo_password` dialog (both handled by `Dialog.svelte` / `+page.svelte`).
4. Submit via `elevateOperation()` (`src/lib/ipc.ts`) to `POST /api/fs/elevate-operation`, which runs the command through `sudo -S` with the password piped to stdin.

**Backend rules for elevated endpoints** (`server/routes/fs.js`):
- Only whitelist specific actions (`mkdir`, `delete`, `move`, `rename`, `chmod`, `chown`, `set-properties`); never pass a raw command through.
- Validate all user-supplied arguments: octal modes against `/^[0-7]{3,4}$/`, owner/group names against a safe account-name pattern.
- Call `assertNotProtectedRoot()` before destructive elevated actions (delete/move/rename) — the same protection as non-elevated operations.
- Never log or persist the password; it only travels through the spawned process' stdin.
- On the client, keep `pendingElevatedAction` set when the password was wrong (so the user can retry) and clear it on success, on other errors, and on dialog cancel.

### 4. File Properties
- The `FilePropertiesDialog` edits permissions (including SUID/SGID/sticky), owner and group. The permission checkboxes are the source of truth; the octal text field is a convenience input that only syncs into the checkboxes when it contains a valid octal value.
- On save, only submit fields that actually changed compared to the entry's initial state, so viewing properties of a file you don't own never triggers a needless chmod/chown (and thus no needless elevation prompt).
- `GET /api/fs/users-groups` supplies the owner/group dropdowns; directory listings report `permissions` as `mode & 0o7777` so special bits survive the round-trip. The endpoint also returns `currentUser`/`currentGroup` (from `os.userInfo()` / `process.getgid()`), which `FilePropertiesDialog` moves to the front of the Owner/Group lists — otherwise the logged-in account's own name sits wherever `/etc/passwd`/`/etc/group` happens to put it, often at the very bottom.

### 5. Feedback for No-Op Actions
- Any Files-menu action that only makes sense for a specific selection (Pack/Unpack/Test Archive/Split need a non-directory entry; Pack/Combine need at least one entry) must show a toast on the invalid-selection path, not return silently. `FileList.svelte`'s `showActionToast()` (reusing the `.test-result-toast` UI) is the established mechanism — route the message through `$_('errors.select_file_first')` / `$_('errors.nothing_selected')` rather than adding a new hardcoded string.

## Styling & Tailwind CSS (v4)

### 1. Integration Rules
- **Plugin Order**: In `vite.config.js`, `sveltekit()` **must** be placed before `tailwindcss()`. This prevents Tailwind from scanning raw Svelte script blocks as CSS.
- **Semicolon Rule**: Never include a trailing semicolon in `@import "tailwindcss"` in `app.css`.
- **CSS Variables**: Always use `--color-nc-*` variables. Do not use ad-hoc hex codes in components.

## PWA & Service Workers

### 1. Offline Support
- The `static/sw.js` must be kept updated with critical asset lists.
- Use the `manifest.webmanifest` for defining app identity and icons.

### 2. Window Controls Overlay
- Utilize the `TitleBar.svelte` component to handle custom title bars when the PWA is running in standalone mode with the `window-controls-overlay` feature enabled.

## Code Quality

### 1. Svelte 5 Runes
- Use `$state`, `$derived`, and `$effect` exclusively. Avoid legacy Svelte 4 `let` reactivity or `$: ` statements.
- Component props should use the `let { ... } = $props();` syntax.

### 2. Localization
- Never hardcode user-visible strings. Use the `$_()` helper from `$lib/i18n`.
- Ensure all new keys are added to `server/langs/en.json` (and eventually other languages).

### 3. Menu/Keyboard Action Dispatch (single source of truth)
- `MenuBar.svelte` and `ActionPalette.svelte` both dispatch a global `window` `nc:menu-action` CustomEvent; `+page.svelte`'s `handleMenuAction` is the **only** place that should react to it, resolving the active panel (`activePanel` store) and calling the matching exported method on `leftPanel`/`rightPanel`.
- Do not add a second listener for the same action inside `FileList.svelte` (or any other panel-scoped component) "just for that panel" — since `+page.svelte` already resolves to the active panel, a local listener fires a second, redundant call on every dispatch. This was found and removed for 12 actions (select/unselect-all(-files), select/unselect-same-ext, invert-selection, save/restore-selection, test-archive, split, combine) that were each running twice per click — doubling e.g. the Test Archive network round-trip for no benefit.
- The same duplication class broke **F9** specifically: `FileList.svelte`'s own key handler dispatched `task-manager` (forces the task panel open) while `+page.svelte`'s global key handler called the real `toggle()` — the two fought every press, so F9 looked like it did nothing. Keyboard shortcuts that should behave as a single global toggle belong only in `+page.svelte`'s `handleKeydown`; panel-local key handling should stay limited to actions that genuinely depend on which panel is focused (selection, navigation, Alt+F9 unpack of the selected entry, etc.).
