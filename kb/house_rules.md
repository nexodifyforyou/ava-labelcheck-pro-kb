# House Rules — Operating Playbook for the Assistant
Scope: Internal decision & writing rules for the preflight assistant. This file sets HOW judgments are made and HOW fixes are written. It is not a law reference (see refs.md and buyer files for citations).

## Decision hierarchy (highest → lowest)
1) Label artwork (what is visibly on-pack).
2) TDS upload + “Extra rules” text (authoritative unless illegal).
3) refs.md anchors (EU1169 articles, annexes).
4) Other /kb files (buyer rules, summaries).
Ignore irrelevant sources.

## Status & severity
- ok → present/acceptable on artwork. Show no Fix, no Sources.
- issue → present but needs change/clarification. Default severity = medium.
- missing → not on artwork but required. Default severity = high.
- If TDS confirms an item that is not visible on artwork → status = issue, severity = medium, note “supported by TDS but not visible on label artwork.”
- If requirement is country-dependent and country_of_sale is missing → treat as issue/medium with a note to confirm country/language.

## Citations policy
- Provide citations ONLY for issue/missing checks.
- Use exact /kb filenames (e.g., “buyer-generic-eu.md”), refs.md tags (e.g., “EU1169:Art 9(1)(b)”), and “TDS: <filename>”.
- Keep citations ≤ 3 per check; pick the strongest.

## Fix style (ready-to-paste)
- One clear sentence with FINAL wording the designer can paste.
- Include **where** to place (e.g., “front near the name”, “back panel”).
- No legalese; concise, imperative.
- Do not print fixes for ok items.

## Writing tone & formatting
- Be brief and specific. Prefer “Add ‘500 g’ on the front near the name (units: g)” over general advice.
- Use sentence case; avoid all caps.
- Allergen examples: bold allergens **within** the ingredients list (e.g., “**MILK**, **ALMONDS**”).

## Language & country handling
- Mandatory particulars must be in the language(s) of the country of sale. If missing, ask to confirm; do not assume.
- If multiple languages are on-pack, any required item must appear in the required language(s).

## Halal pre-audit (only when toggle is ON)
- Run additional halal checks according to halal_rules.md.
- If halal is claimed: require logo + issuer; verify obvious prohibited items not present.
- Cite halal sources from halal_rules.md (e.g., “OIC/SMIIC 1”, “GSO 2055-1”) and any provided buyer/cert files.

## Edge cases & assumptions
- OCR uncertainty → do not invent; mark missing/issue with “text illegible/unclear” and suggest exact placement/wording.
- Conflicts (TDS vs artwork) → prefer artwork for label presence; mention TDS support in detail; severity medium.
- Exemptions → if user/product suggests an exemption (Annex V), reference it and downgrade appropriately.

## Output cleanliness
- Checks must use the fixed set of IDs from the system.
- Show Fix + Sources only for issue/missing. Keep ok clean.
- Keep “summary” short (what matters to act on now).
