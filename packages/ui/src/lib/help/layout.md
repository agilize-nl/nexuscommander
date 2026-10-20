# Application Layout

NexusCommander features a classic **dual-pane** interface, flanked by various toolbars and status areas.

## The Dual Panels
The core of the application consists of the left and right file panels. One panel is always **active**, indicated by a highlighted cursor. 
- You can switch active panels by pressing **Tab**.
- Each panel shows the files for the currently selected folder.

## Key UI Elements
- **Menu Bar** (Top): Contains all available commands categorized into drop-down menus.
- **Drive Bar**: Just above the panels, allows you to switch between physical drives, network shares, or specific mounts. Internal pseudo-mounts such as `/proc` or container metrics mounts are intentionally hidden.
- **Folder Tabs**: You can keep multiple folders open in each panel using tabs. Use `Ctrl+T` to open a new tab.
- **Command Line** (Bottom): Execute standard terminal commands in the current directory.
- **Function Key Bar** (Bottom-most): Quick reference for the F1-F10 keys. Clicking them executes the action.
- **Single View**: Show only the active file list. This is useful on phones and narrow portrait screens; press `Tab` to switch between the left and right list.
