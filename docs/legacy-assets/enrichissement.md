# Actifs extraits — Enrichissement & résolution d'entreprise

> Source : `enrich-company`, `_shared/fullenrich*.ts`, `_shared/insee-sirene.ts`, `_shared/email-pattern.ts`, `_shared/geo-cascade.ts`, `_shared/name-reconstruction.ts`.

## Paramètres API FullEnrich — `_shared/fullenrich.ts`
- Base : `https://app.fullenrich.com/api/v2`, auth `Authorization: Bearer <key>`
- Endpoints : `POST /company/search`, `POST /people/search` (pagination `search_after`, PAGE_SIZE 100), `POST /contact/enrich/bulk` (+ `GET /contact/enrich/bulk/{id}?forceResults=true`), `GET /account/credits`
- `enrich_fields` par défaut = `["contact.work_emails"]` **uniquement** (les phones sont ~10× plus chers, volontairement exclus)
- Renommage API 2026-04-23 : `contact.emails` → `contact.work_emails`, `linkedin` → `professional_network`
- **Rate limiter cross-instance en Postgres** (nécessaire car N workers Deno) : RPC `acquire_fullenrich_token`, token-bucket capacité 50, refill 1/1.2 s (marge sous le quota FE 60/min)
- Webhook FE pour éviter le polling payant : `submitBulkEnrichment(webhookUrl)` + `pollBulkEnrichment` lit `pending_fullenrich_bulks` en DB (gratuit), n'espace le GET HTTP qu'à 30 s
- **Coûts empiriques documentés** : `/people/search` ≈ 0,25 crédit/contact retourné ; **appels vides = 0 crédit** (d'où la cascade géo) ; `/company/search` ≈ 0 crédit

## Résolution d'entreprise réellement implémentée — `_shared/fullenrich-company-resolve.ts`
⚠️ Résout un nom **vers l'ID canonique FullEnrich**, PAS vers un SIREN. Cascade :
1. `professional_network_urls` (LinkedIn) exact — si hint fourni
2. `domains` exact — si hint fourni
3. multi-`names` fuzzy, 2 appels parallèles (avec/sans `headquarters_locations: FR`) + `generateNameVariants` (strip parenthèses/slash/suffixes/holding)
4. dernier recours : variantes IA via **Claude Haiku** (`generateAIVariants`, cache 30 j) pour acronymes/filiales (« CCEP » → « Coca-Cola Entreprise », « Groupe Figaro » → « Le Figaro »)
- Ranking `scoreCandidate` : similarité Jaccard (gate 0.5), bonus pays FR, log headcount, **malus −0.2 sur TLD pays non aligné**

### Écart vs les 4 passes cible (domaine → raison sociale+CP via annuaire → trigram → unresolved)
- La cible veut résoudre vers **SIREN via l'annuaire légal**. Ici SIREN vient d'INSEE `findCompanyByName(nom, per_page=1)` sans filtre CP
- **Passe trigram Postgres ABSENTE** de la chaîne de rattachement (`pg_trgm` sert seulement à la barre de recherche UI et au dédup d'import)
- **Pas d'état `unresolved` ni d'arbitrage humain** : rien ne matche → cache négatif 24 h, fallback silencieux

## Email-pattern — `_shared/email-pattern.ts`
- 10 patterns (`first.last`, `flast`, `f.last`, …), confiance = hits/samples utilisables
- Match tolérant (espace/tiret/troncature nom composé), swap first/last, exclusion des samples tronqués
- Seuils : `high ≥ 0.85` ; **`medium` désactivé (relevé à 0.85)** après constat prod que Reoon rejetait tout < 85 % → tout < 0.85 = `skip`
- Minimum 3 samples pour publier un pattern domaine

## Cascade géo — `_shared/geo-cascade.ts`
- Tables complètes : 101 départements + DROM + Corse 2A/2B → mapping CP → dept → région → France
- Title-case des villes, strip du suffixe régional dans le nom de boîte
- La cascade `/people/search` s'arrête au 1er niveau retournant ≥ `minContacts` (économie de crédits)

## Reconstruction de nom — `_shared/name-reconstruction.ts`
- Si `last_name` anonymisé (« Marie W. ») ou ALL CAPS et email `prenom.nom@` : backfill sous conditions strictes (prénom exact + initiale concordante)

## Cache anti-double-paiement
`enrichment_cache` (fullenrich_company TTL 30 j, ai_variants 30 j, sentinelle négative 24 j), `domain_email_patterns`, `email_verification_cache`, `catch_all_domains` + dédup (company_name, ville) sur 60 j.

## À construire pour la cible (absent aujourd'hui)
- **`estimateCost()` en euros avant exécution** : n'existe pas (contrôle réactif uniquement : caps, pause sur 402, cron solde)
- **Opposition au démarchage** : totalement absente. L'API `recherche-entreprises` expose `statut_diffusion` par établissement mais il n'est **ni demandé ni parsé**. À implémenter from scratch
- **Établissements multiples** : INSEE ne récupère que le **siège** (`siege.*`), pas les établissements secondaires (nécessaire pour le canal courrier)
