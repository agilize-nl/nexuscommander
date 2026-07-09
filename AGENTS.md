# NexusCommander Agent Instructions

## Codex Start Protocol

At the start of a new Codex chat or task in this repository, read the newest
dated Markdown file in `improvements-codex/` before making plans, edits, or
deploy decisions.

Use that retro as active working guidance for this repo. In particular, apply
the NexusCommander preflight/regression habit described there:

- check dirty files before edits or deploys
- separate visual overlays from interaction blockers
- protect settings and custom columns before UI changes
- test responsive panel behavior after wrapper/layout changes
- state clearly what `./deploy.sh` will include before running it

If more than one file exists in `improvements-codex/`, prefer the newest file by
date in the filename, then scan older files only when the task directly relates
to their topic.
