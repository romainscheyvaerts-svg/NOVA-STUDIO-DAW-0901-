# Licences des modèles de séparation de stems (lot 6)

Vérifié le 14/10/2026. Seuls les modèles sous **licence permissive**, avec une source officielle,
sont téléchargés par NOVA. Ils ne sont pas inclus dans l'installateur de Nova Studio : le module
`%LOCALAPPDATA%\NovaStudio\stems` les télécharge sur le PC de l'utilisateur, la première fois
qu'il choisit le jeu de stems concerné.

## Retenus

| Jeu de stems | Modèle | Taille | Source | Licence | Vérification |
|---|---|---|---|---|---|
| 2 et 4 stems | Demucs v4 `htdemucs` (Meta) | 84 Mo | `dl.fbaipublicfiles.com/demucs/hybrid_transformer/955717e8-8726e21a.th` (chargé par `demucs.pretrained`) | **MIT** | README de facebookresearch/demucs, section « License » : « Demucs is released under the MIT license » ; fichier LICENSE MIT (Meta Platforms). Pas de licence distincte pour les poids. |
| 6 stems (voix, batterie, basse, guitare, piano, autres) | Demucs v4 `htdemucs_6s` (Meta) | 55 Mo | `…/hybrid_transformer/5c90dfd2-34c22ccb.th` | **MIT** | Même dépôt et même licence. Le README prévient : « the piano source is not working great » ; l'interface le dit. |
| Voix lead / chœurs | « UVR-MDX-NET Karaoke 2 » (`UVR_MDXNET_KARA_2.onnx`), Ultimate Vocal Remover | 53 Mo | `github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR_MDXNET_KARA_2.onnx` (dépôt de modèles officiel d'UVR), SHA-256 `bf32e151…cbf5f4` vérifié au téléchargement | **MIT, avec crédit** | README d'Anjok07/ultimatevocalremovergui : « UVR's core developers trained all of the models provided in this package (except for the Demucs v3 and v4 4-stem models) » et « For all third-party application developers who wish to use our models, please honor the MIT license by providing credit to UVR and its developers. » Le crédit est affiché dans la fenêtre « Séparer en stems » quand on choisit « Voix lead / chœurs ». |
| (moteur) | onnxruntime / onnxruntime-gpu 1.22 (Microsoft) | 13 Mo (CPU) / 215 Mo (GPU) | PyPI | **MIT** | LICENSE de microsoft/onnxruntime. |

Réglages du modèle Karaoke 2 (n_fft 5120, dim_f 2048, dim_t 256, compensate 1,065, sortie =
« instrumental » c'est-à-dire tout sauf la voix principale) : `model_data.json` d'UVR
(`TRvlvr/application_data`), empreinte 1d64a6d2c30f709b8c9b4ce1366d96ee. Vérifié à la mesure :
la sortie du réseau contient les chœurs, la voix lead reste à -23 dB dedans.

**Réserve honnête.** Le dépôt `TRvlvr/model_repo` n'a pas de fichier LICENSE : la licence MIT
des modèles UVR vient de la phrase du README d'UVR citée plus haut, qui vise explicitement les
applications tierces. Comme pour Demucs, les données d'entraînement ne sont pas publiées (cas
général des modèles de séparation). Si Romain veut une garantie écrite, demander une
confirmation à Anjok07 (dépôt GitHub d'UVR) ; en attendant, NOVA respecte la condition posée
(crédit visible).

## Écartés (pas de licence permissive vérifiable)

| Modèle | Pourquoi |
|---|---|
| Mel-RoFormer Karaoke « aufr33 / viperx » (SDR 10,2) | Entraîné en partie par viperx (pas développeur d'UVR) : la phrase MIT d'UVR ne le couvre pas clairement ; aucune licence publiée. Les ré-exports ONNX étiquetés MIT sur Hugging Face (`Project42/mel-band-roformer-karaoke-webgpu`, `bdsqlsz/…-ONNX`) ne peuvent pas relicencier des poids dont ils ne sont pas les auteurs. |
| `becruily/mel-band-roformer-karaoke`, `becruily/bs-roformer-karaoke` (frazer + becruily) | Aucune licence déclarée sur Hugging Face : tous droits réservés par défaut. |
| `GaboxR67/MelBandRoformers` (Karaoke Gabox V1/V2) | Aucune licence déclarée. |
| `anvuew/karaoke_bs_roformer` | GPL-3.0 : copyleft, pas permissive (à reconsidérer seulement sur décision de Romain, module téléchargé à part). |
| `Sucial/MSST-WebUI` (collection de modèles) | CC-BY-NC-SA-4.0 : usage commercial interdit. |
| VR « UVR-BVE-4B_SN-44100-1/2 », « 5/6_HP-Karaoke-UVR » | Même licence MIT d'UVR que le Karaoke 2, mais architecture VR (tout le code VR d'UVR à porter en plus) ; non mesurés ici. Possibles plus tard si le Karaoke 2 ne suffit pas sur les chœurs chantés. |
