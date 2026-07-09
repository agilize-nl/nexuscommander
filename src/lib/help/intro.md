# Introduction to NexusCommander

Welcome to **NexusCommander**, a cross-platform, high-performance file manager designed for efficiency and power users. 

## What is a Dual-Pane File Manager?
NexusCommander follows the "Orthodox File Manager" (OFM) tradition. Instead of a single window, you have **two panels** side-by-side. This allows you to:
- See the source and destination at the same time.
- Move or copy files with single keystrokes (`F5` or `F6`).
- Compare directories quickly.

## Selection Modes
NexusCommander supports two primary ways of selecting files:
- **Norton Commander (NC) Mode**: Right-click to select files. Standard left-click just moves the cursor.
- **Windows Mode**: Left-click to select files. Right-click opens the context menu.

You can change this in the **Options** dialog under **General**.

## Quick Start
1. Use **Tabs** or the **Drive Bar** to navigate to your folders.
2. Select files using the mouse or keyboard (`Shift` + `Arrow Keys` or `Space`).
3. View files with `F3` or edit them with `F4`.
4. Copy selected files to the opposite panel with `F5`.
5. Move selected files to the opposite panel with `F6`.

## Standalone / Remote Use

When NexusCommander runs inside a remote or headless Linux environment, opening files behaves a little differently:

- `F3` uses the built-in viewer inside NexusCommander
- `F4` opens the built-in editor for text and code files
- supported images, PDFs, audio, and video open inside NexusCommander
- desktop-only actions that require a local Linux GUI app may not be available on the server itself
