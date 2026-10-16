const enc = new TextEncoder();
const dec = new TextDecoder();

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))));
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Random URL-safe id, e.g. for nonces. */
export const randomId = (bytes = 16) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

/**
 * A signed, expiring token: base64url(JSON) + "." + HMAC. `kind` keeps a token
 * minted for one purpose (a settings link) from being accepted as another (a session).
 */
export async function signToken(secret: string, kind: string, payload: Record<string, unknown>, ttlSeconds: number): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify({ ...payload, kind, exp: Math.floor(Date.now() / 1000) + ttlSeconds })));
  return `${body}.${await hmac(secret, body)}`;
}

export async function verifyToken<T extends Record<string, unknown>>(secret: string, kind: string, token: string | null | undefined): Promise<T | undefined> {
  if (!token) return undefined;
  const [body, sig] = token.split(".");
  if (!body || !sig || !sameText(sig, await hmac(secret, body))) return undefined;
  let data: T & { kind?: string; exp?: number };
  try {
    data = JSON.parse(dec.decode(fromB64url(body))) as T & { kind?: string; exp?: number };
  } catch {
    return undefined;
  }
  if (data.kind !== kind || typeof data.exp !== "number" || data.exp < Date.now() / 1000) return undefined;
  return data;
}

async function aesKey(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(`channel-credentials:${secret}`));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** AES-GCM encrypt with a key derived from APP_SECRET; output is base64url(iv ‖ ciphertext). */
export async function encrypt(secret: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), enc.encode(plaintext)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64url(out);
}

export async function decrypt(secret: string, data: string): Promise<string> {
  const bytes = fromB64url(data);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, await aesKey(secret), bytes.slice(12));
  return dec.decode(pt);
}

export { sameText };
