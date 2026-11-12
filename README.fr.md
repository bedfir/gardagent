English version: [README.md](README.md)

# Gardagent

[![CI](https://github.com/bedfir/gardagent/actions/workflows/ci.yml/badge.svg)](https://github.com/bedfir/gardagent/actions/workflows/ci.yml)

Gardagent est une passerelle de gouvernance auto-hébergée. Elle se place entre vos agents IA et leurs fournisseurs de
modèles ou serveurs MCP, et applique à chaque appel une identité par agent, des règles, des budgets et un journal
à empreintes chaînées, vérifiable par rapport à un point de contrôle conservé hors de la base.

Ce fichier est un résumé en français. Le [README anglais](README.md) est la référence complète (tableau de toutes les
variables d'environnement, schéma d'architecture, modèle de sécurité, limites connues) et la documentation détaillée est
en anglais dans [docs/](docs/README.md).

## Ce que fait Gardagent

- **une identité par agent** : chaque agent a sa propre clé `ga_…` ; la vraie clé du fournisseur reste dans la passerelle ;
- **des budgets journaliers atomiques** : le budget est réservé avant l'appel et réglé après, donc des requêtes simultanées
  ou en streaming sont admises selon la dépense et les estimations déjà réservées ; le coût réel peut dépasser une estimation ;
- **la validation humaine des outils MCP** : les outils en écriture, ou ceux que vous désignez, attendent la décision d'un
  administrateur ;
- **un journal chaîné en ajout seul** : chaque action est enregistrée avec des empreintes SHA-256 (pas le contenu), la base
  refuse toute modification ou suppression, et un point d'accès vérifie toute la chaîne ;
- **les modes `observe` et `enforce`** : mesurer ce que les règles bloqueraient avant de bloquer ;
- **compatibilité OpenAI et format Anthropic, pas encore vérifié auprès du fournisseur** ([vérification](tools/anthropic/README.md)) (`POST /v1/chat/completions`, `POST /v1/messages`, streaming compris) et **proxy MCP**
  (méthodes explicites, listes filtrées et refus par défaut en mode `enforce`) ;
- des jetons nominatifs d’opérateurs, des révisions immuables de politique et des approbations corrélées ;
- des limites optionnelles de débit et de concurrence par agent ;
- une API d'administration et une console web (français et anglais).

## Démarrage local

Guide prévu pour Linux x86-64, Docker Engine avec Compose v2, un shell POSIX,
Python 3, git, curl et openssl ; prévoir 8 Gio de RAM et 6 Gio de disque libre.
Aucun GPU ni clé de fournisseur nécessaire. Moins de dix minutes est un objectif,
pas encore mesuré par un tiers. La compilation et le téléchargement initial
nécessitent Internet et peuvent prendre davantage de temps.

```bash
git clone https://github.com/bedfir/gardagent.git
cd gardagent
export GARDAGENT_ADMIN_TOKEN=$(openssl rand -hex 32)
docker compose -f docker-compose.local.yml --profile local up -d --build
```

Gardez ce shell ouvert : le jeton reste dans son environnement. Le modèle est
téléchargé avant le démarrage de la passerelle. Vérifiez la disponibilité :

```bash
curl --fail-with-body http://127.0.0.1:8080/health
```

Créez un agent et capturez sa clé, affichée une seule fois, puis faites un appel :

```bash
export GA_KEY=$(curl --fail-with-body -sS http://127.0.0.1:8080/admin/agents \
  -H "Authorization: Bearer $GARDAGENT_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"local-demo","allowedModels":["qwen2.5:0.5b","demo-anthropic"],"allowedTools":["demo/*"],"dailyBudgetUsd":1}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["key"])')
test -n "$GA_KEY"
curl --fail-with-body -sS http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer $GA_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen2.5:0.5b","max_tokens":64,"messages":[{"role":"user","content":"Say hello in one sentence."}]}'
```

La première réponse peut prendre plusieurs minutes sur CPU. L'authentification
reste active. Lisez le journal puis vérifiez la chaîne :

```bash
curl --fail-with-body -sS 'http://127.0.0.1:8080/admin/ledger?order=desc&limit=5' \
  -H "Authorization: Bearer $GARDAGENT_ADMIN_TOKEN"
curl --fail-with-body -sS http://127.0.0.1:8080/admin/ledger/verify \
  -H "Authorization: Bearer $GARDAGENT_ADMIN_TOKEN"
```

La vérification doit retourner `"valid":true`. Une réécriture complète ou une
troncature nécessite un point de contrôle conservé hors de la base pour être détectée.
La console est sur <http://127.0.0.1:8080/console/> ; utilisez le jeton d'administration.
Le profil ne publie que la passerelle sur la boucle locale et utilise un mot de passe
de base volontairement factice. Ne l'exposez pas au réseau. Ollama fournit
`qwen2.5:0.5b` avec des taux comptables nuls ; cela ne mesure pas les ressources consommées.
L'API Anthropic utilise une réponse synthétique, pas un fournisseur réel.

Exemples exécutables : [OpenAI](examples/openai/README.md),
[Anthropic, format-compatible](examples/anthropic/README.md),
[MCP avec approbation](examples/mcp/README.md).
Arrêt : `docker compose -f docker-compose.local.yml --profile local down`.
Avec `-v`, la base, les poids et le journal de secours sont supprimés.
Un nouveau jeton au redémarrage change la connexion console ; les clés d'agents restent valides.

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

- seul le transport MCP Streamable HTTP POST est pris en charge ; ressources, prompts, GET, DELETE et lots sont refusés
  en mode `enforce` ; le mode `observe` relaie les violations de politique en les journalisant ;
- les limites de débit, de concurrence et d'échecs d'authentification vivent dans un seul processus et sont réinitialisées au redémarrage ;
- les migrations numérotées s'exécutent au démarrage sous verrou, dans une transaction par étape ; leur répétition ne reconstruit pas les index ;
- une réécriture cohérente ou une troncature de fin ne se détecte que par rapport à un point de contrôle conservé hors de la base ;
  les entrées postérieures à ce point nécessitent un nouvel ancrage ;
- un jeton d'opérateur prouve sa possession, pas l'identité d'une personne ; pas de SSO ni de rôles détaillés ;
- la passerelle ne filtre pas le contenu des requêtes et ne gouverne que le trafic qui passe par elle ;
- le fichier `docker-compose.tailscale.yml` n'a pas été testé, et la console n'envoie pas d'en-tête Content-Security-Policy.

## Statut

Logiciel jeune : testé de bout en bout sur un serveur de test, jamais utilisé en production ni soumis à une revue de
sécurité indépendante. Les interfaces peuvent changer entre versions ; lisez le [CHANGELOG](CHANGELOG.md) avant de mettre à jour.

La [mise à niveau depuis 0.3.0](docs/upgrade-0.3-to-1.0.md) et le [bilan v1](docs/v1-readiness.md)
détaillent les preuves et les vérifications restantes. La compatibilité est définie à partir de 1.0 dans
[la politique dédiée](docs/compatibility.md). Le tag v1 est une action humaine et exige des utilisateurs indépendants.

## Liens

[Documentation](docs/README.md) · [Contribuer](CONTRIBUTING.md) · [Sécurité](SECURITY.md) ·
[Code de conduite](CODE_OF_CONDUCT.md) · [Journal des changements](CHANGELOG.md) · [Licence Apache 2.0](LICENSE)
