# docs/legacy-assets/ — Connaissance extraite du code existant

Produit par le ticket **T0 (audit)**. Ces fichiers capturent la **connaissance métier** encodée dans le code actuel — paramètres d'API qui fonctionnent, listes d'exclusion, heuristiques éprouvées, prompts, mappings — indépendamment de la qualité du code qui la porte. À réinjecter dans la reconstruction, même là où le code source est abandonné.

| Fichier | Contenu |
|---|---|
| [signaux-scrapers.md](signaux-scrapers.md) | France Travail / Adzuna / Apify / INSEE : endpoints & params. Blacklists cabinets, NAF, honeypot. Prompt de scoring. Règles de normalisation. |
| [enrichissement.md](enrichissement.md) | FullEnrich & INSEE : params, coûts empiriques, rate-limiter Postgres. Email-patterns, cascade géo, résolution d'entreprise. |
| [outreach-smartlead.md](outreach-smartlead.md) | Smartlead : endpoints, mapping des champs, rendu des variables. Écarts vs la cible. |
| [crm-detection.md](crm-detection.md) | Signatures techno→CRM, blacklist domaines FR, briques DNS/SSRF réutilisables. **Fonctionnalité hors périmètre v1.** |

> Note de conformité : plusieurs de ces actifs contiennent des données réelles collectées (noms d'entreprises, emails). Avant de convertir quoi que ce soit en fixtures de test, **anonymiser** (règle CLAUDE.md : « pas de fixtures avec de vraies personnes ou entreprises »).
