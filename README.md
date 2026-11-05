# Capri Web

Un compagnon Capri dans le navigateur, en Next.js : elle s'anime, s'endort, se laisse attraper et lancer, et répond quand on lui parle.

## Lancer

```bash
npm install
cp .env.example .env.local
npm run dev
```

Ouvre **Paramètres**, choisis ton fournisseur, colle ta clé et choisis un modèle. Tout fournisseur compatible OpenAI fonctionne, y compris Ollama ou un serveur local. La clé, les réglages et les discussions sont gardés dans `data/capri.db` (SQLite) sur cette machine, lisible seulement par ton compte. La clé y est en clair et n'est jamais renvoyée à la page. `.env.local` reste possible en repli (voir `.env.example`).

Le micro passe par la reconnaissance vocale du navigateur (Chrome, Edge ou Safari, pas Firefox). Le son part au service vocal du navigateur : Google pour Chrome, Apple pour Safari.

Il faut Node 22.18 ou plus récent. `npm test` lance tous les tests, sans réseau et sans toucher à tes données.

## Données

`data/capri.db` contient tout : pense à le sauvegarder, et ne le partage pas.

Un navigateur qui avait encore ses données dans `localStorage` les transfère à sa première ouverture, puis les efface. Une copie brute reste dans `data/localStorage-*.json`, avec les clés en clair : supprime-la quand tout est bon. Si un deuxième navigateur arrive ensuite, il complète ce qui est encore par défaut sans rien écraser, et sa discussion reste dans ce fichier de copie.

Toutes les discussions restent dans la base. Seuls les derniers messages, selon le réglage **Mémoire**, partent au modèle.

## Quotas

Le panneau **Quotas** n'affiche que ce que les fournisseurs renvoient, jamais d'estimation. OpenRouter (crédits de la clé) et ElevenLabs (caractères) se relisent chaque minute. Les autres donnent leurs limites dans les en-têtes de chaque réponse, donc le relevé date du dernier message. Si un fournisseur n'envoie rien, le panneau le dit.

**Avant de mettre en ligne :** les routes `/api/*` refusent tout ce qui ne vient pas de cette machine, donc l'app ne marche pas une fois déployée. C'est voulu : elles tiennent tes clés et lancent des outils MCP.

## Outils MCP

Ajoute un serveur dans **Paramètres > MCP** : nom, URL, cas d'usage et token si besoin. Le cas d'usage aide Capri à choisir le bon outil. Le token est écrit en clair dans `mcp.json`, lisible seulement par ton compte. Pour un serveur local (une commande) ou un autre en-tête, édite `mcp.json` à la main (voir `mcp.example.json`) : ce fichier est ignoré par git. La page ne peut ajouter que des URL, jamais une commande. Capri donne des nouvelles à chaque étape et demande ton accord avant chaque outil, sauf ceux marqués « Toujours ». Il faut un modèle qui gère l'appel d'outils.

**Infos générales, sans rien configurer :** le serveur intégré `Capri Infos` donne l'heure, la météo d'une ville ([Open-Meteo](https://open-meteo.com/)), les titres de l'actualité ([France 24](https://www.france24.com/)) et les résumés de [Wikipédia](https://www.wikipedia.org/), fait les calculs et conversions, et gère des rappels et minuteurs gardés dans `data/capri.db`, sans clé ni compte. Ces outils ne demandent pas ton accord : retire-les de **Toujours autorisés** pour qu'ils le demandent. Seuls le nom de la ville et le sujet demandés sortent de ta machine ; calculs et rappels restent en local. Le réglage **Utiliser les outils MCP** les coupe avec les autres.

## Publier ou contribuer

Le `.gitignore` écarte les clés, `mcp.json`, `data/` et les sauvegardes, mais il ne protège que les fichiers pas encore suivis. Avant un commit, relis `git status`. Si une clé part quand même dans un commit, révoque-la : la supprimer ensuite ne l'efface pas de l'historique.

## Licence et crédits

Basé sur [Capri](https://github.com/lachydotmcg/capri-desktop) de Lachy. Sprites et texte du personnage viennent de ce projet, art par son artiste. Licence PolyForm Noncommercial 1.0.0 (voir `LICENSE.md`) : le code est public et modifiable, mais pas d'usage commercial, donc ce n'est pas une licence open source au sens de l'OSI. Toute copie doit garder `LICENSE.md` et créditer le projet d'origine. Polices Barlow et Share Tech Mono sous licence SIL OFL (voir `public/fonts/`).

Projet de fan non officiel, ni approuvé ni soutenu par CD PROJEKT RED, les ayants droit de l'anime ou ses doubleurs.
