English version: [README.md](README.md)

# Gardagent

[![CI](https://github.com/bedfir/gardagent/actions/workflows/ci.yml/badge.svg)](https://github.com/bedfir/gardagent/actions/workflows/ci.yml)

Gardagent est une passerelle de gouvernance auto-hébergée placée entre vos agents IA et leurs fournisseurs de modèles et
serveurs MCP. Elle applique à chaque appel une identité par agent, des règles, des budgets et un journal à empreintes
chaînées.

## Pourquoi

Les agents IA partagent souvent une seule clé de fournisseur, et rien n'enregistre ni ne limite ce que chacun fait.
Gardagent donne à chaque agent sa propre clé, conserve la vraie clé du fournisseur au sein de la passerelle, contrôle
les modèles et outils qu'un agent peut utiliser et combien il peut dépenser par jour, et écrit chaque action dans un
journal en ajout seul chaîné par empreintes. Vous modifiez l'URL de base et la clé dans la configuration de l'agent ;
le code de l'agent ne change pas.

## Fonctionnalités

- **Une identité par agent** : chaque agent a sa propre clé `ga_...` ; la vraie clé du fournisseur reste dans la passerelle.
- **Budgets journaliers atomiques** : le budget est réservé avant chaque appel et réglé après, donc les admissions
  simultanées et en streaming sont vérifiées par rapport à la dépense et aux estimations déjà réservées.
- **Validation humaine des outils MCP** : les outils en écriture, ou ceux que vous listez, attendent la décision d'un
  administrateur avant de s'exécuter.
- **Journal en ajout seul, chaîné par empreintes** : chaque action est enregistrée avec des empreintes SHA-256 (pas le
  contenu) ; la base refuse les mises à jour et suppressions, et un point d'accès vérifie toute la chaîne.
- **Modes `observe` et `enforce`** : mesurer ce que les règles bloqueraient avant de le bloquer.
- **Compatibilité OpenAI** et **format Anthropic compatible, vérifié une fois auprès du fournisseur sur un modèle, en
  mode normal et streaming** ([vérification](tools/anthropic/README.md)) : `POST /v1/chat/completions` et
  `POST /v1/messages`, streaming compris.
- **Proxy MCP** : gouvernance explicite des messages Streamable HTTP, capacités et listes d'outils filtrées, refus par
  défaut des méthodes non prises en charge ([matrice](docs/mcp-matrix.md)).
- **Opérateurs nommés et révisions immuables de politique** : les preuves d'admission et d'approbation enregistrent
  l'attribution des identifiants ([limites](docs/mandate.md)).
- **Limites optionnelles par agent** : admissions par minute glissante et réponses simultanées, partagées entre les
  points d'accès ([détails](docs/rate-limits.md)).
- **Vérification hors ligne et points de contrôle externes** : [exporter et vérifier](docs/verify.md) indépendamment de
  la base de données.
- **API d'administration et console** (Vue 3, français et anglais) : agents, dépenses, consultation et filtrage du
  journal, export CSV, vérification d'intégrité.

## Démarrage local rapide

Guide rédigé pour Linux x86-64, Docker Engine avec Compose v2, un shell POSIX, Python 3,
`git`, `curl` et `openssl` ; prévoir 8 Gio de RAM et 6 Gio de disque libre. L'inférence sur CPU ne nécessite aucun GPU.
Moins de dix minutes est un objectif : un passage d'un mainteneur a pris environ 3,7 minutes sur une petite machine avec
les caches Docker déjà chauds, et personne d'autre ne l'a encore mesuré ([méthode et chiffres](docs/quickstart-timing.md)).
La première compilation et le premier téléchargement de modèle nécessitent un accès à Internet et peuvent prendre plus
de temps. Aucune clé de fournisseur n'est nécessaire. Ollama sert `qwen2.5:0.5b` ; les taux comptables locaux sont
nuls, ce qui ne mesure ni l'électricité ni le matériel.

```bash
git clone https://github.com/bedfir/gardagent.git
cd gardagent
export GARDAGENT_ADMIN_TOKEN=$(openssl rand -hex 32)
docker compose --env-file /dev/null -f docker-compose.local.yml --profile local up -d --build
```

Gardez ce shell ouvert : le jeton reste dans son environnement, pas dans un fichier de configuration.
`--env-file /dev/null` empêche Compose de charger un fichier `.env` local.
La commande télécharge le modèle avant de démarrer la passerelle. Vérifiez la disponibilité jusqu'à ce que `/health`
renvoie HTTP 200 avec `"status":"ok"` et `"database":"up"` :

```bash
curl --fail-with-body http://127.0.0.1:8080/health
```

Créez un agent via l'API d'administration authentifiée, puis capturez sa clé unique :

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

La première inférence peut prendre plusieurs minutes sur un CPU. L'authentification reste active ;
la fausse clé `UPSTREAM_API_KEY` dans Compose ne sert que pour le serveur local.
Lisez l'appel dans le journal et vérifiez la chaîne :

```bash
curl --fail-with-body -sS 'http://127.0.0.1:8080/admin/ledger?order=desc&limit=5' \
  -H "Authorization: Bearer $GARDAGENT_ADMIN_TOKEN"
curl --fail-with-body -sS http://127.0.0.1:8080/admin/ledger/verify \
  -H "Authorization: Bearer $GARDAGENT_ADMIN_TOKEN"
```

La vérification doit renvoyer `"valid":true`. Elle contrôle la chaîne stockée ; détecter une réécriture complète ou
une troncature de fin nécessite un point de contrôle conservé hors de la base.
Ouvrez <http://127.0.0.1:8080/console/> et connectez-vous avec le jeton d'amorçage.
Seule la passerelle est publiée, sur la boucle locale. Ce profil est une démonstration locale ;
son mot de passe de base est volontairement factice. Le point d'accès Anthropic utilise une fixture synthétique,
tandis que les appels OpenAI utilisent Ollama. N'exposez pas ce profil à un réseau.

Exécutez les exemples [OpenAI SDK](examples/openai/README.md), [Anthropic SDK (format-compatible)](examples/anthropic/README.md)
et [MCP avec approbation](examples/mcp/README.md) dans le même shell.
Arrêtez avec `docker compose -f docker-compose.local.yml --profile local down`.
L'ajout de `-v` supprime la base locale, les poids du modèle et le journal de secours. Un nouveau jeton d'amorçage
lors d'un démarrage ultérieur modifie la connexion à la console ; les clés d'agents existantes restent valides.

### Image publiée

Lorsqu'une version est publiée, son image est disponible dans le GitHub Container Registry :

```bash
docker pull ghcr.io/bedfir/gardagent:<version>   # par exemple 0.4.1, ou "latest"
```

Cela ne fonctionne qu'après la première publication par le workflow de release ; jusque-là, compilez depuis les sources
comme indiqué ci-dessus. L'image contient la passerelle et la console et a besoin d'une base PostgreSQL (`DATABASE_URL`) ;
les fichiers Compose de ce dépôt construisent l'image à partir du `Dockerfile` et constituent la méthode prise en charge
pour l'exécuter.

### Rapport d'usage

`pnpm report` lit l'API d'administration et écrit un rapport d'usage au format Markdown : un résumé de la période, les
agents avec leurs modèles autorisés, outils MCP, budget journalier et dépense, les requêtes refusées par motif, ce que le
mode observe aurait bloqué, quelques notes de configuration (jokers, budgets manquants, budget presque épuisé, trafic à
clé invalide, intégrité du journal) et une courte déclaration de périmètre. Il ne fait que lire des données ; il ne
modifie rien et n'affiche jamais le jeton d'administration.

```bash
pnpm install && pnpm build
export GARDAGENT_ADMIN_TOKEN=...   # le même jeton que la passerelle
pnpm report --url http://127.0.0.1:8080 --days 7 --out report.md   # --days : 1 à 90
```

## Configuration

La configuration se lit dans les variables d'environnement. Le profil local les fournit directement ; les autres
fichiers Compose utilisent `.env`. Seules `UPSTREAM_BASE_URL`,
`UPSTREAM_API_KEY` et `GARDAGENT_ADMIN_TOKEN` sont requises. Les valeurs invalides arrêtent la passerelle au démarrage
avec un message explicite. Le comportement détaillé de chaque groupe est décrit dans
[docs/reference.md](docs/reference.md).

| Variable | Valeur par défaut | Description |
| --- | --- | --- |
| `UPSTREAM_BASE_URL` | requis | URL du fournisseur compatible OpenAI, sans le `/v1` final. |
| `UPSTREAM_API_KEY` | requis | Clé du fournisseur ; elle ne quitte jamais la passerelle. |
| `ANTHROPIC_UPSTREAM_BASE_URL` | `UPSTREAM_BASE_URL` | URL du fournisseur pour `POST /v1/messages`, sans `/v1`. |
| `ANTHROPIC_UPSTREAM_API_KEY` | `UPSTREAM_API_KEY` | Clé du fournisseur pour le point d'accès Anthropic. |
| `UPSTREAM_FORWARD_HEADERS` | `x-opencode-session` | En-têtes clients transférés vers le fournisseur, séparés par des virgules. `authorization`, `x-api-key`, `cookie`, `host`, `content-length`, `content-type` et les en-têtes hop-by-hop ne sont jamais transférés. |
| `UPSTREAM_TIMEOUT_MS` | `120000` | Durée maximale d'un appel au fournisseur. |
| `GARDAGENT_ADMIN_TOKEN` | requis | Jeton pour `/admin/*` et la console. Au moins 32 caractères (`openssl rand -hex 32`) ; les valeurs plus courtes sont refusées au démarrage. |
| `DATABASE_URL` | aucune | URL PostgreSQL. Sans elle, la passerelle utilise un stockage en mémoire, perdu à l'arrêt (démos et tests uniquement). Les fichiers Compose la définissent. |
| `GARDAGENT_MODE` | `enforce` | `enforce` bloque les violations de politique ; `observe` les transfère et journalise `observed:<reason>`. |
| `GARDAGENT_MCP_SERVERS` | aucune | Objet JSON des serveurs MCP gouvernés : `{"name":{"url":"...","headers":{},"readTools":[]}}`. Sans lui, la route `/mcp` n'existe pas. |
| `GARDAGENT_PRICES` | tableau indicatif intégré | Objet JSON des prix en USD par million de jetons : `{"model":{"input":0.15,"output":0.6}}`. Les modèles non listés utilisent une valeur par défaut de 10 / 30. |
| `GARDAGENT_DEFAULT_MAX_OUTPUT_TOKENS` | `1024` | Nombre de jetons de sortie supposés pour la réservation de budget quand une requête ne fixe pas de maximum. |
| `GARDAGENT_APPROVAL_TIMEOUT_MS` | `120000` | Durée d'attente d'un outil avant qu'une décision humaine n'expire. |
| `GARDAGENT_DB_OUTAGE` | `fail-closed` | `fail-closed` ou `fail-open`. Le mode fail-open n'est honoré qu'avec `GARDAGENT_MODE=observe`. |
| `GARDAGENT_LEDGER_SPOOL` | `/app/spool/ledger.jsonl` | Fichier de secours pour les lignes de journal que la base n'a pas pu recevoir. |
| `GARDAGENT_SPOOL_MAX_BYTES` | `67108864` | Limite de taille du fichier de secours (minimum 4096). |
| `GARDAGENT_DB_CALL_TIMEOUT_MS` | `600` | Plafond d'un appel à la base sur le chemin de la requête (50 à 60000). |
| `GARDAGENT_DB_PROBE_TIMEOUT_MS` | `800` | Plafond de la sonde de santé (50 à 60000). |
| `GARDAGENT_DB_CONNECT_TIMEOUT_MS` | `2000` | Plafond de l'attente d'une connexion en pool (50 à 60000). |
| `GARDAGENT_AGENT_CACHE_TTL_MS` | `30000` | Durée de vie d'un agent mis en cache pendant une panne en mode fail-open (1000 à 600000). |
| `GARDAGENT_AUTH_FAIL_LIMIT` | `10` | Nombre d'échecs d'authentification par adresse source et fenêtre avant un HTTP 429 ; `0` désactive la limite. |
| `GARDAGENT_AUTH_FAIL_WINDOW_MS` | `60000` | Longueur de la fenêtre de comptage des échecs (1000 à 3600000). |
| `GARDAGENT_TRUST_PROXY` | `false` | Comment l'adresse client est déduite de `X-Forwarded-For` : `true`, `false`, ou une liste d'adresses de proxy ou de CIDR séparés par des virgules. Ne mettez `true` que si un proxy inverse qui réécrit cet en-tête est le seul moyen d'atteindre la passerelle. |
| `GARDAGENT_ADMIN_ALLOWED_CIDRS` | aucune | Non appliqué par l'application. Utilisé par le proxy Caddy de `deploy/` ; quand la passerelle écoute au-delà de la boucle locale et que ce paramètre n'est pas défini, l'application se contente d'avertir au démarrage. |
| `GARDAGENT_CONSOLE_DIR` | défini dans l'image | Répertoire de la console compilée ; la console n'est servie que s'il existe. |
| `PORT` | `8080` | Port d'écoute. |
| `HOST` | `0.0.0.0` | Adresse d'écoute (dans Docker, elle doit être `0.0.0.0` ; le fichier Compose racine publie le port uniquement sur `127.0.0.1`). |
| `POSTGRES_PASSWORD` | requis par Compose | Mot de passe de la base de données fournie (Compose uniquement). |

La pile `deploy/` ajoute `GARDAGENT_DOMAIN`, `GARDAGENT_TLS` et `GARDAGENT_ADMIN_ALLOWED_CIDRS` pour son proxy Caddy ;
voir [deploy/README.md](deploy/README.md).

## Architecture

```text
 agent (OpenAI / Anthropic SDK, MCP client)           administrator
        |  ga_... key                                      |  admin token
        v                                                  v
 +--------------------------------------------------------------------+
 |  Gardagent gateway (Fastify)                                       |
 |  /v1/chat/completions  /v1/messages  /mcp/<server>   /admin  /console
 |    identify agent -> rules (models, tools) -> approval (MCP)       |
 |    -> reserve budget -> forward -> settle budget -> ledger row     |
 +---------+------------------------+------------------+--------------+
           |                        |                  |
           v                        v                  v
     model provider(s)        MCP server(s)        PostgreSQL
     (real key held here)     (headers held here)  agents, budgets, approvals,
                                                    append-only hash-chained ledger
```

La passerelle est un seul processus Node.js. La vraie clé du fournisseur et les en-têtes des serveurs MCP n'existent que
dans sa configuration.

## Modèle de sécurité

Ce que Gardagent est conçu pour garantir, pour le trafic qui passe par elle :

- Les agents ne voient jamais la clé du fournisseur ni les identifiants des serveurs MCP ; chaque agent a sa propre clé
  révocable (désactiver un agent ou faire tourner sa clé prend effet immédiatement).
- En mode enforce, une requête est refusée sauf si l'agent est actif et le modèle dans sa liste blanche ; un `tools/call`
  MCP est refusé sauf si l'outil est dans les `allowedTools` de l'agent. Les outils en écriture attendent une approbation
  humaine.
- En mode enforce, les vérifications d'admission au budget journalier incluent de manière atomique la dépense existante
  et les estimations réservées. L'usage réel peut dépasser une estimation ; ce n'est pas un plafond strict sur les
  factures du fournisseur.
- Chaque action gouvernée et chaque modification administrative sont enregistrées dans un journal en ajout seul que la
  base refuse de mettre à jour ou de supprimer, chaîné par empreintes pour que `GET /admin/ledger/verify` détecte les
  hachages, liens ou continuité de séquence cassés. Le journal stocke les empreintes des requêtes et réponses, pas leur
  contenu.
- Par défaut, si le journal ne peut pas être écrit, la requête est refusée (fail-closed) ; elle n'est pas servie sans
  laisser de trace.
- Le jeton d'administration doit faire au moins 32 caractères, et les échecs d'authentification sont limités par adresse
  source.

Ce qu'elle ne garantit pas :

- Ce n'est pas un bac à sable et elle n'inspecte pas le contenu des prompts ou des arguments d'outils (pas de filtrage
  de contenu, pas de défense contre l'injection de prompt). Tout ce qu'un agent est autorisé à faire, il peut le faire.
- Elle ne gouverne que le trafic qui passe par elle. Un agent qui peut atteindre directement un fournisseur ou un serveur
  MCP peut la contourner.
- La chaîne est vérifiable, pas inviolable : quelqu'un ayant un accès administratif à la base peut encore la modifier, et
  la vérification interne seule accepte une réécriture cohérente avec elle-même ou une troncature de fin. Conservez des
  points de contrôle hors de la base pour détecter les modifications par rapport à leur préfixe ancré ; les entrées
  ultérieures nécessitent un point de contrôle ultérieur.
- Les coûts sont calculés à partir de l'usage rapporté par le fournisseur et des prix que vous configurez ; ce ne sont
  pas les factures du fournisseur.
- Les jetons d'opérateur nommés et l'amorçage identifient l'identifiant utilisé, pas un humain. Il n'y a pas de SSO ni de
  système de rôles fin ; seul l'amorçage gère les opérateurs.
- Le fichier Compose racine sert du HTTP simple sur la boucle locale. Le TLS et une liste blanche d'administration
  viennent de la pile `deploy/`.
- Ce n'est pas un système de sécurité fonctionnelle et elle ne doit pas être utilisée dans une boucle de sécurité (voir
  [docs/industrial-setup.md](docs/industrial-setup.md)).

Pour signaler une vulnérabilité, voir [SECURITY.md](SECURITY.md).

## Limites connues

- MCP ne prend en charge que le POST Streamable HTTP ; GET/DELETE, lots, ressources et prompts sont refusés en mode
  enforce. Le mode observe relaie les violations de politique avec des preuves ; un encadrement malformé reste refusé.
  Voir la [matrice](docs/mcp-matrix.md).
- Les compteurs de débit par agent vivent dans un seul processus et sont réinitialisés au redémarrage. Le déploiement
  multi-instance et les autres protocoles (par exemple A2A) ne sont pas pris en charge. Les limites sont optionnelles et
  illimitées par défaut.
- Les migrations de schéma numérotées s'exécutent au démarrage, une transaction par étape sous un verrou consultatif,
  avant de servir le trafic. Les réexécutions ne rejouent pas le DDL applicatif ; un nouveau DDL peut bloquer. Les
  [timings historiques](docs/migration-timing.md) ne sont pas des timings v1.
- Le limiteur d'échecs d'authentification vit dans la mémoire d'un seul processus : les compteurs sont réinitialisés au
  redémarrage et ne sont pas partagés entre les instances de la passerelle.
- Une requête portant une clé d'agent bien formée mais incorrecte est lue en entier (jusqu'à 10 Mio) avant d'être
  refusée, jusqu'à ce que la limite par adresse s'applique ; les requêtes sans clé bien formée sont limitées à 64 Kio.
- Les coûts de budget sont estimés avant l'appel (taille de la requête / 4 pour l'entrée plus le plafond de sortie) et
  réglés avec l'usage rapporté par le fournisseur ensuite. Sur `/v1/messages`, le corps est transféré tel quel, et les
  jetons de cache sont comptés au prix des jetons d'entrée ordinaires.
- Pendant une panne de base de données, les refus qui ont besoin de la base ne laissent aucune ligne de journal, et en
  mode `fail-open` le plafond journalier n'est pas appliqué.
- La langue par défaut de la console d'administration suit le navigateur (français ou anglais).
- `docker-compose.tailscale.yml` (accès privé via Tailscale) n'a pas été testé.
- Gardagent n'a pas été utilisé en production par les mainteneurs ; voir le Statut.

## Documentation

- [Mise à niveau depuis 0.3.0](docs/upgrade-0.3-to-1.0.md) et [preuves et lacunes de préparation v1](docs/v1-readiness.md)
- [docs/README.md](docs/README.md) : index de la documentation
- [docs/self-hosting.md](docs/self-hosting.md) et [deploy/README.md](deploy/README.md) : faire tourner Gardagent sur votre propre hôte
- [docs/reference.md](docs/reference.md) : gouvernance MCP, modes, gestion des pannes, approbations, API d'administration, console
- [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- [CHANGELOG.md](CHANGELOG.md) et [LICENSE](LICENSE) (Apache License 2.0)

## Statut

Gardagent est un logiciel jeune. La suite de tests est étendue et la passerelle a été exercée de bout en bout sur un
serveur de test avec du trafic de test (rapports dans [docs/](docs/README.md)), mais elle n'a pas connu d'utilisation en
production ni de revue de sécurité indépendante. Les interfaces et la configuration peuvent changer entre les versions ;
lisez le [CHANGELOG](CHANGELOG.md) avant de mettre à niveau ; la [politique de compatibilité](docs/compatibility.md)
s'applique à partir de la 1.0, qui n'a pas de date : voyez [versionnement et chemin vers la 1.0](docs/versioning.md)
pour ce qu'elle requiert. Les rapports de bogues, questions et contributions sont les bienvenus.
