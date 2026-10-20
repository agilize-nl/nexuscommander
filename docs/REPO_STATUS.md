# Repostatus en implementatiedoel

**Vastgesteld:** 2026-07-28
**Uitvoering van:** P0.0 uit `COMPREHENSIVE_QUALITY_SAFETY_UPGRADE_PLAN_2026-07-28.md`
**Hoort bij:** `NEXUS_MIGRATIEPLAN_MONOREPO_2026-07-23.md` (Fase 9)

## Beslissing

**Deze monorepo (`_Apps/NexusCommander`) is het implementatiedoel.** Alle
verdere ontwikkeling aan zowel de desktop- als de web-shell gebeurt hier.

**De voormalige losse desktop-repo is bevroren.** Daar worden geen
releases meer gemaakt en geen functionele wijzigingen meer gecommit. De repo
blijft bestaan als historische referentie tot de reconciliatie hieronder klaar
is, daarna wordt hij gearchiveerd (read-only).

### Waarom dit vastgelegd moest worden

Na de monorepo-snapshot is er in de oude repo dóórontwikkeld tot en met release
v0.8.34 (2026-07-28, 3.168 toegevoegde regels over 40 bestanden). Tegelijk liep
de monorepo vooruit met Fases 3–7. De drift was dus tweerichtings en groeide bij
elke release. Zonder een vastgelegd doel wordt elke volgende release een tweede
merge die iemand met de hand moet doen.

## Wat is al gereconcilieerd (2026-07-28)

De Rust-backend en de locales zijn samengevoegd via een 3-way merge met
legacy 0.8.33 (`a5e0a4f`) als basis.

| Bestand | Uitkomst |
|---|---|
| `open_with.rs`, `task_queue.rs`, `help.rs` | Schoon gemerged, geen conflict |
| `lib.rs` | Eén schijnconflict — beide kanten voegden op dezelfde plek verschillende code toe; beide behouden |
| `vfs.rs` | Twee conflicten, beide alleen commentaartekst — de code was al identiek |
| `terminal.rs`, `archive.rs`, `settings.rs`, `search.rs` | Ongewijzigd aan beide kanten |

Overgenomen uit 0.8.34: `task_pause`/`task_resume`-commando's, `read_directory`
en `calculate_dir_size` asynchroon via `spawn_blocking`, `theme_startup_color` /
`native_window_theme`, `install_gtk_noise_filter`, de venster-reveal-fallback,
owner/group-caching en symlink-bewuste `dir_size_recursive` in `vfs.rs`.

Behouden uit de monorepo: de `cfg(unix)`-gating met Windows-stubs voor
`restart_as_root` en `is_running_as_root`.

`glib` is teruggezet als directe Linux-dependency, omdat
`install_gtk_noise_filter()` hem nodig heeft. Zie QSF-019: dit is het enige
directe gebruik, dus het schrappen van die filter verwijdert de dependency
volledig. Dat is een productbeslissing, geen mergebeslissing — daarom nu
overgenomen zoals hij was.

**Verificatie:** `cargo check` groen, `cargo test` 26/26, commandoset uitgebreid
met `task_pause`/`task_resume` en niets verloren uit 0.8.34.

Locales: de negen keys die 0.8.34 toevoegde zijn overgenomen in
`packages/ui/src/lib/locales/`, inclusief vertalingen voor de/es/fr/pt die daar
nooit gemaakt waren. Vijf ervan zijn de enkelvoudsvormen van de verwijder-,
kopieer- en verplaatsbevestigingen — een ontbrekende key in een destructieve
bevestiging is een echt risico, geen cosmetisch gat. De locale-check is groen en
er is geverifieerd dat hij faalt op een verwijderde key.

## Svelte-reconciliatie (2026-07-28) — ✅ afgerond

Dit was het echte resterende werk en van Fase 3/4-omvang — geen mechanische
merge. v0.8.34 raakte twaalf componenten die inmiddels gedeeld zijn en waarvan
de monorepo-versie uit de PWA-kant komt. Alle twaalf zijn nu per bestand
doorgenomen (beide versies volledig gelezen, niet alleen gedifft) en waar nodig
gereconcilieerd, telkens geverifieerd met `npm run check` (0 errors, locales in
sync) en gecommit per bestand.

| Component | Locatie | Verschilregels | Uitkomst |
|---|---|---|---|
| `FileList` | ui | 1944 | ✅ **grootste klus** — geen wholesale merge (monorepo was al verder), maar vijf losse fixes na een volledige diff-lezing: config-keys die alleen web's `layout_*`-naamgeving lazen en op desktop dus altijd de default gebruikten (parent-dir-row, folder-brackets, per-paneel view-mode-restore — alle drie stille no-ops op desktop), `show_file_sizes_in_bytes` nergens meer gebruikt, View/Edit kwijt uit het rechtsklikmenu, Shift+Delete deed niet meer aan permanent verwijderen, een periodieke stale-pad/ejected-drive-check die geheel verdwenen was (gevonden omdat hij als geneste arrow-function niet in de eerste functienaam-scan zat), en een handvol i18n-regressies (statusbalk, pad-contextmenu, leeg/laad/fout-staat, symlink-tooltip) |
| `TaskProgress` | ui | 834 | ✅ legacy's modal+dockbar-ontwerp overgenomen (pause/resume, view-all-lijst, conflict-overlay), volledig ge-i18n't, monorepo's auto-clear-van-voltooide-taken behouden |
| `OptionsDialog` | ui | 346 | ✅ props-architectuur (appConfig/onapply, iconPreview-injectie, showSavedViews) was al verder; hersteld: `.btn`/`.btn.theme-btn` waren teruggezakt naar hardcoded hex + `:global(.dark)` — een styling-regel-schending mét een echt hover-bugje erbij |
| `DropMenuModal` | ui | 347 | ✅ legacy's volledige visuele redesign overgenomen (breder, backdrop-blur, doorgevoerde `--color-nc-*`-theming i.p.v. hardcoded hex/`:global(.dark)`); enkelvoud "1 item to:" hersteld, `drop_menu.*`-namespace consistent getrokken |
| `TwinPanels` | ui | 312 | ✅ pointer-drag, responsive/portrait-split en de layout/onpersistlayout-prop-seam waren al verder; hersteld: `quickviewSide`-tracking, anders kon het paneel na focus-drift in twee quickviews tegelijk eindigen |
| `Dialog` | ui | 263 | ✅ archiefbewustzijn en de permission_denied/sudo_password-elevatieflow waren al verder; enkelvoudsvormen voor verwijder/kopieer/verplaats-bevestigingen alsnog aangesloten (de locale-keys stonden er al sinds de eerste Fase 9-commit, nooit aangeroepen) |
| `MenuBar` | ui | 187 | ✅ geverifieerd — showExit/showElevate/showStubTools-seams en de unified action-dispatch waren al volledig bedraad in beide shells, geen wijziging nodig |
| `Toolbar` | ui | 184 | ✅ geverifieerd — `act()`-dispatchpatroon (Fase 3b-bevinding #5) en showUpload/showExit-seams waren al volledig ahead, geen wijziging nodig |
| `FolderTabs` | ui | 159 | ✅ geverifieerd — i18n, long-press-touch-support en `--color-nc-*`-theming waren al volledig ahead, geen wijziging nodig |
| `FilePropertiesDialog` | ui | 113 | ✅ **niet écht geconvergeerd** — bij het uitlezen bleken er bugs aan beide kanten: `permissionsToOctal()` (desktop's backend levert een symbolische string, geen octaal) en de allowExecuteAsProgram-sync waren gesneuveld in de monorepo-kant; de monorepo-kant had wél terecht `getIpc()`-capability-detectie en de `onpermissiondenied`-seam die legacy nooit kreeg. Beide kanten samengevoegd |
| `TextEditorModal` | desktop | 94 | ✅ legacy wholesale overgenomen — apart loadError/saveError (een save-fout toonde voorheen het "kon niet laden"-scherm en het ongesaved werk was onbereikbaar), Cmd+S, en de foutieve Save-knoplabel-fallback (`drop_menu.merge`) gefixed |
| `FileEditor` | ui | 88 | ✅ legacy wholesale overgenomen — themabewuste syntax-highlighting via `--color-nc-*` i.p.v. hardcoded hex; blootgelegde een bestaand gat in `apps/web/src/app.css` (`--font-editor-*`/`--font-viewer-*` ontbraken daar helemaal, alleen desktop had ze) |

## Shell-reconciliatie (2026-07-29) — ✅ afgerond

De tabel hierboven dekte alleen de *componenten*. De niet-component-bestanden
stonden eronder als "nog niet gedaan", waardoor de sectie als geheel ✅ leek
terwijl het merendeel van wat 0.8.34 zichtbaar toevoegde daar juist in zat. Dat
gat is nu gedicht.

| Onderdeel | Bestanden | Uitkomst |
|---|---|---|
| Opstart-thema en window-reveal | `app.html`, `+page.svelte`, `tauri.conf.json`, `capabilities/default.json` | ✅ De Rust-helft (`theme_startup_color`, `native_window_theme`, reveal-fallback) was in de eerste Fase 9-commit al overgenomen maar werd door niemand aangeroepen — dode code. Nu compleet: `app.html` zet `data-theme` + `--nc-startup-bg` vóór de eerste paint, `setWindowStartupColor()`/`revealWindow()` tonen het venster pas nadat thema én taal geverfd zijn, en `visible: false` staat terug. Drie `core:window:*`-permissies waren nodig; zonder die had `show()` stil gefaald en was het venster 8 seconden onzichtbaar gebleven tot de Rust-fallback |
| Webfonts | `app.html` | ✅ De Google-Fonts-`<link>` is eruit (zoals in 0.8.34). Inter/JetBrains Mono komen uit de `--font-family-*`-stacks; een koude start hangt niet meer aan het netwerk |
| Tab- en drivebalk-theming | `apps/desktop/src/app.css`, `apps/web/src/app.css` | ✅ 0.8.34 voegde `--color-nc-tab-*`/`--color-nc-drive-*` toe voor alle 11 thema's. Desktop had er 6 (de vijf lichte thema's ontbraken), web had er **0**. Beide staan nu op 11/11 |
| `readDirectory`/`getDrives` coalescing | `apps/desktop/src/lib/ipc.ts` | ✅ In-flight-dedup per pad en een 1s-drivescache overgenomen |
| Koude-start-CSS | `apps/desktop/vite.config.js` | ✅ `coldSvelteStyleFallback` overgenomen, maar **niet letterlijk**: legacy hashte met `path.relative(root, file)`, wat voor het gesymlinkte `packages/ui` buiten de root `/../../packages/…` oplevert en elk gedeeld component een scope-class zou geven die z'n markup nooit krijgt. Vervangen door de `stripRoot`-semantiek van vite-plugin-svelte zelf, en geverifieerd tegen diens eigen `safeBase64Hash`/`normalize` voor paden binnen én buiten de root |
| `FileList` — restant | ui | ✅ Drie dingen die de componenttabel miste: het `..`-contextmenu (alleen Open + Refresh; anders staan Copy/Move/Delete/Rename op de bovenliggende map), de `..`-filter in `getOperationEntries()` (F5/F6/F8 met de cursor op `..` bouwden hun padlijst uit die rij), en de "Internal Editor"-entry die de Open-with-submenu ook vult als er geen enkele xdg-app gevonden wordt |
| `MenuBar` — FTP-stubs | ui | ✅ Regressie de andere kant op: 0.8.34 verwijderde de drie dode, onvertaalde FTP-items; de monorepo had ze achter `showStubTools` teruggezet. Nu weg. `showStubTools` blijft bestaan voor history/sync-panels |

`theme.ts` (localStorage-persistentie), `types.ts` (`created`/`accessed`/
`changed` — die staan in `ipc-contract.ts`, de per-app-kopieën zijn dood) en
`postcss.config.js` (alleen quote-stijl) bleken bij nalezing geen achterstand te
hebben.

**Verificatie:** `npm run check` 0 errors in beide apps, locales in sync (en
geverifieerd dat de check rood wordt op de nieuwe key), `cargo check` groen,
`cargo test` 26/26, `npm run build` groen voor beide shells. In de gebouwde
desktop-output is gecontroleerd dat het opstartscript meekomt en dat er geen
`fonts.googleapis`-verwijzing meer in zit.

**Blokkeur:** de visuele regressietest (Fase 9.1) kan niet headless en is een
handmatige checkpoint van de gebruiker. Dat is ook de enige nog openstaande
acceptatie van Fases 3, 4 en 6.

## Versies

Alle workspaces staan op `0.9.0-dev`, gelijk aan root en `packages/ui`.
Bewust géén `0.9.0`: dat is een releaseversie en er is nog niets vrijgegeven.
Zie QSF-021 — versie bumpen vóór validatie is precies het patroon dat de oude
`deploy.sh` fout deed.

`apps/desktop/scripts/bump-version.sh` controleert nu zijn eigen werk en faalt
als één van de versieplekken achterblijft. De vensternaam in `tauri.conf.json`
is de enige bron voor de zichtbare versie; `app.html` draagt er bewust geen meer
(die kopie bleef vijf releases op v0.8.29 staan).

## Volgende stappen

1. ~~Svelte-reconciliatie per bestand volgens de tabel hierboven.~~ ✅ afgerond
   2026-07-28. ~~Shell-bestanden (`app.html`, `+page.svelte`, `ipc.ts`,
   `vite.config.js`, `app.css`).~~ ✅ afgerond 2026-07-29.
2. Visuele regressietest — handmatige checkpoint gebruiker (Fase 9.1). Dit is
   nu de enige blokkeur voor cutover. Let bij die test specifiek op de vijf
   lichte thema's (tab-/drivebalk waren daar ongethematiseerd) en op de
   opstartsequentie: het venster hoort pas zichtbaar te worden als het opgeslagen
   thema en de taal al staan, niet ervoor.
3. Windows echt verifiëren: `gcc-mingw-w64-x86-64`, dan
   `cargo check --target x86_64-pc-windows-gnu`.
4. Opruimen: `help.rs` compileert nog maar wordt niet meer aangeroepen sinds de
   markdown gebundeld wordt.
5. Oude repo archiveren (read-only op Forgejo) — pas ná stap 2.
6. Daarna pas: Fase 1 van het QSF-plan (de veilige mutatie-engine).
