"""Insert ARA (Melodyne / VocAlign en insert sur une piste, comme Pro Tools) par le VRAI pont et le VRAI
hôte NovaARAHost.exe, sans navigateur : le script joue le rôle de NOVA (mêmes trames que le worklet).

  1. LOAD_PLUGIN ara=melodyne → insert chargé (latence annoncée)
  2. ARA_INSERT_SOURCE + ARA_INSERT_DOC → document de la piste ; régions relues dans le plugin
  3. lecture : trames type 1 avec la position du morceau (drapeau TIMELINE) → le clic du fichier,
     placé à 2,000 s sur la timeline, sort à 2,000 s (latence du flux compensée)
  4. déplacer / couper / rogner / supprimer / dupliquer → document à jour, son à jour
  5. réglage global du plugin (Volume) entendu en direct, sans rendu
  6. ARA_INSERT_RENDER (export) identique à la lecture
  7. GET_STATE (archive ARA) puis rechargement : retouches restaurées

Usage : NOVA_BRIDGE_PYTHON=…\\venv\\Scripts\\python.exe python qa/ara_insert_pont.py   (pont lancé sur 8782)
"""
import asyncio, json, os, struct, subprocess, sys, time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get("QA_OUT", r"D:\1 WORK\CONTENU\nova-ara\insert"))
OUT.mkdir(parents=True, exist_ok=True)
PORT = int(os.environ.get("NOVA_TEST_PORT", "8782"))
BRIDGE_PY = Path(os.environ.get("NOVA_BRIDGE_PYTHON", r"D:\1 WORK\CODE\NOVA-STUDIO-DAW-0901-\bridge-python\venv\Scripts\python.exe"))
HOST_EXE = ROOT / "nova-ara-host" / "build" / "NovaARAHost_artefacts" / "Release" / "NovaARAHost.exe"
MEL = r"C:\Program Files\Common Files\VST3\Celemony\Melodyne\Melodyne.vst3"
VOICE = Path(r"D:\1 WORK\CONTENU\nova-ara\melodyne\voix_originale.wav")
SR = 48000
BLOCK = 128
PREBUFFER = 2048          # VST_PREBUFFER_FRAMES du worklet


def read_wav(path):
    sys.path.insert(0, r"D:\1 WORK\CONTENU\nova-ara\scripts")
    import wavio
    x, sr = wavio.read(str(path))
    return x, sr


def source_audio():
    """Fichier de test : silence, clic à 0,500 s, voix à partir de 1,0 s (48 kHz, mono)."""
    x, sr0 = read_wav(VOICE)
    x = x[:, 0]
    if sr0 != SR:
        t = np.arange(int(len(x) * SR / sr0)) / SR
        x = np.interp(t, np.arange(len(x)) / sr0, x).astype(np.float32)
    src = np.zeros(int(SR * 1.0) + len(x), np.float32)
    src[int(0.5 * SR)] = 0.9
    src[int(1.0 * SR):] = x * 0.8
    return src


def render_frame(meta, audio=None):
    j = json.dumps(meta).encode()
    off = (8 + len(j) + 3) & ~3
    head = bytearray(off)
    head[0] = 2
    struct.pack_into("<I", head, 4, len(j))
    head[8:8 + len(j)] = j
    return bytes(head) + (b"" if audio is None else np.ascontiguousarray(audio, "<f4").tobytes())


def parse_render(buf):
    (jl,) = struct.unpack_from("<I", buf, 4)
    meta = json.loads(buf[8:8 + jl])
    off = (8 + jl + 3) & ~3
    return meta, np.frombuffer(buf, "<f4", offset=off)


def audio_frame(slot, seq, block, timeline):
    sid = slot.encode()
    h = (2 + len(sid) + 3) & ~3
    head = bytearray(h + 8)
    head[0] = 1
    head[1] = len(sid)
    head[2:2 + len(sid)] = sid
    n = block.shape[1]
    struct.pack_into("<IHBB", head, h, seq, n, 2, 4)
    return bytes(head) + np.ascontiguousarray(block.T, "<f4").tobytes() + struct.pack("<d", float(timeline))


class Nova:
    """Ce que fait NOVA : requêtes JSON, trames binaires, flux temps réel d'un slot."""

    def __init__(self, ws):
        self.ws = ws
        self.rid = 0
        self.pending = {}
        self.audio = {}
        self.events = []
        self.task = asyncio.create_task(self.reader())

    async def reader(self):
        async for m in self.ws:
            if isinstance(m, bytes):
                if m[0] == 1:
                    L = m[1]
                    h = (2 + L + 3) & ~3
                    seq, n, nch, _f = struct.unpack_from("<IHBB", m, h)
                    self.audio[seq] = np.frombuffer(m, "<f4", count=n * nch, offset=h + 8).reshape(n, nch).T.copy()
                elif m[0] == 2:
                    meta, data = parse_render(m)
                    fut = self.pending.pop(meta.get("req_id"), None)
                    if fut:
                        fut.set_result((meta, data))
                continue
            d = json.loads(m)
            if d.get("action") == "ARA_EVENT":
                self.events.append(d)
            fut = self.pending.pop(d.get("req_id"), None)
            if fut:
                fut.set_result(d)

    async def req(self, action, timeout=300, frame_audio=None, binary=False, **kw):
        self.rid += 1
        fut = asyncio.get_running_loop().create_future()
        self.pending[self.rid] = fut
        msg = {"action": action, "req_id": self.rid, **kw}
        await self.ws.send(render_frame(msg, frame_audio) if binary else json.dumps(msg))
        return await asyncio.wait_for(fut, timeout)

    async def play(self, slot, t0, t1, inp=None):
        """Lecture de t0 à t1 (s) : un bloc de 128 par trame, position = temps du morceau de l'ENTRÉE
        (comme le worklet : sortie à t ⇔ morceau t − origine, entrée en avance de la latence du flux)."""
        self.audio.clear()
        n0 = int(t0 * SR)
        nb = int((t1 - t0) * SR) // BLOCK
        for i in range(nb):
            pos = n0 + i * BLOCK
            blk = np.zeros((2, BLOCK), np.float32) if inp is None else inp(pos)
            # Comme le worklet : pas plus de blocs en vol que le pré-tampon (le pont jette au-delà de 64).
            t = time.time()
            while i - len(self.audio) >= PREBUFFER // BLOCK and time.time() - t < 10:
                await asyncio.sleep(0.001)
            await self.ws.send(audio_frame(slot, i, blk, pos))
        t = time.time()
        while len(self.audio) < nb and time.time() - t < 60:
            await asyncio.sleep(0.05)
        return np.concatenate([self.audio.get(i, np.zeros((2, BLOCK), np.float32)) for i in range(nb)], axis=1)


def click_time(y, t0, thr=0.3):
    a = np.abs(y[0])
    i = int(np.argmax(a > thr))
    return round(t0 + i / SR, 6) if a.max() > thr else None


async def scenario(rep):
    import websockets
    async with websockets.connect(f"ws://127.0.0.1:{PORT}", max_size=1 << 30) as ws:
        nova = Nova(ws)
        hello = await nova.req("HELLO")
        rep["hello"] = {k: hello.get(k) for k in ("version", "ara", "ara_insert")}
        slot = "ara-test-voix"
        t = time.time()
        ld = await nova.req("LOAD_PLUGIN", slot_id=slot, path=MEL, sample_rate=SR, ara="melodyne")
        rep["load"] = {k: ld.get(k) for k in ("success", "name", "latency_samples", "ara", "error")}
        rep["load_s"] = round(time.time() - t, 1)
        src = source_audio()
        dur = len(src) / SR
        doc = lambda regions, **kw: nova.req("ARA_INSERT_DOC", slot_id=slot, sources=[{"id": "buf-voix", "name": "Voix"}],
                                             regions=regions, track={"name": "Voix lead"}, bpm=95,
                                             tempo=[{"t": 0, "q": 0}, {"t": 4 * 60 / 95, "q": 4}],
                                             signatures=[{"q": 0, "num": 4, "den": 4}], **kw)
        r0 = await doc([{"id": "c1", "source": "buf-voix", "name": "Voix", "offset": 0, "start": 1.5, "duration": dur}])
        rep["doc_sans_son"] = r0
        up = await nova.req("ARA_INSERT_SOURCE", binary=True, frame_audio=src, slot_id=slot, id="buf-voix", name="Voix",
                            sample_rate=SR, nch=1, nframes=len(src))
        rep["source"] = up
        r1 = await doc([{"id": "c1", "source": "buf-voix", "name": "Voix", "offset": 0, "start": 1.5, "duration": dur}])
        rep["doc1"] = r1
        st = await nova.req("ARA_INSERT_STATE", slot_id=slot, wait_analysis_s=90, timeout=200)
        rep["regions1"] = [{"id": r["id"], "start": r["start"], "notes": len(r["notes"]), "1re_note_s": r["notes"][0][3] if r["notes"] else None} for r in st["regions"]]

        lat = (ld.get("latency_samples") or 0)
        # Le pont ne connaît pas le pré-tampon du worklet : ici, position = morceau de l'entrée = sortie.
        y = await nova.play(slot, 0, 3.0)
        rep["clic_attendu_s"] = 2.0
        rep["clic_lecture_s"] = click_time(y, 0) if lat == 0 else round(click_time(y, 0) - lat / SR, 6)
        noise = lambda pos: (np.sin(np.arange(pos, pos + BLOCK) * 0.05)[None, :].repeat(2, 0) * 0.3).astype(np.float32)
        yn = await nova.play(slot, 0, 3.0, noise)
        rep["entree_ignoree_ecart_max"] = float(np.max(np.abs(yn - y)))

        # Éditions NOVA → document ARA à jour (régions relues dans le plugin, son au bon endroit).
        edits = {
            "deplacer_+1s": [{"id": "c1", "source": "buf-voix", "name": "Voix", "offset": 0, "start": 2.5, "duration": dur}],
            "couper_a_4s": [{"id": "c1", "source": "buf-voix", "name": "Voix", "offset": 0, "start": 2.5, "duration": 1.5},
                            {"id": "c1b", "source": "buf-voix", "name": "Voix", "offset": 1.5, "start": 4.0, "duration": dur - 1.5}],
            "rogner_debut_c1": [{"id": "c1", "source": "buf-voix", "name": "Voix", "offset": 0.8, "start": 3.3, "duration": 0.7},
                                {"id": "c1b", "source": "buf-voix", "name": "Voix", "offset": 1.5, "start": 4.0, "duration": dur - 1.5}],
            "dupliquer_c1b": [{"id": "c1", "source": "buf-voix", "name": "Voix", "offset": 0.8, "start": 3.3, "duration": 0.7},
                              {"id": "c1b", "source": "buf-voix", "name": "Voix", "offset": 1.5, "start": 4.0, "duration": dur - 1.5},
                              {"id": "c1c", "source": "buf-voix", "name": "Voix", "offset": 1.5, "start": 4.0 + dur, "duration": dur - 1.5}],
            "supprimer_c1": [{"id": "c1b", "source": "buf-voix", "name": "Voix", "offset": 1.5, "start": 4.0, "duration": dur - 1.5},
                             {"id": "c1c", "source": "buf-voix", "name": "Voix", "offset": 1.5, "start": 4.0 + dur, "duration": dur - 1.5}],
        }
        rep["editions"] = {}
        for name, regions in edits.items():
            r = await doc(regions)
            st = await nova.req("ARA_INSERT_STATE", slot_id=slot, timeout=120)
            rep["editions"][name] = {"doc": {k: r.get(k) for k in ("added", "removed", "updated")},
                                     "regions_vues_par_le_plugin": [{"id": x["id"], "start": x["start"], "offset": x["offset"], "duration": round(x["duration"], 3),
                                                                     "notes": len(x["notes"]), "1re_note_s": round(x["notes"][0][3], 3) if x["notes"] else None}
                                                                    for x in st["regions"]]}
            if name == "deplacer_+1s":
                y2 = await nova.play(slot, 0, 4.0)
                rep["editions"][name]["clic_lecture_s"] = click_time(y2, 0)
        # Retour au clip entier pour la suite.
        await doc([{"id": "c1", "source": "buf-voix", "name": "Voix", "offset": 0, "start": 1.5, "duration": dur}])

        # Réglage global du plugin (Volume) : entendu en direct, sans rendu.
        ref = await nova.play(slot, 0, 3.0)
        pr = await nova.req("ARA_INSERT_PARAMS", slot_id=slot)
        rep["reglages"] = [(p["title"], p["text"]) for p in pr["params"]]
        sp = await nova.req("ARA_INSERT_PARAM", slot_id=slot, title="Volume", value=0.2)
        await asyncio.sleep(0.5)
        await nova.play(slot, 0, 0.2)
        yv = await nova.play(slot, 0, 3.0)
        rep["volume_en_direct"] = {"reglage": sp.get("text"), "clic_avant": float(np.max(np.abs(ref[0]))), "clic_apres": float(np.max(np.abs(yv[0]))),
                                   "ecart_db": round(20 * np.log10(max(1e-9, float(np.max(np.abs(yv[0])))) / float(np.max(np.abs(ref[0])))), 2)}

        # Export : rendu hors ligne de la piste, identique à la lecture.
        meta, data = await nova.req("ARA_INSERT_RENDER", slot_id=slot, start=0, duration=3.0, sample_rate=SR, timeout=600)
        z = data[: meta["nframes"] * meta["nch"]].reshape(meta["nframes"], meta["nch"]).T
        n = min(z.shape[1], yv.shape[1])
        rep["export"] = {"clic_s": click_time(z, 0), "ecart_max_avec_lecture": float(np.max(np.abs(z[:, :n] - yv[:, :n]))), "frames": meta["nframes"]}

        # Archive ARA (retouches) puis rechargement : restaurée.
        stt = await nova.req("GET_STATE", slot_id=slot)
        arc = stt.get("state") or ""
        rep["archive_octets"] = len(arc) * 3 // 4
        await nova.req("UNLOAD_PLUGIN", slot_id=slot)
        await asyncio.sleep(1.0)
        ld2 = await nova.req("LOAD_PLUGIN", slot_id=slot + "-2", path=MEL, sample_rate=SR, ara="melodyne", state=arc)
        await nova.req("ARA_INSERT_SOURCE", binary=True, frame_audio=src, slot_id=slot + "-2", id="buf-voix", name="Voix",
                       sample_rate=SR, nch=1, nframes=len(src))
        r2 = await nova.req("ARA_INSERT_DOC", slot_id=slot + "-2", sources=[{"id": "buf-voix", "name": "Voix"}],
                            regions=[{"id": "c1", "source": "buf-voix", "name": "Voix", "offset": 0, "start": 1.5, "duration": dur}],
                            track={"name": "Voix lead"}, bpm=95)
        rep["rechargement"] = {"load": ld2.get("success"), "restaure": r2.get("restored")}
        y3 = await nova.play(slot + "-2", 0, 3.0)
        rep["rechargement"]["volume_garde_db"] = round(20 * np.log10(max(1e-9, float(np.max(np.abs(y3[0])))) / float(np.max(np.abs(ref[0])))), 2)
        await nova.req("UNLOAD_PLUGIN", slot_id=slot + "-2")
        rep["evenements"] = sorted({e.get("event") for e in nova.events})
        nova.task.cancel()


VA = r"C:\Program Files\Common Files\VST3\VocAlign6Standard.vst3"
DUB = Path(r"D:\1 WORK\CONTENU\nova-ara\vocalign\double_decale.wav")


def resample(x, sr0):
    if sr0 == SR:
        return x.astype(np.float32)
    t = np.arange(int(len(x) * SR / sr0)) / SR
    return np.interp(t, np.arange(len(x)) / sr0, x).astype(np.float32)


def envelope(y, hop=0.005):
    h = int(hop * SR)
    n = len(y) // h
    e = np.sqrt((y[: n * h].reshape(n, h) ** 2).mean(1))
    return np.log10(e + 1e-4)


def local_lag(g, d, win=0.5, maxlag=0.12, hop=0.005):
    """Retard local guide ↔ double sur l'ENVELOPPE (fenêtres de 0,5 s), comme mesure_calage.py."""
    eg, ed = envelope(g, hop), envelope(d, hop)
    W, L = int(win / hop), int(maxlag / hop)
    lags = []
    for s in range(L, len(eg) - W - L, W // 2):
        a = eg[s:s + W] - eg[s:s + W].mean()
        if a.std() < 0.15:
            continue
        cs = [float(np.dot(a, ed[s + l:s + l + W] - ed[s + l:s + l + W].mean())) for l in range(-L, L + 1)]
        lags.append((int(np.argmax(cs)) - L) * hop * 1000)
    lags = np.abs(np.array(lags))
    return {"fenetres": int(len(lags)), "moyen_abs_ms": round(float(lags.mean()), 1), "max_abs_ms": round(float(lags.max()), 1)} if len(lags) else {}


async def scenario_vocalign(rep):
    """VocAlign en insert sur la piste du double, guide = la lead (capture transparente)."""
    import websockets
    async with websockets.connect(f"ws://127.0.0.1:{PORT}", max_size=1 << 30) as ws:
        nova = Nova(ws)
        slot = "ara-test-double"
        ld = await nova.req("LOAD_PLUGIN", slot_id=slot, path=VA, sample_rate=SR, ara="vocalign")
        rep["load"] = {k: ld.get(k) for k in ("success", "name", "latency_samples", "ara", "error")}
        lead, sr0 = read_wav(VOICE)
        dub, sr1 = read_wav(DUB)
        lead, dub = resample(lead[:, 0], sr0), resample(dub[:, 0], sr1)
        for sid, a in (("buf-lead", lead), ("buf-double", dub)):
            await nova.req("ARA_INSERT_SOURCE", binary=True, frame_audio=a, slot_id=slot, id=sid, name=sid, sample_rate=SR, nch=1, nframes=len(a))
        start = 2.0
        r = await nova.req("ARA_INSERT_DOC", slot_id=slot, sources=[{"id": "buf-double", "name": "Double"}],
                           regions=[{"id": "c-dbl", "source": "buf-double", "name": "Double", "offset": 0, "start": start, "duration": len(dub) / SR}],
                           track={"name": "Double"}, bpm=95,
                           guide={"sources": [{"id": "buf-lead", "name": "Lead"}],
                                  "regions": [{"id": "c-lead", "source": "buf-lead", "name": "Lead", "offset": 0, "start": start, "duration": len(lead) / SR}]})
        rep["doc"] = {k: r.get(k) for k in ("applied", "capture", "missing")}
        # Avant la fin de la capture : la piste joue son double tel quel (le son reçu de NOVA).
        t0 = time.time()
        st = {}
        while time.time() - t0 < 300:
            st = await nova.req("ARA_INSERT_CAPTURE", slot_id=slot)
            if st.get("state") in ("done", "error"):
                break
            await asyncio.sleep(1)
        rep["capture"] = {k: st.get(k) for k in ("state", "error", "seconds", "aligned_s", "aligned_start_s")}
        rep["capture_attente_s"] = round(time.time() - t0, 1)
        end = start + len(dub) / SR + 0.5
        y = await nova.play(slot, 0, end)
        a, b = int(start * SR), int(start * SR) + len(lead)
        guide = np.zeros(y.shape[1], np.float32)
        guide[a:min(b, len(guide))] = lead[: min(b, len(guide)) - a]
        dub_on_tl = np.zeros(y.shape[1], np.float32)
        dub_on_tl[a:min(a + len(dub), len(guide))] = dub[: min(a + len(dub), len(guide)) - a]
        rep["calage"] = {"double_avant": local_lag(guide, dub_on_tl), "double_cale_sur_la_piste": local_lag(guide, y[0])}
        meta, data = await nova.req("ARA_INSERT_RENDER", slot_id=slot, start=0, duration=end, sample_rate=SR, timeout=600)
        z = data[: meta["nframes"] * meta["nch"]].reshape(meta["nframes"], meta["nch"]).T
        n = min(z.shape[1], y.shape[1])
        rep["export_ecart_max_avec_lecture"] = float(np.max(np.abs(z[:, :n] - y[:, :n])))
        try:
            snap = OUT / "vocalign_insert_fenetre.png"
            await nova.req("ARA_INSERT_SNAPSHOT", slot_id=slot, path=str(snap))
            rep["fenetre"] = str(snap)
        except Exception as e:
            rep["fenetre"] = f"pas de capture : {e}"
        await nova.req("UNLOAD_PLUGIN", slot_id=slot)
        nova.task.cancel()


def main():
    env = dict(os.environ, NOVA_BRIDGE_PORT=str(PORT), NOVA_ARA_HOST=str(HOST_EXE), PYTHONIOENCODING="utf-8")
    if "vocalign" in sys.argv[1:]:
        global scenario
        scenario = scenario_vocalign
    log = open(OUT / f"pont-{PORT}.log", "w", encoding="utf-8")
    p = subprocess.Popen([str(BRIDGE_PY), "nova_bridge_server.py"], cwd=str(ROOT / "bridge-python"), env=env,
                         stdout=log, stderr=subprocess.STDOUT, creationflags=0x08000000)
    rep = {}
    try:
        import socket
        for _ in range(240):
            try:
                socket.create_connection(("127.0.0.1", PORT), 0.5).close()
                break
            except OSError:
                time.sleep(0.5)
        asyncio.run(scenario(rep))
    finally:
        subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True, creationflags=0x08000000)
        (OUT / ("ara_insert_vocalign.json" if "vocalign" in sys.argv[1:] else "ara_insert_pont.json")).write_text(json.dumps(rep, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
        print(json.dumps(rep, ensure_ascii=False, indent=1, default=str)[:8000])


if __name__ == "__main__":
    main()
