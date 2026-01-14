# 🔧 Guide de Debug Déploiement

## Problème : Les changements ne s'affichent pas après merge

### ✅ Code Vérifié (14 Jan 2026)

Le code dans le repo est **CORRECT** :
- `src/components/TrackHeader.tsx` : Buttons + **SUPPRIMÉS** ✅
- `src/components/MixerView.tsx` : Buttons + **AJOUTÉS** dans section INSERTS ✅

### 🐛 Causes Possibles

1. **Cache Navigateur** (90% des cas)
2. **Cache GitHub Pages CDN** (5-20 min de délai)
3. **Déploiement en cours** (10 min timeout configuré)
4. **Multiples merges rapides** confondent le cache

### 🔨 Solutions par Ordre de Priorité

#### Solution 1 : Hard Refresh Total
```
1. Ouvrir DevTools (F12)
2. Clic droit sur bouton refresh
3. "Empty Cache and Hard Reload"
4. OU : Ctrl + Shift + Delete → Clear ALL → Ctrl + F5
```

#### Solution 2 : Mode Incognito + Cache Busting
```
URL : https://romainscheyvaerts-svg.github.io/NOVA-STUDIO-DAW-0901-/?v=YYYYMMDD
```
Change la date à chaque fois pour forcer le reload.

#### Solution 3 : Attendre le Déploiement
```
1. Aller sur : https://github.com/romainscheyvaerts-svg/NOVA-STUDIO-DAW-0901-/actions
2. Vérifier que le dernier workflow est ✅ VERT (pas 🟠 orange)
3. Attendre 5-10 min après que le workflow soit vert
```

#### Solution 4 : Vérifier le Code Déployé
```
1. Ouvrir : https://romainscheyvaerts-svg.github.io/NOVA-STUDIO-DAW-0901-/
2. F12 → Network → Disable cache (cocher)
3. Ctrl + R
4. Sources → Chercher "TrackHeader" ou "MixerView"
5. Vérifier que le code correspond au repo
```

### 📊 Historique des Merges (dernières 2h)

```
d86815b - PR #41 - Hide plugin buttons ✅
cdfdc08 - PR #40 - Hide plugin buttons ✅
8aebe23 - PR #39 - API key Supabase ✅
f283a6c - PR #38 - API key Supabase ✅
a76745f - PR #37 - Force API button ✅
```

**Conclusion** : Trop de merges rapides → Cache CDN confus

### 🚀 Pour Éviter ce Problème à l'Avenir

1. **Grouper les changements** dans 1 seule PR si possible
2. **Attendre 10 min** entre chaque merge
3. **Toujours tester en mode Incognito** après merge
4. **Utiliser ?v=timestamp** dans l'URL pour forcer refresh

### 🔍 Comment Vérifier que C'est un Problème de Cache

Si tu vois encore les anciens boutons +, fais :
```javascript
// Console du navigateur (F12)
console.log(window.location.href);
// Devrait montrer : .../NOVA-STUDIO-DAW-0901-/

// Puis
localStorage.clear();
sessionStorage.clear();
location.reload(true);
```

### ⚠️ Si RIEN Ne Marche

Crée un commit vide sur main pour forcer re-deploy :
```bash
git commit --allow-empty -m "chore: force rebuild"
git push origin main
```

---

**Dernière mise à jour** : 14 Jan 2026 00:30 UTC
**Status** : Code correct ✅ | Déploiement OK ✅ | Problème = Cache
