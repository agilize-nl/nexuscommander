# Contributing to NexusCommander

Thanks for considering a contribution — bug reports, feature ideas and pull requests are all welcome.

## Setup

```bash
npm install
npm start
```

This runs the Vite dev server (`5173`) and the Express backend (`3721`) together. See [README.md](README.md) for standalone/production mode.

## Before opening a PR

These must pass:

```bash
npm run check   # svelte-check — must stay at zero warnings
npm run build   # production build
```

## Project conventions

The full architectural patterns live in [docs/CODING_STANDARDS.md](docs/CODING_STANDARDS.md) — read it before touching dialogs, archives, permissions/sudo-elevation, or PWA/service-worker code. The rules that trip people up most often:

- **i18n**: never hardcode user-visible strings. Use the `$_()` helper and add new keys to `server/langs/en.json` (other languages can follow later).
- **Svelte 5 runes only**: `$state`/`$derived`/`$effect` and `let { ... } = $props()`. No Svelte 4 `let` reactivity or `$:` statements.
- **Styling**: only `--color-nc-*` CSS variables — no ad-hoc hex codes. Modal backdrops stay visually transparent; depth comes from the panel's `box-shadow`, not a darkened overlay.
- **Menu/keyboard actions dispatch once**: `+page.svelte`'s `handleMenuAction`/`handleKeydown` is the only listener for global `nc:menu-action` events and global shortcuts. Don't add a panel-local duplicate listener for the same action — this exact bug has broken F9 and double-fired 12 menu actions before.
- **Archives are virtual, read-only paths**: `<archive>::<inner>` handled by `splitVirtualPath()` (`server/lib/archivePaths.js`). It only matches when the inner path is non-empty — a selected `backup.zip` sitting in a normal folder is a plain file for copy/move, not an archive entry. Only copy/extract is supported out of an archive, never move/delete/rename.

## Reporting bugs / requesting features

Please use the issue templates — they ask for just enough context (repro steps, environment) to act on quickly.

## License

By contributing, you agree your contribution is licensed under the project's [MIT license](LICENSE).
