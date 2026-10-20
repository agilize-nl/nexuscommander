/** Shell shortcuts are resolved before panel keys, so modifiers never trigger file operations. */
export function shellShortcut(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>): string | undefined {
  if (e.metaKey) return;
  const key = e.key.toLowerCase();
  if (e.ctrlKey && !e.altKey) {
    if (e.shiftKey) return key === 'u' ? 'equalize-panels' : undefined;
    return ({ f1: 'view-brief', f2: 'view-full', f8: 'view-tree', j: 'toggle-tasks',
      p: 'command-palette', r: 'refresh', u: 'swap-panels' } as Record<string, string>)[key];
  }
  if (!e.ctrlKey && !e.altKey && e.shiftKey && key === 'f4') return 'open-terminal';
  if (e.altKey && !e.ctrlKey && !e.shiftKey && key === 'f7') return 'search';
  if (!e.ctrlKey && !e.altKey && !e.shiftKey) {
    return ({ f1: 'help-contents', f9: 'toggle-tasks', f10: 'command-palette', f12: 'command-palette' } as Record<string, string>)[key];
  }
}

export function isTextTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' ||
    target.isContentEditable || !!target.closest('[contenteditable="true"]'));
}

type Translate = (key: string) => string;

/**
 * A shortcut label as the user's keyboard prints it: "Ctrl+Insert" reads
 * "Strg+Einfg" in German, "PgUp" reads "Bild↑". Labels are stored in English
 * (they double as documentation) and only the key names are swapped on display;
 * letters, digits, F-keys and symbols stay as they are.
 */
export function displayShortcut(shortcut: string, t: Translate): string {
  return shortcut.replace(/\b(Ctrl|Alt|Shift|Space|Insert|Enter|Num|PgUp|PgDn|Esc)\b/g, (name) => t(`keys.${name.toLowerCase()}`));
}
