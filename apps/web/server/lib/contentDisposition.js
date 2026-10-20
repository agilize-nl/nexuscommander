// Browser-download plan §3.1 — a single, tested helper for the
// `Content-Disposition: attachment` header, shared by `routes/fs.js` (single
// file, `?download=1`) and `routes/download.js` (zip bundles). Two concerns
// that are easy to get wrong and easy to test once:
//
//   - the quoted `filename="…"` fallback must survive a name containing a
//     quote, backslash or CR/LF without letting it break out of the header;
//   - non-ASCII names (emoji, accents) need the separate RFC 5987
//     `filename*=UTF-8''…` parameter — encoding that value and also stuffing
//     it into the quoted fallback produces a mojibake filename for exactly
//     the users who need it working.
//
// CR/LF stripping matters even though `sanitizeRelPath`/`resolveSafePath`
// already reject control characters in *input* paths: the display name given
// to this helper is not always a raw path segment (§3.2 derives
// "<mapnaam>.zip" / "N-bestanden.zip" from possibly-unsanitized display
// names), so the header builder defends itself rather than trusting callers.

/** ASCII fallback for the quoted `filename="…"` parameter: strips CR/LF/quote/backslash. */
function asciiFallback(name) {
    // Header injection: a literal CR/LF here would let a filename terminate
    // the header and inject another one.
    const stripped = name.replace(/[\r\n]/g, '');
    // Non-ASCII becomes `_` in the fallback; the real name travels via
    // filename* below. Quote and backslash would otherwise break out of the
    // quoted-string.
    return stripped.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
}

/** RFC 5987 `ext-value` encoding for the `filename*` parameter. */
function rfc5987Encode(name) {
    const stripped = name.replace(/[\r\n]/g, '');
    return encodeURIComponent(stripped)
        // encodeURIComponent leaves these as literal characters; RFC 5987's
        // attr-char excludes them, so they still need percent-encoding.
        .replace(/['()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
        .replace(/\*/g, '%2A');
}

/**
 * Builds a `Content-Disposition` header value for a download of `name`.
 * @param {string} name display filename (not a path — no directory separators expected)
 */
export function buildContentDisposition(name) {
    const fallback = asciiFallback(name);
    const encoded = rfc5987Encode(name);
    return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
