# NexusCommander Installation Guide

NexusCommander is a Progressive Web App (PWA) designed to run "native" on ChromeOS and Linux without the overhead of containerization.

## 🚀 Quick Install (ChromeOS / Chrome)

1.  **Open the App**: Navigate to the hosted URL (e.g., `http://localhost:5173` during development, or `http://<machine-ip>:5173` from another device on your LAN).
2.  **Install Prompt**: Look for the **Install** icon (desktop with down arrow) in the right side of the address bar.
3.  **Confirm**: Click **Install**.
4.  **Launch**: The app will now appear in your **Launcher** (ChromeOS) or **Application Menu** (Linux) and can be pinned to the shelf/taskbar.

## 📱 Mobile (Android)

NexusCommander also works on mobile devices. On Android (Chrome):

1. Browse to the app URL from your phone — the phone must be able to reach the backend, e.g. on the same LAN or via your VPN/tailnet, and the origin must be allowed (see `NC_ALLOWED_ORIGINS`).
2. Open the ⋮ menu → **Add to Home screen** / **Install app**.
3. Launch from the home screen for a fullscreen, app-like experience with touch-optimized controls.

iOS/Safari has not been tested yet.

## ⚙️ Backend Setup (Development)

To run the local file system bridge, you must have Node.js v22+ installed.

**Archive support**: `.zip` is handled in-process (`adm-zip`); `.tar`/`.tar.gz`/`.tar.bz2`/`.tar.xz` need the `tar` CLI (present on virtually all Linux systems). `.7z` and `.rar`/`.rar5` are extracted via the `7z` CLI, so install the official **`7zip`** package (≥ ~21.x, with built-in RAR/RAR5 support) — e.g. `apt install 7zip` on Debian/Ubuntu 24.04+. Avoid the older `p7zip`/`p7zip-full` fork: it needs a separate `p7zip-rar` codec and has unreliable RAR5 support. Without it, `.7z`/`.rar` browsing and extraction return an error but the rest of the app is unaffected.

1.  **Clone the Repository**:
    ```bash
    git clone https://github.com/djawiz/NexusCommander.git
    cd NexusCommander
    ```
2.  **Install Dependencies**:
    ```bash
    npm install
    ```
3.  **Start the Server**:
    ```bash
    npm start
    ```
    This launches both the **Express Backend** (on port 3721) and the **Vite Dev Server** (on port 5173). Both bind to all interfaces by default so the PWA can be used from another device/host, while the backend still rejects untrusted browser origins.

    Optional overrides:
    ```bash
    NC_HOST=127.0.0.1 npm run server
    NC_ALLOWED_ORIGINS=http://localhost:5173,http://my-workstation:5173 npm run server
    ```

## 🚀 Standalone Production Mode

The repository supports a standalone production mode where the Express backend serves both the API and the built frontend from the same origin.

1. Build the frontend:
   ```bash
   npm run build
   ```
2. Create a production env file:
   ```bash
   cp .env.example .env
   ```
3. Start the standalone server:
   ```bash
   npm run serve
   ```

Available production endpoints:

- App shell: `http://127.0.0.1:3721/`
- Health check: `http://127.0.0.1:3721/api/health`

There is also a convenience command:

```bash
npm run prod
```

## Opening Files in Standalone / Headless Mode

In a local desktop install, double-clicking a file can still hand off to the host's default Linux application.

On a headless server deployment this is different:

- the backend runs on a machine without a desktop session
- there is no way to launch local GUI apps
- files therefore open web-native inside NexusCommander wherever possible

Behavior in headless deployments:

| Category | Extensions | Preferred behavior |
| --- | --- | --- |
| Text and code | `txt`, `md`, `log`, `json`, `xml`, `csv`, `yml`, `yaml`, `js`, `ts`, `svelte`, `css`, `html`, `sh`, `py`, `php`, `sql`, `env` | built-in editor/viewer |
| Images | `png`, `jpg`, `jpeg`, `gif`, `webp`, `bmp`, `svg`, `ico` | built-in image viewer |
| PDF | `pdf` | embedded browser/PDF preview |
| Browser-native audio | `mp3`, `wav`, `ogg`, `m4a`, `aac` | built-in audio player |
| Browser-native video | `mp4`, `webm`, `m4v` | built-in video player (mkv/avi play too when `ffmpeg` is installed, via on-the-fly remux) |
| Office documents | `docx`, `xlsx`, `pptx`, `odt`, `ods`, `odp` | converted preview when LibreOffice is available, otherwise download/open-raw |
| Other binary files | other extensions | unsupported screen with download, open raw and copy path actions |

## 🖥 Systemd Service

A ready-to-use example unit is included in [deploy/nexuscommander.service](../deploy/nexuscommander.service).

Typical production layout:

- app path: `/opt/NexusCommander`
- environment file: `/opt/NexusCommander/.env`
- runtime user: the account whose files NexusCommander should manage (the backend has the same file system rights as this user)

Install steps:

```bash
sudo cp deploy/nexuscommander.service /etc/systemd/system/
# edit User=/Group= and paths to match your setup
sudo systemctl daemon-reload
sudo systemctl enable --now nexuscommander.service
```

Update / restart after deploying new code:

```bash
sudo systemctl restart nexuscommander.service
curl -fsS http://127.0.0.1:3721/api/health
```

## 🌐 Remote Access (VPN / Reverse Proxy)

The backend has no built-in authentication, so never expose it directly to the public internet (see the Security Model section in the [README](../README.md)). Proven setups:

- **Tailscale Serve** (or another VPN): expose the app as `https://<node>.<tailnet>.ts.net`; only devices on your tailnet can reach it, and you get HTTPS for free.
- **Local reverse proxy**: a minimal Caddy example is included in [deploy/nexuscommander.Caddyfile](../deploy/nexuscommander.Caddyfile), proxying `:8080` to `127.0.0.1:3721`. Combine with your LAN reverse proxy / internal DNS as desired.

Whichever route you choose, add the public-facing origin(s) to `NC_ALLOWED_ORIGINS` in `.env`, e.g.:

```bash
NC_ALLOWED_ORIGINS=https://nexuscommander.<tailnet>.ts.net,https://nexuscommander.internal.example
NC_ALLOWED_ORIGIN_PORTS=443
```

## 🛠 Features for ChromeOS

- **Standalone Window**: The main app runs in its own window without browser tabs; browser-opened media or documents can still open in a separate tab when appropriate.
- **File System Access**: Uses the Node.js backend to bridge local file system operations to the web UI.
- **Offline Capable**: Works offline via Service Workers for core UI and logic.
- **Dark Mode Support**: Respects system theme and provides 5+ built-in distinct themes.

## 📂 Configuration

By default, settings are stored in:
- **Linux/ChromeOS**: `~/.config/nexuscommander/config.json`

The interface language can be changed from **Options > General > Language & Interface**. The bundled UI languages are English, Dutch, German, French, Spanish, and Portuguese.
