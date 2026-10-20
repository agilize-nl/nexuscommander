# Niet volledig geïmplementeerde items

**Peildatum:** 2026-08-04  
**Bronnen:** de actieve documenten in `docs/` en een controle van de huidige
werkboom.

Deze lijst bevat alleen punten die nog niet volledig zijn geïmplementeerd of
waarvoor de vereiste verificatie nog ontbreekt. De afgeronde faseplannen en
analyses staan in [`docs/archive/`](archive/).

## Gecontroleerde basis

De lokale gate `npm run verify` slaagt. Daaronder vallen typechecks, locale- en
statische checks, beide builds, Rust fmt/clippy/tests, webtests, audits en de
GNU Windows-cross-check. Dat resultaat sluit de volgende beperkingen niet uit:

- drie webtests voor cross-device-operaties zijn overgeslagen omdat geen tweede
  filesystem beschikbaar is;
- `npm audit` meldt een moderate PostCSS-kwetsbaarheid met een beschikbare fix;
- `cargo audit` meldt 17 toegestane waarschuwingen, waaronder de onmaintained
  GTK3-stack en de unsound `glib`-waarschuwing;
- de builds slagen, maar rapporteren twee Svelte-buildwaarschuwingen in
  `AboutDialog.svelte` en `FilePropertiesDialog.svelte`;
- de GNU cross-check is geen native Windows-build, geen macOS-build en geen
  fysieke platform-smoketest.

## Migratie en cutover

- **Visuele regressietest (Fase 9.1):** beide shells moeten nog handmatig tegen
  de referentiebeelden worden gecontroleerd; headless verificatie is niet
  beschikbaar.
- **Windows:** native compile, operationele testmatrix en kwalificatie met
  echte Windows-semantiek ontbreken nog. De lokale GNU cross-check is groen,
  maar vervangt dit niet.
- **Release/cutoverbesluit:** de oude repositories moeten nog read-only worden
  gearchiveerd, README's moeten naar de monorepo verwijzen en de
  `CLAUDE.md`/`AGENTS.md`-structuur moet definitief worden opgeschoond. De vier
  workspaces staan inmiddels op `0.9.5`; oudere migratiedocumenten noemen nog
  `0.9.0-dev`/`0.9.0` en moeten daarom worden bijgewerkt zodra het releasebesluit
  is genomen.
- **Oude help-backend:** `apps/desktop/src-tauri/src/help.rs` compileert nog,
  maar wordt niet meer door de UI gebruikt sinds help-markdown is gebundeld.

## Fase 2 — archieven

- **P2.1:** `solid_archive` staat nog in het IPC-contract, desktop-command en
  dialoog, maar heeft geen werking in de vijf desktop-writers. De capability-
  matrix, formaatdetectie en weigering van niet-produceerbare formaten zijn
  wel grotendeels afgerond.
- **P2.2:** packing is nog niet job-scoped. Desktop gebruikt één procesbrede
  cancel-vlag; web heeft geen packing-cancel en geen voortgangsrapportage.
- **P2.3:** staging en conflictbewuste promotie zijn geïmplementeerd, maar
  vrije-schijfruimte-preflight, dubbele/case-collision-detectie en een UI-flow
  om na skips direct `replace` of `keep_both` te kiezen ontbreken.
- **P2.4:** er is nog geen expliciete `MetadataPolicy`; timestamps worden bij
  extractie niet volledig behouden en `read_archive` retourneert alle entries
  ineens zonder paginering of begrensde streaming.
- **P2.5:** tests voor zip-bomb-ratio- en entry-countgrenzen ontbreken nog op
  pure grenspredicaten; ongeldige headers zijn slechts beperkt afgedekt en er
  is nog geen volledige hostile-fixture/fuzzmatrix.

## Incrementele file-list-refresh

De frontend-eerste stap is zichtbaar in `FileList.svelte`: keyed selectie met
`Set<string>`, `reconcileEntries()` en behoud van relevante mapgrootte-cache.
Het plan als geheel is dus slechts gedeeltelijk afgerond:

- **Niveau 2 ontbreekt:** geen directory-`mtime` fast path en geen
  `readDirectoryDelta`-contract/API.
- **Niveau 3 ontbreekt:** de `notify`-dependency is aanwezig, maar er is geen
  actieve OS-watcher met `nc:file-changed`-dispatch naar een paneel.
- De scroll-, selectie-, cache- en IPC-performantie-acceptatiecriteria zijn nog
  niet als reproduceerbare benchmark/regressietest vastgelegd.

## QSF-vervolgwerk na Fase 2

De volgende onderdelen uit het kwaliteits- en veiligheidsplan zijn nog niet
volledig gerealiseerd:

| Onderdeel | Nog open |
|---|---|
| P3.1 | Herstelbare settings/bookmark-service inclusief recovery-UI en crash/close-tests |
| P3.2 | Duurzame task-history en zichtbare partial/error/recovery-resultaten |
| P3.3 | Request-ID's/channels voor search, navigatie en viewer; deduplicatie van listeners en mount-monitoring |
| P3.4 | Opsplitsen van `FileList`, opties/dialogen, task queue, VFS en archive-modules |
| P3.5 | Volledige accessibility-, keyboard-, locale- en focus-gates |
| P3.6 | Code splitting en verdere reductie van startup-chunks, native calls en polling |
| P3.7 | Verwijderen van onveilige `{@html}`-rendering en invoeren van parser + sanitizer voor Markdown |
| P4.1 | Linux/Windows/macOS runners en fysieke platform-smoketests |
| P4.2 | Minimale privileged helper in plaats van elevatie van de volledige app |
| P4.3 | Immutable releasepipeline met tests, signing, checksums, SBOM en provenance |
| P4.4 | Opt-in crashrapportage, logredactie en diagnostische export |
| P4.5 | Complete build-, test-, architectuur-, security-, recovery- en supportdocumentatie |
| Fase 5 | Plugin-isolatie/permissions, netwerkfilesystemen en overige optionele capability growth |

Dit correspondeert onder meer met open QSF-items rond root-elevatie (QSF-007),
HTML/sanitization (QSF-013), search/viewer-races en dubbele listeners
(QSF-015/016), swallowed errors (QSF-017), dependency-onderhoud (QSF-019),
release-automation (QSF-021), moduleconcentratie (QSF-022), testdiepte
(QSF-023), a11y/bundlekwaliteit (QSF-024) en plugin-isolatie (QSF-025).

## Startup-performance-backlog

- `TextEditorModal`/CodeMirror lazy-loaden en lucide deep imports gebruiken;
- `get_drives`-polling beperken tot focus/zichtbare drives en mount-timeouts
  toevoegen;
- locales lazy laden en onnodig grote favicon-assets verwijderen;
- de twee Svelte-buildwaarschuwingen oplossen.

De eerder genoemde clippy-fout uit de startupanalyse is inmiddels niet meer
open: `cargo clippy -D warnings` slaagt in de actuele verify-gate.

## Status van de actieve bron-documenten

| Document | Status |
|---|---|
| `COMPREHENSIVE_QUALITY_SAFETY_UPGRADE_PLAN_2026-07-28.md` | Actief voorstel; Fase 2 gedeeltelijk uitgevoerd, Fases 3–5 niet volledig uitgevoerd |
| `FASE_2_UITVOERINGSPLAN_2026-07-30.md` | In uitvoering |
| `INCREMENTELE_FILELIST_REFRESH_PLAN_2026-07-30.md` | Gedeeltelijk uitgevoerd; Niveau 2 en 3 open |
| `NEXUS_MIGRATIEPLAN_MONOREPO_2026-07-23.md` | Gedeeltelijk uitgevoerd; cutover/verificatie open |
| `REPO_STATUS.md` | Gedeeltelijk uitgevoerd; handmatige acceptatie en opruiming open |
| `STARTUP_PERFORMANCE_ANALYSE_2026-07-31.md` | Gedeeltelijk uitgevoerd; backlog open |
