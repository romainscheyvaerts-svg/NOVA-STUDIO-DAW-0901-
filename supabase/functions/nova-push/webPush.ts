// Web Push sans dépendance : WebCrypto seul (Deno et Node 20+).
//  - chiffrement du contenu « aes128gcm » (RFC 8291 + RFC 8188), un seul enregistrement ;
//  - en-tête d'autorisation VAPID (RFC 8292) : jeton JWT ES256 signé par la clé privée du projet.
// Les clés VAPID viennent des secrets Supabase (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT),
// jamais du code. Testé par tests/webPush.test.ts (aller-retour : déchiffré comme le ferait le navigateur).

const te = new TextEncoder();

export function b64urlEncode(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array {
  const clean = String(s || "").trim().replace(/-/g, "+").replace(/_/g, "/");
  const pad = clean.length % 4 ? "=".repeat(4 - (clean.length % 4)) : "";
  const bin = atob(clean + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

/** HKDF (RFC 5869) pour une sortie ≤ 32 octets : extraction puis un seul tour d'expansion. */
export async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, len);
}

/** Clé publique P-256 « non compressée » (65 octets, 0x04 || X || Y) valide ? */
export function isP256Public(raw: Uint8Array): boolean {
  return raw.length === 65 && raw[0] === 4;
}

export interface EncryptOptions {
  /** Pour les tests seulement : sel et clé éphémère imposés. */
  salt?: Uint8Array;
  serverKeys?: CryptoKeyPair;
  recordSize?: number;
}

/**
 * Chiffre `plaintext` pour un abonnement (clés p256dh et auth du navigateur, en base64url).
 * Renvoie le corps à POSTer (Content-Encoding: aes128gcm).
 */
export async function encryptPayload(plaintext: Uint8Array, p256dhB64: string, authB64: string, opts: EncryptOptions = {}): Promise<Uint8Array> {
  const uaPublic = b64urlDecode(p256dhB64);
  const authSecret = b64urlDecode(authB64);
  if (!isP256Public(uaPublic)) throw new Error("clé p256dh invalide");
  if (authSecret.length < 16) throw new Error("secret auth invalide");
  const rs = opts.recordSize ?? 4096;
  if (plaintext.length + 1 + 16 > rs) throw new Error("contenu trop gros pour un enregistrement");

  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const as = opts.serverKeys ?? (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));

  // RFC 8291 § 3.4 : IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info\0" || ua_public || as_public, 32).
  const ikm = await hkdf(authSecret, ecdh, concat(te.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);

  // Un seul enregistrement : contenu || 0x02 (délimiteur du dernier enregistrement), sans bourrage.
  const key = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(plaintext, new Uint8Array([2]))));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs, false);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, cipher);
}

/** Clé privée VAPID (32 octets base64url) + clé publique (65 octets) → clé de signature ES256. */
export async function importVapidKey(publicB64: string, privateB64: string): Promise<CryptoKey> {
  const safe = (s: string) => { try { return b64urlDecode(s); } catch { return new Uint8Array(0); } };
  const pub = safe(publicB64);
  const d = safe(privateB64);
  if (!isP256Public(pub)) throw new Error("VAPID_PUBLIC_KEY invalide (65 octets attendus, base64url)");
  if (d.length !== 32) throw new Error("VAPID_PRIVATE_KEY invalide (32 octets attendus, base64url)");
  const jwk = { kty: "EC", crv: "P-256", d: b64urlEncode(d), x: b64urlEncode(pub.slice(1, 33)), y: b64urlEncode(pub.slice(33, 65)), ext: true };
  return await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

/** En-tête Authorization VAPID pour l'adresse d'envoi (valable 12 h). */
export async function vapidAuthorization(endpoint: string, publicB64: string, signKey: CryptoKey, subject: string, nowSec: number = Math.floor(Date.now() / 1000)): Promise<string> {
  const aud = new URL(endpoint).origin;
  const head = b64urlEncode(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64urlEncode(te.encode(JSON.stringify({ aud, exp: nowSec + 12 * 3600, sub: subject })));
  const input = `${head}.${claims}`;
  // WebCrypto rend la signature ECDSA au format r || s (64 octets) : exactement ce que veut JWS.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signKey, te.encode(input)));
  return `vapid t=${input}.${b64urlEncode(sig)}, k=${publicB64}`;
}

/**
 * Seuls les services d'envoi des navigateurs sont acceptés (pas d'adresse interne ni arbitraire :
 * le serveur ne POSTe que vers eux). Même liste que la contrainte SQL de nova_push_subscriptions.
 */
export const PUSH_HOST_RE = /^(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.notify\.windows\.com|web\.push\.apple\.com|[a-z0-9.-]+\.push\.apple\.com)$/i;

export function isPushEndpoint(endpoint: unknown): boolean {
  if (typeof endpoint !== "string" || endpoint.length > 1000) return false;
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && !u.port && PUSH_HOST_RE.test(u.hostname);
  } catch {
    return false;
  }
}

export interface PushTarget { endpoint: string; p256dh: string; auth: string }
export interface VapidKeys { publicKey: string; signKey: CryptoKey; subject: string }

/** Envoie un message chiffré. Renvoie le statut HTTP du service d'envoi (201 = accepté, 404/410 = abonnement mort). */
export async function sendPush(target: PushTarget, payload: string, vapid: VapidKeys, opts: { ttl?: number; urgency?: "low" | "normal" | "high"; topic?: string; fetchImpl?: typeof fetch } = {}): Promise<number> {
  if (!isPushEndpoint(target.endpoint)) return 400;
  const body = await encryptPayload(te.encode(payload), target.p256dh, target.auth);
  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    "Content-Encoding": "aes128gcm",
    TTL: String(opts.ttl ?? 86400),
    Urgency: opts.urgency ?? "normal",
    Authorization: await vapidAuthorization(target.endpoint, vapid.publicKey, vapid.signKey, vapid.subject),
  };
  // Topic : 32 caractères base64url au plus ; remplace un message pas encore livré du même sujet.
  if (opts.topic && /^[A-Za-z0-9_-]{1,32}$/.test(opts.topic)) headers.Topic = opts.topic;
  const res = await (opts.fetchImpl ?? fetch)(target.endpoint, { method: "POST", headers, body });
  try { await res.arrayBuffer(); } catch { /* corps ignoré */ }
  return res.status;
}
