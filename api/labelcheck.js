// api/labelcheck.js
export const config = { runtime: "nodejs" };

/* ========= BRAND ========= */
const APP_NAME = "Nexodify’s Label Compliance Preflight";
/* ========================= */

import OpenAI from "openai";
import PDFDocument from "pdfkit";
import { Resend } from "resend";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/* ====== clients / env ====== */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY ?? "");
const RESEND_FROM = process.env.RESEND_FROM || `${APP_NAME} <onboarding@resend.dev>`;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

/* ====== small utils ====== */
function sendJson(res, status, obj) {
  res.status(status);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}
async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); }
      catch { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}
function clamp(s, n) { if (!s) return ""; s = String(s); return s.length > n ? s.slice(0, n) : s; }
function b64FromDataUrl(dataUrl) { if (!dataUrl) return ""; const i = dataUrl.indexOf(","); return i >= 0 ? dataUrl.slice(i + 1) : dataUrl; }
function extractJson(content, wantArray = false) {
  if (!content) return wantArray ? [] : {};
  let t = String(content).trim();
  const m = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (m) { try { return JSON.parse(m[1]); } catch {} }
  try { return JSON.parse(t); } catch {}
  const open = wantArray ? "[" : "{"; const close = wantArray ? "]" : "}";
  const s = t.indexOf(open), e = t.lastIndexOf(close);
  if (s !== -1 && e !== -1 && e > s) { try { return JSON.parse(t.slice(s, e + 1)); } catch {} }
  return wantArray ? [] : {};
}
function sanitizeFilename(s, def = "Report") {
  return (String(s || def).replace(/[^\p{L}\p{N}\-_ ]/gu, "").replace(/\s+/g, "_").slice(0, 60)) || def;
}
function nowIsoCompact() { return new Date().toISOString().replace(/[:.]/g, "-"); }

/* ====== KB files ====== */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
function readIf(rel) { try { return fs.readFileSync(path.join(__dirname, "..", rel), "utf8"); } catch { return ""; } }
const KB_HOUSE = readIf("kb/house-rules.md") || readIf("kb/house_rules.md");
const KB_REFS  = readIf("kb/refs.md");
const KB_BUYER = readIf("kb/buyer-generic-eu.md");
const KB_HALAL = readIf("kb/halal-rules.md") || readIf("kb/halal_rules.md");

/* ====== prompts ====== */
const SYSTEM_PROMPT = `
You are an expert EU food label compliance assistant for Regulation (EU) No 1169/2011.

Scope:
- Preflight assistant for EU1169/2011 mandatory particulars.
- Each label and TDS is a NEW, independent case: do not reuse prior outputs.
- On every run, consult the provided /kb files: buyer-generic-eu.md, house-rules.md, refs.md.
- Never invent facts. If information is unclear, illegible, contradictory, or missing, mark status="missing" or "issue" per house rules.

Output (JSON only):
{
  "version": "1.0",
  "product": { "name": "", "country_of_sale": "", "languages_provided": [] },
  "summary": "",
  "checks": [
    { "title": "", "status": "ok|issue|missing", "severity": "low|medium|high", "detail": "", "fix": "", "sources": [], "mandatory": true|false }
  ]
}

Minimum checks:
- Sales name
- Ingredient list
- Annex II allergen emphasis
- QUID (Art 22)
- Net quantity
- Date marking
- Storage/conditions of use
- FBO name/EU address
- Nutrition declaration per 100 g/ml
- Language Compliance
- Claims

Mandatory vs Optional:
- If legally required under EU1169/2011 → mandatory=true.
- If buyer best practice/optional (e.g., barcode quiet zone) → mandatory=false; phrase as "Good to have, not mandatory under EU law."

Fix & Sources:
- For ok: short "detail" + 1 compact citation where possible.
- For issue/missing mandatory: paste-ready "fix" + ≤3 strong citations (e.g., "EU1169:Art 22; Annex VIII", "buyer-generic-eu.md").
- Tone: concise, actionable, placement hints (e.g., "front near the name").

If inputs are blank: return all core mandatory checks as "missing" (and optional as non-mandatory "missing"). No free text beyond JSON.
`;

const HALAL_PROMPT = `
Halal pre-audit. Return ONLY a pure JSON array of:
[{ "title":"", "status":"ok|issue|missing", "severity":"low|medium|high", "detail":"", "fix":"", "sources":[] }]

Rules:
- NEVER invent. If unconfirmed: status="missing" (or "issue" if likely present) with a short paste-ready Fix. ≤3 sources.
- Cite: "OIC/SMIIC 1", "GSO 2055-1", "Codex CXG 24", buyer files (e.g., "buyer-generic-eu.md"), or "TDS:<filename>".
- Each run is a NEW case.

Shipping scope:
- If country_of_sale or shipping_scope suggests GCC/Middle East (KSA, UAE, QA, KW, BH, OM): stricter rules—no pork/derivatives; no alcohol as an ingredient; solvent carry-over only if technically unavoidable, non-intoxicating, and explicitly accepted by the cert body. Logo/issuer must have a valid certificate covering the SKU/batch. (OIC/SMIIC 1; GSO 2055-1; Codex CXG 24)

Core checks to include:
- Prohibited ingredients
- Gelatin/collagen origin
- Emulsifiers/glycerin origin
- Enzymes/rennet origin
- Flavourings & carriers/solvents (ethanol, PG, triacetin, etc.)
- Processing aids
- High-risk E-numbers
- Cross-contamination & segregation
- Halal logo & issuer authenticity
- Traceability & documentation
- Transport & storage (segregation)
- Halal claims discipline

High-risk E-numbers (ALWAYS issue/high unless explicitly proven halal):
- If any of: E120, E441, E471, E472, E422, E920, E904, E913, E1518, E153 (and any ambiguous additive): set
  status="issue", severity="high",
  detail="High-risk additive; halal origin must be verified with supplier.",
  fix="Provide halal certificate/attestation or reformulate with certified plant/microbial alternative.",
  sources=["OIC/SMIIC 1","GSO 2055-1"].
- Only downgrade if plant/microbial origin or valid halal certificate is present for that additive & market.

Alcohol/ethanol:
- None as an ingredient. For carrier/carry-over, require supplier declaration of % and cert-body acceptance; otherwise issue/high.

Formatting:
- Be concise; fixes paste-ready. If inputs are blank, output the above core checks as "missing" (high for origin/alcohol/additives; medium for segregation/docs).
`;

/* ====== retry helper ====== */
async function withRetry(fn, { tries = 3, baseMs = 400 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i) + Math.floor(Math.random() * 120)));
    }
  }
  throw lastErr;
}

/* ====== Vision OCR (Phase 0) — with allergen emphasis ====== */
async function visionTranscribeLabel(imageDataUrl) {
  if (!imageDataUrl) return "";
  const messages = [
    { role: "system", content:
      "You are a meticulous label transcriber. Extract exactly what is printed; no translation, no summarization." },
    { role: "user", content: [
        { type: "text", text:
`Extract the on-pack text exactly as printed.

Rules:
- Return ONLY plain text (no JSON, no tables, no markdown except where noted).
- Preserve line breaks and reading order (left→right, top→bottom).
- Keep original languages, capitalization, punctuation, numbers, symbols, and units (%, g, ml, ℮, kJ/kcal).
- If anything is unclear, write [illegible].
- Include: sales name(s), full ingredients (as one continuous list), allergen statements, net quantity, date lines (BEST BEFORE/USE BY), storage/use, FBO name/address/contacts, country of origin/provenance, alcohol % if any, nutrition per 100 g/ml, any certification text/logos (issuer), recycling text.
- Do NOT infer; only what is visibly printed.

Allergen emphasis:
- If allergens are visually emphasized on-pack (bold/ALL CAPS/contrast), wrap ONLY those emphasized allergen words with **double asterisks** (e.g., “… **MILK**, **ALMONDS** …”). Do not add asterisks elsewhere.

Output: raw transcribed text only (plain text, with ** used solely to mark visible allergen emphasis).` },
        { type: "image_url", image_url: { url: imageDataUrl } }
      ] }
  ];
  const r = await withRetry(() => openai.chat.completions.create({
    model: OPENAI_MODEL,   // e.g., "gpt-4o-mini"
    temperature: 0.0,
    messages
  }));
  const out = (r.choices?.[0]?.message?.content || "").trim();
  const fenced = out.match(/```[\s\S]*?```/);
  return fenced ? fenced[0].replace(/^```[a-z]*\n?|\n?```$/g, "") : out;
}


/* ====== Model calls ====== */
async function askEU({ fields, imageDataUrl, labelPdfText, tdsText, extraText }) {
  const userParts = [];
  const kbText = [
    KB_HOUSE && `House Rules:\n${KB_HOUSE}`,
    KB_REFS  && `EU References:\n${KB_REFS}`,
    KB_BUYER && `Buyer Generic Rules:\n${KB_BUYER}`
  ].filter(Boolean).join("\n\n");
  if (kbText) userParts.push({ type: "text", text: clamp(kbText, 9000) });
  userParts.push({ type: "text", text: `Fields:\n${clamp(JSON.stringify(fields, null, 2), 3500)}` });
  if (extraText)     userParts.push({ type: "text", text: `Extra rules:\n${clamp(extraText, 3500)}` });
  if (tdsText)       userParts.push({ type: "text", text: `TDS excerpt:\n${clamp(tdsText, 6000)}` });
  if (labelPdfText)  userParts.push({ type: "text", text: `Label/OCR text:\n${clamp(labelPdfText, 8000)}` });
  if (imageDataUrl)  userParts.push({ type: "image_url", image_url: { url: imageDataUrl } });

  const r = await withRetry(() =>
    openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.1,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userParts },
        { role: "user", content: "Return only the JSON object—no commentary, no code fences. If inputs are blank, all core mandatory checks must be missing and optional marked non-mandatory." }
      ]
    })
  );
  return extractJson(r.choices?.[0]?.message?.content || "{}", false);
}

async function askHalal({ fields, imageDataUrl, labelPdfText, tdsText, extraText }) {
  const parts = [];
  const kb = (KB_HALAL ? `halal-rules.md:\n${KB_HALAL}\n\n` : "") + (KB_BUYER ? `buyer-generic-eu.md:\n${KB_BUYER}` : "");
  if (kb) parts.push({ type: "text", text: clamp(kb, 8000) });
  parts.push({ type: "text", text: `Fields:\n${clamp(JSON.stringify(fields, null, 2), 3500)}` });
  if (extraText)     parts.push({ type: "text", text: `Extra rules:\n${clamp(extraText, 3500)}` });
  if (tdsText)       parts.push({ type: "text", text: `TDS excerpt:\n${clamp(tdsText, 6000)}` });
  if (labelPdfText)  parts.push({ type: "text", text: `Label/OCR text:\n${clamp(labelPdfText, 8000)}` });
  if (imageDataUrl)  parts.push({ type: "image_url", image_url: { url: imageDataUrl } });

  const r = await withRetry(() =>
    openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.1,
      messages: [
        { role: "system", content: HALAL_PROMPT },
        { role: "user", content: parts },
        { role: "user", content: "Return only the JSON array—no commentary, no code fences. Mark missing if unconfirmed." }
      ]
    })
  );
  return extractJson(r.choices?.[0]?.message?.content || "[]", true);
}

/* ====== PDF→PNG first-page rasterizer (Node, ESM-safe) ====== */
async function pdfFirstPageToDataUrl(buf) {
  try {
    // 1) Canvas impl
    let createCanvas, canvasImpl = "none";
    try {
      ({ createCanvas } = await import("@napi-rs/canvas"));
      canvasImpl = "@napi-rs/canvas";
    } catch {
      try {
        ({ createCanvas } = await import("canvas"));
        canvasImpl = "canvas";
      } catch {
        createCanvas = null;
      }
    }
    if (!createCanvas) throw new Error("no canvas runtime");
    console.log("labelcheck v12: canvas impl =", canvasImpl);

    // 2) pdfjs-dist (modern ESM)
    const pdfjsLib = await import("pdfjs-dist/build/pdf.mjs");
    // Version string is available on some builds; guard in case undefined
    const pdfjsVersion = (pdfjsLib.version || "unknown");
    console.log("labelcheck v12: pdfjs-dist version =", pdfjsVersion);

    // Run in same thread (no worker file on server)
    pdfjsLib.GlobalWorkerOptions.workerSrc = null;

    // 3) Load PDF
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(buf),
      useSystemFonts: true,
      isEvalSupported: false,
    });
    const pdf = await loadingTask.promise;
    const page = await pdf.getPage(1);

    // 4) Render
    const scale = 2.2;
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d");

    await page.render({ canvasContext: ctx, viewport }).promise;

    const png = canvas.toBuffer("image/png");
    return "data:image/png;base64," + png.toString("base64");
  } catch (e) {
    console.error("PDF rasterize fallback failed (esm):", e?.stack || e?.message || e);
    return null;
  }
}


/* ====== deterministic post-checks ====== */
const COUNTRY_LANG = {
  italy: ["it"], germany: ["de"], france: ["fr"], spain: ["es"], portugal: ["pt"],
  netherlands: ["nl"], belgium: ["nl","fr","de"], austria: ["de"], denmark: ["da"],
  sweden: ["sv"], finland: ["fi"], poland: ["pl"], romania: ["ro"], greece: ["el"],
  czechia: ["cs"], slovakia: ["sk"], slovenia: ["sl"], hungary: ["hu"],
  ireland: ["en"], "united kingdom": ["en"], switzerland: ["de","fr","it"], luxembourg: ["fr","de","lb"]
};
function keywordFromName(name) {
  if (!name) return "";
  const stop = new Set(["di","de","al","alla","allo","candite","canditi","sgocciolate","sgocciolato","sciroppo","glucosio","regolatore","acido","concentrato","sale","acqua"]);
  const words = String(name).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu," ").split(/\s+/).filter(Boolean);
  for (const w of words) if (!stop.has(w) && w.length > 2) return w;
  return words[0] || "";
}
function worstSeverity(a,b){ const ord = { low:1, medium:2, high:3 }; return (ord[a||"low"] >= ord[b||"low"]) ? a : b; }
function idxAllLike(checks, key) { const k = key.toLowerCase(); const idxs = []; checks.forEach((c,i)=>{ const t=(c?.title||"").toLowerCase(); if (t.includes(k)) idxs.push(i); }); return idxs; }
function dedupeAndCanonicalize(checks, key, canonicalTitle, preferredCheck) {
  const idxs = idxAllLike(checks, key);
  if (!idxs.length) { checks.push({ ...preferredCheck, title: canonicalTitle }); return; }
  const first = idxs[0];
  let merged = { title: canonicalTitle, status: "ok", severity: "low", detail: "", fix: "", sources: [], mandatory: true };
  for (const i of idxs) {
    const c = checks[i] || {};
    merged.status  = (c.status !== "ok" || merged.status !== "ok") ? (c.status === "missing" ? "missing" : "issue") : "ok";
    merged.severity = worstSeverity(merged.severity, c.severity || "low");
    if (typeof c.mandatory === "boolean") merged.mandatory = c.mandatory;
    if (c.detail) merged.detail = merged.detail ? (merged.detail + "  • " + c.detail) : c.detail;
    if (c.fix)    merged.fix    = merged.fix    ? (merged.fix    + "  • " + c.fix)    : c.fix;
    if (Array.isArray(c.sources)) merged.sources = Array.from(new Set([...(merged.sources||[]), ...c.sources]));
  }
  if (preferredCheck) {
    if (preferredCheck.status !== "ok") {
      merged = { ...merged,
        status: preferredCheck.status,
        severity: preferredCheck.severity || merged.severity,
        detail: preferredCheck.detail || merged.detail,
        fix: preferredCheck.fix || merged.fix,
        sources: Array.from(new Set([...(merged.sources||[]), ...(preferredCheck.sources||[])])),
        mandatory: (typeof preferredCheck.mandatory === "boolean") ? preferredCheck.mandatory : merged.mandatory
      };
    } else if (merged.status === "ok") {
      merged = { ...merged,
        status: "ok", severity: "low",
        detail: preferredCheck.detail || merged.detail,
        sources: Array.from(new Set([...(merged.sources||[]), ...(preferredCheck.sources||[])])),
        mandatory: (typeof preferredCheck.mandatory === "boolean") ? preferredCheck.mandatory : merged.mandatory
      };
    }
  }
  checks[first] = merged;
  for (let j = idxs.length - 1; j >= 1; j--) checks.splice(idxs[j], 1);
}
function find(rx, text){ return rx.test(text); }

function enforce(report, fields, joinedText, rawBlocks=[]) {
  report.checks = Array.isArray(report.checks) ? report.checks : [];
  const lower = joinedText.toLowerCase();

  // Language compliance
  const needSet = COUNTRY_LANG[(fields.country_of_sale||"").toLowerCase()] || null;
  if (needSet && needSet.length) {
    const have = Array.isArray(report.product?.languages_provided)
      ? report.product.languages_provided.map(x=>String(x||"").toLowerCase())
      : (fields.languages_provided||[]).map(x=>String(x||"").toLowerCase());
    const okLang = have.some(h => needSet.includes(h));
    const langPreferred = okLang ? {
      title: "Language Compliance", status: "ok", severity: "low",
      detail: `Includes at least one accepted language (${needSet.join(", ")}) for sale in ${fields.country_of_sale}.`,
      fix: "", sources: ["EU1169:Art 15"], mandatory: true
    } : {
      title: "Language Compliance", status: "issue", severity: "medium",
      detail: `Required accepted language(s) for ${fields.country_of_sale}: ${needSet.join(", ")}. None detected.`,
      fix: `Add mandatory particulars in at least one accepted language (${needSet.join(", ")}).`,
      sources: ["EU1169:Art 15"], mandatory: true
    };
    dedupeAndCanonicalize(report.checks, "language", "Language Compliance", langPreferred);
  }

  // Sales name
  const salesPreferred = (fields.product_name || "").trim() ? {
    title: "Sales name", status: "ok", severity: "low",
    detail: "Sales name provided.", fix: "", sources: ["EU1169:Art 17"], mandatory: true
  } : {
    title: "Sales name", status: "missing", severity: "medium",
    detail: "Sales name of the food is not supplied.",
    fix: "Provide the legal/customary/descriptive sales name.",
    sources: ["EU1169:Art 17"], mandatory: true
  };
  dedupeAndCanonicalize(report.checks, "sales name", "Sales name", salesPreferred);

  // Ingredient list
  const ING_RX = /\bingredient[io](:|\b)|\bingredienti\b|\bingredients\b/gi;
  const hasIngredients = find(ING_RX, lower);
  const ingredientsPreferred = hasIngredients ? {
    title: "Ingredient order", status: "ok", severity: "low",
    detail: "Ingredients are listed.", fix: "", sources: ["EU1169:Art 18"], mandatory: true
  } : {
    title: "Ingredient list", status: "missing", severity: "medium",
    detail: "Ingredient list not detected.",
    fix: "Provide ingredients in descending order by weight.",
    sources: ["EU1169:Art 18"], mandatory: true
  };
  dedupeAndCanonicalize(report.checks, "ingredient", hasIngredients ? "Ingredient order" : "Ingredient list", ingredientsPreferred);

  // Allergen emphasis
  const ALLERGEN_WORDS = /(gluten|frumento|uovo|uova|soia|latte|arachidi|frutta a guscio|nocci|mandorle|sesamo|lupino|pesce|crosta(c|ce)i|sedano|senape|mollusch|solfiti)/i;
  const hasAllergenWords = find(ALLERGEN_WORDS, lower);
  const EMPHASIS_CUES = /(in grassetto|bold|MAIUSCOLO|\*\*|<b>|<\/b>)/i;
  const hasEmphasisCue = find(EMPHASIS_CUES, lower);
  const allergenPreferred = hasAllergenWords
    ? (hasEmphasisCue ? {
        title: "Annex II allergen emphasis", status: "ok", severity: "low",
        detail: "Allergens appear emphasized (format cues).", fix: "", sources: ["EU1169:Annex II"], mandatory: true
      } : {
        title: "Annex II allergen emphasis", status: "issue", severity: "medium",
        detail: "Allergens detected but emphasis not confirmed from text/OCR.",
        fix: "Bold/emphasize allergens within the ingredients list.",
        sources: ["EU1169:Annex II"], mandatory: true
      })
    : {
        title: "Annex II allergen emphasis", status: "missing", severity: "low",
        detail: "Allergens not detected in provided text.",
        fix: "If present, emphasize allergens within ingredients.",
        sources: ["EU1169:Annex II"], mandatory: true
      };
  dedupeAndCanonicalize(report.checks, "allergen", "Annex II allergen emphasis", allergenPreferred);

  // QUID
  const token = keywordFromName(fields.product_name || report.product?.name || "");
  if (token) {
    const NEAR = 80;
    const patterns = [
      new RegExp(`\\b${token}\\b[^\\n]{0,${NEAR}}?\\b\\d{1,3}\\s*%`, "i"),
      new RegExp(`\\b\\d{1,3}\\s*%[^\\n]{0,${NEAR}}?\\b${token}\\b`, "i")
    ];
    let ok = patterns.some(rx => rx.test(lower));
    if (!ok && Array.isArray(rawBlocks)) {
      for (const t of rawBlocks) {
        const L = String(t || "").toLowerCase();
        if (patterns.some(rx => rx.test(L))) { ok = true; break; }
      }
    }
    const quidPreferred = ok ? {
      title: "QUID", status: "ok", severity: "low",
      detail: `Percentage for "${token}" appears present near sales name/ingredients.`,
      fix: "", sources: ["EU1169:Art 22; Annex VIII"], mandatory: true
    } : {
      title: "QUID", status: "issue", severity: "high",
      detail: `Sales name suggests "${token}", but no percentage (%) found near name or in ingredients.`,
      fix: `Declare the percentage of "${token}" (e.g., "${token} 60%") near the sales name or within ingredients.`,
      sources: ["EU1169:Art 22; Annex VIII"], mandatory: true
    };
    dedupeAndCanonicalize(report.checks, "quid", "QUID", quidPreferred);
  }

  // Net quantity
  const NET_RX = /\b(\d{1,4}(?:[.,]\d{1,2})?)\s?(g|kg|ml|l)\b|℮/i;
  const hasNet = find(NET_RX, lower);
  const netPreferred = hasNet ? {
    title: "Net quantity", status: "ok", severity: "low",
    detail: "Net quantity detected.", fix: "", sources: ["EU1169:Art 23"], mandatory: true
  } : {
    title: "Net quantity", status: "missing", severity: "medium",
    detail: "Net quantity not detected.",
    fix: "Add net quantity with the correct unit (g/kg or ml/L).",
    sources: ["EU1169:Art 23"], mandatory: true
  };
  dedupeAndCanonicalize(report.checks, "net quantity", "Net quantity", netPreferred);

  // Date marking
  const DATE_RX = /(best before|best before end|use by|da consumarsi preferibilmente|da consumarsi entro|scad\.)/i;
  const hasDate = find(DATE_RX, lower);
  const datePreferred = hasDate ? {
    title: "Date marking", status: "ok", severity: "low",
    detail: "Date marking detected.", fix: "", sources: ["EU1169:Art 24"], mandatory: true
  } : {
    title: "Date marking", status: "missing", severity: "low",
    detail: "Date marking not detected.",
    fix: "Add 'best before' or 'use by' as applicable.",
    sources: ["EU1169:Art 24"], mandatory: true
  };
  dedupeAndCanonicalize(report.checks, "date", "Date marking", datePreferred);

  // Storage/use
  const STORAGE_RX = /(conservare|conservazione|keep refrigerated|store in|after opening|dopo l'apertura)/i;
  const hasStorage = find(STORAGE_RX, lower);
  const storagePreferred = hasStorage ? {
    title: "Storage/conditions of use", status: "ok", severity: "low",
    detail: "Storage/use statement detected.", fix: "", sources: ["EU1169:Art 25"], mandatory: true
  } : {
    title: "Storage/conditions of use", status: "missing", severity: "low",
    detail: "Storage/conditions of use not detected.",
    fix: "Add storage conditions and, if necessary, conditions of use.",
    sources: ["EU1169:Art 25"], mandatory: true
  };
  dedupeAndCanonicalize(report.checks, "storage", "Storage/conditions of use", storagePreferred);

  // FBO name/EU address
  const COMPANY_TOKENS = /(s\.r\.l|srl|s\.p\.a|spa|ltd|gmbh|sas|s\.a\.|sa|oy|bv|s\.c\.)/i;
  const STREET_TOKENS  = /(via |viale |strada |piazza |street|road|rue|avenue|av\.|platz|calle|postcode|\b\d{4,5}\b)/i;
  const hasCompany = find(COMPANY_TOKENS, lower);
  const hasStreet  = find(STREET_TOKENS, lower);
  let hasFbo = false;
  if (hasCompany && hasStreet) {
    const compIdx = lower.search(COMPANY_TOKENS);
    const strIdx  = lower.search(STREET_TOKENS);
    if (compIdx !== -1 && strIdx !== -1 && Math.abs(compIdx - strIdx) < 1200) hasFbo = true;
  }
  const fboPreferred = hasFbo ? {
    title: "FBO name/EU address", status: "ok", severity: "low",
    detail: "Business name with EU postal address detected (proximity match).",
    fix: "", sources: ["EU1169:Art 9(1)(h)"], mandatory: true
  } : {
    title: "FBO name/EU address", status: "missing", severity: "low",
    detail: "Business name and EU postal address not confirmed from text.",
    fix: "Add the food business operator’s name and full EU postal address.",
    sources: ["EU1169:Art 9(1)(h)"], mandatory: true
  };
  dedupeAndCanonicalize(report.checks, "address", "FBO name/EU address", fboPreferred);

  // Nutrition declaration presence
  const NUT_RX = /(valori nutrizionali|nutrition facts|nutrition declaration|per 100\s?(g|ml)|kcal|kj)/i;
  const hasNut = find(NUT_RX, lower);
  const nutPreferred = hasNut ? {
    title: "Nutrition declaration order per 100g/100ml", status: "ok", severity: "low",
    detail: "Nutrition information detected.", fix: "", sources: ["EU1169:Annex XV"], mandatory: true
  } : {
    title: "Nutrition declaration", status: "missing", severity: "medium",
    detail: "Nutrition declaration not detected.",
    fix: "Provide the mandatory per 100 g/ml nutrition declaration.",
    sources: ["EU1169:Annex XV"], mandatory: true
  };
  dedupeAndCanonicalize(report.checks, "nutrition", hasNut ? "Nutrition declaration order per 100g/100ml" : "Nutrition declaration", nutPreferred);

  // Claims
  const CLAIM_RX = /(source of|fonte di|ricco di|high in|no added|senza zuccheri aggiunti|sugar free|alto contenuto)/i;
  const hasClaim = find(CLAIM_RX, lower);
  const claimPreferred = hasClaim ? {
    title: "Claims", status: "issue", severity: "medium",
    detail: "Claims detected—verify authorization and conditions of use.",
    fix: "Ensure the claim is authorised and conditions of use are fulfilled (Reg. (EC) 1924/2006).",
    sources: ["Reg 1924/2006"], mandatory: true
  } : {
    title: "Claims", status: "ok", severity: "low",
    detail: "No explicit claims detected.", fix: "", sources: [], mandatory: true
  };
  dedupeAndCanonicalize(report.checks, "claims", "Claims", claimPreferred);

  return report;
}

/* ====== scoring ====== */
function recomputeScore(report) {
  let score = 100, high = 0, hasMed = false;
  for (const c of (report.checks || [])) {
    if (c.status !== "ok") {
      if (c.severity === "high") { score -= 15; high++; }
      else if (c.severity === "medium") { score -= 8; hasMed = true; }
      else { score -= 3; }
    }
  }
  score = Math.max(0, Math.min(100, score));
  let overall = "pass";
  if (high >= 2) overall = "fail";
  else if (high === 1 || hasMed) overall = "caution";
  return { score, overall };
}

/* ====== PDF building ====== */
async function buildPdfBase64(report, halalChecks, fields, { includeHalalPage = true } = {}) {
  return await new Promise((resolve) => {
    const doc = new PDFDocument({ size: "A4", margin: 36 });
    const bufs = [];
    let errorMsg = "";
    doc.on("data", (d) => bufs.push(d));
    doc.on("error", (e) => { errorMsg = e?.message || String(e); });
    doc.on("end", () => { resolve({ base64: Buffer.concat(bufs).toString("base64"), error: errorMsg }); });

    const head = (title) => {
      doc.rect(36, 36, 523, 42).fill("#0f1530");
      doc.fill("#eaf0ff").fontSize(16).text(title, 44, 48, { width: 510 });
      doc.moveDown(2).fill("#000");
    };

    // Cover
    head(`${APP_NAME} — Compliance Report`);
    doc.fontSize(10).fill("#333").text(`Generated: ${new Date().toISOString()}`);
    doc.moveDown(0.5).text(`Company: ${fields.company_name || "-"}`);
    const p = report.product || {};
    doc.text(`Product: ${p.name || "-"}`);
    doc.text(`Country of sale: ${p.country_of_sale || "-"}`);
    doc.text(`Languages: ${(p.languages_provided || []).join(", ") || "-"}`);
    doc.text(`Score: ${report.score}/100   Overall: ${report.overall_status.toUpperCase()}`);
    doc.moveDown(0.8);
    if (report.summary) doc.fontSize(11).fill("#000").text(report.summary, { width: 520 });
    doc.moveDown(1.0);

    // EU checks
    doc.fontSize(13).fill("#000").text("EU 1169/2011 Checks", { underline: true });
    doc.moveDown(0.5).fontSize(10);
    for (const c of report.checks || []) {
      doc.fill(c.status === "ok" ? "#0a7" : c.severity === "high" ? "#c00" : c.severity === "medium" ? "#c70" : "#000")
         .text(`• ${c.title} [${c.status.toUpperCase()} | ${c.severity}]`);
      doc.fill("#000");
      if (c.detail) doc.text(`Detail: ${c.detail}`);
      if (c.status !== "ok" && c.fix) doc.text(`Fix: ${c.fix}`);
      if (Array.isArray(c.sources) && c.sources.length) doc.text(`Sources: ${c.sources.join("; ")}`);
      doc.moveDown(0.5);
    }

    // Halal (issues/missing only)
    const halalHasContent = Array.isArray(halalChecks) && halalChecks.length > 0;
    const halalAllOk = halalHasContent && halalChecks.every(h => h.status === "ok");
    if (includeHalalPage && halalHasContent && !halalAllOk) {
      doc.addPage();
      head("Halal Pre-Audit");
      doc.fontSize(10).fill("#000");
      for (const c of halalChecks) {
        if (c.status === "ok") continue;
        doc.fill(c.status === "ok" ? "#0a7" : c.severity === "high" ? "#c00" : c.severity === "medium" ? "#c70" : "#000")
           .text(`• ${c.title} [${c.status.toUpperCase()} | ${c.severity}]`);
        doc.fill("#000");
        if (c.detail) doc.text(`Detail: ${c.detail}`);
        if (c.status !== "ok" && c.fix) doc.text(`Fix: ${c.fix}`);
        if (Array.isArray(c.sources) && c.sources.length) doc.text(`Sources: ${c.sources.join("; ")}`);
        doc.moveDown(0.5);
      }
    }

    // Fix Pack
    doc.addPage();
    head("Fix Pack (copy-paste suggestions)");
    doc.fontSize(10).fill("#000");
    for (const c of report.checks || []) {
      if (c.status === "ok") {
        doc.fill("#0a7").text(`✓ ${c.title} — OK`);
        if (Array.isArray(c.sources) && c.sources.length) doc.fill("#555").text(`Sources: ${c.sources.join("; ")}`);
        doc.fill("#000").moveDown(0.3);
        continue;
      }
      doc.fill("#c00").text(`• ${c.title} [${c.severity.toUpperCase()}]`);
      doc.fill("#000");
      if (c.detail) doc.text(`- ${c.detail}`);
      if (c.fix)   doc.text(`→ Fix: ${c.fix}`);
      if (Array.isArray(c.sources) && c.sources.length) doc.text(`Sources: ${c.sources.join("; ")}`);
      doc.moveDown(0.4);
    }
    if (Array.isArray(halalChecks)) {
      for (const c of halalChecks) {
        if (c.status === "ok") continue;
        doc.fill("#c00").text(`• Halal: ${c.title} [${c.severity.toUpperCase()}]`);
        doc.fill("#000");
        if (c.detail) doc.text(`- ${c.detail}`);
        if (c.fix)   doc.text(`→ Fix: ${c.fix}`);
        if (Array.isArray(c.sources) && c.sources.length) doc.text(`Sources: ${c.sources.join("; ")}`);
        doc.moveDown(0.4);
      }
    }

    doc.moveDown(1.0);
    doc.fontSize(8).fill("#667").text(
      "This preflight is an automated, best-effort screening based on inputs and public/KB references. "+
      "It is not legal advice or a conclusive compliance opinion. Professional review is recommended.",
      { width: 520 }
    );
    doc.fill("#000");

    doc.end();
  });
}
function buildFallbackPdfBase64(message = "Report generated without full details.") {
  const doc = new PDFDocument({ size: "A4", margin: 36 });
  const bufs = [];
  doc.on("data", d => bufs.push(d));
  doc.fontSize(16).text(APP_NAME, { underline: true });
  doc.moveDown().fontSize(12).text(message);
  doc.end();
  return Buffer.concat(bufs).toString("base64");
}

/* ====== handler ====== */
export default async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST" });

  const t0 = Date.now();
  let stage = "init";
  try {
    stage = "parse_body";
    const body = await readJsonBody(req);
    const {
      product_name, company_name, company_email,
      country_of_sale, languages_provided = [],
      shipping_scope, product_category,
      label_image_data_url, label_pdf_file,
      tds_file,
      reference_docs_text, halal_audit,

      // toggles:
      return_pdf = false,
      attach_pdf = true,
      include_halal_page = true
    } = body || {};

    const fields = {
      product_name, company_name, company_email,
      country_of_sale, languages_provided,
      shipping_scope, product_category
    };

    /* === TDS parse (guarded) === */
    stage = "parse_tds";
    let tdsText = "";
    if (tds_file?.base64) {
      try {
        const base = b64FromDataUrl(tds_file.base64);
        if (base && base.length > 0) {
          const buf = Buffer.from(base, "base64");
          if ((tds_file.name || "").toLowerCase().endsWith(".pdf")) {
            const pdfParse = (await import("pdf-parse")).default;
            const parsed = await pdfParse(buf);
            tdsText = parsed?.text || "";
          } else {
            tdsText = buf.toString("utf8");
          }
        }
      } catch (e) { console.error("TDS parse failed:", e?.message || e); }
    }

    /* === Label PDF parse (guarded) + rasterize fallback === */
    stage = "parse_label_pdf";
    let labelPdfText = "";
    let imageDataUrl = label_image_data_url || null;

    if (label_pdf_file?.base64) {
      try {
        let base = label_pdf_file.base64;
        if (typeof base !== "string") { console.error("Label PDF base64 not a string"); base = ""; }
        const b64 = base.includes(",") ? base.slice(base.indexOf(",")+1) : base;

        const looksB64 = /^[A-Za-z0-9+/=\s]+$/.test(b64 || "");
        if (looksB64 && b64.length > 200) {
          const buf = Buffer.from(b64, "base64");
       console.log("labelcheck v12: attempting PDF rasterize (bytes)", (buf && buf.length) || 0);
          if (Buffer.isBuffer(buf) && buf.length > 0) {
            // text layer
            try {
              const pdfParse = (await import("pdf-parse")).default;
              const parsed = await pdfParse(buf);
              labelPdfText = typeof parsed?.text === "string" ? parsed.text : "";
            } catch (e) {
              console.error("Label PDF parse failed (pdf-parse):", e?.message || e);
            }
            // rasterize if sparse & no image provided
            const sparse = !labelPdfText || labelPdfText.replace(/\s+/g, "").length < 200;
            if (sparse && !imageDataUrl) {
              const pngDataUrl = await pdfFirstPageToDataUrl(buf);
              if (pngDataUrl) {
                console.log("Rasterized PDF page to PNG for Vision");
                imageDataUrl = pngDataUrl;
              }
            }
          } else { console.error("Label PDF buffer invalid/empty."); }
        } else { console.error("Label PDF base64 does not look valid; skipping parse."); }
      } catch (e) {
        console.error("Label PDF base64 decode failed:", e?.message || e);
      }
    }

    /* === Phase 0 Vision OCR (if we have an image) === */
    stage = "vision_ocr";
    if (imageDataUrl) {
      try {
        const visionText = await visionTranscribeLabel(imageDataUrl);
        if (visionText && visionText.length > 10) {
          // Prepend vision text so it’s weighted strongly
          labelPdfText = (visionText + "\n\n" + (labelPdfText || "")).trim();
        }
      } catch (e) {
        console.error("Vision transcription failed:", e?.message || e);
      }
    }

    /* === blank detection === */
    stage = "check_blank";
    const isBlank =
      !(imageDataUrl && String(imageDataUrl).trim()) &&
      !(label_pdf_file?.base64) &&
      !(tdsText && tdsText.trim()) &&
      !(reference_docs_text && String(reference_docs_text).trim()) &&
      !(product_name && String(product_name).trim());

    /* === 1) EU ask === */
    stage = "ask_eu";
    const raw = await askEU({
      fields,
      imageDataUrl: imageDataUrl || null,
      labelPdfText: labelPdfText || null,
      tdsText: tdsText || null,
      extraText: reference_docs_text || ""
    });

    /* === 2) normalize === */
    stage = "normalize";
    const report = {
      version: "1.0",
      product: {
        name: raw?.product?.name || fields.product_name || "",
        country_of_sale: raw?.product?.country_of_sale || fields.country_of_sale || "",
        languages_provided: Array.isArray(raw?.product?.languages_provided) ? raw.product.languages_provided : (fields.languages_provided || [])
      },
      summary: raw?.summary || "",
      checks: Array.isArray(raw?.checks) ? raw.checks.map(c => ({
        title: c?.title || "Check",
        status: c?.status === "ok" ? "ok" : c?.status === "missing" ? "missing" : "issue",
        severity: ["low","medium","high"].includes(c?.severity) ? c.severity : "medium",
        detail: c?.detail || "",
        fix: c?.status === "ok" ? "" : (c?.fix || ""),
        sources: Array.isArray(c?.sources) ? c.sources : [],
        mandatory: (typeof c?.mandatory === "boolean") ? c.mandatory : true
      })) : []
    };

    /* === 3) hard enforcement === */
    stage = "enforce";
    const rawBlocks = [labelPdfText || "", tdsText || "", reference_docs_text || ""].filter(Boolean);
    const joined = rawBlocks.join("\n").toLowerCase();
    enforce(report, fields, joined, rawBlocks);

    if (isBlank) {
      const coreTitles = [
        "Sales name","Ingredient list","Annex II allergen emphasis","QUID","Net quantity",
        "Date marking","Storage/conditions of use","FBO name/EU address","Nutrition declaration",
        "Language Compliance","Claims"
      ];
      report.checks = coreTitles.map(t => ({
        title: t, status: "missing", severity: t === "QUID" ? "high" : "medium",
        detail: "No evidence found in the provided inputs.",
        fix: "Provide the required information.", sources: [], mandatory: true
      }));
      report.summary = "Inputs were blank/scant. All core particulars are missing.";
    }

    /* === 4) score === */
    stage = "score";
    const { score, overall } = recomputeScore(report);
    report.score = score;
    report.overall_status = overall;

    /* === 5) halal === */
    stage = "halal";
    let halalChecks = [];
    if (halal_audit) {
      const hal = await askHalal({
        fields,
        imageDataUrl: imageDataUrl || null,
        labelPdfText: labelPdfText || null,
        tdsText: tdsText || null,
        extraText: reference_docs_text || ""
      });
      halalChecks = (Array.isArray(hal) ? hal : []).map(c => ({
        title: c?.title || "Halal check",
        status: c?.status === "ok" ? "ok" : c?.status === "missing" ? "missing" : "issue",
        severity: ["low","medium","high"].includes(c?.severity) ? c.severity : "medium",
        detail: c?.detail || "",
        fix: c?.status === "ok" ? "" : (c?.fix || ""),
        sources: Array.isArray(c?.sources) ? c.sources : []
      }));
    }

    /* === 6) pdf build === */
    stage = "pdf";
    let pdf_base64 = "";
    let pdf_error = "";
    try {
      const r = await buildPdfBase64(report, halalChecks, fields, { includeHalalPage: include_halal_page });
      pdf_base64 = r.base64;
      pdf_error = r.error || "";
      if (!pdf_base64 || pdf_base64.length < 1000) {
        pdf_error = pdf_error || "empty-pdf";
        pdf_base64 = buildFallbackPdfBase64("Fallback PDF created because the main PDF stream was empty.");
      }
    } catch (e) {
      pdf_error = e?.message || String(e);
      pdf_base64 = buildFallbackPdfBase64("Fallback PDF created due to PDF error.");
    }

    /* === 7) email === */
    stage = "email";
    let email_status = "skipped: missing RESEND_API_KEY or company_email";
    if (process.env.RESEND_API_KEY && fields.company_email) {
      const recipients = String(fields.company_email).split(/[;,]/).map(s => s.trim()).filter(Boolean);
      const filename = `Preflight_${sanitizeFilename(fields.product_name || "Product")}_${nowIsoCompact()}.pdf`;
      try {
        await withRetry(() => resend.emails.send({
          from: RESEND_FROM,
          to: recipients,
          subject: `${APP_NAME} — ${fields.product_name || "Your Product"} | ${report.overall_status.toUpperCase()} ${report.score}/100`,
          html: `<p>Hello ${fields.company_name || ""},</p>
                 <p>Attached is your preliminary compliance report for <strong>${fields.product_name || "your product"}</strong>.</p>
                 <p>Overall: <strong>${report.overall_status.toUpperCase()}</strong> — Score: <strong>${report.score}/100</strong>.</p>
                 <p>Best,<br/>${APP_NAME}</p>`,
          attachments: attach_pdf ? [{ filename, content: pdf_base64, contentType: "application/pdf" }] : []
        }));
        email_status = `sent to ${recipients.length}`;
      } catch (e) {
        email_status = "failed: " + (e?.message || e);
      }
    }

    const resp = {
      ok: true,
      version: "v12-vision-phase",
      model: OPENAI_MODEL,
      report,
      score: report.score,
      halal_audit: !!halal_audit,
      halal_checks: halalChecks,
      pdf_error,
      email_status
    };
    if (body.return_pdf) resp.pdf_base64 = pdf_base64;

    return sendJson(res, 200, resp);
  } catch (err) {
    console.error("API error at stage:", stage, err);
    return sendJson(res, 500, { error: err?.message || String(err), stage });
  }
}
