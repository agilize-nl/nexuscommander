<script lang="ts">
  import { onMount } from "svelte";
  import { readDirectory } from "$lib/ipc";
  import type { FileEntry } from "$lib/types";
  import { _ } from "$lib/i18n";
  import { isOverlayActive } from "$lib/stores";

  interface Props {
    rootPath: string;
    onselect: (path: string) => void;
  }

  let { rootPath, onselect }: Props = $props();

  interface TreeNode {
    name: string;
    path: string;
    isDir: boolean;
    children: TreeNode[] | null;
    expanded: boolean;
    loading: boolean;
    level: number;
  }

  let tree = $state<TreeNode[]>([]);
  let overlayActive = $state(false);
  isOverlayActive.subscribe(v => overlayActive = v);

  onMount(() => {
    tree = [
      {
        name: rootPath === "/" ? $_('common.root') : rootPath.split("/").pop() || rootPath,
        path: rootPath,
        isDir: true,
        children: null,
        expanded: false,
        loading: false,
        level: 0
      }
    ];
  });

  async function toggleNode(node: TreeNode) {
    if (overlayActive) return;
    if (!node.isDir) return;
    
    node.expanded = !node.expanded;
    
    if (node.expanded && node.children === null) {
      node.loading = true;
      try {
        const entries = await readDirectory(node.path);
        node.children = entries
          .filter(e => e.is_dir)
          .map(e => ({
            name: e.name,
            path: node.path === "/" ? `/${e.name}` : `${node.path}/${e.name}`,
            isDir: true,
            children: null,
            expanded: false,
            loading: false,
            level: node.level + 1
          }));
      } catch (e) {
        console.error("Failed to load tree node:", e);
        node.expanded = false;
      } finally {
        node.loading = false;
      }
    }
  }

  function handleSelect(node: TreeNode) {
    if (overlayActive) return;
    onselect(node.path);
  }

  // Flattened tree for rendering
  let visibleNodes = $derived.by(() => {
    const flat: TreeNode[] = [];
    function walk(nodes: TreeNode[]) {
      for (const node of nodes) {
        flat.push(node);
        if (node.expanded && node.children) {
          walk(node.children);
        }
      }
    }
    walk(tree);
    return flat;
  });
</script>

<div class="tree-container">
  {#each visibleNodes as node}
    <div 
      class="tree-node" 
      style="padding-left: {node.level * 16 + 8}px"
      onclick={() => handleSelect(node)}
      role="button"
      tabindex="0"
      onkeydown={(e) => e.key === "Enter" && handleSelect(node)}
    >
      <span 
        class="toggle" 
        class:expanded={node.expanded} 
        class:hidden={!node.isDir}
        onclick={(e) => { e.stopPropagation(); toggleNode(node); }}
        onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); toggleNode(node); } }}
        role="button"
        tabindex="0"
      >
        {node.expanded ? "▼" : "▶"}
      </span>
      <span class="icon">{node.isDir ? "📁" : "📄"}</span>
      <span class="name">{node.name}</span>
      {#if node.loading}
        <span class="loading-spinner">...</span>
      {/if}
    </div>
  {/each}
</div>

<style>
  .tree-container {
    flex: 1;
    overflow-y: auto;
    background: var(--color-nc-bg-deep);
    color: var(--color-nc-text);
    font-size: 13px;
    user-select: none;
  }

  .tree-node {
    display: flex;
    align-items: center;
    padding: 4px 8px;
    cursor: default;
    white-space: nowrap;
    border: 1px solid transparent;
  }

  .tree-node:hover {
    background: var(--color-nc-bg-panel);
    border-color: var(--color-nc-border);
  }

  .tree-node:focus {
    outline: none;
    background: var(--color-nc-accent-dim);
    color: var(--color-nc-text-bright);
  }

  .toggle {
    width: 16px;
    height: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    color: var(--color-nc-text-dim);
    cursor: pointer;
    transition: transform 0.2s;
  }

  .toggle.expanded {
    z-index: 1;
  }

  .toggle.hidden {
    visibility: hidden;
  }

  .icon {
    margin: 0 6px;
    font-size: 14px;
    opacity: 0.8;
  }

  .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .loading-spinner {
    font-size: 10px;
    color: var(--color-nc-accent);
    margin-left: 8px;
  }
</style>
