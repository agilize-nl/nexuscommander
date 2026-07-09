<script lang="ts">
  import { playerState, currentTrackPath, togglePlay, playNext, playPrev, toggleShuffle, cycleRepeat, setVolume, stopPlayer, reportProgress } from "$lib/playerStore";
  import { convertFileSrc } from "$lib/ipc";
  import { Repeat, Repeat1, Shuffle, SkipBack, Play, Pause, SkipForward } from "lucide-svelte";

  let audioEl: HTMLAudioElement | undefined = $state(undefined);

  const currentPath = $derived(currentTrackPath($playerState));
  const trackName = $derived(currentPath ? (currentPath.split("/").pop() ?? currentPath) : "");
  const src = $derived(currentPath ? convertFileSrc(currentPath) : "");

  $effect(() => {
    if (!audioEl) return;
    if ($playerState.isPlaying) {
      void audioEl.play().catch(() => {});
    } else {
      audioEl.pause();
    }
  });

  $effect(() => {
    if (audioEl) audioEl.volume = $playerState.volume;
  });

  function handleEnded() {
    if ($playerState.repeat === "one" && audioEl) {
      audioEl.currentTime = 0;
      void audioEl.play().catch(() => {});
      return;
    }
    playNext(true);
  }

  function handleTimeUpdate() {
    if (!audioEl) return;
    reportProgress(audioEl.currentTime, audioEl.duration || 0);
  }

  function handleSeek(e: Event) {
    const value = Number((e.target as HTMLInputElement).value);
    if (audioEl) audioEl.currentTime = value;
    reportProgress(value, $playerState.duration);
  }

  function handleVolume(e: Event) {
    setVolume(Number((e.target as HTMLInputElement).value));
  }

  function formatTime(seconds: number) {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  }

  // Media Session API: lets hardware media keys, the OS notification and
  // (once installed as a PWA) the phone lock screen control playback.
  $effect(() => {
    if (!("mediaSession" in navigator)) return;
    if (!currentPath) {
      navigator.mediaSession.metadata = null;
      return;
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: trackName,
      artist: "NexusCommander",
    });
    navigator.mediaSession.playbackState = $playerState.isPlaying ? "playing" : "paused";
  });

  $effect(() => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.setActionHandler("play", () => togglePlay());
    navigator.mediaSession.setActionHandler("pause", () => togglePlay());
    navigator.mediaSession.setActionHandler("previoustrack", () => playPrev());
    navigator.mediaSession.setActionHandler("nexttrack", () => playNext(false));
    navigator.mediaSession.setActionHandler("seekto", (details) => {
      if (audioEl && details.seekTime != null) audioEl.currentTime = details.seekTime;
    });
    return () => {
      navigator.mediaSession.setActionHandler("play", null);
      navigator.mediaSession.setActionHandler("pause", null);
      navigator.mediaSession.setActionHandler("previoustrack", null);
      navigator.mediaSession.setActionHandler("nexttrack", null);
      navigator.mediaSession.setActionHandler("seekto", null);
    };
  });
</script>

{#if currentPath}
  <!-- svelte-ignore a11y_media_has_caption -->
  <audio
    bind:this={audioEl}
    {src}
    onended={handleEnded}
    ontimeupdate={handleTimeUpdate}
    onloadedmetadata={handleTimeUpdate}
  ></audio>
  <div class="mini-player">
    <div class="track-info" title={currentPath}>
      <span class="track-name">{trackName}</span>
      <span class="track-position">{$playerState.position + 1}/{$playerState.playlist.length}</span>
    </div>

    <div class="controls">
      <button class="tool-btn" class:active={$playerState.shuffle} onclick={toggleShuffle} title="Shuffle">
        <Shuffle size={16} strokeWidth={2.4} />
      </button>
      <button class="tool-btn" onclick={playPrev} title="Previous">
        <SkipBack size={16} strokeWidth={2.4} fill="currentColor" />
      </button>
      <button class="tool-btn play-btn" onclick={togglePlay} title={$playerState.isPlaying ? "Pause" : "Play"}>
        {#if $playerState.isPlaying}
          <Pause size={16} strokeWidth={2.4} fill="currentColor" />
        {:else}
          <Play size={16} strokeWidth={2.4} fill="currentColor" />
        {/if}
      </button>
      <button class="tool-btn" onclick={() => playNext(false)} title="Next">
        <SkipForward size={16} strokeWidth={2.4} fill="currentColor" />
      </button>
      <button class="tool-btn" class:active={$playerState.repeat !== "off"} onclick={cycleRepeat} title="Repeat">
        {#if $playerState.repeat === "one"}
          <Repeat1 size={16} strokeWidth={2.4} />
        {:else}
          <Repeat size={16} strokeWidth={2.4} />
        {/if}
      </button>
    </div>

    <div class="seek-row">
      <span class="time">{formatTime($playerState.currentTime)}</span>
      <input
        class="seek"
        type="range"
        min="0"
        max={$playerState.duration || 0}
        step="0.1"
        value={$playerState.currentTime}
        oninput={handleSeek}
      />
      <span class="time">{formatTime($playerState.duration)}</span>
    </div>

    <input class="volume" type="range" min="0" max="1" step="0.01" value={$playerState.volume} oninput={handleVolume} title="Volume" />

    <button class="tool-btn close-btn" onclick={stopPlayer} title="Stop">✕</button>
  </div>
{/if}

<style>
  .mini-player {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 6px 14px;
    background: var(--color-nc-bg-panel);
    border-top: 1px solid var(--color-nc-border);
    color: var(--color-nc-text);
    font-size: 12px;
  }

  .track-info {
    display: flex;
    flex-direction: column;
    min-width: 140px;
    max-width: 220px;
    overflow: hidden;
  }

  .track-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
    color: var(--color-nc-text-bright);
  }

  .track-position {
    color: var(--color-nc-text-dim);
    font-size: 10px;
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }

  .tool-btn {
    appearance: none;
    border: 1px solid var(--color-nc-border);
    background: var(--color-nc-bg);
    color: var(--color-nc-text);
    padding: 4px 8px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
    line-height: 1;
  }

  .tool-btn :global(svg) {
    display: block;
  }

  .tool-btn.active {
    color: var(--color-nc-accent);
    border-color: var(--color-nc-accent);
  }

  .play-btn {
    min-width: 32px;
  }

  .seek-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 0;
  }

  .time {
    color: var(--color-nc-text-dim);
    font-variant-numeric: tabular-nums;
    font-size: 11px;
    flex-shrink: 0;
  }

  .seek {
    flex: 1;
    min-width: 60px;
  }

  .volume {
    width: 80px;
    flex-shrink: 0;
  }

  .close-btn {
    flex-shrink: 0;
  }
</style>
