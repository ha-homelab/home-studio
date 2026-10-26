# Home Studio — Démarrage rapide

[Home Studio — Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=fr#native-studio) · [Languages](README.md)

## Commencer dans Home Assistant

Pour un nouveau logement, utilisez Home Studio dans Home Assistant. Aucune installation séparée de Python, aucun YAML ni jeton d’accès ne sont nécessaires.

Pour un composant déjà généré ou personnalisé, lisez d’abord **Existing generated homes** dans le guide détaillé : la conversion n’est pas automatique.

1. Utilisez Home Assistant 2026.10 ou une version ultérieure et faites une sauvegarde.
2. Dans HACS, ajoutez `https://github.com/ha-homelab/home-studio` comme dépôt personnalisé de catégorie **Integration**. Installez la version stable de Home Studio contenant **home_floorplan.zip**, puis redémarrez Home Assistant.
3. Ouvrez **Settings → Devices & services → Add integration → Home Studio**.
4. Avec un compte administrateur, ouvrez **Home Studio** dans la barre latérale. Dessinez une pièce et associez les objets aux appareils réels de HA.
5. Cliquez sur **Save draft**, puis **Publish family view**. Ouvrez **3D Home** et vérifiez les associations avec **Dry run** avant de commander les appareils.

[Home Assistant guide — English](../home-assistant-editor.md) · [Install — English](https://ha-homelab.github.io/home-studio/install.html#native-studio)

## Facultatif : dessiner pendant la configuration de HA

L’éditeur web séparé peut servir pendant la préparation de HA. Il n’a aucune connexion en direct avec HA. Exportez le JSON, puis utilisez **Open JSON** dans Home Studio au sein de HA, vérifiez les appareils, enregistrez et publiez.

[Browser editor](https://ha-homelab.github.io/home-studio/planner/?lang=fr)

Dessinez votre logement dans le navigateur. Aucun compte n’est nécessaire. Choisissez votre langue en haut de l’éditeur.

1. Ajoutez des pièces, des murs, des portes et des fenêtres. La bibliothèque contient 211 modèles. Choisissez une palette de couleurs et, pour les objets compatibles, un motif de surface.
2. Exportez le JSON pour conserver une copie modifiable. Les brouillons restent uniquement dans ce navigateur. Changer de langue ne modifie pas votre plan.

### Facultatif : outils portables et compilateur Python

Ce parcours concerne les compilations séparées et les anciennes installations générées ; ignorez-le pour une nouvelle installation native.

Téléchargez et décompressez la boîte à outils complète. Installez Python 3.10 ou une version ultérieure. Dans le dossier des outils, exécutez :

[ZIP](https://github.com/ha-homelab/home-studio/releases/latest)

```sh
python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package
```

Le guide d’installation en anglais explique les sauvegardes, Home Assistant OS, le chemin de configuration et le redémarrage. L’éditeur web ne se connecte pas lui-même à Home Assistant et ne commande aucun appareil.

[Home Assistant](https://ha-homelab.github.io/home-studio/install.html?lang=fr) · [README](../../README.md) · [i18n](../i18n.md)

Votre plan et les identifiants d’appareils peuvent être confidentiels. Utilisez un logement fictif pour les exemples publics.

Ceci est un guide de démarrage traduit. La documentation complète et le guide illustré sont actuellement en anglais. Les corrections de traduction sont bienvenues.

## Essayer les boutons sans commande

Dans le plan Home Assistant installé, activez Dry run pour essayer les boutons sans envoyer de commandes. Les interrupteurs, l’alimentation des téléviseurs, les rideaux et les fenêtres natives de commande des serrures sont bloqués ; les états affichés restent réels. Enregistrez l’adresse du plan avec ?dry_run=1 dans les favoris de ce navigateur. Les modifications de disposition peuvent toujours être enregistrées.

[Dry run — English](../dry-run.md) · [Wiki — English](../wiki/Home.md)

MIT · [LICENSE](../../LICENSE)
