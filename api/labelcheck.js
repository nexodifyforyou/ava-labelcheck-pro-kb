// api/labelcheck.js
export const config = { runtime: "nodejs" };

// ========= BRAND / NAME =========
const APP_NAME = "Nexodify’s Label Compliance Preflight";
// =================================

import OpenAI from "openai";
import PDFDocument from "pdfkit";
import { Resend } from "resend";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/* ------------------------- clients / env -------------------------- */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY ?? "");
const RESEND_FROM = process.env.RESEND_FROM || ""; // <- require your verified domain

/* ------------------------- small helpers -------------------------- */
function sendJson(res, status, obj) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}
function safeB64ToBuffer(b64orDataUrl) {
  const b64 = (b64orDataUrl || "").includes(",")
    ? b64orDataUrl.split(",").pop()
    : b64orDataUrl || "";
  return Buffer.from(b64, "base64");
}
function clampText(s, n = 8000) {
  if (!s) return "";
  s = String(s);
  return s.length > n ? s.slice(0, n) : s;
}
async function readJsonBody(req) {
  return await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); }
      catch { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

/* ---------- JSON extraction (handles ```json fences, extra text) --------- */
function extractJsonObject(text, wantArray = false) {
  if (!text) return wantArray ? [] : {};
  const t = String(text).trim();

  // a) code fence
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) {
    try { return JSON.parse(fence[1]); } catch {}
  }
  // b) straight parse
  try { return JSON.parse(t); } catch {}

  // c) scan for first {...} or [...]
  const open = wantArray ? "[" : "{";
  const close = wantArray ? "]" : "}";
  const start = t.indexOf(open);
  const end = t.lastIndexOf(close);
  if (start !== -1 && end !== -1 && end > start) {
    const slice = t.slice(start, end + 1);
    try { return JSON.parse(slice); } catch {}
  }
  return wantArray ? [] : {};
}

/* --------------------- load KB (best effort) ---------------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
function readIfExists(rel) {
  try {
    return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
  } catch {
    return "";
  }
}
const KB_HOUSE = readIfExists("kb/house_rules.md");
const KB_REFS  = readIfExists("kb/refs.md");
const KB_BUYER = readIfExists("kb/buyer-generic-eu.md");
const KB_HALAL = readIfExists("kb/halal_rules.md");

/* -------------------- prompt system messages ---------------------- */
const SYSTEM_PROMPT = `
You are an expert EU food label compliance assistant for Regulation (EU) No 1169/2011.
Return ONLY pure JSON (no markdown fences). Shape:
{
  "version": "1.0",
  "product": { "name": "", "country_of_sale": "", "languages_provided": [] },
  "summary": "",
  "checks": [
    { "title": "", "status": "ok|issue|missing", "severity": "low|medium|high", "detail": "", "fix": "", "sources": [] }
  ]
}
Rules:
- Be precise. If unsure, mark as "missing" with a short detail.
- Only include Fix and Sources for non-OK items.
- Cite concise sources (e.g., "EU1169:Art 22; Annex VIII") and exact KB filenames where relevant ("buyer-generic-eu.md", "refs.md", "TDS: file.pdf").
- Do NOT invent facts. If the item is present on the label/TDS, mark it OK.
- Important topics: sales name, ingredient list (descending order), allergen emphasis (Annex II), QUID (Art 22), net quantity, date marking, storage/conditions of use, FBO name/EU address, nutrition table per 100g/100ml in the correct order, language compliance for the country of sale, and claims.
`;

const HALAL_SYSTEM_PROMPT = `
You are performing a Halal pre-audit screening based on halal_rules.md and buyer inputs.
Return ONLY a pure JSON array (no markdown), elements shaped as:
{ "title":"", "status":"ok|issue|missing", "severity":"low|medium|high", "detail":"", "fix":"", "sources":[] }.
Consider forbidden ingredients (porcine, alcohol), gelatin/enzymes origin, flavour carriers/solvents (ethanol), processing aids, logo/issuer authenticity, segregation/contamination risk.
Provide Fix & Sources only for non-OK.
`;

/* ----------------------- model call helpers ----------------------- */
async function analyzeEU({ fields, imageDataUrl, pdfText, tdsText, extraRules }) {
  const userParts = [];
  const kbText = [
    KB_HOUSE && `House Rules:\n${KB_HOUSE}`,
    KB_REFS  && `EU References:\n${KB_REFS}`,
    KB_BUYER && `Buyer Generic Rules:\n${KB_BUYER}`
  ].filter(Boolean).join("\n\n");

  if (kbText) userParts.push({ type:"text", text:`Use these references if relevant:\n${clampText(kbText, 9000)}` });
  userParts.push({ type:"text", text:`Product fields:\n${clampText(JSON.stringify(fields, null, 2), 3000)}` });
  if (extraRules) userParts.push({ type:"text", text:`Client Extra Rules:\n${clampText(extraRules, 3000)}` });
  if (tdsText)    userParts.push({ type:"text", text:`TDS extract:\n${clampText(tdsText, 6000)}` });
  if (pdfText)    userParts.push({ type:"text", text:`Label PDF text:\n${clampText(pdfText, 6000)}` });
  if (imageDataUrl) userParts.push({ type:"image_url", image_url:{ url:imageDataUrl } });

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.1,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userParts },
      { role: "user", content: "Return only the JSON object—no commentary, no code fences." }
    ]
  });

  const raw = resp.choices?.[0]?.message?.content || "{}";
  return extractJsonObject(raw, false);
}

async function analyzeHalal({ fields, imageDataUrl, pdfText, tdsText, extraRules }) {
  const parts = [];
  const kb = (KB_HALAL ? `halal_rules.md:\n${KB_HALAL}\n\n` : "") +
             (KB_BUYER ? `buyer-generic-eu.md:\n${KB_BUYER}` : "");
  if (kb) parts.push({ type:"text", text: clampText(kb, 8000) });
  parts.push({ type:"text", text: `Fields:\n${clampText(JSON.stringify(fields, null, 2), 3000)}` });
  if (extraRules) parts.push({ type:"text", text:`Client Extras:\n${clampText(extraRules, 3000)}` });
  if (tdsText)    parts.push({ type:"text", text:`TDS excerpt:\n${clampText(tdsText, 6000)}` });
  if (pdfText)    parts.push({ type:"text", text:`Label PDF excerpt:\n${clampText(pdfText, 6000)}` });
  if (imageDataUrl) parts.push({ type:"image_url", image_url:{ url:imageDataUrl } });

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.1,
    messages: [
      { role: "system", content: HALAL_SYSTEM_PROMPT },
      { role: "user", content: parts },
      { role: "user", content: "Return only the JSON array—no commentary, no code fences." }
    ]
  });

  const raw = resp.choices?.[0]?.message?.content || "[]";
  return extractJsonObject(raw, true);
}

/* ------------------------ deterministic rules --------------------- */
// map of primary language by country (extend as needed)
const COUNTRY_LANG = {
  italy: "it", germany: "de", france: "fr", spain: "es", portugal: "pt",
  netherlands: "nl", belgium: "nl", austria: "de", denmark: "da",
  sweden: "sv", finland: "fi", poland: "pl", romania: "ro", greece: "el",
  czechia: "cs", slovakia: "sk", slovenia: "sl", hungary: "hu", ireland: "en",
  "united kingdom": "en"
};

function pickIngredientFromName(name) {
  if (!name) return "";
  const stop = new Set(["di","de","al","alla","allo","candite","canditi","sgocciolate","sgocciolato","sciroppo","glucosio","regolatore","acido"]);
  const words = name.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu," ").split(/\s+/).filter(Boolean);
  for (const w of words) {
    if (!stop.has(w) && w.length > 2) return w; // first meaningful token
  }
  return words[0] || "";
}

function upsertCheck(checks, title, updater) {
  const idx = checks.findIndex(c => (c?.title || "").toLowerCase().includes(title.toLowerCase()));
  if (idx >= 0) checks[idx] = updater(checks[idx]);
  else checks.push(updater({ title, status: "issue", severity: "medium", detail: "", fix: "", sources: [] }));
}

function enforceDeterministic(report, fields, pdfText, tdsText, extraRules) {
  const checks = Array.isArray(report.checks) ? report.checks : [];
  const textAll = `${(pdfText||"")}\n${(tdsText||"")}\n${(extraRules||"")}`.toLowerCase();

  // 1) Language compliance
  const reqLang = COUNTRY_LANG[(fields.country_of_sale||"").toLowerCase()];
  if (reqLang) {
    const provided = Array.isArray(report.product?.languages_provided) ? report.product.languages_provided.map(x=>String(x||"").toLowerCase()) : [];
    if (!provided.includes(reqLang)) {
      upsertCheck(checks, "Language Compliance", (c)=>({
        title: "Language Compliance",
        status: "issue",
        severity: "medium",
        detail: `Primary language "${reqLang}" required for ${fields.country_of_sale} is not in languages_provided.`,
        fix: `Add mandatory particulars in "${reqLang}" for sale in ${fields.country_of_sale}.`,
        sources: ["EU1169:Art 15"]
      }));
    }
  }

  // 2) QUID: if name highlights an ingredient, require % near it in text sources
  const ingr = pickIngredientFromName(fields.product_name || report.product?.name || "");
  if (ingr) {
    const quidRegex = new RegExp(`${ingr}\\s*[^\\n]{0,40}?\\d{1,3}\\s*%`, "i");
    const foundQuid = quidRegex.test(textAll);
    if (!foundQuid) {
      upsertCheck(checks, "QUID", (c)=>({
        title: "QUID",
        status: "issue",
        severity: "high",
        detail: `Sales name highlights "${ingr}", but no percentage (%) is found next to the sales name or in the ingredients list.`,
        fix: `Declare the percentage of "${ingr}" (e.g., "${ingr} 60%") near the sales name or in the ingredients list per EU 1169/2011.`,
        sources: ["EU1169:Art 22; Annex VIII"]
      }));
    }
  }

  report.checks = checks;
  return report;
}

/* ------------------------ post-processors ------------------------- */
function normalizeReport(r, fields) {
  const report = {
    version: "1.0",
    product: {
      name: r?.product?.name || fields?.product_name || "",
      country_of_sale: r?.product?.country_of_sale || fields?.country_of_sale || "",
      languages_provided: Array.isArray(r?.product?.languages_provided)
        ? r.product.languages_provided : (fields?.languages_provided || [])
    },
    summary: r?.summary || "",
    checks: Array.isArray(r?.checks) ? r.checks : []
  };

  report.checks = report.checks.map(c => ({
    title: c?.title || "Unlabeled check",
    status: c?.status === "ok" ? "ok" : c?.status === "missing" ? "missing" : "issue",
    severity: ["low","medium","high"].includes(c?.severity) ? c.severity : "medium",
    detail: c?.detail || "",
    fix: c?.status === "ok" ? "" : (c?.fix || ""),
    sources: c?.status === "ok" ? [] : (Array.isArray(c?.sources) ? c.sources : [])
  }));

  // scoring
  let score = 100, hasHigh=false, hasMedium=false;
  for (const c of report.checks) {
    if (c.status !== "ok") {
      if (c.severity === "high") { score -= 15; hasHigh = true; }
      else if (c.severity === "medium") { score -= 8; hasMedium = true; }
      else { score -= 3; }
    }
  }
  score = Math.max(0, Math.min(100, score));
  const overall_status = hasHigh ? "fail" : (hasMedium ? "caution" : "pass");
  return { ...report, overall_status, score };
}

function buildFixPackLines(report, halalChecks) {
  const lines = [];
  const add = (c, prefix="") => {
    if (c.status === "ok") return;
    lines.push(`${prefix}${c.title} [${c.severity.toUpperCase()}]`);
    if (c.detail) lines.push(`- ${c.detail}`);
    if (c.fix)    lines.push(`→ Fix: ${c.fix}`);
    if (Array.isArray(c.sources) && c.sources.length) lines.push(`Sources: ${c.sources.join("; ")}`);
    lines.push("");
  };
  for (const c of report.checks) add(c);
  if (Array.isArray(halalChecks)) for (const c of halalChecks) add(c, "Halal: ");
  return lines;
}

function makePdf({ report, halalChecks, fields }) {
  const doc = new PDFDocument({ size: "A4", margin: 36 });
  const bufs = [];
  doc.on("data", d => bufs.push(d));
  doc.on("error", e => console.error("PDF error:", e));

  // Cover / summary
  doc.fontSize(18).text(`${APP_NAME} — Compliance Assessment`, { align: "left" });
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor("#555").text(
    `Preliminary analysis based on EU 1169/2011 + KB references. Generated: ${new Date().toISOString()}`
  );
  doc.moveDown();

  // product box
  const p = report.product || {};
  doc.fillColor("#000").fontSize(11);
  doc.text(`Company: ${fields.company_name || "-"}`);
  doc.text(`Product: ${p.name || "-"}`);
  doc.text(`Shipping scope: ${fields.shipping_scope || "-"}`);
  doc.text(`Country of sale: ${p.country_of_sale || "-"}`);
  doc.text(`Languages: ${(p.languages_provided || []).join(", ") || "-"}`);
  doc.moveDown();

  doc.fontSize(12).text(`Overall: ${report.overall_status.toUpperCase()}  •  Score: ${report.score}/100`);
  if (report.summary) {
    doc.moveDown(0.5);
    doc.fontSize(10).text(report.summary, { width: 520 });
  }
  doc.moveDown();

  // EU checks
  doc.fontSize(12).text("EU 1169/2011 Checks");
  doc.moveDown(0.3);
  doc.fontSize(10);
  for (const c of report.checks) {
    doc.text(`• ${c.title} [${c.status.toUpperCase()} | ${c.severity}]`);
    if (c.detail) doc.text(`Detail: ${c.detail}`);
    if (c.status !== "ok" && c.fix) doc.text(`Fix: ${c.fix}`);
    if (c.status !== "ok" && Array.isArray(c.sources) && c.sources.length) {
      doc.text(`Sources: ${c.sources.join("; ")}`);
    }
    doc.moveDown(0.4);
  }

  // Halal page
  if (Array.isArray(halalChecks) && halalChecks.length) {
    doc.addPage();
    doc.fontSize(14).text("Halal Pre-Audit", { underline: true });
    doc.moveDown(0.5).fontSize(10);
    for (const c of halalChecks) {
      doc.text(`• ${c.title} [${c.status.toUpperCase()} | ${c.severity}]`);
      if (c.detail) doc.text(`Detail: ${c.detail}`);
      if (c.status !== "ok" && c.fix) doc.text(`Fix: ${c.fix}`);
      if (c.status !== "ok" && Array.isArray(c.sources) && c.sources.length) {
        doc.text(`Sources: ${c.sources.join("; ")}`);
      }
      doc.moveDown(0.4);
    }
  }

  // Fix Pack page (non-OK only)
  const fixes = buildFixPackLines(report, halalChecks);
  if (fixes.length) {
    doc.addPage();
    doc.fontSize(14).text("Fix Pack", { underline: true });
    doc.moveDown(0.5).fontSize(10);
    for (const line of fixes) doc.text(line);
  }

  doc.end();
  const pdfBuffer = Buffer.concat(bufs);
  return pdfBuffer.toString("base64");
}

/* ============================== handler ============================== */
export default async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST" });

  try {
    const body = await readJsonBody(req);
    const {
      product_name, company_name, company_email,
      country_of_sale, languages_provided = [],
      shipping_scope, product_category,
      label_image_data_url, label_pdf_file, // { name, base64 }
      tds_file,                              // { name, base64 }
      reference_docs_text, halal_audit
    } = body || {};

    const fields = {
      product_name, company_name, company_email,
      country_of_sale, languages_provided,
      shipping_scope, product_category
    };

    // TDS text (supports PDF via lazy pdf-parse)
    let tdsText = "";
    if (tds_file?.base64) {
      if ((tds_file.name || "").toLowerCase().endsWith(".pdf")) {
        const pdfParse = (await import("pdf-parse")).default;
        const tbuf = safeB64ToBuffer(tds_file.base64);
        const parsed = await pdfParse(tbuf);
        tdsText = parsed.text || "";
      } else {
        try { tdsText = safeB64ToBuffer(tds_file.base64).toString("utf8"); } catch {}
      }
    }

    // Label PDF text
    let labelPdfText = "";
    if (label_pdf_file?.base64) {
      const pdfParse = (await import("pdf-parse")).default;
      const buf = safeB64ToBuffer(label_pdf_file.base64);
      const parsed = await pdfParse(buf);
      labelPdfText = parsed.text || "";
    }

    // Main EU analysis (model)
    const rawReport = await analyzeEU({
      fields,
      imageDataUrl: label_image_data_url || null,
      pdfText: labelPdfText || null,
      tdsText: tdsText || null,
      extraRules: reference_docs_text || ""
    });

    // Normalize + enforce deterministic rules (QUID / Language)
    let report = normalizeReport(rawReport, fields);
    report = enforceDeterministic(report, fields, labelPdfText, tdsText, reference_docs_text);

    // Optional Halal
    let halalChecks = [];
    if (halal_audit) {
      const hal = await analyzeHalal({
        fields,
        imageDataUrl: label_image_data_url || null,
        pdfText: labelPdfText || null,
        tdsText: tdsText || null,
        extraRules: reference_docs_text || ""
      });
      halalChecks = (Array.isArray(hal) ? hal : []).map(c => ({
        title: c?.title || "Halal check",
        status: c?.status === "ok" ? "ok" : c?.status === "missing" ? "missing" : "issue",
        severity: ["low","medium","high"].includes(c?.severity) ? c.severity : "medium",
        detail: c?.detail || "",
        fix: c?.status === "ok" ? "" : (c?.fix || ""),
        sources: c?.status === "ok" ? [] : (Array.isArray(c?.sources) ? c.sources : [])
      }));
    }

    // PDF (includes Fix Pack page)
    const pdf_base64 = makePdf({ report, halalChecks, fields });

    // Email (optional, now stricter)
    let email_status = "skipped";
    if (!RESEND_FROM) {
      email_status = "skipped: set RESEND_FROM to a verified domain sender";
    } else if (process.env.RESEND_API_KEY && company_email) {
      try {
        await resend.emails.send({
          from: RESEND_FROM,
          to: company_email,
          subject: `${APP_NAME} — ${fields.product_name || "Your Product"}`,
          html: `<p>Hello ${fields.company_name || ""},</p>
                 <p>Attached is your preliminary compliance report for <strong>${fields.product_name || "your product"}</strong>.</p>
                 <p>Best,<br/>${APP_NAME}</p>`,
          attachments: [
            { filename: "Preflight_Report.pdf", content: pdf_base64, contentType: "application/pdf" }
          ]
        });
        email_status = "sent";
      } catch (e) {
        email_status = "failed: " + (e?.message || e);
      }
    }

    return sendJson(res, 200, {
      report,
      score: report.score,
      halal_audit: !!halal_audit,
      halal_checks: halalChecks,
      pdf_base64,
      email_status
    });
  } catch (err) {
    console.error("API error:", err);
    return sendJson(res, 500, { error: err?.message || String(err) });
  }
}
