# Technische Documentatie: Desktop Backend Implementatie voor Archief Testen, Splitsen en Samenvoegen

**Datum**: 10 september 2026  
**Status**: Volledig geïmplementeerd, geverifieerd en samengevoegd  
**Gerelateerde tickets/audits**: QSF-008, QSF-001, QSF-026, FUNCTIONALITEITSAUDIT_2026-09-10  

---

## 1. Doel en Context

Tijdens eerdere kwaliteitsaudits (o.a. QSF-008 en de functionaliteitsaudit van 10 september 2026) werd vastgesteld dat functionaliteiten voor:
1. **Archief integriteitstesten** (`archiveTest` / `archive_test`)
2. **Bestanden splitsen in partities** (`splitFile` / `split_file`)
3. **Bestandspartities samenvoegen** (`combineFiles` / `combine_files`)

wél beschikbaar waren in de web-backend (`apps/web/server/routes/archive.js`), maar ontbraken in de desktop-backend (Tauri/Rust in `apps/desktop/src-tauri`). In de desktop-adapter waren deze functies daarom uitgeschakeld om runtime-crashes ("command not found") te voorkomen.

Deze implementatie voorziet in de volledige native Rust-backend, de registratie van de corresponderende Tauri-commando\x27s, de activering in de desktop IPC-adapter en de integratie met de frontend-dialogen en sneltoetsen.

---

## 2. Veiligheidsarchitectuur en Kwaliteitsstandaarden

Alle bestandswijzigingen en schrijfoperaties voldoen aan de strikte veiligheidsinvariants van NexusCommander:

- **Geen niet-atomaire overschrijvingen (QSF-001 / QSF-026)**:
  Bestanden worden nooit rechtstreeks geopend met `File::create()` (wat een bestaand bestand direct leegkapt vóórdat schrijven voltooid is). In plaats daarvan verlopen zowel `split_file` als `combine_files` via de centrale commit-engine:
  `crate::engine::commit::Staged` in combinatie met `crate::engine::path_policy::PathPolicy`.
- **Transactionele Staging en Rollback**:
  Elke partitie of samengevoegd bestand wordt geschreven naar een uniek tijdelijk staging-bestand in de doelmap. Mocht het proces worden onderbroken, de schijf vol raken of een I/O-fout optreden, dan ruimt de `Drop`-implementatie van `Staged` het tijdelijke bestand automatisch op. Het oorspronkelijke bestand blijft te allen tijde onaangetast.
- **Geen Path Traversal / Symlink Exploits (QSF-003)**:
  `PathPolicy` bewaakt dat paden component voor component worden geopend zonder ongeoorloofde symlink-doorlopen.
- **Geheugenefficiënte Chunking**:
  Zowel bij het splitsen als samenvoegen wordt gebruikgemaakt van een streamingsbuffer (64 KB). Er worden geen willekeurig grote bestanden in het werkgeheugen geladen.
- **Statische Gates**:
  - `scripts/check-ipc-parity.js`: bewaakt dat elk geregistreerd Tauri-commando en elke desktop IPC-aanroep synchroon zijn.
  - `scripts/check-no-fs-bypass.js`: bewaakt dat geen enkele schrijfoperatie de commit-engine omzeilt.

---

## 3. Backend Specificatie (Rust / Tauri)

### 3.1. Archief Integriteit Testen: `archive::test_archive`

```rust
pub fn test_archive(path: &str) -> Result<bool, String>
```

- **Ondersteunde formaten**:
  - **ZIP** (`.zip`):opent het archief met `zip::ZipArchive`, valideert het aantal entries tegen `MAX_ARCHIVE_ENTRIES`, en decomprimeert elke non-directory entry direct naar `std::io::sink()`. De `zip`-crate valideert hierbij automatisch de CRC32-checksum en de compressiestream. Bij een corrupte byte faalt de read en retourneert de functie `Ok(false)`.
  - **TAR en gecomprimeerde varianten** (`.tar`, `.tar.gz`, `.tgz`, `.tar.bz2`, `.tbz2`, `.tar.xz`, `.txz`, `.tar.zst`, `.tzst`):
    Wikkelt de filereader in de juiste decompressor (`flate2`, `bzip2`, `xz2`, `zstd`) en leest alle tar-entries naar `std::io::sink()`. Header- of decompressiefouten resulteren in `Ok(false)`.
  - **Enkele gecomprimeerde bestanden** (`.gz`, `.zst`): decomprimeert naar `std::io::sink()`.
  - **7z** (`.7z`): roept `7z t <pad>` of `7za t <pad>` aan als externe testtool indien aanwezig op het besturingssysteem.
- **Foutafhandeling**:
  - Valide archief: retourneert `Ok(true)`.
  - Corrupt/beschadigd bestand: retourneert `Ok(false)`.
  - Niet-bestaand bestand of niet-ondersteund formaat: retourneert `Err(...)`.

### 3.2. Bestand Splitsen: `archive::split_file`

```rust
pub fn split_file(path: &str, chunk_size: u64, dest_dir: &str) -> Result<crate::vfs::OpResult, String>
```

- **Parameters**:
  - `path`: pad naar het te splitsen bestand.
  - `chunk_size`: grootte in bytes per partitie (moet > 0 zijn).
  - `dest_dir`: directory waarin de partities moeten worden opgeslagen.
- **Gedrag**:
  - Partities worden genummerd met drie of meer cijfers: `<basename>.001`, `<basename>.002`, etc.
  - Elke partitie wordt aangemaakt via `Staged::create(&policy, &part_target, verification, Replace::IfFile)`.
  - Na het vullen van een partitie tot `chunk_size` (of EOF) wordt de partitie atomair gecommit via `staged.commit(Some(bytes_written))`.
  - Retourneert `OpResult::ok("OK")` bij succes.

### 3.3. Bestanden Samenvoegen: `archive::combine_files`

```rust
pub fn combine_files(sources: &[String], dest_path: &str) -> Result<crate::vfs::OpResult, String>
```

- **Parameters**:
  - `sources`: geordende lijst van bronpartities (bijv. `["file.001", "file.002", "file.003"]`).
  - `dest_path`: doelbestandspad.
- **Gedrag**:
  - Valideert dat alle bronbestanden bestaan en dat de lijst niet leeg is.
  - Doelbestand wordt via `Staged::create` klaargezet.
  - Leest bronbestanden sequentieel in blokken van 64 KB en schrijft deze naar de staging stream.
  - Publiceert het gecombineerde bestand pas nadat alle bronbestanden volledig en foutloos zijn geschreven via `staged.commit(Some(total_bytes))`.
  - Retourneert `OpResult::ok("OK")` bij succes.

---

## 4. Tauri Commands en Registratie

In `apps/desktop/src-tauri/src/lib.rs` zijn de volgende commands gedefinieerd:

```rust
#[tauri::command]
async fn archive_test(path: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || archive::test_archive(&path))
        .await
        .map_err(|e| format!("Archive test task error: {}", e))?
}

#[tauri::command]
async fn split_file(
    path: String,
    chunk_size: u64,
    dest_dir: String,
) -> Result<vfs::OpResult, String> {
    tauri::async_runtime::spawn_blocking(move || archive::split_file(&path, chunk_size, &dest_dir))
        .await
        .map_err(|e| format!("Split file task error: {}", e))?
}

#[tauri::command]
async fn combine_files(sources: Vec<String>, dest_path: String) -> Result<vfs::OpResult, String> {
    tauri::async_runtime::spawn_blocking(move || archive::combine_files(&sources, &dest_path))
        .await
        .map_err(|e| format!("Combine files task error: {}", e))?
}
```

Deze commando\x27s zijn geregistreerd in `tauri::generate_handler![...]`.

---

## 5. Frontend Integratie en IPC

### 5.1. IPC Adapter (`apps/desktop/src/lib/ipc.ts`)

De volgende methoden zijn geïmplementeerd en toegevoegd aan `desktopIpc`:
- `archiveTest(path: string): Promise<boolean>`
- `splitFile(path: string, chunkSize: number, destDir: string): Promise<OpResult>`
- `combineFiles(sources: string[], destPath: string): Promise<OpResult>`

Omdat `desktopIpc` deze functies nu levert, evalueren de capability-checks in de gedeelde UI:
- `hasCapability("archiveTest")` -> `true`
- `hasCapability("splitFile")` -> `true`
- `hasCapability("combineFiles")` -> `true`

### 5.2. UI-Acties en Sneltoetsen

1. **Archief Testen**:
   - Menu: **Bestanden -> Archief testen** (`test-archive`).
   - Sneltoets: **Alt + Shift + F9**.
   - Resultaat: toont toastbericht met "Archiefintegriteitscontrole geslaagd." of "Archief is beschadigd of ongeldig.".
2. **Bestand Splitsen**:
   - Menu: **Bestanden -> Bestand splitsen** (`split`).
   - Opent de `split`-dialoog met instelbare chunkgrootte (standaard 1.44 MB of 100 MB voor grote bestanden).
   - In `apps/desktop/src/routes/+page.svelte` wordt `splitFile(paths[0], chunkSize, sourceDir)` aangeroepen.
3. **Bestanden Samenvoegen**:
   - Menu: **Bestanden -> Bestanden samenvoegen** (`combine`).
   - Opent de `combine`-dialoog met automatisch voorgestelde doelbestandsnaam (ontdaan van `.001`).
   - In `apps/desktop/src/routes/+page.svelte` wordt `combineFiles(paths, value.trim())` aangeroepen.

---

## 6. Verificatie en Testresultaten

De implementatie is geverifieerd via de volledige gate-suite (`./scripts/verify.sh`):

1. **Rust Tests (`cargo test`)**:
   - `test_archive_valid_and_corrupt_zip`: geslaagd.
   - `test_archive_valid_and_corrupt_tar_gz`: geslaagd.
   - `test_archive_nonexistent_returns_err`: geslaagd.
   - `test_split_and_combine_roundtrip`: geslaagd (round-trip splitsen van 5000 bytes in blokken van 1024 bytes en foutloos samenvoegen).
   - `test_split_invalid_chunk_size`: geslaagd.
   - `test_combine_empty_sources`: geslaagd.
   - Totaal: **175 geslaagd** in Rust (0 fouten).
2. **IPC Parity Gate (`scripts/check-ipc-parity.js`)**:
   - 60 commando\x27s in beide richtingen exact synchroon.
3. **Commit Engine Gate (`scripts/check-no-fs-bypass.js`)**:
   - 0 schendingen; alle schrijfoperaties lopen via transactionele staging.
4. **Rust Lints & Formatting**:
   - `cargo fmt --check`: pass.
   - `cargo clippy -D warnings`: pass (0 warnings).
5. **UI Regressietests (`npm run test:ui`)**:
   - 69/69 UI-tests geslaagd.
6. **Applicatiebuilds**:
   - Zowel de desktopfrontend als de webfrontend bouwen foutloos (`npm run build`).
