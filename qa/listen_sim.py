"""Fonction serveur daw-listen SIMULÉE (lien d'écoute client sans compte), pour la QA hors production.

Même contrat que supabase/functions/daw-listen/index.ts (testé, lui, par
supabase/tests/daw-listen.test.ts) : mêmes actions, mêmes codes HTTP, mêmes
codes d'erreur (unknown, expired, revoked, password_required, password_wrong,
locked, read_only). Les séances, le journal et l'audio viennent de
FakeNovaCloud (qa/collab_sim.py) : un lien d'écoute porte sur une vraie séance
simulée de la QA.

Tout passe par les routes Playwright : rien ne sort vers Supabase.
"""
import hashlib, json, random, string, time

TTL_HOURS = (24, 168, 720)
TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
READ_ONLY = "Lien d'écoute : lecture seule. Il ne permet aucune modification de la séance."
_rng = random.SystemRandom()


class ListenErr(Exception):
    def __init__(self, status, msg, **extra):
        super().__init__(msg)
        self.status = status
        self.extra = extra


def _iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(t))


def _fr(t):
    return time.strftime("%d/%m/%Y %H:%M", time.localtime(t))


class FakeListen:
    def __init__(self, cloud):
        self.cloud = cloud
        self.links = {}          # id -> lien
        self.calls = []          # (tag, action, statut)

    # ------------------------------------------------------------- route
    def handler(self, tag):
        def h(route, request):
            if request.method == "OPTIONS":
                return route.fulfill(status=204, headers=self.cloud.cors())
            try:
                body = json.loads(request.post_data or "{}")
            except Exception:
                body = {}
            a = body.get("action")
            try:
                out = self.act(a, body, request)
                self.calls.append((tag, a, 200))
                route.fulfill(status=200, content_type="application/json", headers={**self.cloud.cors(), "cache-control": "no-store"}, body=json.dumps(out))
            except ListenErr as e:
                self.calls.append((tag, a, e.status))
                route.fulfill(status=e.status, content_type="application/json", headers=self.cloud.cors(), body=json.dumps({"error": str(e), **e.extra}))
        return h

    # ------------------------------------------------------------ outils
    def _session(self, b, request):
        uid = self.cloud._user(request)
        if not uid:
            raise ListenErr(401, "Connecte-toi à ton compte Make Music pour gérer les liens d'écoute")
        s = self.cloud.sessions.get(b.get("id"))
        if not s or s["secret"] != b.get("secret"):
            raise ListenErr(404, "Session introuvable")
        return b.get("id"), uid

    @staticmethod
    def _view(l):
        return {"id": l["id"], "token": l["token"], "label": l["label"], "live": l["live"], "versions": l["versions"], "comments": l["comments"],
                "has_password": bool(l["password"]), "created_at": _iso(l["created"]), "expires_at": _iso(l["expires"]),
                "channel": f"nova-listen-{l['id']}", "opens": l["opens"], "last_opened_at": None}

    def _active(self, sid):
        now = time.time()
        return sorted([l for l in self.links.values() if l["sid"] == sid and not l["revoked"] and l["expires"] > now], key=lambda l: -l["created"])

    def expire(self, link_id):
        """Le lien a expiré (horloge avancée) : pour la QA."""
        self.links[link_id]["expires"] = time.time() - 60

    # --------------------------------------------------- vue publique (lecture)
    @staticmethod
    def _stamp(r):
        s = (r or {}).get("s") or {}
        return (s.get("t") or 0, s.get("c") or 0, s.get("by") or "")

    def _review(self, sid):
        comments, versions = {}, {}
        m = (self.cloud.sessions[sid].get("manifest") or {}).get("project") or {}
        items = [("comments", c) for c in m.get("timelineComments") or []] + [("mixver", v) for v in m.get("mixVersions") or []]
        for o in self.cloud.ops:
            if o["sid"] == sid and o["kind"] in ("comments", "mixver"):
                items += [(o["kind"], i) for i in ((o["op"] or {}).get("upsert") or []) if isinstance(i, dict)]
        for kind, i in items:
            store = comments if kind == "comments" else versions
            cur = store.get(i.get("id"))
            if not cur:
                store[i["id"]] = i
                continue
            keys = ("pos", "text", "status", "archived") if kind == "comments" else ("decision",)
            merged = dict(cur)
            for k in keys:
                if self._stamp(i.get(k)) > self._stamp(cur.get(k)):
                    merged[k] = i.get(k)
            if kind == "comments":
                reps = {r["id"]: r for r in (cur.get("replies") or []) + (i.get("replies") or []) if isinstance(r, dict) and r.get("id")}
                merged["replies"] = list(reps.values())
            store[i["id"]] = merged
        pub_c = []
        for c in comments.values():
            if (c.get("archived") or {}).get("v") is True:
                continue
            pos = (c.get("pos") or {}).get("v") or {}
            text = ((c.get("text") or {}).get("v") or "").strip()
            if not text or not isinstance(pos.get("t"), (int, float)):
                continue
            pub_c.append({"id": c["id"], "t": pos["t"], "end": pos.get("end"), "text": text[:1000], "author": c.get("authorName") or "?",
                          "role": c.get("role"), "status": "resolved" if ((c.get("status") or {}).get("v") or {}).get("s") == "resolved" else "open",
                          "created_at": c.get("createdAt") or 0,
                          "replies": [{"author": r.get("authorName") or "?", "text": (r.get("text") or {}).get("v") or "", "at": r.get("createdAt") or 0}
                                      for r in c.get("replies") or [] if not (r.get("deleted") or {}).get("v")]})
        pub_c.sort(key=lambda c: (c["t"], c["created_at"]))
        pub_v = []
        for v in versions.values():
            d = (v.get("decision") or {}).get("v")
            a = v.get("audio") or None
            parts = [p for p in (a or {}).get("parts") or [] if isinstance(p, str) and len(p) == 40]
            pub_v.append({"id": v["id"], "n": v.get("n"), "name": v.get("name") or f"Version {v.get('n')}", "note": v.get("note") or None,
                          "sent_at": v.get("sentAt") or 0, "sent_by": v.get("sentBy") or "?",
                          "decision": {"kind": d["kind"], "by": d.get("by") or "?", "at": d.get("at") or 0, "comment": d.get("comment")} if isinstance(d, dict) else None,
                          "audio": {"parts": parts, "size": a.get("size") or 0, "duration": a.get("duration") or 0} if parts else None,
                          "urls": {p: f"https://fake-storage.test/{p}" for p in parts if p in self.cloud.parts} if parts else None})
        pub_v.sort(key=lambda v: -(v["n"] or 0))
        return pub_c, pub_v[:20]

    # ------------------------------------------------------------- actions
    def act(self, a, b, request):
        if "token" in b and a != "listen_open":
            raise ListenErr(403, READ_ONLY, code="read_only")
        if a == "listen_open":
            tok = str(b.get("token") or "")
            l = next((x for x in self.links.values() if x["hash"] == hashlib.sha256(tok.encode()).hexdigest()), None) if len(tok) == 32 else None
            if not l:
                raise ListenErr(404, "Lien d'écoute introuvable : vérifie qu'il est complet (copie-le en entier), ou demande un nouveau lien à ton ingé son.", code="unknown")
            if l["revoked"]:
                raise ListenErr(410, "Ce lien d'écoute a été désactivé par l'ingé son. Demande-lui un nouveau lien.", code="revoked")
            if l["expires"] <= time.time():
                raise ListenErr(410, f"Ce lien d'écoute a expiré le {_fr(l['expires'])}. Demande un nouveau lien à ton ingé son.", code="expired")
            if l["password"]:
                pw = b.get("password") or ""
                if not pw:
                    raise ListenErr(401, "Ce lien est protégé par un mot de passe : demande-le à ton ingé son.", code="password_required")
                if pw != l["password"]:
                    raise ListenErr(403, "Mot de passe incorrect.", code="password_wrong")
            if not b.get("refresh"):
                l["opens"] += 1
            sid = l["sid"]
            pub_c, pub_v = self._review(sid) if (l["comments"] or l["versions"]) else ([], [])
            return {"link": {"label": l["label"], "expires_at": _iso(l["expires"]), "live": l["live"], "versions": l["versions"], "comments": l["comments"]},
                    "session": {"name": self.cloud.sessions[sid]["name"] or "Séance"},
                    "channel": f"nova-listen-{l['id']}" if l["live"] else None,
                    "comments": pub_c if l["comments"] else None, "versions": pub_v if l["versions"] else None,
                    "server_time": _iso(time.time())}
        if a in ("listen_create", "listen_list", "listen_revoke"):
            sid, uid = self._session(b, request)
            if a == "listen_list":
                return {"links": [self._view(l) for l in self._active(sid)]}
            if a == "listen_revoke":
                l = self.links.get(str(b.get("link_id") or ""))
                if not l or l["sid"] != sid:
                    raise ListenErr(404, "Lien d'écoute introuvable")
                l["revoked"] = l["revoked"] or time.time()
                return {"ok": True}
            ttl = b.get("ttl_hours")
            if ttl not in TTL_HOURS:
                raise ListenErr(400, "Durée invalide : 24 h, 7 jours ou 30 jours")
            live, versions, comments = b.get("live") is not False, b.get("versions") is not False, bool(b.get("comments"))
            if not (live or versions or comments):
                raise ListenErr(400, "Choisis au moins une chose à partager : le mix en direct, les versions ou les commentaires")
            pw = b.get("password") or ""
            if pw and not 4 <= len(pw) <= 64:
                raise ListenErr(400, "Mot de passe : de 4 à 64 caractères")
            if len(self._active(sid)) >= 20:
                raise ListenErr(409, "Déjà 20 liens actifs sur cette séance : révoques-en un avant d'en créer un autre")
            tok = "".join(_rng.choice(TOKEN_ALPHABET) for _ in range(32))
            lid = "".join(_rng.choice(string.ascii_lowercase + string.digits) for _ in range(16))
            now = time.time()
            self.links[lid] = {"id": lid, "sid": sid, "token": tok, "hash": hashlib.sha256(tok.encode()).hexdigest(), "label": str(b.get("label") or "")[:60],
                               "live": live, "versions": versions, "comments": comments, "password": pw or None, "created": now,
                               "expires": now + ttl * 3600, "revoked": None, "opens": 0, "by": uid}
            return {"link": self._view(self.links[lid])}
        raise ListenErr(400, "Action inconnue")
