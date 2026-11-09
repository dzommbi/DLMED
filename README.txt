DLMed — correctif de mise à jour automatique (v114)

Remplacez ces cinq fichiers à la racine du dépôt GitHub :
- sw.js
- pwa-update.js
- index.html
- quiz.html
- exam.html

Puis validez les changements sur main et attendez le déploiement GitHub Pages.

Le nouveau Service Worker :
- passe en cache v114 ;
- réessaie trois fois les fichiers essentiels avant d’abandonner une installation ;
- ne bloque plus son activation si une icône ou une page légale optionnelle échoue ;
- récupère les pages et scripts depuis le réseau en contournant le cache HTTP ;
- supprime uniquement les anciens caches portant le préfixe DLMed.

Aucun cookie, session Google, donnée Supabase ou réponse de QCM n’est supprimé par ce correctif.
