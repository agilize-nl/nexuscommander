# Keyboard Shortcuts

NexusCommander is designed to be fully navigable via keyboard. Using shortcuts will significantly improve your productivity.

## Function Keys (F1 - F10)
- **F1**: Open Help
- **F2**: Rename the focused file or folder
- **F3**: View file contents in the built-in viewer
- **F4**: Edit text/code files in the built-in editor; on desktop installs other file types may still open in a system app
- **F5**: Copy selected files
- **F6**: Move or Rename selected files
- **F7**: Create New Directory
- **F8**: Delete selected files
- **F9** / **Ctrl + J**: Toggle Tasks / background transfers
- **F10** / **F12** / **Ctrl + P**: Open Actions palette

## Navigation & Selection
- **Tab**: Switch focus between Left and Right panels
- **Arrow Keys**: Move the cursor up/down
- **Shift + Arrow Keys**: Select multiple files (NC mode)
- **Space**: Toggle selection of the current file
- **Ctrl + Num +**: Select All files
- **Ctrl + Num -**: Unselect All files
- **Num ***: Invert Selection
- **Alt + Enter**: Show File Properties

## Panel & Window Management
- **Ctrl + U**: Swap Left and Right Panel paths
- **Ctrl + Shift + U**: Equalize Panel widths
- **Alt + F7**: Open Search tool
- **Ctrl + D**: Open Directory Hotlist (Bookmarks)
- **Ctrl + T**: Open New Tab
- **Ctrl + W**: Close Current Tab
- **Ctrl + F3/F4/F5/F6**: Sort by name, extension, modified date, or size
- **Show > Single View**: Toggle one-list mode for narrow or portrait screens
- **Alt + F4**: Exit (desktop only)

- **Ctrl + F1 / F2**: Brief / full listing
- **Ctrl + F8**: Toggle tree on the active panel
- **Ctrl + M**: Multi-rename
- **Ctrl + R**: Refresh both listings
- **Ctrl + F**: Quick search in the active listing
- **Alt + F5 / F9**: Pack / unpack
- **Alt + Shift + F9**: Test archive (when supported by the backend)
- **Shift + F2**: Compare directories
- **Delete / Shift + Delete**: Trash / permanently delete

## Remote / Headless Note

In a headless server deployment, `F4` now prefers the built-in editor for text and code. PDFs, images, audio, video, and other supported formats open inside NexusCommander, while unsupported files fall back to download or raw-open actions. App-exit shortcuts are intentionally disabled in the shared service runtime.
