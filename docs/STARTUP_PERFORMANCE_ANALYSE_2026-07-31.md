# Startup-performance: analyse en maatregelen

**Vastgesteld:** 2026-07-31
**Aanleiding:** de desktop-shell voelde traag bij het starten — het venster
verscheen pas seconden nadat het proces was gestart.
**Uitkomst:** één oorzaak verklaarde ~85% van de gevoelde starttijd en is
opgelost. De rest staat als backlog in "Nog openstaand".

## Samenvatting

De applicatie was al ~1,4 s na launch volledig ingeladen — beide panelen
gelezen, thema en taal toegepast — maar het venster werd pas na **8,2 s**
zichtbaar. Die 6,8 s was zuiver wachten: `revealWindow()` in
`apps/desktop/src/routes/+page.svelte` wachtte op twee animatieframes die een
verborgen venster nooit levert, waardoor het venster in de praktijk altijd door
de noodklep in `src-tauri/src/lib.rs` werd getoond in plaats van door de
frontend.

## Meetmethode

Beide shells zijn gemeten met `strace -f -ttt` op syscall-niveau, met vier
markers die elk een fase afbakenen:

| Marker | Syscall | Betekent |
|---|---|---|
| GTK-init | `openat` op `gtk.css` | GTK is opgestart |
| Rust `load_settings` | `openat` op `nexuscmd.ini` (1e) | `setup()` draait |
| webview parst `app.html` | `openat` op `localstorage` | het inline themascript liep |
| frontend JS draait | `openat` op `nexuscmd.ini` (2e) | `startApp()` in `onMount` |
| panelen geladen | `getdents64` op de tabpaden | `loadDirectory()` klaar |

Het moment waarop het venster werkelijk verschijnt is apart gemeten door de
applicatie met `GDK_BACKEND=x11` te starten en `xwininfo -root -tree` te pollen
tot de venstertitel in de boom staat. Dat is nodig omdat de sessie standaard op
Wayland draait, waar `xwininfo` het venster niet ziet.

**Let op bij hermeten:** een run direct na een vorige geeft een vals-positieve
meting van enkele milliseconden, omdat het venster van de vorige run nog even in
de X-boom hangt. Laat er een paar seconden tussen.

## Meetresultaten (release-build, warme cache)

| Fase | Tijd |
|---|---|
| GTK-init | +119 ms |
| Rust `load_settings` | +300 ms |
| webview parst `app.html` | +567 ms |
| frontend JS draait | +805 ms |
| beide panelen ingelezen | +1337 ms |
| **venster zichtbaar** | **+8205 ms** |

`npm run dev:desktop` ligt daar bovenop: met een koude Vite-transformcache draait
de frontend-JS pas na +2869 ms (warm: +1496 ms), maar het venster verscheen ook
daar consistent pas na ~8,2 s — hetzelfde plafond, dezelfde oorzaak.

## Oorzaak

`revealWindow()` deed `await tick()` gevolgd door twee
`requestAnimationFrame`-awaits, en riep daarna pas `show()` aan. Het venster
wordt echter verborgen aangemaakt (`visible: false` in `tauri.conf.json`), en
**WebKitGTK draait geen animatieframes voor een venster dat niet gemapt is**. De
frames waarop werd gewacht konden dus pas komen nádat het venster zichtbaar was
— precies wat die functie zelf had moeten doen. Een cirkel.

Bevestigd met tijdelijke IPC-probes tussen elke await (elke probe is een
`get_path_info` op een uniek pad, zichtbaar in `strace`):

```
enter        +2033 ms
after_tick   +2181 ms
after_raf1   +8607 ms   ← pas nadat Rust het venster al had getoond
after_raf2   +8712 ms
```

Wat het venster in werkelijkheid toonde was de vangnet-thread in `lib.rs`, die
na 8 s controleerde of het venster zichtbaar was en het anders alsnog toonde.
Die was bedoeld voor het geval de frontend crasht tijdens het opstarten, maar
was verworden tot de enige route — en daarmee tot de facto starttijd.

## Wat is gewijzigd

**`apps/desktop/src/routes/+page.svelte`** — elke `requestAnimationFrame` is
begrensd met een timer van 50 ms. Waar rAF wél loopt verandert er niets; waar het
niet loopt kost het maximaal 100 ms in plaats van oneindig.

**`apps/desktop/src-tauri/src/lib.rs`** — de vangnettimer van 8 s naar 3 s. Nog
altijd ruim boven het eigen pad van de frontend (~1,4 s), maar kort genoeg dat
een echte opstartfout niet als een hang overkomt.

### Waarom dit de flikkerbescherming niet aantast

De twee rAF-awaits waren de vierde van vier lagen die voorkomen dat de gebruiker
een verkeerd getemad of onvertaald venster ziet. De andere drie liggen allemaal
vóór dit punt en zijn ongemoeid gelaten:

1. `theme_startup_color()` / `native_window_theme()` in `lib.rs` verven de
   native frame in het opgeslagen thema, nog voordat de webview bestaat.
2. Het inline script in `app.html` zet `data-theme` en de achtergrondkleur uit
   `localStorage` vóór de eerste paint.
3. `await tick()` garandeert dat Svelte het thema en de taal al in de DOM heeft
   geflusht.

Wat de rAF-paren daarbovenop leverden was het bewijs dát die frame ook
gecommit was. Op een verborgen venster is dat bewijs niet te krijgen — de
timeout-route toont dus dezelfde pixels, alleen zonder dat extra bewijs.

### Resultaat

Venster zichtbaar, drie runs per meting, telkens met een pauze ertussen:

| | vóór | na |
|---|---|---|
| release | 8205 / 8256 ms | 1186 / 1240 / 1559 ms |
| dev | 8195 / 8217 ms | 1188 / 1513 ms |

Daarmee valt het venster nu samen met het moment waarop de applicatie
werkelijk klaar is (panelen ingelezen op +1337 ms) in plaats van er 6,8 s op
te wachten.

## Nog openstaand

Deze drie zijn wél onderzocht en gekwantificeerd, maar niet doorgevoerd.

### 1. CodeMirror en `lucide-svelte` staan in de initiële chunk

`+page.svelte` importeert `TextEditorModal` statisch → `FileEditor` → negen
CodeMirror-taalpakketten. De gebouwde pagina-chunk is daardoor 1,23 MB en bevat
de hele editor (`cm-gutter` komt er 17× in voor), terwijl die pas bij F4 nodig
is. In dev is het effect veel groter: van de 274 modules / 18,1 MB die de webview
bij élke start ophaalt is CodeMirror 9,2 MB en de `lucide-svelte`-barrel 4,95 MB
— samen 78%.

Maatregel: `TextEditorModal` achter een dynamische import, en lucide via deep
imports (`lucide-svelte/icons/layers`) in plaats van de barrel.

### 2. `get_drives` is een latent risico op netwerkmounts

`DriveBar.svelte` pollt elke 3 s en er zijn twee panelen, dus twee timers; daar
bovenop staat `checkPathValidity` in `FileList.svelte` op 2,5 s. Gemeten op een
werkstation met 9 CIFS/NFS-mounts: **24 sweeps per minuut, 240 `statvfs` op
netwerkmounts per minuut in rust**.

Zolang alle servers online zijn kost een sweep ~14 ms en valt het niet op. Maar
`collect_drives()` in `vfs.rs` doet die `statvfs`-aanroepen sequentieel in één
`spawn_blocking`-taak, dus één onbereikbare server blokkeert de hele lijst tot de
mount-timeout (CIFS standaard ~60 s). Ook triggert de `Path::exists()`-controle
een automount op autofs-entries die nog niet gemount zijn.

Maatregel: pollinterval omhoog en alleen bij vensterfocus, `get_disk_space`
alleen voor de zichtbare drive, en een timeout per mount.

### 3. Kleine posten

- Alle zes locales staan eager in de initiële chunk (`import.meta.glob(…, {
  eager: true })` in `packages/ui/src/lib/i18n.ts`, ~163 KB JSON). Alleen `en`
  eager houden en de actieve taal lazy laden scheelt parse-tijd bij elke start.
- `static/favicon.png` is 202 KB en `favicon.ico` 93 KB, voor een desktop-app
  die ze niet nodig heeft.

## Los hiervan opgemerkt

`cargo clippy -D warnings` is rood op `archive.rs:1984-1985`
(`double_ended_iterator_last`, tweemaal `.split('/').last()` dat
`.next_back()` moet zijn). Dat dateert van vóór dit werk en blokkeert
`npm run verify`.
