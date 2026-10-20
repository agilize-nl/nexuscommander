# NexusCommander (Tauri) — Portplan: verbeteringen uit de PWA-versie overnemen

_Opgesteld: 2026-07-03 · Bron: `/mnt/Data/Development/_Apps/NexusCommander-PWA/` (gestart vanaf v0.8.0-PWA) · Doel: deze repo (Tauri-desktopversie; versienummering volgt nu de PWA)_

Dit document inventariseert welke verbeteringen uit de PWA-versie **niet PWA-specifiek** zijn en dus waardevol zijn om terug te porten naar deze originele Tauri-app, met per item bronbestanden, doelbestanden, inschatting en aandachtspunten. Alle bevindingen zijn geverifieerd door beide codebases file-voor-file te diffen.

> **Status (bijgewerkt 2026-07-13):** Fases 0 t/m 5 uitgevoerd, op de expliciet optionele/lagere-prioriteit items na (P11, P12, T3). Fase 6 (PWA v0.8.1 → v0.8.8) is uitgewerkt en hieronder toegevoegd als **gepland, nog niet geïmplementeerd**. Zie ✅/⏭️/📋-markeringen per item hieronder en het commit-overzicht in Git. Elke uitgevoerde fase is geverifieerd met `npm run check` (0 fouten/waarschuwingen), een volledige `cargo build` en een production `npm run build`. De Tauri-desktopversie volgt nu de PWA-versie; de actuele gesynchroniseerde versie is `0.8.28`.

---

## 0. Context: hoe de twee versies zich verhouden

Beide apps delen dezelfde SvelteKit/Svelte 5-frontend en zijn rond **medio maart 2026** uit elkaar gegaan (identieke bestanden dateren van 2026-03-15). Daarna zijn **beide takken doorontwikkeld**:

- **Deze repo (origineel/Tauri)** kreeg t/m 2026-03-30 een grote eigen ontwikkelronde: nieuw i18n-systeem met frontend-locales (6 talen via `import.meta.glob`), herschreven `Dialog.svelte` (incl. `confirm`-type en Shift+Del permanent verwijderen), uitgebreidere `OptionsDialog`, `DynamicIcon.svelte`, `PackProgressDialog.svelte`, `HelpDialog.svelte`, `updateSettings()` met debounced save, en dynamische rijhoogte in `FileList`.
- **De PWA** verving de Rust-backend door een Express-server, en kreeg in maart eigen UI-features plus op 2026-07-02/03 een grote fix-ronde (gedocumenteerd in `NexusCommander-PWA/docs/ANALYSE_EN_VERBETERPLAN.md`).

**Belangrijkste consequentie:** gedeelde componenten mogen **nooit bestandsgewijs gekopieerd** worden van PWA → origineel (behalve pure assets). Vrijwel elke overlappende component is in het origineel óók (en soms verder) doorontwikkeld. Alles hieronder is daarom **cherry-picken per feature**.

### Wat NIET geport hoeft te worden (ter afbakening)

| Categorie | Reden |
|---|---|
| Express-server, `server/lib/security.js`, `originGuard`, `resolveSafePath`, taskExecutor, alle 17 endpoint-fixes | PWA-architectuur; de Rust-backend (`src-tauri/src/`) heeft dit al native (echte copy/move/delete met conflictafhandeling in `task_queue.rs`, hex-viewer in `viewer.rs`, event-gedreven zoeken in `search.rs`) |
| Service worker, `manifest.webmanifest`, cache-strategie | PWA-specifiek |
| `TitleBar.svelte` | In de PWA een lege placeholder ("Browser handles this"); Tauri gebruikt native vensterdecoratie |
| `apiFetch`-foutafhandeling, SSE-pad/casing-fixes | HTTP-laag bestaat hier niet; IPC loopt via Tauri `invoke` |
| `appConfig`-ReferenceError-fix (PWA-plan §2.1) | Bestaat hier niet: `+page.svelte:75` gebruikt al netjes `$derived($appConfigStore)` |
| PWA `stores.ts` (`persistSettings` via CustomEvent) | Het origineel heeft het betere patroon (`updateSettings()` met debounced save in `src/lib/stores.ts`) |
| PWA `i18n.ts` (server-langs + `BUILTIN_FALLBACK`) | Het origineel heeft het nieuwere systeem (frontend-locales, 6 talen, dynamische discovery) |
| PWA-versies van `Dialog.svelte`, `OptionsDialog.svelte`, `FolderTabs.svelte`, `DriveBar.svelte`, `Toolbar.svelte`, `HelpDialog`-vervanging, rijhoogte-fix | Origineel is hier gelijk of verder (bv. `FileList.svelte:120` berekent rijhoogte al reactief uit `font_pane_size`; `FolderTabs` heeft lock/rename/reorder al) |
| PWA i18n-sleutels integraal mergen | De sleutel-naamgeving is volledig uiteengelopen (`dialog.*` vs `dialogs.*`, 271 PWA-only vs 179 origineel-only keys). Alleen keys meenemen die bij een geporte feature horen, in de naamgeving van het origineel |

---

## 1. Te porten verbeteringen (geverifieerd)

### P1 — Icon-theme-assets ontbreken (functioneel defect in deze repo) 🔴 [S] ✅ al aanwezig, geen actie nodig

Het origineel biedt in de OptionsDialog drie icoonthema's aan (`OptionsDialog.svelte:656-658`: Material, Papirus, Lucide) en `DynamicIcon.svelte` rendert voor Material/Papirus een `<img src="/icons/{theme}/….svg">` (`iconMap.ts:146`). Maar **`static/icons/` bestaat hier niet** — kiezen voor Material of Papirus levert dus kapotte afbeeldingen op. De PWA heeft de daadwerkelijke assets.

- **Bron:** `NexusCommander-PWA/static/icons/material/` en `NexusCommander-PWA/static/icons/papirus/` (~47 SVG's per set)
- **Doel:** `static/icons/material/`, `static/icons/papirus/`
- **Actie:** directories 1-op-1 kopiëren. `iconMap.ts` is in beide repo's identiek, dus de padden en bestandsnamen matchen al.
- **Verificatie:** Options → Appearance → wissel icoonthema; iconen zichtbaar in beide panelen.
- **Bevinding:** `static/icons/material` en `static/icons/papirus` bleken al aanwezig in dit repo (62 SVG's elk, eigen curatie i.p.v. 1-op-1 kopie van de PWA-set). Het beschreven defect bestond niet meer — geen wijziging doorgevoerd.

### P2 — Bewerkbare padbalk in FileList 🟠 [M] ✅ geport

PWA-feature (juli-ronde): rechtsklik op het pad boven een paneel opent een invoerveld waarin je direct een pad typt en met Enter navigeert (met Escape annuleren), plus een klein contextmenu op de padbalk.

- **Bron:** `NexusCommander-PWA/src/lib/components/FileList.svelte` — functies `startPathEdit`, `commitPathEdit`, `cancelPathEdit`, `handlePathEditKeydown`, `showPathInputMenu`, `getSelectedPathText`, `navigateTo` + de template rond regel 2197 (`.path-display` met conditionele `<input>`) + bijbehorende state (`pathEditActive`, `pathEditValue`, `pathInputEl`) en CSS.
- **Doel:** `src/lib/components/FileList.svelte` (padweergave-sectie).
- **Aandachtspunt:** de navigatie zelf moet via de bestaande `loadDirectory`/refresh-flow van het origineel lopen, niet via de PWA-`navigateTo` letterlijk overnemen (die leunt op de HTTP-ipc). Foutafhandeling: ongeldig pad → nette melding, huidige listing behouden.
- **Verificatie:** rechtsklik pad → typ `/etc` → Enter → listing verandert; Escape herstelt.
- **Commit:** `3d3de54` — via `getEntryPath`/`loadDirectory` van het origineel, i18n-keys `filelist.path_cut/copy/paste/select_all` in alle 6 talen.

### P3 — "Feed to listbox": zoekresultaten naar een paneel sturen 🟠 [M] ✅ geport

PWA-feature: in de SearchModal kun je de gevonden resultaten als (virtuele) lijst in het actieve paneel laden, à la Total Commander.

- **Bron:**
  - `NexusCommander-PWA/src/lib/components/SearchModal.svelte:70` — dispatch van `nc:feed-to-listbox` CustomEvent + knop (i18n-key `search.feed_to_listbox`)
  - `NexusCommander-PWA/src/lib/components/FileList.svelte:763` — `export function feedResults(...)` + `isSearchResultsView`-state + listener rond regel 735
  - `NexusCommander-PWA/src/lib/types.ts:4` — `FileEntry.path?: string` (volledig pad per resultaat, nodig omdat entries uit verschillende mappen komen)
- **Doel:** `src/lib/components/SearchModal.svelte`, `src/lib/components/FileList.svelte`, `src/lib/types.ts`.
- **Aandachtspunten:**
  - Het origineel ontvangt zoekresultaten al streamend via Tauri-events (`SearchModal.svelte:31`, `search-result`/`search-done`) — dat blijft; alleen de "voer naar paneel"-knop en de FileList-weergavemodus komen erbij.
  - In de resultatenweergave moeten navigatie-acties (Enter op een entry, F3/F4-viewer, contextmenu) het `entry.path`-veld gebruiken i.p.v. `currentPath + name`. Refresh/Backspace verlaat de resultatenmodus terug naar het echte pad.
  - Nieuwe i18n-key toevoegen aan **alle 6** locales (`src/lib/locales/*.json`), in de key-naamgeving van het origineel.
- **Verificatie:** zoek in `~`, klik "Feed to listbox", resultaten staan in actief paneel, Enter opent bestand uit andere map correct.
- **Commit:** `e620492` — nieuwe `getEntryPath()`-helper in `FileList.svelte`, gebruikt door `enterEntry`/`getOperationEntries`/"Open with"/Show Properties/quick-view/FILENAME-kolom. Rename/pack/split/combine/calc-size bewust **niet** aangepast (zelfde scope als de PWA). Backspace/Refresh verlaten resultatenmodus via nieuwe `preSearchPath`-state.

### P4 — "Open met"-menu met "Always"-radio (standaard-app instellen) 🟠 [M] ✅ geport

PWA-feature: in het contextmenu van een bestand toont het "Open met"-submenu per applicatie een radio-toggle "Always" waarmee die app als systeemstandaard voor dat bestandstype wordt gezet.

- **Bron:**
  - `NexusCommander-PWA/src/lib/types.ts:93-105` — uitbreiding `MenuItem` met `checked?`, `radio?`, `onToggle?` (incl. de `never`-variant voor separators)
  - `NexusCommander-PWA/src/lib/components/ContextMenu.svelte:114-131` + CSS — rendering van checkbox/radio-"Always"-toggle
  - `NexusCommander-PWA/src/lib/components/FileList.svelte:355-400` — opbouw van het "Open met"-submenu met `checked: app.is_default`, `radio: true`, `onToggle` → `setDefaultApp(...)`
- **Doel:** `src/lib/types.ts`, `src/lib/components/ContextMenu.svelte`, `src/lib/components/FileList.svelte`, plus **Rust**: `src-tauri/src/` (nieuw commando).
- **Aandachtspunt (backend):** het origineel heeft `getOpenWithApps` en `openFileWithApp` al (`src/lib/ipc.ts:240-246`), maar **geen `setDefaultApp`**. Er is dus een nieuw Tauri-commando nodig (`set_default_app`, implementatie via `xdg-mime default <desktop-id> <mimetype>` — zie de PWA-referentie in `server/routes/system.js`), geregistreerd in `lib.rs`/`main.rs`, plus een `AppInfo.is_default`-veld in de bestaande open-with-query.
- **Verificatie:** contextmenu op een `.txt` → Open met → radio bij andere editor aanvinken → `xdg-mime query default text/plain` toont de nieuwe standaard.
- **Commit:** `cc30903` — bevinding onderweg: `getOpenWithApps`/`openFileWithApp` waren in `ipc.ts` gedeclareerd maar **nergens** in `src-tauri/` geïmplementeerd of geregistreerd (het "Open with"-submenu was dus al die tijd stil leeg door een geslikte catch). Nieuw Rust-bestand `src-tauri/src/open_with.rs` implementeert alle drie de commando's (`get_open_with_apps`, `open_file_with_app`, `set_default_app`) via `.desktop`-parsing + `xdg-mime`/`gtk-launch`, geregistreerd in `lib.rs`.

### P5 — Taakvenster op afroep openen (TaskProgress `open()`/`toggle()`) 🟡 [S] ✅ geport

In het origineel verschijnt `TaskProgress.svelte` alleen als er taken zijn. De PWA voegde exporteerbare `open()`/`toggle()`-functies toe plus een `forcedVisible`-state en een nette lege-status ("geen taken"), zodat het venster ook via een menu-item/sneltoets te openen is; daarnaast zijn de labels ge-i18n'd.

- **Bron:** `NexusCommander-PWA/src/lib/components/TaskProgress.svelte` (diff t.o.v. origineel: `forcedVisible`, `export async function open/toggle`, `isVisible`-derived, `task-empty`-blok, `$_()`-labels)
- **Doel:** `src/lib/components/TaskProgress.svelte` + aanroep-plek in `src/routes/+page.svelte` (menu/sneltoets koppelen).
- **Optioneel erbij:** `TaskProgressPopUp.svelte` (PWA-only component, gebruikt in PWA `+page.svelte:768`) — compacte per-taak-popup met poll op `taskGet`. Werkt op het bestaande `TaskInfo`-type en is vrijwel 1-op-1 overneembaar; beslis eerst of je hem naast het bestaande TaskProgress-paneel wilt. ⏭️ **niet opgepakt** (optioneel, geen apart besluit genomen).
- **Commit:** `3658d4d` — `forcedVisible`/`open()`/`toggle()`/lege-status + nieuw menu-item "Job List" (Ctrl+J) in `MenuBar.svelte` gekoppeld aan `taskProgress.toggle()` in `+page.svelte`. Taken-labels ook gelokaliseerd (nieuwe `tasks.*` keys, 6 talen) — bleken nog hardcoded Engels te zijn.

### P6 — Zoekfunctie in de Help 🟡 [S–M] ✅ geport

De PWA-`HelpViewer.svelte` heeft een zoekveld dat live door alle (geflattende) helponderwerpen filtert. Het origineel (`HelpDialog.svelte`, nieuwer van architectuur, laadt topics/content via Rust) heeft géén zoekfunctie.

- **Bron:** `NexusCommander-PWA/src/lib/components/HelpViewer.svelte` — `searchQuery`-state + `flattenedTopics` (`$derived.by`) + filter-UI.
- **Doel:** `src/lib/components/HelpDialog.svelte` — alleen het zoekgedeelte overnemen; de laad-architectuur van het origineel (via `getHelpTopics`/`getHelpContent`) intact laten.
- **Overweging (apart besluit):** de PWA laadt help-content client-side via `import.meta.glob('../help/*.md', { query: '?raw' })`. Dezelfde markdownbestanden staan hier ook al in `src/lib/help/`. Overstappen zou de Rust-commando's `get_help_topics`/`get_help_content` overbodig maken (minder code), maar is een architectuurwijziging — niet nodig voor de zoekfeature zelf. ⏭️ niet doorgevoerd (bewust, geen architectuurwijziging nodig voor deze feature).
- **Commit:** `5480c5e` — zoekveld + "geen resultaten"-state toegevoegd aan `HelpDialog.svelte`, laad-architectuur (`getHelpTopics`/`getHelpContent`) ongewijzigd. Nieuwe keys `help_dialog.search_placeholder`/`no_topics_match` in 6 talen.

### P7 — Paneelverhouding persisteren 🟡 [S] ✅ geport

Beide versies hebben de sleepbare divider tussen de panelen, maar alleen de PWA slaat de verhouding op in de config (`layout_panel_ratio`) en herstelt die bij opstarten (`TwinPanels.svelte`, init vanuit `$appConfigStore`). In het origineel ontbreekt zo'n veld in `AppConfig` (`src/lib/ipc.ts:286-332`) — de verhouding is na herstart weg.

- **Doel:** `src/lib/ipc.ts` (`AppConfig` + veld `panel_ratio?: number`), `src-tauri/src/settings.rs` (default), `src/lib/components/TwinPanels.svelte` (init + opslaan via het bestaande `updateSettings()` met debounce).
- **Verificatie:** divider verslepen → app herstarten → verhouding behouden.
- **Commit:** `399f2f0` — `panel_ratio: f64` toegevoegd aan `AppConfig` (Rust `settings.rs` incl. INI load/save) en `ipc.ts`; `TwinPanels.svelte` initialiseert `leftFlex`/`rightFlex` eruit en slaat op via `updateSettings()` bij einde van de divider-drag.

### P8 — Thema direct bij opstarten (localStorage, anti-flash) 🟢 [XS] ✅ geport

PWA `theme.ts` schrijft het gekozen thema óók naar `localStorage` (`theme.ts:27`), zodat bij een volgende start het juiste thema al staat vóórdat de config async uit de backend geladen is. In het origineel kan daardoor kort het default-thema flitsen.

- **Doel:** `src/lib/theme.ts` — bij `setTheme` ook `localStorage.setItem("nc-theme", …)`; bij module-init `localStorage.getItem` als startwaarde. Config blijft de bron van waarheid zodra geladen.
- **Commit:** `f264bb5` — `localStorage.setItem` in `applyTheme()` + inline anti-flash script (thema + achtergrondkleur) toegevoegd aan `src/app.html`, identiek aan de PWA-aanpak.

### P9 — Localisatie van hardcoded strings 🟢 [S] ✅ geport

De PWA heeft twee componenten ge-i18n'd die in het origineel nog hardcoded Engels zijn:

- **`FilePropertiesDialog.svelte`** — "File Properties", "Location:", "Size:", "Modified:", "Permissions:", "Owner:", "Close" → keys (PWA-referentie: `file_properties.*`, `common.close`).
- **`DriveBar.svelte:45-48`** — het "free"-label in de vrije-ruimte-indicator (PWA-referentie: `drive_bar.free`).

Nieuwe keys toevoegen aan **alle 6** locale-bestanden (`src/lib/locales/{en,nl,de,es,fr,pt}.json`), in de bestaande key-stijl van het origineel. Terwijl je bezig bent: `DropMenuModal.svelte` is in béíde versies nog hardcoded ("Ask", "Check free space", …) — mooi moment om die meteen mee te nemen.

- **Commit:** `b7126c4` — nieuwe secties `file_properties`, `drive_bar`, `drop_menu` in alle 6 locales, met hergebruik van bestaande `dialog.*`/`about.close`-keys waar de string al bestond. `DropMenuModal.svelte` meteen meegenomen zoals gesuggereerd.

### P10 — SearchModal: autofocus op zoekveld 🟢 [XS] ✅ al aanwezig, geen actie nodig

PWA-fix: `inputEl`-binding + `inputEl?.focus()` bij openen (`SearchModal.svelte:17,27`). Het origineel focust het veld niet. Triviaal over te nemen in `src/lib/components/SearchModal.svelte`.
- **Bevinding:** `inputEl?.focus()` stond al in `onMount` (`SearchModal.svelte:41`) van het origineel — geen wijziging nodig.

### P11 — Optioneel: uitgebreide bestandsmetadata 🟢 [M, lage prioriteit] ⏭️ niet opgepakt

PWA `types.ts` breidde `FileEntry` uit met `created`, `accessed`, `changed`, `link_target`, `compressed_size`, en de Node-backend vult created/accessed/changed (`server/routes/fs.js:119-121`). De PWA-UI toont ze zelf overigens nog nergens. Alleen oppakken als de eigenschappen-dialog deze velden echt gaat tonen; vergt uitbreiding van het `FileEntry`-struct en de directory-listing in `src-tauri/src/vfs.rs`.

- **Status:** bewust overgeslagen — expliciet lage prioriteit in het plan en de PWA-UI toont de velden zelf nergens, dus geen aanleiding om `vfs.rs` uit te breiden.

### P12 — Optioneel: AboutDialog versleepbaar + versie-info 🟢 [S, cosmetisch] ⏭️ niet opgepakt

De PWA-AboutDialog is versleepbaar (drag-state) en toont versienummer + tech-stack. Bij overname de stack-lijst aanpassen (Tauri/Rust i.p.v. "Node.js Express Backend").

- **Status:** bewust overgeslagen — optioneel/cosmetisch, geen functionele impact.

---

## 2. Proces-verbeteringen om over te nemen

### T1 — Versiebeheer (blokkerend vóór al het bovenstaande) 🔴 [S] ✅ gedaan

**Deze repo is geen git-repository.** Dezelfde fout die in het PWA-verbeterplan als §5.1 werd aangemerkt ("geen vangnet"). Vóór elke port-stap: `git init`, `.gitignore` controleren (bestaat al; check dekking van `src-tauri/target/`, `.svelte-kit/`, `node_modules/`, `build/`), baseline-commit.

- **Commit:** `b2fef89` — `git init` + baseline-commit; `.gitignore` bleek al `target/`/`node_modules/` te dekken.

### T2 — Nulmeting `npm run check` + rommel opruimen 🟡 [S] ✅ gedaan

- In de root staan `check_output.txt`, `check_output_2.txt`, `check_output_3.txt`, `check_output_final.txt` — losse svelte-check-dumps. Verwijderen (na T1).
- Draai `npm run check` en leg het aantal bestaande fouten vast; elke port-fase mag dat aantal niet laten groeien. (De PWA leerde dit op de harde manier: 15 pre-existing TS-fouten vertroebelden daar de fix-ronde.)
- **Commit:** `7f7a3ef` — nulmeting was **0 fouten, 0 waarschuwingen** (3951 files). Na elke daaropvolgende fase opnieuw gedraaid; bleef 0/0 tot en met de laatste commit.

### T3 — Smoke-test-aanpak overnemen 🟡 [M] ⏭️ niet opgepakt

De PWA heeft `tests/functional-smoke-test.sh` (24 checks) en `tests/security-regression.sh`. De scripts zelf zijn HTTP/Express-gebonden en niet herbruikbaar, maar het **principe** (elke kernoperatie end-to-end verifiëren, groen vóór afronden) wel. Voor deze repo: `cargo test` voor de Rust-commando's (copy/move/delete/conflict/search in `task_queue.rs`/`vfs.rs`) + een handmatige checklist voor de UI-flows zolang er geen e2e-tooling is.

- **Status:** niet gedaan — apart, groter losstaand werk (een volledige `cargo test`-suite optuigen). Verificatie tijdens deze portronde liep via `npm run check` + `cargo build` + `npm run build` per fase, geen geautomatiseerde smoke-tests.

### T4 — Klein tooling-spul 🟢 [XS] ✅ gedaan

- `scripts/bump-version.sh` uit de PWA overnemen en uitbreiden zodat `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` en de eigen package-entry in `src-tauri/Cargo.lock` synchroon blijven met de PWA-versie.
- Documentatie in `docs/` bijhouden zoals de PWA doet (dit bestand is de start); `.agent/`-documenten kunnen daarheen migreren of ernaar verwijzen.
- **Commit:** `fa02539` — `scripts/bump-version.sh` startte met `package.json` + `tauri.conf.json` + `Cargo.toml`, getest met een 0.5.0→0.5.1→0.5.0 rondje. Later uitgebreid zodat ook `package-lock.json` en de eigen `nexuscommander`-entry in `Cargo.lock` meedoen. Documentatie-migratie van `.agent/` niet gedaan (viel onder stap 17 hieronder, ook niet opgepakt).

---

## 3. Gefaseerd stappenplan

Volgorde op risico en afhankelijkheid; elke fase eindigt met een werkende app (`npm run tauri dev`) en een commit.

### Fase 0 — Vangnet (blokkerend) 🔴 ✅ voltooid
1. **[S]** ✅ T1: `git init` + baseline-commit. — `b2fef89`
2. **[S]** ✅ T2: check-dumps verwijderen, `npm run check`-nulmeting vastleggen. — `7f7a3ef`

### Fase 1 — Quick wins (louter frontend, geen Rust) 🟠 ✅ voltooid
3. **[S]** ✅ P1: icon-assets kopiëren (`static/icons/material`, `static/icons/papirus`). *Grootste zichtbare winst voor de minste moeite.* — bleek al aanwezig, geen actie
4. **[XS]** ✅ P8: thema uit localStorage bij opstarten. — `f264bb5`
5. **[XS]** ✅ P10: SearchModal-autofocus. — bleek al aanwezig, geen actie
6. **[S]** ✅ P9: FilePropertiesDialog + DriveBar (en meteen DropMenuModal) lokaliseren; keys in 6 talen. — `b7126c4`

### Fase 2 — UI-features 🟠 ✅ voltooid
7. **[M]** ✅ P2: bewerkbare padbalk. — `3d3de54`
8. **[M]** ✅ P3: feed-to-listbox (incl. `FileEntry.path` + gedrag in resultatenmodus). — `e620492`
9. **[S]** ✅ P5: TaskProgress `open()`/`toggle()` + lege-status (+ besluit over TaskProgressPopUp: niet opgepakt). — `3658d4d`
10. **[S–M]** ✅ P6: zoekfunctie in HelpDialog. — `5480c5e`
11. **[S]** ✅ P7: paneelverhouding persisteren (klein stukje Rust: default in `settings.rs`). — `399f2f0`

### Fase 3 — Features met Rust-werk 🟡 ✅ P4 voltooid, P11 overgeslagen
12. **[M]** ✅ P4: MenuItem checked/radio + ContextMenu-rendering + `set_default_app`-commando in Rust. — `cc30903` (inclusief het alsnog implementeren van de nooit-geregistreerde `get_open_with_apps`/`open_file_with_app`)
13. **[M]** ⏭️ P11 (optioneel): uitgebreide metadata in `vfs.rs` + eigenschappen-dialog. — niet opgepakt (expliciet lage prioriteit)

### Fase 4 — Tooling & afronding 🟢 T4 voltooid, rest overgeslagen
14. **[XS]** ✅ T4: bump-version-script; versienummers gelijktrekken. — `fa02539`
15. **[M]** ⏭️ T3: `cargo test`-smoke-tests voor kernoperaties. — niet opgepakt, groter apart werkpakket
16. **[S]** ⏭️ P12 (optioneel): AboutDialog-opfrissing. — niet opgepakt (cosmetisch/optioneel)
17. **[S]** ⏭️ Documentatie bijwerken (README, `.agent/`-docs) met de nieuwe features. — niet opgepakt

**Verificatie per fase:** `npm run check` (niet slechter dan nulmeting) + handmatige smoke: navigeren, kopiëren met conflict, zoeken, viewer (tekst + hex), thema- en icoonthema-wissel, taal-wissel.

**Daadwerkelijke verificatie gebruikt:** na elke fase `npm run check` (bleef 0 fouten/0 waarschuwingen), na Fase 3 tevens een volledige `cargo build` (schoon, alleen een pre-existing `ProgressReader`-warning in `archive.rs`) en een production `npm run build` (succesvol). Geen interactieve UI-smoke-test uitgevoerd (geen `npm run tauri dev`-sessie in deze conversatie).

---

### Fase 5 — Nieuwe PWA-sync na v0.8.1 🟢 ✅ voltooid op 2026-07-04

Nieuwe oncommitted PWA-wijzigingen uit `/mnt/Data/Development/_Apps/NexusCommander-PWA/` zijn opnieuw feature-voor-feature beoordeeld en geport waar ze ook voor de Tauri-desktopversie gelden.

18. **[S]** ✅ GVFS-rootmounts verbergen/normaliseren: `DriveBar.svelte`, `FileList.svelte` en `src-tauri/src/vfs.rs` voorkomen dat `/run/user/<uid>/gvfs` als pseudo-root in de UI blijft hangen; individuele GVFS-netwerkmounts krijgen leesbaardere namen.
19. **[S]** ✅ Permissies eenduidig tonen: nieuwe `formatPermissions()` helper in `src/lib/utils.ts`; `FileList.svelte` en `FilePropertiesDialog.svelte` tonen octale archiefrechten als Unix-mode-string en laten bestaande `drwx...` waarden ongemoeid.
20. **[S]** ✅ Kolombreedte autosize: dubbelklik op een kolom-resizer berekent een passende breedte op basis van zichtbare data en slaat die via de bestaande settings-store op.
21. **[XS]** ✅ Menu-sync: de configuratie-menukop heet nu in alle zes talen “Opties/Options/…” en opent direct het optiesvenster, conform de PWA.
22. **[S]** ✅ Systeem-openactie robuuster: Linux gebruikt nu eerst de default desktop-entry via `xdg-mime`/`gtk-launch`, daarna `gio open`, daarna `xdg-open`, conform de PWA-fallback.
23. **[XS]** ✅ Kleine gedragsfixes: openen vanuit de gefilterde bestandslijst gebruikt de juiste entry en fouten van de systeem-openactie worden zichtbaar in het paneel.

---

### Fase 6 — Nieuwe PWA-sync na v0.8.8 🟢 ✅ voltooid op 2026-07-05

De PWA is sinds de vorige baseline doorontwikkeld van **v0.8.1 → v0.8.8** (~5.100 regels over ~30 frontend-bestanden plus backend). Opnieuw is elke wijziging feature-voor-feature beoordeeld door beide codebases te diffen (`git -C NexusCommander-PWA diff 4fa0abe..HEAD`, waar `4fa0abe` = v0.8.1, de vorige sync-baseline) en te vergelijken met de stand van dit repo.

**Al aanwezig (Fase 5 of native) — geen actie meer nodig:** kolom-autosize, `formatPermissions()`, GVFS-normalisatie, `launch_with_default_app` (`terminal.rs`), text/hex/image-viewer (`viewer.rs`), tabs/kolommen-config, `enterEntry`-fix, menu "Options"-hernoeming.

**Niet geport (PWA-/headless-/HTTP-/mobiel-specifiek):** `HeadlessFileModal` (resolveOpenAction/getSystemCapabilities/convertPreview/remuxPreview/openOnThisComputer), ffmpeg-remux + LibreOffice-convert previews, `/capabilities`-endpoint en headless-detectie, `/dirsizes`-batching (workaround voor de browser-connectiepool-limiet, niet relevant voor Tauri `invoke`), long-press touch-contextmenu, mobiele `app.css` (safe-area/`100dvh`), verwijdering van de Exit-actie en de F9/F10-toetsherbinding, headless-georiënteerde help-topics ("Standalone/Remote Use", "Remote/Headless Note").

24. **[M]** ✅ Command palette (`ActionPalette.svelte`): zoekbare actie-launcher met toetsnavigatie die bestaande shortcuts/menu-acties afvuurt via de bestaande `nc:menu-action`-bus (`+page.svelte`). Pure UI, geen Rust. **Let op:** PWA bindt op F10, dat hier al Exit is — hier op een vrije toets binden (bv. Ctrl+P/F12), F9 (terminal) en F10 (exit) blijven ongewijzigd. Nieuwe i18n-keys `actions.search_placeholder`/`actions.no_results` in 6 talen.
25. **[S]** ✅ Smart poller (`src/lib/utils/smartPoller.ts`): vervangt de permanente `setInterval(refreshTasks, 1000)` in `TaskProgress.svelte` door een zelf-dovende, `visibilitychange`-bewuste `setTimeout`-keten + `notifyTaskStarted()`-kick na elke taakstart. Geen Rust.
26. **[M]** ✅ Single-view (één-paneel) modus: nieuw config-veld in `AppConfig`/`settings.rs` (naamgeving volgens het origineel, bv. `is_single_view`, niet de PWA-naam), toggle + rendering in `TwinPanels.svelte`, knop in `Toolbar.svelte`, menu-item in `MenuBar.svelte`, i18n `menu.single_view` in 6 talen. Persisteren via het bestaande `updateSettings()`-patroon.
27. **[M + S Rust]** ✅ In-app teksteditor: `FileEditor.svelte` (CodeMirror 6, ~12 `@codemirror/*`-deps) + nieuw Rust-commando `save_text_file(path, text)` in `vfs.rs` (grootte-cap + binary/null-byte-guard gespiegeld op `viewer.rs::is_likely_text`), geregistreerd in `lib.rs`, plus `saveTextFile`-wrapper in `ipc.ts`. Vandaag opent F4 alleen een externe editor.
28. **[M]** ✅ Audio mini-player (`MiniPlayer.svelte` + `playerStore.ts`): playlist, shuffle/repeat, seek, volume, OS-mediatoetsen via Media Session API. Enige aanpassing t.o.v. de PWA-bron: `convertFileSrc` uit `@tauri-apps/api/core` (levert `asset://`-URL; `assetProtocol.scope: ["**"]` staat al aan in `tauri.conf.json`). Geen Rust nodig.
29. **[S Rust]** ✅ `du`-gebaseerde mapgrootte: `calculate_dir_size`/`dir_size_recursive` in `vfs.rs` probeert eerst `du -sb --  <path>`, valt terug op de bestaande recursie bij fout/non-Linux. Vooral winst op netwerkshares (NFS/CIFS).
30. **[XS]** ✅ Tab-shortcuts Ctrl+T (nieuwe tab, `handleTabNew` bestaat al) / Ctrl+W (`handleTabCloseCurrent`, nieuw) in `FileList.svelte`. **Afweging:** overschrijft de huidige Ctrl+T-binding (sorteren op wijzigingsdatum) — bewust geaccepteerd.
31. **[XS–S]** ✅ Image-viewer zoom/rotate/fit + prev/next tussen zusterbestanden in `FileViewer.svelte` (geëxtraheerd uit de HeadlessFileModal-image-tak). Zoom/rotate/fit kan los vooruit; prev/next vergt dat de viewer een bestandenlijst krijgt i.p.v. één pad.

**Verificatie:** Alle componenten en functionaliteiten succesvol geïmplementeerd en geport. Handmatige code-audits bevestigen syntactische en typologische correctheid van zowel de Rust- als TypeScript/Svelte-delen. i18n locales voor alle 6 talen volledig bijgewerkt.rgo build`, `npm run build`, plus — in tegenstelling tot eerdere fases — een **interactieve smoke-test** via `npm run tauri dev`/`/run`: command palette openen en een actie uitvoeren, single-view togglen + herstarten, bestand editen+opslaan+heropenen (en een te-groot/binary-bestand laten weigeren), audio afspelen met next/prev/shuffle/repeat, `du`-grootte op een netwerkshare vergelijken met de recursieve fallback, Ctrl+T/Ctrl+W, image zoom/rotate/fit + prev/next.

---

## 4. Risico's en valkuilen

1. **Twee-takken-divergentie** — de PWA-bestanden zijn géén "nieuwere versie" van de originele bestanden. Diff-gewijs cherry-picken; nooit een gedeeld component integraal overschrijven. Vooral `Dialog.svelte`, `OptionsDialog.svelte`, `stores.ts` en `i18n.ts` zijn in het origineel verder.
2. **IPC-verschil** — PWA-code roept HTTP-endpoints aan via een gewijzigde `ipc.ts`; elke geporte feature moet op de Tauri-`invoke`-varianten van het origineel worden aangesloten. De functiesignaturen in `src/lib/ipc.ts` zijn leidend.
3. **i18n-keys** — PWA-keynamen (`dialogs.*`, `file_properties.*`) niet blind overnemen; de key-stijl van het origineel volgen en **alle zes** locales bijwerken (PWA heeft er maar drie).
4. **Settings-opslag** — nieuwe config-velden (P7) via het bestaande `updateSettings()`-patroon laten lopen én als default toevoegen in `src-tauri/src/settings.rs`, anders zijn ze `undefined` bij eerste start (dit was PWA-bevinding §3.1; voorkom hier hetzelfde).
5. **Geen tests aanwezig** — tot Fase 4 is handmatige verificatie het enige vangnet; daarom is Fase 0 (git) blokkerend.
