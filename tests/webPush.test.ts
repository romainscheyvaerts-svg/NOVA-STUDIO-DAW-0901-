/**
 * Lot 7 · Web Push sans dépendance (supabase/functions/nova-push/webPush.ts).
 * Preuve par aller-retour : le message chiffré est déchiffré ICI comme le fait le navigateur
 * (RFC 8291 côté réception, avec le HKDF de Node, une implémentation indépendante) ; le jeton
 * VAPID est vérifié avec la clé publique. Clés générées pour le test, jamais celles du projet.
 */
import { hkdfSync, webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { b64urlDecode, b64urlEncode, concat, encryptPayload, importVapidKey, isPushEndpoint, sendPush, vapidAuthorization } from '../supabase/functions/nova-push/webPush';

const subtle = webcrypto.subtle;
const te = new TextEncoder();

async function browserKeys() {
  const kp = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const pub = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  const auth = webcrypto.getRandomValues(new Uint8Array(16));
  return { kp, p256dh: b64urlEncode(pub), auth: b64urlEncode(auth), pub, authBytes: auth };
}

/** Déchiffrement côté navigateur (RFC 8291 § 3 + RFC 8188), HKDF de Node. */
async function decrypt(body: Uint8Array, ua: Awaited<ReturnType<typeof browserKeys>>) {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16, false);
  const idlen = body[20];
  const asPub = body.slice(21, 21 + idlen);
  const cipher = body.slice(21 + idlen);
  const asKey = await subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.kp.privateKey, 256));
  const h = (s: Uint8Array, k: Uint8Array, info: Uint8Array, n: number) => new Uint8Array(hkdfSync('sha256', k, s, info, n));
  const ikm = h(ua.authBytes, ecdh, concat(te.encode('WebPush: info\0'), ua.pub, asPub), 32);
  const cek = h(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = h(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const key = await subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, cipher));
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--; // bourrage éventuel
  return { rs, idlen, delimiter: plain[end], text: new TextDecoder().decode(plain.slice(0, end)) };
}

async function vapidKeys() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const pub = b64urlEncode(new Uint8Array(await subtle.exportKey('raw', kp.publicKey)));
  const jwk = await subtle.exportKey('jwk', kp.privateKey);
  return { pub, priv: jwk.d as string, verifyKey: kp.publicKey };
}

describe('chiffrement aes128gcm (RFC 8291)', () => {
  it('le navigateur retrouve exactement le message (accents, émojis)', async () => {
    const ua = await browserKeys();
    const msg = JSON.stringify({ title: '💬 Nina a commenté à 1:12', body: '« le "s" siffle » · Séance « Été »' });
    const body = await encryptPayload(te.encode(msg), ua.p256dh, ua.auth);
    const out = await decrypt(body, ua);
    expect(out.text).toBe(msg);
    expect(out.rs).toBe(4096);
    expect(out.idlen).toBe(65);
    expect(out.delimiter).toBe(2); // dernier enregistrement
    expect(body.length).toBe(16 + 4 + 1 + 65 + te.encode(msg).length + 1 + 16);
  });

  it('deux envois du même message ne se ressemblent pas (sel et clé éphémère neufs)', async () => {
    const ua = await browserKeys();
    const a = await encryptPayload(te.encode('x'), ua.p256dh, ua.auth);
    const b = await encryptPayload(te.encode('x'), ua.p256dh, ua.auth);
    expect(b64urlEncode(a)).not.toBe(b64urlEncode(b));
  });

  it('un autre navigateur ne peut pas lire', async () => {
    const ua = await browserKeys();
    const other = await browserKeys();
    const body = await encryptPayload(te.encode('secret'), ua.p256dh, ua.auth);
    await expect(decrypt(body, other)).rejects.toBeTruthy();
  });

  it('clés de l’abonnement invalides ou contenu trop gros : refusé', async () => {
    const ua = await browserKeys();
    await expect(encryptPayload(te.encode('x'), 'abc', ua.auth)).rejects.toThrow(/p256dh/);
    await expect(encryptPayload(te.encode('x'), ua.p256dh, 'AAAA')).rejects.toThrow(/auth/);
    await expect(encryptPayload(new Uint8Array(5000), ua.p256dh, ua.auth)).rejects.toThrow(/trop gros/);
  });
});

describe('VAPID (RFC 8292)', () => {
  it('jeton ES256 signé, vérifiable avec la clé publique ; audience = service d’envoi ; 12 h', async () => {
    const v = await vapidKeys();
    const key = await importVapidKey(v.pub, v.priv);
    const now = 1_760_000_000;
    const h = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc:def', v.pub, key, 'https://www.studiomakemusic.com', now);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h)!;
    expect(m).toBeTruthy();
    expect(m[4]).toBe(v.pub);
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(m[2])));
    expect(claims).toEqual({ aud: 'https://fcm.googleapis.com', exp: now + 12 * 3600, sub: 'https://www.studiomakemusic.com' });
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(m[1])))).toEqual({ typ: 'JWT', alg: 'ES256' });
    const sig = b64urlDecode(m[3]);
    expect(sig.length).toBe(64);
    const ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, v.verifyKey, sig, te.encode(`${m[1]}.${m[2]}`));
    expect(ok).toBe(true);
  });

  it('clés mal formées : message clair', async () => {
    const v = await vapidKeys();
    await expect(importVapidKey('court', v.priv)).rejects.toThrow(/VAPID_PUBLIC_KEY/);
    await expect(importVapidKey(v.pub, 'court')).rejects.toThrow(/VAPID_PRIVATE_KEY/);
  });
});

describe('adresses d’envoi', () => {
  it('seulement les services des navigateurs, en https, sans port', () => {
    for (const ok of ['https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://wns2-par02p.notify.windows.com/w/?token=x', 'https://web.push.apple.com/QG', 'https://api.push.apple.com/3/device/x']) {
      expect(isPushEndpoint(ok), ok).toBe(true);
    }
    for (const ko of ['http://fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://evil.com/fcm.googleapis.com', 'https://127.0.0.1/x', 'https://fcm.googleapis.com.evil.com/x', 'pas une adresse', 42, 'https://fcm.googleapis.com/' + 'x'.repeat(1001)]) {
      expect(isPushEndpoint(ko), String(ko)).toBe(false);
    }
  });

  it('envoi : en-têtes aes128gcm + VAPID + TTL ; adresse interdite jamais appelée', async () => {
    const v = await vapidKeys();
    const ua = await browserKeys();
    const keys = { publicKey: v.pub, signKey: await importVapidKey(v.pub, v.priv), subject: 'https://www.studiomakemusic.com' };
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }));
    const st = await sendPush({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: ua.p256dh, auth: ua.auth }, '{"title":"x"}', keys, { fetchImpl, ttl: 60, urgency: 'high' });
    expect(st).toBe(201);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://fcm.googleapis.com/fcm/send/abc');
    const h = init.headers as Record<string, string>;
    expect(h['Content-Encoding']).toBe('aes128gcm');
    expect(h.TTL).toBe('60');
    expect(h.Urgency).toBe('high');
    expect(h.Authorization).toMatch(/^vapid t=.+, k=/);
    expect((await decrypt(init.body as Uint8Array, ua)).text).toBe('{"title":"x"}');
    const st2 = await sendPush({ endpoint: 'https://evil.example/x', p256dh: ua.p256dh, auth: ua.auth }, '{}', keys, { fetchImpl });
    expect(st2).toBe(400);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
