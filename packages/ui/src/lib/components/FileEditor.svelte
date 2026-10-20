<script lang="ts">
  import { onMount } from "svelte";
  import { Compartment, EditorState, Prec } from "@codemirror/state";
  import { EditorView, keymap, lineNumbers } from "@codemirror/view";
  import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
  import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
  import { syntaxHighlighting, HighlightStyle, type Language } from "@codemirror/language";
  import { tags } from "@lezer/highlight";

  interface Props {
    path: string;
    value: string;
    readOnly?: boolean;
    onChange?: (value: string) => void;
    onSave?: () => void;
  }

  let { path, value, readOnly = false, onChange, onSave }: Props = $props();

  let host: HTMLDivElement | undefined = $state(undefined);
  let view: EditorView | null = $state(null);
  const languageCompartment = new Compartment();
  let languageLoadRequest = 0;
  let activeLanguage: Language | null = null;

  function keepEditorKeypressesLocal(event: KeyboardEvent) {
    // FileList listens on window for commander shortcuts (Backspace means
    // "up one directory", arrows move the selection, …). CodeMirror must
    // own every editing key before that listener can see it. Do not prevent
    // the default: CodeMirror and the browser still need to insert/delete.
    // Escape deliberately bubbles to the editor modal, where it closes it.
    if (event.key !== "Escape") event.stopPropagation();
  }

  // Token colours come from the active NexusCommander theme rather than a fixed
  // palette, so the editor stays readable on the light themes too. The chrome
  // (background, gutters, selection) is styled with the same vars below.
  const ncHighlightStyle = HighlightStyle.define([
    { tag: [tags.keyword, tags.modifier, tags.operatorKeyword], color: "var(--color-nc-archive)" },
    { tag: tags.string, color: "var(--color-nc-warning)" },
    { tag: tags.regexp, color: "var(--color-nc-warning)" },
    { tag: tags.comment, color: "var(--color-nc-text-dim)", fontStyle: "italic" },
    { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--color-nc-image)" },
    { tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], color: "var(--color-nc-exec)" },
    { tag: [tags.typeName, tags.className, tags.namespace, tags.tagName], color: "var(--color-nc-symlink)" },
    { tag: [tags.propertyName, tags.attributeName], color: "var(--color-nc-accent)" },
    { tag: [tags.operator, tags.punctuation, tags.bracket, tags.separator], color: "var(--color-nc-text-dim)" },
    { tag: tags.heading, color: "var(--color-nc-accent)", fontWeight: "700" },
    { tag: [tags.link, tags.url], color: "var(--color-nc-accent)", textDecoration: "underline" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.strong, fontWeight: "700" },
    { tag: tags.meta, color: "var(--color-nc-text-dim)" },
    { tag: tags.invalid, color: "var(--color-nc-danger)" }
  ]);

  async function languageForPath(filePath: string): Promise<Language | null> {
    const normalized = filePath.toLowerCase();
    if (normalized.endsWith(".css")) {
      return (await import("@codemirror/lang-css")).cssLanguage;
    }
    if (normalized.endsWith(".html") || normalized.endsWith(".htm") || normalized.endsWith(".svelte")) {
      return (await import("@codemirror/lang-html")).htmlLanguage;
    }
    if (normalized.endsWith(".js")) {
      return (await import("@codemirror/lang-javascript")).javascriptLanguage;
    }
    if (normalized.endsWith(".ts")) {
      return (await import("@codemirror/lang-javascript")).typescriptLanguage;
    }
    if (normalized.endsWith(".json")) {
      return (await import("@codemirror/lang-json")).jsonLanguage;
    }
    if (normalized.endsWith(".md")) {
      return (await import("@codemirror/lang-markdown")).markdownLanguage;
    }
    if (normalized.endsWith(".py")) {
      return (await import("@codemirror/lang-python")).pythonLanguage;
    }
    if (normalized.endsWith(".sql")) {
      return (await import("@codemirror/lang-sql")).sql().language;
    }
    if (normalized.endsWith(".xml")) {
      return (await import("@codemirror/lang-xml")).xmlLanguage;
    }
    if (normalized.endsWith(".yml") || normalized.endsWith(".yaml")) {
      return (await import("@codemirror/lang-yaml")).yamlLanguage;
    }
    return null;
  }

  async function updateLanguage(filePath: string) {
    const request = ++languageLoadRequest;
    activeLanguage = null;

    if (view) {
      view.dispatch({
        effects: languageCompartment.reconfigure([])
      });
    }

    try {
      const language = await languageForPath(filePath);
      if (request !== languageLoadRequest || !view) return;

      activeLanguage = language;
      view.dispatch({
        effects: languageCompartment.reconfigure(language ?? [])
      });
    } catch (e) {
      // Editing remains available without syntax highlighting if a parser
      // chunk cannot be loaded.
      console.error(`Failed to load syntax highlighting for ${filePath}:`, e);
    }
  }

  function createState(doc: string) {
    return EditorState.create({
      doc,
      extensions: [
        // Ctrl+S is bound inside the editor rather than only on `window`, so it
        // fires whenever the editor has focus regardless of listener ordering.
        Prec.highest(
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              stopPropagation: true,
              run: () => {
                onSave?.();
                return true;
              }
            }
          ])
        ),
        lineNumbers(),
        history(),
        highlightSelectionMatches(),
        syntaxHighlighting(ncHighlightStyle),
        EditorView.lineWrapping,
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChange?.(update.state.doc.toString());
          }
        }),
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
        languageCompartment.of(activeLanguage ?? [])
      ]
    });
  }

  onMount(() => {
    if (!host) return;
    view = new EditorView({
      state: createState(value),
      parent: host
    });

    // Without this the file panel keeps keyboard focus and swallows every
    // keystroke, which makes the editor look read-only.
    if (!readOnly) view.focus();

    return () => {
      languageLoadRequest += 1;
      view?.destroy();
      view = null;
    };
  });

  $effect(() => {
    const currentPath = path;
    if (!view) return;
    void updateLanguage(currentPath);
  });

  $effect(() => {
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.setState(createState(value));
  });
</script>

<div class="editor-root" bind:this={host} onkeydown={keepEditorKeypressesLocal} role="presentation"></div>

<style>
  .editor-root {
    flex: 1;
    min-height: 0;
    background: var(--color-nc-bg);
    /* The shells deliberately disable selection globally for the file-manager
       UI. CodeMirror is a contenteditable control, so it must explicitly opt
       back in or Chromium inherits the non-editable interaction behaviour. */
    user-select: text;
    -webkit-user-select: text;
  }

  :global(.editor-root .cm-editor) {
    height: 100%;
    font-size: var(--font-editor-size);
    background: var(--color-nc-bg);
    color: var(--color-nc-text);
  }

  :global(.editor-root .cm-editor.cm-focused) {
    outline: none;
  }

  :global(.editor-root .cm-scroller) {
    font-family: var(--font-editor-name);
    line-height: 1.5;
  }

  :global(.editor-root .cm-content) {
    cursor: text;
    user-select: text;
    -webkit-user-select: text;
  }

  :global(.editor-root .cm-gutters) {
    background: var(--color-nc-bg-panel);
    color: var(--color-nc-text-dim);
    border-right: 1px solid var(--color-nc-border);
  }

  :global(.editor-root .cm-activeLine),
  :global(.editor-root .cm-activeLineGutter) {
    background: var(--color-nc-bg-hover);
  }

  :global(.editor-root .cm-cursor) {
    border-left-color: var(--color-nc-text-bright);
  }

  /* CodeMirror renders its own selection layer, so ::selection alone is not enough. */
  :global(.editor-root .cm-selectionBackground),
  :global(.editor-root .cm-content ::selection),
  :global(.editor-root.cm-focused .cm-selectionBackground) {
    background: var(--color-nc-bg-selected);
  }

  :global(.editor-root .cm-selectionMatch) {
    background: var(--color-nc-accent-glow);
  }
</style>
