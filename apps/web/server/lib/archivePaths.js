import path from 'path';
import fssync from 'fs';

export function archiveKind(filePath) {
    const lower = filePath.toLowerCase();
    if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar';
    if (lower.endsWith('.tar.bz2') || lower.endsWith('.tbz2')) return 'tar';
    if (lower.endsWith('.tar.xz') || lower.endsWith('.txz')) return 'tar';
    if (lower.endsWith('.tar.zst') || lower.endsWith('.tzst') || lower.endsWith('.zst')) return 'tar';
    if (lower.endsWith('.tar')) return 'tar';
    if (lower.endsWith('.gz')) return 'gz';
    if (lower.endsWith('.zip')) return 'zip';
    if (lower.endsWith('.7z')) return '7z';
    if (lower.endsWith('.rar')) return 'rar';
    return null;
}

/**
 * Reject an inner archive path that an external tool would read as an option.
 *
 * `tar` and `7z` both take file operands positionally, so an entry named
 * `--checkpoint-action=exec=sh` reaching either of them as an operand is an
 * argument-injection primitive that starts a subprocess as the backend user.
 * Call sites pass `--` as well; this is the second half of the same guard,
 * because `--` support is a property of each individual tool's parser and
 * `--`-before-operands is not universal (notably not for 7-Zip's switches
 * before 15.x).
 */
export function assertSafeArchiveOperand(innerPath, label = 'archive entry') {
    if (typeof innerPath !== 'string' || innerPath.length === 0) return innerPath;
    if (innerPath.startsWith('-')) {
        const err = new Error(`Refusing to pass a ${label} that starts with '-': ${innerPath}`);
        err.statusCode = 400;
        throw err;
    }
    if (innerPath.includes('\0')) {
        const err = new Error(`Invalid ${label}`);
        err.statusCode = 400;
        throw err;
    }
    return innerPath;
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
