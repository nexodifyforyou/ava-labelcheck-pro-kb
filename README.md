

# AVA LabelCheck — PRO + Knowledge Base

Upload label image → OCR + EU 1169/2011 + House Rules → JSON report → stamped PDF → optional email.

## Deploy (browser-only)
1) Put this repo on GitHub (upload all files & folders).
2) Import on Vercel → add env vars:
   - OPENAI_API_KEY = your OpenAI key
   - (optional) RESEND_API_KEY = your Resend key for emailing PDFs
3) Click Deploy.

## How to use your documents
- Persistent rules (always applied) → edit `kb/house_rules.md` (summaries or key clauses).
- Per-job rules → paste into the big textarea on the form.
