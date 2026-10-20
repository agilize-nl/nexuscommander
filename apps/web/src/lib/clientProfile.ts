// Per-client settings isolation — Fase 2 of
// apps/web/docs/PER_CLIENT_INSTELLINGEN_PLAN.md. Storage and generation live
// here, not in ipc.ts's general transport function, so the identifier stays
// out of every unrelated request.

const CLIENT_ID_KEY = "nc-client-id-v1";
const CLIENT_ID_RE = /^nc_[a-f0-9]{32}$/;

let volatileClientId: string | null = null;

function generateClientId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `nc_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function getClientId(): string | null {
  if (typeof window === "undefined") return null;

  try {
    const stored = window.localStorage.getItem(CLIENT_ID_KEY);
    if (stored && CLIENT_ID_RE.test(stored)) return stored;

    const generated = generateClientId();
    window.localStorage.setItem(CLIENT_ID_KEY, generated);
    return generated;
  } catch {
    // Storage can throw a SecurityError under some browser/privacy policies.
    // A volatile ID keeps requests consistent within this page session
    // without silently falling through to writing the shared legacy profile.
    volatileClientId ??= generateClientId();
    return volatileClientId;
  }
}
