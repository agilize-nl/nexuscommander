# NexusCommander Technical Stack

A comprehensive overview of the technologies, frameworks, and libraries powering NexusCommander-WPA.

## 🎨 Frontend (Client-Side)

### Core Frameworks
- **[SvelteKit](https://kit.svelte.dev/)**: The meta-framework for Svelte, handling routing and application structure.
- **[Svelte 5](https://svelte.dev/)**: Using **Runes** (`$state`, `$derived`, `$effect`) for modern, signal-based reactivity.
- **[Vite 6](https://vitejs.dev/)**: High-performance frontend build tool and dev server.

### Styling & UI
- **[Tailwind CSS v4](https://tailwindcss.com/)**: Next-generation utility-first CSS framework.
- **[Lucide Svelte](https://lucide.dev/)**: Icon library used throughout the interface.
- **Custom Theme Engine**: Pure CSS-variable based theme system supporting dynamic dark/light mode switching.

### PWA Capabilities
- **Service Worker**: custom `sw.js` for offline support and asset caching.
- **Web App Manifest**: `manifest.webmanifest` for standalone installation on ChromeOS and Linux.
- **Window Controls Overlay**: Integrated support for native-like title bars in PWA mode.

---

## 🟢 Backend (Server-Side)

### System Framework
- **[Node.js v22+](https://nodejs.org/)**: The runtime environment for the system-side backend.
- **[Express](https://expressjs.com/)**: Fast, unopinionated web framework for Node.js handling the REST API.

### Key Libraries
- **File System**: Native `fs/promises` for high-performance non-blocking I/O.
- **Archive Operations**: `adm-zip` for ZIP, plus the `tar` and `7z` CLIs (shelled out via `child_process`) for TAR/GZIP/BZIP2/XZ and 7Z/RAR respectively. A single `splitVirtualPath()` helper (`server/lib/archivePaths.js`) resolves virtual `archive::inner/path` locations shared by browsing, extraction and copy/move.
- **Process Management**: `child_process` for terminal integration and shell commands.
- **SSE (Server-Sent Events)**: Real-time progress updates for file operations (Copy/Move/Delete).

---

## ⚙️ Development & Build
- **Package Manager**: `npm` for both frontend and backend dependencies.
- **Process Manager**: `concurrently` used to run Vite dev server and Express backend simultaneously.
- **IPC Bridge**: RESTful API and SSE replacing the former Tauri IPC system.
- **Deployment**: Standalone Node.js server with Vite-built static frontend assets.
