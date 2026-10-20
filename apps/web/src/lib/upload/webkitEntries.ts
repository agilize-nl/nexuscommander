export interface CollectedFile {
  file: File;
  rel: string;
}

export interface CollectionResult {
  files: CollectedFile[];
  emptyDirs: string[];
}

export async function collectFromDataTransfer(dt: DataTransfer): Promise<CollectionResult> {
  const files: CollectedFile[] = [];
  const emptyDirs: string[] = [];
  
  // Gotcha 1: collect entries synchronously before the drag-and-drop context yields
  const entries: FileSystemEntry[] = [];
  if (dt.items && dt.items.length > 0) {
    for (let i = 0; i < dt.items.length; i++) {
      const item = dt.items[i];
      if (typeof item.webkitGetAsEntry === 'function') {
        const entry = item.webkitGetAsEntry();
        if (entry) {
          entries.push(entry);
        }
      }
    }
  }
  
  // Fallback to standard dt.files if webkitGetAsEntry is not supported/returned nothing
  if (entries.length === 0 && dt.files && dt.files.length > 0) {
    for (let i = 0; i < dt.files.length; i++) {
      const file = dt.files[i];
      files.push({
        file,
        rel: file.name
      });
    }
    return { files, emptyDirs };
  }
  
  // Recursive directory traverser
  async function traverse(entry: FileSystemEntry, pathAcc: string): Promise<void> {
    if (entry.isFile) {
      const fileEntry = entry as FileSystemFileEntry;
      const file = await new Promise<File>((resolve, reject) => {
        fileEntry.file(resolve, reject);
      });
      files.push({
        file,
        rel: pathAcc ? `${pathAcc}/${entry.name}` : entry.name
      });
    } else if (entry.isDirectory) {
      const dirEntry = entry as FileSystemDirectoryEntry;
      const dirPath = pathAcc ? `${pathAcc}/${entry.name}` : entry.name;
      
      const dirEntries = await readAllEntries(dirEntry);
      if (dirEntries.length === 0) {
        emptyDirs.push(dirPath);
      } else {
        for (const child of dirEntries) {
          await traverse(child, dirPath);
        }
      }
    }
  }
  
  // Gotcha 2: readEntries yields max 100 entries per call in Chromium, loop until empty
  async function readAllEntries(dirEntry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
    const reader = dirEntry.createReader();
    const result: FileSystemEntry[] = [];
    
    while (true) {
      const entriesBatch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
        reader.readEntries(resolve, reject);
      });
      if (entriesBatch.length === 0) {
        break;
      }
      result.push(...entriesBatch);
    }
    return result;
  }
  
  for (const entry of entries) {
    await traverse(entry, '');
  }
  
  return { files, emptyDirs };
}
