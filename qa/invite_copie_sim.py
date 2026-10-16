"""Simulateurs 1.5.1 (lots 3 et 9) : fonctions daw-fork (« Faire sa version ») et daw-listen
(actions public_* : page publique d'un morceau), branchées sur FakeNovaCloud (qa/collab_sim.py)
pour partager les séances et l'audio. Aucune écriture réelle : tout passe par les routes Playwright.

Mêmes règles que les vraies fonctions (supabase/functions/daw-fork/index.ts,
supabase/functions/daw-listen/publicTrack.ts) : propriétaire seulement côté hôte, compte exigé
pour récupérer sa copie, beat du catalogue jamais copié, lien désactivé → 410, publication avec
consentement, morceau entier seulement si l'export est débloqué, page retirée → 410.
"""
import json, random, re, string, time

from collab_sim import HttpErr, STORE

PART_RE = re.compile(r"^[a-f0-9]{40}$")


def _tok(n, alphabet=string.ascii_letters + string.digits):
    return "".join(random.choice(alphabet) for _ in range(n))


class FakeForkPublic:
    def __init__(self, cloud, mix_unlocked=None):
        self.cloud = cloud
        self.forks = {}        # token -> lien
        self.copies = {}       # token -> {uid}
        self.pages = {}        # id -> page
        self.log = []
        # Comptes dont l'export est débloqué (morceau entier publiable) ; None : tous.
        self.mix_unlocked = mix_unlocked

    # ------------------------------------------------------------------ routes
    def _route(self, act):
        def h(route, request):
            if request.method == "OPTIONS":
                return route.fulfill(status=204, headers=self.cloud.cors())
            try:
                body = json.loads(request.post_data or "{}")
            except Exception:
                body = {}
            uid = self.cloud._user(request)
            self.log.append((body.get("action"), uid))
            try:
                out = act(body.get("action"), body, uid)
                route.fulfill(status=200, content_type="application/json", headers=self.cloud.cors(), body=json.dumps(out))
            except HttpErr as e:
                route.fulfill(status=e.status, content_type="application/json", headers=self.cloud.cors(), body=json.dumps({"error": str(e), **e.extra}))
        return h

    def install(self, page, listen=True):
        page.route("**/functions/v1/daw-fork", self._route(self.fork))
        if listen:
            page.route("**/functions/v1/daw-listen", self._route(self.listen))
            page.route(f"{STORE}/**", self.cloud.download)

    def _owned(self, b, uid):
        s = self.cloud.sessions.get(b.get("id"))
        if not s or (s.get("owner") != uid and s["secret"] != b.get("secret")):
            raise HttpErr(404, "Session introuvable")
        if s.get("owner") != uid:
            raise HttpErr(403, "Seul le propriétaire de la séance peut faire ça.", code="not_owner")
        return s

    # ------------------------------------------------------------------ daw-fork
    def fork(self, a, b, uid):
        if b.get("token") is not None and a != "fork_open":
            raise HttpErr(403, "Lien « Faire sa version » : lecture seule.", code="read_only")
        if a == "fork_open":
            f = self.forks.get(str(b.get("token") or ""))
            if not f:
                raise HttpErr(404, "Lien introuvable", code="unknown")
            if f["revoked_at"]:
                raise HttpErr(410, "Ce lien a été désactivé", code="revoked")
            if not uid:
                raise HttpErr(401, "Connecte-toi (compte gratuit) pour récupérer ta version", code="login")
            if f["sid"] not in self.cloud.sessions:
                raise HttpErr(410, "La séance d'origine n'existe plus", code="gone")
            if uid != f["created_by"] and uid not in self.copies[f["token"]]:
                self.copies[f["token"]].add(uid)
            parts = [p for x in f["manifest"]["files"].values() for p in x["parts"]]
            return {"name": f["name"], "label": f["label"], "version": f["version"], "created_at": f["created_at"], "manifest": f["manifest"],
                    "urls": {p: f"{STORE}/{p}" for p in parts}, "copies": len(self.copies[f["token"]])}
        if not uid:
            raise HttpErr(401, "Connecte-toi à ton compte Make Music pour partager ta séance")
        s = self._owned(b, uid)
        sid = b.get("id")
        view = lambda f: {"id": f["id"], "token": f["token"], "label": f["label"], "name": f["name"], "version": f["version"],  # noqa
                          "created_at": f["created_at"], "copies": len(self.copies[f["token"]]), "last_copy_at": None, "files": len(f["manifest"]["files"])}
        mine = [f for f in self.forks.values() if f["sid"] == sid and not f["revoked_at"]]
        if a == "fork_list":
            return {"links": [view(f) for f in sorted(mine, key=lambda f: f["created_at"], reverse=True)], "max": 5}
        if a == "fork_revoke":
            for f in self.forks.values():
                if f["id"] == b.get("link_id") and f["sid"] == sid:
                    f["revoked_at"] = time.time()
                    return {"ok": True}
            raise HttpErr(404, "Lien introuvable")
        if a == "fork_create":
            m = s.get("manifest")
            if not m or not m.get("project"):
                raise HttpErr(409, "Ta séance n'est pas encore en ligne", code="empty")
            if len(mine) >= 5:
                raise HttpErr(409, "Déjà 5 liens actifs", code="too_many")
            project = json.loads(json.dumps(m["project"]))
            cat = {c.get("audioRef") for t in project.get("tracks", []) if t.get("instrumentId") not in (None, "") for c in t.get("clips", [])}
            files = {k: v for k, v in (m.get("files") or {}).items() if k not in cat}
            f = {"id": _tok(16, string.ascii_lowercase + string.digits), "token": _tok(32), "sid": sid, "label": str(b.get("label") or "")[:60],
                 "name": str(b.get("name") or s.get("name") or "Séance")[:80], "manifest": {"format": 1, "project": project, "files": files},
                 "version": s["version"], "created_by": uid, "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"), "revoked_at": None}
            self.forks[f["token"]] = f
            self.copies[f["token"]] = set()
            ncat = sum(1 for t in project.get("tracks", []) if t.get("instrumentId") not in (None, ""))
            return {"link": view(f), "catalog_tracks": ncat, "removed_files": len(m.get("files") or {}) - len(files)}
        raise HttpErr(400, "Action inconnue")

    # ------------------------------------------------------------------ daw-listen (page publique)
    def listen(self, a, b, uid):
        if a == "public_open":
            pg = self.pages.get(str(b.get("page") or ""))
            if not pg:
                raise HttpErr(404, "Ce morceau n'existe pas (ou plus)", code="unknown")
            if not pg["published"]:
                raise HttpErr(410, "Ce morceau n'est plus publié par son auteur.", code="unpublished")
            if not b.get("refresh"):
                pg["plays"] += 1
            return {"id": pg["id"], "title": pg["title"], "artist": pg["artist"], "credits": pg["credits"],
                    "lyrics": pg["lyrics"] if pg["show_lyrics"] else "", "kind": pg["kind"], "duration": pg["audio"]["duration"],
                    "mime": pg["audio"]["mime"], "urls": [f"{STORE}/{p}" for p in pg["audio"]["parts"]], "cover_url": None,
                    "booking_url": "https://www.studiomakemusic.com/reservation?utm_source=nova&utm_medium=page_publique",
                    "plays": pg["plays"], "updated_at": pg["updated_at"]}
        if a not in ("public_get", "public_publish", "public_set"):
            raise HttpErr(400, "Action inconnue")
        if not uid:
            raise HttpErr(401, "Connecte-toi à ton compte Make Music pour publier ton morceau")
        s = self._owned(b, uid)
        sid = b.get("id")
        cur = next((p for p in self.pages.values() if p["sid"] == sid), None)
        own = lambda p: {k: p[k] for k in ("id", "title", "artist", "credits", "lyrics", "show_lyrics", "kind", "published", "plays", "created_at", "updated_at")} | {"duration": p["audio"]["duration"], "unpublished_at": None}  # noqa
        if a == "public_get":
            return {"page": own(cur) if cur else None}
        if a == "public_set":
            if not cur:
                raise HttpErr(404, "Pas encore publié", code="none")
            cur["published"] = b.get("published") is True
            return {"page": own(cur)}
        if b.get("consent") is not True:
            raise HttpErr(400, "Coche « Je publie ce morceau »", code="consent")
        kind = b.get("kind")
        au = b.get("audio") or {}
        parts = au.get("parts") or []
        if kind not in ("mix", "extrait") or not parts or any(not PART_RE.match(p) for p in parts):
            raise HttpErr(400, "Son manquant", code="audio")
        if kind == "extrait" and float(au.get("duration") or 0) > 31:
            raise HttpErr(400, "L'extrait dure 30 secondes au plus.", code="duration")
        if any(p not in self.cloud.parts for p in parts):
            raise HttpErr(400, "Le son n'est pas encore arrivé sur le serveur", code="audio_missing")
        if kind == "extrait" and sum(len(self.cloud.parts[p]) for p in parts) > 1_500_000:
            raise HttpErr(400, "Un extrait fait 30 secondes au plus.", code="size")
        if kind == "mix" and self.mix_unlocked is not None and uid not in self.mix_unlocked:
            raise HttpErr(403, "Le morceau entier se publie quand son export est débloqué.", code="mix_locked", reason="paiement")
        pid = cur["id"] if cur else _tok(10, string.ascii_lowercase + string.digits)
        pg = {"id": pid, "sid": sid, "title": str(b.get("title") or "")[:80], "artist": str(b.get("artist") or "")[:60],
              "credits": str(b.get("credits") or "")[:500], "lyrics": str(b.get("lyrics") or "")[:5000], "show_lyrics": b.get("show_lyrics") is True,
              "kind": kind, "audio": {"parts": parts, "size": au.get("size"), "duration": au.get("duration"), "mime": au.get("mime") or "audio/mpeg"},
              "published": True, "plays": cur["plays"] if cur else 0, "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
              "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ")}
        self.pages[pid] = pg
        return {"page": own(pg)}
