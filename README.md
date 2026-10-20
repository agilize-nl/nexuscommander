# NexusCommander

NexusCommander is a dual-pane file manager with a shared Svelte frontend for a
native Tauri desktop app and a browser-based PWA.

[![NexusCommander 0.9.17 — dual-pane browsing in the Midnight theme](apps/web/docs/media/screenshots/dual-pane-browsing.png)](apps/web/docs/media/screenshots/dual-pane-browsing.png)

These screenshots show version **0.9.17** with demonstration files. Select an
image to view it at full size.

| File management | Themes |
| --- | --- |
| [![Copying files with F5](apps/web/docs/media/screenshots/copy-with-f5.png)](apps/web/docs/media/screenshots/copy-with-f5.png)<br>Copying files with F5 | [![GitHub Light](apps/web/docs/media/screenshots/light-themes.png)](apps/web/docs/media/screenshots/light-themes.png)<br>GitHub Light |
| [![Browsing a ZIP archive as a folder](apps/web/docs/media/screenshots/archives-as-folders.png)](apps/web/docs/media/screenshots/archives-as-folders.png)<br>Archives as folders | [![Dracula](apps/web/docs/media/screenshots/dark-themes.png)](apps/web/docs/media/screenshots/dark-themes.png)<br>Dracula |

[View all screenshots and themes →](apps/web/README.md#see-it-in-action)

## Architecture

```
NexusCommander/
├── packages/ui/       Shared Svelte UI and the NexusIpc contract
├── apps/desktop/      Tauri shell with a Rust backend
└── apps/web/          SvelteKit and Express PWA shell
```

The shared UI communicates only through the `NexusIpc` contract. Each shell
provides its own adapter, so platform-specific behavior stays at the boundary
between the interface and its backend.

## Features

- Dual-pane browsing with tabs, breadcrumbs, keyboard shortcuts and touch support
- Copy, move, rename and delete operations with background progress and conflict handling
- ZIP, TAR, 7Z and RAR archives browsed as virtual folders
- Built-in text, image, PDF, audio and video viewers
- Search, multi-rename, directory comparison, file split/combine and bookmarks
- Dark and light themes, icon sets and English, Dutch, German, French, Spanish and Portuguese interfaces
- Installable PWA and native desktop builds for Linux, macOS and Windows

## Development

```bash
npm install
npm run dev:desktop
npm run dev:web
npm run check
npm run build
```

See [the web application guide](apps/web/README.md) for web/PWA setup and
contribution details.
