import crypto from 'crypto';

/**
 * Content-Security-Policy for the built SPA.
 *
 * The web shell had none at all, so anything that got markup into the page —
 * an unescaped label, a file served from this origin — ran with the whole API
 * behind it, `/system/execute` included. This mirrors the desktop shell's CSP
 * (`tauri.conf.json`). Inline scripts are allowed by hash rather than by
 * `'unsafe-inline'`: `app.html` has two of its own and SvelteKit adds its
 * bootstrap, and the hashes are taken from the built `index.html` at startup so
 * they cannot drift from what is actually served.
 */
export function buildCsp(indexHtml) {
    const hashes = inlineScriptHashes(indexHtml).map((h) => `'${h}'`);
    return [
        "default-src 'self'",
        `script-src 'self' ${hashes.join(' ')}`.trim(),
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com data:",
        "img-src 'self' data: blob:",
        "media-src 'self' blob:",
        "connect-src 'self'",
        "frame-src 'self'",
        "worker-src 'self'",
        "manifest-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'self'"
    ].join('; ');
}

export function inlineScriptHashes(html) {
    const hashes = [];
    const re = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        if (!m[1].trim()) continue;
        hashes.push(`sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}`);
    }
    return hashes;
}

/**
 * Files on disk that a browser would *run* if they were opened from this
 * origin. `/api/fs/raw` serves arbitrary files inline, so a downloaded
 * `page.html` opened through it would otherwise execute with the app's
 * origin — and so with full access to its API.
 */
export const ACTIVE_CONTENT_EXTENSIONS = new Set([
    '.html', '.htm', '.xhtml', '.xht', '.shtml', '.svg', '.svgz', '.xml', '.xsl', '.xslt', '.mht', '.mhtml'
]);

/** A sandbox without `allow-scripts` / `allow-same-origin`: renders, never runs. */
export const ACTIVE_CONTENT_CSP = 'sandbox';
