# AUDIT — Code existant Jay Reach

> Ticket **T0**. Audit **sur pièces** du dépôt existant, réalisé sans aucune modification du code. Objectif : décider quoi garder, quoi extraire, quoi réécrire, quoi jeter — et identifier ce qui doit continuer à tourner pendant la refonte.
> Périmètre audité : 33 Edge Functions (Deno/Supabase), ~26 000 lignes de front React (Vite), 52 migrations SQL, bibliothèque partagée `_shared/`.
> **Ceci est un point d'arrêt (STOP). Aucune suite n'est engagée avant validation humaine de ce rapport.**

---

## 1. Synthèse (lisible sans être développeur)

Le dépôt actuel **est déjà une première version fonctionnelle de Jay Reach**, en production sur la prospection réelle de l'éditeur. Ce n'est pas une table rase : c'est un moteur qui, aujourd'hui, **scrape des offres d'emploi → score par IA → enrichit les contacts → vérifie les emails → pousse dans Smartlead**. Cette chaîne marche et contient de la connaissance métier coûteuse à reconstituer (paramètres d'API, listes d'exclusion de cabinets de recrutement, patterns d'emails, prompts).

La **cible** (le cahier des charges) est plus ambitieuse et bâtie sur une autre fondation technique : un monorepo Next.js avec un **séquenceur multicanal maison** (email + LinkedIn + courrier + téléphone), une boîte de réception unifiée, 3 langues, et des garde-fous de conformité. L'écart n'est donc pas cosmétique : **le socle et le pipeline de collecte/enrichissement sont réutilisables, mais tout le « cœur d'engagement » (séquenceur, inbox, conformité) est à construire** — l'existant a délibérément sous-traité l'envoi et la séquence à Smartlead.

Côté sécurité : **posture globalement saine** (aucun secret dans le code ni dans l'historique Git, credentials chiffrés AES-256-GCM, RLS activée partout, gitleaks en CI). Quelques points à corriger avant l'ouverture publique, aucun bloquant grave.

**Verdict : reprise partielle.** On garde le socle multi-tenant, le pipeline signaux/enrichissement et le design ; on réécrit le modèle d'engagement à partir de la spec. Détail au §6.

---

## 2. Classement module par module

Verdicts : **Reprendre** (marche, testable, transposable) · **Extraire** (connaissance précieuse, code à jeter) · **Réécrire** (besoin valide, code non) · **Abandonner** (besoin disparu).

### 2.1 Signaux & scrapers
| Module | Rôle | Verdict |
|---|---|---|
| `scrapers/adzuna.ts`, `scrapers/apify.ts` | Scrapers jobs Adzuna / LinkedIn | **Reprendre** |
| `scrapers/france-travail.ts` | Scraper France Travail + extraction nom | **Extraire** (params en or, 20 regex fragiles) |
| `scrapers/honeypot-detector.ts`, `scrapers/types.ts` | Anti-honeypot, interface `Scraper` | **Reprendre** (types ≈ interface cible `SignalProvider`) |
| `scrapers/signal-processor.ts` | Dédup + cascade de filtres + insertion | **Réécrire** (monolithe, logique DB mêlée) |
| `scrapers/company-name-validator.ts` | Détection faux noms d'entreprise | **Extraire** |
| `naf.ts`, `naf-codes.ts`, `insee-sirene.ts` | Référentiel NAF + résolution SIREN | **Reprendre** (purs, testés) |
| `signal-scoring-core.ts`, `providers/anthropic.ts`, `anthropic-client.ts` | Résolution prompt + client Claude Batch | **Reprendre** |
| `score-prospect-signals/index.ts` | Orchestration scoring IA + auto-learning blacklist | **Extraire** |
| `scrape-job-signals/index.ts` | Orchestrateur cron | **Réécrire** (à porter sur worker Node) |

### 2.2 Enrichissement & résolution d'entreprise
| Module | Rôle | Verdict |
|---|---|---|
| `insee-sirene.ts`, `email-pattern.ts`, `geo-cascade.ts`, `name-reconstruction.ts`, `persona-enrichment-core.ts` | Briques pures (annuaire légal, patterns, géo) | **Reprendre** |
| `fullenrich.ts` | Client FullEnrich + rate-limiter Postgres | **Extraire** |
| `fullenrich-company-resolve.ts` | Résolution nom→ID FullEnrich (4 passes + IA) | **Extraire** (mais vise l'ID FE, pas le SIREN) |
| `fullenrich-dedup.ts`, `fullenrich-webhook-helpers.ts`, `enrich-deduced-emails/index.ts`, `fullenrich-credits-monitor/index.ts` | Dédup, webhook, déduction email, monitoring | **Extraire** |
| `enrich-company/index.ts` (1600 l) | Orchestrateur worker + `processSignal` | **Réécrire** (monolithe) |
| `enqueue-enrichment`, `expand-prospect-profiles` | Spawn workers pg_net / « voir 10 de plus » | **Réécrire** |
| `reenrich-companies/index.ts` | Reset destructif ops | **Abandonner** |

### 2.3 Validation email, providers & credentials (sécurité)
| Module | Rôle | Verdict |
|---|---|---|
| `token-encryption.ts` (+test) | Chiffrement AES-256-GCM des secrets | **Extraire** (corriger `decryptTokenSafe`, ajouter rotation de clé) |
| `providers/registry.ts`, `providers/types.ts`, adapters (`anthropic`, `bouncer`, `reoon`, `fullenrich`, `openai-compatible`, `demo`) | Résolution provider + interfaces + adapters | **Reprendre** |
| `providers/catalog.ts` | Descripteur de providers | **Extraire** (embryon de manifest, pas de Zod/i18n) |
| `bouncer.ts`, `email-gate.ts` | Client Bouncer + décision de push | **Reprendre / Extraire** |
| `reoon.ts` | Client Reoon | **Réécrire léger** (clé en query string) |
| `set-provider-credential`, `test-provider-connection`, `bouncer-batch`, `bouncer-webhook`, `bounce-learning` | Fonctions HTTP credentials & validation | **Reprendre** |
| `cors.ts`, `validation.ts`, `subscription-access.ts`, `audit-events.ts` | Transverses sécurité | **Reprendre** |
| `rate-limiter.ts` | Rate-limit Postgres fail-closed | **Reprendre** (⚠️ présent mais **non câblé**) |

### 2.4 Outreach (Smartlead) & messages
| Module | Rôle | Verdict |
|---|---|---|
| `smartlead.ts`, `outreach/registry.ts`, `outreach/types.ts` | Client REST + abstraction outreach | **Extraire** |
| `outreach/smartlead-provider.ts` | Impl. Smartlead (routing persona, push groupé) | **Réécrire** (≠ cible : bulk & routage persona) |
| `outreach/smartlead-provider.test.ts` | Tests provider | **Reprendre** |
| `send-via-smartlead/index.ts` (585 l), `smartlead-webhook`, `prospect-renderer.ts`, `generate-prospect-messages-bulk` | Envoi, webhook, rendu, génération | **Réécrire** |
| `get-smartlead-campaign-stats`, `list-smartlead-campaigns`, `regenerate-...-from-template` | Stats, liste, re-render | **Extraire** |
| `src/features/smartlead/*`, `src/features/messages/*` | Hooks push & messages front | **Reprendre** |

### 2.5 Détection de CRM — **hors périmètre v1**
| Module | Verdict |
|---|---|
| `crm-detection/signatures.ts`, `domain-resolver.ts`, `jobs-analyzer.ts`, `dns-resolver.ts`, `homepage-scraper.ts` | **Extraire** (connaissance) |
| `detect-crm`, `cleanup-stuck-crm-detections`, `linkedin-skills-analyzer`, `web-search-crm` (code mort), `types.ts`, hook & badge front | **Abandonner** |

### 2.6 Frontend (React / Vite)
| Zone | Verdict | Blocage |
|---|---|---|
| 11 écrans câblés (`components/prospection/*`) | **Reprendre** (structure/JSX/UX) + adapter data | Framework |
| 48 primitives shadcn (`components/ui/*`) | **Reprendre** | Aucun |
| 33 hooks (logique de données) | **Extraire** (logique) / **Réécrire** (transport) | Framework |
| `features/*`, `lib/*` (utilitaires purs) | **Extraire / Reprendre** | Framework partiel |
| `App.tsx`, `main.tsx`, `pages/*` | **Réécrire** | Framework (Vite→Next App Router) |
| `i18n.ts` + `locales/*` | **Réécrire** | Scaffolding vide, 0 `t()` réel |
| `index.css` (design glass) + `tailwind.config.ts` | **Reprendre** | Aucun |
| Écrans legacy non câblés (`ProspectionSignals/Campaigns/Pipeline/Messages`) | **Abandonner** | — |

### 2.7 Modèle de données (52 migrations)
| Domaine | Verdict |
|---|---|
| Socle multi-tenant (`workspaces`, `workspace_members`, RLS, `user_workspaces()`) | **Reprendre** (renommer workspace→organization) |
| `icp_personas`, `prospect_signals`, `prospect_imports`, `prospect_message_templates`, `workspace_provider_credentials` | **Reprendre** |
| `prospect_profiles` (contact+entreprise fusionnés), `company_group_id` virtuel | **Extraire** (à scinder en `accounts` + `contacts`) |
| Séquenceur cible (`enrollments`, `sequence_steps`, `actions`, `outcomes`, `senders`, `bindings`, `threads`, `suppressions`, `customer_lists`, `prospecting_opposition`, `notifications`) | **Réécrire depuis la spec** (absent) |

---

## 3. Actifs extraits et leur emplacement

Toute la connaissance métier récupérable a été écrite dans **`docs/legacy-assets/`** :

| Fichier | Contenu clé |
|---|---|
| `docs/legacy-assets/signaux-scrapers.md` | Params OAuth France Travail, Adzuna, Apify, INSEE ; blacklist ~125 cabinets + regex ; codes NAF ; prompt de scoring ; règles de normalisation ; honeypot |
| `docs/legacy-assets/enrichissement.md` | Params & **coûts empiriques** FullEnrich, rate-limiter token-bucket Postgres, email-patterns (seuil 0.85 calibré en prod), cascade géo 101 depts |
| `docs/legacy-assets/outreach-smartlead.md` | Endpoints Smartlead, **mapping des champs `lead_list`**, variables de rendu, écarts vs cible |
| `docs/legacy-assets/crm-detection.md` | Table signatures ~55 CRM, blacklist ~90 domaines FR, briques DNS/anti-SSRF |

**Actif transverse le plus précieux à porter** : le principe NAF « verdict 3 états `match/mismatch/unknown` » (n'exclut jamais sur code absent) et l'amélioration évidente = **exclure les cabinets par code NAF (division 78) et déduplicer par SIREN**, alors que l'existant le fait 100 % par nom.

---

## 4. Problèmes de sécurité, par gravité

> Rappel : **aucun secret trouvé dans le code ni dans l'historique Git** (400 derniers commits scannés), aucun `.env` réel commité, `.gitleaks.toml` + scan gitleaks en CI. Le socle est sain. Les points ci-dessous sont des durcissements, pas des fuites avérées.

### 🔴 Élevé — à corriger avant ouverture publique
1. **IDOR sur `detect-crm`** (`detect-crm/index.ts:39-46`) : hors service-role, tout utilisateur authentifié passe (check admin volontairement sauté) alors que la fonction opère en **service-role qui bypasse la RLS**. Un utilisateur peut déclencher une détection sur un `company_group_id` arbitraire et écrire dans le workspace d'un autre. → Comme ce module est **abandonné** (hors périmètre), le supprimer règle le problème.
2. **Autorisation trop large sur `send-via-smartlead`** : exige `role='admin'` **global**, pas l'appartenance au workspace ciblé → un admin peut pousser des prospects d'un autre workspace. → Scoper l'autorisation au workspace (rôle `operator+` sur CE workspace).
3. **`rate-limiter` non câblé** : `test-provider-connection` sans throttle = oracle de clé / brûlage de quota provider. → Brancher le rate-limiter sur les endpoints sensibles.

### 🟠 Moyen
4. **Webhooks non signés** (Smartlead, Bouncer, FullEnrich) : auth par **token/secret en query string** comparé en clair (non constant-time), pas de HMAC ni anti-rejeu. Le token transite dans des URLs (logs proxy). → Comparaison constant-time ; documenter le durcissement ; HMAC là où le provider le permet.
5. **Clés API en query string** (Smartlead, Reoon, INSEE, France Travail, Adzuna) : risque de fuite via logs/proxies. Bouncer fait mieux (header `x-api-key`). → Passer toutes les clés en header.
6. **`decryptTokenSafe` — défaut latent** (`token-encryption.ts:203-209`) : sur clé erronée, peut renvoyer le base64 chiffré comme « plaintext ». Circonscrit (le chemin credential utilise `decryptToken` strict), mais à corriger. → Supprimer le fallback silencieux, lever une erreur.
7. **Matching des réponses par email `ilike`** : peut attribuer réponse/bounce au mauvais prospect (homonymes cross-workspace). → Matcher par identifiant, pas par email.
8. **Chiffrement des secrets** : clé symétrique unique globale, **sans rotation ni versioning**, pas de KMS. Acceptable en self-hosted, mais à documenter et prévoir une rotation.

### 🟡 Faible / dette
9. Garde admin **côté client seulement** au front (`pages/Prospection.tsx`) — la vraie protection est la RLS (présente). À refaire en middleware/Server Action côté Next.
10. `reenrich-companies` : DELETE en masse (avec `force:true` outrepassant le guard). Outil ops à isoler/abandonner.
11. Absence de timeout réseau natif sur certains `fetch` (INSEE/FE) — repose sur des `Promise.race` côté appelant.
12. Caches sans purge TTL (`email_verification_cache`) — croissance non bornée.

> **Conformité (données personnelles)** : les signaux et `prospect_profiles` stockent des données personnelles réelles (noms, emails). Aucune n'est dans le dépôt Git, mais **avant de convertir des données collectées en fixtures de test, il faut les anonymiser** (règle CLAUDE.md).

---

## 5. Part du périmètre v1 déjà couverte par l'existant

| Domaine cible v1 | Couverture existante | Commentaire |
|---|---|---|
| Connecteur **offres d'emploi** (`job_posting`) | ✅ **Élevée** | 3 scrapers fonctionnels (France Travail, Adzuna, Apify), scoring IA, blacklist cabinets |
| Connecteurs **nominations** / **salons** | ❌ Absent | À construire |
| **Enrichissement** entreprise + contacts | ✅ **Élevée** | INSEE (firmographie) + FullEnrich (contacts), cache anti-double-paiement, rate-limiting |
| **Résolution d'entreprise** (→ SIREN) | 🟠 Partielle / mal alignée | Résout vers ID FullEnrich, pas SIREN ; passe trigram & état `unresolved` absents |
| **Import de fichiers** CSV/XLSX | 🟠 Partielle | `prospect_imports` présent ; pas de notion de `lists`/`context_note` |
| **Personas** | ✅ Élevée | `icp_personas` riche (scoring, canaux, caps) |
| **Scoring** (règles + IA) | ✅ Élevée | Prompt par trigger, JSON validé, auto-learning |
| **Email — Smartlead** | 🟠 Partielle | Envoi **en bulk** délégué à Smartlead ; pas d'abstraction `ChannelProvider`, pas de threading Message-ID |
| **Séquenceur multicanal maison** | ❌ **Absent** | Cœur de la cible : `enrollments`/`sequence_steps`/`actions`/`outcomes` inexistants (délégués à Smartlead) |
| Canaux **LinkedIn / courrier / téléphone** | ❌ Absent | À construire |
| **Boîte de réception** & classification des réponses | ❌ Absent | `positive_replies` = 0 « par construction » (aucun classifieur branché) |
| **Approbation & file d'attente** | 🟠 Embryon | États draft/approved/sent au front, écran dédié mort |
| **Conformité** (suppressions, opposition démarchage, exclusion clients) | ❌ Absent | Aucune `suppressions`/`customer_lists`/`prospecting_opposition` |
| **Notifications** (email + push) | ❌ Absent | — |
| **3 langues** (FR/EN/NL) | ❌ Quasi absent | i18n scaffoldé mais vide, tout en dur en français |
| **Multi-utilisateurs + rôles + RLS** | ✅ **Élevée** | Socle solide et cohérent, RLS partout |
| **Credentials chiffrés** | ✅ Élevée | AES-256-GCM, RLS sans policy sur la table des secrets |
| **Design system / écrans** | ✅ **Élevée** (~70-80 % visuel) | Design glass abouti, 11 écrans peuplés de vraies données |

**Estimation globale** : l'existant couvre bien **l'amont** (détecter → qualifier → enrichir → vérifier) et **le socle** (multi-tenant, credentials, UI). Il ne couvre **quasiment pas l'aval** cible (séquenceur maison, multicanal, inbox, conformité, i18n).

---

## 6. Recommandation

> **Reprise partielle.**

Le dépôt existant est une V1 réelle de Jay Reach dont **le socle et la moitié amont du pipeline sont directement transposables**, et dont l'UI et la connaissance métier sont des actifs majeurs. Repartir de zéro gâcherait des mois de calibrage (params d'API, blacklists, patterns email, prompts, design). Mais **la moitié aval de la cible (séquenceur multicanal, inbox, conformité) n'existe pas et doit être bâtie depuis la spec**, pas dérivée de l'existant qui a fait le choix inverse (sous-traiter à Smartlead).

**Ordre de migration recommandé**, chaque module en usage réel restant derrière un drapeau de fonctionnalité jusqu'à validation du nouveau chemin (jamais de bascule sèche — le scraping/enrichissement/Smartlead tourne en prod) :

1. **Socle** (T1-T5) : monorepo Next.js, schéma en **renommant `workspace`→`organization`** et en reprenant la RLS existante (`user_workspaces`), auth/rôles, i18n (chantier neuf), coffre à credentials (reprendre `token-encryption` durci).
2. **Amont** (T6-T13) : porter les **actifs de `docs/legacy-assets/`** — connecteur `jobboard` (reprendre Adzuna/Apify/France Travail), scoring, personas, résolution d'entreprise **complétée** (ajouter la passe SIREN par domaine+CP, le trigram, l'état `unresolved`, et l'**opposition au démarchage** aujourd'hui absente).
3. **Enrichissement** (T14-T16) : envelopper FullEnrich/INSEE dans l'interface `EnrichmentProvider` avec `estimateCost()` (absent), réutiliser cache & rate-limiter.
4. **Cœur d'engagement** (T17-T24) : **construction neuve** depuis la spec — c'est là qu'est le vrai travail (séquenceur, garde-fous, canaux, approbation).
5. **Aval** (T25-T32) : inbox, classification, API, CRM, conformité — neuf.

**Ce qui doit continuer à tourner pendant toute la refonte** (à ne pas casser) : la chaîne cron `scrape-job-signals → score-prospect-signals → enqueue-enrichment/enrich-company → bouncer-batch → send-via-smartlead`, et les credentials chiffrés des workspaces actifs.

**À supprimer sans regret une fois la connaissance extraite** : le sous-système de détection de CRM (hors périmètre, + faille IDOR), les écrans front legacy non câblés, `reenrich-companies`.

---

## Annexe — Méthode & couverture de l'audit

- Inventaire structurel (arbo, lignes, migrations), puis lecture analytique de chaque sous-système.
- Scan sécurité : secrets dans le code suivi **et** dans l'historique Git (400 commits), fichiers `.env` suivis, config gitleaks/CI.
- Tests existants recensés : **21** fichiers côté Edge Functions, **1** côté front. CI : lint, typecheck, build, test, deno lint, deno test, gitleaks.
- Non modifié : aucun fichier de code touché. Seuls ajouts : ce `AUDIT.md` et `docs/legacy-assets/`.
