<script lang="ts">
  import { onMount } from "svelte";
  import { EditorState } from "@codemirror/state";
  import { EditorView, keymap, lineNumbers } from "@codemirror/view";
  import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
  import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
  import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
  import { cssLanguage } from "@codemirror/lang-css";
  import { htmlLanguage } from "@codemirror/lang-html";
  import { javascriptLanguage, typescriptLanguage } from "@codemirror/lang-javascript";
  import { jsonLanguage } from "@codemirror/lang-json";
  import { markdownLanguage } from "@codemirror/lang-markdown";
  import { pythonLanguage } from "@codemirror/lang-python";
  import { sql } from "@codemirror/lang-sql";
  import { xmlLanguage } from "@codemirror/lang-xml";
  import { yamlLanguage } from "@codemirror/lang-yaml";

  interface Props {
    path: string;
    value: string;
    readOnly?: boolean;
    onChange?: (value: string) => void;
  }

  let { path, value, readOnly = false, onChange }: Props = $props();

  let host: HTMLDivElement | undefined = $state(undefined);
  let view: EditorView | null = null;

  function languageForPath(filePath: string) {
    const normalized = filePath.toLowerCase();
    if (normalized.endsWith(".css")) return cssLanguage;
    if (normalized.endsWith(".html") || normalized.endsWith(".htm") || normalized.endsWith(".svelte")) return htmlLanguage;
    if (normalized.endsWith(".js")) return javascriptLanguage;
    if (normalized.endsWith(".ts")) return typescriptLanguage;
    if (normalized.endsWith(".json")) return jsonLanguage;
    if (normalized.endsWith(".md")) return markdownLanguage;
    if (normalized.endsWith(".py")) return pythonLanguage;
    if (normalized.endsWith(".sql")) return sql().language;
    if (normalized.endsWith(".xml")) return xmlLanguage;
    if (normalized.endsWith(".yml") || normalized.endsWith(".yaml")) return yamlLanguage;
    return null;
  }

  function createState(doc: string) {
    const language = languageForPath(path);
    return EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        history(),
        highlightSelectionMatches(),
        syntaxHighlighting(defaultHighlightStyle),
        EditorView.lineWrapping,
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChange?.(update.state.doc.toString());
          }
        }),
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
        ...(language ? [language] : [])
      ]
    });
  }

  onMount(() => {
    if (!host) return;
    view = new EditorView({
      state: createState(value),
      parent: host
    });

    return () => {
      view?.destroy();
      view = null;
    };
  });

  $effect(() => {
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.setState(createState(value));
  });
</script>

<div class="editor-root" bind:this={host}></div>

<style>
  .editor-root {
    flex: 1;
    min-height: 0;
    background: #0f1721;
  }

  :global(.editor-root .cm-editor) {
    height: 100%;
    font-size: 13px;
    background: #0f1721;
    color: #e6edf7;
  }

  :global(.editor-root .cm-scroller) {
    font-family: "Fira Code", "JetBrains Mono", monospace;
  }

  :global(.editor-root .cm-gutters) {
    background: #16202b;
    color: #7e93a6;
    border-right: 1px solid #223142;
  }

  :global(.editor-root .cm-activeLine),
  :global(.editor-root .cm-activeLineGutter) {
    background: rgba(101, 163, 255, 0.12);
  }
</style>
