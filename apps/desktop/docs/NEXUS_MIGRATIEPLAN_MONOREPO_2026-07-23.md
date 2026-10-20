# Migratieplan: NexusCommander → monorepo (Desktop + Web/PWA gedeelde frontend)

**Datum:** 2026-07-23
**Vervolg op:** [NEXUS_DIFF_ANALYSE_DESKTOP_VS_PWA_2026-07-23.md](../../docs/archive/NEXUS_DIFF_ANALYSE_DESKTOP_VS_PWA_2026-07-23.md)
**Doel:** één repo met een gedeelde Svelte-frontend die twee (later drie) shells voedt: Tauri-desktop (Linux/macOS/Windows) en SvelteKit+Express web/PWA.
**Leidend principe:** nieuwe functionaliteit van **Desktop (0.8.32) gaat voor** bij ties. Gemarkeerde uitzonderingen (⚠️) waar de PWA vóórligt worden geport i.p.v. overschreven.

---

## Kernrandvoorwaarden (uit de diff-analyse)

1. **0 gedeelde git-commits** → geen native `git merge`; reconciliatie per bestand.
2. **Drift is tweerichtings** → per-bestand beleid, geen blinde overlay.
3. **Backends blijven gescheiden** (Tauri capability-model vs Express-over-HTTP) → alleen frontend delen.
4. **`FilePropertiesDialog` ⚠️** → PWA ver vooruit; vereist nieuwe Tauri-commands (`set_permissions`, `chown`, `get_users_groups`, `size_on_disk`).
5. **i18n** → desktop's gebundelde `locales/*.json` wordt de standaard.

---

## Doelstructuur

```
NexusCommander/                        (één repo)
├── package.json                        # npm workspaces root
├── packages/
│   ├── ui/                             # GEDEELD: alle .svelte, stores, theme, i18n,
│   │   ├── src/lib/components/         #   utils, plugin-api, iconMap, locales/*.json
│   │   ├── src/lib/ipc-contract.ts     #   ← de interface (geen implementatie)
│   │   └── package.json                #   name: "@nexus/ui"
│   └── core/                           # (optioneel) gedeelde types/logica zonder Svelte
├── apps/
│   ├── desktop/                        # Tauri-shell
│   │   ├── src/                        #   +page.svelte (app-shell), routes
│   │   ├── src/lib/ipc.ts              #   ← invoke()-adapter (implements ipc-contract)
│   │   ├── src-tauri/                  #   Rust-backend (ongewijzigd overgenomen)
│   │   └── package.json
│   └── web/                            # SvelteKit + Express-shell
│       ├── src/                        #   +page.svelte (app-shell), upload/*, TitleBar
│       ├── src/lib/ipc.ts              #   ← fetch()-adapter (implements ipc-contract)
│       ├── server/                     #   Express-backend (ongewijzigd overgenomen)
│       └── package.json
└── docs/
```

**Tooling:** npm workspaces (beide projecten gebruiken al npm; geen nieuwe package manager nodig). Desktop's `vite.config.js` heeft al `resolve.preserveSymlinks: true` — cruciaal voor gesymlinkte workspace-packages. Turborepo/Nx is optioneel voor build-caching; niet nodig om te starten.

---

## Fase 0 — Voorbereiding & beslissingen (½ dag)

| Stap | Actie | Acceptatie |
|------|-------|-----------|
| 0.1 | Nieuwe repo `NexusCommander` aanmaken op Forgejo. | Repo bestaat. |
| 0.2 | **Git-historie behouden**: importeer beide bestaande repos als subtree (`git subtree add --prefix=apps/desktop <desktop-remote> main` en idem `apps/web`). Zo overleeft `git blame`/log van beide kanten. | `git log apps/desktop` en `git log apps/web` tonen oude historie. |
| 0.3 | **Synthetische voorouder zoeken** (accelerator): check desktop-commit *"Baseline commit before PWA portplan"* uit en diff tegen PWA-releases (v0.8.0…v0.8.28) om de dichtstbijzijnde te vinden. Die snapshot dient als 3-way merge-base per bestand. | Merge-base-versie geïdentificeerd of bewust verworpen. |
| 0.4 | Beslissen: `packages/core` wel/niet (aparte non-Svelte types/logica). **Aanbeveling:** starten zonder; types in `packages/ui/src/lib/types.ts`, splitsen als het knelt. | Beslissing genoteerd. |
| 0.5 | Baseline-testnet: draai beide apps één keer, screenshot de hoofdschermen als visuele regressie-referentie. | Referentiebeelden opgeslagen. |

**Alternatief voor 0.2** als subtree te complex is: desktop-repo *is* de basis (leidende versie) → hernoem naar monorepo-structuur binnen deze repo, voeg `apps/web` toe vanuit PWA-content (historie PWA dan via `git subtree`).

---

## Fase 1 — Scaffold monorepo, beide apps ongewijzigd groen (1 dag)

Doel: de mappen staan goed en **beide apps builden nog exact zoals nu**, vóór er ook maar één regel gedeeld wordt. Strangler-aanpak: eerst het skelet, dan pas vlees verplaatsen.

1.1 Root `package.json` met `"workspaces": ["packages/*", "apps/*"]`.
1.2 Verplaats desktop-code naar `apps/desktop/`, PWA-code naar `apps/web/`. `src-tauri/` en `server/` gaan integraal mee.
1.3 Maak lege `packages/ui` met `package.json` (`"name": "@nexus/ui"`), nog zonder inhoud.
1.4 Beide apps: `svelte.config.js`/`vite.config.js` ongewijzigd (ze zijn al identiek qua adapter).
1.5 **Acceptatie:** `npm --workspace apps/desktop run build` én `npm --workspace apps/web run build` slagen. `tauri dev` en `npm --workspace apps/web start` draaien. **Geen functionele wijziging.**

> Vanaf hier geldt: na elke verplaatsing moeten **beide apps blijven builden**. Nooit twee bestanden tegelijk verhuizen zonder groene build ertussen.

---

## Fase 2 — De `ipc`-interface extraheren (de adapter-grens) (1 dag)

Dit is het scharnier van de hele operatie.

2.1 Vergelijk de exports van beide `ipc.ts` (desktop 442 rgls / web 530). Stel de **unie** van functie-signatures vast → `packages/ui/src/lib/ipc-contract.ts`:
```ts
export interface NexusIpc {
  readDirectory(path: string): Promise<FileEntry[]>;
  getDrives(): Promise<DriveInfo[]>;
  getPathInfo(path: string): Promise<PathInfo>;
  // … volledige unie van beide kanten
  setPermissions?(path: string, mode: string): Promise<OpResult>; // web heeft dit al; desktop krijgt het (Fase 4)
}
```
2.2 Functies die maar aan één kant bestaan → optioneel (`?`) in het contract, met capability-detectie (`ipc.setPermissions?.(…)`), zodat de UI degradeert i.p.v. crasht.
2.3 `packages/ui` krijgt een **injectiepunt**: een Svelte context of module-singleton `getIpc(): NexusIpc`. Elke app zet zijn implementatie bij opstart (`setIpc(desktopIpc)` / `setIpc(webIpc)`).
2.4 Desktop `apps/desktop/src/lib/ipc.ts` en web `apps/web/src/lib/ipc.ts` implementeren `NexusIpc` (invoke- resp. fetch-adapter). Blijven in de apps, niet in `packages/ui`.
2.5 **Acceptatie:** beide apps importeren `NexusIpc` uit `@nexus/ui`, injecteren hun adapter, builden groen.

---

## Fase 3 — Gedeelde UI consolideren, oplopend risico (3–5 dagen)

Per bestand naar `packages/ui/src/lib/…` verplaatsen; app-imports naar `@nexus/ui` herwijzen. **Volgorde = risico-oplopend** (zie categorieën diff-analyse). Desktop is de brontekst tenzij anders vermeld.

### 3a. Identiek/triviaal — kopiëren, nul reconciliatie (9)
`FileEditor.svelte`, `help/topics.json`, `plugin-api.ts`, `utils/smartPoller.ts`, `+layout.ts`, `playerStore.ts` (2 diff), `TreeView.svelte` (3 diff), + de twee triviale.
→ Verplaats naar `packages/ui`, verwijder uit beide apps. Groene build = klaar.

### 3b. Kleine drift — merge, desktop leidend (11)
`theme.ts`, `utils.ts`, `MultiRenameModal`, `HotlistModal`, `ActionPalette`, `stores.ts`, `NetworkConnectionsModal`, `MiniPlayer`, `ContextMenu`, `iconMap.ts` (desktop wint: meer mappings), `FunctionKeyBar`.
→ Per bestand: 2-way diff, desktop als basis, PWA-only toevoegingen erin, platform-takjes achter `getIpc()`-capability. Groene build beide apps.

### 3c. Middelgrote drift — bewuste merge (10)
`SearchModal`, `TaskProgress`, `FolderTabs`, `Toolbar`, `DriveBar` (desktop wint), `TwinPanels`, `DropMenuModal`, `FileViewer`.
`i18n.ts` en `types.ts` → **niet** in 3c; zie Fase 5 resp. hieronder.
→ `types.ts`: splits in **gedeelde subset** (`packages/ui`) + **app-specifieke DTO's** (blijven in app). PWA heeft 254 vs 127 regels (meer backend-DTO's) — die web-only types blijven in `apps/web`.

### 3d. Zware drift — per-bestand playbook → **Fase 4**.

**Acceptatie Fase 3:** alle categorie a/b/c-bestanden staan in `packages/ui`; beide apps builden en draaien; visuele check tegen referentiebeelden (Fase 0.5).

---

## Fase 4 — Zware bestanden, per-bestand playbook (4–7 dagen)

### `OptionsDialog.svelte` (1436 diff) — **Desktop wint** ✓
Desktop heeft opgeslagen views/layouts (`handleSaveView/SaveAs/Delete/Rename/ViewChange`).
- Basis = desktop. Port PWA's `handleHelp` erin.
- Naar `packages/ui`.

### `Dialog.svelte` (877 diff) — **Desktop wint** ✓
Desktop heeft folder-picker + pack-opties (`loadPickerDir`, `selectPickerFolder`, `goUpPicker`, `getDefaultExtension`, `handlePack*`).
- Basis = desktop. Web gebruikt dezelfde dialog; folder-picker draait via `getIpc().readDirectory` (werkt in beide).
- Naar `packages/ui`.

### ⚠️ `FilePropertiesDialog.svelte` (Desktop 273 / **PWA 991**) — **PWA porten**
PWA-only: chmod/octaal-editor (`getOctalFromState`, `handleOctalChange`, `updateFromOctal`, `toggleAllowExecute`), `loadUsersAndGroups`, `getSizeOnDisk`, `formatDetailedDate/Size`, `getMediaType`, `handleSave`, `moveToFront`. **Desktop-versie is stub.**

**Backend-portingpad (nieuw Rust-werk in `apps/desktop/src-tauri`):**
| Nodig in UI | PWA-server heeft | Desktop-backend nu | Actie |
|-------------|------------------|--------------------|-------|
| Rechten schrijven | chmod via `runAsSudo` | ❌ geen command | Nieuw `#[tauri::command] set_permissions(path, mode)` in `vfs.rs` (Unix: `std::fs::set_permissions` + `PermissionsExt`; privilege-escalatie via bestaande `restart_as_root`) |
| Eigenaar/groep | `chown` endpoint | ❌ | Nieuw `chown(path, uid, gid)` command (Unix: `std::os::unix` / `nix`) |
| Users/groepslijst | `GET /users-groups` | leest al uid/gid via `uzers` in `get_path_info` | Nieuw `get_users_groups()` command (hergebruik `uzers`) |
| Grootte op schijf | `getSizeOnDisk` (server) | in `get_path_info`? verifiëren | Blocks×512 via `MetadataExt`; command of veld toevoegen |

- Registreer nieuwe commands in `generate_handler!` in `lib.rs`.
- Breid `NexusIpc`-contract uit met `setPermissions`, `chown`, `getUsersGroups` (optioneel; web heeft ze al).
- UI = PWA-versie, naar `packages/ui`. Windows: rechten-tab conditioneel verbergen (`getIpc().setPermissions` afwezig) — POSIX-permissions bestaan daar niet.
- **Security:** privilege-escalatie verschilt fundamenteel (Tauri `restart_as_root` vs server `runAsSudo`-met-wachtwoord). Niet delen; per-app in de adapter. Zie [security_audit_2026-07].

### `FileList.svelte` (1824 diff) — **Merge beide** (grootste klus)
- Desktop-only: `checkPathValidity`, `enterResolvedEntry`, `handleFeedToListbox`, `handleFileListWheel`, `handleMenuAction`, `initTabs`, `isDirSizePending`, `processNext`.
- PWA-only: `checkReadOnly`, `getViewMode`, `handleColumnsSync`, `navigateTo`, `requestOpen`, `showActionToast`, `sortEntries`, `updateRowHeight`, `abortDirSizeCalcs`, **touch/long-press** (`handleLongPress*`, `handlePathLongPressStart`, `clearLongPressTimer`).
- Aanpak: neem het **grootste** bestand (PWA, 3469 rgls) als basis om PWA-features niet te verliezen; port desktop-only functies erin; touch achter `utils/touch.ts` + capability-flag (blijft werken op web/mobiel, no-op op desktop).
- Dit bestand alléén in één sessie; uitgebreide handmatige + visuele test.

### `+page.svelte` (984 diff) — **App-specifiek, blijft grotendeels per-app**
App-shell; divergentie is platform-inherent (desktop: editor/viewer-vensters, `handleExit`, background-tasks; web: `installPWA`, `handleBeforeInstallPrompt`, clipboard `handlePaste`, web-polling `pollBlockingFileOperation`, panel-swap).
- **Niet** volledig delen. Extraheer gedeelde orchestratie-logica naar `packages/ui` stores; laat elke `+page.svelte` de app-eigen delen houden.

### `AboutDialog.svelte` (459) & `MenuBar.svelte` (366) — Merge (content, geen logica)
- Divergentie in markup/menu-items, niet functies. Desktop als basis; web-specifieke items (install/promo) conditioneel via capability-flag.

### `ipc.ts` (516) — al afgehandeld in Fase 2 (adapter-grens).

**Acceptatie Fase 4:** alle zware bestanden verwerkt; beide apps groen; `FilePropertiesDialog` werkt op desktop mét nieuwe rechten-commands; volledige handmatige regressietest.

---

## Fase 5 — i18n consolideren (½ dag)

- Desktop's `import.meta.glob("./locales/*.json")` wordt de gedeelde loader in `packages/ui/src/lib/i18n.ts`.
- `locales/{de,en,es,fr,nl,pt}.json` → `packages/ui/src/lib/locales/`.
- Web: laat de gebundelde loader gebruiken (werkt offline in de PWA). Express-`/api`-taalendpoint + `server/langs/*` mag vervallen of als fallback blijven.
- **Sync-check:** vergelijk desktop `locales/*.json` met PWA `server/langs/*.json` op ontbrekende sleutels; neem de superset. Desktop leidend bij conflict.
- **Acceptatie:** taal wisselen werkt in beide apps; geen ontbrekende sleutels.

---

## Fase 6 — App-specifieke bestanden plaatsen (½ dag)

**Alleen in desktop → blijft `apps/desktop`:** `DynamicIcon.svelte` (of delen indien generiek), `HelpDialog.svelte`, `PackProgressDialog.svelte`, `TextEditorModal.svelte`.
**Alleen in web → blijft `apps/web`:** `upload/*` (uploadClient/Store/webkitEntries), `UploadConflictModal`, `UploadProgress`, `TitleBar` (Tauri heeft native decorations), `HeadlessFileModal` (onderzoeken).
**Verzoenen:** desktop `HelpDialog` ↔ web `HelpViewer` → één gedeelde `HelpDialog` in `packages/ui` indien haalbaar; anders per-app. `TaskProgress` ↔ web `TaskProgressPopUp` → gedeelde `TaskProgress` + web-only popup-wrapper.
`utils/touch.ts` → naar `packages/ui/src/lib/utils/` (capability-gated), gebruikt door gedeelde `FileList`.

---

## Fase 7 — Backends & security (doorlopend)

- Rust-backend (`apps/desktop/src-tauri`) en Express (`apps/web/server`) blijven **volledig gescheiden**. Geen gedeelde backend-code.
- Trust-modellen expliciet documenteren: Express stelt FS bloot via HTTP (auth/CORS/scope-review nodig); Tauri capability-scoping. Verwijs naar [security_audit_2026-07].
- Nieuwe desktop-commands (`set_permissions`, `chown`) door dezelfde review-lat als de audit.
- Web `runAsSudo`-pad (wachtwoord-escalatie) blijft web-only en gescheiden.

---

## Fase 8 — Build, CI & Windows-target (1–2 dagen)

Sluit aan op de eerdere Windows-vraag: Windows is nu simpelweg een build-target van `apps/desktop`.

8.1 **Cargo target-gating** in `apps/desktop/src-tauri/Cargo.toml` (nog te doen, los van monorepo):
```toml
[target.'cfg(windows)'.dependencies]
winapi = { version = "0.3", features = ["fileapi", "winbase"] }
[target.'cfg(unix)'.dependencies]
uzers = "0.12"
libc = "0.2"
[target.'cfg(target_os = "linux")'.dependencies]
rfd = { version = "0.15", default-features = false, features = ["gtk3"] }
[target.'cfg(not(target_os = "linux"))'.dependencies]
rfd = "0.15"
```
8.2 GitHub/Forgejo Actions:
- `apps/desktop`: matrix `ubuntu-latest` + `macos-latest` + `windows-latest` → `tauri build`.
- `apps/web`: build + deploy (bestaande `deploy.sh`).
8.3 Root scripts: `npm run build` bouwt beide; `npm run dev:desktop` / `dev:web`.
8.4 **Acceptatie:** CI produceert Windows-installer + Linux/macOS-bundles + web-build vanuit één repo.

---

## Fase 9 — Verificatie & cutover (1 dag)

9.1 Volledige handmatige regressietest beide apps tegen referentiebeelden (Fase 0.5).
9.2 Versies gelijktrekken (kies bijv. 0.9.0 als eerste monorepo-release).
9.3 Oude repos archiveren (read-only), README's naar monorepo verwijzen.
9.4 CLAUDE.md / AGENTS.md samenvoegen naar monorepo-root + per-app.

---

## Risico's & mitigaties

| Risico | Impact | Mitigatie |
|--------|--------|-----------|
| PWA-features stil verloren door "desktop wint" | Hoog | Per-bestand beleid; ⚠️-uitzonderingen; `FilePropertiesDialog` = PWA-basis |
| `FileList` merge te groot in één keer | Hoog | Apart, geïsoleerd, PWA als basis, touch achter flag |
| SvelteKit + workspace-symlinks | Middel | `preserveSymlinks: true` staat al in desktop-vite; idem web toevoegen |
| Nieuwe Rust-commands introduceren security-gat | Middel | Zelfde review-lat als audit 2026-07; capability-scope |
| Geen 3-way merge-base → handmatige fouten | Middel | Fase 0.3 synthetische voorouder; visuele referenties; groene-build-na-elke-stap |
| Windows: POSIX-permissions bestaan niet | Laag | Rechten-tab conditioneel via `getIpc()`-capability |

---

## Tijdsindicatie (grove orde)

| Fase | Duur |
|------|------|
| 0 Voorbereiding | ½ dag |
| 1 Scaffold | 1 dag |
| 2 ipc-interface | 1 dag |
| 3 Gedeelde UI (a/b/c) | 3–5 dagen |
| 4 Zware bestanden | 4–7 dagen |
| 5 i18n | ½ dag |
| 6 App-specifiek | ½ dag |
| 7 Backends/security | doorlopend |
| 8 Build/CI/Windows | 1–2 dagen |
| 9 Cutover | 1 dag |
| **Totaal** | **±2–3,5 weken** effectief werk |

---

## Gouden regels tijdens uitvoering

1. **Na elke bestandsverplaatsing: beide apps builden groen.** Nooit doorstapelen op rood.
2. **Desktop wint bij ties; PWA-vooruitgang porten, niet overschrijven** (⚠️-lijst).
3. **Backends nooit delen** — alleen de frontend.
4. **Platformverschillen achter `getIpc()`-capabilities**, niet achter `if (isDesktop)` verspreid door de UI.
5. **Één zwaar bestand per sessie**, met handmatige + visuele test.
