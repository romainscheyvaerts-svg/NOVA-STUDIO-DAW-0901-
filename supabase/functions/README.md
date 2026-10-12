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

## Règle

Toute modification de ces fonctions se fait **ici** (et se recopie dans le dépôt du site tant
que celui-ci déploie aussi), avec ses tests, puis attend un GO pour le déploiement.
