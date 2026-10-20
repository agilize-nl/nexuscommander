<script lang="ts">
  import { tick, untrack } from "svelte";
  import { fade, scale } from "svelte/transition";
  import { Book, Search, X, ChevronRight, ChevronDown, ExternalLink, HelpCircle } from "lucide-svelte";
  import { _, locale } from "../i18n";
  import topicsData from "../help/topics.json";

  // Load all markdown files as raw strings
  const helpFiles = import.meta.glob('../help/*.md', { query: '?raw', import: 'default', eager: true });

  interface HelpTopic {
    id: string;
    label: string;
    labelKey?: string;
    file?: string;
    children?: HelpTopic[];
  }

  const { onclose, startTopic = "intro" } = $props<{ onclose?: () => void, startTopic?: string }>();

  let activeTopicId = $state(untrack(() => startTopic));
  
  $effect(() => {
    activeTopicId = startTopic;
  });
  let searchQuery = $state("");
  let expandedGroups = $state<Set<string>>(new Set(["basics", "operations", "advanced", "config"]));
  let contentScroll: HTMLDivElement;

  // Flattened topics for searching
  const flattenedTopics = $derived.by(() => {
    const flat: { id: string, label: string, labelKey?: string, file?: string }[] = [];
    const traverse = (items: HelpTopic[]) => {
      for (const item of items) {
        if (item.file) flat.push({ id: item.id, label: item.label, labelKey: item.labelKey, file: item.file });
        if (item.children) traverse(item.children);
      }
    };
    traverse(topicsData as HelpTopic[]);
    return flat;
  });

  const filteredTopics = $derived(
    searchQuery.trim() === "" 
      ? null 
      : flattenedTopics.filter(t => {
          const label = t.labelKey ? $_(t.labelKey) : t.label;
          return label.toLowerCase().includes(searchQuery.toLowerCase());
        })
  );

  const currentTopic = $derived(flattenedTopics.find(t => t.id === activeTopicId));
  
  const rawContent = $derived.by(() => {
    if (!currentTopic?.file) return `# ${$_('help_viewer.topic_not_found')}\n\n${$_('help_viewer.missing_content')}`;
    
    // Try to load localized version first
    const fileBase = currentTopic.file.replace('.md', '');
    const localizedKey = `../help/${fileBase}.${$locale}.md`;
    const defaultKey = `../help/${currentTopic.file}`;
    
    if (helpFiles[localizedKey]) {
      return (helpFiles[localizedKey] as string);
    }
    
    return (helpFiles[defaultKey] as string) || `# ${$_('help_viewer.file_not_found')}\n\n${$_('help_viewer.could_not_load', { file: currentTopic.file })}`;
  });

  // Simple Markdown Parser
  // The source is escaped before any markup is added, so the only HTML in the
  // result is what this function itself writes. Internal links carry their
  // topic in a data attribute and are handled by `handleContentClick`: the
  // inline `onclick` they used to carry is blocked by the desktop CSP
  // (`script-src 'self'`), so topic links did nothing there.
  function escapeHtml(text: string) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function parseMarkdown(md: string) {
    if (!md) return "";

    let html = escapeHtml(md)
      .replace(/^# (.*$)/gim, '<h1>$1</h1>')
      .replace(/^## (.*$)/gim, '<h2>$1</h2>')
      .replace(/^### (.*$)/gim, '<h3>$1</h3>')
      .replace(/^&gt; (.*$)/gim, '<blockquote>$1</blockquote>')
      .replace(/\*\*(.*)\*\*/gim, '<strong>$1</strong>')
      .replace(/\*(.*)\*/gim, '<em>$1</em>')
      .replace(/!\[(.*?)\]\((.*?)\)/gim, '<img alt="$1" src="$2" />')
      .replace(/\[(.*?)\]\((.*?)\)/gim, (match, text, link) => {
        // If it's a topic ID link, we handle it internally
        if (!link.startsWith('http') && !link.includes('.') && !link.includes('/')) {
          return `<a href="#" data-help-topic="${link}">${text}</a>`;
        }
        if (!/^https?:\/\//i.test(link)) return text;
        return `<a href="${link}" target="_blank" rel="noopener noreferrer">${text} <span class="ext-icon">↗</span></a>`;
      })
      .replace(/^\- (.*$)/gim, '<li>$1</li>')
      .replace(/<\/li>\n<li>/gim, '</li><li>') // Bundle lists
      .replace(/(<li>.*<\/li>)/gim, '<ul>$1</ul>')
      .replace(/`(.*?)`/gim, '<code>$1</code>')
      .replace(/\n\n/gim, '</p><p>')
      .replace(/\n/gim, '<br />');

    return `<p>${html}</p>`
      .replace(/<p><ul>/g, '<ul>')
      .replace(/<\/ul><\/p>/g, '</ul>')
      .replace(/<p><h1>/g, '<h1>')
      .replace(/<\/h1><\/p>/g, '</h1>')
      .replace(/<p><h2>/g, '<h2>')
      .replace(/<\/h2><\/p>/g, '</h2>')
      .replace(/<p><h3>/g, '<h3>')
      .replace(/<\/h3><\/p>/g, '</h3>');
  }

  const renderedHtml = $derived(parseMarkdown(rawContent));

  async function selectTopic(id: string) {
    activeTopicId = id;
    searchQuery = "";
    await tick();
    contentScroll.scrollTo({ top: 0 });
  }

  function toggleGroup(id: string) {
    if (expandedGroups.has(id)) {
      expandedGroups.delete(id);
    } else {
      expandedGroups.add(id);
    }
    expandedGroups = new Set(expandedGroups);
  }

  function handleContentClick(e: MouseEvent) {
    const link = (e.target as Element | null)?.closest?.("a[data-help-topic]");
    if (!link) return;
    e.preventDefault();
    selectTopic(link.getAttribute("data-help-topic") ?? "");
  }

  // Dragging state
  let pos = $state({ x: 0, y: 0 });
  let size = $state({ width: 900, height: 650 });
  let dragging = $state(false);
  let dragStart = { x: 0, y: 0 };

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onclose?.();
    }
  }

  function startDrag(e: MouseEvent) {
    if ((e.target as HTMLElement).closest('.close-btn') || (e.target as HTMLElement).closest('.search-box')) return;
    dragging = true;
    dragStart = { x: e.clientX - pos.x, y: e.clientY - pos.y };
  }

  function handleMouseMove(e: MouseEvent) {
    if (dragging) {
      pos.x = e.clientX - dragStart.x;
      pos.y = e.clientY - dragStart.y;
    }
  }

  function stopDrag() {
    dragging = false;
  }
</script>

<svelte:window onmousemove={handleMouseMove} onmouseup={stopDrag} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div 
  class="help-backdrop" 
  onclick={onclose} 
  onkeydown={handleKeydown}
  in:fade={{ duration: 150 }} 
  out:fade={{ duration: 100 }}
  role="presentation"
>
  <div 
    class="help-modal" 
    onclick={(e) => e.stopPropagation()} 
    in:scale={{ start: 0.95, duration: 150 }} 
    out:scale={{ start: 0.95, duration: 100 }}
    style="transform: translate({pos.x}px, {pos.y}px); width: {size.width}px; height: {size.height}px;"
  >
    <header class="help-header" onmousedown={startDrag}>
      <div class="header-left">
        <HelpCircle size={18} class="help-icon" />
        <span class="title">{$_('help_viewer.title')}</span>
      </div>
      
      <div class="search-box">
        <Search size={14} class="search-icon" />
        <input 
          type="text" 
          placeholder={$_('help_viewer.search_placeholder')} 
          bind:value={searchQuery}
          onkeydown={(e) => e.stopPropagation()}
        />
        {#if searchQuery}
          <button class="clear-search" onclick={() => searchQuery = ""}>✕</button>
        {/if}
      </div>

      <button class="close-btn" onclick={onclose}>✕</button>
    </header>

    <div class="help-content-wrapper">
      <aside class="help-sidebar">
        <div class="sidebar-scroll">
          {#if searchQuery}
            <div class="search-results">
              <div class="results-header">{$_('help_viewer.search_results', { n: filteredTopics?.length || 0 })}</div>
              {#each filteredTopics || [] as topic}
                <button 
                  class="sidebar-item search-result" 
                  class:active={activeTopicId === topic.id}
                  onclick={() => selectTopic(topic.id)}
                >
                  {topic.labelKey ? $_(topic.labelKey) : topic.label}
                </button>
              {:else}
                <div class="no-results">{$_('help_viewer.no_topics_match', { query: searchQuery })}</div>
              {/each}
            </div>
          {:else}
            {#each topicsData as topic}
              <div class="nav-group">
                {#if topic.children}
                  <button class="group-header" onclick={() => toggleGroup(topic.id)}>
                    {#if expandedGroups.has(topic.id)}
                      <ChevronDown size={14} />
                    {:else}
                      <ChevronRight size={14} />
                    {/if}
                    {topic.labelKey ? $_(topic.labelKey) : topic.label}
                  </button>
                  {#if expandedGroups.has(topic.id)}
                    <div class="group-children" in:fade={{ duration: 100 }}>
                      {#each topic.children as child}
                        <button 
                          class="sidebar-item" 
                          class:active={activeTopicId === child.id}
                          onclick={() => selectTopic(child.id)}
                        >
                          {child.labelKey ? $_(child.labelKey) : child.label}
                        </button>
                      {/each}
                    </div>
                  {/if}
                {:else}
                  <button 
                    class="sidebar-item root-item" 
                    class:active={activeTopicId === topic.id}
                    onclick={() => selectTopic(topic.id)}
                  >
                    {topic.labelKey ? $_(topic.labelKey) : topic.label}
                  </button>
                {/if}
              </div>
            {/each}
          {/if}
        </div>
      </aside>

      <main class="help-main">
        <div class="content-scroll" bind:this={contentScroll}>
          <!-- Delegated: the links are generated markup, and Enter on a focused
               link dispatches the same click. -->
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <article class="markdown-body" onclick={handleContentClick}>
            {@html renderedHtml}
          </article>
        </div>
      </main>
    </div>

    <footer class="help-footer">
      <div class="breadcrumb">
        {$_('help_viewer.breadcrumb', {
          topic: currentTopic ? (currentTopic.labelKey ? $_(currentTopic.labelKey) : currentTopic.label) : '...'
        })}
      </div>
      <div class="status">{$_('help_viewer.close_hint')}</div>
    </footer>
  </div>
</div>

<style>
  .help-backdrop {
    position: fixed;
    inset: 0;
    background: transparent;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 7000;
  }

  .help-modal {
    background: var(--color-nc-bg-deep);
    border: 1px solid var(--color-nc-border-bright);
    border-radius: 8px;
    box-shadow: 0 30px 90px rgba(0, 0, 0, 0.7);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    position: relative;
  }

  .help-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 16px;
    background: var(--color-nc-bg-header);
    border-bottom: 1px solid var(--color-nc-border);
    cursor: move;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 200px;
  }

  :global(.help-icon) { color: var(--color-nc-accent); }
  .title { font-size: 13px; font-weight: 600; color: var(--color-nc-text-bright); }

  .search-box {
    flex: 1;
    max-width: 400px;
    position: relative;
    margin: 0 20px;
  }

  :global(.search-icon) {
    position: absolute;
    left: 10px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--color-nc-text-dim);
    pointer-events: none;
  }

  .search-box input {
    width: 100%;
    background: var(--color-nc-bg-deep);
    border: 1px solid var(--color-nc-border);
    border-radius: 4px;
    padding: 5px 30px 5px 30px;
    font-size: 12px;
    color: var(--color-nc-text-bright);
    outline: none;
    transition: all 0.2s;
  }

  .search-box input:focus {
    border-color: var(--color-nc-accent);
    box-shadow: 0 0 0 2px var(--color-nc-accent-glow);
    background: var(--color-nc-bg);
  }

  .clear-search {
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    background: none;
    border: none;
    color: var(--color-nc-text-dim);
    cursor: pointer;
    font-size: 12px;
    padding: 2px;
  }

  .close-btn {
    background: none;
    border: none;
    color: var(--color-nc-text-dim);
    cursor: pointer;
    font-size: 16px;
    padding: 4px;
    border-radius: 4px;
    transition: all 0.2s;
  }

  .close-btn:hover { background: var(--color-nc-danger); color: white; }

  .help-content-wrapper {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  .help-sidebar {
    width: 240px;
    background: var(--color-nc-bg-panel);
    border-right: 1px solid var(--color-nc-border);
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .sidebar-scroll {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0;
  }

  .nav-group {
    display: flex;
    flex-direction: column;
    margin-bottom: 4px;
  }

  .group-header {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 16px;
    background: transparent;
    border: none;
    color: var(--color-nc-text-bright);
    font-size: 12px;
    font-weight: 600;
    text-align: left;
    cursor: pointer;
  }

  .group-header:hover { background: var(--color-nc-bg-hover); }

  .group-children {
    display: flex;
    flex-direction: column;
    padding-left: 12px;
  }

  .sidebar-item {
    padding: 6px 16px 6px 20px;
    background: transparent;
    border: none;
    color: var(--color-nc-text);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
    transition: all 0.15s;
    border-left: 2px solid transparent;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .sidebar-item.root-item { padding-left: 16px; font-weight: 500; }

  .sidebar-item:hover {
    background: var(--color-nc-bg-hover);
    color: var(--color-nc-text-bright);
  }

  .sidebar-item.active {
    background: var(--color-nc-accent-dim);
    color: var(--color-nc-accent);
    border-left-color: var(--color-nc-accent);
    font-weight: 600;
  }

  .results-header {
    padding: 8px 16px;
    font-size: 11px;
    text-transform: uppercase;
    color: var(--color-nc-text-dim);
    letter-spacing: 0.05em;
  }

  .no-results {
    padding: 20px 16px;
    color: var(--color-nc-text-dim);
    font-size: 12px;
    text-align: center;
    font-style: italic;
  }

  .help-main {
    flex: 1;
    background: var(--color-nc-bg);
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .content-scroll {
    flex: 1;
    overflow-y: auto;
    padding: 40px 60px;
  }

  .help-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 16px;
    background: var(--color-nc-bg-header);
    border-top: 1px solid var(--color-nc-border);
    font-size: 11px;
    color: var(--color-nc-text-dim);
  }

  /* Markdown Styles */
  .markdown-body {
    color: var(--color-nc-text);
    line-height: 1.6;
    font-size: 14px;
    max-width: 800px;
    margin: 0 auto;
  }

  .markdown-body :global(h1) {
    font-size: 28px;
    color: var(--color-nc-text-bright);
    margin-bottom: 24px;
    border-bottom: 2px solid var(--color-nc-border);
    padding-bottom: 12px;
  }

  .markdown-body :global(h2) {
    font-size: 20px;
    color: var(--color-nc-accent);
    margin: 32px 0 16px 0;
    font-weight: 600;
  }

  .markdown-body :global(h3) {
    font-size: 16px;
    color: var(--color-nc-text-bright);
    margin: 24px 0 12px 0;
  }

  .markdown-body :global(p) { margin-bottom: 16px; }

  .markdown-body :global(ul) { margin-bottom: 16px; padding-left: 20px; }
  .markdown-body :global(li) { margin-bottom: 8px; }

  .markdown-body :global(strong) { color: var(--color-nc-text-bright); font-weight: 600; }

  .markdown-body :global(code) {
    background: var(--color-nc-bg-deep);
    padding: 2px 6px;
    border-radius: 4px;
    font-family: var(--font-family-mono);
    font-size: 12px;
    color: var(--color-nc-accent-bright);
  }

  .markdown-body :global(blockquote) {
    border-left: 4px solid var(--color-nc-accent-dim);
    background: rgba(var(--color-nc-accent-rgb), 0.05);
    padding: 12px 20px;
    margin: 20px 0;
    font-style: italic;
  }

  .markdown-body :global(a) {
    color: var(--color-nc-accent);
    text-decoration: none;
    border-bottom: 1px dashed transparent;
    transition: all 0.2s;
  }

  .markdown-body :global(a:hover) {
    color: var(--color-nc-accent-bright);
    border-bottom-color: var(--color-nc-accent);
  }

  :global(.ext-icon) { font-size: 10px; margin-left: 2px; opacity: 0.6; }
</style>
