#!/bin/bash
# Script pour vérifier l'état du déploiement GitHub Pages

echo "🔍 Vérification de l'état du déploiement..."
echo ""

# 1. Vérifier le dernier commit sur main
echo "📌 Dernier commit sur main:"
git log origin/main --oneline -1

# 2. Vérifier si le code est correct localement
echo ""
echo "📂 Vérification du code local:"

echo -n "TrackHeader (boutons + supprimés) : "
if grep -q "fa-plus.*empty-slot" src/components/TrackHeader.tsx; then
    echo "❌ PROBLÈME - Boutons + encore présents"
else
    echo "✅ OK - Boutons + supprimés"
fi

echo -n "MixerView (boutons + ajoutés) : "
if grep -q "Boutons.*pour ajouter.*plugins" src/components/MixerView.tsx; then
    echo "✅ OK - Boutons + ajoutés dans INSERTS"
else
    echo "❌ PROBLÈME - Boutons + manquants"
fi

echo ""
echo "🌐 Pour vérifier le site déployé:"
echo "1. Va sur: https://github.com/romainscheyvaerts-svg/NOVA-STUDIO-DAW-0901-/actions"
echo "2. Vérifie que le dernier workflow est ✅ VERT"
echo "3. Attends 5 minutes après qu'il soit vert"
echo "4. Ouvre en navigation privée: https://romainscheyvaerts-svg.github.io/NOVA-STUDIO-DAW-0901-/"
echo ""
echo "Si toujours pas visible après 10 min, exécute:"
echo "git commit --allow-empty -m 'chore: force redeploy' && git push origin main"
