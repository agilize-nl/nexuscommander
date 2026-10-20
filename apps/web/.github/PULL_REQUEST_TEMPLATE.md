## What does this PR do?

<!-- Short description of the change and why. Link related issues with "Fixes #123". -->

## Checklist

- [ ] `npm run check` passes with zero warnings
- [ ] `npm run build` succeeds
- [ ] New user-visible strings go through `$_()` and were added to `server/langs/en.json`
- [ ] Svelte components use runes (`$state`/`$derived`/`$effect`, `let { ... } = $props()`) — no legacy `$:` reactivity
- [ ] UI changes use `--color-nc-*` variables, no ad-hoc hex codes
- [ ] Tested on a narrow viewport if this touches layout/wrappers

## Screenshots / recording

<!-- For UI changes, a before/after screenshot or short screen recording makes review much faster. -->
