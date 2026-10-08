/**
 * MD5 (RFC 1321), sans dépendance : signature des échantillons dans l'en-tête
 * STREAMINFO d'un FLAC (les lecteurs et `flac -t` la vérifient).
 */
const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0);

export function md5(data: Uint8Array): Uint8Array {
  const n = data.length;
  const total = ((n + 8) >> 6) + 1;
  const words = new Uint32Array(total * 16);
  // Mots complets, puis la fin (octet 0x80 et longueur en bits).
  const full = n >> 2;
  for (let i = 0; i < full; i++) {
    const o = i << 2;
    words[i] = data[o] | (data[o + 1] << 8) | (data[o + 2] << 16) | (data[o + 3] << 24);
  }
  for (let i = full << 2; i < n; i++) words[i >> 2] |= data[i] << ((i & 3) * 8);
  words[n >> 2] |= 0x80 << ((n & 3) * 8);
  const bits = n * 8;
  words[total * 16 - 2] = bits >>> 0;
  words[total * 16 - 1] = Math.floor(bits / 4294967296) >>> 0;
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let blk = 0; blk < total; blk++) {
    const base = blk * 16;
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; }
      else { F = C ^ (B | ~D); g = (7 * i) & 15; }
      F = (F + A + K[i] + words[base + g]) | 0;
      A = D; D = C; C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  const out = new Uint8Array(16);
  [a0, b0, c0, d0].forEach((v, i) => { out[i * 4] = v & 0xff; out[i * 4 + 1] = (v >>> 8) & 0xff; out[i * 4 + 2] = (v >>> 16) & 0xff; out[i * 4 + 3] = (v >>> 24) & 0xff; });
  return out;
}

export const md5Hex = (data: Uint8Array) => Array.from(md5(data), b => b.toString(16).padStart(2, '0')).join('');
