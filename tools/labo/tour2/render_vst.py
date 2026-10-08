"""Rend les jeux du tour 2 avec le VST d'origine (hors ligne, sans fenêtre).
Usage : pythonw -m tour2.render_vst <banc>  -> <labo>/<id>/tour2/vst/<nom>__<sig>.npy"""
import os, sys, time, json
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import bench, host, procs  # noqa
from tour2.common import banc_mod, LABO
from tour2.sets import sets, SIG


def load_sig(sig, rms):
    path, off, sec = SIG[sig]
    return bench.load_audio(path, sec, off, rms)


def main(bn):
    host.hide_console()
    banc = banc_mod(bn)
    out = os.path.join(LABO, banc.ID, "tour2", "vst")
    os.makedirs(out, exist_ok=True)
    log = open(os.path.join(out, "render.log"), "a", encoding="utf-8")
    proc = procs.VstProc(banc.PLUGIN, banc.BASE)
    for e in sets(bn):
        fn = os.path.join(out, f"{e['name']}__{e['sig']}.npy")
        if os.path.exists(fn):
            continue
        t = time.time()
        applied = proc.configure(e["settings"])
        x = load_sig(e["sig"], e["rms_db"])
        y = proc.run(x)
        np.save(fn, y.astype(np.float32))
        log.write(f"{time.strftime('%H:%M:%S')} {e['name']} {e['sig']} {time.time() - t:.1f}s {json.dumps(applied, ensure_ascii=False)[:300]}\n")
        log.flush()
    log.write("FIN\n")
    log.close()


if __name__ == "__main__":
    main(sys.argv[1])
