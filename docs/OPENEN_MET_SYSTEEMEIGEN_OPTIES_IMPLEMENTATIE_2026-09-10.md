# Technische Documentatie: Systeemeigen Opties voor "Openen met..." in Web en Desktop

**Datum**: 10 september 2026  
**Status**: Geïmplementeerd; web-backend nagecorrigeerd op 10 september 2026 (zie §4)  
**Gerelateerde componenten**: `open_with.rs`, `desktopIpc` (`ipc.ts`), `apps/web/server/routes/system.js`, `FileList.svelte`, `packages/ui/src/lib/locales/`  

---

## 1. Doel en Probleemanalyse

De contextmenu-optie **"Openen met..."** (`common.open_with`) stelt gebruikers in staat om een bestand of map te openen met externe, op het besturingssysteem geïnstalleerde applicaties of systeemeigen tools.

Voorafgaand aan deze implementatie vertoonde deze functionaliteit ernstige beperkingen en een blokkerende runtime-fout:

1. **Desktop IPC-blokkade**:
   In `FileList.svelte` werd vóór het opvragen van systeemmapps gecontroleerd op `capabilities.desktopOpenAvailable` via `await getSystemCapabilities()`. In `apps/desktop/src/lib/ipc.ts` ontbrak echter een implementatie van `getSystemCapabilities`. Hierdoor wierp de IPC-aanroep `TypeError: d().getSystemCapabilities is not a function`. Een omliggend `try/catch`-blok ving dit stil op, waardoor op desktop **altijd 0 applicaties** werden getoond en het submenu uitsluitend de ingebouwde "Interne editor" bevatte.
2. **Beperkte app-detectie via paden**:
   Zowel de Rust-backend (`src-tauri/src/open_with.rs`) als de Node.js webserver (`apps/web/server/routes/system.js`) doorzochten slechts 3 hardcoded mappen (`/usr/share/applications`, `/usr/local/share/applications`, `~/.local/share/applications`). Moderne Linux-applicaties geïnstalleerd via **Snap** (`/var/lib/snapd/desktop/applications`), **Flatpak** (`/var/lib/flatpak/exports/share/applications`, `~/.local/share/flatpak/exports/share/applications`) of via `$XDG_DATA_DIRS` werden hierdoor volledig gemist.
3. **Mimetype-subtypen en ontbrekende standaarden**:
   De app-zoekmethode voerde slechts een letterlijke stringvergelijking uit op `a.mime_types.contains(&mimetype)`. Voor veel voorkomende bestanden zoals `package.json` (`application/json`) of `README.md` (`text/markdown`) resulteerde dit in 0 gevonden applicaties, omdat teksteditors (zoals GNOME Text Editor of Gedit) in hun `.desktop`-bestand uitsluitend `text/plain` declareren en het besturingssysteem ze via `gio mime` aanwijst als standaard.
4. **Beperkte acties**:
   Het submenu bevatte geen directe systeemeigen acties om het bestand met de OS-standaardhandler, de externe systeemeditor, een terminal in de betreffende map of via de systeemeigen bestandsbeheerder te openen.

---

## 2. Architectuur en Implementatiedetails

### 2.1. Desktop IPC Adapter (`apps/desktop/src/lib/ipc.ts`)

In `desktopIpc` is `getSystemCapabilities` geïmplementeerd:

```typescript
export async function getSystemCapabilities(): Promise<SystemCapabilities> {
  return {
    headless: false,
    desktopOpenAvailable: true,
    browserPreviewAvailable: true,
    conversionAvailable: false,
    transcodingAvailable: false,
  };
}
```

Hierdoor levert `desktopIpc` de volledige contractvorm voor capabilities, waardoor `FileList.svelte` zonder excepties de systeemeigen desktopmogelijkheden herkent.

### 2.2. Desktop Backend: Rust Tauri (`apps/desktop/src-tauri/src/open_with.rs`)

1. **Uitgebreide applicatiedirectories (`desktop_app_dirs`)**:
   - `~/.local/share/applications`
   - `~/.local/share/flatpak/exports/share/applications`
   - `/usr/local/share/applications`
   - `/usr/share/applications`
   - `/var/lib/flatpak/exports/share/applications`
   - `/var/lib/snapd/desktop/applications`
   - Alle mappen uit `$XDG_DATA_DIRS` (met `/applications` suffix)
2. **Systeemeigen GIO- en XDG-integratie**:
   - `query_gio_mime_apps(mimetype: &str)` roept `gio mime <mimetype>` aan om de geregistreerde en aanbevolen applicaties van het OS op te halen.
   - Fallback naar `xdg-mime query default <mimetype>`.
   - Garandeert dat de standaardapplicatie altijd wordt opgenomen en gemarkeerd met `is_default: true`.
3. **Ondersteuning voor tekstsubtypen**:
   - Voor bestanden van het type `text/*` of subtypen (`application/json`, `application/javascript`, `application/xml`, `application/x-sh`, `application/x-yaml`, `application/toml`, `application/x-desktop`) worden tevens geïnstalleerde applicaties toegevoegd die `text/plain` ondersteunen.
4. **Icoonpad-resolutie (`resolve_icon_path`)**:
   - Vertaalt symbolische/naamicoontjes (bijv. `firefox`, `org.gnome.TextEditor`) naar absolute paden in `/usr/share/pixmaps` of `/usr/share/icons/hicolor/...` zodat de frontend ze kan renderen.
   - Levert `None` wanneer niets resolvet. De retourwaarde belooft een pad, dus
     een kale iconnaam is geen geldig antwoord: de frontend hoeft niet uit de
     string af te leiden of het werkelijk een pad is. `resolveIconPath` in de
     web-backend geeft om dezelfde reden `null`.
5. **Veiligheidsvalidatie (`is_known_desktop_entry`)**:
   - Valideert dat de doorgegeven `desktop_entry` daadwerkelijk in een van de bekende applicatiemappen bestaat en weigert padseparators/traversals.

### 2.3. Web Backend: Node.js Express (`apps/web/server/routes/system.js`)

In `GET /system/open-with`:
- `getDesktopAppDirs()` doorzoekt dezelfde XDG-, Snap- en Flatpak-paden.
- `queryGioMime(mimetype)` leest OS-associaties via `gio mime`.
- `resolveIconPath(icon)` vertaalt iconen naar absolute bestandspaden, en geeft
  `null` wanneer niets resolvet — de web-tegenhanger van `resolve_icon_path`.
- Mimetype-filtering ondersteunt tevens `text/plain`-editors voor tekst-/code-subtypen.
- `isLaunchable(entry)` filtert entries waarvan het binary ontbreekt (`TryExec`/
  `Exec`, opgezocht via `PATH`) of die een terminal vereisen — de web-tegenhanger
  van `is_launchable` in `open_with.rs`.
- `isKnownDesktopEntry(fileName)` valideert de door de client aangeleverde
  `desktopEntry` tegen dezelfde applicatiemappen, en weigert padseparators en
  `..` — de web-tegenhanger van `is_known_desktop_entry`. `POST /open-file-with`
  en `POST /set-default-app` gebruiken deze guard vóór `gtk-launch`/`xdg-mime`.

### 2.4. Gedeelde Frontend: Contextmenu (`packages/ui/src/lib/components/FileList.svelte`)

Het submenu voor **"Openen met..."** is nu als volgt gestructureerd:

```
[Bestand / Map] Contextmenu -> Openen met...
  ├── [Icoon] <Systeemmapp 1 (bijv. Firefox)>  (○ Altijd)
  ├── [Icoon] <Systeemmapp 2 (bijv. Text Editor)> (● Altijd)
  ├── ──────────────────────────────────────
  ├── Systeemtoepassing (standaard)           (openFile)
  ├── Systeemeigen teksteditor                (openInEditor)
  ├── Systeemeigen terminal                   (openTerminal)
  ├── Systeemeigen bestandsbeheerder          (openFile op de map)
  ├── Openen op deze computer (indien web)    (openOnThisComputer)
  ├── ──────────────────────────────────────
  ├── Interne editor                          (F4)
  └── Interne viewer                          (F3)
```

- **Voor mappen**: Het contextmenu biedt tevens een "Openen met..."-optie voor mappen met de systeemeigen bestandsbeheerder (bijv. Nautilus/Verkenner), terminal en eventuele mapbeheer-apps (zoals Double Commander of Baobab).

### 2.5. Lokalisatie & Vertalingen

De nieuwe menuteksten zijn toegevoegd aan alle 6 ondersteunde talen (`en`, `nl`, `de`, `fr`, `es`, `pt`) in zowel `packages/ui/src/lib/locales/` als `apps/web/server/langs/`:
- `common.system_default`
- `filelist.system_editor`
- `filelist.system_terminal`
- `filelist.system_file_manager`
- `filelist.internal_viewer`

---

## 3. Verificatie en Kwaliteitsgaranties

Alle gates gedraaid via `npm run verify` — **All gates passed**:

1. **`npm run check`**: `apps/desktop` en `apps/web` beide 0 fouten; alle 6 talen
   synchroon met `en.json`.
2. **`npm run check:static`**: plugin-loader, versies, CSP, shell-injectie,
   IPC-pariteit (60 commando's, beide richtingen) en fs-bypass — alle geslaagd.
3. **UI-testsuite (`npm run test:ui`)**: 82 van 82 geslaagd.
4. **Rust (`cargo test` / `fmt --check` / `clippy -D warnings`)**: geslaagd.
5. **Web backend (`npm test -w apps/web`)**: 149 geslaagd, 0 fouten, 3 overgeslagen.

---

## 4. Correcties na review (10 september 2026)

Een controle van de hierboven beschreven implementatie tegen de code bracht drie
afwijkingen aan het licht. De desktop-kant (`open_with.rs`, `ipc.ts`), de
gedeelde frontend en de lokalisatie bleken volledig conform; de afwijkingen zaten
alle in de web-backend en in de testdekking.

### 4.1. Ontbrekende validatie van `desktopEntry` (beveiliging)

`POST /system/open-file-with` en `POST /system/set-default-app` controleerden de
door de client aangeleverde `desktopEntry` uitsluitend op "is een niet-lege
string", en gaven die daarna door aan `gtk-launch` respectievelijk `xdg-mime`.
De desktop-kant had hiervoor al `is_known_desktop_entry`; de web-kant niet,
terwijl juist die over HTTP bereikbaar is.

**Correctie**: `isKnownDesktopEntry()` toegevoegd en toegepast op beide routes.

### 4.2. Ontbrekend `isLaunchable`-filter (functioneel)

`listDesktopApps()` filterde alleen op `NoDisplay`/`Hidden`. Entries waarvan het
binary niet geïnstalleerd is (het `vim-common`-geval: `vim.desktop` aanwezig,
`vim` niet) en terminalapplicaties — die via `gtk-launch` stil falen — werden
daardoor in het web-submenu getoond. `open_with.rs` filtert deze al weg.

**Correctie**: `execBinaryFromExecLine()`, `binaryExists()` en `isLaunchable()`
toegevoegd, gespiegeld op de Rust-implementatie, en toegepast in
`listDesktopApps()`.

### 4.3. Fouten bij starten werden ingeslikt

`/open-file-with` riep `execFile('gtk-launch', …)` aan zonder callback en
antwoordde onvoorwaardelijk `{ success: true }`. Een mislukte start bereikte de
gebruiker dus nooit.

**Correctie**: vervangen door `await execFileAsync(…)`, zodat een fout via de
bestaande `catch` als HTTP-fout terugkomt.

### 4.4. Testsuite toetste broncodetekst in plaats van gedrag

`scripts/tests/open-with.test.js` bestond volledig uit `src.includes("…")`-asserties
op de brontekst. Die bleven groen terwijl §4.1–4.3 hierboven ontbraken — precies
het faalpatroon dat CLAUDE.md onder *"Verify a check can fail"* beschrijft.

**Correctie**: herschreven naar gedragstests tegen de daadwerkelijke functies
(daarvoor zijn de helpers uit `system.js` geëxporteerd). Elke nieuwe guard is
vervolgens opzettelijk gebroken om te bevestigen dat de test rood wordt:

| Gebroken guard | Resultaat |
| --- | --- |
| `isKnownDesktopEntry` uit `/open-file-with` verwijderd | 1 test faalt |
| `isLaunchable` altijd `true` | 2 tests falen |
| `..`-controle uitgeschakeld | 1 test faalt |

De `..`-test bleek bij de eerste poging groen te blijven omdat elk testgeval óók
een padseparator bevatte, waardoor die guard de uitkomst bepaalde. De test is
uitgebreid met een naam die wél `..` maar géén separator bevat.

### 4.5. Opgeruimd

`DESKTOP_APP_DIRS` — een op module-niveau berekende constante die na de
herstructurering nergens meer werd gelezen — is verwijderd. De directorylijst
wordt nu overal via `getDesktopAppDirs()` per aanroep bepaald, zodat een
tussentijds geïnstalleerde applicatie zonder herstart wordt gezien.
