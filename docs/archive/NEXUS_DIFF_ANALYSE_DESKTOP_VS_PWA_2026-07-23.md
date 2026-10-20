# Diff-analyse: NexusCommander Desktop (Tauri) ↔ NexusCommander-PWA

**Datum:** 2026-07-23
**Doel:** exacte inventaris van overlap en drift tussen de twee codebases, als basis voor samenvoegen tot één monorepo met gedeelde UI.
**Beleid:** nieuwe functionaliteit van **deze versie (Desktop, 0.8.32) gaat voor** bij gelijkspel/tie-breaks. Uitzonderingen waar de PWA objectief vóórligt zijn expliciet gemarkeerd (⚠️).

- Desktop: `/mnt/Data/Development/_Apps/NexusCommander` — SvelteKit + Tauri (Rust), v0.8.32
- PWA: `/mnt/Data/Development/_Apps/NexusCommander-PWA` — SvelteKit + Express (Node), v0.8.28

---

## 0. Randvoorwaarden (bepalen de merge-strategie)

| Feit | Consequentie |
|------|--------------|
| **0 gedeelde git-commits** tussen de repos | Geen native `git merge` mogelijk. Reconciliatie op bestandsinhoud (2-way diff per bestand). |
| Desktop-repo start met *"Baseline commit before PWA portplan"* | Desktop is een fork-kopie van de PWA-frontend. Die baseline-snapshot kan als **synthetische gemeenschappelijke voorouder** dienen → dan alsnog per-bestand 3-way merge mogelijk. Te onderzoeken in migratiefase. |
| Beide 46 `src/`-bestanden, 36 gedeeld | Kern is één gedeelde frontend met twee transport-backends. |
| **Drift is tweerichtings** | "Desktop wint altijd" zou PWA-werk vernietigen (m.n. `FilePropertiesDialog`). Per-bestand beleid nodig. |
| i18n verschilt structureel (zie §5) | Desktop's `import.meta.glob`-bundeling wordt de gedeelde standaard. |

---

## 1. Identiek — direct deelbaar, nul werk (5)

| Bestand | Regels |
|---------|-------|
| `src/lib/components/FileEditor.svelte` | 119 |
| `src/lib/help/topics.json` | 108 |
| `src/lib/plugin-api.ts` | 250 |
| `src/lib/utils/smartPoller.ts` | 112 |
| `src/routes/+layout.ts` | 5 |

## 2. Vrijwel identiek — triviaal (<5 diff-regels) (2)

| Bestand | Diff-regels |
|---------|-------------|
| `src/lib/playerStore.ts` | 2 |
| `src/lib/components/TreeView.svelte` | 3 |

## 3. Kleine drift — makkelijk te verzoenen (<100 diff-regels) (11)

| Bestand | Diff-regels | Beleid |
|---------|-------------|--------|
| `theme.ts` | 21 | Desktop wint (localStorage-persist nieuwer) |
| `utils.ts` | 26 | Merge |
| `MultiRenameModal.svelte` | 43 | Merge |
| `HotlistModal.svelte` | 45 | Merge |
| `ActionPalette.svelte` | 54 | Merge |
| `stores.ts` | 58 | Merge |
| `NetworkConnectionsModal.svelte` | 62 | Merge |
| `MiniPlayer.svelte` | 70 | Merge |
| `ContextMenu.svelte` | 78 | Merge |
| `iconMap.ts` | 83 | Desktop wint (309 vs 232 regels = meer mappings) |
| `FunctionKeyBar.svelte` | 96 | Merge |

## 4. Middelgrote drift (100–300 diff-regels) (10)

| Bestand | Diff-regels | Aard van verschil |
|---------|-------------|-------------------|
| `SearchModal.svelte` | 129 | Feature-drift, verzoenbaar |
| `TaskProgress.svelte` | 132 | Web async-model vs Tauri events |
| `i18n.ts` | 137 | **Structureel** — zie §5 |
| `types.ts` | 137 | Backend-inherent (PWA 254 vs 127 regels; meer DTO's) — deels app-specifiek |
| `FolderTabs.svelte` | 152 | Feature-drift |
| `Toolbar.svelte` | 184 | Feature-drift |
| `DriveBar.svelte` | 204 | Desktop 214 vs PWA 158 — desktop wint (drive-types) |
| `TwinPanels.svelte` | 205 | Feature-drift |
| `DropMenuModal.svelte` | 221 | Feature-drift |
| `FileViewer.svelte` | 242 | Feature-drift |

## 5. Zware drift — bidirectionele feature-divergentie (300+) (8)

Per bestand geanalyseerd op **unieke functies** per kant.

### `OptionsDialog.svelte` — 1436 diff (Desktop 1645 / PWA 1297) → **Desktop wint** ✓
- **Desktop-only:** `handleSaveView`, `handleSaveAsView`, `handleDeleteView`, `handleRenameView`, `handleViewChange` → **opgeslagen views/layouts** (nieuwe functionaliteit deze versie).
- PWA-only: `handleFieldInput`, `handleHelp` (klein).
- **Beleid:** desktop als basis; PWA's `handleHelp` erin porten.

### `Dialog.svelte` — 877 diff (Desktop 1113 / PWA 972) → **Desktop wint** ✓
- **Desktop-only:** `loadPickerDir`, `selectPickerFolder`, `goUpPicker`, `getDefaultExtension`, `handlePackDestFocus/Blur`, `handlePackOptionChange` → **ingebouwde folder-picker + pack-opties**.
- **Beleid:** desktop als basis.

### `FilePropertiesDialog.svelte` — 934 diff (Desktop 273 / **PWA 991**) → ⚠️ **PWA wint / porten vereist**
- Desktop-only functies: **geen**.
- **PWA-only:** `loadUsersAndGroups`, octaal/chmod-editor (`getOctalFromState`, `handleOctalChange`, `updateFromOctal`, `toggleAllowExecute`), `getSizeOnDisk`, `formatDetailedDate/Size`, `getMediaType`, `handleSave`, `moveToFront`.
- **Desktop-versie is een stub (273 regels) t.o.v. de PWA (991).** Botte "desktop wint" zou de rechten-editor, users/groups, size-on-disk en media-type vernietigen.
- **Beleid:** PWA-versie als basis; via Tauri-IPC koppelen aan de Rust-backend (`vfs.rs` heeft `uzers` al voor users/groups).

### `FileList.svelte` — 1824 diff (Desktop 3097 / PWA 3469) → **Merge beide kanten**
- **Desktop-only:** `checkPathValidity`, `enterResolvedEntry`, `handleFeedToListbox`, `handleFileListWheel`, `handleMenuAction`, `initTabs`, `isDirSizePending`, `processNext`.
- **PWA-only:** `checkReadOnly`, `getViewMode`, `handleColumnsSync`, `navigateTo`, `requestOpen`, `showActionToast`, `sortEntries`, `updateRowHeight`, `abortDirSizeCalcs`, **touch/long-press** (`handleLongPressStart/Move/End`, `handlePathLongPressStart`, `clearLongPressTimer`).
- **Beleid:** grootste merge-klus. Desktop-interacties (wheel, menu-actie) + PWA-features (view-modes, sort, toast, read-only). Touch/long-press is mobiel-specifiek → achter capability-flag, niet weggooien.

### `+page.svelte` — 984 diff (Desktop 880 / PWA 1148) → **App-specifiek splitsen (niet volledig delen)**
- **Desktop-only:** `handleEditFile`, `handleViewFile`, `closeEditor`, `closeViewer`, `handleExit`, `handleToggleLayout`, `startBackgroundTask`, `watchTaskRefresh`.
- **PWA-only:** `handleBeforeInstallPrompt`, `installPWA`, `handleFilePickerChange`, `handlePaste` (clipboard), `pollBlockingFileOperation`/`trackBlockingFileOperation` (web polling-model), foreground-task-popup, `handleSwapPanels`, `handleTargetSource`.
- **Beleid:** dit is de **app-shell**; divergentie is grotendeels platform-inherent (PWA-install, clipboard, web-polling vs native editor-vensters). Blijft grotendeels per-app; gedeelde logica naar `packages/ui` stores.

### `AboutDialog.svelte` — 459 diff (Desktop 314 / PWA 395) → Merge (content, geen logica)
- Divergentie zit in markup/content, niet in functies. PWA groter (promo/install-content).

### `ipc.ts` — 516 diff (Desktop 442 / PWA 530) → **Transport-inherent → adapter-grens**
- Zelfde functie-interface (`readDirectory(path): Promise<FileEntry[]>` etc.), andere implementatie: Tauri `invoke()` vs HTTP `fetch('/api/...')`.
- **Beleid:** dit ís de platformgrens. Wordt de swapbare adapter: `packages/ui` importeert de interface, elke app levert zijn `ipc.ts`.

### `MenuBar.svelte` — 366 diff (Desktop 734 / PWA 690) → Merge (menu-items, geen logica)
- Alleen `unsub2` (desktop) / `closeMenu` (PWA) uniek; rest is verschil in menu-items.

---

## 6. Alleen in Desktop (deze versie) (10)

| Bestand | Betekenis |
|---------|-----------|
| `components/DynamicIcon.svelte` | Icon-rendering (nieuwer) |
| `components/HelpDialog.svelte` | Help-venster (desktop-variant; PWA heeft `HelpViewer`) |
| `components/PackProgressDialog.svelte` | Archief-pack voortgang |
| `components/TextEditorModal.svelte` | Ingebouwde teksteditor |
| `locales/{de,en,es,fr,nl,pt}.json` | 6 taalbestanden, **gebundeld** (zie §5) |

## 7. Alleen in PWA (10)

| Bestand | Betekenis | Lot bij merge |
|---------|-----------|---------------|
| `components/UploadConflictModal.svelte` | Upload-conflict UI | Web-specifiek (geen upload op desktop) |
| `components/UploadProgress.svelte` | Upload-voortgang | Web-specifiek |
| `upload/uploadClient.ts` | Upload-transport | Web-specifiek |
| `upload/uploadStore.ts` | Upload-state | Web-specifiek |
| `upload/webkitEntries.ts` | Drag-drop mapstructuur (browser) | Web-specifiek |
| `utils/touch.ts` | Touch-gebaren | Mobiel — capability-flag |
| `components/HeadlessFileModal.svelte` | ? | Onderzoeken |
| `components/HelpViewer.svelte` | Help (PWA-variant) | Verzoenen met desktop `HelpDialog` |
| `components/TaskProgressPopUp.svelte` | Taak-popup | Verzoenen met `TaskProgress` |
| `components/TitleBar.svelte` | Titelbalk (web) | Web-specifiek (Tauri heeft native decorations) |

---

## 8. i18n — structureel verschil (§5)

| | Desktop | PWA |
|--|---------|-----|
| Bron | `src/lib/locales/*.json` (6 talen) | `server/langs/*.json` |
| Laden | `import.meta.glob("./locales/*.json")` — **gebundeld, statisch, offline** | `loadLanguageFile()` via IPC → server-fetch, runtime |

**Beleid:** Desktop's gebundelde aanpak wordt de gedeelde standaard (werkt offline, geen server-roundtrip). De web-app kan dezelfde bundel gebruiken; de Express-`/api`-taalendpoint mag vervallen of als fallback blijven.

---

## 9. Samenvattend beeld (merge-omvang)

| Categorie | Aantal | Werk |
|-----------|-------:|------|
| Identiek / triviaal | 7 | ~0 |
| Klein (<100) | 11 | Laag |
| Middel (100–300) | 10 | Middel |
| Zwaar (300+) | 8 | Hoog — kern van de klus |
| Alleen desktop | 10 | Behouden |
| Alleen PWA | 10 | Deels web-specifiek, deels porten |

**Kritieke aandachtspunten:**
1. ⚠️ **`FilePropertiesDialog.svelte`** — PWA vér vooruit (chmod/octaal-editor, users/groups, size-on-disk). Desktop-versie is stub. **Niet overschrijven met desktop.**
2. **`FileList.svelte`** (1824 diff) — grootste merge; beide kanten hebben unieke features + touch-support (PWA).
3. **`+page.svelte`** & **`ipc.ts`** & **`types.ts`** — blijven grotendeels per-app (platformgrens), niet forceren in gedeelde package.
4. **Backends blijven gescheiden** — Express stelt FS bloot via HTTP (ander trust-model dan Tauri capability-scoping). Zie security-audit 2026-07. Alleen de frontend wordt gedeeld.

## 10. Voorgestelde eindstructuur (monorepo)

```
NexusCommander/                 (één repo)
  packages/ui/    → gedeelde .svelte, theme, i18n (gebundeld), stores,
                    types (gedeelde subset), utils, plugin-api, locales/*.json
  apps/desktop/   → Tauri: Rust-backend + ipc.ts (invoke-adapter)
                    → build-targets: Linux + macOS + Windows
  apps/web/       → SvelteKit + Express + ipc.ts (fetch-adapter) + upload/* + TitleBar
                    → PWA
```
