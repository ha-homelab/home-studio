# Home Studio — Démarrage rapide

[Home Studio](https://ha-homelab.github.io/home-studio/planner/?lang=fr) · [Languages](README.md)

Dessinez votre logement dans le navigateur. Aucun compte n’est nécessaire. Choisissez votre langue en haut de l’éditeur.

1. Ajoutez des pièces, des murs, des portes et des fenêtres. La bibliothèque contient 195 modèles. Choisissez une palette de couleurs et, pour les objets compatibles, un motif de surface.
2. Exportez le JSON pour conserver une copie modifiable. Les brouillons restent uniquement dans ce navigateur. Changer de langue ne modifie pas votre plan.

Téléchargez et décompressez la boîte à outils complète. Installez Python 3.10 ou une version ultérieure. Dans le dossier des outils, exécutez :

[ZIP](https://github.com/ha-homelab/home-studio/archive/refs/heads/main.zip)

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
