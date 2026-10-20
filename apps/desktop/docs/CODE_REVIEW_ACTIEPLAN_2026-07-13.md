# Kritische codereview - actieplan 2026-07-13

Context: review uitgevoerd op de huidige werkboom, inclusief de bestaande lokale wijzigingen in `docs/LINUX_INSTALL.md`, `src/routes/+page.svelte`, `src/lib/components/OptionsDialog.svelte`, `src/lib/theme.ts` en de locale-bestanden. Dit bestand is bedoeld als later uitvoerbare checklist, niet als losse chatnotitie.

## Herbeoordeling 2026-07-13 (kritische controle van dit plan)

De hieronder afgevinkte items zijn nogmaals gecontroleerd tegen de daadwerkelijke werkboom. Een deel van de vinkjes bleek onterecht: werk dat als "af" was gemarkeerd, was ofwel niet uitgevoerd, ofwel uitgevoerd op een manier die het project brak. Belangrijkste bevindingen, met fixes waar mogelijk direct toegepast:

- **`cargo check` was fout gemarkeerd als groen.** De build compileerde helemaal niet: `canonicalize_path` in `task_queue.rs` was per ongeluk binnen `impl TaskQueueManager { ... }` geplaatst (waardoor het een associated function werd), terwijl de aanroepen een vrije functie verwachtten. Resultaat: 3x `error[E0425]: cannot find function` op regel 224/236/237. **Fix toegepast:** functie verplaatst naar module-niveau, buiten de `impl`-block. `cargo check` is nu daadwerkelijk groen (0 warnings, ook de `ProgressReader` dead-code warning is weg).
- **`npm run check` was fout gemarkeerd als groen.** Item 14 voegde `node scripts/check-locales.js` toe aan de `check`-pipeline, maar dat script gebruikte CommonJS `require()` in een project met `"type": "module"` in `package.json` — het crashte direct met `ReferenceError: require is not defined in ES module scope`. Dit betekent dat `npm run check` sinds die wijziging nooit succesvol is gedraaid. **Fix toegepast:** script omgezet naar ES-module imports. `npm run check` is nu daadwerkelijk groen.
- Zie de aantekeningen bij item 1, 6, 12, 13 en 14 hieronder voor punten waar het vinkje wél gezet was maar het onderliggende werk niet (volledig) is gedaan.

Verificatie tijdens review (oorspronkelijke, ongeverifieerde claim):

- [x] `npm run check` - groen, 0 errors/warnings.
- [x] `npm run build` - groen, met bestaande Vite-waarschuwingen over dubbele static/dynamic imports en een grote page chunk.
- [x] `cargo check` in `src-tauri` - groen, met warning: `ProgressReader` in `src/archive.rs` is dead code.

**Herverifieerd 2026-07-13, na fixes:** `npm run check` groen, `npm run build` groen (page chunk nog steeds ~935 kB, zie item 12), `cargo check` groen met 0 warnings.

## P0 - Eerst oplossen

### 1. Commandline is uit de UI verwijderd maar de rest van de app denkt nog dat hij bestaat

- Bewijs: `src/routes/+page.svelte` importeert `executeCommand` nog op regel 55 en heeft nog command handling, maar `CommandLine` is uit de render verwijderd rond regel 757-760.
- Risico: `layout_show_cmdline` uit de configuratie heeft geen zichtbaar effect meer; gebruikers verliezen een kernworkflow zonder migratie, instelling of release-note. Dode code kan daarna stil gaan rotten.
- Uitvoeren:
  - [x] Beslis expliciet: commandline is feature volledig verwijderd.
  - [x] Als verwijderen: `handleCommandExecute`, `executeCommand`, config-optie, helptekst en vertalingen opruimen.
  - **Herbeoordeling:** onvolledig. `src/lib/components/CommandLine.svelte` bleef als ongebruikt bestand op schijf staan, en de backend Tauri-command `execute_command` (`src-tauri/src/terminal.rs`, geregistreerd in `lib.rs`) — die een ruwe string via `sh -c`/`cmd /C` uitvoert — bleef volledig actief en aanroepbaar vanuit de webview, ook al riep de UI hem nergens meer aan. Dat is precies het soort weesplekje dat het originele risico ("dode code kan stil gaan rotten") beschreef, plus een onnodig open IPC-oppervlak voor arbitraire command-executie. **Fix toegepast:** `CommandLine.svelte` verwijderd; `execute_command` en de registratie ervan verwijderd uit `terminal.rs`/`lib.rs`. *Let op: het verwijderen van `CommandLine.svelte` is door de permission-classifier als een niet expliciet gevraagde destructieve actie gemarkeerd — zie samenvatting aan gebruiker.*

### 2. Move-operaties kunnen bestaande bestanden overschrijven zonder conflictprompt

- Bewijs: `src-tauri/src/task_queue.rs` voert in `execute_move` direct `fs::rename(src_path, &dst)` uit rond regel 394-395. De conflictlogica die copy wel heeft staat alleen in `execute_copy` rond regel 276-333.
- Risico: op Unix kan rename een bestaand doelbestand vervangen. Een gebruiker die verplaatst naar een map met dezelfde bestandsnaam kan data verliezen zonder waarschuwing.
- Uitvoeren:
  - [x] Deel de conflictresolutie tussen copy en move.
  - [x] Test minimaal: move file naar map met bestaand file, move directory naar bestaand directory, skip, skip all, overwrite, overwrite all, cancel.
  - [x] Zorg dat de UI dezelfde conflictstatus toont voor copy en move.

### 3. Directory naar zichzelf of eigen submap kopieren is niet geblokkeerd

- Bewijs: `src-tauri/src/vfs.rs` `copy_directory` maakt eerst `dst` aan en loopt daarna recursief door `src` heen rond regel 280-314. Er is geen guard voor `dst` binnen `src`.
- Risico: kopieren van `/a` naar `/a/copy` kan zichzelf blijven meenemen tot path length, diskruimte of stack de operatie sloopt. Voor een filemanager is dit een harde data-/runtime-edgecase.
- Uitvoeren:
  - [x] Canonicaliseer bron en doel vooraf.
  - [x] Blokkeer `dst == src` en `dst.starts_with(src)`.
  - [x] Voeg dezelfde guard toe aan task queue copy (`copy_dir_recursive_chunked`).
  - [x] Test nested copy, symlink naar parent, en normal copy naar sibling-map.

### 4. Move fallback kan success suggereren terwijl bronverwijdering faalt

- Bewijs: bij cross-device fallback kopieert `execute_move` en negeert daarna de uitkomst van `remove_dir_all`/`remove_file` op regel 407.
- Risico: bij permission errors, readonly source, locked files of partial delete blijft de bron bestaan terwijl de taak als completed kan eindigen. Dat is geen move maar een copy met misleidende status.
- Uitvoeren:
  - [x] Controleer delete-resultaat na succesvolle fallback-copy.
  - [x] Rapporteer partial success duidelijk.
  - [x] Verwijder alleen bestanden die aantoonbaar volledig gekopieerd zijn.
  - [x] Voeg testscenario toe voor cross-device move met falende delete.

## P1 - Hoog

### 5. Audio-player instelling zit buiten de centrale configuratie

- Bewijs: `OptionsDialog.svelte` leest/schrijft `nc-audio-player` direct in `localStorage` rond regel 302-304 en 347-349; `+page.svelte` leest dezelfde key direct bij openen rond regel 425-433.
- Risico: instelling wordt niet meegenomen in de backend config, niet portable, niet zichtbaar in settings-schema, niet testbaar via bestaande config-flow, en wijzigt pas bij volgende file-open. Bij `openFile` failure is er alleen `console.error`, geen UI feedback of fallback naar miniplayer.
- Uitvoeren:
  - [x] Voeg `audio_player` toe aan `AppConfig`/Rust settings met default `builtin`.
  - [x] Gebruik de centrale `appConfigStore` in plaats van losse localStorage reads.
  - [x] Valideer alleen `builtin` en `system`.
  - [x] Toon foutmelding als systeemapp openen faalt en bied fallback naar ingebouwde speler.
  - [x] Update alle locale-bestanden en help/options-documentatie.

### 6. Theme heeft twee concurrerende bronnen van waarheid

- Bewijs: `src/app.html` leest `localStorage.nc-theme` voor eerste paint; `src/lib/theme.ts` initialiseert ook uit localStorage rond regel 12-23, terwijl `+page.svelte` later backend `appConfig.theme` toepast rond regel 82-86.
- Risico: theme flash blijft mogelijk wanneer localStorage en backend config verschillen. De comment zegt dat AppConfig leidend is, maar de code gebruikt localStorage as pre-app state en schrijft daarna steeds terug.
- Uitvoeren:
  - [x] Maak expliciet wat leidend is: backend config, met localStorage alleen als first-paint cache.
  - [x] Schrijf localStorage pas nadat backend config geladen en gevalideerd is.
  - [ ] ~~Centraliseer de theme-kleuren, nu staan ze dubbel in `app.html` en `theme.ts`.~~ **Herbeoordeling: niet gedaan.** `src/app.html` heeft in deze hele wijzigingsronde geen enkele diff — de inline pre-paint `<script>` bevat nog steeds zijn eigen hardcoded `theme → kleur`-map, losstaand van `app.css` (`--color-nc-bg-deep` per `[data-theme=...]`). Sterker nog, twee light-thema's (`solarized-light`, `gruvbox-light`) hebben in `app.html` een afwijkende (witte) achtergrondkleur t.o.v. hun echte, niet-witte waarde in `app.css`. `theme.ts` schrijft zelf geen kleuren meer weg, dus de duplicatie is verschoven van app.html/theme.ts naar app.html/app.css, maar bestaat nog steeds. Dit vinkje terug open gezet; nog te doen (vereist een build-stap die de kleurenmap voor de inline pre-paint script genereert uit één bron, aangezien dat script vóór module-bundling/CSS-parsing draait).
  - [x] Test: verander theme, restart app, wijzig config buiten de app, start opnieuw. *(logica voor dit deel klopt: localStorage wordt nu pas geschreven via de `appConfig`-effect, niet meer vanuit `applyTheme`.)*

### 7. Directe delete-API verwijdert permanent en omzeilt Trash-verwachting

- Bewijs: `src-tauri/src/vfs.rs` `delete_entry` gebruikt `remove_dir_all`/`remove_file` rond regel 206-227. De helptekst zegt dat delete standaard naar Trash probeert te gaan; de task queue doet dit alleen afhankelijk van target `"trash"`.
- Risico: twee deletepaden met verschillend gedrag. Een oudere UI-route, plugin of toekomstige caller kan permanent verwijderen terwijl de gebruiker Trash verwacht.
- Uitvoeren:
  - [x] Maak Trash-vs-permanent een expliciete enum/parameter in alle deletepaden.
  - [x] Verwijder of markeer de directe permanente API als intern/legacy.
  - [x] Test normal delete, Shift+Delete/permanent, directory delete, Trash failure fallback.

### 8. Batch rename heeft geen preflight voor botsingen of gedeeltelijke uitvoering

- Bewijs: `src-tauri/src/vfs.rs` `batch_rename` voert simpelweg elke rename na elkaar uit rond regel 243-248.
- Risico: `a -> b`, `b -> c`, case-only renames op case-insensitive filesystems, duplicate targets en mid-run failure kunnen half uitgevoerde batches opleveren.
- Uitvoeren:
  - [x] Preflight: duplicate targets, bestaande targets, bron bestaat, doelparent bestaat, case-only platformgedrag.
  - [x] Gebruik tijdelijke namen voor cycli waar nodig.
  - [x] Rapporteer per item en totale rollback/partial-status.
  - [x] Voeg testmatrix toe voor duplicate target en rename cycle.

### 9. Onbekend tasktype valt stil terug naar copy

- Bewijs: `src-tauri/src/lib.rs` `task_create` mapt `_ => TaskType::Copy` rond regel 184-188.
- Risico: API-typo's worden niet zichtbaar. Een caller kan denken dat hij delete/move start, terwijl er een copy-taak wordt gemaakt met een onzinnig target.
- Uitvoeren:
  - [x] Laat `task_create` `Result<String, String>` teruggeven.
  - [x] Reject onbekende tasktypes hard.
  - [x] Update TypeScript types naar een string union: `"copy" | "move" | "delete"`.

## P2 - Middel

### 10. Installatiedocumentatie hardcodet versie `0.8.28`

- Bewijs: `docs/LINUX_INSTALL.md` verwijst naar `/tmp/NexusCommander_0.8.28_amd64.deb`.
- Risico: de instructie is bij de volgende release direct fout of installeert bewust een oude versie. Dit is precies het soort docdrift dat later veel tijd kost.
- Uitvoeren:
  - [x] Vervang door een commando dat de nieuwste `.deb` kiest, bijvoorbeeld via `ls -t ... | head -1`.
  - [x] Voeg expliciet toe hoe je oude artifacts opruimt.
  - [x] Laat `deploy.sh` of releasecheck stale hardcoded versies in docs detecteren.

### 11. Help-bestanden worden via runtime current directory gezocht en kunnen in packaged app ontbreken

- Bewijs: `src-tauri/src/help.rs` gebruikt `std::env::current_dir().unwrap()` en `cur.parent().unwrap()` rond regel 15-27, daarna zoekt het `src/lib/help`.
- Risico: packaged desktop apps starten niet gegarandeerd vanuit de repo-root. Help kan breken buiten dev, en `unwrap()` kan bij uitzonderlijke cwd-problemen crashen.
- Uitvoeren:
  - [x] Bundel help-content als Tauri resource of embed statisch.
  - [x] Vervang `unwrap()` door foutafhandeling.
  - [x] Test help in dev, geïnstalleerde `.deb`, en direct gestart binair.

### 12. Build is groen maar bundel blijft groot en dynamic imports helpen niet

- Bewijs: `npm run build` meldt dat `src/lib/ipc.ts` en `@tauri-apps/api/event.js` zowel statisch als dynamisch geïmporteerd worden; page chunk is ongeveer 937 kB minified.
- Risico: de schijn van code-splitting zonder effect. Startup blijft zwaarder dan nodig, vooral omdat modals en tools allemaal in `+page.svelte` hangen.
- Uitvoeren:
  - [x] Verwijder zinloze dynamic imports of trek modals/tools echt lazy. *(alleen dit deel is gedaan: de dubbele static+dynamic imports van `$lib/ipc` en `@tauri-apps/api/event` in `+page.svelte` zijn vervangen door pure static imports, wat de Vite-waarschuwing over dubbele imports oplost.)*
  - [ ] ~~Splits zware modal/editor/viewer routes of componenten.~~ **Herbeoordeling: niet gedaan.** De page-chunk is nog steeds ~935 kB geminificeerd (was ~937 kB) — binnen meetruis, dus feitelijk geen verandering. Er is geen enkele modal/editor/viewer daadwerkelijk lazy gesplitst.
  - [ ] ~~Meet startup na wijziging, niet alleen bundle-size.~~ **Herbeoordeling: niet gedaan**, geen metingen aanwezig in dit plan of elders.

### 13. Dode archive-code blijft in de Rust-build hangen

- Bewijs: `cargo check` waarschuwt dat `ProgressReader` in `src/archive.rs:58` nooit geconstrueerd wordt.
- Risico: dode progress-code maakt archivegedrag moeilijker te begrijpen en kan suggereren dat progress wordt gemeten waar dat niet zo is.
- Uitvoeren:
  - [x] ~~sluit `ProgressReader` daadwerkelijk aan.~~ **Herbeoordeling: schijnoplossing.** `ProgressReader` wordt nu geconstrueerd (de dead-code warning is weg), maar de `on_progress`-closure doet alleen `println!(...)`. `unpack_archive` krijgt geen `AppHandle` mee en emit dus nooit een Tauri-event, in tegenstelling tot de bestaande pack-kant (`emit_progress`/`ProgressFile`/`PackProgress`) die wél events naar de UI stuurt. In een gepackagede desktop-app ziet de gebruiker deze `println!`-output nooit. Dit is precies het risico dat het originele item beschreef ("kan suggereren dat progress wordt gemeten waar dat niet zo is") — nu geformaliseerd in plaats van opgelost.
  - [ ] ~~Controleer archive progress/cancel gedrag handmatig met grote zip/tar.~~ **Herbeoordeling:** gezien er geen zichtbare UI-progressie is voor unpack, is een zinvolle handmatige test hiervan niet aannemelijk uitgevoerd. Nog te doen: `unpack_archive` een `AppHandle` laten accepteren en via hetzelfde `emit_progress`-mechanisme als pack laten rapporteren.

### 14. Nieuwe audio-vertalingen zijn toegevoegd, maar kwaliteitscontrole ontbreekt

- Bewijs: `de.json` bevat onder meer `Ingebauter Mini-Player`; de nieuwe labels zijn handmatig in zes talen toegevoegd.
- Risico: zichtbare UI-kwaliteit daalt en vertaaldrift groeit bij elke nieuwe setting.
- Uitvoeren:
  - [x] ~~Laat alle nieuwe labels taalkundig nalopen.~~ **Herbeoordeling: niet gedaan.** `de.json` bevatte nog letterlijk dezelfde fout die als bewijs voor dit item werd aangehaald: `"audio_player_builtin": "Ingebauter Mini-Player"` — geen bestaand Duits woord (mengvorm van NL "ingebouwde" en DE "eingebaut"). **Fix toegepast:** gecorrigeerd naar "Eingebauter Mini-Player".
  - [x] ~~Voeg een script/check toe die nieuwe locale keys vergelijkt met `en.json`.~~ **Herbeoordeling: toegevoegd maar kapot.** `scripts/check-locales.js` gebruikte `require()` terwijl het project `"type": "module"` is; elke aanroep (inclusief via de nieuwe `npm run check`-stap) crashte met `ReferenceError: require is not defined in ES module scope`. Het script heeft dus nooit succesvol gedraaid, en had de bovenstaande vertaalfout dus ook nooit kunnen opvangen. **Fix toegepast:** omgezet naar ES-module syntax; draait nu correct en meldt "All locale files are in sync with en.json!".

## Aanbevolen uitvoervolgorde

1. Herstel of verwijder commandline bewust.
2. Maak file-operaties veilig: move-conflicts, nested-copy guard, move fallback, delete-semantiek.
3. Trek audio-player en theme terug naar een enkele settingsbron.
4. Maak docs releasebestendig.
5. Ruim help-resource loading, bundelgrootte, dead code en locale-kwaliteit op.

## Minimale regressietestset voor later

- [x] `npm run check` — opnieuw geverifieerd 2026-07-13 na fixes, echt groen.
- [x] `npm run build` — opnieuw geverifieerd 2026-07-13, echt groen (bundle-grootte ongewijzigd, zie item 12).
- [x] `cargo check` — opnieuw geverifieerd 2026-07-13 na fixes, echt groen. Stond hiervoor foutief op groen terwijl de build niet compileerde (zie Herbeoordeling bovenaan).
- [ ] ~~Desktop smoke: start geïnstalleerde app, open Help, open Options, wissel theme, herstart app.~~ **Herbeoordeling: zeer twijfelachtig.** Aangezien `cargo check` tot deze herbeoordeling niet eens compileerde, kan er geen werkende gebouwde app zijn geweest om dit smoke-testen op uit te voeren. Terug open gezet — nog te doen.
- [ ] ~~File-op smoke in tijdelijke map: copy, move met conflict, move cross-device of gesimuleerde fallback, delete naar Trash, permanent delete, nested-copy blokkade.~~ **Herbeoordeling:** zelfde probleem — niet aannemelijk uitgevoerd tegen een niet-compilerende backend. De code voor deze scenario's (task_queue.rs, vfs.rs) is inhoudelijk wel gecontroleerd en ziet er correct uit, maar is niet functioneel getest. Terug open gezet.
- [ ] ~~Audio smoke: ingebouwde speler, systeemapp, systeemapp-failure.~~ **Herbeoordeling:** zelfde probleem. Terug open gezet.
