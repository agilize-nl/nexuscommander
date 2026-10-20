# NexusCommander installeren op Linux

Deze repo is de Tauri-desktopversie van NexusCommander. Op Linux bouwt Tauri een native app en installer vanuit de Svelte frontend en Rust backend.

## Geteste context

- Huidige ontwikkelmachine: Zorin OS 18.1 (`noble`)
- Projectversie: `0.9.17` (gesynchroniseerd met NexusCommander-PWA)
- Buildscript: `npm run tauri build`
- Installatie-artifacts: `src-tauri/target/release/bundle/`
- Uitgebrachte `.deb`-installers: `builds/` (daar zet de root-releaseflow `./deploy.sh` ze neer)

## 1. Systeemdependencies

Voor Debian/Ubuntu/Zorin zijn de Tauri v2 builddependencies:

```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  file \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev
```

Op deze pc waren Node.js, npm, Rust en Cargo al aanwezig. Van de bovenstaande packages leek alleen `libxdo-dev` nog te ontbreken.

## 2. Node dependencies installeren

Gebruik in de repo:

```bash
cd /home/djawiz/Data/Development/_Apps/NexusCommander
npm ci
```

Als `package-lock.json` bewust verouderd is of packagewijzigingen bevat die nog niet zijn vastgelegd, gebruik dan tijdelijk:

```bash
npm install
```

## 3. Controleren of de app bouwbaar is

```bash
npm run check
npm run build
cargo build --manifest-path src-tauri/Cargo.toml
```

## 4. Linux installer bouwen

```bash
npm run tauri build
```

De Linux bundles komen daarna onder:

```text
src-tauri/target/release/bundle/
```

Voor Debian/Ubuntu/Zorin is de `.deb` normaal de handigste installer. Afhankelijk van Tauri's output kunnen er ook AppImage- of RPM-artifacts staan.

Bouw en deploy je vanuit de root van de monorepo via `./deploy.sh`, dan wordt
de `.deb` daarna uit `target/` verplaatst naar `apps/desktop/builds/`, via een
tijdelijk bestand lokaal met `apt` geïnstalleerd, en daarna geverifieerd. Dezelfde
releaseflow pusht naar Forgejo en deployt de web/PWA naar CT188. Tauri's
bundle-uitvoermap is niet instelbaar, dus die verhuizing houdt de installer
buiten bereik van `cargo clean`.

## 5. Installeren op deze pc

Installeer de actuele `.deb` via een tijdelijk pad dat door apt gelezen kan worden.

1. Kopieer en installeer de nieuwst gebouwde `.deb`. Zoek in `builds/` (de
   uitvoermap van `./deploy.sh`) en anders in Tauri's bundlemap, zodat het
   commando ook werkt na een losse `npm run tauri build`:
```bash
LATEST_DEB=$(ls -t ./builds/NexusCommander_*_amd64.deb \
                   ./src-tauri/target/release/bundle/deb/NexusCommander_*_amd64.deb \
             2>/dev/null | head -n 1)
cp "$LATEST_DEB" /tmp/nexuscommander_latest.deb
sudo apt install /tmp/nexuscommander_latest.deb
```

2. Oude installers opruimen kan wanneer je wilt; ze staan `.deb` per versie in
   `builds/` en worden niet automatisch verwijderd:
```bash
ls -t ./builds/NexusCommander_*_amd64.deb
```

Daarna zou NexusCommander in het applicatiemenu moeten staan. Je kunt de binary ook direct starten met:

```bash
nexuscommander
```

## 6. Snelle ontwikkelstart zonder installatie

Voor testen zonder installer:

```bash
npm run tauri dev
```

## Notities

- Deze stappen gelden voor de lokale Tauri-desktopversie, niet voor de PWA/servervariant.
- Tauri v2 gebruikt op Linux WebKitGTK 4.1; daarom is `libwebkit2gtk-4.1-dev` nodig voor bouwen.
- Oude build-artifacts kunnen worden opgeruimd met `rm -f ./src-tauri/target/release/bundle/deb/*.deb`, en het `ls -t` commando selecteert gegarandeerd het nieuwst gebouwde artifact om verkeerde versies bij installatie te voorkomen.
- De repo staat fysiek onder `/mnt/Data`, en die map is niet leesbaar voor de `_apt` sandbox user. Kopieer de `.deb` daarom eerst naar `/tmp` of een andere wereldleesbare map.
- GUI-apps erven op Linux niet altijd dezelfde shell-omgeving als een terminal. Als later externe tools vanuit NexusCommander niet gevonden worden, controleer dan het PATH waarmee de desktop-app start.
