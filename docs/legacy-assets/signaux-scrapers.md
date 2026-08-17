# Actifs extraits — Signaux & scrapers

> Connaissance métier récupérée du code existant (audit T0). Ces éléments valent plus que le code qui les porte : à réinjecter tels quels dans la reconstruction.
> Source : `supabase/functions/_shared/scrapers/*`, `scrape-job-signals`, `score-prospect-signals`, `_shared/signal-scoring-core.ts`, `_shared/insee-sirene.ts`, `_shared/naf*.ts`.

## Paramètres d'API qui fonctionnent

### France Travail (offres d'emploi) — `_shared/scrapers/france-travail.ts`
- **OAuth token** : `POST https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=%2Fpartenaire`
  - body `x-www-form-urlencoded` : `grant_type=client_credentials`, `client_id`, `client_secret`, `scope=api_offresdemploiv2 o2dsoffre`
  - token mis en cache, rafraîchi à 90 % de `expires_in`
- **Recherche** : `GET https://api.francetravail.io/partenaire/offresdemploi/v2/offres/search?motsCles=<kw>&range=0-99&sort=1`
  - `sort=1` = tri par date ; `departement=<loc>` optionnel ; header `Authorization: Bearer <token>`
  - limite : 15 keywords par run
- **Champs clés de la réponse** : `codeNAF` (NAF sans point, ex. `6201Z`) = code d'activité déclaré par l'employeur, **gratuit et fiable** ; `trancheEffectifEtab` ; `secteurActiviteLibelle`
- **Détail offre** : `https://candidat.francetravail.fr/offres/recherche/detail/{id}`

### Adzuna — `_shared/scrapers/adzuna.ts`
- `GET https://api.adzuna.com/v1/api/jobs/fr/search/{page}?app_id=&app_key=&what=<kw>&results_per_page=50&max_days_old=30&sort_by=date`
- **France uniquement** (BE/CH non supportés) ; délai 250 ms entre requêtes

### Apify LinkedIn jobs — `_shared/scrapers/apify.ts`
- `POST https://api.apify.com/v2/acts/{actorId}/run-sync-get-dataset-items?token=&timeout=120&format=json`
- actor par défaut : **`valig~linkedin-jobs-scraper`** (cookie-free, pay-per-event)
- body JSON `{title, location, limit, rows}` ; plafonds : 25 items/kw, description tronquée à 2000 car, budget global 90 s
- **Détection crédits épuisés** : HTTP `402` = plus de crédit prépayé ; `403` + regex `usage-limit|limit-exceeded|insufficient-credit|payment` = quota mensuel

### INSEE / Recherche entreprises (annuaire légal) — `_shared/insee-sirene.ts`
- `GET https://recherche-entreprises.api.gouv.fr/search?q=<nom>&per_page=1&mtm_campaign=jay-prospection` — **gratuite, sans clé**, header `Accept: application/json`
- champs lus : `siren`, `siege.siret`, `nom_complet`/`nom_raison_sociale`, `siege.adresse/code_postal/libelle_commune`, `activite_principale` (NAF rev.2), `activite_principale_naf25` (NAF 2025/NACE 2.1), `tranche_effectif_salarie`
- **throttle : min 160 ms entre appels** (limite publique ~7 req/s), sérialisé par chaîne de promesses ; plafond 150 résolutions/run
- ⚠️ le champ **`statut_diffusion`** (opposition/diffusibilité) est exposé par l'API mais **non lu** aujourd'hui → à brancher pour l'opposition au démarchage

## Listes d'exclusion (valeurs réelles à conserver)

### Cabinets de recrutement / intérim — table `recruitment_agencies_blacklist`
~125 noms seed (migrations `20260518100000` et `20260616190000`). Majors : Adecco, Manpower, Randstad, Hays, Michael Page, Page Personnel, Robert Half, Expectra, Synergie, Crit, Actual, Temporis, Proman, Artus, Supplay, Kelly Services, Gi Group, Adéquat, Samsic, Uptoo, Fed, Akkodis, Robert Walters, Menway, Abalone, Ergalis… + job boards (Adzuna, Indeed, Monster, HelloWork, Meteojob, Keljob, RegionsJob, Talent.com). ~24 noms `auto_score` détectés par l'IA (AGRI TEAM, asap.work, Nexus HR, Rocket4Sales, WIZBII…).

### Regex de détection cabinet — `signal-processor.ts`
```
\b(recrutement|recruiting|intérim|interim|staffing|placement|headhunt|chasseur de t[eê]tes|strategy|stratégie|cabinet (conseil|rh|recrutement)|conseil rh|conseil (en )?recrutement|people strategy|talent strategy|advisory|executive search)\b
```
- `SHORT_CONSEIL_PATTERN` : `^[a-zà-ÿ0-9&'.\s]{1,12}\s+conseil` (« ORAH Conseil » = cabinet ; « Conseil Départemental » trop long → exclu)
- `\brh$` en fin de nom ; `SCHOOL_PATTERNS` (écoles) ; `MLM_FRANCHISE_PATTERNS`

### Contenu franchise/MLM — `CONTENT_BLACKLIST` (sur `raw_content`)
`investissement initial`, `droit d'entrée`, `apport personnel nécessaire`, `devenir franchisé`, `créer votre franchise`, `ouvrir votre agence`, `réseau de mandataires`, `agent commercial indépendant`, `agent immobilier indépendant`

### Banques / assurances — `EXCLUDED_COMPANIES`
`bpce, bnp, lcl, axa, april, maif, macif, maaf, gmf, allianz, groupama, generali, ag2r` + regex `\b(assurance|prévoyance|mutuelle|banque|bancaire)\b`

### Titres de poste non-commerciaux exclus
secrétaire, préparateur, recouvrement, chef de projet, juriste, product owner, business/data analyst, community manager, contrôleur de gestion…

### Honeypot — `_shared/scrapers/honeypot-detector.ts`
- préfixes génériques : `noreply, no-reply, test, admin, info, support, contact, hello, sales, marketing, webmaster, postmaster, abuse, root, mailer-daemon`
- domaines jetables : `tempmail.com, guerrillamail.com, mailinator.com, yopmail.com, temp-mail.org…`

## Règles de parsing / normalisation éprouvées
- `normalizeCompanyName` : lowercase + strip suffixes juridiques `sas|sarl|sa|sasu|eurl|snc|scp|scs|sci|selarl|selas|group|groupe|holding|distribution|france|europe|international` (sert à la dédup cross-semaine)
- Nettoyage post-extraction France Travail : « Rothelec Rothelec » → « Rothelec » ; strip « À propos de » ; « Rejoindre le Groupe X » → « Groupe X »
- `normalizeNafCode` : `6201Z` → `62.01Z` ; `matchNafFilter` renvoie un **verdict 3 états `match/mismatch/unknown`** — n'élimine JAMAIS sur code absent, seulement sur désaccord prouvé. **Principe directeur à conserver absolument.**
- `company-name-validator.ts::looksLikeJobTitleFragment` : marqueurs de genre (h/f), types de contrat, participes passés, ≥3 mots tout-majuscule = job title brut, stop-words FR isolés, verbes à l'infinitif

## Prompt de scoring IA
Le **prompt système** n'est PAS dans le code : il est stocké par trigger dans `signal_triggers.signal_scoring_prompt` (min 200 car, sinon skip — plus de fallback hardcodé). Seul le **message utilisateur** est construit par le code (`score-prospect-signals/index.ts::buildUserMessage`) :
```
Évalue ces {N} prospects selon les critères définis dans les instructions système.

{ID: ... / Entreprise: ... / Poste: ... / Localisation: ... / Email: ... / Description: ...(150 car)}
---
Réponds UNIQUEMENT avec un tableau JSON valide, un objet par prospect, dans ce format exact :
[{"id": "<recopie l'ID à l'identique>", "score": <entier 0 à 100>, "reason": "<une phrase courte>"}]
Règles strictes : aucun texte avant/après le tableau, pas de balises de code, un objet par prospect, "id" recopié exactement.
```
- API : Anthropic **Message Batches**, tier `smart` = Sonnet ; mode sync de secours pour providers sans Batch API
- Parsing tolérant : strip des fences ```` ```json ````, extraction du 1er tableau via `\[\s*\{[\s\S]*\}\s*\]`, clamp du score 0-100
- **Auto-apprentissage blacklist** : tout signal scoré ≤30 dont la `reason` matche `\b(cabinet|intermédiaire|recrute pour|recrutement par|agence (?:de )?recrutement|placement|chasseur|headhunt|interim|intérim|esn)\b` → inséré dans `recruitment_agencies_blacklist`

## Améliorations évidentes repérées (à porter dans la reconstruction)
- L'exclusion des cabinets est **100 % par nom** (blacklist + regex + auto-learning). Le **SIREN est résolu et stocké mais jamais utilisé pour exclure**, et les **codes NAF 78.10Z / 78.20Z / 78.30Z** (activités liées à l'emploi) existent dans le référentiel mais **ne sont jamais filtrés**. → Brancher l'exclusion sur le code NAF déjà résolu (division 78) plutôt que sur des listes de noms à maintenir.
- Déduplication par URL (in-run) + par nom normalisé (cross-semaine), **mais pas par SIREN** → même limite.

## Couverture périmètre
- `job_posting` : **entièrement couvert** (Adzuna, France Travail, Apify LinkedIn) — seul type réellement implémenté
- `appointment` (nominations) : **absent**
- `tradeshow` (salons) : **absent**
