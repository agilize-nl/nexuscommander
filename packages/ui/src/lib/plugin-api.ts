// NexusCommander Plugin API v1.0 — EXPERIMENTAL AND UNIMPLEMENTED
//
// This file is a design sketch. It contains type definitions only: there is no
// loader, no isolation boundary, no permission enforcement, no signing and no
// revocation model anywhere in either shell. Nothing here runs.
//
// The descriptions below are therefore aspirational, not a description of
// current behaviour. In particular NexusCommander does NOT read, load or
// execute anything from ~/.config/nexuscommander/plugins/ — an earlier version
// of this header claimed it did.
//
// Enabling runtime plugins means loading third-party code into the privileged
// webview, which for the desktop shell is the same trust domain as the whole
// native command surface. That needs its own threat model and the Phase 5
// security work in docs/COMPREHENSIVE_QUALITY_SAFETY_UPGRADE_PLAN_2026-07-28.md
// (QSF-025) before any loader lands.
//
// scripts/check-no-plugin-loader.js enforces the absence of a loader and runs
// as part of `npm run check`.

/**
 * Plugin manifest file (manifest.json).
 */
export interface PluginManifest {
  /** Unique plugin identifier (e.g., "com.example.my-plugin"). */
  id: string;
  /** Display name. */
  name: string;
  /** Semantic version (e.g., "1.0.0"). */
  version: string;
  /** Plugin description. */
  description: string;
  /** Author name. */
  author: string;
  /** Minimum NexusCommander version required. */
  minAppVersion: string;
  /** Entry point file relative to plugin directory. */
  main: string;
  /** Permissions the plugin requests. */
  permissions: PluginPermission[];
  /** Menu items to register. */
  menuItems?: PluginMenuItem[];
  /** Keyboard shortcuts to register. */
  keybindings?: PluginKeybinding[];
  /** File type associations. */
  fileAssociations?: string[];
}

/**
 * Permissions a plugin can request.
 */
export type PluginPermission =
  | "fs:read"       // Read files
  | "fs:write"      // Write/delete/move files
  | "fs:execute"    // Execute files
  | "net:http"      // Make HTTP requests
  | "ui:panel"      // Create custom panels
  | "ui:dialog"     // Show dialogs
  | "ui:statusbar"  // Modify status bar
  | "system:env"    // Read environment variables
  | "system:shell"  // Execute shell commands
  ;

/**
 * A menu item contributed by a plugin.
 */
export interface PluginMenuItem {
  /** Menu path (e.g., "Plugins/My Plugin/Do Thing"). */
  path: string;
  /** Command to invoke when clicked. */
  command: string;
  /** Keyboard shortcut for this item. */
  shortcut?: string;
  /** Icon (emoji or path). */
  icon?: string;
}

/**
 * A keybinding contributed by a plugin.
 */
export interface PluginKeybinding {
  /** Key combination (e.g., "Ctrl+Shift+P"). */
  keys: string;
  /** Command to invoke. */
  command: string;
  /** Context when this keybinding is active. */
  when?: "always" | "panel-focused" | "viewer-open";
}

// ===== Plugin API (available to plugins at runtime) =====

/**
 * The NexusCommander API object injected into plugin scope.
 * Accessible as `nexus` in the plugin's main script.
 */
export interface NexusAPI {
  /** Plugin's own information. */
  readonly plugin: {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly dataDir: string; // Plugin-specific data directory
  };

  /** File system operations. */
  fs: {
    /** Read directory contents. */
    readDirectory(path: string): Promise<FileEntryAPI[]>;
    /** Read file as text. */
    readText(path: string): Promise<string>;
    /** Read file as binary (base64). */
    readBinary(path: string): Promise<string>;
    /** Write text to a file. */
    writeText(path: string, content: string): Promise<void>;
    /** Copy files/directories. */
    copy(sources: string[], target: string): Promise<void>;
    /** Move files/directories. */
    move(sources: string[], target: string): Promise<void>;
    /** Delete files/directories. */
    delete(paths: string[], recursive?: boolean): Promise<void>;
    /** Create a directory. */
    mkdir(path: string): Promise<void>;
    /** Check if a path exists. */
    exists(path: string): Promise<boolean>;
    /** Get file/directory metadata. */
    stat(path: string): Promise<FileStatAPI>;
  };

  /** UI operations. */
  ui: {
    /** Show a message dialog. */
    showMessage(title: string, message: string, type?: "info" | "warning" | "error"): Promise<void>;
    /** Show an input dialog, returns user input or null if cancelled. */
    showInput(title: string, prompt: string, defaultValue?: string): Promise<string | null>;
    /** Show a confirmation dialog, returns true if confirmed. */
    showConfirm(title: string, message: string): Promise<boolean>;
    /** Show a notification toast. */
    showNotification(message: string, type?: "info" | "success" | "warning" | "error"): void;
    /** Add an item to the status bar. */
    setStatusBarItem(id: string, text: string, priority?: number): void;
    /** Remove a status bar item. */
    removeStatusBarItem(id: string): void;
    /** Refresh the current panel's file listing. */
    refreshPanel(side?: "left" | "right" | "active"): void;
  };

  /** Panel navigation. */
  panel: {
    /** Get the current path of a panel. */
    getPath(side: "left" | "right" | "active"): string;
    /** Navigate a panel to a path. */
    navigate(path: string, side?: "left" | "right" | "active"): Promise<void>;
    /** Get the currently selected entries. */
    getSelection(side?: "left" | "right" | "active"): FileEntryAPI[];
    /** Get the active panel side. */
    getActivePanel(): "left" | "right";
    /** Set the active panel. */
    setActivePanel(side: "left" | "right"): void;
  };

  /** Event system. */
  events: {
    /** Subscribe to an event. Returns an unsubscribe function. */
    on(event: NexusEvent, handler: (...args: any[]) => void): () => void;
    /** Emit a custom event. */
    emit(event: string, ...args: any[]): void;
  };

  /** Command registry. */
  commands: {
    /** Register a command handler. */
    register(command: string, handler: (...args: any[]) => void | Promise<void>): void;
    /** Execute a command. */
    execute(command: string, ...args: any[]): Promise<void>;
  };

  /** Shell execution (requires "system:shell" permission). */
  shell: {
    /** Execute a shell command. */
    execute(command: string, args?: string[], cwd?: string): Promise<ShellResultAPI>;
  };
}

// ===== Supporting types =====

export interface FileEntryAPI {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  modified: number;
  extension: string;
  permissions: string;
}

export interface FileStatAPI {
  exists: boolean;
  isDir: boolean;
  isFile: boolean;
  isSymlink: boolean;
  size: number;
  modified: number;
  created: number;
  permissions: string;
}

export interface ShellResultAPI {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Events that plugins can subscribe to.
 */
export type NexusEvent =
  | "panel:navigate"       // Panel navigated to a new directory
  | "panel:select"         // Selection changed
  | "panel:activate"       // Panel gained focus
  | "file:beforeCopy"      // Before copy operation (cancellable)
  | "file:afterCopy"       // After copy completed
  | "file:beforeMove"      // Before move operation (cancellable)
  | "file:afterMove"       // After move completed
  | "file:beforeDelete"    // Before delete operation (cancellable)
  | "file:afterDelete"     // After delete completed
  | "file:beforeRename"    // Before rename (cancellable)
  | "file:afterRename"     // After rename completed
  | "viewer:open"          // File viewer opened
  | "viewer:close"         // File viewer closed
  | "app:ready"            // Application fully loaded
  | "app:beforeQuit"       // Before application quit
  ;

// ===== Plugin lifecycle interface =====

/**
 * A plugin must export a default object implementing this interface.
 */
export interface NexusPlugin {
  /** Called when the plugin is activated. */
  activate(api: NexusAPI): void | Promise<void>;
  /** Called when the plugin is deactivated. */
  deactivate?(): void | Promise<void>;
}

// Example plugin:
// 
// export default {
//   activate(nexus) {
//     nexus.commands.register("my-plugin.hello", () => {
//       nexus.ui.showMessage("Hello", "Hello from My Plugin!");
//     });
//
//     nexus.events.on("panel:navigate", (side, path) => {
//       console.log(`Panel ${side} navigated to ${path}`);
//     });
//   },
//   deactivate() {
//     console.log("Plugin deactivated");
//   },
// } satisfies NexusPlugin;
