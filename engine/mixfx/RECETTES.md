# Compresseur multibande et EQ dynamique : recettes des préréglages (21/10/2026)

> Règle de Romain : aucun préréglage inventé. Chaque préréglage ci-dessous reprend une recette
> publiée ; les valeurs qui n'y sont pas chiffrées ne sont PAS ajoutées (le réglage de
> l'utilisateur est gardé). Le **seuil n'est jamais imposé** : toutes les recettes disent de le
> régler à l'oreille pour une réduction donnée, c'est ce que dit l'aide du préréglage.

Valeurs par défaut des deux effets : **neutres** (le son ne change pas tant qu'on n'a rien tourné).

- Compresseur multibande : taux 1:1 sur chaque bande, gains 0 dB. Coupures 200 Hz et 4 kHz
  (3 bandes), 10 kHz (4e bande) : sans effet sur le son tant que rien ne compresse (somme plate).
- EQ dynamique : plage 0 dB sur les 4 bandes (sortie identique à l'entrée au bit près).

## Sources

| Id | Source | Lien | Lu le |
|---|---|---|---|
| R1 | Steve LaCerra, « Secrets of Multiband Compression », FOH Online, 12/04/2016 (mis à jour le 03/03/2025) | https://fohonline.com/?p=123419 | 21/10/2026 (page ouverte) |
| R2 | « How to Fix Harsh Vocals (Smooth, Easy Leads) », Violet Recording | https://violetrecording.com/how-to-fix-harsh-vocals/ | 21/10/2026 (page ouverte) |

Pages consultées mais sans chiffre exploitable (aucun préréglage n'en vient) : McDSP « Vocal
De-Essing with Dynamic EQ » (fréquences d'exemple seulement), Sweetwater « Multiband compressor
application on a vocal track » (403, non lue), Sound On Sound « Multi-band compression tips »
(vue en résultat seulement).

## Compresseur multibande

| Préréglage | Recette (R1) | Dans NOVA |
|---|---|---|
| Voix : sifflantes | Recette 3 « sibilance control » : coupures 130 Hz et 4 kHz ; grave 1:1 ; médium 2,5:1 ou 3:1, attaque ~30 ms, relâchement 0,20 s, +3 dB, seuil pour 4 à 6 dB de réduction ; aigu 4:1 ou 5:1, attaque la plus rapide possible, relâchement 0,20 s, +2 ou +3 dB, seuil pour 4 à 5 dB sur les « s ». | 3 bandes, 130 Hz / 4 kHz ; b1 1:1 ; b2 3:1, 30 ms, 200 ms, +3 dB ; b3 5:1, 0,1 ms (attaque minimale du bouton), 200 ms, +2 dB. Seuils : à l'utilisateur (cibles dans l'aide). |
| Bus batterie | Recette 2 « stereo drum bus » : coupures 275 Hz et 4 kHz ; grave 2,5:1, 15 ms, 0,25 s, ~4 dB de réduction, +4 dB ; médium 3:1, 15 ms, 0,25 s, 5 à 6 dB, 0 dB ; aigu 1:1, +3 dB. | 3 bandes, 275 Hz / 4 kHz ; b1 2,5:1, 15 ms, 250 ms, +4 dB ; b2 3:1, 15 ms, 250 ms, 0 dB ; b3 1:1, +3 dB. |
| Grave qui pompe | Recette 1 « dance mix » : bande grave 5:1, attaque ~10 ms, relâchement 0,25 s, seuil pour ~5 dB de réduction sur le kick ; coupure balayée jusqu'à ce que la voix ne soit plus comprimée (pas de valeur). | b1 5:1, 10 ms, 250 ms. Coupure et seuil : à l'utilisateur. |

Non repris : recette 4 (voix dure) — « attaque et relâchement rapides » sans valeur ; recette 5
(basse) — aucun chiffre.

## EQ dynamique

| Préréglage | Recette (R2) | Dans NOVA |
|---|---|---|
| Voix dure (2 à 5 kHz) | Trouver la dureté avec une cloche étroite (Q 4 à 6) balayée entre 2 et 5 kHz, puis passer la bande en dynamique pour baisser de 2 à 4 dB au-dessus du seuil. Attaque, relâchement et seuil : non chiffrés. | Bande 3 active, 3,5 kHz (milieu de 2–5 kHz, à balayer avec « Écouter »), Q 5, plage −3 dB. Attaque, relâchement et seuil : ceux de l'utilisateur. |

## Mesures (tests/mixFx.test.ts)

- Somme du multibande sans compression : écart max < 0,001 dB de 20 Hz à 20 kHz (impulsion), ≤ 0,1 dB par octave sur bruit rose, en 3 et 4 bandes.
- Réduction mesurée sur un sinus dans une bande = (1 − 1/taux) × dépassement à ±0,25 dB ; 0 dB dans les autres bandes.
- EQ dynamique sous le seuil : sortie identique à l'entrée au bit près ; au-dessus : atténuation = min(dépassement, |plage|) à ±0,2 dB, jamais plus que la plage.
