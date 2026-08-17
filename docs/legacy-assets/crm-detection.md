# Actifs extraits — Détection de CRM (fonctionnalité HORS périmètre v1)

> Source : `detect-crm`, `_shared/crm-detection/*`.
> **Verdict : extraire la connaissance, abandonner la machinerie.** Ce sous-système devine le CRM utilisé par l'entreprise *cible* — ce n'est pas un signal d'intention d'achat, c'est hors du périmètre v1 (flag `crm_detection_enabled` off par défaut, résultat consommé nulle part sauf un badge décoratif). Conservé ici au cas où il reviendrait un jour (ex. approche « migration CRM »).

## Table de signatures techno → CRM — `_shared/crm-detection/signatures.ts`
~55 CRM. Exemples réels à conserver :
- **SPF** : `_spf.salesforce.com`→Salesforce · `spf\d*.hubspotemail.net|spf.hubspot.com`→HubSpot · `spf.zoho.com`→Zoho · `spf.pipedrive.com|pipedrivemail.com`→Pipedrive · `spf.dynamics.com|crmdynint.com`→Dynamics · `spf.sellsy.com`→Sellsy · `spf.teamleader.eu`→Teamleader · `axonaut.com`→Axonaut · `_spf.odoo.com`→Odoo · `_sv[1-9].bitrix24.com`→Bitrix24
- **CNAME** : `.my.salesforce.com|.lightning.force.com|.force.com`→Salesforce · `.hubspot.net|.hs-sites.com|.hsforms.net`→HubSpot · `.crm.dynamics.com`→Dynamics · `.pipedrive.com`→Pipedrive · `.netsuite.com`→Oracle NetSuite
- **HTML/trackers** : `js.hs-scripts.com|hs-analytics.net|_hsq|hubspotutk`→HubSpot · `pi.pardot.com|.lightning.force.com|sfdcsessid`→Salesforce · `salesiq.zoho.com|forms.zoho.com`→Zoho
- **Non-CRM à exclure** (`NON_CRM_TOOLS`, précieux — évite de confondre ESP et CRM) : Brevo/Mailchimp/Mailjet/SendGrid/Mailgun (ESP), Marketo/Eloqua/Acoustic (marketing auto), Intercom/Drift/Zendesk/Crisp (support), 6sense/Demandbase/ZoomInfo/Cognism (ABM)
- Sous-domaines sondés : `crm, app, info, support, community, help, portal, sales, marketing, go, track`

## Résolution de domaine corporate — `_shared/crm-detection/domain-resolver.ts` (réutilisable partout, pas seulement CRM)
- **Blacklist ~90 domaines parasites FR** : annuaires (societe.com, pagesjaunes.fr, infogreffe.fr, data.gouv.fr…), job boards, presse, gov US ; rejet `.gov`/`state.xx.us`
- Scoring déterministe : ressemblance au nom +10, préfixe du SLD +4, `.fr` +2, racine 2 labels +3, **pénalité microsites −8** (shop/jobs/blog/support…), pénalité hyphens ; fallback acronyme pour noms courts (ABB, ELIS)

## Briques génériques réutilisables (utilitaires edge-runtime propres)
- `dns-resolver.ts` : DoH Cloudflare, timeout 5 s, SPF reconstitué depuis TXT `v=spf1`, MX = dernier token, CNAME probés en parallèle
- `homepage-scraper.ts` : fetch home + pages légales via **`safeFetch` anti-SSRF** (revalide chaque redirection) — **bon pattern à conserver** (`_shared/url-validator.ts`)
- `jobs-analyzer.ts` : filtre ESN (si ≥3 offres citent le CRM dans le titre → c'est un intégrateur, pas l'outil interne)
- Agrégation pondérée (`confidence.ts`) : poids par source (DNS SPF/CNAME = 3, HTML/text/jobs/linkedin = 2, MX = 1)

## À supprimer (machinerie spécifique)
`detect-crm`, `cleanup-stuck-crm-detections`, `linkedin-skills-analyzer`, `web-search-crm` (déjà code mort), `crm-detection/types.ts`, table `prospect_crm_detections`, hook `useCrmDetection`, badge `CrmDetectionBadge` (dont le tooltip référence encore un ancien pipeline « BuiltWith » inexistant).
