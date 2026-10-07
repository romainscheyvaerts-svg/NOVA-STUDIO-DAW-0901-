"""Preuves V16-V17 (motifs de batterie, samples perso sur les pads, découpe) dans
un navigateur headless, par la VRAIE interface (clics dans la boîte à rythmes),
puis rendu par le même moteur que l'export (audioEngine.renderProject) et
mesure des coups.

Usage : python qa/v16_v17_preuves.py [URL]   (défaut http://localhost:3420/)
Sortie : D:\\1 WORK\\CONTENU\\nova-v16-v17\\ (captures, WAV rendus, preuves.json)
Aucune écriture externe (qalib bloque les POST/PATCH/PUT/DELETE vers l'extérieur).
"""
import sys, os, re, json, math, struct, wave, base64, time
from pathlib import Path

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3420/"
OUT = Path(r"D:\1 WORK\CONTENU\nova-v16-v17")
OUT.mkdir(parents=True, exist_ok=True)
os.environ["QA_OUT"] = str(OUT)
sys.path.insert(0, str(Path(__file__).parent))
import qalib  # noqa
qalib.BASE = URL
qalib.OUT = OUT
from playwright.sync_api import sync_playwright  # noqa

SR = 44100


def write_wav(path, samples):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(b"".join(struct.pack("<h", int(max(-1, min(1, s)) * 32000)) for s in samples))


def tone(freq, dur, amp=0.8, decay=0.05):
    n = int(dur * SR)
    return [amp * math.sin(2 * math.pi * freq * i / SR) * math.exp(-i / (SR * decay)) * min(1, i / 40) for i in range(n)]


# Sample perso : « bip » à 3 kHz qui décroît (attaque franche, queue douce).
PERSO = OUT / "sample_perso_3khz.wav"
write_wav(PERSO, tone(3000, 0.15, 0.9, 0.035))
# Boucle à découper : 8 notes distinctes sur les croches d'une mesure à 100 BPM.
LOOP_FREQS = [200, 300, 450, 650, 900, 1200, 1600, 2100]
LOOP_BPM = 100
LOOP = OUT / "boucle_8_notes_100bpm.wav"
eighth = 60 / LOOP_BPM / 2
loop = [0.0] * int(8 * eighth * SR)
for k, f in enumerate(LOOP_FREQS):
    for i, v in enumerate(tone(f, eighth * 0.85, 0.8, 0.09)):
        loop[int(k * eighth * SR) + i] += v
write_wav(LOOP, loop)

# --- JS côté page ---------------------------------------------------------
HOOK = r"""
async () => {
  const { audioEngine: e } = await import('/engine/AudioEngine.ts');
  if (!window.__v16) {
    window.__v16 = { tracks: null };
    const up = e.updateTrack.bind(e);
    e.updateTrack = (t, all) => { window.__v16.tracks = all; return up(t, all); };
    const live = e.setLiveTracks.bind(e);
    e.setLiveTracks = (all) => { window.__v16.tracks = all; return live(all); };
  }
  return true;
}
"""

RENDER = r"""
async ({ bars, save, cands, probes }) => {
  const { audioEngine: e } = await import('/engine/AudioEngine.ts');
  const { detectTransients } = await import('/utils/chop.ts');
  const all = window.__v16.tracks;
  const drums = all.find(t => t.id === 'track-drums');
  const clips = drums.clips.map(c => ({ name: c.name, start: +c.start.toFixed(4), duration: +c.duration.toFixed(4), notes: (c.notes || []).length }));
  // Seule la batterie sonne (la mélodie est coupée) : c'est elle qu'on mesure.
  const tracks = all.map(t => (t.id === 'track-drums' || t.type === 'BUS' || t.type === 'SEND' || t.id === 'master') ? t : { ...t, isMuted: true });
  const barSec = window.__v16.barSec;
  const dur = bars * barSec + 0.3;
  const buf = await e.renderProject(tracks, dur, 0, 44100);
  const ch = buf.getChannelData(0);
  const sr = buf.sampleRate;
  // detectTransients plafonne à 16 tranches : on mesure mesure par mesure.
  const hits = [];
  for (let b = 0; b < bars; b++) {
    const a = Math.floor(b * barSec * sr), z = Math.floor((b + 1) * barSec * sr);
    const seg = ch.subarray(a, z);
    const pts = detectTransients([seg], sr, { sensitivity: 0.7, minGapMs: 60 });
    let pk = 0; for (let i = 0; i < seg.length; i++) pk = Math.max(pk, Math.abs(seg[i]));
    pts.forEach(p => {
      // un « coup » = au moins 10 % de la crête de la mesure dans les 30 ms suivantes
      let m = 0; for (let i = p; i < Math.min(seg.length, p + sr * 0.03); i++) m = Math.max(m, Math.abs(seg[i]));
      if (m < pk * 0.1 && pk > 0) return;
      // fréquence : passages par zéro de 5 à 35 ms après l'attaque
      const s0 = p + Math.round(sr * 0.005), s1 = Math.min(seg.length, p + Math.round(sr * 0.035));
      let zc = 0; for (let i = s0 + 1; i < s1; i++) if ((seg[i - 1] < 0) !== (seg[i] < 0)) zc++;
      // enveloppe : où est la crête dans les 150 ms (début = son à l'endroit, fin = à l'envers)
      let mi = p, mv = 0; for (let i = p; i < Math.min(seg.length, p + sr * 0.15); i++) { const v = Math.abs(seg[i]); if (v > mv) { mv = v; mi = i; } }
      // note la plus proche parmi des fréquences candidates (Goertzel, 5-60 ms après l'attaque)
      let best = null;
      if (cands) {
        let bv = -1;
        for (const f of cands) {
          const w = 2 * Math.PI * f / sr, cw = 2 * Math.cos(w); let s1 = 0, s2 = 0;
          for (let i = p + Math.round(sr * 0.005); i < Math.min(seg.length, p + Math.round(sr * 0.06)); i++) { const s = seg[i] + cw * s1 - s2; s2 = s1; s1 = s; }
          const pw = s1 * s1 + s2 * s2 - cw * s1 * s2;
          if (pw > bv) { bv = pw; best = f; }
        }
      }
      hits.push({ note: best, bar: b + 1, t: +((a + p) / sr).toFixed(3), inBar: +((p / sr) / barSec * 16).toFixed(2), hz: Math.round(zc / 2 / ((s1 - s0) / sr)), peakMs: Math.round((mi - p) / sr * 1000), level: +m.toFixed(3) });
    });
  }
  // Sondes : enveloppe et fréquence à un instant précis (pas d'une mesure)
  const probed = (probes || []).map(({ bar: pb, step: ps }) => {
    const p0 = Math.round(((pb - 1) * barSec + ps * barSec / 16) * sr);
    let mi = p0, mv = 0;
    for (let i = p0; i < Math.min(ch.length, p0 + sr * 0.16); i++) { const v = Math.abs(ch[i]); if (v > mv) { mv = v; mi = i; } }
    const s0 = p0 + Math.round(sr * 0.003), s1 = p0 + Math.round(sr * 0.14);
    let zc = 0; for (let i = s0 + 1; i < s1; i++) if ((ch[i - 1] < 0) !== (ch[i] < 0)) zc++;
    return { bar: pb, step: ps + 1, peakMs: Math.round((mi - p0) / sr * 1000), hz: Math.round(zc / 2 / ((s1 - s0) / sr)), level: +mv.toFixed(3) };
  });
  // Ordre attendu des tranches d'après le motif affiché (pas → n° de tranche)
  const dmx = drums.drumMachine;
  const slotOrder = [];
  (dmx.rows || []).forEach(r => { if (r.slice) r.steps.forEach((v, i) => { if (v > 0) slotOrder.push([i, r.slice]); }); });
  slotOrder.sort((a, b) => a[0] - b[0]);
  let wav = null;
  if (save) {
    const n = ch.length, out = new DataView(new ArrayBuffer(44 + n * 2));
    const w = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); out.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
    out.setUint32(24, sr, true); out.setUint32(28, sr * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); w(36, 'data'); out.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, ch[i])) * 32767, true);
    let bin = ''; const u = new Uint8Array(out.buffer); for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    wav = btoa(bin);
  }
  return { clips, hits, wav, probed, slotOrder, rows: (drums.drumMachine.rows || []).map(r => r.name), patterns: (drums.drumMachine.patterns || []).map(p => p.name), song: drums.drumMachine.song };
}
"""



def btn(page, name, exact=False):
    return page.get_by_role("button", name=name, exact=exact).locator("visible=true").first


def close_welcome(page):
    for name in ("C'est parti", "Plus tard"):
        b = btn(page, name, exact=True)
        try:
            if b.is_visible():
                b.click(); page.wait_for_timeout(300)
        except Exception:
            pass


def open_instru(page):
    page.goto(URL, wait_until="domcontentloaded")
    page.get_by_text("Mélodies").first.wait_for(timeout=20000)
    page.get_by_text("Mélodies").first.click()
    page.wait_for_timeout(800)
    page.get_by_role("button", name="Faire une instru").first.click()
    page.wait_for_timeout(1500)
    close_welcome(page)
    page.get_by_text("Batterie").first.wait_for(timeout=45000)
    t = time.time()
    while time.time() - t < 45 and "Chargement" in page.inner_text("body"):
        page.wait_for_timeout(400)
    page.wait_for_timeout(1500)
    close_welcome(page)
    page.evaluate(HOOK)


def step(page, pad, n):
    btn(page, f"{pad}, pas {n}").click()
    page.wait_for_timeout(120)


def render(page, bars, save=None, cands=None, probes=None):
    page.wait_for_timeout(700)
    r = page.evaluate(RENDER, {"bars": bars, "save": bool(save), "cands": cands, "probes": probes})
    if save and r.get("wav"):
        (OUT / save).write_bytes(base64.b64decode(r["wav"]))
    r.pop("wav", None)
    return r


def bpm_of(page):
    return page.evaluate("""async () => { const { audioEngine: e } = await import('/engine/AudioEngine.ts');
      const t = window.__v16.tracks.find(x => x.id === 'track-drums'); return t.drumMachine.bpmUsed; }""")


preuves = {"url": URL, "quand": time.strftime("%Y-%m-%d %H:%M:%S")}
log = qalib.Log("v16_v17")
with sync_playwright() as p:
    b = qalib.launch(p)
    ctx, page = qalib.new_page(b, "pc", log)
    open_instru(page)
    page.screenshot(path=str(OUT / "pc_01_batterie_ouverte.png"))

    # ===== 1. Deux motifs : A (kick sur les temps) puis B (caisse claire 2 et 4) =====
    btn(page, "Vide").click(); page.wait_for_timeout(600)
    bpm = bpm_of(page)
    page.evaluate("(s) => { window.__v16.barSec = s; }", 240 / bpm)
    preuves["bpm_projet"] = bpm
    for n in (1, 5, 9, 13): step(page, "Kick", n)
    btn(page, "Partout", exact=True).click(); page.wait_for_timeout(200)
    page.get_by_role("button", name=re.compile(r"^\W*Motif$")).locator("visible=true").first.click(); page.wait_for_timeout(300)   # nouveau motif B, aussitôt affiché
    for n in (5, 13): step(page, "Snare", n)
    # Peindre les mesures 5 à 8 avec B (glisser le doigt / la souris)
    c5 = page.get_by_role("button", name="Mesure 5 :").first.bounding_box()
    c8 = page.get_by_role("button", name="Mesure 8 :").first.bounding_box()
    page.mouse.move(c5["x"] + 10, c5["y"] + 15); page.mouse.down()
    page.mouse.move(c8["x"] + 10, c8["y"] + 15, steps=10); page.mouse.up()
    page.wait_for_timeout(500)
    page.screenshot(path=str(OUT / "pc_02_motifs_A_B_places.png"))
    r1 = render(page, 8, "export_A_puis_B.wav")
    per_bar = {k: [h for h in r1["hits"] if h["bar"] == k] for k in range(1, 9)}
    preuves["1_deux_motifs"] = {
        "clips_dans_le_morceau": r1["clips"],
        "motifs": r1["patterns"],
        "coups_par_mesure": {k: len(v) for k, v in per_bar.items()},
        "frequence_moyenne_par_mesure_hz": {k: (round(sum(h["hz"] for h in v) / len(v)) if v else None) for k, v in per_bar.items()},
        "positions_en_pas_mesure_1": [h["inBar"] for h in per_bar[1]],
        "positions_en_pas_mesure_5": [h["inBar"] for h in per_bar[5]],
    }
    okA = all(len(per_bar[k]) == 4 for k in (1, 2, 3, 4))
    okB = all(len(per_bar[k]) == 2 for k in (5, 6, 7, 8))
    preuves["1_deux_motifs"]["verdict"] = "OK : 4 coups graves/mesure (A) sur les mesures 1-4, puis 2 coups aigus/mesure (B) sur 5-8" if okA and okB else "ÉCHEC"

    # ===== 2. Sample perso sur un pad (Perc), réglé à l'envers ensuite =====
    btn(page, "Son et mix du pad Perc").click(); page.wait_for_timeout(400)
    page.locator("input[data-nova-pad-file]").first.set_input_files(str(PERSO))
    page.wait_for_timeout(1500)
    for n in (3, 11):
        btn(page, f"sample_perso_3khz, pas {n}").click(); page.wait_for_timeout(120)
    page.screenshot(path=str(OUT / "pc_03_sample_perso_sur_pad.png"))
    PROBES = [{"bar": 5, "step": 2}, {"bar": 5, "step": 10}]
    r2 = render(page, 6, "export_sample_perso.wav", probes=PROBES)
    near_perso = lambda h: h["bar"] == 5 and (abs(h["inBar"] - 2) < 1.2 or abs(h["inBar"] - 10) < 1.2)
    perso = [h for h in r2["hits"] if near_perso(h)]
    btn(page, "Reverse").click(); page.wait_for_timeout(900)
    r3 = render(page, 6, "export_sample_perso_reverse.wav", probes=PROBES)
    preuves["2_sample_perso"] = {
        "pads": r2["rows"],
        "coups_mesure_5": [h for h in r2["hits"] if h["bar"] == 5],
        "coups_du_sample_perso": perso,
        "sonde_a_l_endroit": r2["probed"],
        "sonde_reverse": r3["probed"],
        "verdict": "OK : le son perso (≈3 kHz) joue aux pas 3 et 11 ; réglé « Reverse », sa crête passe en fin de son" if len(perso) == 2 and all(2500 < h["hz"] < 3500 for h in perso) and all(x["peakMs"] < 20 for x in r2["probed"]) and all(x["peakMs"] > 80 and 2500 < x["hz"] < 3500 for x in r3["probed"]) else "À VÉRIFIER",
    }
    btn(page, "Fermer les réglages du pad").click(); page.wait_for_timeout(300)

    # ===== 3. Boucle découpée en 8 tranches, rejouée dans un autre ordre =====
    btn(page, "Découper").click(); page.wait_for_timeout(400)
    page.locator("input[data-nova-chop-file]").first.set_input_files(str(LOOP))
    page.wait_for_timeout(1500)
    page.screenshot(path=str(OUT / "pc_04_decoupe_8_tranches.png"))
    poser = btn(page, "Poser ")
    label = poser.inner_text()
    poser.click(); page.wait_for_timeout(2500)
    btn(page, "Partout", exact=True).click(); page.wait_for_timeout(500)
    r4 = render(page, 2, "export_decoupe_ordre_origine.wav", cands=LOOP_FREQS)
    btn(page, "Remixer").click(); page.wait_for_timeout(600)
    page.screenshot(path=str(OUT / "pc_05_decoupe_remixee.png"))
    r5 = render(page, 2, "export_decoupe_remixee.wav", cands=LOOP_FREQS)

    def nearest(hz):
        return min(LOOP_FREQS, key=lambda f: abs(math.log(max(hz, 1) / f)))
    seq0 = [h["note"] for h in r4["hits"] if h["bar"] == 1]
    seq1 = [h["note"] for h in r5["hits"] if h["bar"] == 1]
    expect1 = [LOOP_FREQS[s - 1] for _, s in r5["slotOrder"]]
    preuves["3_decoupe"] = {
        "bouton": label, "tempo_boucle": LOOP_BPM, "tempo_projet": bpm,
        "pads": r5["rows"], "motifs": r5["patterns"],
        "ordre_origine_mesure_1_hz": seq0, "positions_origine_en_pas": [h["inBar"] for h in r4["hits"] if h["bar"] == 1],
        "ordre_remixe_mesure_1_hz": seq1, "ordre_remixe_attendu_d_apres_le_motif": expect1,
        "tranches_par_pas_apres_remix": r5["slotOrder"], "positions_remixe_en_pas": [h["inBar"] for h in r5["hits"] if h["bar"] == 1],
        "verdict": "OK : 8 tranches rejouées, même ensemble de notes, ordre différent" if seq0 == LOOP_FREQS and seq1 == expect1 and sorted(seq1) == sorted(LOOP_FREQS) and seq1 != seq0 else "À VÉRIFIER",
    }
    # ===== 4. Annuler (Ctrl+Z) : le remix est défait, l'ordre d'origine revient =====
    page.mouse.click(5, 450); page.keyboard.press("Control+z"); page.wait_for_timeout(900)
    r6 = render(page, 1, None, cands=LOOP_FREQS)
    preuves["4_annuler"] = {
        "ordre_apres_ctrl_z": [h["note"] for h in r6["hits"] if h["bar"] == 1],
        "verdict": "OK : Ctrl+Z défait le remix (ordre d'origine)" if r6["slotOrder"] == r4["slotOrder"] and [h["note"] for h in r6["hits"] if h["bar"] == 1] == LOOP_FREQS else "À VÉRIFIER",
    }
    btn(page, "Son et mix du pad Tranche 3").click(); page.wait_for_timeout(600)
    page.screenshot(path=str(OUT / "pc_06_pad_tranche_reglages.png"))
    preuves["erreurs_page"] = log.errors()[:10]
    b.close()

    # ===== Captures tablette et téléphone =====
    for vp in ("tab", "tel"):
        lg = qalib.Log(vp)
        b = qalib.launch(p)
        ctx, page = qalib.new_page(b, vp, lg)
        open_instru(page)
        page.screenshot(path=str(OUT / f"{vp}_01_batterie.png"))
        page.get_by_role("button", name=re.compile(r"^\W*Motif$")).locator("visible=true").first.click(); page.wait_for_timeout(400)
        page.screenshot(path=str(OUT / f"{vp}_02_motif_B.png"))
        try:
            if vp == "tel":
                btn(page, "Écouter Perc").click(); page.wait_for_timeout(200)
                page.locator('button[title="Son et mix du pad choisi"]').first.click()
            else:
                btn(page, "Son et mix du pad Perc").click()
            page.wait_for_timeout(500)
            page.get_by_text("Ton son").first.scroll_into_view_if_needed()
            page.screenshot(path=str(OUT / f"{vp}_03_reglages_sample.png"))
        except Exception as ex:  # noqa
            preuves[f"{vp}_note"] = str(ex)[:200]
        btn(page, "Découper").click(); page.wait_for_timeout(300)
        page.locator("input[data-nova-chop-file]").first.set_input_files(str(LOOP))
        page.wait_for_timeout(1500)
        page.get_by_text("Découper en pads").first.scroll_into_view_if_needed()
        page.screenshot(path=str(OUT / f"{vp}_04_decoupe.png"))
        preuves[f"{vp}_debordements"] = qalib.overflow_report(page)
        preuves[f"{vp}_erreurs"] = lg.errors()[:5]
        b.close()

(OUT / "preuves.json").write_text(json.dumps(preuves, ensure_ascii=False, indent=1), encoding="utf-8")
print(json.dumps({k: (v.get("verdict") if isinstance(v, dict) else v) for k, v in preuves.items()}, ensure_ascii=False, indent=1))
