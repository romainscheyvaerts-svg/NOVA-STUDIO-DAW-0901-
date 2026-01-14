#!/bin/bash
# Script pour ajouter un timestamp visible dans la page de vérification

echo "🔍 Création d'un script de vérification de déploiement..."

# Ajouter un timestamp dans public/ pour vérifier le déploiement
mkdir -p public
echo "{\"deployed_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\", \"test\": \"red_dot_deployed\"}" > public/deploy-info.json

echo "✅ Fichier de vérification créé : public/deploy-info.json"
echo ""
echo "Après déploiement, vérifie ici :"
echo "https://romainscheyvaerts-svg.github.io/NOVA-STUDIO-DAW-0901-/deploy-info.json"
