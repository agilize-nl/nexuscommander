# Backends & security — trust-modellen in de monorepo

**Status:** Fase 7 van de monorepo-migratie. Kernregel: **alleen de frontend (`packages/ui`) wordt gedeeld; de backends blijven volledig gescheiden.** Er is geen gedeelde backend-code tussen `apps/desktop` en `apps/web`.

## Waarom gescheiden

De twee shells hebben fundamenteel verschillende trust-modellen:

| | `apps/desktop` (Tauri) | `apps/web` (Express) |
|--|------------------------|----------------------|
| Transport | `invoke()` → Rust, in-process | HTTP `fetch('/api/...')` → Node-server |
| Vertrouwensgrens | Tauri capability-scoping; geen netwerk-oppervlak | FS blootgesteld over HTTP → auth/CORS/scope nodig |
| Privilege-escalatie | `restart_as_root` via **pkexec** (OS-dialoog, hele proces wordt root) | `runAsSudo` / `elevateOperation` met **wachtwoord** per operatie |
| Adaptergrens | `apps/desktop/src/lib/ipc.ts` (implements `NexusIpc`) | `apps/web/src/lib/ipc.ts` (implements `NexusIpc`) |

Deze verschillen mogen **niet** in gedeelde code terechtkomen. Ze leven per app in de `ipc.ts`-adapter (zie [ipc-contract](../../packages/ui/src/lib/ipc-contract.ts)). De gedeelde UI kent alleen het `NexusIpc`-contract en detecteert capabilities (`getIpc().setFileProperties?.(…)`); ze weet niet welk transport eronder zit.

## Nieuwe desktop-commands (Fase 4) — securityreview

Voor de gedeelde `FilePropertiesDialog` (PWA-origin) kreeg de desktop-backend schrijfrechten op permissies/eigenaarschap. Nieuwe commands in `apps/desktop/src-tauri/src/vfs.rs`:

| Command | Doet | Risico-overweging |
|---------|------|-------------------|
| `get_users_groups` | Leest `/etc/passwd` + `/etc/group` (alleen eerste veld = naam) + huidige uid/gid. | Alleen-lezen, geen wachtwoorden/hashes (veld 2 wordt genegeerd). Geen padargument → geen path-traversal. |
| `set_file_properties(path, permissions?, owner?, group?)` | `chmod` (octaal) en/of `chown` (op naam→uid/gid via `uzers`). | Schrijfoperatie. Draait met de privileges die het proces al heeft — **geen nieuwe escalatie-surface**: elevatie loopt via het bestaande `restart_as_root` (pkexec). Onbekende user/group → nette fout, geen fallback naar root:root. Ongeldige octaal → afgewezen. |
| `get_size_on_disk(path)` | `blocks × 512` via `MetadataExt`. | Alleen-lezen. |

**Reviewlat:** dezelfde als de audit van 2026-07 (zie desktop `docs/SECURITY_AUDIT_2026-07-13.md`). Aandachtspunten die gehaald zijn:
- Geen nieuw privilege-escalatiepad geïntroduceerd (hergebruik pkexec-proces-elevatie).
- Geen shell-interpolatie (directe syscalls via `std::fs` / `std::os::unix::fs::chown`, geen `Command`-string).
- POSIX-only achter `#[cfg(unix)]`; op niet-Unix een nette `OpResult::err` i.p.v. panic.
- Foutmeldingen lekken geen paden buiten wat de aanroeper al kent.

De web-kant heeft deze functionaliteit al (`/fs/set-properties`, `/fs/users-groups`, `/fs/elevate-operation`) met zijn eigen wachtwoord-escalatiemodel; dat blijft **web-only** en ongewijzigd.

## Geaccepteerd risico: `assetProtocol.scope` staat op `["**"]` (QSF-014)

**Beslissing:** blijft `["**"]`. **Eigenaar:** djawiz. **Vastgelegd:** 2026-07-29.
**Herzien:** uiterlijk 2027-01-29, of eerder zodra het IPC-oppervlak versmald wordt.

`apps/desktop/src-tauri/tauri.conf.json` geeft het asset-protocol toegang tot
willekeurige paden. Dat is geen omissie maar een afweging die al bij de audit van
2026-07-14 is gemaakt en hier opnieuw bevestigd wordt.

De drie consumenten hebben allemaal willekeurige paden nodig via `convertFileSrc`:

| Consument | Waarvoor |
|---|---|
| `MiniPlayer.svelte` | audiopreview van een bestand op een willekeurig pad |
| `ContextMenu.svelte` | iconen van "openen met"-applicaties uit `.desktop`-entries |
| `FileViewer.svelte` | afbeeldingsweergave — bewust van base64-over-IPC afgestapt |

**Waarom versmallen hier niets koopt:** het IPC-oppervlak verleent al even brede
leestoegang tot het bestandssysteem (`read_file_for_viewer` en verwanten kennen
geen padrestrictie). Het asset-protocol dichtzetten verplaatst een grens die niet
de echte grens is. Voor een *file manager* is "alle paden lezen" bovendien de
functie zelf, niet een uitzondering.

**Wat wél de controle is:** de CSP. Die draagt daarmee het volle gewicht, dus is
hij gated door `scripts/check-csp.js` (onderdeel van `npm run check`): `script-src`
en `default-src` op `'self'`, `object-src`/`frame-ancestors` op `'none'`,
`base-uri` op `'self'`, nergens `unsafe-eval`, en `unsafe-inline` uitsluitend in
`style-src`. Diezelfde check faalt ook als deze risicoparagraaf verdwijnt terwijl
de scope breed blijft.

**Herzien zodra** het IPC-oppervlak wél gescoped wordt (Fase 1 `PathPolicy`), of
zodra `{@html}` uit `ContextMenu`/`HelpDialog` verdwenen is (QSF-013, P3.7) —
tot die tijd is `object-src 'none'` een dragende regel en geen formaliteit.

## Regels bij verder bouwen

1. **Nooit backend-code delen** — alleen `packages/ui`.
2. Nieuwe platform-verschillen achter een `NexusIpc`-capability, niet achter `if (isDesktop)` verspreid door de UI.
3. Elke nieuwe Rust-command of Express-endpoint door dezelfde reviewlat als de 2026-07-audit.
4. Het web `elevateOperation`/`runAsSudo`-pad (wachtwoord) blijft gescheiden van het desktop-pkexec-pad.
