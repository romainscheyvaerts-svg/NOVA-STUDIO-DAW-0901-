# Fonctions serveur de NOVA (Supabase Edge Functions)

Ce dossier contient le code des fonctions serveur dont NOVA dépend. Jusqu'au 12/10/2026,
`daw-session` et `nova-billing` n'existaient que dans le dépôt du site : NOVA les appelait
sans les versionner.

**Rien n'est déployé depuis ce dépôt sans le GO de Romain.**

## D'où elles viennent

| Fonction | Source d'origine | Version dans ce dépôt | Version en ligne (projet `mxdrxpzxbgybchzzvpkf`) |
|---|---|---|---|
| `daw-session` | `D:\1 WORK\CODE\SITE MAKE MUSIC\studiomakemusic-collab-wt\supabase\functions\daw-session\index.ts` (branche `daw-session-collab-2026-10-07`) | **`fe14e5f`** : une clé par appareil, la collaboration repousse le ménage des 180 jours, codes d'invitation | **Pas `fe14e5f`.** D'après `D:\1 WORK\CONTENU\nova-collab-pro\DEPLOIEMENT_SERVEUR.md` (dernier point le 08/10), `fe14e5f` n'est pas déployée. La version en ligne est celle de la branche principale du site (`2e2b234`, identique à `a9d9a82` pour ce fichier) : c'est le 1er commit de ce dossier dans NOVA (`git log -- supabase/functions/daw-session`). |
| `nova-billing` | `D:\1 WORK\CODE\SITE MAKE MUSIC\studiomakemusic\supabase\functions\nova-billing\index.ts` (branche principale, `2e2b234`) | `2e2b234` | `2e2b234`, la version de la branche principale. La branche `tarifs-nova-2026-10-04` (`cc3919e`, grille à 10 €) n'est **pas** reprise ici : elle attend un GO séparé. |

Le dossier `supabase/schema-site/` contient une copie des migrations du site qui créent les
tables utilisées (`daw_sessions`, `daw_session_members`, `daw_session_ops`,
`daw_session_invites`, `nova_subscriptions`, `nova_purchases`, `nova_export_uses`).
C'est une référence : ce n'est **pas** un dossier `migrations`, `supabase db push` ne le lit pas.

Les autres fonctions du dossier (`create-checkout-session`, `generate-invoice`,
`stream-drive-audio`, `sync-drive-index`) étaient déjà là avant.

`daw-listen` (12/10/2026, chantier 12 « Lien d'écoute client sans compte ») est **nouvelle** et
**pas déployée** : liens d'écoute créés par l'ingé (`listen_create`, `listen_list`,
`listen_revoke` : compte connecté + lien de la séance), ouverts par le client sans compte
(`listen_open` : le jeton seul, lecture seule ; toute autre action avec un jeton → 403). Sa
table est dans `supabase/migrations/20261012180000_daw_listen_links.sql` (non appliquée).

## Tests

```powershell
npx vitest run supabase/tests
```

`supabase/tests/functions.test.ts` charge les fichiers `index.ts` **tels quels** : les imports
distants (`deno.land`, `esm.sh`) sont remplacés par des faux en mémoire
(`supabase/tests/fakes/`, alias dans `vitest.config.ts`). Aucun réseau, aucune base réelle.
Ils couvrent : CORS, secret haché, conflit 409, audio manquant, abonnement exigé pour
collaborer (402), clé par appareil, codes d'invitation, adresse de retour refusée (pas de
redirection ouverte), prix inchangés (2 €, 5 €/mois, 10 €/mois), 10 exports gratuits Nova Pro.

`supabase/tests/daw-listen.test.ts` (même principe) couvre le lien d'écoute : jeton aléatoire
de 32 caractères cherché par son empreinte, durées 24 h / 7 j / 30 j, expiration (410
« expiré le … »), révocation (410 « désactivé »), mot de passe PBKDF2 et blocage après 8
essais, contenu choisi (direct / versions / commentaires), **lecture seule** (toute écriture
avec le jeton refusée par `daw-listen` et par `daw-session`, et rien d'écrit en base), vue
publique des commentaires et versions (sans clé interne, archivés exclus).

## Déployer (seulement avec le GO de Romain)

Toujours depuis ce dossier, sur le projet `mxdrxpzxbgybchzzvpkf` (compte romain.scheyvaerts /
MAKE MUSIC BOOKING).

```powershell
cd "D:\1 WORK\CODE\NOVA-fiab-wt"            # ou le dépôt NOVA principal après fusion
npx supabase login                          # si besoin
npx supabase link --project-ref mxdrxpzxbgybchzzvpkf

# 1. Table des codes d'invitation, AVANT la fonction (sinon « Code indisponible ») :
#    tableau de bord → SQL Editor → contenu de supabase\schema-site\20261007200000_daw_collab_invites.sql → Run

# 2. daw-session : la vérification JWT de la passerelle est DÉSACTIVÉE (la fonction
#    accepte la clé anonyme et vérifie elle-même le compte quand il le faut).
npx supabase functions deploy daw-session --project-ref mxdrxpzxbgybchzzvpkf --no-verify-jwt

# 3. nova-billing (inchangée : à redéployer seulement si elle change)
npx supabase functions deploy nova-billing --project-ref mxdrxpzxbgybchzzvpkf
```

Vérifier après coup : dans NOVA, « Collaborer → Démarrer » affiche « Ou donne ce code : … ».

Retour arrière pour `daw-session` : redéployer la version d'avant, gardée dans l'historique
de ce dépôt :

```powershell
git show c4d3f47:supabase/functions/daw-session/index.ts > $env:TEMP\daw-session-avant.ts
# copier ce fichier dans un dossier supabase/functions/daw-session temporaire, puis la même commande deploy
```

### Lien d'écoute client (`daw-listen`), dans cet ordre

```powershell
# 1. Table AVANT la fonction (sinon « relation daw_listen_links does not exist ») :
#    tableau de bord → SQL Editor → contenu de supabase\migrations\20261012180000_daw_listen_links.sql → Run
#    (pas « supabase db push » : il appliquerait aussi les autres migrations du dossier).

# 2. La fonction, vérification JWT de la passerelle DÉSACTIVÉE comme daw-session (le client
#    n'a pas de compte : clé anonyme ; la fonction vérifie elle-même compte et jeton).
npx supabase functions deploy daw-listen --project-ref mxdrxpzxbgybchzzvpkf --no-verify-jwt

# 3. Le site NOVA (Vercel) avec la branche fusionnée : il apporte ecoute.html (page du client)
#    et le panneau « Lien d'écoute client » de l'ingé.
```

Rien d'autre à régler : le direct passe par Supabase Realtime (canaux publics, déjà utilisés par
la collaboration) et WebRTC entre l'ingé et le client.

Vérifier après coup : NOVA → Collaborer (ingé) → « Lien d'écoute client » → « Nouveau lien » →
ouvrir le lien sur un téléphone en navigation privée → « En direct » quand l'ingé diffuse.

Retour arrière : redéployer le site d'avant, puis
`npx supabase functions delete daw-listen --project-ref mxdrxpzxbgybchzzvpkf`, puis dans le
SQL Editor `drop table if exists public.daw_listen_links;`.

## Règle

Toute modification de ces fonctions se fait **ici** (et se recopie dans le dépôt du site tant
que celui-ci déploie aussi), avec ses tests, puis attend un GO pour le déploiement.

## `studio-inbox` (13/10/2026, chantier 17 « Envoyer au studio ») — PAS DÉPLOYÉE

NOVA regroupe le projet (.zip), les stems (FLAC 24 bits), les notes horodatées et une
**demande** de réservation, et les dépose au studio Make Music. Compte connecté obligatoire.
Actions : `package_init` (adresses d'envoi signées, stockage privé `studio-packages`),
`package_resign` (reprise d'un envoi coupé), `package_submit` (vérifie que chaque fichier est
arrivé à la bonne taille, puis crée la demande de réservation, statut `demande` ; deux envois du
même paquet rendent la même réservation), `package_status`, `studio_list` (boîte du studio,
comptes listés dans le secret `STUDIO_ADMIN_EMAILS`). **Aucun message n'est envoyé** (ni mail,
ni SMS) : le studio lit sa boîte ; brancher une notification sera une décision à part.
Règles communes à NOVA et au serveur : `studio-inbox/rules.ts`.

Tests : `npx vitest run supabase/tests/studio-inbox.test.ts` ; QA de bout en bout sur un serveur
simulé qui fait tourner ce code tel quel : `qa/studio_connecte.py` (+ `qa/harness/studio_inbox_serveur.mjs`).

Déploiement (seulement avec le GO de Romain) :

```powershell
cd "D:\1 WORK\CODE\NOVA-studio-wt"            # ou le dépôt NOVA principal après fusion
npx supabase link --project-ref mxdrxpzxbgybchzzvpkf
# 1. Tables + bucket privé, AVANT la fonction :
#    tableau de bord → SQL Editor → contenu de supabase\migrations\20261013120000_studio_packages.sql → Run
# 2. Qui voit la boîte du studio (adresses séparées par des virgules) :
npx supabase secrets set STUDIO_ADMIN_EMAILS="romain.scheyvaerts@gmail.com" --project-ref mxdrxpzxbgybchzzvpkf
# 3. La fonction (vérifie elle-même le compte, comme daw-session : 401 sans compte) :
npx supabase functions deploy studio-inbox --project-ref mxdrxpzxbgybchzzvpkf --no-verify-jwt
```

Retour arrière : `npx supabase functions delete studio-inbox --project-ref mxdrxpzxbgybchzzvpkf`,
puis le bloc « Retour arrière » en tête de la migration.

## Tarifs Nova, grille du 14/10/2026 — PAS DÉPLOYÉE

Source unique des prix et des règles : `_shared/novaTarifs.ts` (export 1,99 €/projet, Nova Pro
9,99 €/mois ou 89 €/an, cadeaux : instru 30 j, mélodie 7 j, Melody Exclusive 30 j, séance au
studio 30 j, cumulables ; gratuit : 1 projet en ligne 7 jours). Le DAW et le site la lisent par
`nova-billing` → `pricing` (public). Le serveur décide seul de l'export (`export_access`).

| Fonction | Référence | Changement |
|---|---|---|
| `nova-billing` | **ce dépôt** (la copie du site est marquée « ne pas déployer d'ici ») | grille, `pricing`, `export_access`, `melody_perk`, Pro annuel, cadeaux déduits des achats, anciens produits et actions acceptés |
| `daw-session` | **ce dépôt** (idem) | projet gratuit 7 jours (1 à la fois), 410 après expiration, collaboration : seul l'hôte a besoin de Nova Pro, séance studio = 30 j de Pro |
| `daw-session-purge` | **ce dépôt** (nouvelle) | ménage des projets expirés ; clé `NOVA_PURGE_KEY`, simulation par défaut ; **pas programmée** |
| `deliver-instrumental`, `beatmaker` | dépôt du **site** | mélodie offerte du mois (décompte par `nova-billing`), espace beatmaker ouvert aux abonnés Nova Pro |

Migration : `supabase/migrations/20261014120000_nova_tarifs.sql` (AVANT les fonctions).
Tests : `npx vitest run supabase/tests` (dont `novaTarifs.test.ts`) ; migration :
`PGLITE=… node supabase/tests/nova_tarifs.pglite.mjs`.
Ordre de mise en ligne, commandes et retour arrière : `D:\1 WORK\CONTENU\nova-tarifs\DEPLOIEMENT.md`.
