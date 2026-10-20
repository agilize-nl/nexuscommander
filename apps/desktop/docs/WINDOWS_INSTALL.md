# NexusCommander installeren op Windows

NexusCommander is een Tauri-desktopapp: Svelte bouwt de interface en Rust bouwt
de native Windows-app. De release wordt verpakt als een gewone `.exe`-installer
(NSIS), die je via **Instellingen > Apps** ook weer kunt verwijderen.

## Eenmalig: bouwomgeving installeren

Open een nieuwe PowerShell nadat je onderstaande onderdelen hebt geinstalleerd.

1. Installeer [Node.js 22 LTS](https://nodejs.org/). Controleer daarna met
   `node --version` en `npm --version`.
2. Installeer [Rustup](https://rustup.rs/) en kies de standaard Windows MSVC-toolchain.
   Controleer met `rustc --version` en `cargo --version`.
3. Installeer **Visual Studio Build Tools 2022**. Selecteer de workload
   **Desktop development with C++**, inclusief de MSVC x64/x86-buildtools en een
   Windows 10 of 11 SDK.
4. Op Windows 10 moet de Microsoft Edge WebView2 Runtime aanwezig zijn. Op een
   bijgewerkte Windows 11-installatie is die normaal al aanwezig.

De projectmap zelf mag op een netwerkschijf staan, maar lokaal bouwen is vaak
sneller en voorkomt problemen met bestandslocks. Kopieer de repo zo nodig naar
bijvoorbeeld `C:\Development\NexusCommander`.

## Installer bouwen

Open PowerShell in de hoofdmap van deze repository en voer uit:

```powershell
.\scripts\build-windows.ps1
```

Dit script controleert de tools, installeert de Node-dependencies, draait de
kwaliteitscontrole en bouwt de productie-frontend, Rust-backend en een
NSIS-installer. Het setupbestand komt hier terecht:

```text
apps\desktop\src-tauri\target\release\bundle\nsis\NexusCommander_<versie>_x64-setup.exe
```

Voor de huidige versie is dat normaal
`NexusCommander_0.9.5_x64-setup.exe`.

Als de dependencies al gecontroleerd zijn en je alleen opnieuw wilt bundelen:

```powershell
.\scripts\build-windows.ps1 -SkipChecks
```

## Installeren en testen

1. Dubbelklik op het gegenereerde `*-setup.exe` bestand.
2. Doorloop de installatie en start **Nexus Commander** vanuit het Startmenu.
3. Test ten minste beide panelen, een lokale schijf zoals `C:\`, kopieren naar
   een tijdelijke map en verwijderen naar de Prullenbak.

Windows kan bij een niet-ondertekende eigen build een SmartScreen-waarschuwing
tonen. Kies alleen **Meer informatie > Toch uitvoeren** wanneer je het bestand
zelf hebt gebouwd of de herkomst vertrouwt. Voor distributie aan anderen is een
code-signingcertificaat de volgende stap; zonder certificaat werkt de installer
wel, maar krijgt hij minder vertrouwen van SmartScreen.

## Problemen oplossen

- `node`, `npm`, `cargo` of `rustc` wordt niet herkend: sluit PowerShell en open
  hem opnieuw na de installatie; controleer daarna de `PATH`.
- Een melding over een C++ linker of Windows SDK: pas de installatie van Visual
  Studio Build Tools aan en voeg de genoemde C++-workload/SDK toe.
- Een fout over WebView2 bij starten: installeer de Evergreen WebView2 Runtime
  van Microsoft en start de app opnieuw.
- Alleen tijdens ontwikkeling starten, zonder installer: `npm run tauri -- dev`.
