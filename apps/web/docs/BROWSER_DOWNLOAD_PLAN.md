# NexusCommander-PWA — Browser-downloadplan

_Opgesteld: 2026-09-16 · Versie repo: v0.9.15 · Status: 📝 Ontwerp, nog niet geïmplementeerd_

Dit document beschrijft het ontwerp en een gefaseerd implementatieplan om vanuit de browser bestanden (en mappen) te downloaden vanuit de map die in het actieve paneel open staat — het spiegelbeeld van `BROWSER_UPLOAD_PLAN.md` (§9 daarvan wordt hier niet herhaald; conflicthantering is bij download niet van toepassing, de browser bepaalt zelf de bestandsnaam bij dubbele downloads). Alle verwijzingen hebben de vorm `bestand:regel` en zijn geverifieerd tegen v0.9.15, ná de monorepo-migratie (`packages/ui` bevat de gedeelde componenten; `apps/web/src/lib/upload/*` is web-lokaal).

Vastgelegde functionele keuzes:

- **Ingangen:** item-contextmenu en Bestanden-menu, mobielvriendelijk. Het achtergrond-contextmenu en de toolbar krijgen in fase 1 geen downloadactie: „hele huidige map downloaden” is te makkelijk per ongeluk te starten en de toolbar is al dicht bij vol. Géén drag-out (OS-drag-uit-browser is technisch mogelijk via `DownloadURL`-MIME maar wordt door geen enkele browser meer volledig ondersteund voor cross-origin/blob-content — buiten scope).
- **Selectie:** één bestand, meerdere bestanden, of mappen. Eén bestand → directe streaming-download. Meerdere items of een map → server-side zip-bundeling, gestreamd (geen tijdelijk zip-bestand op schijf).
- **Voortgang:** eigen downloadpaneel naast `UploadProgress`, zelfde visuele grammatica. Voor het single-file-pad is er geen betrouwbare byte-progress vanuit een `<a download>`/nieuwe-tab-flow (zie §2.2) — voor het zip-pad wel, via SSE. Het paneel rapporteert server-side zip-voortgang, niet of de browser de download al volledig naar schijf heeft geschreven.

---

## 1. Probleemstelling en huidige situatie

| # | Vaststelling | Locatie |
|---|---|---|
| 1 | Er bestaat al één download-primitive: `GET /api/fs/raw?path=…`, die `res.sendFile` met `acceptRanges: true` doet — werkt voor precies één bestand, geen zip/batch | `apps/web/server/routes/fs.js:638-650` |
| 2 | De enige UI-ingang is een kale `<a href={rawUrl} download>Download</a>` in de headless-bestandspreview, bereikbaar alléén als je een bestand al in de preview-modal open hebt staan — geen contextmenu-item, geen toolbar-knop, geen multi-select, geen mapdownload | `apps/web/src/lib/components/HeadlessFileModal.svelte:901,995,1277` |
| 3 | Die "Download"-tekst is **hardcoded**, niet via `$_()` — een bestaande afwijking van de i18n hard-rule die dit plan niet moet herhalen | `apps/web/src/lib/components/HeadlessFileModal.svelte:901` |
| 4 | `convertFileSrc()` is een optionele `NexusIpc`-capability met per-shell implementatie, maar representeert uitsluitend een preview/asset-URL en kent geen download-intentie of headers | `packages/ui/src/lib/ipc-contract.ts:495`, `apps/web/src/lib/ipc.ts:543-545` |
| 5 | `adm-zip` zit al in `package.json`, maar bouwt schrijfarchieven in geheugen en is daarom uitsluitend geschikt voor het bestaande leesgebruik (unpack/browse), niet voor downloadbundels | `apps/web/package.json:52`, `apps/web/server/routes/archive.js:2` |
| 6 | Twee bestaande progress-patronen om van te kiezen: XHR `upload.onprogress` (upload) en SSE via `/api/tasks/:id/progress` (lang lopende server-taken zoals copy/move) | `apps/web/src/lib/upload/uploadClient.ts:71-75`, `apps/web/src/lib/ipc.ts:547-548` |
| 7 | `FileList.svelte` heeft al het exacte seam-precedent voor een web-only contextmenu-item: `showUpload`-prop (default `false`) die een item conditioneel toevoegt | `packages/ui/src/lib/components/FileList.svelte:86,97,812` |
| 8 | Selectie van meerdere entries is al een first-class concept (gebruikt door Pack/Delete/Copy) | `packages/ui/src/lib/components/FileList.svelte:787` (`selectedEntries`) |

"Downloaden vanaf de server" is dus voor het single-file-geval al opgelost (`/api/fs/raw`) — het ontbrekende werk is (a) dat aan een generieke, ontdekbare UI-actie hangen (contextmenu/toolbar/menu, multi-select), en (b) een zip-bundelend endpoint voor meerdere bestanden of mappen, met voortgang.

---

## 2. Kernbeslissingen

### 2.1 Twee paden: direct-stream (1 bestand) vs. zip-bundel (2+ bestanden of een map)

| Situatie | Pad |
|---|---|
| Eén bestand geselecteerd | Hergebruik `GET /api/fs/raw` — geen wijziging nodig, alleen een `Content-Disposition`-header toevoegen (§3.1) zodat de bestandsnaam ook klopt zonder de preview-modal |
| Eén map geselecteerd | Nieuw endpoint, zip van de hele boom |
| 2+ items geselecteerd (mix van bestanden/mappen) | Zelfde nieuwe endpoint, zip van de selectie |

Geen universeel "alles door de zipper" omdat single-file-streaming zonder compressie-overhead en met `Range`-support (resumable, scrubbing in mediaplayers) beter is voor het gebruikelijke geval.

### 2.2 Transport zip-pad: server-side streamende zip over één `GET`, browser-native download

- Client navigeert (`window.location.href = url` of een verborgen `<a download>`-klik) naar `GET /api/download/bundle?...` — **geen** `fetch`+`Blob`: dat laadt de hele zip in geheugen voordat er iets naar schijf gaat, en multi-GB-mappen ontploffen dan de tab. Browser-native navigatie/`<a download>` streamt rechtstreeks naar de Downloads-map met OS-eigen voortgang in de browser-UI zelf.
- Server: `adm-zip` bouwt schrijfarchieven in-memory en is dus **niet geschikt** voor multi-GB streaming zips. Voeg `yazl` toe en laat zijn output naar de response stromen. `adm-zip` blijft voor het bestaande unpack/browse-gebruik. `yazl` voorkomt buffering van de bestandsinhoud, maar een ZIP heeft onvermijdelijk central-directory-metadata per entry; het geheugen groeit dus nog steeds met het aantal bestanden. Leg daarom een configureerbare limiet op voor aantal entries en recursiediepte, en valideer licentie, Node-versiecompatibiliteit en lockfile bij toevoeging.
- `res.setHeader('Content-Type', 'application/zip')`, `Content-Disposition: attachment; filename="…"`, **geen** `Content-Length` (onbekend vooraf bij streaming compressie) — HTTP/1.1 chunked transfer, wat alle moderne browsers prima aankunnen voor downloads.
- De selectie gaat niet mee in de download-URL. De voorafgaande `prepare`-call valideert haar en levert een kortlevend, eenmalig `bundleId`; de download-URL bevat uitsluitend dat capability-token en eventueel geen client-gestuurde naam (§3.2). Daarmee is er geen URL-lengtelimiet voor grote selecties.

### 2.3 Voortgangsmodel: SSE voor het zip-pad, niets voor het single-file-pad

- **Single-file:** een browser-native download (`<a download>` of locatie-navigatie) geeft de pagina geen `onprogress`-events — dat is exact waarom upload bewust XHR gebruikte en download dat pad niet kán volgen zonder de native download-manager van de browser te vervangen door een `fetch`+`ReadableStream`+`Blob`-constructie (die weer de in-memory-limiet van §2.2 introduceert). Besluit: **geen voortgangsbalk voor single-file-downloads**, de browser toont zijn eigen download-indicator (net zoals nu al met de kale `<a download>` in HeadlessFileModal).
- **Zip-bundel:** vóórdat de streaming-download start, vraagt de client `POST /api/download/prepare` aan (analoog aan upload's preflight) die (a) de totale ongecomprimeerde bytegrootte berekent (`lstat` per bestand, recursief voor mappen) en een `bundleId` teruggeeft, en (b) een SSE-kanaal `GET /api/download/:bundleId/progress` opent voordat de daadwerkelijke zip-`GET /api/download/bundle?bundleId=…` start. De server rapporteert **bytes ongecomprimeerd gelezen** (niet verzonden — gecomprimeerde bytes-verzonden zijn geen zinvolle progressmaat voor de gebruiker, die denkt in bestandsgrootte) via hetzelfde SSE-patroon als `/api/tasks/:id/progress` (`apps/web/src/lib/ipc.ts:547-548`). Throttle updates (bijvoorbeeld maximaal 4/s) en stuur altijd een terminal event.
- Dit hergebruikt bewust het **tweede** bestaande progress-patroon (SSE), niet het XHR-patroon van upload — want de browser zelf voert hier de download-request uit (native `<a>`-navigatie), de pagina heeft geen `xhr.onprogress`-haakje op dat request. SSE is de enige manier om server-kant voortgang naar de pagina te krijgen terwijl de browser de daadwerkelijke bytes zelf wegschrijft.

### 2.4 Geen commit engine nodig — dit is een read-only pad

Root-CLAUDE.md's "geen fs-write buiten de commit engine"-regel (`check-no-fs-bypass.js`) betreft mutaties van de bestemmingsboom. Download **leest** alleen (`fs.createReadStream`, recursieve `readdir`); er wordt niets op de server-filesystem geschreven of overschreven. `withStaging`/`commit.js` is dus niet van toepassing — net zoals `/api/fs/raw` er vandaag ook al buiten staat. Wel relevant: de zip wordt **in-flight** opgebouwd en direct naar de HTTP-response gestreamd, nooit als tijdelijk bestand op de server-schijf (geen "half zip-bestand" dat opgeruimd moet worden, geen schijfruimte-verbruik op de server).

### 2.5 Concurrency en annuleren

- Eén download tegelijk per gebruiker is geen harde eis zoals bij upload (browsers regelen hun eigen downloadwachtrij), maar de **zip-bundeling op de server** is wel CPU/IO-werk. De webclient blokkeert een tweede start zolang zijn eigen bundel loopt. De backend heeft geen sessie/tab-identiteit en kan die limiet dus niet eerlijk „per sessie” afdwingen; voeg hoogstens een expliciete, documenteerde globale/configureerbare limiet toe als belasting dat vereist.
- Annuleren van een zip-download gebeurt in de browser-downloadmanager. `req.on('close', …)` op de bundle-route stopt daarna de leesstreams/zip-stream server-side. De pagina kan een native `<a download>`-request niet programmatisch annuleren; een ✕ in het eigen paneel mag daarom alleen de voortgangsweergave sluiten/dismissen, nooit „Annuleren” beloven. De SSE-verbinding is zelfstandig en moet eveneens sluiten bij een terminal event of component-unmount.

---

## 3. Server-ontwerp

### 3.1 Wijziging bestaand endpoint `GET /api/fs/raw` — `Content-Disposition`-header

- Voeg uitsluitend bij `?download=1` een `Content-Disposition: attachment` toe; de route wordt ook gebruikt voor inline preview (afbeeldingen/PDF in `HeadlessFileModal`/`FileViewer`), waar die header de browser zou dwingen te downloaden. Zonder de parameter blijft het gedrag exact gelijk.
- Bouw de header met een geteste helper: een CR/LF- en quote-veilige ASCII-fallback in `filename="…"` **én** een afzonderlijke RFC 5987-parameter `filename*=UTF-8''…` voor niet-ASCII/emoji. Encodeer niet de RFC 5987-waarde in de quoted `filename`-parameter; dat levert voor Unicode-bestanden geen correcte header op.
- Geen andere wijziging aan deze route: `resolveSafePath`, `sendFile`, `acceptRanges` blijven ongemoeid.

### 3.2 Nieuw routebestand `server/routes/download.js`

Eigen bestand, analoog aan `server/routes/upload.js` — eigen streaming-semantiek, past niet in `fs.js`'s JSON-in/JSON-uit-vorm.

**Endpoint A — `POST /api/download/prepare`**

- Body: `{ dir: string, items: string[] }` (relatieve paden t.o.v. `dir`, dezelfde vorm als upload's `rel`).
- Gedrag:
  1. Vereis een niet-lege array binnen een expliciete requestlimiet. `resolveSafePath(dir)`; valideer elk item met `sanitizeRelPath(item)`, dedupliceer het, en bouw de bron met `path.join(resolvedDir, ...cleanRel.split('/'))` plus de bestaande prefix-jailcheck. Controleer dat `dir` werkelijk een directory is.
  2. Loop recursief met `lstat` en `readdir` om totale ongecomprimeerde bytegrootte, bestands- en directorycount te bepalen. Volg nooit symlinks, neem lege directories expliciet op, en begrens entrycount/recursiediepte. Weiger de voorbereiding als geen enkele reguliere file of directoryentry overblijft. Bewaar alleen de gevalideerde relatieve paden; geen volledige bestandslijst in de `Map`.
  3. Genereer een cryptografisch sterk `bundleId` van minstens 128 bits (`crypto.randomBytes(16).toString('hex')`) en bewaar in een korte-TTL in-memory `Map`: `{ dir, items, totalBytes, fileCount, skipped, createdAt, state: 'prepared', listeners }`. TTL 5 minuten. Het token is een eenmalige bearer-capability: zet `Cache-Control: no-store` en `Referrer-Policy: no-referrer` op de bundle-response, en laat het entry atomair van `prepared` naar `active` overgaan vóór de zip-output begint; verwijder het pas bij terminale cleanup.
- Response: `{ bundleId, totalBytes, fileCount, directoryCount, skipped }`. De scan is een momentopname: bestanden kunnen tussen prepare en stream veranderen of verdwijnen; de bundelroute meldt dat via een terminal SSE-fout en mag nooit een HTTP-fout proberen te schrijven nadat de headers al zijn verstuurd.

**Endpoint B — `GET /api/download/bundle?bundleId=…`**

- Haal `bundleId` atomair uit de in-memory `Map`; niet gevonden, verlopen of niet meer `prepared` → 404. Zet het vóór het openen van bestanden op `active`, zodat twee gelijktijdige GETs niet allebei mogen starten, maar bestaande SSE-listeners aan hetzelfde entry gekoppeld blijven.
- Bepaal de archiefnaam server-side uit de gevalideerde selectie (één map → `<mapnaam>.zip`, anders `N-bestanden.zip`), voeg altijd `.zip` toe, en gebruik dezelfde veilige `Content-Disposition`-helper als §3.1. Accepteer geen client-gestuurde `name`-parameter.
- Zip-opbouw met `yazl`: `ZipFile()`, per regulier bestand een zelf geopende stream met `addReadStream` (zodat `data` voor voortgang kan worden geteld); voeg directoryentries inclusief lege mappen expliciet toe en roep `zipfile.end()` precies eenmaal aan nadat de enumeratie klaar is. Gebruik alleen afgeleide, NFC-genormaliseerde relatieve ZIP-namen zonder `..` of absolute prefix. De structuur bevat de geselecteerde top-levelnamen.
- Herhaal `lstat` vlak vóór het openen van ieder bestand en gebruik waar beschikbaar `O_NOFOLLOW` voor het finale bestand. Dit voorkomt de normale symlinkgevallen, maar een padgebaseerde Node-walk is geen volledige bescherming tegen een kwaadaardige TOCTOU-race in een door een andere gebruiker beschrijfbare directory. De bestaande local-origin/trustgrens blijft daarom bepalend; maak van „symlinks niet volgen” geen claim van een sandbox of privilegegrens.
- Houd de geopende readstreams bij. Tel bytes op hun `data`-events, publiceer gethrottlede voortgang, handel stream-/zip-/response-fouten af met één terminal SSE-event en beëindig/destroy daarna alle streams. Bij `req.on('close', …)` wordt dezelfde cleanup uitgevoerd. Een tussentijdse bronfout kan bij een native download hoogstens een mislukte/onvolledige download opleveren; claim in de UI pas „serverstream voltooid” na het terminale succes-event.

**Endpoint C — `GET /api/download/:bundleId/progress`** (SSE)

- Zelfde basispatroon als de bestaande task-SSE (`apps/web/server/routes/tasks.js`, aangeroepen via `listenToTaskProgress` in `apps/web/src/lib/ipc.ts:547-548`): `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, een initiële status en heartbeats. Stuur gethrottlede `progress`-events met `{ bytesRead, totalBytes }` en precies één terminal `complete`, `error` of `aborted`-event. Sta hoogstens één listener per bundle toe of vervang de bestaande listener gecontroleerd.
- Client opent dit **vóór** de navigatie naar endpoint B start (zelfde `bundleId`), zodat er geen voortgang gemist wordt.

### 3.3 Wijzigingen `server/index.js`

- `import downloadRoutes from './routes/download.js'; app.use('/api/download', downloadRoutes);` — kan ná de globale `express.json()` gemount worden (in tegenstelling tot upload): `prepare` is een gewone kleine JSON-body, `bundle` en `progress` zijn beide `GET` zonder body.
- Geen wijziging aan `server.requestTimeout` nodig voor het bundle-pad zelf (dat is al `0` sinds de upload-fix, `BROWSER_UPLOAD_PLAN.md §3.2` — geldt serverbreed, niet per-route), maar wel relevant: grote zip-downloads duren net zo lang als grote uploads, dus deze fix moet blijven staan.

### 3.4 GVFS/CIFS-aandachtspunten

- Lezen van een GVFS/CIFS-mount tijdens zip-opbouw is een gewone sequentiële read — geen atomiciteit nodig zoals bij schrijven, wel: trage FUSE-mounts vertragen de zip-throughput 1:1, geen mitigatie nodig anders dan dat de voortgangsbalk dit zichtbaar maakt (net zoals upload's ETA bij trage shares).
- Symlinks binnen een gedownloade map: **niet volgen** (`fs.lstat` i.p.v. `fs.stat` tijdens scan én bundeling) — een symlink naar `/etc` in een gebruikersmap mag niet stilzwijgend in de zip belanden. Meld de tijdens `prepare` gevonden skips vóór bevestiging; opnieuw ontdekte skips of fouten tijdens de stream komen in het terminale SSE-event. De downloadresponse kan na streaming niet meer betrouwbaar JSON-metadata teruggeven.

---

## 4. Client-ontwerp

### 4.1 Nieuwe module `apps/web/src/lib/download/` (analoog aan `apps/web/src/lib/upload/`)

**`downloadClient.ts`** — transportlaag:

- `prepareDownload(dir, items: string[]): Promise<{ bundleId, totalBytes, fileCount }>` — gewone `fetch`-JSON-POST naar `/api/download/prepare`.
- `startBundleDownload(bundleId, onProgress)`:
  1. Opent `new EventSource(`/api/download/${bundleId}/progress`)`, routeert events naar `onProgress`.
  2. Wacht op een initiële SSE-status of een korte connectie-timeout vóór de daadwerkelijke download via een verborgen, dynamisch aangemaakte `<a href="/api/download/bundle?bundleId=…" download>` + `.click()` start. Dat verkleint, maar elimineert niet volledig, de race tussen EventSource en download-GET.
  3. Sluit de `EventSource` bij een terminal event, component-unmount of een timeout-vangnet. Het returned handle mag alleen de voortgangsweergave sluiten; hij kan de native download niet aborteren.
- `downloadSingleFile(path)`: bouwt web-lokaal de `/api/fs/raw?path=…&download=1`-URL en doet dezelfde verborgen-`<a>`-klik-truc. Breid `convertFileSrc` hiervoor niet uit: het huidige contract beschrijft alleen een asset/preview-URL en deze feature wordt via `showDownload` alleen in de webshell aangeboden. Geen progress (§2.3).

**`downloadStore.ts`** — state voor het downloadpaneel:

```ts
type DownloadItemStatus = 'preparing' | 'streaming' | 'server_complete' | 'error' | 'dismissed';
interface DownloadBatchState {
  id: string; name: string; fileCount: number;
  totalBytes: number; readBytes: number; status: DownloadItemStatus;
  speedBps: number; etaSeconds: number;
}
```

- Alleen relevant voor het zip-pad; single-file-downloads verschijnen niet in dit paneel (er is niets zinvols te tonen, zie §2.3) — precies zoals upload van één bestand wél in `UploadProgress` verschijnt, is dit een bewust verschil, niet een inconsistentie: bij upload heeft de pagina altijd XHR-progress, bij single-file-download nooit.
- Snelheid/ETA-berekening: zelfde rolling-window-aanpak als `uploadStore.ts` (hergebruik het patroon, geen gedeelde module nodig — de databron is fundamenteel anders: SSE-push i.p.v. XHR-poll).

### 4.2 Nieuwe UI-component

- **`apps/web/src/lib/components/DownloadProgress.svelte`** — naast `<UploadProgress/>` in `+page.svelte`, zelfde CSS-grammatica (inklapbare header, voortgangsbalk, ✕-dismiss). Toont alleen zip-bundelbatches (§4.1); „klaar” betekent dat de server de ZIP-stream foutvrij heeft afgesloten, niet dat de browseropslag is bevestigd.
- Geen apart conflict-modal nodig — download overschrijft nooit iets op de server, en de bestandsnaam-bij-dubbele-download-in-Downloads-map is browser-eigen gedrag (`bestand (1).zip`), buiten de app se controle.
- Optioneel maar goedkoop: een lichte bevestigingsstap bij een grote selectie ("12 bestanden, 340 MB downloaden?") ná `prepareDownload` en vóór de daadwerkelijke stream start — voorkomt een per-ongeluk-download van een hele fotomap op mobiel dataverbruik. Gebruik hiervoor `Dialog.svelte`'s bestaande generieke confirm-modus, geen nieuwe dialoogcomponent.

### 4.3 Ingangen

**(a) Contextmenu — item(en) geselecteerd:**

- `packages/ui/src/lib/components/FileList.svelte`, in het item-contextmenu-blok (naast `menu.pack` op regel 789, vóór de separator op regel 791): nieuw item `{ label: $_('menu.download'), action: handleDownload, mnemonicIndex: 0 }`, zichtbaar voor zowel een enkel bestand, een enkele map als een multi-selectie. `handleDownload` gebruikt `getOperationEntries()`; dat levert de huidige selectie op of, bij afwezige selectie, het aangeklikte cursoritem.
- Houd `FileList` shell-neutraal: voeg een optionele callback-prop toe, bijvoorbeeld `onDownload?: (request: { dir: string; entries: FileEntry[] }) => void`. `handleDownload` roept die callback aan; het importeert nadrukkelijk niet `apps/web/src/lib/download/*`. `+page.svelte` geeft de webimplementatie door via `fileListProps` en bepaalt daar single-file versus bundle.
- Achter een nieuwe prop-seam **`showDownload?: boolean`** (default `false`), exact het precedent van `showUpload` (regel 86/97/812) — web zet hem aan (`+page.svelte`), desktop laat hem uit omdat dit browser-specifieke exportfunctionaliteit is. Dit volgt seam-voorkeur 2 (props) uit root-CLAUDE.md, consistent met hoe upload al is opgelost.
- `handleDownload()` verzamelt de entries en delegeert via `onDownload`. De webcallback kiest: precies 1 bestand → `downloadClient.downloadSingleFile(...)`; anders (map, of 2+ items) → `prepareDownload` + bevestiging + `startBundleDownload`.

**(b) Contextmenu — achtergrond (geen selectie):**

- Geen zinvolle actie ("download de hele huidige map" is een grote, makkelijk-per-ongeluk-te-triggeren operatie) — bewust **niet** toegevoegd aan het achtergrond-contextmenu (regel 807-814), analoog aan hoe dat menu ook geen "Pack alles" heeft. Wil een gebruiker de hele map, dan is Ctrl+A + contextmenu-op-selectie de route — één extra stap, voorkomt een misklik-download van een hele schijf.

**(c) Toolbar/menu:**

- `MenuBar.svelte`: item `menu.files.download` in het Bestanden-menu, achter dezelfde `showDownload`-prop, met actie `download-selection`. `MenuBar` heeft nu geen toegang tot de selectie van het actieve `FileList`; maak het dus niet op basis van `selectedEntries` disabled. Voeg `download-selection → handleDownload` toe aan de gedeelde `PANEL_ACTIONS`-routering, waar `getOperationEntries()` ook de cursor als fallback kent.
- `Toolbar.svelte`: geen nieuwe downloadknop in fase 1 (de toolbar is al dicht bij vol; contextmenu + Bestanden-menu zijn voldoende ontdekbaar) — heroverwegen in een latere fase als gebruikersfeedback daarom vraagt.

### 4.4 Mobiel

- Contextmenu (long-press) werkt al identiek aan upload se mobiele bereikbaarheid (`FileList.showContextMenu`, achtergrondtak `packages/ui/src/lib/components/FileList.svelte:481-487` was al long-press-bereikbaar voor upload; hetzelfde route geldt voor het nieuwe item-contextmenu-entry).
- `<a download>` op iOS Safari: opent soms in een nieuwe tab in plaats van direct te downloaden (bekende Safari-eigenaardigheid, geen mitigatie nodig — gebruiker kan van daaruit "Bewaar naar Bestanden" doen). Android Chrome downloadt direct.
- Grote zip-downloads op mobiel dataverbruik → de bevestigingsstap uit §4.2 is hier extra relevant.

### 4.5 i18n

Patroon: `packages/ui/src/lib/locales/{en,nl,de,...}.json` (zes talen, formeel "u" voor Nederlands) — **niet** `server/langs/` (dat is de oudere, pre-monorepo locatie die alleen nog voor iets anders gebruikt lijkt te worden; upload se eigen keys zitten inmiddels ook al in `packages/ui/src/lib/locales/en.json:25-26,114-115,610+`, dus dat is de huidige waarheid, niet `apps/web/server/langs/`). Toevoegen aan alle zes:

- `menu.download` en `menu.files.download`: "Download..." / "Downloaden..."
- Blok `download.*` (spiegelbeeld van het bestaande `upload.*`-blok): `title`, `streaming`, `preparing`, `confirm_large_selection` (met `{count}`/`{size}`-placeholders), `server_completed`, `failed`, `dismiss`.
- Voeg ook de nu ontbrekende `common.download` toe aan alle zes localebestanden en vervang daarmee de drie hardcoded `"Download"`-strings in `HeadlessFileModal.svelte:901,995,1277`. `svelte-check` controleert geen vertaaldekking of hardcoded UI-tekst; voeg daarom een gerichte locale-key/testcheck toe als zo'n gate gewenst is, in plaats van te verwachten dat `npm run check` dit vangt.

---

## 5. Bestandenlijst (aanmaken/wijzigen)

| Bestand | Actie |
|---|---|
| `apps/web/server/routes/download.js` | **Nieuw** — `prepare`, streamende `bundle` (zip via `yazl`), SSE `progress` |
| `apps/web/server/routes/fs.js` | `GET /raw`: `Content-Disposition`-header achter nieuwe `?download=1`-parameter |
| `apps/web/server/lib/security.js` | Hergebruik `resolveSafePath`/`sanitizeRelPath` — geen wijziging verwacht |
| `apps/web/server/index.js` | Mount `/api/download` |
| `apps/web/package.json` | `yazl` toevoegen (streaming zip-writer; `adm-zip` blijft voor lezen) |
| `package-lock.json` | Bijwerken via de workspace-package-manager nadat `yazl` is toegevoegd |
| `apps/web/src/lib/download/downloadClient.ts` | **Nieuw** — prepare-fetch, SSE-listener, verborgen-`<a>`-downloadtrigger |
| `apps/web/src/lib/download/downloadStore.ts` | **Nieuw** — batch-state, speed/ETA |
| `apps/web/src/lib/components/DownloadProgress.svelte` | **Nieuw** — voortgangspaneel naast `UploadProgress` |
| `apps/web/src/lib/components/HeadlessFileModal.svelte` | Aparte `downloadUrl` (`rawUrl` + `download=1`) voor de drie downloadlinks; behoud `rawUrl` voor inline media/preview en vervang de hardcoded string door i18n |
| `apps/web/src/routes/+page.svelte` | Web-callback voor `onDownload`, `showDownload` aan `FileList`/`MenuBar`, mount `<DownloadProgress/>` |
| `packages/ui/src/lib/components/FileList.svelte` | Props `showDownload` + `onDownload`, contextmenu-item en geëxporteerde `handleDownload` |
| `packages/ui/src/lib/components/MenuBar.svelte` | Prop `showDownload`, menu-item `menu.files.download` met actie `download-selection` |
| `packages/ui/src/lib/stores.ts` | `download-selection → handleDownload` in `PANEL_ACTIONS` |
| `packages/ui/src/lib/locales/en.json` (+ nl, de, en overige talen) | `common.download`, `menu.download`, `menu.files.download`, `download.*` en i18n-fix voor de bestaande hardcoded string |

**Ongemoeid:** `express.json()`-limiet, de taskengine, `apiFetch`, `adm-zip`'s bestaande leesgebruik in `archive.js`, de commit engine (`commit.js`/`withStaging` — dit pad schrijft niets), desktop's `FileList`-gebruik (`showDownload` blijft daar `false`, desktop krijgt geen nieuw contextmenu-item).

**Toe te voegen tests:** route-unit/integratietests onder `apps/web/server/tests/` voor prepare-validatie, one-shot bundle-ID, headers, lege directories, symlink-skip en streamfouten; een componenttest of gerichte test voor `download-selection → handleDownload` en de webcallback. Laat de bestaande `npm test --workspace apps/web`, `npm run check` en de root static checks draaien nadat de implementatie er is.

---

## 6. Gefaseerd implementatieplan (elke fase afzonderlijk shipbaar)

### Fase 1 — Single-file download als generieke actie

`?download=1` op `/api/fs/raw`, `downloadClient.downloadSingleFile`, `showDownload` + shell-neutrale `onDownload`-callback, contextmenu-item + Bestanden-menu-item (werkt op selectie of cursoritem), i18n-keys, hardcoded-string-fix in `HeadlessFileModal`.
→ **Resultaat:** downloaden van één bestand is overal ontdekbaar (contextmenu/menu), niet meer verstopt in de preview-modal.

### Fase 2 — Zip-bundel voor mappen en multi-selectie

`server/routes/download.js` (`prepare` + `bundle`, zonder SSE eerst — client toont enkel een "bezig..."-spinner zonder percentage), `yazl`-dependency, contextmenu-item werkt nu ook voor mappen/multi-select, bevestigingsdialoog bij grote selecties.
→ **Resultaat:** downloaden van mappen en meerdere bestanden werkt, zonder gedetailleerde voortgang.

### Fase 3 — Voortgang + polish

SSE-endpoint `progress`, `DownloadProgress.svelte`, speed/ETA, server-side stop na browser-annulering via `req.on('close')`, en symlink-skip-transparantie (`skipped[]` in de UI). De UI biedt alleen dismiss, geen schijn-annuleerknop.

### Fase 4 — Optioneel

Toolbar-downloadknop als gebruikersfeedback daarom vraagt; opstart-sweep van verweesde `bundleId`-entries in de in-memory `Map` (TTL vangt dit al af, dus enkel cosmetisch/geheugenhygiëne bij een zeer lang draaiende server-instantie).

---

## 7. Test- en verificatieplan

1. **Single-file, alle browsers:** contextmenu → Download op een klein bestand, een groot (>1 GB) bestand, een bestand met emoji/spaties/NFD-naam in de bestandsnaam (RFC 5987-encoding-check), en `Range`-gedrag blijft intact voor video/audio-preview (regressie op `acceptRanges`).
2. **Zip-pad, kleine selectie:** 3 bestanden + 1 lege map + 1 map met submappen → gedownloade zip heeft de juiste structuur, juiste bestandsnamen, lege map is aanwezig (of bewust weggelaten — bepaal en documenteer bij implementatie, zip-formaat ondersteunt lege mapentries).
3. **Zip-pad, groot:** map van meerdere GB op een GVFS/CIFS-share → geheugen groeit niet met de bronbytes (wel beperkt met het aantal ZIP-entries); controleer dat met RSS-monitoring en een selectie met veel kleine bestanden. Overschrijding van de entry-/dieptelimiet geeft een duidelijke 4xx-fout vóór een download start.
4. **Annuleren mid-flight:** browser-download annuleren (tab sluiten, "Annuleren" in browser-downloadbalk) → server merkt `req.on('close')`, stopt de leeslus, SSE-verbinding sluit netjes.
5. **Symlinks:** map met een symlink naar een bestand buiten de map en naar een systeempad → beide overgeslagen, zichtbaar gemeld, nooit gevolgd.
6. **Security:** `dir`/`items` met `../`, backslash, NUL en duplicate-pogingen → 400 of gededupliceerde selectie; verlopen of onbekende `bundleId` → 404; twee parallelle GETs met hetzelfde ID leveren hoogstens één stream op; controleer `no-store`/`no-referrer` op de bundle-response en een veilige `Content-Disposition` voor quotes/CRLF/Unicode.
7. **Foutpad en SSE:** bronbestand verdwijnt na prepare of readstream faalt → precies één terminal `error`-event, alle open streams sluiten, geen tweede JSON/HTTP-response na headers. Normale response-close na voltooiing mag niet als abort worden geteld.
8. **Regressie:** `HeadlessFileModal`'s downloadlink blijft werken (met `?download=1` + i18n); `/api/fs/raw` zonder `?download=1` blijft inline-preview-gedrag vertonen (geen `Content-Disposition`); bestaande upload-flow volledig ongewijzigd (andere routebestand, andere dependency).
9. **Mobiel:** Android Chrome + iOS Safari, long-press-contextmenu → Download, single-file en zip-pad; controleer ook dat het eigen paneel geen niet-werkende annuleeractie suggereert.

---

## 8. Risico's en randgevallen

| Risico | Mitigatie |
|---|---|
| **In-memory `bundleId`-map raakt server-instance-gebonden** — bij een herstart/meerdere instanties werkt een oude `bundleId` niet meer | Acceptabel voor de huidige single-instance deployment: TTL is 5 minuten, gebruiker start opnieuw. Bij horizontale schaal is shared affinity/state nodig; documenteer dat als harde randvoorwaarde, geen stilzwijgende Redis-aanname |
| **Querystring-lengtelimiet bij `items` direct in de URL** | Opgelost door het `prepare`+`bundleId`-tussenstap-patroon (§3.2) — de bundle-GET draagt alleen een korte ID |
| **Zip zonder `Content-Length`** kan sommige downloadmanagers een "onbekende grootte"-balk geven i.p.v. een percentage | Acceptabel; het eigen paneel toont de server-side voortgang, maar benoemt duidelijk dat dit geen bevestiging van lokale browseropslag is |
| **Geen voortgang voor single-file-downloads** kan verwarrend zijn bij een zeer groot bestand | Bewuste keuze (§2.3); de browser se eigen downloadbalk toont wél voortgang voor dit pad, dus de gebruiker is niet zonder feedback |
| **Een gewone symlink zou een informatielek zijn** (map delen met een symlink naar `/etc/shadow`) | `lstat` in scan én bundeling, `O_NOFOLLOW` waar beschikbaar en expliciete skip-lijst (§3.4); de afzonderlijke TOCTOU-beperking staat hieronder |
| **Symlink-TOCTOU in een door derden beschrijfbare bronmap** | Vlak vóór lezen opnieuw `lstat`, gebruik `O_NOFOLLOW` waar beschikbaar, en documenteer dat de padgebaseerde Node-implementatie geen sandbox tegen een lokale race-aanvaller is |
| **Dubbele klik op Download start twee keer dezelfde grote zip-opbouw** | Client-side guard voorkomt de gewone dubbelklik; de backend maakt het `bundleId` atomair one-shot. Een harde per-gebruikerlimiet is zonder sessie-identiteit niet implementeerbaar |
| **`yazl` als nieuwe dependency** — extra supply-chain-oppervlak | Leg versie vast via de lockfile en beoordeel licentie/Node-compatibiliteit bij de dependencywijziging; een eigen ZIP-writer is geen klein onderhoudsarm alternatief |
| **Veel kleine bestanden laten ZIP-metadata groeien** | Configureerbare limieten op requestitems, recursiediepte en totale ZIP-entries; meld overschrijding vóór streaming. „Streaming” betekent geen buffering van bestandsinhoud, niet O(1)-geheugen voor oneindig veel entries |
| **Native download is niet vanuit JS annuleerbaar** | Browser-downloadmanager is de enige echte annuleerknop; UI biedt hoogstens dismiss. `req.on('close')` ruimt serverresources op zodra de browser de request verbreekt |
| **Geen auth** (by design, zelfde als upload: origin-guard-trustmodel) | Endpoint valt onder dezelfde CORS/originGuard als de rest; `sanitizeRelPath`/`resolveSafePath` blijven de invoergrens. Behandel `bundleId` bovendien als kortlevende bearer-capability: 128-bit entropie, one-shot, `no-store` en `no-referrer` |
