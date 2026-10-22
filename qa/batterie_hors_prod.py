"""Batterie de non-régression NOVA, 100 % hors production (catalogue Supabase simulé).

Lance chaque scénario dans son propre processus (navigateurs headless, aucune
fenêtre), avec le compteur de qa_hors_prod, puis écrit un tableau :
résultat, durée, requêtes Supabase simulées, octets servis, requêtes bloquées,
requêtes parties vers la production (0 attendu).

  NOVA_URL=http://127.0.0.1:3485/ python qa/batterie_hors_prod.py [--jobs 3] [--phase nom] [scénario ...]
"""
import argparse
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

QA = Path(__file__).resolve().parent
BASE_OUT = Path(os.environ.get("QA_HORS_PROD_DIR", r"D:\1 WORK\CONTENU\nova-qa-hors-prod"))

BATTERIE = [
    ("barre_debordement", []), ("barre_bas_debordement", []), ("gestes_tactiles", []), ("fenetres_echap", []),
    ("palette_commandes", []), ("menu_clip", []), ("casque_rec", []), ("seances_doigt", []),
    ("session_voix", []), ("session_mix", []), ("session_beat", []),
    ("collab_bout_en_bout", []), ("feat_distance", []),
    ("r16_midi", []), ("r21_session_pro", []), ("r14_r15_multipiste", []), ("r18_beatmaker", []),
    ("r23_beat_repunch", []), ("r7_sidechain", []), ("r8_automation", []), ("inserts_visibles", []),
    ("pdc_preuve", []), ("pdc_audio_lecture", []),
    ("protools_utiles", []), ("r17_raccourcis_scrub", []), ("catalogue_indisponible", []),
    # Tour 3 (utilisable et pro) : séance d'ingé complète, restes du tour 2, console du téléphone.
    ("seance_inge", []), ("restes_pro3", []), ("console_telephone", []),
    # 1.4.6-1.4.7 : fréquence par projet, artiste invité, collaboration (prise en direct, commentaires, lien d'écoute).
    ("frequence_preuve", []), ("collab_artiste", []), ("prise_directe", []), ("commentaires_versions", []), ("lien_ecoute", []),
    # Chantier 17 : studio Make Music connecté (télécommande de cabine, « Envoyer au studio » sur un studio-inbox simulé, port libre).
    ("studio_connecte", []),
    # 13/10/2026 : thème clair (aucun écran resté sombre, textes lisibles, DAW intégré au site qui suit son thème).
    ("theme_clair", []),
    # 1.4.8 : AAF, surfaces de contrôle, écarts Pro Tools + presets, veille des effets, façades des plugins.
    ("echange_aaf", []), ("surface_controle", []), ("protools_ecarts", []), ("veille_fidelite", []),
    ("plugins_hw_reel", ["D:/1 WORK/CONTENU/nova-plugins-design/batterie_reel"]),
    ("plugins_hw_vague2b", ["--reel", "D:/1 WORK/CONTENU/nova-plugins-design/batterie_vague2b"]),
    ("v21_fenetres", []), ("harmoniseur_fenetre", []),
    # 1.5.1 (plugins-fin) : façades du Compresseur, du Stéréo et du Master (bureau 1366 et téléphone 390, sombre et clair :
    # plus de curseur ni de phrase d'aide, gestes souris / doigt, bornes d'avant, boutons non recouverts).
    ("plugins_fin", []),
    # 13/10/2026 : kits NOVA (sons à la demande, brouillés, jamais exportés gratuitement), PC + téléphone, sombre + clair.
    ("kits_batterie", []),
    # 14/10/2026 : synthé NOVA en un clic (« 🎹 Synthé NOVA »), sons, façade, mini-clavier (bureau et téléphone, sombre et clair).
    ("synthe", []),
    # 15/10/2026 : piano roll pro sur une piste « Synthé NOVA » : beat de 808 avec glissés, accords dans la gamme, vélocité,
    # humaniser + quantifier, dupliquer, écouter, export .mid ; preuve audio du glissé (export = lecture) ; bureau et téléphone, sombre et clair.
    ("pianoroll_pro", []),
    # Lot 2a (BandLab) : clip vertical TikTok / Reels avec les paroles synchronisées (MP4 vérifié par ffprobe / ffmpeg).
    ("clip_paroles", []),
    # 14/10/2026 : tarifs Nova (nova-billing simulé) : gratuit sans export, 1,99 €, Pro, instru → export offert + 1 mois,
    # mélodie → 7 jours, instru non achetée refusée, ancienne grille ; bureau et téléphone.
    ("tarifs", []),
    # Lot 4 BandLab : « Masteriser un morceau » (fichier sans projet) et « Caler sur la référence ».
    ("master_fichier", []),
    # Lot 1 BandLab (14/10/2026) : « ✨ Nettoyer la voix » sur le site sans pont (RNNoise WASM), bureau et téléphone, thèmes sombre et clair.
    ("voix_propre", []),
    # 14/10/2026 : Nova ingé son (API de chat SIMULÉE) : commandes de la palette, confirmation (« Oui, fais-le »),
    # export payant respecté, un Ctrl+Z par message, refus avec la raison ; bureau et téléphone.
    ("chat_inge", []),
    # 15/10/2026 : « ❓ Comment faire ? » : 25 parcours (utils/guides), « Montre-moi » de bout en bout (enregistrer, mixer, exporter),
    # Échap, « Et après ? », questions au chat sans l'IA et avec l'IA SIMULÉE (outil GUIDE) ; bureau sombre et téléphone clair.
    ("guides", []),
    # Lot 12 BandLab (14/10/2026) : « Prêt pour Spotify / Apple / TikTok ? » (feux, « Corriger », paquet .zip Livraison
    # rouvert et vérifié ; instru non achetée → « Acheter la licence », aucun paquet) ; bureau et téléphone, sombre et clair.
    ("distribution", []),
    # Lot 11 BandLab (14/10/2026) : « Voix et flow » : accordeur (La3 ±3 cents, guitare, basse, note tenue), échauffement
    # (flow 80/90/140 BPM à 0, 20 et 50 ms, diction, gammes, tenue, trilles, souffle, sirène, tessiture), micro simulé,
    # historique, micro rendu ; bureau et téléphone, sombre et clair.
    ("echauffement", []),
    # Lot 8 BandLab (14/10/2026) : presets voix (31 + 2 bus, calés sur 3 vraies prises), « Décris ton son », One Knob
    # (tranche de la console et téléphone), Ctrl+Z ; bureau 1600 × 900 et téléphone 390 × 844, sombre et clair.
    ("presets_voix", []),
    # 14/10/2026 : prise et horloge : entrée trouée, débranchée, coupée, fil principal bloqué, rendu affamé, page masquée :
    # chaque clic reste à sa place dans la prise (0 échantillon), mesure du recalage du flux MediaStream de Chrome.
    ("prise_horloge", []),
    # 15/10/2026 : 📌 Prises gardées (zone au-dessus de la piste armée) : 4 prises au micro simulé, 3 gardées (bandeau
    # de fin de prise, Ctrl+Alt+P, clip glissé), écoute, « Mettre sur la piste », comp depuis une ligne, export sans les
    # prises gardées, sauvegarde + rechargement ; bureau 1600 × 900 et téléphone 390 × 844, sombre et clair.
    ("prises_gardees", []),
    ("playlist_glisser", []),
    # 21/10/2026 : 🎧 outils d'écoute d'un ingé de mix : mono (−6 dB), côtés, Dim −20 dB, coupure, volume d'écoute
    # (mesurés sur la sortie d'écoute ET le master), solo AFL / PFL (bus, VCA), export identique au bit près, Ø à
    # l'export, réverbe à réponse impulsionnelle IMPORTÉE (WAV fabriqué), sauvegarde + rechargement ; bureau et téléphone.
    ("mix_ecoute", []),
    # Lot 2b BandLab (14/10/2026) : caméra pendant la prise (fausse caméra de Chrome, flash + clic au même instant), vidéo de la
    # performance (mix + image, MP4 mesuré par ffprobe / ffmpeg : écart ≤ 1 image), stockage plein, prise audio identique ; bureau et téléphone.
    ("video_prise", []),
    # 15/10/2026 (« le DAW le plus simple possible ») : premier parcours d'un nouveau venu chronométré (accueil → instru →
    # première prise → écoute → fenêtre d'export), bureau et téléphone, sans compte et connecté ; inventaire des écrans,
    # aucune pastille flottante qui recouvre un bouton.
    ("premier_parcours", []),
    # 1.5.1 (16/10/2026, chantier fixes-midi) : glissés du piano roll pro dans le .mid (pitch bend + RPN 0, une note par canal
    # sous un accord), relus et réimportés à l'identique ; V25 (bouton MIDI replié dans ☰) et « Remplacer une prise » remis à jour.
    ("glisses_midi", []), ("v25_midi", []), ("remplacer_prise", []),
    # Lot 7 BandLab (16/10/2026) : 🔔 notifications (Web Push) : aucune permission au chargement, carte discrète après le
    # 1er commentaire, « Activer » (faux PushManager), réglages (tout couper / par type, désabonnement réel), notification
    # touchée → commentaire ouvert, autre séance, sans clé (caché), refus, appli Windows ; bureau et téléphone, sombre et clair.
    ("notifications", []),
    # 1.5.1 · lots BandLab 3 et 9 (16/10/2026) : invité GRATUIT (seul l'hôte a Nova Pro ; héberger sans Pro → 402 ;
    # ancien serveur : message clair), « Faire sa version » (copie au bit près, compteur, lien désactivé → 410) et page
    # publique d'un morceau (extrait, lecteur intégrable, réserver au studio, pas de téléchargement, retirée → 410).
    ("invite_copie", []),
    # Lots 5 et 10 BandLab (16/10/2026) : navigateur de sons (kits brouillés, rien à télécharger), boucles NOVA, Palette dans la
    # tonalité, « Démarrer un beat » à base de règles (une annulation), Prolonger / Varier ; bureau 1366 et téléphone 390, sombre et clair.
    ("sons_beat", []),
    # Nettoyage 1.5.2 (16/10/2026) : 💳 « Gérer mon abonnement » (portail Stripe simulé : abonné seulement, message clair si
    # indisponible, nouvel onglet, palette), bureau et téléphone, sombre et clair ; ▶ suivi de la tête de lecture suspendu
    # par un défilement à la main, « Suivre », reprise au Play ; « DUP » du téléphone qui duplique vraiment.
    ("gerer_abonnement", []), ("suivi_lecture", []), ("compte_unique", []),
    # 1.5.2 · guidage (16/10/2026) : micro refusé / absent dit DANS la page au téléphone, barre du clip en français,
    # « Montre-moi » qui va jusqu'au bon bouton du menu ☰, étapes sans Ctrl+K au doigt, connexion à l'endroit du code
    # de collaboration, « Ouvrir un projet » sans compte, projet abîmé, LUFS / dBTP expliqués ; bureau et téléphone, sombre et clair.
    ("guidage", []),
    # 1.5.3 · simple-compte (16/10/2026) : mode simple = BEAT + UNE piste REC (« + Piste voix », mode avancé complet, projet
    # existant intact) ; « Créer un compte » = compte Make Music (règles du site, e-mail de confirmation, renvoi, non confirmé),
    # fenêtre Nova Pro, palette, téléphone ; compte Make Music seul : séances en ligne dans « Ouvrir un projet ».
    ("simple_compte", []),
    # 21/10/2026 : 💬 talkback (bouton « Talk » de la barre, touche N : court = reste ouvert, maintenu = tant qu'on tient) :
    # au studio, voix mesurée dans la sortie casque et absente du master, de l'écoute de la régie, de l'export et de la prise
    # (dim −15 dB, coupé pendant la prise, micro rendu après 20 s) ; en collaboration simulée, N ouvre le talkback EN DIRECT
    # chez l'autre (« 🎙️ Nina te parle » dans la barre de l'ingé) ; bureau sombre et clair, téléphone.
    ("talkback", []),
    # Scénarios avec un pont de test (ports fixes) : à lancer avec --jobs 1 (phase séparée).
    ("sauvegarde_persistante", []), ("prise_pont", []), ("fidelite_export", []), ("pont_protools", []), ("silence_pont_vst", []),
    # B7 : voix par l'IA locale (pont de test 8803 + module voix installé : Whisper sur la carte graphique).
    ("voix_ia_locale", []),
    # Lot 6 BandLab (14/10/2026) : 6 stems, voix lead / chœurs, stem → MIDI, licence des beats, premier
    # téléchargement de modèle (pont de test 8806 + module stems installé ; bureau et téléphone).
    ("stems6", []),
    # Lot 6c BandLab (16/10/2026) : stems DANS LE NAVIGATEUR (Demucs v4 en ONNX, WebGPU puis repli processeur),
    # téléchargement du modèle annoncé, annulé puis gardé, 2 et 4 stems calés, réseau mobile, conseil du PC au téléphone,
    # licence des beats ; bureau et téléphone, sombre et clair (fichiers servis en local sur le port 8798).
    ("stems_web", []),
    # 1.5.3 : mise à jour automatique de l'appli Windows (faux site 8802 + FAUX installateur, rien n'est installé) :
    # téléchargement repris + SHA-256, carte « est prête » dans la page, refus pendant lecture / prise / collab,
    # installation à la fermeture puis relance, « Mis à jour ✓ », appli ancienne (carte web), réglages.
    ("desktop_maj_auto", []),
    ("desktop_hors_ligne", []),
    # 21/10/2026 · effets de mix : Compresseur multibande et EQ dynamique ajoutés par « Ajouter un effet », boutons tournés,
    # mètres de réduction / gain qui bougent en lecture, son du master changé (actif / contourné), solo, écoute d'une bande,
    # sauvegarde ; bureau sombre + clair, téléphone 390 ; lecture = export au bit près (44,1 et 48 kHz).
    ("mixfx", []),
    # 21/10/2026 (perfseance) : grosse séance de mix rap, 96 pistes × 4 effets NOVA (EQ, compresseur, de-esser,
    # envoi reverb), 4 bus, automation, 60 s de lecture : charge et coût du fil audio, sous-régimes, temps
    # d'image (lecture et édition), fil principal, mémoire, démarrage. Mesure seule (objectifs rapportés).
    ("banc_grosse_seance", []),
    # Surcharge processeur (40 pistes × 3 effets) : compteur, alerte avec solutions, mode sécurité.
    ("surcharge_cpu", []),
    # 22/10/2026 · L5 écart 7 : « Réparer la voix » (plosives, clics de bouche, bourdonnement 50 Hz, écrêtage) en
    # traitement de clip, mesuré sur le son rendu par NOVA (vraie prise rap + défauts ajoutés), Ctrl+Z et « Revenir à
    # l'original » au bit près ; éditeur spectral (zone tracée, −20 dB mesuré, reste identique au bit près, remplissage) ;
    # bureau sombre 1600 et clair 1366, téléphone 390 au doigt, sombre et clair.
    ("voix_reparation", []),
    # 22/10/2026 · L5 écart 18 : éditer la voix par le texte (prise transcrite) : mot cliqué = plage + tête de lecture,
    # Suppr en Slip (blanc) et en Shuffle (la suite recule), jonction < −60 dBFS sur le rendu du moteur, Ctrl+Z, silence
    # ramené à 0,12 s, mot corrigé gardé dans le .zip, découpe par phrase ; bureau sombre, téléphone 390, bureau clair.
    ("voix_texte", []),
    # 22/10/2026 · L5 écart 19 : étirement « haute qualité » dans la page (boucle de batterie stéréo calée sur le tempo,
    # 90 → 112,5 → 72 BPM) : attaques à ±2 ms, pas de pré-écho, image stéréo gardée, durée exacte (son relu dans le .zip).
    ("etirement_banc", []),
    # 22/10/2026 · lot L6 (ergonomie pro) + échange DAWproject : export .dawproject relu en Python (noires → secondes à
    # 0 échantillon, WAV), réouvert dans NOVA (aller-retour identique, Ctrl+Z), fichier de référence d'un autre logiciel
    # (plugins absents, son manquant signalés) ; bureau sombre + clair, téléphone 390.
    ("ergo_pro", []),
    # 22/10/2026 · lot L4 « mix et mastering pro » : EQ 12 bandes en Mid/Side et phase linéaire (latence au PDC, export =
    # lecture, neutre + PDC = son sec au bit près), rack d'effets parallèles (branches, bandes, centre / côtés, réalignement),
    # scènes de mix A/B/C/D (rappel exact en une annulation, A⇄B, rappel partiel), mastering d'un EP (6 titres ≤ 0,5 LU,
    # blancs exacts, .cue + ISRC, un WAV par titre) ; bureau sombre + clair, téléphone 390.
    ("mixpro", []),
    # 22/10/2026 · L3 temps musical : tempo 90 → 140 par la fenêtre Tempo (notes, clips, repère, boucle : même mesure | temps |
    # tick ; export = projet écrit directement à 140), Ctrl+Z en une étape, « garder les clips audio à leur place », rampe
    # 120 → 100 (clics à ±1 ms, bande de la piste tempo), sauvegarde + rechargement ; bureau sombre / clair, téléphone 390.
    ("tempo_musical", []),
    # 22/10/2026 · L3 clips MIDI liés : « Dupliquer en copie liée » (menu du clip) ×8, pastilles « ∞ 8 », ↑ dans le piano roll
    # d'UNE copie = les 8 montent (Ctrl+Z / Ctrl+Y en une étape), export = motif posé 8 fois, « Rendre unique », sauvegarde + rechargement.
    ("clips_lies", []),
    # 22/10/2026 · L3 effets MIDI en temps réel : arpège (doubles-croches à 140 BPM à ±1 ms, vitesse changée PENDANT la lecture),
    # gamme forcée (100 % dans la gamme du projet), clavier en direct (arpège, aucun minuteur au repos), « Figer en notes »
    # (= notes entendues, export identique), Ctrl+Z, sauvegarde + rechargement ; bureau sombre / clair, téléphone 390.
    ("effets_midi", []),
    # 22/10/2026 · L3 modulateurs : LFO à la noire sur le volume (menu de la piste) ; export : l'enveloppe bat à 0,5 s à ±5 ms ;
    # lecture : le gain de la piste suit la même courbe ; coupé = son constant ; Ctrl+Z ; sauvegarde + rechargement ; téléphone.
    ("modulateurs", []),
    # 22/10/2026 · restes : lecture avec un effet à latence sur le master (EQ linéaire 43 ms, + limiteur) : grosse caisse
    # posée à 0,000 s entendue entière (pré-roulement du transport), depuis 0 et depuis le milieu, 44,1 et 48 kHz ;
    # lecture = export au bit près ; tête de lecture jamais avant le départ ni en avance sur le son.
    ("pdc_preroll_lecture", []),
    # 22/10/2026 · restes : automation d'un effet placé dans une branche du rack parallèle (gain de compensation du
    # Compresseur ×1 → ×2 = +6,02 dB à l'export, Off = rien), proposé dans l'éditeur, lecture = export au bit près (44,1 / 48 kHz).
    ("rack_automation", []),
    # 22/10/2026 · restes : clé externe (side-chain) sur le Compresseur multibande et l'EQ dynamique : kick muet → la basse
    # se creuse pendant chaque kick (≈ −19 dB), voix muette → la nappe baisse de la plage (−6 dB), rien entre les salves ;
    # lecture = export au bit près (44,1 / 48 kHz).
    ("mixfx_cle", []),
    # 22/10/2026 · restes 2 : lecture EN BOUCLE avec un effet à latence sur le master (EQ linéaire 43 ms, + limiteur, synthé
    # NOVA) : chaque tour commence entier (grosse caisse dès son 1er échantillon, 43 premières ms = son sec), rien d'après la
    # fin de boucle ne s'entend, chaque tour = export de la même zone au bit près (44,1 / 48 kHz).
    ("pdc_boucle_lecture", []),
    # 22/10/2026 · restes 2 : rack parallèle, automation écrite en touchant un bouton dans la fenêtre d'un effet d'une branche
    # (Latch au clavier, Touch à la souris) : voie « <rack>::<effet>/<réglage> », valeur jouée par le moteur, Ctrl+Z en une étape.
    ("rack_automation_fenetre", []),
    # 22/10/2026 · restes 2 : suiveur d'enveloppe (modulateur) : le niveau du Kick creuse le volume de la Basse (plage 60 %,
    # attaque 5 ms, relâchement 80 ms) ; export de la basse seule = creux à chaque coup (≥ 6 dB), lecture = même courbe ;
    # coupé, Ctrl+Z, sauvegarde + rechargement ; téléphone.
    ("modulateurs_suiveur", []),
]


def run_one(name, args, phase, url, timeout):
    out = BASE_OUT / "batterie" / phase
    cnt = out / "compteurs" / f"{name}.json"
    logf = out / "sorties" / f"{name}.txt"
    cnt.parent.mkdir(parents=True, exist_ok=True); logf.parent.mkdir(parents=True, exist_ok=True)
    try: cnt.unlink()
    except OSError: pass
    env = dict(os.environ, NOVA_URL=url, QA_OUT=str(out / "captures" / name), QA_PHASE=phase, QA_TAG=phase,
               PYTHONIOENCODING="utf-8", QA_HORS_PROD_COMPTEUR=str(cnt))
    env.pop("QA_ALLOW_PROD", None)
    t0 = time.time()
    with open(logf, "w", encoding="utf-8") as fh:
        try:
            p = subprocess.run([sys.executable, str(QA / f"{name}.py"), *args], cwd=str(QA.parent), env=env,
                               stdout=fh, stderr=subprocess.STDOUT, timeout=timeout,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            code = p.returncode
        except subprocess.TimeoutExpired:
            code = "délai"
    secs = round(time.time() - t0)
    c = {}
    try: c = json.loads(cnt.read_text(encoding="utf-8"))
    except Exception: pass
    tail = logf.read_text(encoding="utf-8", errors="replace").splitlines()[-12:]
    ko = [l for l in logf.read_text(encoding="utf-8", errors="replace").splitlines() if l.startswith(("KO", "ÉCHEC", "FAIL"))]
    r = {"scenario": name, "code": code,
         "ok": code == 0 and bool(c) and not c.get("requetes_bloquees") and not c.get("requetes_prod") and not c.get("filet_dns"),
         "secs": secs, "simulees": c.get("requetes_simulees"), "simulees_scenario": c.get("simulees_par_le_scenario"),
         "octets": c.get("octets_total"), "par_type": c.get("par_type"), "octets_par_type": c.get("octets_par_type"),
         "bloquees": c.get("requetes_bloquees"), "bloquees_detail": c.get("bloquees"),
         "filet_dns": c.get("filet_dns"), "prod": c.get("requetes_prod"), "prod_detail": c.get("requetes_prod_detail"),
         "ko": ko[:10], "fin": tail}
    print(f"{'OK ' if r['ok'] else 'KO '} {name:24s} code={code} {secs:4d}s  simulées={r['simulees']}  "
          f"(+{r['simulees_scenario']} par le scénario)  bloquées={r['bloquees']}  filet DNS={r['filet_dns']}  prod={r['prod']}", flush=True)
    return r


def table(rows, phase, url):
    L = [f"# Batterie de non-régression hors production ({phase})", "",
         f"Serveur : {url} · {time.strftime('%Y-%m-%d %H:%M')} · Supabase simulé (qa/qa_hors_prod.py)", "",
         "| Scénario | Résultat | Durée | Requêtes Supabase simulées (qa_hors_prod) | + servies hors simulateur central (simulateurs du scénario, pré-vols CORS) | Octets servis | Bloquées | Filet DNS | Vers la prod |",
         "|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        L.append(f"| {r['scenario']} | {'✅' if r['ok'] else '❌ (code ' + str(r['code']) + ')'} | {r['secs']} s | "
                 f"{r['simulees'] if r['simulees'] is not None else '—'} | {r.get('simulees_scenario', '—')} | "
                 f"{(r['octets'] or 0) / 1e6:.1f} Mo | {r['bloquees'] if r['bloquees'] is not None else '—'} | "
                 f"{r.get('filet_dns', '—')} | {r['prod'] if r['prod'] is not None else '—'} |")
    tot_req = sum(r["simulees"] or 0 for r in rows)
    L += ["", f"**Total : {sum(r['ok'] for r in rows)}/{len(rows)} scénarios verts · {tot_req} requêtes Supabase simulées · "
              f"{sum(r.get('simulees_scenario') or 0 for r in rows)} servies par les simulateurs des scénarios ou pré-vols CORS · "
              f"{sum(r['bloquees'] or 0 for r in rows)} bloquées · {sum(r.get('filet_dns') or 0 for r in rows)} arrêtées par le filet DNS · "
              f"{sum(r['prod'] or 0 for r in rows)} vers la production.**"]
    return "\n".join(L) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("noms", nargs="*")
    ap.add_argument("--jobs", type=int, default=3)
    ap.add_argument("--phase", default="hors_prod")
    ap.add_argument("--timeout", type=int, default=45 * 60)
    a = ap.parse_args()
    url = os.environ.get("NOVA_URL", "http://127.0.0.1:3485/")
    todo = [(n, args) for n, args in BATTERIE if not a.noms or n in a.noms]
    with ThreadPoolExecutor(a.jobs) as ex:
        rows = list(ex.map(lambda t: run_one(t[0], t[1], a.phase, url, a.timeout), todo))
    out = BASE_OUT / "batterie" / a.phase
    prev = {}
    try: prev = {r["scenario"]: r for r in json.loads((out / "resultats.json").read_text(encoding="utf-8"))}
    except Exception: pass
    prev.update({r["scenario"]: r for r in rows})
    allrows = [prev[n] for n, _ in BATTERIE if n in prev]
    (out / "resultats.json").write_text(json.dumps(allrows, ensure_ascii=False, indent=1), encoding="utf-8")
    (out / "tableau.md").write_text(table(allrows, a.phase, url), encoding="utf-8")
    print(table(allrows, a.phase, url))
    sys.exit(0 if all(r["ok"] for r in rows) else 1)


if __name__ == "__main__":
    main()
