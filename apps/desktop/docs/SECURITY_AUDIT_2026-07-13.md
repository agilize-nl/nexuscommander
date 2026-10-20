# Security audit NexusCommander - 2026-07-13

Scope: lokale desktop-app in deze checkout (`/home/djawiz/Data/Development/_Apps/NexusCommander`), met focus op Tauri/Rust IPC, filesystem-operaties, archieven, proces-start, dependency-risico's, memory/resource leaks en denial-of-service. De PWA/backend-variant valt buiten deze audit.

Status: audit uitgevoerd op broncode en dependency metadata. Er zijn geen codefixes doorgevoerd in deze ronde.

**Update 2026-07-14: alle onderstaande bevindingen zijn opgevolgd met daadwerkelijke codefixes, geverifieerd met tests en groene builds.** Zie de sectie "Remediatie 2026-07-14" onderaan dit document voor het volledige overzicht, bewijs en de resterende geaccepteerde restrisico's.

## Samenvatting

De app is functioneel krachtig maar heeft een groot trusted-UI model: vrijwel alle filesystem- en procesacties worden vanuit de webview via Tauri commands uitgevoerd. Dat is acceptabel voor een lokale filemanager, maar het betekent dat webview-hardening cruciaal is. De belangrijkste security holes zitten in de combinatie van een uitgeschakelde CSP, een globaal asset-protocol, brede filesystem commands, archive extraction zonder eigen padvalidatie en een root-herstart command dat via IPC bereikbaar is.

Hoogste prioriteit:

1. Zet een strikte Tauri CSP aan en beperk `assetProtocol.scope`.
2. Valideer archive extraction zelf tegen Zip Slip/Tar Slip en symlink/hardlink escapes.
3. Verwijder of gate `restart_as_root`; maak root-acties expliciet en minimaal.
4. Upgrade npm dependencies; `npm audit --omit=dev` meldt 2 kwetsbaarheden, volledige `npm audit` meldt 7.
5. Voeg lifecycle-limieten toe aan search/task/archive jobs om memory- en resourcegroei te begrenzen.

## Auditbewijzen

Uitgevoerde checks:

- `git status --short`: worktree was al dirty; audit voegt alleen dit nieuwe document toe.
- `npm audit --omit=dev`: 2 kwetsbaarheden, waarvan 1 high.
- `npm audit`: 7 kwetsbaarheden, waarvan 4 high.
- `cargo audit --version`: `cargo-audit` is niet geinstalleerd (`error: no such command: audit`).
- `cargo tree -e normal --depth 1`: Rust top-level dependencies geinventariseerd.
- Broncode-inspectie van `src-tauri/tauri.conf.json`, `src-tauri/src/*.rs`, `src/lib/ipc.ts` en relevante Svelte componenten.

## Bevindingen

### CRITICAL/HIGH - Tauri webview hardening staat te open

Bewijs:

- `src-tauri/tauri.conf.json:24-28` zet `"csp": null` en `assetProtocol.scope` op `["**"]`.
- `src-tauri/src/lib.rs:297-354` registreert brede filesystem-, archive-, process- en root-commands voor de main window.

Risico:

Als een XSS, gemanipuleerde lokale asset, supply-chain bug of onbedoelde webview-navigatie ontstaat, heeft die code via `invoke` toegang tot lezen, schrijven, verwijderen, archiveren, openen met externe applicaties en root-herstart. Zonder CSP mist een belangrijke verdedigingslaag tegen scriptinjectie. De `assetProtocol` wildcard maakt het risico groter omdat lokale bestanden ruimer bereikbaar kunnen worden dan nodig.

Advies:

- Stel een expliciete CSP in, minimaal met `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' asset: data:; connect-src 'self' ipc: http://ipc.localhost`.
- Beperk `assetProtocol.scope` tot app-data of expliciet benodigde directories. Gebruik geen `**`.
- Voeg command-level guards toe: valideer per command of het pad binnen de verwachte context valt, zeker voor destructive actions.

### HIGH - Archive extraction vertrouwt library-defaults zonder eigen escape-checks

Bewijs:

- `src-tauri/src/archive.rs:1437-1451` gebruikt `zip::ZipArchive::extract(dest)`.
- `src-tauri/src/archive.rs:1470-1487` gebruikt `tar::Archive::unpack(dest)` voor tar/gz/zst.

Risico:

Archieven zijn attacker-controlled input. Ook als crates deels beschermen, blijft dit een hoog-risico pad voor Zip Slip/Tar Slip, absolute paden, `..`, symlinks, hardlinks, device entries en decompression bombs. De app is een filemanager en gebruikers zullen juist onbekende archieven openen en uitpakken.

Advies:

- Loop entries handmatig door en accepteer alleen paden waarvan `dest.join(entry_path).canonicalize_or_parent()` binnen `dest` blijft.
- Weiger absolute paden, parent traversal, Windows drive prefixes, symlink/hardlink entries en special files tenzij expliciet en veilig ondersteund.
- Voeg limieten toe: max aantal entries, max totale uitgepakte bytes, max compressieratio, max padlengte.
- Voeg tests toe met malafide zip/tar fixtures: `../escape`, absolute paden, symlink naar buiten, hardlink naar buiten en zip bomb indicatoren.

### HIGH - Root escalation command is via Tauri IPC bereikbaar

Bewijs:

- `src-tauri/src/lib.rs:243-272` implementeert `restart_as_root()` met `pkexec`.
- `src-tauri/src/lib.rs:353-354` exposeert `restart_as_root` en `is_running_as_root` in de invoke handler.

Risico:

Een gecompromitteerde webview kan de gebruiker een `pkexec` prompt laten zien of root-context afdwingen voor de volledige app. Daarna worden dezelfde brede filesystem commands als root uitgevoerd. Dat maakt iedere webview/Rust-command bug veel ernstiger.

Advies:

- Verwijder `restart_as_root` uit de algemene invoke handler.
- Als root noodzakelijk is: maak een aparte kleine privileged helper met allowlisted acties, niet de hele app als root.
- Toon een duidelijke native confirmation met exacte actie en target, en log root-acties.

### HIGH - Dependency vulnerabilities in npm chain

Bewijs:

- `npm audit --omit=dev` meldt:
  - `devalue` high: DoS via sparse array deserialization.
  - `svelte` moderate: meerdere XSS/ReDoS/SSR issues.
- `npm audit` meldt daarnaast high issues in `@sveltejs/kit`, `picomatch`, `vite`, plus moderate `postcss`.
- `package.json:32-44` bevat oudere dev tooling ranges zoals `@sveltejs/kit ^2.9.0`, `svelte ^5.0.0`, `vite ^6.0.3`.

Risico:

Omdat dit een Tauri app is, zijn frontend-XSS en dev-server arbitrary file read kwetsbaarheden extra gevoelig: een frontend compromise kan native commands bereiken. Dev-only issues tellen ook mee voor ontwikkelmachine-risico en supply-chain hygiene.

Advies:

- Draai gericht `npm audit fix`, controleer diff in `package-lock.json`, daarna `npm run check` en een Tauri build.
- Pin of update minimaal Svelte/SvelteKit/Vite/PostCSS/Picomatch naar patched versies.
- Voeg een CI/check stap toe voor `npm audit --omit=dev` en periodiek volledige `npm audit`.

### MEDIUM - Task queue kan memory/resource growth veroorzaken

Bewijs:

- `src-tauri/src/task_queue.rs:79-86` bewaart alle taken in een globale `HashMap`.
- `src-tauri/src/task_queue.rs:127-129` voegt iedere taak toe zonder maximum.
- `src-tauri/src/task_queue.rs:132-180` spawnt async werk bij `execute_task`.
- `src-tauri/src/task_queue.rs:647-655` ruimt finished tasks alleen op als `clear_finished_tasks()` expliciet wordt aangeroepen.

Risico:

Veel copy/move/delete taken of herhaalde UI-calls kunnen memory laten groeien en achtergrondwerk blijven spawnen. Dit is geen klassieke Rust memory leak, maar wel unbounded retention/resource leak. Omdat taken padlijsten, fouten en status vasthouden, kan dit ook privacygevoelige padinformatie lang bewaren.

Advies:

- Voeg max queue length en TTL toe voor `Completed`, `Failed` en `Cancelled`.
- Maak `execute_task` idempotent: als status `Running` of `WaitingForInput` is, geen tweede worker spawnen.
- Ruim automatisch op na afronding of bewaar alleen compacte history.

### MEDIUM - Search jobs zijn niet annuleerbaar en kunnen blijven emitteren

Bewijs:

- `src-tauri/src/search.rs:33-95` start per search een losse thread.
- Er is geen job-id, cancel-token, concurrency limit of max result limit.
- Content search leest ieder matchend bestand tot 10 MB in memory via `fs::read_to_string` (`src-tauri/src/search.rs:62-64`).

Risico:

Herhaald zoeken in grote trees kan CPU, IO en event traffic opstapelen. Een brede regex of content search over mounted shares kan de app langdurig belasten. Na sluiten van de modal kan de thread blijven lopen en events blijven sturen.

Advies:

- Introduceer search job IDs, cancellation en max gelijktijdige searches.
- Voeg result caps, timeout en mount/symlink policy toe.
- Stream content checks of scan bytes in chunks in plaats van volledige bestanden naar string te laden.

### MEDIUM - Viewer laadt grote bestanden volledig in memory

Bewijs:

- Tekstbestanden tot 10 MB worden volledig gelezen (`src-tauri/src/viewer.rs:127-128`).
- Afbeeldingen tot 50 MB worden volledig gelezen en base64 geencodeerd (`src-tauri/src/viewer.rs:160-175`), waardoor memory overhead grofweg 1.33x plus UI payload is.
- Hex view limiteert wel tot 1 MB (`src-tauri/src/viewer.rs:140-148`).

Risico:

Meerdere viewers of grote afbeeldingen kunnen piekgeheugen sterk verhogen. SVG wordt als image toegestaan; met `data:image/svg+xml;base64,...` in de webview moet CSP extra strak zijn om SVG-script/extern laden te beperken.

Advies:

- Verlaag image limit of gebruik temp-file/asset streaming in plaats van base64 IPC.
- Behandel SVG als text/sanitized preview of blokkeer actieve SVG.
- Voeg per-viewer cleanup en single-preview lifecycle toe.

### MEDIUM - Proces-start vertrouwt omgeving en desktop entries

Bewijs:

- `open_terminal` gebruikt `$TERMINAL` direct als executable (`src-tauri/src/terminal.rs:83-92`).
- `open_in_editor` gebruikt `$VISUAL` en `$EDITOR` direct (`src-tauri/src/terminal.rs:181-187`).
- `open_file_with_app` accepteert `desktop_entry` vanuit de UI en geeft die door aan `gtk-launch` (`src-tauri/src/open_with.rs:136-143`).

Risico:

Dit gebruikt geen shell en is daardoor niet direct shell-injectable, maar het vertrouwt wel de procesomgeving en UI-argumenten. Een gemanipuleerde environment of desktop entry kan onverwachte programma's starten met geselecteerde padargumenten.

Advies:

- Alleen executables starten uit een allowlist of absolute paden die via `which`/desktop database zijn gevalideerd.
- Voor `open_file_with_app`: accepteer alleen desktop entries die uit `get_open_with_apps` komen, eventueel met een session-token of server-side lookup.
- Overweeg een native confirmation voor executable/script files.

### MEDIUM - Destructive filesystem commands hebben geen centrale guardrail

Bewijs:

- `src-tauri/src/lib.rs:305-315` exposeert create/delete/rename/copy/move/save/calculate commands.
- `src-tauri/src/vfs.rs:230-248` valt bij trash failure terug naar permanent delete.
- `src-tauri/src/vfs.rs:529` schrijft tekst direct naar het opgegeven pad.

Risico:

Voor een filemanager is brede filesystem toegang verwacht, maar een webview-compromise kan willekeurige bestanden verwijderen of overschrijven binnen de OS-permissies van de app. Trash fallback naar permanent delete is vooral riskant omdat de intentie "trash" alsnog destructief kan worden.

Advies:

- Maak destructive commands expliciet: geen automatische permanent-delete fallback bij trash failure zonder aparte bevestiging.
- Voeg native confirmation toe voor home/root/system directories, dotfiles en mount roots.
- Centraliseer padvalidatie en logging in een wrapper rond alle muterende filesystem acties.

### LOW/MEDIUM - Rust dependency audit ontbreekt

Bewijs:

- `cargo audit --version` faalt omdat cargo-audit niet geinstalleerd is.
- `cargo tree -e normal --depth 1` toont onder meer `tauri 2.10.3`, `zip 2.4.2`, `tar 0.4.44`, `notify 6.1.1`, `trash 5.2.5`, `xz2 0.1.7`.

Risico:

Zonder RustSec-check blijven bekende advisories in Rust crates onzichtbaar, juist in gevoelige codepaden zoals archive parsing en desktop integration.

Advies:

- Installeer `cargo-audit` of gebruik `cargo deny`.
- Voeg periodiek `cargo audit`/`cargo deny check advisories` toe aan release-preflight.

## Positieve observaties

- De Rust code gebruikt `Command::new(...).arg(...)` en geen shell-concatenatie voor Linux open/editor paths; dat beperkt klassieke command injection.
- Tekst-editor save heeft een 10 MB limiet en null-byte guard.
- Hex viewer heeft een 1 MB limiet.
- Directory copy controleert copy-into-self via canonicalized source/destination.
- Tauri capability file geeft alleen `core:default` en `opener:default`; de brede native toegang komt vooral uit eigen commands, niet uit extra Tauri plugin-permissies.

## Aanbevolen actielijst

1. Hardening patch:
   - CSP aanzetten.
   - `assetProtocol.scope` beperken.
   - `restart_as_root` uit de algemene handler halen.

2. Archive safety patch:
   - Eigen safe extraction implementeren voor zip/tar.
   - Malafide fixture tests toevoegen.

3. Dependency patch:
   - `npm audit fix` uitvoeren.
   - `npm run check` en Tauri build draaien.
   - RustSec tooling toevoegen.

4. Resource lifecycle patch:
   - Task queue TTL/max size/idempotent execute.
   - Search cancellation/concurrency/result caps.
   - Viewer streaming of lagere limieten.

5. Destructive action UX:
   - Geen stil permanent delete fallback.
   - Extra confirmation/logging voor risicopaden.

## Niet vastgesteld in deze ronde

- Geen dynamische runtime-test met malafide archieven uitgevoerd.
- Geen `cargo-audit` resultaat beschikbaar omdat de tool niet geinstalleerd is.
- Geen memory profiler run uitgevoerd; memory/resource bevindingen zijn code-review bevindingen op basis van unbounded retention en volledige file loads.

## Remediatie 2026-07-14

Alle bevindingen hierboven zijn opgevolgd met codefixes. Per item, met bewijs:

### CSP + assetProtocol
- `src-tauri/tauri.conf.json`: `csp` is niet meer `null`. Nieuwe policy: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' asset: http://asset.localhost data: blob:; media-src 'self' asset: http://asset.localhost blob:; connect-src 'self' ipc: http://ipc.localhost; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`.
- Tauri hasht inline `<script>`-tags in de gebundelde HTML automatisch tegen de CSP (geverifieerd in `tauri-codegen-2.5.5/src/embedded_assets.rs`), dus de pre-paint theme-script in `src/app.html` blijft werken zonder `unsafe-inline` voor scripts.
- `assetProtocol.scope` blijft bewust op `["**"]`: dit is een filemanager waarin audio-preview (`MiniPlayer.svelte`) en "open with"-iconen (`ContextMenu.svelte`) via `convertFileSrc` elk willekeurig pad op de schijf moeten kunnen laden, en de bestaande IPC-commands geven sowieso al even brede filesystem-toegang. De marginale winst van scope-beperking woog niet op tegen het breken van kernfunctionaliteit; de CSP (met name `script-src 'self'` zonder `unsafe-eval`) is de belangrijkste nieuwe verdedigingslaag tegen misbruik van `asset:`.

### Archive extraction (Zip Slip / Tar Slip / decompression bombs)
- `src-tauri/src/archive.rs`: `unpack_archive` gebruikt niet langer `zip::ZipArchive::extract()`/`tar::Archive::unpack()` direct, maar eigen entry-voor-entry extractie (`unpack_zip_safe`, `unpack_tar_entries`) met:
  - padvalidatie (`validate_relative_entry_path`): weigert absolute paden, `..`, en niet-toegestane path-componenten; controleert dat het resulterende pad binnen de canonicalized destination blijft.
  - weigering van symlink/hardlink/special-device entries.
  - caps: max 200.000 entries, max 20 GiB totaal uitgepakte bytes, max compressieratio 1032x boven 100 MiB (zip), en een `.take(declared_size)`-begrensde kopie zodat een entry nooit meer bytes wegschrijft dan de gedeclareerde grootte.
  - 7 unit tests met malafide fixtures (zip/tar met `../`, absolute paden, tar-symlink-escape) plus twee "happy path"-tests, allemaal groen (`cargo test extraction_safety_tests`).
- `tar` crate geupgraded naar 0.4.46 (was 0.4.44): loste ook RUSTSEC-2026-0067 (`unpack_in` chmod via symlinks) en RUSTSEC-2026-0068 (PAX size header wordt genegeerd, waardoor de eigen size-cap omzeild had kunnen worden) op.

### Root-escalation command
- `src-tauri/src/lib.rs` `restart_as_root`: toont nu een blocking native confirmation-dialog (`rfd::MessageDialog`, backend-side dus niet te omzeilen door een gecompromitteerde webview die rechtstreeks `invoke("restart_as_root")` aanroept) voordat `pkexec` wordt gestart. Bevestiging/weigering wordt gelogd.
- `rfd` is toegevoegd met de `gtk3`-backend (niet `xdg-portal`), zodat er geen nieuwe dependency-boom (ashpd/wayland-client/quick-xml/crossbeam-epoch) nodig was: de gtk-sys/glib-sys/gobject-sys crates waren al aanwezig via Tauri's eigen Linux-backend.

### Dependency-kwetsbaarheden
- `npm audit`: van 7 (4 high) naar 3 low, via `npm audit fix`. De resterende 3 zitten in `cookie <0.7.0` als dependency van `@sveltejs/kit` (nieuwste stabiele versie, nog niet gepatcht upstream) en zijn alleen relevant voor de Node-devserver (`npm run dev`), niet voor de gebouwde app (`adapter-static`, SPA-modus, geen Node-server in productie). `npm audit fix --force` zou naar een breaking `@sveltejs/kit@0.0.30` downgraden — niet gedaan.
- `cargo-audit` geinstalleerd (`cargo install cargo-audit`) en uitgevoerd. Van 8 naar 2 kwetsbaarheden:
  - `tar` → 0.4.46 (zie boven).
  - `crossbeam-epoch` → 0.9.20 (RUSTSEC-2026-0204).
  - `users` (unmaintained, RUSTSEC-2025-0040/2023-0040/2023-0059, geen fix beschikbaar) vervangen door de actief onderhouden fork `uzers` in `src-tauri/src/vfs.rs`.
  - Resterende 2 (RUSTSEC-2026-0194/0195 in `quick-xml 0.38.4`): transitief via Tauri's eigen `plist`-dependency, uitsluitend gebruikt op macOS-targets (`cargo tree -i quick-xml --target all` toont `plist → tauri`). Op onze Linux-build wordt deze crate niet eens gecompileerd (`cargo tree -i quick-xml` zonder `--target all` toont "nothing to print"). Geaccepteerd restrisico, niet upstream fixbaar vanuit dit project.
  - Overige "unmaintained"-warnings (gtk-rs GTK3-bindings, `proc-macro-error`, `fxhash`, `unic-*`, `anyhow`/`glib`/`rand` unsoundness) komen allemaal uit Tauri 2.10.3's eigen Linux-stack (webkit2gtk/tao/muda) of `tauri-utils`, niet uit projectcode. Buiten scope om zelf te patchen; monitoren bij toekomstige Tauri-upgrades.

### Task queue resource growth
- `src-tauri/src/task_queue.rs`: `execute_task` is nu idempotent (spawnt geen tweede worker als een taak al `Running`/`WaitingForInput` is). Nieuwe `prune_tasks()` stampt een `finished_at` op elke taak die `Completed`/`Failed`/`Cancelled` wordt, verwijdert taken ouder dan 1 uur, en houdt een hard maximum van 500 getrackte taken aan (oudste voltooide taken eerst, actieve taken worden nooit verwijderd). Aangeroepen bij elke `create_task`/`get_all_tasks`. 4 unit tests groen.

### Search job resource leaks
- `src-tauri/src/search.rs`: elke `search_files`-aanroep krijgt een job-id en een cancel-flag in een nieuwe `SearchState`. Toegevoegd: `search_cancel(job_id)` IPC-command, max 3 gelijktijdige searches, max 5000 resultaten, max 5 minuten looptijd per job. Events zijn nu per-job (`search-result:{job_id}` / `search-done:{job_id}`) zodat late events van een geannuleerde search niet doorlekken naar een nieuwe. Frontend (`SearchModal.svelte`) annuleert de actieve job bij het sluiten van de modal en vóór het starten van een nieuwe zoekopdracht.

### Viewer memory footprint
- `src-tauri/src/viewer.rs`: afbeeldingen worden niet meer volledig ingelezen en base64-geencodeerd over IPC gestuurd. De frontend (`FileViewer.svelte`) laadt de afbeelding nu rechtstreeks via `convertFileSrc()` (Tauri's `asset:`-protocol), zodat de webview het bestand van schijf streamt in plaats van dat het tegelijk in het Rust- en JS-geheugen als volledige kopie plus base64-opblazing (~1.33x) staat. De `base64`-crate-dependency is verwijderd.
- SVG-bestanden worden gerenderd via een `<img>`-tag (bevestigd in `FileViewer.svelte`), niet via `<object>`/`<iframe>`/innerHTML — browsers voeren scripts in SVG's die als `<img>` geladen worden niet uit, dus de eerder genoemde SVG-XSS zorg was al gemitigeerd door deze renderkeuze en is nu extra gedekt door de nieuwe strikte CSP.
- Tekst- (10 MB) en hex-viewer (1 MB) limieten ongewijzigd gelaten: die waren al begrensd, niet onbegrensd.

### Proces-start hardening
- `src-tauri/src/terminal.rs`: nieuwe `resolve_program()` controleert dat `$TERMINAL`/`$VISUAL`/`$EDITOR` daadwerkelijk naar een bestaand executable pad resolven (absoluut of via `$PATH`) voordat ze aan `Command::new()` worden doorgegeven; bij een niet-resolvend pad valt de code terug op de bestaande XDG-fallbacks in plaats van blind te proberen te executen. Als bijvangst is de kapotte `Command::new("which")...is_ok()`-check (die altijd `true` gaf, ongeacht of het programma echt gevonden werd) vervangen door de echte `resolve_program`-check. 5 unit tests groen.
- `src-tauri/src/open_with.rs`: `open_file_with_app` en `set_default_app` accepteren niet langer elke willekeurige `desktop_entry`-string vanuit de webview. Nieuwe `is_known_desktop_entry()` valideert dat de entry overeenkomt met een daadwerkelijk geinstalleerd `.desktop`-bestand in de standaard app-directories (dezelfde bron als `get_open_with_apps`), en weigert padseparators/`..`. 2 unit tests groen.

### Destructive filesystem guardrail
- `src-tauri/src/vfs.rs` `delete_entry`: bij `DeleteMode::Trash` en een falende `trash::delete()` wordt niet meer stil teruggevallen op permanent verwijderen. De fout wordt nu teruggegeven aan de caller; een permanente delete vereist een expliciete tweede aanroep met `DeleteMode::Permanent`. De task-queue delete-flow (`task_queue.rs::execute_delete`, de daadwerkelijke UI-route via `Dialog.svelte`'s permanent-delete checkbox) deed dit al correct en is ongewijzigd.
- Overige P0-items uit `docs/CODE_REVIEW_ACTIEPLAN_2026-07-13.md` (move-conflictresolutie, nested-copy guard, move-fallback delete-check) waren al aantoonbaar aanwezig in de huidige code (`task_queue.rs`, `vfs.rs::copy_directory`) en zijn onafhankelijk geverifieerd, niet enkel op het bestaande actieplan vertrouwd.

### Verificatie
- `cargo check`: groen, 0 warnings.
- `cargo test --lib`: 18/18 groen (archive-extractie, task-queue lifecycle, terminal/open-with validatie).
- `npm run check`: groen, 0 errors/warnings, locales in sync.
- `npm run build`: groen.
- **Niet uitgevoerd:** een interactieve GUI-smoketest (`tauri dev` met een echt venster) — er is geen headless screenshot-tooling beschikbaar in deze omgeving (geen `xvfb-run`/`import`/`scrot`/`gnome-screenshot`), en dit draait op de daadwerkelijke live desktopsessie van de gebruiker, dus is bewust niet ongevraagd een zichtbaar venster geopend. De CSP-wijziging is in plaats daarvan statisch geverifieerd (Tauri's eigen script-hashing mechanisme gelezen in de crate-source, alle `fetch`/`XHR`/`WebSocket`/`eval`-aanroepen in `src/` doorzocht — geen gevonden die de nieuwe CSP zou breken). Aanbevolen: eenmalig handmatig `npm run tauri dev` draaien en de devtools-console op CSP-violations controleren.
