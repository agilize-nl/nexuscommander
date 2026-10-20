<script lang="ts">
  import { fade, scale } from "svelte/transition";
  import { Info, Github, Atom, Wind, Feather, Zap } from "lucide-svelte";
  import { _ } from "../i18n";

  export interface TechEntry {
    name: string;
    /** A lucide-svelte icon; this release still exports legacy class components. */
    icon: typeof Atom;
    /** i18n key for the one-line description. */
    detail: string;
  }

  // `version` and `platformTech` are the only genuinely per-shell bits: each
  // app reads its own package.json, and the runtime half of the stack differs
  // (Tauri/Rust vs Express). Everything else is the same product.
  let {
    version,
    platformTech = [],
    onclose
  } = $props<{
    version: string;
    platformTech?: TechEntry[];
    onclose?: () => void;
  }>();

  const techStack = $derived<TechEntry[]>([
    { name: "Svelte 5", icon: Atom, detail: "about.tech_svelte" },
    ...platformTech,
    { name: "Tailwind CSS v4", icon: Wind, detail: "about.tech_tailwind" },
    { name: "Lucide Svelte", icon: Feather, detail: "about.tech_lucide" },
    { name: "Vite 6", icon: Zap, detail: "about.tech_vite" }
  ]);

  // Dragging state
  let pos = $state({ x: 0, y: 0 });
  let dragging = $state(false);
  let dragStart = { x: 0, y: 0 };

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  }

  function close() {
    onclose?.();
  }

  function startDrag(e: MouseEvent) {
    if ((e.target as HTMLElement).closest('.close-btn')) return;
    dragging = true;
    dragStart = { x: e.clientX - pos.x, y: e.clientY - pos.y };
  }

  function handleMouseMove(e: MouseEvent) {
    if (dragging) {
      let newX = e.clientX - dragStart.x;
      let newY = e.clientY - dragStart.y;

      const maxX = window.innerWidth / 2;
      const maxY = window.innerHeight / 2;

      pos.x = Math.max(-maxX, Math.min(newX, maxX));
      pos.y = Math.max(-maxY, Math.min(newY, maxY));
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
  class="modal-backdrop"
  onclick={close}
  onkeydown={handleKeydown}
  in:fade={{ duration: 150 }}
  out:fade={{ duration: 100 }}
  role="presentation"
>
  <div
    class="modal"
    onclick={(e) => e.stopPropagation()}
    in:scale={{ start: 0.95, duration: 150 }}
    out:scale={{ start: 0.95, duration: 100 }}
    style="transform: translate({pos.x}px, {pos.y}px);"
  >
    <header class="modal-header" onmousedown={startDrag} style="cursor: move;">
      <div class="title-group">
        <Info size={16} />
        <div class="title">{$_('about.title')}</div>
      </div>
      <button class="close-btn" onclick={close}>✕</button>
    </header>

    <div class="modal-body">
      <div class="app-info">
        <div class="logo-container">
           <img src="/logo.png" alt="Nexus Commander" class="app-logo" />
        </div>
        <div class="app-details">
          <h1>Nexus Commander</h1>
          <div class="version">{$_('about.version')} {version}</div>
          <p class="description">
            {$_('about.description')}
          </p>
        </div>
      </div>

      <div class="tech-section">
        <h3>{$_('about.tech_stack')}</h3>
        <div class="tech-grid">
          {#each techStack as tech}
            <div class="tech-item">
              <div class="tech-icon-wrapper">
                <tech.icon size={16} />
              </div>
              <div class="tech-text">
                <span class="tech-name">{tech.name}</span>
                <span class="tech-detail">{$_(tech.detail)}</span>
              </div>
            </div>
          {/each}
        </div>
      </div>

      <div class="footer-links">
        <a href="https://github.com/djawiz/NexusCommander" target="_blank" rel="noopener noreferrer" class="github-link">
          <Github size={14} />
          {$_('about.view_github')}
        </a>
        <div class="copyright">{$_('about.copyright')}</div>
      </div>
    </div>

    <div class="modal-footer">
      <button class="btn ok-btn" onclick={close}>{$_('common.close')}</button>
    </div>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: transparent;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 6000;
  }

  .modal {
    width: 480px;
    background: var(--color-nc-bg-deep);
    border: 1px solid var(--color-nc-border-bright);
    border-radius: 8px;
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    background: var(--color-nc-bg-header);
    border-bottom: 1px solid var(--color-nc-border);
  }

  .title-group {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--color-nc-accent);
  }

  .title {
    font-size: 14px;
    font-weight: 600;
    color: var(--color-nc-text-bright);
  }

  .close-btn {
    background: none;
    border: none;
    color: var(--color-nc-text-dim);
    cursor: pointer;
    font-size: 14px;
    padding: 4px;
    border-radius: 4px;
    transition: all 0.2s;
  }

  .close-btn:hover {
    background: var(--color-nc-bg-hover);
    color: var(--color-nc-danger);
  }

  .modal-body {
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 22px;
    background: linear-gradient(135deg, var(--color-nc-bg) 0%, var(--color-nc-bg-panel) 100%);
  }

  .app-info {
    display: flex;
    gap: 20px;
    align-items: center;
  }

  .logo-container {
    flex-shrink: 0;
    padding: 8px;
    background: var(--color-nc-bg-deep);
    border-radius: 14px;
    border: 1px solid var(--color-nc-border-bright);
    box-shadow: 0 0 0 3px var(--color-nc-accent-glow), 0 4px 16px rgba(0, 0, 0, 0.3);
  }

  .app-logo {
    width: 64px;
    height: 64px;
    object-fit: contain;
    display: block;
  }

  .app-details {
    min-width: 0;
  }

  .app-details h1 {
    font-size: 22px;
    margin: 0;
    color: var(--color-nc-text-bright);
    letter-spacing: -0.01em;
  }

  .version {
    display: inline-flex;
    align-items: center;
    margin-top: 6px;
    padding: 2px 10px;
    border-radius: 999px;
    font-size: 11px;
    font-family: var(--font-family-mono);
    color: var(--color-nc-accent);
    background: var(--color-nc-accent-glow);
    border: 1px solid var(--color-nc-accent-glow);
  }

  .description {
    font-size: 13px;
    color: var(--color-nc-text-dim);
    margin: 8px 0 0;
    line-height: 1.5;
  }

  .tech-section h3 {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--color-nc-text-dim);
    margin: 0 0 12px 0;
  }

  .tech-section h3::before {
    content: "";
    width: 3px;
    height: 12px;
    border-radius: 2px;
    background: var(--color-nc-accent);
  }

  .tech-section h3::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--color-nc-border);
  }

  .tech-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }

  .tech-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    background: var(--color-nc-bg-alt);
    border-radius: 8px;
    border: 1px solid var(--color-nc-border);
    transition: all 0.2s;
  }

  .tech-item:hover {
    background: var(--color-nc-bg-hover);
    border-color: var(--color-nc-accent-dim);
    box-shadow: 0 2px 10px var(--color-nc-accent-glow);
    transform: translateY(-1px);
  }

  .tech-icon-wrapper {
    flex-shrink: 0;
    width: 30px;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    color: var(--color-nc-accent);
    background: var(--color-nc-accent-glow);
  }

  .tech-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .tech-name {
    font-size: 12px;
    font-weight: 600;
    color: var(--color-nc-text-bright);
  }

  .tech-detail {
    font-size: 10px;
    color: var(--color-nc-text-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .footer-links {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding-top: 14px;
    border-top: 1px solid var(--color-nc-border);
    font-size: 11px;
    color: var(--color-nc-text-dim);
  }

  .github-link {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    margin-left: -10px;
    border-radius: 999px;
    color: var(--color-nc-text-dim);
    text-decoration: none;
    transition: all 0.2s;
  }

  .github-link:hover {
    color: var(--color-nc-accent);
    background: var(--color-nc-accent-glow);
  }

  .copyright {
    text-align: right;
  }

  .modal-footer {
    padding: 12px 24px;
    background: var(--color-nc-bg-header);
    border-top: 1px solid var(--color-nc-border);
    display: flex;
    justify-content: flex-end;
  }

  .btn {
    padding: 6px 20px;
    border-radius: 4px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }

  .ok-btn {
    background: var(--color-nc-bg-panel);
    border: 1px solid var(--color-nc-border-bright);
    color: var(--color-nc-text);
  }

  .ok-btn:hover {
    background: var(--color-nc-bg-hover);
    border-color: var(--color-nc-accent);
    color: var(--color-nc-text-bright);
  }
</style>
