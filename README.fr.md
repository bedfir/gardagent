English version: [README.md](README.md)

# Gardagent

[![CI](https://github.com/bedfir/gardagent/actions/workflows/ci.yml/badge.svg)](https://github.com/bedfir/gardagent/actions/workflows/ci.yml)

Gardagent est une passerelle de gouvernance auto-hébergée. Elle se place entre vos agents IA et leurs fournisseurs de
modèles ou serveurs MCP, et applique à chaque appel une identité par agent, des règles, des budgets et un journal
dont toute altération est détectable.

Ce fichier est un résumé en français. Le [README anglais](README.md) est la référence complète (tableau de toutes les
variables d'environnement, schéma d'architecture, modèle de sécurité, limites connues) et la documentation détaillée est
en anglais dans [docs/](docs/README.md).

## Ce que fait Gardagent

- **une identité par agent** : chaque agent a sa propre clé `ga_…` ; la vraie clé du fournisseur reste dans la passerelle ;
- **des budgets journaliers atomiques** : le budget est réservé avant l'appel et réglé après, donc des requêtes simultanées
  ou en streaming ne peuvent pas dépasser le plafond ;
- **la validation humaine des outils MCP** : les outils en écriture, ou ceux que vous désignez, attendent la décision d'un
  administrateur ;
- **un journal chaîné en ajout seul** : chaque action est enregistrée avec des empreintes SHA-256 (pas le contenu), la base
  refuse toute modification ou suppression, et un point d'accès vérifie toute la chaîne ;
- **les modes `observe` et `enforce`** : mesurer ce que les règles bloqueraient avant de bloquer ;
- **compatibilité OpenAI et format Anthropic, pas encore vérifié auprès du fournisseur** ([vérification](tools/anthropic/README.md)) (`POST /v1/chat/completions`, `POST /v1/messages`, streaming compris) et **proxy MCP**
  (outils `tools/call`) ;
- une API d'administration et une console web (français et anglais).

## Démarrage rapide

Prérequis : Docker avec Compose, `git`, `curl`, et une clé d'API pour un fournisseur compatible OpenAI.

```bash
git clone https://github.com/bedfir/gardagent.git
cd gardagent
cp .env.example .env
sed -i "s|^GARDAGENT_ADMIN_TOKEN=.*|GARDAGENT_ADMIN_TOKEN=$(openssl rand -hex 32)|; s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 16)|" .env
# Éditez .env : UPSTREAM_BASE_URL et UPSTREAM_API_KEY (URL sans /v1), puis GARDAGENT_PRICES pour vos modèles.
docker compose up -d --build
curl http://127.0.0.1:8080/health
```

Le `docker-compose.yml` racine publie la passerelle sur `127.0.0.1:8080` uniquement : ne le changez pas en `8080:8080` sur
une machine partagée ; pour un déploiement en réseau, utilisez le kit [`deploy/`](deploy/README.md).

Créez un agent. **Un budget est obligatoire** : `dailyBudgetUsd` doit être un nombre positif ; pour un agent sans plafond,
il faut écrire explicitement `"dailyBudgetUsd": 0, "unlimited": true` (sans budget, la requête est refusée avec un 400).

```bash
export GARDAGENT_ADMIN_TOKEN=$(sed -n 's/^GARDAGENT_ADMIN_TOKEN=//p' .env)

curl -s -X POST http://127.0.0.1:8080/admin/agents \
  -H "Authorization: Bearer $GARDAGENT_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"agent-demo","allowedModels":["deepseek-v4.1-flash"],"dailyBudgetUsd":2}'
```

La réponse contient la clé de l'agent (`key`). **Elle n'est affichée qu'une seule fois.** Utilisez ensuite n'importe quel
client compatible OpenAI en changeant seulement l'URL de base et la clé :

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8080/v1", api_key="ga_...")
client.chat.completions.create(model="deepseek-v4.1-flash", messages=[{"role": "user", "content": "Bonjour"}])
```

Pour le SDK Anthropic, `base_url="http://127.0.0.1:8080"` (le SDK ajoute `/v1/messages` lui-même). Lisez le journal avec
`GET /admin/ledger?order=desc&limit=5`, vérifiez la chaîne avec `GET /admin/ledger/verify`, et ouvrez la console sur
<http://127.0.0.1:8080/console/> (connexion avec la valeur de `GARDAGENT_ADMIN_TOKEN`).

Une fois la première version publiée, l'image sera disponible avec `docker pull ghcr.io/bedfir/gardagent:<version>` ;
d'ici là, construisez-la depuis les sources comme ci-dessus.

## Rapport d'usage

`pnpm report` lit l'API d'administration et écrit un rapport d'usage au format Markdown (en anglais) : résumé de la période,
agents (modèles et outils MCP autorisés, budget journalier, dépense), requêtes refusées par motif, ce que le mode
observation aurait bloqué, quelques remarques de configuration et intégrité du journal. Il ne fait que lire et n'affiche
jamais le jeton d'administration.

```bash
pnpm install && pnpm build
export GARDAGENT_ADMIN_TOKEN=...   # le même jeton que la passerelle
pnpm report --url http://127.0.0.1:8080 --days 7 --out report.md   # --days : 1 à 90
```

## Limites principales

La liste complète est dans le [README anglais](README.md#known-limitations). Les principales :

- la gouvernance MCP ne couvre que `tools/call` ; les autres méthodes (`resources/read`, `prompts/get`, …) sont relayées
  sans règle ni ligne de journal ;
- pas de limitation de débit par agent (seuls les budgets journaliers plafonnent) ;
- le limiteur d'échecs d'authentification vit dans la mémoire d'un seul processus ;
- les migrations de schéma s'exécutent au démarrage, sans `CONCURRENTLY` ;
- toute altération du journal est détectable, mais il n'est pas infalsifiable : un administrateur de la base peut le réécrire, et la
  tête de chaîne n'est pas ancrée à l'extérieur ;
- la passerelle ne filtre pas le contenu des requêtes et ne gouverne que le trafic qui passe par elle ;
- le fichier `docker-compose.tailscale.yml` n'a pas été testé, et la console n'envoie pas d'en-tête Content-Security-Policy.

## Statut

Logiciel jeune : testé de bout en bout sur un serveur de test, jamais utilisé en production ni soumis à une revue de
sécurité indépendante. Les interfaces peuvent changer entre versions ; lisez le [CHANGELOG](CHANGELOG.md) avant de mettre à jour.

## Liens

[Documentation](docs/README.md) · [Contribuer](CONTRIBUTING.md) · [Sécurité](SECURITY.md) ·
[Code de conduite](CODE_OF_CONDUCT.md) · [Journal des changements](CHANGELOG.md) · [Licence Apache 2.0](LICENSE)
