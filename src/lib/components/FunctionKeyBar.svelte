<script lang="ts">
  import { _ } from "$lib/i18n";
  import { isOverlayActive } from "$lib/stores";

  let overlayActive = $state(false);
  isOverlayActive.subscribe(v => overlayActive = v);

  const keys = $derived([
    { key: "F2", label: $_('fkeys.f2') || "Rename", shortLabel: "Ren", fkey: "F2" },
    { key: "F3", label: $_('fkeys.f3'), shortLabel: "View", fkey: "F3" },
    { key: "F4", label: $_('fkeys.f4'), shortLabel: "Edit", fkey: "F4" },
    { key: "F5", label: $_('fkeys.f5'), shortLabel: "Copy", fkey: "F5" },
    { key: "F6", label: $_('fkeys.f6'), shortLabel: "Move", fkey: "F6" },
    { key: "F7", label: $_('fkeys.f7'), shortLabel: "MkDir", fkey: "F7" },
    { key: "F8", label: $_('fkeys.f8'), shortLabel: "Del", fkey: "F8" },
    { key: "F9", label: $_('fkeys.f9'), shortLabel: "Tsks", fkey: "F9" },
    { key: "F10", label: $_('fkeys.f10'), shortLabel: "Act", fkey: "F10" },
  ]);

  function handleClick(fkey: string) {
    if (overlayActive && fkey !== "F9") return;

    // Dispatch a synthetic keyboard event so the FileList handles it
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: fkey,
        bubbles: true,
        cancelable: true,
      })
    );
  }
</script>

<div class="fkey-bar">
  {#each keys as fk}
    <button
      class="fkey-btn"
      title={`${fk.key} ${fk.label}`}
      disabled={overlayActive && fk.fkey !== "F9"}
      onclick={() => handleClick(fk.fkey)}
    >
      <span class="fkey-num">{fk.key}</span>
      <span class="fkey-label full-label">{fk.label}</span>
      <span class="fkey-label short-label">{fk.shortLabel}</span>
    </button>
  {/each}
</div>

<style>
  .fkey-bar {
    display: flex;
    height: 26px;
    background: linear-gradient(
      180deg,
      var(--color-nc-bg-panel) 0%,
      var(--color-nc-bg-deep) 100%
    );
    border-top: 1px solid var(--color-nc-border);
    padding: 0 2px max(0px, env(safe-area-inset-bottom));
    box-sizing: content-box;
  }

  .fkey-btn {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 3px;
    background: transparent;
    border: none;
    border-right: 1px solid var(--color-nc-border);
    color: var(--color-nc-text);
    font-family: var(--font-family-sans);
    font-size: 11.5px;
    cursor: pointer;
    transition: all 0.12s ease;
    padding: 0 2px;
  }

  .fkey-btn:last-child {
    border-right: none;
  }

  .fkey-btn:hover {
    background: var(--color-nc-bg-hover);
    color: var(--color-nc-text-bright);
  }

  .fkey-btn:active {
    background: var(--color-nc-accent-dim);
    transform: scale(0.97);
  }

  .fkey-btn:disabled {
    color: var(--color-nc-text-dim);
    cursor: not-allowed;
    opacity: 0.45;
  }

  .fkey-btn:disabled:hover,
  .fkey-btn:disabled:active {
    background: transparent;
    transform: none;
  }

  .fkey-num {
    color: var(--color-nc-accent);
    font-weight: 600;
    font-size: 10px;
  }

  .fkey-label {
    font-weight: 500;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .short-label {
    display: none;
  }

  @media (max-width: 760px) {
    .fkey-btn {
      gap: 2px;
      font-size: 10.5px;
      padding: 0 1px;
    }

    .fkey-num {
      font-size: 9px;
    }

    .full-label {
      display: none;
    }

    .short-label {
      display: inline;
    }
  }

  @media (max-width: 420px) {
    .fkey-bar {
      height: 28px;
      padding: 0;
    }

    .fkey-btn {
      flex-direction: column;
      gap: 0;
      font-size: 10px;
      line-height: 1.05;
    }
  }

  @media (hover: none), (pointer: coarse) {
    .fkey-bar {
      height: auto;
      min-height: var(--nc-touch-target-min, 44px);
    }

    .fkey-btn {
      min-height: var(--nc-touch-target-min, 44px);
    }
  }
</style>
