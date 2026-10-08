"""R9 · Automation des VST : preuves AU NIVEAU DU PONT, avec les vrais plugins du PC,
hors ligne, sans aucune fenêtre (le pont de CE dépôt, port 8776 / 8777).

 1. FabFilter Pro-C 3 — seuil automatisé 0 dB → −30 dB (palier) :
    a. rendu hors ligne (gel / export) : le palier à 2,000 s change le son à l'échantillon près ;
    b. temps réel (blocs de 128, comme le worklet) : palier à 2,0013 s (au milieu d'un bloc)
       → même sortie que le rendu hors ligne (export = lecture, au niveau du pont).
 2. FabFilter Pro-Q 4 — fréquence de la bande 1 (cloche +12 dB) 500 Hz → 4 kHz à 2,000 s.
 3. Charge : 20 réglages de Pro-Q 4 en rampe continue, temps passé dans le pont par bloc,
    avec / sans automation.
 4. Waves (plugin d'un WaveShell, chargé par son nom) : un réglage automatisé en palier.
 5. Écriture Touch simulée : un réglage bougé « dans la fenêtre » (DEBUG_EDITOR_SET, aucune
    fenêtre) est signalé (PARAM_CHANGED, valeur d'avant comprise) ; l'automation reçue ne
    reprend la main qu'après le geste.

<python du pont> qa/r9_pont_direct.py   →  D:\\1 WORK\\CONTENU\\nova-r9-r10\\r9_pont_direct.json
"""
import time
import traceback

import numpy as np

from r9r10_lib import (SR, Bridge, find_plugin, first_divergence, peak_db, pick_port, save, sine, start_bridge,
                       stop_bridge)


def set_and_read(br, slot, items):
    r = br.request({"action": "SET_PARAMS", "slot_id": slot, "params": items})
    return {x["name"]: x for x in r["results"]}


def raw_for(br, slot, name, **kw):
    return float(set_and_read(br, slot, [{"name": name, **kw}])[name]["value"])


def main():
    port = pick_port()
    proc = start_bridge(port)
    res = {"port": port}
    try:
        br = Bridge(port)
        hello = br.request({"action": "HELLO"})
        res["pont"] = {k: hello.get(k) for k in ("version", "automation", "param_watch", "sidechain")}
        plugins = br.request({"action": "GET_PLUGIN_LIST"}, 600)["plugins"]
        res["plugins_vus"] = len(plugins)

        # ── 1. Pro-C 3 ────────────────────────────────────────────────────────────
        pc = find_plugin(plugins, r"^FabFilter Pro-C 3$", r"Pro-C 3")
        r1 = {"plugin": pc and pc["name"]}
        res["pro_c3"] = r1
        if pc:
            sl = "qa-proc3"
            ld = br.request({"action": "LOAD_PLUGIN", "slot_id": sl, "path": pc["path"], "plugin_name": pc.get("plugin_name"),
                             "sample_rate": SR, "quiet": True}, 300)
            r1["latence_ech"] = ld.get("latency_samples")
            rb = set_and_read(br, sl, [{"name": "auto_gain", "text": "Off"}, {"name": "ratio", "real": 20},
                                       {"name": "knee", "real": 0}, {"name": "attack", "value": 0.0},
                                       {"name": "release", "real": 50}, {"name": "lookahead", "real": 0},
                                       {"name": "range", "real": 60}, {"name": "threshold", "real": 0}])
            r1["reglages_relus"] = {k: v.get("text") for k, v in rb.items()}
            t0 = raw_for(br, sl, "threshold", real=0)
            t30 = raw_for(br, sl, "threshold", real=-30)
            raw_for(br, sl, "threshold", real=0)
            r1["seuil_brut"] = {"0 dB": round(t0, 5), "-30 dB": round(t30, 5)}
            auto = br.request({"action": "AUTOMATABLE", "slot_id": sl})["parameters"]
            r1["reglages_automatisables"] = len(auto)
            r1["exemple_reglages"] = [(p["name"], p["display_name"], p["text"]) for p in auto[:6]]
            texts = br.request({"action": "PARAM_TEXTS", "slot_id": sl, "names": ["threshold"], "steps": 4})["texts"]
            r1["textes_seuil_0_25_50_75_100"] = texts.get("threshold")

            x = sine(4, 0.5, 997)
            step = 2 * SR
            meta = {"slot_id": sl, "sample_rate": SR, "tail_seconds": 0}
            ref_hi = br.render({**meta, "automation": [{"name": "threshold", "frames": [0], "values": [t0]}]}, x)
            ref_lo = br.render({**meta, "automation": [{"name": "threshold", "frames": [0], "values": [t30]}]}, x)
            auto_out = br.render({**meta, "automation": [{"name": "threshold", "frames": [0, step], "values": [t0, t30]}]}, x)
            d = first_divergence(auto_out, ref_hi, start=SR // 2)
            r1["export"] = {
                "palier_ecrit_ech": step, "premier_echantillon_change": d,
                "ecart_ech": None if d is None else d - step,
                "avant_db": peak_db(auto_out[0], 1.0, 1.95), "apres_db": peak_db(auto_out[0], 2.5, 3.5),
                "reference_seuil_0_db": peak_db(ref_hi[0], 2.5, 3.5), "reference_seuil_30_db": peak_db(ref_lo[0], 2.5, 3.5),
                "identique_avant_palier": bool(np.max(np.abs(auto_out[:, :step] - ref_hi[:, :step])) < 1e-6),
            }
            # b. temps réel : palier au milieu d'un bloc (2,0013 s), même chose hors ligne.
            fstep = int(np.ceil(2.0013 * SR))
            br.request({"action": "SET_AUTOMATION_MAP", "slot_id": sl, "names": ["threshold"]})
            stream_in = x[:, : (x.shape[1] // 128) * 128]
            ch = {0: [(0, 0, t0)], fstep // 128: [(0, fstep % 128, t30)]}
            live, secs = br.stream(sl, stream_in, ch)
            # Latence du flux (zéros en tête quand le plugin retient des échantillons) : relue sur le pont.
            lat = int(ld.get("latency_samples") or 0)
            off = br.render({**meta, "automation": [{"name": "threshold", "frames": [0, fstep], "values": [t0, t30]}]}, stream_in)
            ref_live = br.render({**meta, "automation": [{"name": "threshold", "frames": [0], "values": [t0]}]}, stream_in)
            live_al = live[:, lat:]
            n = min(live_al.shape[1], off.shape[1])
            diff = np.abs(live_al[:, :n] - off[:, :n])
            dl = first_divergence(live_al, ref_live, start=SR // 2)
            r1["temps_reel"] = {
                "palier_ecrit_ech": fstep, "decalage_dans_le_bloc": fstep % 128, "latence_flux_ech": lat,
                "premier_echantillon_change": dl, "ecart_ech": None if dl is None else dl - fstep,
                "ecart_max_avec_export": float(np.max(diff)), "ecart_max_avec_export_db": round(20 * np.log10(float(np.max(diff)) + 1e-12), 1),
                "blocs": live.shape[1] // 128, "duree_envoi_s": round(secs, 2),
            }
            # 5. Écriture Touch simulée (même plugin).
            r5 = {}
            res["touch_simule"] = r5
            br.request({"action": "WATCH_PARAMS", "slot_id": sl, "on": True})
            time.sleep(0.2)
            t_send = time.time()
            br.request({"action": "DEBUG_EDITOR_SET", "slot_id": sl, "name": "threshold", "value": 0.3})
            ev = br.wait_event("PARAM_CHANGED", 3.0)
            r5["evenement"] = ev and ev[1].get("changes")
            r5["delai_signalement_ms"] = ev and round((ev[0] - t_send) * 1000)
            # L'automation reçue pendant le geste ne reprend pas la main tout de suite.
            br.request({"action": "AUTOMATION_STATS", "slot_id": sl, "reset": True})
            blk = stream_in[:, :128 * 20]
            br.stream(sl, blk, {0: [(0, 0, 0.9)]})
            st1 = br.request({"action": "AUTOMATION_STATS", "slot_id": sl})
            time.sleep(0.6)
            br.stream(sl, blk, {0: [(0, 0, 0.9)]})
            st2 = br.request({"action": "AUTOMATION_STATS", "slot_id": sl})
            r5["pendant_le_geste"] = {"posees": st1["applied"], "laissees_au_geste": st1["skipped"]}
            r5["apres_0_6_s"] = {"posees": st2["applied"], "laissees_au_geste": st2["skipped"]}
            ev2 = br.wait_event("PARAM_CHANGED", 0.5)
            r5["automation_prise_pour_un_geste"] = bool(ev2)
            br.request({"action": "WATCH_PARAMS", "slot_id": sl, "on": False})
            br.request({"action": "UNLOAD_PLUGIN", "slot_id": sl})

        # ── 2. Pro-Q 4 : fréquence d'une bande ───────────────────────────────────
        pq = find_plugin(plugins, r"^FabFilter Pro-Q 4$", r"Pro-Q 4")
        r2 = {"plugin": pq and pq["name"]}
        res["pro_q4"] = r2
        if pq:
            sl = "qa-proq4"
            br.request({"action": "LOAD_PLUGIN", "slot_id": sl, "path": pq["path"], "plugin_name": pq.get("plugin_name"),
                        "sample_rate": SR, "quiet": True}, 300)
            rb = set_and_read(br, sl, [{"name": "band_1_used", "text": "Used"}, {"name": "band_1_enabled", "text": "Enabled"},
                                       {"name": "band_1_shape", "text": "Bell"}, {"name": "band_1_gain", "real": 12},
                                       {"name": "band_1_q", "real": 4}, {"name": "band_1_frequency", "real": 500}])
            r2["reglages_relus"] = {k: v.get("text") for k, v in rb.items()}
            f500 = raw_for(br, sl, "band_1_frequency", real=500)
            f4k = raw_for(br, sl, "band_1_frequency", real=4000)
            raw_for(br, sl, "band_1_frequency", real=500)
            r2["frequence_brute"] = {"500 Hz": round(f500, 5), "4000 Hz": round(f4k, 5)}
            x = sine(4, 0.1, 4000)
            meta = {"slot_id": sl, "sample_rate": SR, "tail_seconds": 0}
            out = br.render({**meta, "automation": [{"name": "band_1_frequency", "frames": [0, 2 * SR], "values": [f500, f4k]}]}, x)
            ref = br.render({**meta, "automation": [{"name": "band_1_frequency", "frames": [0], "values": [f500]}]}, x)
            d = first_divergence(out, ref, start=SR // 2, eps=1e-4)
            r2["export"] = {"palier_ecrit_ech": 2 * SR, "premier_echantillon_change": d, "ecart_ech": None if d is None else d - 2 * SR,
                            "avant_db": peak_db(out[0], 1.0, 1.95), "apres_db": peak_db(out[0], 2.5, 3.5),
                            "attendu": "≈ −20 dB avant (4 kHz hors de la cloche), ≈ −8 dB après (+12 dB)"}

            # ── 3. Charge : 20 réglages en rampe ──────────────────────────────────
            names = [f"band_{b}_{k}" for b in range(1, 11) for k in ("gain", "frequency")][:20]
            br.request({"action": "SET_AUTOMATION_MAP", "slot_id": sl, "names": names})
            noise = (np.random.default_rng(1).standard_normal((2, 10 * SR)) * 0.05).astype(np.float32)
            br.request({"action": "AUTOMATION_STATS", "slot_id": sl, "reset": True})
            _, s0 = br.stream(sl, noise)
            st0 = br.request({"action": "AUTOMATION_STATS", "slot_id": sl})
            nb = noise.shape[1] // 128
            ch = {b: [(i, 0, 0.3 + 0.4 * ((b / nb + i * 0.05) % 1.0)) for i in range(20)] for b in range(nb)}
            br.request({"action": "AUTOMATION_STATS", "slot_id": sl, "reset": True})
            _, s1 = br.stream(sl, noise, ch)
            st1 = br.request({"action": "AUTOMATION_STATS", "slot_id": sl})
            r3 = {"plugin": pq["name"], "reglages_automatises": 20, "blocs": nb,
                  "sans_automation": {"us_par_bloc_dans_le_plugin": st0["avg_block_us"], "duree_aller_retour_s": round(s0, 2)},
                  "avec_20_rampes": {"us_par_bloc_dans_le_plugin": st1["avg_block_us"], "duree_aller_retour_s": round(s1, 2),
                                     "valeurs_posees": st1["applied"]},
                  "budget_bloc_us": round(128 / SR * 1e6, 1),
                  "octets_reglages_par_seconde": 20 * 8 * SR // 128}
            r3["surcout_us_par_bloc"] = round(st1["avg_block_us"] - st0["avg_block_us"], 1)
            res["charge_20_reglages"] = r3
            br.request({"action": "UNLOAD_PLUGIN", "slot_id": sl})

        # ── 4. Waves (WaveShell, chargé par son nom) ─────────────────────────────
        wv = find_plugin(plugins, r"^C1 comp Stereo$", r"^C1 comp", r"^Renaissance Compressor Stereo$", r"^RComp Stereo$",
                         r"^CLA-76 Stereo$", r"^H-Comp Stereo$", r"Comp.*Stereo", shell=True)
        r4 = {"plugin": wv and wv["name"], "fichier": wv and wv.get("path", "").split("\\")[-1]}
        res["waves"] = r4
        if wv:
            sl = "qa-waves"
            try:
                br.request({"action": "LOAD_PLUGIN", "slot_id": sl, "path": wv["path"], "plugin_name": wv.get("plugin_name") or wv["name"],
                            "sample_rate": SR, "quiet": True}, 600)
                auto = br.request({"action": "AUTOMATABLE", "slot_id": sl})["parameters"]
                r4["reglages_automatisables"] = len(auto)
                r4["liste"] = [(p["name"], p["text"]) for p in auto]
                if any(p["name"] == "ratio" for p in auto):
                    rb = set_and_read(br, sl, [{"name": "ratio", "real": 10}])
                    r4["ratio_relu"] = rb["ratio"].get("text")
                thr = next((p for p in auto if "thresh" in p["name"].lower()), None) or next((p for p in auto if "gain" in p["name"].lower()), None)
                r4["reglage"] = thr and (thr["name"], thr["display_name"], thr["text"])
                if thr:
                    x = sine(4, 0.5, 997)
                    meta = {"slot_id": sl, "sample_rate": SR, "tail_seconds": 0}
                    lo, hi = 0.05, 0.95
                    out = br.render({**meta, "automation": [{"name": thr["name"], "frames": [0, 2 * SR], "values": [hi, lo]}]}, x)
                    ref = br.render({**meta, "automation": [{"name": thr["name"], "frames": [0], "values": [hi]}]}, x)
                    d = first_divergence(out, ref, start=SR // 2, eps=1e-4)
                    texts = br.request({"action": "PARAM_TEXTS", "slot_id": sl, "names": [thr["name"]], "steps": 20})["texts"].get(thr["name"]) or []
                    r4["export"] = {"valeurs": [texts[19] if len(texts) > 19 else hi, texts[1] if len(texts) > 1 else lo],
                                    "palier_ecrit_ech": 2 * SR, "premier_echantillon_change": d,
                                    "ecart_ech": None if d is None else d - 2 * SR,
                                    "avant_db": peak_db(out[0], 1.0, 1.95), "apres_db": peak_db(out[0], 2.5, 3.5)}
                br.request({"action": "UNLOAD_PLUGIN", "slot_id": sl})
            except Exception as e:
                r4["erreur"] = str(e)
    except Exception as e:
        res["erreur"] = f"{e}\n{traceback.format_exc()}"
    finally:
        try:
            br.close()
        except Exception:
            pass
        stop_bridge(proc)
    save("r9_pont_direct.json", res)


if __name__ == "__main__":
    main()
