<script lang="ts">
  import { 
    Folder, 
    File, 
    FileCode, 
    FileJson, 
    FileSpreadsheet, 
    Database, 
    FileText, 
    Image, 
    Film, 
    Music, 
    FileArchive, 
    Settings, 
    Key, 
    ShieldCheck, 
    Type, 
    Lock,
    AppWindow,
    Terminal,
    TerminalSquare
  } from "lucide-svelte";
  import { getFileIconPath, getLucideIconName } from "$lib/iconMap";
  import Icon from "@iconify/svelte";
  import tablerFolder from "@iconify-icons/tabler/folder";
  import tablerFile from "@iconify-icons/tabler/file";
  import tablerCode from "@iconify-icons/tabler/file-code";
  import tablerImage from "@iconify-icons/tabler/photo";
  import tablerVideo from "@iconify-icons/tabler/video";
  import tablerMusic from "@iconify-icons/tabler/music";
  import tablerArchive from "@iconify-icons/tabler/archive";
  import tablerText from "@iconify-icons/tabler/file-text";
  import tablerDatabase from "@iconify-icons/tabler/database";
  import tablerSettings from "@iconify-icons/tabler/settings";
  import tablerKey from "@iconify-icons/tabler/key";
  import tablerLock from "@iconify-icons/tabler/lock";
  import fluentFolder from "@iconify-icons/fluent/folder-24-regular";
  import fluentFile from "@iconify-icons/fluent/document-24-regular";
  import fluentVideo from "@iconify-icons/fluent/video-24-regular";
  import fluentMusic from "@iconify-icons/fluent/music-note-2-24-regular";
  import fluentArchive from "@iconify-icons/fluent/archive-24-regular";
  import fluentDatabase from "@iconify-icons/fluent/database-24-regular";
  import fluentSettings from "@iconify-icons/fluent/settings-24-regular";
  import fluentKey from "@iconify-icons/fluent/key-24-regular";
  import fluentLock from "@iconify-icons/fluent/lock-closed-24-regular";
  import materialFolder from "@iconify-icons/material-symbols/folder";
  import materialFile from "@iconify-icons/material-symbols/description";
  import materialCode from "@iconify-icons/material-symbols/code";
  import materialImage from "@iconify-icons/material-symbols/image";
  import materialVideo from "@iconify-icons/material-symbols/movie";
  import materialMusic from "@iconify-icons/material-symbols/music-note";
  import materialArchive from "@iconify-icons/material-symbols/archive";
  import materialDatabase from "@iconify-icons/material-symbols/database";
  import materialSettings from "@iconify-icons/material-symbols/settings";
  import materialKey from "@iconify-icons/material-symbols/key";
  import materialLock from "@iconify-icons/material-symbols/lock";
  import phosphorFolder from "@iconify-icons/ph/folder";
  import phosphorFile from "@iconify-icons/ph/file";
  import phosphorCode from "@iconify-icons/ph/file-code";
  import phosphorImage from "@iconify-icons/ph/image";
  import phosphorVideo from "@iconify-icons/ph/video";
  import phosphorMusic from "@iconify-icons/ph/music-note";
  import phosphorArchive from "@iconify-icons/ph/archive";
  import phosphorDatabase from "@iconify-icons/ph/database";
  import phosphorSettings from "@iconify-icons/ph/gear";
  import phosphorKey from "@iconify-icons/ph/key";
  import phosphorLock from "@iconify-icons/ph/lock";
  import remixFolder from "@iconify-icons/ri/folder-line";
  import remixFile from "@iconify-icons/ri/file-line";
  import remixCode from "@iconify-icons/ri/file-code-line";
  import remixImage from "@iconify-icons/ri/image-line";
  import remixVideo from "@iconify-icons/ri/video-line";
  import remixMusic from "@iconify-icons/ri/music-2-line";
  import remixArchive from "@iconify-icons/ri/file-zip-line";
  import remixDatabase from "@iconify-icons/ri/database-2-line";
  import remixSettings from "@iconify-icons/ri/settings-3-line";
  import remixKey from "@iconify-icons/ri/key-2-line";
  import remixLock from "@iconify-icons/ri/lock-line";

  const { name, ext, isDir, theme, size = 14 } = $props<{
    name: string;
    ext: string;
    isDir: boolean;
    theme: string;
    size?: number;
  }>();

  // Mapping string names from iconMap.ts to Lucide components
  const lucideMap: Record<string, any> = {
    "Folder": Folder,
    "File": File,
    "FileCode": FileCode,
    "FileJson": FileJson,
    "FileSpreadsheet": FileSpreadsheet,
    "Database": Database,
    "FileText": FileText,
    "Image": Image,
    "Film": Film,
    "Music": Music,
    "FileArchive": FileArchive,
    "Settings": Settings,
    "Key": Key,
    "ShieldCheck": ShieldCheck,
    "Type": Type,
    "Lock": Lock,
    "Terminal": Terminal,
    "AppWindow": AppWindow
  };

  let iconPath = $derived(getFileIconPath(name, ext, isDir, theme));
  let lucideIconName = $derived(theme === 'lucide' ? getLucideIconName(ext, isDir) : null);
  let LucideComponent = $derived(lucideIconName ? (lucideMap[lucideIconName] || File) : null);

  const iconifyThemes: Record<string, Record<string, any>> = {
    tabler: { Folder: tablerFolder, File: tablerFile, FileCode: tablerCode, Image: tablerImage, Film: tablerVideo, Music: tablerMusic, FileArchive: tablerArchive, FileText: tablerText, Database: tablerDatabase, Settings: tablerSettings, Key: tablerKey, Lock: tablerLock },
    fluent: { Folder: fluentFolder, File: fluentFile, FileCode: fluentFile, Image: fluentFile, Film: fluentVideo, Music: fluentMusic, FileArchive: fluentArchive, FileText: fluentFile, Database: fluentDatabase, Settings: fluentSettings, Key: fluentKey, Lock: fluentLock },
    "material-symbols": { Folder: materialFolder, File: materialFile, FileCode: materialCode, Image: materialImage, Film: materialVideo, Music: materialMusic, FileArchive: materialArchive, FileText: materialFile, Database: materialDatabase, Settings: materialSettings, Key: materialKey, Lock: materialLock },
    phosphor: { Folder: phosphorFolder, File: phosphorFile, FileCode: phosphorCode, Image: phosphorImage, Film: phosphorVideo, Music: phosphorMusic, FileArchive: phosphorArchive, FileText: phosphorFile, Database: phosphorDatabase, Settings: phosphorSettings, Key: phosphorKey, Lock: phosphorLock },
    remix: { Folder: remixFolder, File: remixFile, FileCode: remixCode, Image: remixImage, Film: remixVideo, Music: remixMusic, FileArchive: remixArchive, FileText: remixFile, Database: remixDatabase, Settings: remixSettings, Key: remixKey, Lock: remixLock },
  };

  let iconifyIcon = $derived.by(() => {
    const icons = iconifyThemes[theme];
    if (!icons) return null;
    const iconName = getLucideIconName(ext, isDir);
    return icons[iconName] ?? icons.File;
  });
</script>

{#if theme === 'lucide'}
  {#if LucideComponent}
    <LucideComponent size={size} strokeWidth={1.5} />
  {/if}
{:else if iconPath}
  <img 
    src={iconPath} 
    alt="" 
    width={size} 
    height={size} 
    class="file-icon-img"
    loading="lazy"
  />
{:else if iconifyIcon}
  <Icon icon={iconifyIcon} width={size} height={size} />
{/if}

<style>
  .file-icon-img {
    display: block;
    object-fit: contain;
    image-rendering: optimizeSpeed;
  }
</style>
