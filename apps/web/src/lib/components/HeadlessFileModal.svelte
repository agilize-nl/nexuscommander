<script lang="ts">
  import { openFile, resolveOpenAction, getSystemCapabilities, convertPreview, remuxPreview, convertFileSrc, readFileForViewer, saveTextFile, openOnThisComputer, fetchSubtitles, fetchAudioTracks, fetchMediaInfo, type ResolvedOpenAction, type PreviewConversionStatus, type SystemCapabilities, type ViewerContent, type SubtitleTrack, type AudioTrack, type MediaInfo } from "$lib/ipc";
  import FileViewer from "@nexus/ui/components/FileViewer.svelte";
  import FileEditor from "@nexus/ui/components/FileEditor.svelte";
  import { formatSize } from "$lib/utils";
  import { playPlaylist } from "$lib/playerStore";
  import { _ } from "$lib/i18n";

  interface Props {
    path: string;
    intent?: "open" | "view" | "edit";
    siblingPaths?: string[];
    onclose?: () => void;
    onsaved?: () => void;
  }

  let { path, intent = "open", siblingPaths = [], onclose, onsaved }: Props = $props();

  let currentPath = $state("");
  let currentIntent = $state<"open" | "view" | "edit">("open");
  let capabilities: SystemCapabilities | null = $state(null);
  let resolved: ResolvedOpenAction | null = $state(null);
  let loading = $state(true);
  // Stays false while we don't yet know the file kind, so opening an audio
  // file (which hands off to the persistent mini-player) never flashes this
  // modal's large frame on screen before closing again.
  let visible = $state(false);
  let error: string | null = $state(null);
  let editorValue = $state("");
  let originalValue = $state("");
  let editorReadOnly = $state(false);
  let isSaving = $state(false);
  let conversion: PreviewConversionStatus | null = $state(null);
  let shellEl: HTMLDivElement | undefined = $state(undefined);
  
  let audioTracks = $state<AudioTrack[]>([]);
  let selectedAudioTrackId = $state<string>("");
  let customVideoSrc = $state<string | null>(null);
  let subtitles = $state<SubtitleTrack[]>([]);
  let selectedSubtitleId = $state<string>("none");
  let videoEl: HTMLVideoElement | undefined = $state(undefined);
  let videoContainerEl: HTMLDivElement | undefined = $state(undefined);
  let activeCueLines = $state<string[]>([]);

  // Video playback & streaming controls state
  let totalDuration = $state<number>(0);
  let streamStartOffset = $state<number>(0);
  let rawCurrentTime = $state<number>(0);
  let isPlaying = $state<boolean>(false);
  let isMuted = $state<boolean>(false);
  let volume = $state<number>(1.0);
  let isSeeking = $state<boolean>(false);
  let isWaiting = $state<boolean>(false);
  let controlsVisible = $state<boolean>(true);
  let isScrubbing = $state<boolean>(false);
  let scrubPreviewTime = $state<number | null>(null);
  let hoverTime = $state<number | null>(null);
  let hoverPercent = $state<number>(0);
  let scrubberEl: HTMLDivElement | undefined = $state(undefined);
  let controlsTimeout: any = null;

  interface ParsedCue {
    start: number;
    end: number;
    lines: string[];
  }

  let parsedCues = $state<ParsedCue[]>([]);
  const cueCache = new Map<string, ParsedCue[]>();
  let subFileInput: HTMLInputElement | undefined = $state(undefined);

  interface SubtitleScaleOption {
    scale: number;
    label: string;
  }

  const SUBTITLE_SCALE_STORAGE_KEY = "nc-subtitle-scale";
  const SUBTITLE_SCALE_OPTIONS: SubtitleScaleOption[] = [
    { scale: 0.75, label: "media_viewer.scale_small" },
    { scale: 1, label: "media_viewer.scale_auto" },
    { scale: 1.25, label: "media_viewer.scale_large" },
    { scale: 1.5, label: "media_viewer.scale_xlarge" },
    { scale: 1.75, label: "media_viewer.scale_xxlarge" },
    { scale: 2, label: "media_viewer.scale_max" },
  ];

  function loadSavedSubtitleScale(): number {
    if (typeof window === "undefined") return 1;
    try {
      const saved = window.localStorage.getItem(SUBTITLE_SCALE_STORAGE_KEY);
      if (saved) {
        const parsed = parseFloat(saved);
        if (!isNaN(parsed) && parsed >= 0.5 && parsed <= 3) {
          return parsed;
        }
      }
    } catch {
      // storage unavailable
    }
    return 1;
  }

  let subtitleScale = $state<number>(loadSavedSubtitleScale());

  function setSubtitleScale(scale: number) {
    subtitleScale = scale;
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(SUBTITLE_SCALE_STORAGE_KEY, String(scale));
      } catch {
        // storage unavailable
      }
    }
  }

  function decreaseSubtitleScale() {
    const sorted = SUBTITLE_SCALE_OPTIONS.map((o) => o.scale).sort((a, b) => a - b);
    const prev = [...sorted].reverse().find((s) => s < subtitleScale - 0.01);
    if (prev !== undefined) {
      setSubtitleScale(prev);
    }
  }

  function increaseSubtitleScale() {
    const sorted = SUBTITLE_SCALE_OPTIONS.map((o) => o.scale).sort((a, b) => a - b);
    const next = sorted.find((s) => s > subtitleScale + 0.01);
    if (next !== undefined) {
      setSubtitleScale(next);
    }
  }

  const isStreaming = $derived.by(() => {
    return (resolved && resolved.action === "media-remux") || customVideoSrc !== null;
  });

  const currentMediaTime = $derived.by(() => {
    return isStreaming ? (streamStartOffset + rawCurrentTime) : rawCurrentTime;
  });

  const displayTime = $derived.by(() => {
    return isScrubbing && scrubPreviewTime !== null ? scrubPreviewTime : currentMediaTime;
  });

  const progressPercent = $derived.by(() => {
    const dur = totalDuration > 0 ? totalDuration : (videoEl?.duration && Number.isFinite(videoEl.duration) ? videoEl.duration : 0);
    if (dur <= 0) return 0;
    return Math.max(0, Math.min(100, (displayTime / dur) * 100));
  });

  function formatTime(seconds: number): string {
    if (!Number.isFinite(seconds) || isNaN(seconds) || seconds < 0) {
      return "0:00";
    }
    const totalSec = Math.floor(seconds);
    const hours = Math.floor(totalSec / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;

    const padSecs = String(secs).padStart(2, "0");
    if (hours > 0 || (totalDuration && totalDuration >= 3600)) {
      const padMins = String(minutes).padStart(2, "0");
      return `${hours}:${padMins}:${padSecs}`;
    }
    return `${minutes}:${padSecs}`;
  }

  function showControls() {
    controlsVisible = true;
    if (controlsTimeout) clearTimeout(controlsTimeout);
    if (isPlaying && !isScrubbing) {
      controlsTimeout = setTimeout(() => {
        if (isPlaying && !isScrubbing) {
          controlsVisible = false;
        }
      }, 2800);
    }
  }

  function handleVideoMouseMove() {
    showControls();
  }

  function handleVideoMouseLeave() {
    if (isPlaying && !isScrubbing) {
      if (controlsTimeout) clearTimeout(controlsTimeout);
      controlsTimeout = setTimeout(() => {
        if (isPlaying && !isScrubbing) {
          controlsVisible = false;
        }
      }, 1000);
    }
  }

  function togglePlayPause() {
    if (!videoEl) return;
    if (videoEl.paused) {
      void videoEl.play().catch(() => {});
      isPlaying = true;
    } else {
      videoEl.pause();
      isPlaying = false;
    }
    showControls();
  }

  function seekTo(targetSeconds: number) {
    const maxDur = totalDuration > 0 ? totalDuration : (videoEl?.duration && Number.isFinite(videoEl.duration) ? videoEl.duration : Infinity);
    const clamped = Math.max(0, Math.min(maxDur, targetSeconds));
    const wasPlaying = videoEl ? !videoEl.paused : true;

    if (isStreaming) {
      streamStartOffset = clamped;
      rawCurrentTime = 0;
      isSeeking = true;

      const audioParam = selectedAudioTrackId ? (audioTracks.find(t => t.id === selectedAudioTrackId) ? `&audioStreamIndex=${audioTracks.find(t => t.id === selectedAudioTrackId)!.streamIndex}` : "") : "";
      customVideoSrc = `/api/preview/stream?path=${encodeURIComponent(currentPath)}&start=${clamped}${audioParam}`;

      if (videoEl) {
        const el = videoEl;
        const onLoaded = () => {
          isSeeking = false;
          rawCurrentTime = 0;
          if (wasPlaying) {
            void el.play().catch(() => {});
          }
          el.removeEventListener("loadeddata", onLoaded);
          el.removeEventListener("canplay", onLoaded);
        };
        el.addEventListener("loadeddata", onLoaded, { once: true });
        el.addEventListener("canplay", onLoaded, { once: true });
      }
    } else {
      if (videoEl) {
        try {
          videoEl.currentTime = clamped;
          rawCurrentTime = clamped;
          if (wasPlaying && videoEl.paused) {
            void videoEl.play().catch(() => {});
          }
        } catch {
          // seek error
        }
      }
    }
    showControls();
    updateActiveCues();
  }

  function skip(deltaSeconds: number) {
    seekTo(currentMediaTime + deltaSeconds);
  }

  function toggleMute() {
    if (!videoEl) return;
    isMuted = !isMuted;
    videoEl.muted = isMuted;
    showControls();
  }

  function handleVolumeChange(e: Event) {
    const target = e.target as HTMLInputElement;
    const val = parseFloat(target.value);
    volume = val;
    isMuted = val === 0;
    if (videoEl) {
      videoEl.volume = val;
      videoEl.muted = isMuted;
    }
    showControls();
  }

  function setVolumeLevel(newVol: number) {
    volume = Math.max(0, Math.min(1, newVol));
    isMuted = volume === 0;
    if (videoEl) {
      videoEl.volume = volume;
      videoEl.muted = isMuted;
    }
    showControls();
  }

  function getScrubberTimeFromEvent(e: PointerEvent): { time: number; percent: number } {
    if (!scrubberEl) return { time: 0, percent: 0 };
    const rect = scrubberEl.getBoundingClientRect();
    const clientX = e.clientX;
    const offsetX = Math.max(0, Math.min(rect.width, clientX - rect.left));
    const percent = rect.width > 0 ? (offsetX / rect.width) * 100 : 0;
    const dur = totalDuration > 0 ? totalDuration : (videoEl?.duration && Number.isFinite(videoEl.duration) ? videoEl.duration : 0);
    const time = (percent / 100) * dur;
    return { time, percent };
  }

  function handleScrubberPointerDown(e: PointerEvent) {
    e.preventDefault();
    (e.currentTarget as HTMLElement)?.setPointerCapture?.(e.pointerId);
    isScrubbing = true;
    showControls();
    const { time, percent } = getScrubberTimeFromEvent(e);
    scrubPreviewTime = time;
    hoverTime = time;
    hoverPercent = percent;
  }

  function handleScrubberPointerMove(e: PointerEvent) {
    const { time, percent } = getScrubberTimeFromEvent(e);
    hoverTime = time;
    hoverPercent = percent;
    if (isScrubbing) {
      scrubPreviewTime = time;
      showControls();
    }
  }

  function handleScrubberPointerUp(e: PointerEvent) {
    if (isScrubbing) {
      const { time } = getScrubberTimeFromEvent(e);
      isScrubbing = false;
      scrubPreviewTime = null;
      seekTo(time);
      try {
        (e.currentTarget as HTMLElement)?.releasePointerCapture?.(e.pointerId);
      } catch {}
    }
  }

  function handleScrubberPointerLeave() {
    if (!isScrubbing) {
      hoverTime = null;
    }
  }

  const rawUrl = $derived(convertFileSrc(currentPath));
  // Separate from rawUrl: rawUrl stays inline-preview (no Content-Disposition,
  // used for media/iframe src); this appends ?download=1 (§3.1) so the
  // browser downloads instead of navigating/rendering.
  const downloadUrl = $derived(`${rawUrl}&download=1`);
  const activeVideoSrc = $derived.by(() => {
    if (customVideoSrc) return customVideoSrc;
    if (resolved && resolved.action === "media-remux") {
      const audioParam = selectedAudioTrackId ? (audioTracks.find(t => t.id === selectedAudioTrackId) ? `&audioStreamIndex=${audioTracks.find(t => t.id === selectedAudioTrackId)!.streamIndex}` : "") : "";
      const startParam = streamStartOffset > 0 ? `&start=${streamStartOffset}` : "";
      return (conversion && conversion.previewUrl) ? conversion.previewUrl : `/api/preview/stream?path=${encodeURIComponent(currentPath)}${startParam}${audioParam}`;
    }
    return rawUrl;
  });
  const isDirty = $derived(editorValue !== originalValue);
  const siblingIndex = $derived(siblingPaths.indexOf(currentPath));
  const canGoPrev = $derived(siblingPaths.indexOf(currentPath) > 0);
  const canGoNext = $derived(siblingPaths.indexOf(currentPath) >= 0 && siblingPaths.indexOf(currentPath) < siblingPaths.length - 1);

  async function loadCurrent() {
    loading = true;
    error = null;
    conversion = null;
    resolved = null;
    editorReadOnly = false;
    try {
      capabilities = await getSystemCapabilities();
      const nextResolved = await resolveOpenAction(currentPath, currentIntent);
      resolved = nextResolved;

      if (nextResolved.action === "desktop-app") {
        await openFile(currentPath);
        onclose?.();
        return;
      }

      if (nextResolved.action === "media-player" && nextResolved.media_kind === "audio") {
        // Audio hands off to the persistent mini-player so playback survives
        // closing this modal and browsing to other folders.
        playPlaylist(siblingPaths.length > 0 ? siblingPaths : [currentPath], currentPath);
        onclose?.();
        return;
      }

      visible = true;

      if ((nextResolved.action === "media-player" && nextResolved.media_kind === "video") || nextResolved.action === "media-remux") {
        subtitles = [];
        selectedSubtitleId = "none";
        audioTracks = [];
        selectedAudioTrackId = "";
        customVideoSrc = null;
        totalDuration = 0;
        streamStartOffset = 0;
        rawCurrentTime = 0;
        isPlaying = false;
        isSeeking = false;
        isWaiting = false;
        controlsVisible = true;
        try {
          const mediaInfo = await fetchMediaInfo(currentPath);
          if (mediaInfo.duration && mediaInfo.duration > 0) {
            totalDuration = mediaInfo.duration;
          }
          subtitles = mediaInfo.subtitles || [];
          const defaultSub = subtitles.find((s) => s.isDefault) || (subtitles.length > 0 ? subtitles[0] : null);
          if (defaultSub) {
            selectedSubtitleId = defaultSub.id;
            void loadCuesForTrack(defaultSub);
          }
          audioTracks = mediaInfo.audioTracks || [];
          const defaultTrack = audioTracks.find((t) => t.isDefault) || (audioTracks.length > 0 ? audioTracks[0] : null);
          if (defaultTrack) {
            selectedAudioTrackId = defaultTrack.id;
          }
        } catch (err) {
          console.error("Failed to load subtitles or media info:", err);
        }
      }

      if (nextResolved.action === "editor") {
        const content = await readFileForViewer(currentPath);
        if (content.mode !== "Text" || content.text === null) {
          throw new Error($_("editor.not_text_file"));
        }
        originalValue = content.text;
        editorValue = content.text;
      } else if (nextResolved.action === "converted-preview") {
        conversion = await convertPreview(currentPath);
      } else if (nextResolved.action === "media-remux") {
        conversion = {
          status: "ready",
          format: "mp4",
          previewUrl: `/api/preview/stream?path=${encodeURIComponent(currentPath)}`,
          outputPath: currentPath,
          message: $_("media_viewer.streaming")
        };
      }
    } catch (e: any) {
      visible = true;
      error = typeof e === "string" ? e : e.message || $_("media_viewer.open_failed");
      if (resolved?.action === "editor") {
        editorReadOnly = true;
      }
    } finally {
      loading = false;
    }
  }

  async function saveCurrentFile() {
    if (isSaving || editorReadOnly) return;
    isSaving = true;
    error = null;
    try {
      await saveTextFile(currentPath, editorValue);
      originalValue = editorValue;
      onsaved?.();
    } catch (e: any) {
      error = typeof e === "string" ? e : e.message || $_("editor.save_failed");
    } finally {
      isSaving = false;
    }
  }

  async function saveAs() {
    const targetPath = window.prompt($_("media_viewer.save_as"), currentPath);
    if (!targetPath) return;
    isSaving = true;
    error = null;
    try {
      await saveTextFile(targetPath, editorValue);
      currentPath = targetPath;
      originalValue = editorValue;
      onsaved?.();
    } catch (e: any) {
      error = typeof e === "string" ? e : e.message || $_("editor.save_failed");
    } finally {
      isSaving = false;
    }
  }

  function copyPath() {
    void navigator.clipboard?.writeText(currentPath);
  }

  function openRaw() {
    window.open(rawUrl, "_blank", "noopener,noreferrer");
  }

  function copyStreamUrl() {
    void navigator.clipboard?.writeText(new URL(rawUrl, window.location.origin).toString());
  }

  function gotoSibling(offset: -1 | 1) {
    const currentIndex = siblingPaths.indexOf(currentPath);
    if (currentIndex < 0) return;
    const nextPath = siblingPaths[currentIndex + offset];
    if (!nextPath) return;
    currentPath = nextPath;
  }

  function parseVttTime(timeStr: string): number {
    const parts = timeStr.trim().split(":");
    if (parts.length === 3) {
      const hours = parseFloat(parts[0]);
      const minutes = parseFloat(parts[1]);
      const seconds = parseFloat(parts[2].replace(",", "."));
      return hours * 3600 + minutes * 60 + seconds;
    } else if (parts.length === 2) {
      const minutes = parseFloat(parts[0]);
      const seconds = parseFloat(parts[1].replace(",", "."));
      return minutes * 60 + seconds;
    }
    return 0;
  }

  function parseVttTextToCues(vttText: string): ParsedCue[] {
    const cues: ParsedCue[] = [];
    const clean = vttText.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const blocks = clean.split(/\n\n+/);

    for (const block of blocks) {
      const lines = block.trim().split("\n");
      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(/(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{3})?)\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{3})?)/);
        if (match) {
          const start = parseVttTime(match[1]);
          const end = parseVttTime(match[2]);
          const textLines = lines.slice(i + 1)
            .map((l) => l.replace(/<[^>]+>/g, "").trim())
            .filter(Boolean);
          if (textLines.length > 0) {
            cues.push({ start, end, lines: textLines });
          }
          break;
        }
      }
    }
    return cues;
  }

  async function loadCuesForTrack(sub: SubtitleTrack) {
    if (cueCache.has(sub.id)) {
      parsedCues = cueCache.get(sub.id)!;
      updateActiveCues();
      return;
    }
    try {
      const res = await fetch(sub.src);
      if (res.ok) {
        const text = await res.text();
        const cues = parseVttTextToCues(text);
        cueCache.set(sub.id, cues);
        if (selectedSubtitleId === sub.id) {
          parsedCues = cues;
          updateActiveCues();
        }
      }
    } catch (err) {
      console.error("Failed to load subtitle cues for overlay:", err);
    }
  }

  function updateActiveCues() {
    if (!videoEl || selectedSubtitleId === "none") {
      if (activeCueLines.length > 0) activeCueLines = [];
      return;
    }
    const currentTime = currentMediaTime;

    if (parsedCues.length > 0) {
      const match = parsedCues.find((c) => c.start <= currentTime && currentTime <= c.end);
      const newLines = match ? match.lines : [];
      if (newLines.join("\n") !== activeCueLines.join("\n")) {
        activeCueLines = newLines;
      }
      return;
    }

    let lines: string[] = [];
    for (let i = 0; i < videoEl.textTracks.length; i++) {
      const track = videoEl.textTracks[i];
      const sub = subtitles[i];
      if (sub && sub.id === selectedSubtitleId) {
        if (track.activeCues && track.activeCues.length > 0) {
          for (let j = 0; j < track.activeCues.length; j++) {
            const cue = track.activeCues[j] as VTTCue;
            if (cue && cue.text) {
              const splitLines = cue.text
                .split(/\r?\n/)
                .map((l) => l.replace(/<[^>]+>/g, "").trim())
                .filter(Boolean);
              lines.push(...splitLines);
            }
          }
        } else if (track.cues && track.cues.length > 0) {
          for (let j = 0; j < track.cues.length; j++) {
            const cue = track.cues[j] as VTTCue;
            if (cue && cue.startTime <= currentTime && cue.endTime >= currentTime) {
              if (cue.text) {
                const splitLines = cue.text
                  .split(/\r?\n/)
                  .map((l) => l.replace(/<[^>]+>/g, "").trim())
                  .filter(Boolean);
                lines.push(...splitLines);
              }
            }
          }
        }
        break;
      }
    }

    if (lines.join("\n") !== activeCueLines.join("\n")) {
      activeCueLines = lines;
    }
  }

  function setAudioTrack(id: string) {
    if (id === selectedAudioTrackId) return;
    const track = audioTracks.find((t) => t.id === id);
    if (!track) return;

    selectedAudioTrackId = id;
    const currentMediaPos = currentMediaTime;
    const wasPlaying = videoEl ? !videoEl.paused : false;

    if (track.audioIndex === 0 && resolved?.action === "media-player") {
      customVideoSrc = null;
      streamStartOffset = 0;
      rawCurrentTime = currentMediaPos;
    } else {
      streamStartOffset = currentMediaPos;
      rawCurrentTime = 0;
      const startParam = streamStartOffset > 0 ? `&start=${streamStartOffset}` : "";
      customVideoSrc = `/api/preview/stream?path=${encodeURIComponent(currentPath)}${startParam}&audioStreamIndex=${track.streamIndex}`;
    }

    if (videoEl) {
      const el = videoEl;
      const onLoaded = () => {
        if (!isStreaming && currentMediaPos > 0) {
          try {
            el.currentTime = currentMediaPos;
          } catch {
            // ignore seek error
          }
        }
        if (wasPlaying) {
          void el.play().catch(() => {});
        }
        el.removeEventListener("loadeddata", onLoaded);
      };
      el.addEventListener("loadeddata", onLoaded, { once: true });
    }
  }

  function setSubtitle(id: string) {
    selectedSubtitleId = id;
    if (id === "none") {
      parsedCues = [];
      activeCueLines = [];
    } else {
      const sub = subtitles.find((s) => s.id === id);
      if (sub) {
        void loadCuesForTrack(sub);
      }
    }

    if (!videoEl) return;
    for (let i = 0; i < videoEl.textTracks.length; i++) {
      const track = videoEl.textTracks[i];
      const sub = subtitles[i];
      if (sub && sub.id === id) {
        track.mode = document.fullscreenElement === videoEl ? "showing" : "hidden";
        track.oncuechange = () => updateActiveCues();
      } else {
        track.mode = "disabled";
      }
    }
    updateActiveCues();
  }

  function setupVideoElement(el: HTMLVideoElement | undefined) {
    videoEl = el;
    if (!el) return;

    el.requestFullscreen = function(options?: FullscreenOptions) {
      if (videoContainerEl) {
        return videoContainerEl.requestFullscreen(options);
      }
      return HTMLVideoElement.prototype.requestFullscreen.call(el, options);
    };
    (el as any).webkitRequestFullscreen = function() {
      if (videoContainerEl) {
        return (videoContainerEl as any).webkitRequestFullscreen?.() || videoContainerEl.requestFullscreen();
      }
      return (HTMLVideoElement.prototype as any).webkitRequestFullscreen?.call(el);
    };

    if (selectedSubtitleId !== "none") {
      setSubtitle(selectedSubtitleId);
    }
  }

  function handleFullscreenChange() {
    const isVideoFs = document.fullscreenElement === videoContainerEl || document.fullscreenElement === videoEl;
    if (videoEl && selectedSubtitleId !== "none") {
      for (let i = 0; i < videoEl.textTracks.length; i++) {
        const track = videoEl.textTracks[i];
        const sub = subtitles[i];
        if (sub && sub.id === selectedSubtitleId) {
          track.mode = isVideoFs ? "showing" : "hidden";
        }
      }
    }
    updateActiveCues();
  }

  function toggleFullscreen() {
    if (!videoContainerEl) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void videoContainerEl.requestFullscreen();
    }
  }

  function srtToVttClient(srtText: string): string {
    if (!srtText) return "WEBVTT\n\n";
    let text = srtText.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
    text = text.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, (_m, t1, ms1, t2, ms2) => {
      const p1 = t1.split(":");
      const hh1 = p1[0].padStart(2, "0");
      const p2 = t2.split(":");
      const hh2 = p2[0].padStart(2, "0");
      return `${hh1}:${p1[1]}:${p1[2]}.${ms1} --> ${hh2}:${p2[1]}:${p2[2]}.${ms2}`;
    });
    text = text.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, (_m, time, ms) => {
      const parts = time.split(":");
      const hh = parts[0].padStart(2, "0");
      return `${hh}:${parts[1]}:${parts[2]}.${ms}`;
    });
    return `WEBVTT\n\n${text}\n`;
  }

  function handleLoadLocalSubtitle(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const raw = (event.target?.result as string) || "";
      const vtt = file.name.toLowerCase().endsWith(".vtt") ? (raw.startsWith("WEBVTT") ? raw : `WEBVTT\n\n${raw}`) : srtToVttClient(raw);
      const blobUrl = URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
      const newTrack: SubtitleTrack = {
        id: `local-${Date.now()}`,
        label: `${file.name} [Local]`,
        language: "und",
        src: blobUrl,
        customBlob: true
      };
      const cues = parseVttTextToCues(vtt);
      cueCache.set(newTrack.id, cues);
      subtitles = [...subtitles, newTrack];
      setTimeout(() => setSubtitle(newTrack.id), 50);
    };
    reader.readAsText(file);
    input.value = "";
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!visible) return;
    if ((resolved?.action === "media-player" && resolved?.media_kind === "video") || resolved?.action === "media-remux") {
      if (e.key === " " && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        togglePlayPause();
        return;
      }
      if (e.key === "ArrowLeft" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        skip(-10);
        return;
      }
      if (e.key === "ArrowRight" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        skip(10);
        return;
      }
      if (e.key === "ArrowUp" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setVolumeLevel(volume + 0.1);
        return;
      }
      if (e.key === "ArrowDown" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setVolumeLevel(volume - 0.1);
        return;
      }
      if ((e.key === "m" || e.key === "M") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        toggleMute();
        return;
      }
      if ((e.key === "a" || e.key === "A") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        if (audioTracks.length > 1) {
          const currentIdx = audioTracks.findIndex((t) => t.id === selectedAudioTrackId);
          const nextIdx = (currentIdx + 1) % audioTracks.length;
          setAudioTrack(audioTracks[nextIdx].id);
        }
        return;
      }
      if ((e.key === "c" || e.key === "C") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        if (subtitles.length > 0) {
          const currentIdx = subtitles.findIndex((s) => s.id === selectedSubtitleId);
          if (selectedSubtitleId === "none" || currentIdx === -1) {
            setSubtitle(subtitles[0].id);
          } else if (currentIdx < subtitles.length - 1) {
            setSubtitle(subtitles[currentIdx + 1].id);
          } else {
            setSubtitle("none");
          }
        }
        return;
      }
      if (!e.ctrlKey && !e.metaKey) {
        if (e.key === "[" || (e.altKey && (e.key === "-" || e.key === "_"))) {
          e.preventDefault();
          decreaseSubtitleScale();
          return;
        }
        if (e.key === "]" || (e.altKey && (e.key === "+" || e.key === "="))) {
          e.preventDefault();
          increaseSubtitleScale();
          return;
        }
        if ((e.key === "f" || e.key === "F") && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          toggleFullscreen();
          return;
        }
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onclose?.();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && resolved?.action === "editor") {
      e.preventDefault();
      void saveCurrentFile();
    }
    if (e.key === "ArrowLeft" && (e.altKey || resolved?.action === "image-viewer") && canGoPrev) {
      e.preventDefault();
      gotoSibling(-1);
    }
    if (e.key === "ArrowRight" && (e.altKey || resolved?.action === "image-viewer") && canGoNext) {
      e.preventDefault();
      gotoSibling(1);
    }
  }

  $effect(() => {
    currentPath = path;
    currentIntent = intent;
  });

  $effect(() => {
    currentPath;
    currentIntent;
    void loadCurrent();
  });

  $effect(() => {
    if (visible && shellEl) {
      shellEl.focus();
    }
  });
</script>

<svelte:window onkeydown={handleKeydown} onfullscreenchange={handleFullscreenChange} />

{#if visible}
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="modal-overlay" onclick={() => onclose?.()} role="presentation">
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-shell" bind:this={shellEl} tabindex="-1" onclick={(e) => e.stopPropagation()}>
    <div class="modal-header">
      <div class="modal-header-top">
        <div class="modal-heading">
          <div class="modal-title">{resolved?.file_name ?? currentPath.split("/").pop() ?? currentPath}</div>
          <div class="modal-meta">
            {resolved ? `${resolved.action} • ${formatSize(resolved.file_size)}` : currentPath}
          </div>
        </div>
        <div class="modal-actions">
          {#if resolved?.action === "editor"}
            <button class="tool-btn" onclick={() => void saveCurrentFile()} disabled={isSaving || !isDirty || editorReadOnly}>{$_("editor.save")}</button>
            <button class="tool-btn" onclick={saveAs} disabled={isSaving}>{$_("media_viewer.save_as")}</button>
          {/if}
          {#if (resolved?.action === "media-player" && resolved?.media_kind === "video") || resolved?.action === "media-remux"}
            <button class="tool-btn" onclick={toggleFullscreen} title={$_("media_viewer.fullscreen_hint")}>{$_("media_viewer.fullscreen")}</button>
          {/if}
          {#if resolved?.media_kind === "video"}
            <button class="tool-btn" onclick={copyStreamUrl} title={$_("media_viewer.copy_stream_url_hint")}>{$_("media_viewer.copy_stream_url")}</button>
          {/if}
          <button class="tool-btn" onclick={() => openOnThisComputer(currentPath)} title={$_("media_viewer.on_this_computer_hint")}>{$_("common.open_on_computer")}</button>
          <button class="tool-btn" onclick={copyPath}>{$_("media_viewer.copy_path")}</button>
          <a class="tool-btn link-btn" href={downloadUrl} download={resolved?.file_name ?? true}>{$_('common.download')}</a>
          <button class="close-btn" onclick={() => onclose?.()} aria-label={$_("common.close")} title={$_("common.close")}>X</button>
        </div>
      </div>

      {#if (resolved?.action === "media-player" && resolved?.media_kind === "video") || resolved?.action === "media-remux"}
        <div class="modal-media-toolbar">
          {#if audioTracks.length > 0}
            <div class="audio-dropdown-wrap">
              <span class="audio-icon-label" title={$_("media_viewer.audio_track_hint")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
                </svg>
                {$_("media_viewer.audio")}
              </span>
              <select
                class="tool-select audio-select"
                value={selectedAudioTrackId}
                onchange={(e) => setAudioTrack(e.currentTarget.value)}
                disabled={audioTracks.length <= 1}
                title={$_("media_viewer.audio_track")}
              >
                {#each audioTracks as track (track.id)}
                  <option value={track.id}>{track.label}</option>
                {/each}
              </select>
            </div>
          {/if}
          <div class="subtitle-dropdown-wrap">
            <span class="sub-icon-label" title={$_("media_viewer.subtitles_hint")}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="2" y="4" width="20" height="16" rx="2" />
                <path d="M7 15h4M15 15h2M7 11h2M13 11h4" />
              </svg>
              CC
            </span>
            <select class="tool-select" value={selectedSubtitleId} onchange={(e) => setSubtitle(e.currentTarget.value)} title={$_("media_viewer.subtitle_track")}>
              <option value="none">{$_("media_viewer.subtitles_off")}</option>
              {#each subtitles as sub (sub.id)}
                <option value={sub.id}>{sub.label}</option>
              {/each}
            </select>
            <div class="subtitle-size-controls" title={$_("media_viewer.subtitle_size_hint")}>
              <button
                type="button"
                class="sub-size-btn"
                onclick={decreaseSubtitleScale}
                disabled={subtitleScale <= SUBTITLE_SCALE_OPTIONS[0].scale}
                title={$_("media_viewer.subtitle_smaller_hint")}
                aria-label={$_("media_viewer.subtitle_smaller")}
              >
                A-
              </button>
              <select
                class="tool-select sub-size-select"
                value={subtitleScale}
                onchange={(e) => setSubtitleScale(parseFloat(e.currentTarget.value))}
                title={$_("media_viewer.subtitle_size")}
              >
                {#each SUBTITLE_SCALE_OPTIONS as opt}
                  <option value={opt.scale}>{$_(opt.label)}</option>
                {/each}
              </select>
              <button
                type="button"
                class="sub-size-btn"
                onclick={increaseSubtitleScale}
                disabled={subtitleScale >= SUBTITLE_SCALE_OPTIONS[SUBTITLE_SCALE_OPTIONS.length - 1].scale}
                title={$_("media_viewer.subtitle_larger_hint")}
                aria-label={$_("media_viewer.subtitle_larger")}
              >
                A+
              </button>
            </div>
            <button class="tool-btn" onclick={() => subFileInput?.click()} title={$_("media_viewer.load_subtitle_hint")}>{$_("media_viewer.load_subtitle")}</button>
            <input type="file" accept=".srt,.vtt,.sub,.ass,.ssa" style="display:none" bind:this={subFileInput} onchange={handleLoadLocalSubtitle} />
          </div>
        </div>
      {/if}
    </div>

    <div class="modal-body">
      {#if loading}
        <div class="empty-state">{$_("media_viewer.loading_file")}</div>
      {:else if error}
        <div class="empty-state error-state">
          <p>{error}</p>
          <div class="fallback-actions">
            <button class="tool-btn" onclick={openRaw}>{$_("media_viewer.open_raw")}</button>
            {#if resolved?.media_kind === "video"}
              <button class="tool-btn" onclick={copyStreamUrl}>{$_("media_viewer.copy_stream_url")}</button>
            {/if}
            <a class="tool-btn link-btn" href={downloadUrl} download={resolved?.file_name ?? true}>{$_('common.download')}</a>
          </div>
        </div>
      {:else if resolved?.action === "editor"}
        <div class="editor-body">
          <FileEditor path={currentPath} value={editorValue} readOnly={editorReadOnly} onChange={(value) => editorValue = value} />
        </div>
      {:else if resolved?.action === "text-viewer"}
        <FileViewer path={currentPath} embedded={true} />
      {:else if resolved?.action === "image-viewer"}
        <div class="image-shell">
          <FileViewer path={currentPath} embedded={true} />
          {#if siblingPaths.length > 1}
            <div class="image-browser">
              <button class="nav-btn" onclick={() => gotoSibling(-1)} title={$_("media_viewer.prev_image")} disabled={!canGoPrev}>{$_("media_viewer.prev")}</button>
              <span class="browser-status">{siblingIndex + 1}/{siblingPaths.length}</span>
              <button class="nav-btn" onclick={() => gotoSibling(1)} title={$_("media_viewer.next_image")} disabled={!canGoNext}>{$_("media_viewer.next")}</button>
            </div>
          {/if}
        </div>
      {:else if resolved?.action === "pdf-viewer"}
        <iframe class="preview-frame" src={rawUrl} title={resolved.file_name}></iframe>
      {:else if (resolved?.action === "media-player" && resolved?.media_kind === "video") || resolved?.action === "media-remux"}
        <!-- Video player for direct playback and on-the-fly streaming/remuxing -->
        <div class="media-shell">
          {#if canGoPrev}
            <button class="nav-btn" onclick={() => gotoSibling(-1)} title={$_("media_viewer.prev_file")}>{$_("media_viewer.prev")}</button>
          {/if}
          <div
            class="video-container"
            class:hide-cursor={!controlsVisible && isPlaying}
            class:controls-hidden={!controlsVisible}
            bind:this={videoContainerEl}
            ondblclick={toggleFullscreen}
            onmousemove={handleVideoMouseMove}
            onmouseleave={handleVideoMouseLeave}
            role="region"
            aria-label={$_("media_viewer.video_player")}
          >
            <!-- svelte-ignore a11y_media_has_caption -->
            <video
              bind:this={videoEl}
              class="media-player"
              autoplay
              crossorigin="anonymous"
              src={activeVideoSrc}
              ontimeupdate={() => {
                if (videoEl) rawCurrentTime = videoEl.currentTime;
                updateActiveCues();
              }}
              onseeking={() => {
                if (videoEl) rawCurrentTime = videoEl.currentTime;
                updateActiveCues();
              }}
              onseeked={() => {
                if (videoEl) rawCurrentTime = videoEl.currentTime;
                updateActiveCues();
              }}
              onplay={() => {
                isPlaying = true;
                showControls();
                updateActiveCues();
              }}
              onpause={() => {
                isPlaying = false;
                showControls();
                updateActiveCues();
              }}
              onwaiting={() => {
                isWaiting = true;
              }}
              onplaying={() => {
                isWaiting = false;
                isSeeking = false;
              }}
              oncanplay={() => {
                isWaiting = false;
                isSeeking = false;
              }}
              onloadedmetadata={() => {
                setupVideoElement(videoEl);
                if (!totalDuration && videoEl && Number.isFinite(videoEl.duration) && videoEl.duration > 0) {
                  totalDuration = videoEl.duration;
                }
              }}
              onclick={togglePlayPause}
            >
              {#each subtitles as sub (sub.id)}
                <track
                  kind="subtitles"
                  label={sub.label}
                  srclang={sub.language}
                  src={sub.src}
                  default={selectedSubtitleId === sub.id}
                  onload={() => { if (selectedSubtitleId === sub.id) setSubtitle(sub.id); }}
                />
              {/each}
            </video>

            {#if activeCueLines.length > 0 && selectedSubtitleId !== "none"}
              <div class="subtitle-overlay" style="--subtitle-scale: {subtitleScale};">
                <div class="subtitle-box">
                  {#each activeCueLines as line}
                    <div class="subtitle-line-wrapper">
                      <span class="subtitle-line">{line}</span>
                    </div>
                  {/each}
                </div>
              </div>
            {/if}

            {#if isSeeking || isWaiting}
              <div class="video-buffering-overlay">
                <div class="buffering-spinner"></div>
              </div>
            {/if}

            <!-- Custom Video Controls Overlay -->
            <div class="custom-video-controls" class:hidden={!controlsVisible}>
              <!-- Scrubber / Timeline -->
              <div
                class="media-scrubber-wrap"
                class:scrubbing={isScrubbing}
                bind:this={scrubberEl}
                onpointerdown={handleScrubberPointerDown}
                onpointermove={handleScrubberPointerMove}
                onpointerup={handleScrubberPointerUp}
                onpointerleave={handleScrubberPointerLeave}
                role="slider"
                tabindex="0"
                aria-valuemin="0"
                aria-valuemax={totalDuration || 100}
                aria-valuenow={currentMediaTime}
                aria-label={$_("media_viewer.timeline")}
              >
                <div class="media-scrubber-track">
                  <div class="media-scrubber-fill" style="width: {progressPercent}%;"></div>
                  <div class="media-scrubber-handle" style="left: {progressPercent}%;"></div>
                </div>
                {#if hoverTime !== null}
                  <div class="media-scrubber-tooltip" style="left: {hoverPercent}%;">
                    {formatTime(hoverTime)}
                  </div>
                {/if}
              </div>

              <!-- Controls Row -->
              <div class="media-controls-row">
                <div class="media-controls-left">
                  <!-- Play / Pause -->
                  <button
                    type="button"
                    class="player-btn play-btn"
                    onclick={togglePlayPause}
                    title={isPlaying ? $_("media_viewer.pause_hint") : $_("media_viewer.play_hint")}
                    aria-label={isPlaying ? $_("media_viewer.pause") : $_("media_viewer.play")}
                  >
                    {#if isPlaying}
                      <svg class="player-icon" viewBox="0 0 24 24" fill="currentColor">
                        <rect x="6" y="4" width="4" height="16" rx="1"></rect>
                        <rect x="14" y="4" width="4" height="16" rx="1"></rect>
                      </svg>
                    {:else}
                      <svg class="player-icon" viewBox="0 0 24 24" fill="currentColor">
                        <polygon points="5 3 19 12 5 21 5 3"></polygon>
                      </svg>
                    {/if}
                  </button>

                  <!-- Skip Backward 10s -->
                  <button
                    type="button"
                    class="player-btn skip-btn"
                    onclick={() => skip(-10)}
                    title={$_("media_viewer.rewind_hint")}
                    aria-label={$_("media_viewer.rewind")}
                  >
                    <svg class="player-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M11 17l-5-5 5-5M18 17l-5-5 5-5" />
                    </svg>
                    <span class="skip-label">-10s</span>
                  </button>

                  <!-- Skip Forward 10s -->
                  <button
                    type="button"
                    class="player-btn skip-btn"
                    onclick={() => skip(10)}
                    title={$_("media_viewer.forward_hint")}
                    aria-label={$_("media_viewer.forward")}
                  >
                    <span class="skip-label">+10s</span>
                    <svg class="player-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M13 17l5-5-5-5M6 17l5-5-5-5" />
                    </svg>
                  </button>

                  <!-- Time Display -->
                  <div class="media-time-display">
                    <span class="current-time">{formatTime(displayTime)}</span>
                    <span class="time-sep">/</span>
                    <span class="total-duration">{formatTime(totalDuration)}</span>
                  </div>
                </div>

                <div class="media-controls-right">
                  <!-- Volume Control -->
                  <div class="volume-control-wrap">
                    <button
                      type="button"
                      class="player-btn volume-btn"
                      onclick={toggleMute}
                      title={isMuted ? $_("media_viewer.unmute_hint") : $_("media_viewer.mute_hint")}
                      aria-label={isMuted ? $_("media_viewer.unmute") : $_("media_viewer.mute")}
                    >
                      {#if isMuted || volume === 0}
                        <svg class="player-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                          <line x1="23" y1="9" x2="17" y2="15"></line>
                          <line x1="17" y1="9" x2="23" y2="15"></line>
                        </svg>
                      {:else if volume < 0.5}
                        <svg class="player-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                          <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                        </svg>
                      {:else}
                        <svg class="player-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                          <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                        </svg>
                      {/if}
                    </button>
                    <input
                      type="range"
                      class="volume-slider"
                      min="0"
                      max="1"
                      step="0.05"
                      value={isMuted ? 0 : volume}
                      oninput={handleVolumeChange}
                      aria-label={$_("media_viewer.volume")}
                    />
                  </div>

                  <!-- Fullscreen Button -->
                  <button
                    type="button"
                    class="player-btn fullscreen-btn"
                    onclick={toggleFullscreen}
                    title={$_("media_viewer.fullscreen_hint")}
                    aria-label={$_("media_viewer.fullscreen")}
                  >
                    <svg class="player-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path>
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </div>
          {#if canGoNext}
            <button class="nav-btn" onclick={() => gotoSibling(1)} title={$_("media_viewer.next_file")}>{$_("media_viewer.next")}</button>
          {/if}
        </div>
      {:else if resolved?.action === "converted-preview"}
        {#if conversion}
          <div class="converted-preview">
            <div class="conversion-label">{conversion.message}</div>
            <iframe class="preview-frame" src={conversion.previewUrl} title={resolved.file_name}></iframe>
          </div>
        {:else}
          <div class="empty-state">{$_("media_viewer.generating_preview")}</div>
        {/if}
      {:else}
        <div class="empty-state">
          <p>{resolved?.reason ?? $_("media_viewer.cannot_preview")}</p>
          <div class="fallback-actions">
            <button class="tool-btn" onclick={openRaw}>{$_("media_viewer.open_raw")}</button>
            {#if resolved?.media_kind === "video"}
              <button class="tool-btn" onclick={copyStreamUrl}>{$_("media_viewer.copy_stream_url")}</button>
            {/if}
            <a class="tool-btn link-btn" href={downloadUrl} download={resolved?.file_name ?? true}>{$_('common.download')}</a>
          </div>
        </div>
      {/if}
    </div>

    <div class="modal-footer">
      <span>{capabilities?.headless ? $_("media_viewer.runtime_headless") : $_("media_viewer.runtime_desktop")}</span>
      {#if resolved?.action === "editor"}
        <span>{isDirty ? $_("media_viewer.unsaved") : $_("editor.saved")}</span>
      {:else if resolved?.mime_type}
        <span>{resolved.mime_type}</span>
      {/if}
    </div>
  </div>
</div>
{/if}

<style>
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.65);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 24px;
    box-sizing: border-box;
  }

  .modal-shell {
    width: min(1200px, 100%);
    height: min(860px, 100%);
    background: var(--color-nc-bg);
    border: 1px solid var(--color-nc-border);
    border-radius: 6px;
    box-shadow: 0 20px 48px rgba(0, 0, 0, 0.45);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    outline: none;
  }

  .modal-header {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 16px;
    background: var(--color-nc-bg-panel);
    border-bottom: 1px solid var(--color-nc-border);
  }

  .modal-header-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-width: 0;
  }

  .modal-media-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding-top: 6px;
    border-top: 1px solid var(--color-nc-border);
  }

  .modal-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 16px;
    background: var(--color-nc-bg-panel);
    border-top: 1px solid var(--color-nc-border);
    border-bottom: none;
    color: var(--color-nc-text-dim);
    font-size: 11px;
  }

  .modal-heading {
    min-width: 0;
  }

  .modal-title {
    font-weight: 700;
    color: var(--color-nc-text-bright);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .modal-meta {
    font-size: 11px;
    color: var(--color-nc-text-dim);
  }

  .modal-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .tool-btn,
  .close-btn,
  .link-btn {
    appearance: none;
    border: 1px solid var(--color-nc-border);
    background: var(--color-nc-bg);
    color: var(--color-nc-text);
    padding: 6px 10px;
    border-radius: 4px;
    cursor: pointer;
    text-decoration: none;
    font-size: 12px;
  }

  .tool-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .close-btn {
    min-width: 34px;
  }

  .modal-body {
    flex: 1;
    min-height: 0;
    display: flex;
    background: var(--color-nc-bg-deep);
  }

  .editor-body,
  .converted-preview,
  .image-shell {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .preview-frame {
    border: none;
    width: 100%;
    height: 100%;
    background: white;
  }

  .nav-btn {
    border: 1px solid var(--color-nc-border);
    background: var(--color-nc-bg-panel);
    color: var(--color-nc-text);
    padding: 8px 12px;
    border-radius: 4px;
    cursor: pointer;
  }

  .nav-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .image-browser {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 8px 14px;
    border-top: 1px solid var(--color-nc-border);
    background: var(--color-nc-bg-panel);
    flex-shrink: 0;
  }

  .browser-status {
    min-width: 72px;
    text-align: center;
    color: var(--color-nc-text-dim);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .empty-state {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    gap: 16px;
    padding: 24px;
    text-align: center;
    color: var(--color-nc-text-dim);
  }

  .error-state {
    color: #ffb4b4;
  }

  .fallback-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: center;
  }

  .conversion-label {
    padding: 10px 16px;
    font-size: 12px;
    color: var(--color-nc-text-dim);
    border-bottom: 1px solid var(--color-nc-border);
    background: var(--color-nc-bg-panel);
  }

  :global(.modal-body .viewer-container.embedded) {
    flex: 1;
    display: flex;
  }

  :global(.modal-body .viewer-body) {
    flex: 1;
  }

  .audio-dropdown-wrap,
  .subtitle-dropdown-wrap {
    display: flex;
    align-items: center;
    gap: 4px;
    background: var(--color-nc-bg-deep);
    border: 1px solid var(--color-nc-border);
    border-radius: 4px;
    padding: 2px 6px;
  }

  .audio-icon-label,
  .sub-icon-label {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    font-weight: 700;
    color: var(--color-nc-accent, #60a5fa);
    user-select: none;
  }

  .audio-select {
    max-width: 200px;
  }

  .tool-select {
    appearance: none;
    background: var(--color-nc-bg);
    border: 1px solid var(--color-nc-border);
    color: var(--color-nc-text);
    padding: 3px 8px;
    border-radius: 4px;
    font-size: 12px;
    outline: none;
    cursor: pointer;
    max-width: 180px;
  }

  .tool-select:focus {
    border-color: var(--color-nc-accent);
  }

  .subtitle-size-controls {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    background: var(--color-nc-bg);
    border: 1px solid var(--color-nc-border);
    border-radius: 4px;
    padding: 1px 3px;
  }

  .sub-size-btn {
    appearance: none;
    background: transparent;
    border: none;
    color: var(--color-nc-text);
    padding: 2px 5px;
    font-size: 11px;
    font-weight: 700;
    cursor: pointer;
    border-radius: 3px;
    display: flex;
    align-items: center;
    justify-content: center;
    user-select: none;
    transition: background 0.15s ease, color 0.15s ease;
  }

  .sub-size-btn:hover:not(:disabled) {
    background: var(--color-nc-bg-hover, rgba(255, 255, 255, 0.1));
    color: var(--color-nc-accent, #60a5fa);
  }

  .sub-size-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .sub-size-select {
    border: none;
    background: transparent;
    padding: 2px 4px;
    font-size: 11px;
    max-width: 124px;
  }

  .media-shell {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 20px;
    container-type: inline-size;
  }

  .video-container {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    max-width: 100%;
    max-height: 100%;
    width: min(1200px, 100%);
    overflow: hidden;
    background: #000000;
    border-radius: 6px;
    user-select: none;
  }

  .video-container.hide-cursor {
    cursor: none;
  }

  .video-container:fullscreen,
  .video-container:-webkit-full-screen {
    width: 100vw !important;
    height: 100vh !important;
    max-width: 100vw !important;
    max-height: 100vh !important;
    background: #000000 !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    padding: 0 !important;
    margin: 0 !important;
    border-radius: 0 !important;
  }

  .video-container:fullscreen .media-player,
  .video-container:-webkit-full-screen .media-player {
    width: 100% !important;
    height: 100% !important;
    max-width: 100vw !important;
    max-height: 100vh !important;
    object-fit: contain !important;
  }

  .media-player {
    max-width: 100%;
    max-height: 100%;
    width: 100%;
    object-fit: contain;
    display: block;
    cursor: pointer;
  }

  /* Subtitle overlay */
  .subtitle-overlay {
    --sub-font-size: calc(clamp(16px, min(1.8vw, 3.2vh), 56px) * var(--subtitle-scale, 1));
    position: absolute;
    bottom: 66px;
    left: 0;
    right: 0;
    display: flex;
    justify-content: center;
    align-items: center;
    pointer-events: none;
    z-index: 10;
    text-align: center;
    padding: 0 4%;
    transition: bottom 0.25s ease;
  }

  .video-container.controls-hidden .subtitle-overlay {
    bottom: 24px;
  }

  .video-container:fullscreen .subtitle-overlay,
  .video-container:-webkit-full-screen .subtitle-overlay {
    position: absolute !important;
    left: 0 !important;
    right: 0 !important;
    z-index: 2147483647 !important;
  }

  .subtitle-box {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: calc(var(--sub-font-size) * 0.4);
    max-width: 90%;
  }

  .subtitle-line-wrapper {
    display: flex;
    justify-content: center;
  }

  .subtitle-line {
    background-color: rgba(0, 0, 0, 0.82);
    color: #ffffff;
    font-family: "Roboto", -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
    font-size: var(--sub-font-size);
    font-weight: 400;
    line-height: 1.15;
    text-shadow: 0 2px 4px rgba(0, 0, 0, 0.95);
    border-radius: 2px;
    padding: 0.08em 0.35em;
    white-space: pre-wrap;
    box-decoration-break: clone;
    -webkit-box-decoration-break: clone;
  }

  .video-buffering-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.35);
    pointer-events: none;
    z-index: 15;
  }

  .buffering-spinner {
    width: 44px;
    height: 44px;
    border: 4px solid rgba(255, 255, 255, 0.2);
    border-top-color: var(--color-nc-accent, #60a5fa);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* Custom Video Controls */
  .custom-video-controls {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 20;
    padding: 24px 14px 10px 14px;
    background: linear-gradient(to top, rgba(0, 0, 0, 0.90) 0%, rgba(0, 0, 0, 0.5) 60%, transparent 100%);
    display: flex;
    flex-direction: column;
    gap: 8px;
    transition: opacity 0.25s ease, transform 0.25s ease;
    opacity: 1;
    transform: translateY(0);
  }

  .video-container:fullscreen .custom-video-controls,
  .video-container:-webkit-full-screen .custom-video-controls {
    z-index: 2147483647 !important;
  }

  .custom-video-controls.hidden {
    opacity: 0;
    pointer-events: none;
    transform: translateY(6px);
  }

  /* Scrubber / Progress Bar */
  .media-scrubber-wrap {
    position: relative;
    width: 100%;
    height: 18px;
    display: flex;
    align-items: center;
    cursor: pointer;
    touch-action: none;
  }

  .media-scrubber-track {
    position: relative;
    width: 100%;
    height: 5px;
    background: rgba(255, 255, 255, 0.25);
    border-radius: 3px;
    transition: height 0.15s ease;
  }

  .media-scrubber-wrap:hover .media-scrubber-track,
  .media-scrubber-wrap.scrubbing .media-scrubber-track {
    height: 8px;
  }

  .media-scrubber-fill {
    position: absolute;
    top: 0;
    left: 0;
    bottom: 0;
    background: var(--color-nc-accent, #60a5fa);
    border-radius: 3px;
    pointer-events: none;
  }

  .media-scrubber-handle {
    position: absolute;
    top: 50%;
    width: 13px;
    height: 13px;
    background: #ffffff;
    border: 2px solid var(--color-nc-accent, #60a5fa);
    border-radius: 50%;
    transform: translate(-50%, -50%) scale(0);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.6);
    pointer-events: none;
    transition: transform 0.15s ease;
  }

  .media-scrubber-wrap:hover .media-scrubber-handle,
  .media-scrubber-wrap.scrubbing .media-scrubber-handle {
    transform: translate(-50%, -50%) scale(1);
  }

  .media-scrubber-tooltip {
    position: absolute;
    bottom: 22px;
    transform: translateX(-50%);
    background: rgba(15, 23, 42, 0.94);
    color: #f8fafc;
    font-size: 11px;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: 3px;
    border: 1px solid rgba(255, 255, 255, 0.2);
    pointer-events: none;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  /* Controls Row */
  .media-controls-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .media-controls-left,
  .media-controls-right {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .player-btn {
    appearance: none;
    background: transparent;
    border: none;
    color: #ffffff;
    padding: 5px;
    border-radius: 4px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 3px;
    transition: background 0.15s ease, color 0.15s ease, transform 0.1s ease;
  }

  .player-btn:hover {
    background: rgba(255, 255, 255, 0.15);
    color: var(--color-nc-accent, #60a5fa);
  }

  .player-btn:active {
    transform: scale(0.95);
  }

  .player-icon {
    width: 20px;
    height: 20px;
  }

  .skip-btn {
    font-size: 11px;
    font-weight: 600;
    padding: 4px 6px;
  }

  .skip-label {
    font-variant-numeric: tabular-nums;
  }

  .media-time-display {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    font-weight: 500;
    color: #e2e8f0;
    font-variant-numeric: tabular-nums;
    margin-left: 4px;
    user-select: none;
  }

  .time-sep {
    color: rgba(255, 255, 255, 0.5);
  }

  .total-duration {
    color: rgba(255, 255, 255, 0.7);
  }

  /* Volume slider */
  .volume-control-wrap {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .volume-slider {
    appearance: none;
    width: 68px;
    height: 4px;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.3);
    outline: none;
    cursor: pointer;
    transition: background 0.15s ease;
  }

  .volume-slider::-webkit-slider-thumb {
    appearance: none;
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: #ffffff;
    cursor: pointer;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
  }

  .volume-slider::-moz-range-thumb {
    width: 11px;
    height: 11px;
    border: none;
    border-radius: 50%;
    background: #ffffff;
    cursor: pointer;
  }

  .volume-slider:hover {
    background: rgba(255, 255, 255, 0.5);
  }
</style>
