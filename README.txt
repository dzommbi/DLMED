DLMed — questions sans réponse en mode Examen (v115)

Remplacez les fichiers suivants à la racine du dépôt GitHub :
- exam.js
- exam.html
- sw.js
- index.html
- quiz.html
- pwa-update.js

Sur la dernière question, la remise de copie est bloquée s'il reste des réponses vides. Le site affiche en français le nombre de questions manquantes, revient à la première question sans réponse et met ces numéros en évidence. Après réponse, une nouvelle tentative de remise conduit à la prochaine question vide. Quand elles sont toutes répondues, la correction suit le parcours normal.

Le Service Worker passe en version v115 afin que les anciens appareils installent ces fichiers. Enregistrez les changements sur la branche main, puis attendez le déploiement GitHub Pages.
