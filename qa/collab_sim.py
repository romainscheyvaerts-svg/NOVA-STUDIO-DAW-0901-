"""Simulateurs partagés par les scénarios de collaboration (aucune écriture réelle).

- FakeNovaCloud : la fonction daw-session (sessions en ligne, journal des
  opérations, audio en morceaux SHA-1), avec des pannes à la demande
  (un navigateur « hors ligne », réponses perdues).
- FakeRealtime : le serveur Supabase Realtime (protocole Phoenix, vsn 1.0.0) :
  canaux, diffusion (broadcast) et présence entre les navigateurs ; coupure
  d'un navigateur à la demande (le client Supabase se reconnecte tout seul).
- FakeBridgeV7 : pont VST du PC de l'artiste (v7 : réglages par texte). Le
  « plugin » de test applique un compresseur + un gain de sortie (réglage
  « Output », en dB) : un réglage fait à distance s'entend dans le rendu.

Tout passe par les routes de Playwright : rien ne sort vers Supabase.
"""
import base64, json, random, re, string, time

import numpy as np

from gel_pre_effet import FakeBridge  # noqa

SUPA = "https://mxdrxpzxbgybchzzvpkf.supabase.co"
STORE = "https://fake-storage.test"


def _id(n, alphabet=string.ascii_lowercase + string.digits):
    return "".join(random.choice(alphabet) for _ in range(n))


class FakeNovaCloud:
    """daw-session simulée : sessions (manifeste + version), membres, journal, morceaux audio."""

    def __init__(self, per_device=False, codes=False):
        # per_device / codes : la fonction avec le patch « Feat à distance »
        # (clé de membre par appareil, codes d'invitation) ; sinon la fonction en ligne.
        self.per_device = per_device
        self.codes = codes
        self.invites = {}
        self.sessions = {}
        self.members = {}
        self.ops = []
        self.seq = 7000
        self.parts = {}
        self.log = []
        self.down = set()  # navigateurs « hors ligne » (leurs appels échouent)

    @staticmethod
    def cors():
        return {"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*"}

    def handler(self, tag):
        def h(route, request):
            if request.method == "OPTIONS":
                return route.fulfill(status=204, headers=self.cors())
            if tag in self.down:
                self.log.append((tag, "HORS LIGNE"))
                return route.abort("internetdisconnected")
            try:
                body = json.loads(request.post_data or "{}")
            except Exception:
                body = {}
            a = body.get("action")
            self.log.append((tag, a))
            try:
                out = self.act(a, body, request)
                route.fulfill(status=200, content_type="application/json", headers=self.cors(), body=json.dumps(out))
            except Exception as e:  # noqa
                route.fulfill(status=400, content_type="application/json", headers=self.cors(), body=json.dumps({"error": str(e)}))
        return h

    def _user(self, request):
        auth = request.headers.get("authorization", "")
        tok = auth.replace("Bearer ", "")
        try:
            payload = json.loads(base64.urlsafe_b64decode(tok.split(".")[1] + "=="))
            return payload.get("sub")
        except Exception:
            return None

    def act(self, a, b, request):
        if a == "resolve_code":
            if not self.codes:
                raise RuntimeError("Action inconnue")
            if not self._user(request):
                raise RuntimeError("Connecte-toi à ton compte Make Music pour collaborer")
            inv = self.invites.get(str(b.get("code") or "").upper().replace(" ", ""))
            if not inv or inv["exp"] < time.time():
                raise RuntimeError("Code introuvable ou expiré")
            s = self.sessions[inv["sid"]]
            return {"link": f"{inv['sid']}.{s['secret']}", "name": s["name"]}
        if a == "create":
            sid = _id(12)
            self.sessions[sid] = {"secret": _id(32, string.ascii_letters + "23456789"), "name": b.get("name"), "version": 0, "manifest": None,
                                  "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"), "updated_from": b.get("device")}
            return {"id": sid, "secret": self.sessions[sid]["secret"], "version": 0, "owned": True}
        sid = b.get("id")
        s = self.sessions.get(sid)
        if not s or s["secret"] != b.get("secret"):
            raise RuntimeError("Session introuvable")
        uid = self._user(request)
        dev = re.sub(r"[^a-zA-Z0-9_-]", "", str(b.get("device_id") or ""))[:40]
        if self.per_device:
            key = (f"u:{uid}:{dev}" if dev else f"u:{uid}") if uid else "d:" + dev
        else:
            key = f"u:{uid}" if uid else "d:" + str(b.get("device_id") or "")
        if a == "invite_code":
            if not self.codes:
                raise RuntimeError("Action inconnue")
            for c, inv in self.invites.items():
                if inv["sid"] == sid and inv["exp"] > time.time() + 3600:
                    return {"code": c, "expires_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(inv["exp"]))}
            c = "".join(random.choice("ABCDEFGHJKMNPQRSTUVWXYZ23456789") for _ in range(6))
            self.invites[c] = {"sid": sid, "exp": time.time() + 86400}
            return {"code": c, "expires_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(self.invites[c]["exp"]))}
        if a == "sign_upload":
            return {"uploads": {p: {"path": f"daw-sessions/{sid}/{p}", "token": "tok"} for p in b.get("parts", []) if p not in self.parts}}
        if a == "commit":
            if not b.get("force") and int(b.get("baseVersion") or 0) != s["version"]:
                raise RuntimeError("La session a été modifiée ailleurs")
            missing = [p for f in (b["manifest"].get("files") or {}).values() for p in f.get("parts", []) if p not in self.parts]
            if missing:
                raise RuntimeError(f"Audio manquant ({len(missing)})")
            s["version"] += 1
            s["manifest"] = b["manifest"]
            s["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ")
            return {"version": s["version"]}
        if a == "get":
            m = s["manifest"]
            parts = [p for f in ((m or {}).get("files") or {}).values() for p in f.get("parts", [])]
            return {"id": sid, "link": f"{sid}.{s['secret']}", "owned": True, "has_owner": True, "name": s["name"], "version": s["version"],
                    "updated_at": s["updated_at"], "updated_from": s["updated_from"], "manifest": m, "urls": {p: f"{STORE}/{p}" for p in parts}}
        if a == "info":
            return {"id": sid, "link": f"{sid}.{s['secret']}", "name": s["name"], "version": s["version"], "updated_at": s["updated_at"], "updated_from": s["updated_from"]}
        if a == "join":
            self.members[(sid, key)] = {"role": b.get("role"), "name": b.get("name")}
            mem = [{"member_key": k[1], "role": v["role"], "display_name": v["name"]} for k, v in self.members.items() if k[0] == sid]
            last = max([o["seq"] for o in self.ops if o["sid"] == sid] or [0])
            return {"member_key": key, "last_seq": last, "members": mem, "channel": f"nova-collab-{sid}-test"}
        if a == "op":
            m = self.members.get((sid, key))
            if not m and self.per_device and uid and (sid, f"u:{uid}") in self.members:
                key = f"u:{uid}"  # rejoint avant la mise à jour de la fonction
                m = self.members.get((sid, key))
            if not m:
                raise RuntimeError("Rejoins d'abord la session")
            self.seq += 1
            o = {"seq": self.seq, "sid": sid, "member_key": key, "role": m["role"], "author_name": m["name"], "kind": b.get("kind"), "op": b.get("op"),
                 "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"), "t": time.time()}
            self.ops.append(o)
            return {"seq": o["seq"], "created_at": o["created_at"], "role": m["role"], "author_name": m["name"], "member_key": key}
        if a == "ops_since":
            after = int(b.get("after") or 0)
            ops = [{k: v for k, v in o.items() if k not in ("sid", "t")} for o in self.ops if o["sid"] == sid and o["seq"] > after][:500]
            return {"ops": ops}
        if a == "urls":
            return {"urls": {p: f"{STORE}/{p}" for p in b.get("parts", []) if p in self.parts}}
        if a == "members":
            return {"members": [{"member_key": k[1], "role": v["role"], "display_name": v["name"]} for k, v in self.members.items() if k[0] == sid]}
        raise RuntimeError(f"Action inconnue {a}")

    def upload(self, route, request):
        if request.method == "OPTIONS":
            return route.fulfill(status=204, headers=self.cors())
        name = request.url.split("?")[0].rstrip("/").split("/")[-1]
        data = request.post_data_buffer or b""
        ctype = request.headers.get("content-type", "")
        if ctype.startswith("multipart/form-data"):
            boundary = ctype.split("boundary=")[-1].encode()
            for part in data.split(b"--" + boundary):
                if b"\r\n\r\n" not in part:
                    continue
                head, payload = part.split(b"\r\n\r\n", 1)
                if b"filename" in head or b"octet-stream" in head:
                    data = payload[:-2] if payload.endswith(b"\r\n") else payload
                    break
        self.parts[name] = data
        route.fulfill(status=200, content_type="application/json", headers=self.cors(), body=json.dumps({"Key": f"daw-sessions/{name}"}))

    def download(self, route, request):
        name = request.url.split("?")[0].rstrip("/").split("/")[-1]
        data = self.parts.get(name)
        if data is None:
            return route.fulfill(status=404, body="absent")
        route.fulfill(status=200, headers={"content-type": "application/octet-stream", "access-control-allow-origin": "*"}, body=data)

    def ops_of(self, kind, sid=None):
        return [o for o in self.ops if o["kind"] == kind and (sid is None or o["sid"] == sid)]


class FakeRealtime:
    """Serveur Realtime simulé (Phoenix, JSON vsn 1.0.0) partagé par les navigateurs."""

    def __init__(self):
        self.socks = []
        self.presence = {}  # topic -> key -> {"meta": {...}, "sock": s}
        self.blocked = set()
        self.log = []

    def handler(self, tag):
        def h(ws):
            # Jamais d'appel bloquant (ws.close) dans un gestionnaire Playwright : il fige le
            # scénario. Hors ligne = le serveur ne répond pas (la page réessaie toute seule).
            s = {"ws": ws, "tag": tag, "topics": {}, "open": True}
            self.socks.append(s)
            self.log.append((tag, "connexion"))
            ws.on_message(lambda m: self.on_message(s, m))
            # Pas de ws.on_close : Playwright (1.5x) plante quand la page ferme sans code
            # (KeyError 'code'). Les sockets fermées côté page sont oubliées au prochain envoi.
        return h

    @staticmethod
    def _send(s, msg):
        if not s["open"]:
            return
        try:
            s["ws"].send(json.dumps(msg))
        except Exception:
            s["open"] = False

    def _reply(self, s, msg, response=None):
        self._send(s, {"topic": msg.get("topic"), "event": "phx_reply", "payload": {"status": "ok", "response": response or {}},
                       "ref": msg.get("ref"), "join_ref": msg.get("join_ref")})

    def _diff(self, topic, joins, leaves):
        for o in self.socks:
            if topic in o["topics"]:
                self._send(o, {"topic": topic, "event": "presence_diff", "payload": {"joins": joins, "leaves": leaves}, "ref": None})

    def on_message(self, s, m):
        if isinstance(m, (bytes, bytearray)):
            return
        try:
            msg = json.loads(m)
        except Exception:
            return
        if isinstance(msg, list):  # sérialiseur 2.0.0 : [join_ref, ref, topic, event, payload]
            msg = {"join_ref": msg[0], "ref": msg[1], "topic": msg[2], "event": msg[3], "payload": msg[4]}
        topic, event, payload = msg.get("topic"), msg.get("event"), msg.get("payload") or {}
        if topic == "phoenix":
            return self._reply(s, msg)
        if s["tag"] in self.blocked:
            # Direct indisponible : le canal est refusé (la page réessaie toute seule).
            self.log.append((s["tag"], f"refusé ({event})"))
            if event == "phx_join":
                self._send(s, {"topic": topic, "event": "phx_reply", "payload": {"status": "error", "response": {"reason": "indisponible (simulé)"}},
                               "ref": msg.get("ref"), "join_ref": msg.get("join_ref")})
            return
        if event == "phx_join":
            key = ((payload.get("config") or {}).get("presence") or {}).get("key") or ""
            s["topics"][topic] = {"key": key, "join_ref": msg.get("join_ref") or msg.get("ref")}
            self.log.append((s["tag"], f"rejoint {topic}"))
            self._reply(s, msg, {"postgres_changes": []})
            state = {k: {"metas": [v["meta"]]} for k, v in self.presence.get(topic, {}).items()}
            self._send(s, {"topic": topic, "event": "presence_state", "payload": state, "ref": None})
            return
        if event == "phx_leave":
            self._leave(s, topic)
            return self._reply(s, msg)
        if event == "presence":
            info = s["topics"].get(topic)
            if info is not None and payload.get("event") == "track":
                meta = {**(payload.get("payload") or {}), "phx_ref": _id(8)}
                old = self.presence.setdefault(topic, {}).get(info["key"])
                self.presence[topic][info["key"]] = {"meta": meta, "sock": s}
                self._diff(topic, {info["key"]: {"metas": [meta]}}, {info["key"]: {"metas": [old["meta"]]}} if old else {})
            elif info is not None and payload.get("event") == "untrack":
                self._leave_presence(s, topic)
            return self._reply(s, msg)
        if event == "broadcast":
            for o in self.socks:
                if o is not s and topic in o["topics"]:
                    self._send(o, {"topic": topic, "event": "broadcast", "payload": payload, "ref": None})
            if msg.get("ref"):
                self._reply(s, msg)
            return
        if msg.get("ref"):
            self._reply(s, msg)

    def _leave_presence(self, s, topic):
        info = s["topics"].get(topic)
        cur = self.presence.get(topic, {}).get(info["key"]) if info else None
        if cur and cur["sock"] is s:
            del self.presence[topic][info["key"]]
            self._diff(topic, {}, {info["key"]: {"metas": [cur["meta"]]}})

    def _leave(self, s, topic):
        if topic in s["topics"]:
            self._leave_presence(s, topic)
            del s["topics"][topic]

    def on_close(self, s):
        if s not in self.socks:
            return
        s["open"] = False
        for topic in list(s["topics"]):
            self._leave(s, topic)
        self.socks.remove(s)
        self.log.append((s["tag"], "déconnexion"))

    def drop(self, tag):
        """Coupe le direct d'un navigateur (le client Supabase se reconnecte tout seul)."""
        for s in [x for x in self.socks if x["tag"] == tag]:
            self.on_close(s)
            try:
                s["ws"].close(code=4000, reason="coupure simulée")
            except Exception:
                pass

    def online(self, tag):
        return any(s["tag"] == tag and s["topics"] for s in self.socks)


class FakeBridgeV7(FakeBridge):
    """Pont VST v7 (réglages par texte) : chargement en direct, réglages, rendu avec le gain réglé."""

    def __init__(self, installed=None):
        super().__init__(*([installed] if installed else []))
        self.slots = {}
        self.sets = []

    @staticmethod
    def _db(text_or_real):
        try:
            if isinstance(text_or_real, (int, float)):
                return float(text_or_real)
            return float(re.findall(r"-?\d+(?:[.,]\d+)?", str(text_or_real))[0].replace(",", "."))
        except Exception:
            return None

    def handler(self, ws):
        self.ws = ws
        super().handler(ws)

    def close(self):
        """Le pont se ferme (NOVA Studio quitté sur le PC de l'artiste)."""
        try:
            self.ws.close()
        except Exception:
            pass

    def _params(self, slot):
        db = self.slots.get(slot, {}).get("output", 0.0)
        return [{"name": "output", "display_name": "Output", "value": (db + 24) / 48, "text": f"{db:.1f} dB"},
                {"name": "ratio", "display_name": "Ratio", "value": 0.4, "text": "4.0:1"}]

    def _state(self, slot):
        return base64.b64encode(json.dumps({"output": self.slots.get(slot, {}).get("output", 0.0)}).encode()).decode()

    def on_message(self, ws, m):
        if isinstance(m, (bytes, bytearray)):
            self.on_binary(ws, bytes(m)); return
        try:
            req = json.loads(m)
        except Exception:
            return
        act = req.get("action"); rid = req.get("req_id"); slot = req.get("slot_id")
        self.requests.append(act)
        if act in ("HELLO", "PING"):
            ws.send(json.dumps({"req_id": rid, "success": True, "version": 7, "binary_audio": True, "render": True, "params_text": True,
                                "editor": False, "pedalboard": True, "instruments": False, "license_events": False}))
        elif act == "LOAD_PLUGIN":
            path = req.get("path") or ""
            if path not in self.installed:
                ws.send(json.dumps({"req_id": rid, "success": False, "error": "Plugin introuvable sur ce PC"})); return
            out = 0.0
            try:
                out = float(json.loads(base64.b64decode(req.get("state") or "").decode()).get("output", 0.0))
            except Exception:
                pass
            self.slots[slot] = {"path": path, "output": out}
            ws.send(json.dumps({"req_id": rid, "success": True, "name": path.split("\\")[-1].replace(".vst3", ""), "vendor": "Make Music (test)",
                                "latency_samples": 0, "buffer_latency_samples": 0, "state": self._state(slot), "is_instrument": False}))
        elif act == "GET_PARAMS":
            ws.send(json.dumps({"req_id": rid, "success": True, "parameters": self._params(slot)}))
        elif act == "SET_PARAMS":
            results = []
            for p in req.get("params") or []:
                name = str(p.get("name") or "")
                if name.lower() != "output" or slot not in self.slots:
                    results.append({"name": name, "ok": False, "error": "Réglage inconnu"}); continue
                db = self._db(p.get("real") if p.get("real") is not None else p.get("text"))
                if db is None:
                    results.append({"name": name, "ok": False, "error": "Valeur illisible"}); continue
                self.slots[slot]["output"] = max(-48.0, min(12.0, db))
                self.sets.append({"slot": slot, "output": self.slots[slot]["output"], "t": time.time()})
                results.append({"name": name, "ok": True, "text": f"{self.slots[slot]['output']:.1f} dB"})
            ws.send(json.dumps({"req_id": rid, "success": True, "results": results, "latency_samples": 0, "latency_changed": False}))
        elif act == "GET_STATE":
            ws.send(json.dumps({"req_id": rid, "success": True, "state": self._state(slot), "hash": str(self.slots.get(slot, {}).get("output", 0.0))}))
        elif act == "SET_STATE":
            try:
                self.slots.setdefault(slot, {"path": "", "output": 0.0})["output"] = float(json.loads(base64.b64decode(req.get("state") or "").decode()).get("output", 0.0))
            except Exception:
                pass
            ws.send(json.dumps({"req_id": rid, "success": True}))
        elif act == "UNLOAD_PLUGIN":
            self.slots.pop(slot, None)
            ws.send(json.dumps({"req_id": rid, "success": True}))
        else:
            super().on_message(ws, m)

    def process(self, meta, x, sr):
        y = super().process(meta, x, sr)
        slot = self.slots.get(meta.get("slot_id") or "")
        db = slot["output"] if slot else 0.0
        if not slot and meta.get("state"):
            try:
                db = float(json.loads(base64.b64decode(meta["state"]).decode()).get("output", 0.0))
            except Exception:
                pass
        return (y * (10 ** (db / 20))).astype(np.float32)


def jwt(sub, email):
    enc = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")  # noqa
    return f"{enc({'alg': 'HS256', 'typ': 'JWT'})}.{enc({'sub': sub, 'email': email, 'role': 'authenticated', 'aud': 'authenticated', 'exp': int(time.time()) + 86400 * 30})}.sig"


def connect(page, cloud, realtime, tag, uid, email):
    """Compte et abonnement simulés, daw-session et Realtime simulés (aucun appel réel)."""
    user = {"id": uid, "email": email, "aud": "authenticated", "role": "authenticated", "app_metadata": {}, "user_metadata": {}, "created_at": "2026-01-01T00:00:00Z"}
    tok = jwt(uid, email)
    sess = {"access_token": tok, "token_type": "bearer", "expires_in": 86400 * 30, "expires_at": int(time.time()) + 86400 * 30, "refresh_token": "qa-refresh", "user": user}
    page.add_init_script(f"try {{ localStorage.setItem('sb-mxdrxpzxbgybchzzvpkf-auth-token', {json.dumps(json.dumps(sess))}); localStorage.setItem('nova_simple_mode', '0'); }} catch (e) {{}}")
    page.route(f"{SUPA}/auth/v1/user*", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(user)))
    page.route(f"{SUPA}/auth/v1/token*", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(sess)))
    page.route(f"{SUPA}/functions/v1/daw-session", cloud.handler(tag))
    page.route(f"{SUPA}/storage/v1/object/upload/sign/**", cloud.upload)
    page.route(f"{STORE}/**", cloud.download)
    page.route(f"{SUPA}/rest/v1/instrumentals*", lambda r: r.fulfill(status=200, content_type="application/json", body="[]"))
    page.route(f"{SUPA}/rest/v1/rpc/**", lambda r: r.fulfill(status=200, content_type="application/json", body="false"))
    page.route_web_socket(re.compile(r"realtime/v1/websocket"), realtime.handler(tag))
