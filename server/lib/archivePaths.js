import path from 'path';
import fssync from 'fs';

export function archiveKind(filePath) {
    const lower = filePath.toLowerCase();
    if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar';
    if (lower.endsWith('.tar.bz2') || lower.endsWith('.tbz2')) return 'tar';
    if (lower.endsWith('.tar.xz') || lower.endsWith('.txz')) return 'tar';
    if (lower.endsWith('.tar')) return 'tar';
    if (lower.endsWith('.gz')) return 'gz';
    if (lower.endsWith('.zip')) return 'zip';
    if (lower.endsWith('.7z')) return '7z';
    if (lower.endsWith('.rar')) return 'rar';
    return null;
}

export function splitVirtualPath(p) {
    if (!p) return null;
    
    // Check if the path contains '::'
    if (p.includes('::')) {
        const parts = p.split('::');
        const archivePath = parts[0];
        const innerPath = parts.slice(1).join('::');
        if (archiveKind(archivePath)) {
            return { archivePath, innerPath: innerPath.replace(/^\//, '') };
        }
    }
    
    // Check for nested slash form (e.g. /path/to/archive.zip/inner/path)
    const parts = p.split(path.sep);
    let currentPath = '';
    
    let startIndex = p.startsWith(path.sep) ? 1 : 0;
    
    for (let i = startIndex; i < parts.length; i++) {
        const nextPart = parts[i];
        if (!nextPart && i === parts.length - 1) continue;
        
        currentPath = currentPath ? currentPath + path.sep + nextPart : (p.startsWith(path.sep) ? path.sep + nextPart : nextPart);
        
        try {
            if (archiveKind(currentPath)) {
                const stat = fssync.statSync(currentPath);
                if (stat.isFile()) {
                    const innerPath = parts.slice(i + 1).join('/');
                    return { archivePath: currentPath, innerPath: innerPath.replace(/^\//, '') };
                }
            }
        } catch (e) {
            // Stat failed (path doesn't exist, etc.)
        }
    }
    
    return null;
}
