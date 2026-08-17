# Actifs extraits — Outreach (Smartlead) & messages

> Source : `send-via-smartlead`, `smartlead-webhook`, `get-smartlead-campaign-stats`, `list-smartlead-campaigns`, `_shared/smartlead.ts`, `_shared/outreach/*`, `_shared/prospect-renderer.ts`.

## Paramètres API Smartlead — `_shared/smartlead.ts`
- Base : `https://server.smartlead.ai/api/v1`, auth **`?api_key=`** en query string (⚠️ à passer en header côté cible)
- `GET /campaigns` → `{id, name, status}`
- `POST /campaigns/{id}/leads` body `{ lead_list: [...] }` — **max 400 leads/req**, réponse `{ added_count, skipped_count }`
- `POST /campaigns/{id}/status` body `{ status: "START"|"PAUSED"|"STOPPED" }` (idempotent ; sert à réveiller une campagne COMPLETED)
- `POST /campaigns/{id}/webhooks` body `{ id, name, webhook_url, event_types[] }` — event types : `LEAD_REPLIED`, `LEAD_OPENED`, `LEAD_CLICKED`, `EMAIL_SENT`, `EMAIL_BOUNCED`
- `GET /campaigns/{id}/analytics` → parse **défensif** : `sent_count|sent|total_sent`, `unique_open_count|open_count`, `reply_count`, `bounce_count`
- `GET /campaigns/{id}/sequences` → `seq_number`, `seq_delay_details.delay_in_days`, `subject`/`sequence_variants[0].subject`

## Mapping des champs vers Smartlead — `smartlead-provider.ts::toSmartleadLead`
Structure `lead_list[]` :
- `email`, `first_name`, `last_name`, `company_name`
- `linkedin_profile` ← `linkedin_url`
- `website` ← `enrichment.company_website`
- `location` ← `enrichment.company_city`
- `custom_fields: { subject, body, job_title, prospect_id, persona_id }`
  - **`body` = body_html complet** (texte converti + images inline du branding)
  - Le template Smartlead côté opérateur référence `{{subject}}` et `{{body}}`

## Rendu des variables — `_shared/prospect-renderer.ts`
- Variables en **simple accolade** : `{first_name}` `{last_name}` `{company}` `{job_title}` `{salutation}` `{brand_signature}` `{brand_name}`
- ⚠️ Variables manquantes → **remplacées par chaîne vide** (`?? ""`), l'envoi **n'est PAS bloqué** (à l'inverse de la règle cible « une variable non résolue bloque l'envoi »)
- Normalisations réutilisables : `normalizeJobTitle` (nettoie CDI/CDD/h-f/refs), `normalizeCompanyName`, `pickVariant`/`fnv1a` (choix déterministe de variante par hash)
- Mirror front : `src/lib/prospect-template-renderer.ts`

## Génération de messages
**Aucun prompt IA** : la génération a été convertie en **100 % déterministe** (`llm_model: "template-v1"`). Le batch Anthropic a été supprimé ; les messages sont rendus depuis `prospect_message_templates` indexés par `persona_id` + `channel`.

## Écarts majeurs vs la cible (à corriger à la reconstruction)
- **Abstraction** : `OutreachProvider { push/pushMany }` existe mais ≠ cible `ChannelProvider { dispatch/pollOutcomes/handleWebhook }`. Pas de `pollOutcomes` ; le `handleWebhook` est un edge séparé, **hors** du provider
- **Envoi en bulk** (leads groupés par campagne, tranches de 400) ≠ cible « à l'unité »
- **Routage par `persona_id`** ≠ cible « 1 campagne Smartlead / campagne Jay Reach »
- **Pas de threading Message-ID** : matching des réponses par `lead_email` (`ilike`) — fragile
- **Versionnement templates** : compteur `version` bumpé **in-place** (pas d'historique immuable — l'ancien texte est perdu)
- **Pas multilingue** : salutations codées en dur en français (« Bonjour {first_name}, »)
- **Webhook non signé** : auth par secret statique en query `?secret=` (Smartlead ne signe pas)
