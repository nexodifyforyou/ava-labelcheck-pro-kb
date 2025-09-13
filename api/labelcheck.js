// api/labelcheck.js
export const config = { runtime: "nodejs" };

/* ========= BRAND & EMAIL ========= */
const APP_NAME = "Nexodify’s Label Compliance Preflight";
// Default sender (works for Resend test emails / verified domains)
const DEFAULT_FROM = `${APP_NAME} <onboarding@resend.dev>`;
/* ================================= */

import OpenAI from "openai";
import PDFDocument from "pdfkit";
import { Resend } from "resend";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/* ====== clients / env ====== */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY ?? "");
const RESEND_FROM = process.env.RESEND_FROM || DEFAULT_FROM;

/* ====== small helpers ====== */
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

function clamp(s, n) {
  if (!s) return "";
  s = String(s);
  return s.length > n ? s.slice(0, n) : s;
}

function b64FromDataUrl(dataUrl) {
  if (!dataUrl) return "";
  const i = dataUrl.indexOf(",");
  return i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
}

function extractJson(content, wantArray = false) {
  if (!content) return wantArray ? [] : {};
  let t = String(content).trim();
  const m = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (m) { try { return JSON.parse(m[1]); } catch {} }
  try { return JSON.parse(t); } catch {}
  const open = wantArray ? "[" : "{";
  const close = wantArray ? "]" : "}";
  const s = t.indexOf(open), e = t.lastIndexOf(close);
  if (s !== -1 && e !== -1 && e > s) {
    try { return JSON.parse(t.slice(s, e + 1)); } catch {}
  }
  return wantArray ? [] : {};
}

/* ====== KB loading (optional) ====== */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
function readIf(rel) {
  try { return fs.readFileSync(path.join(__dirname, "..", rel), "utf8"); }
  catch { return ""; }
}
const KB_HOUSE = readIf("kb/house_rules.md");
const KB_REFS  = readIf("kb/refs.md");
const KB_BUYER = readIf("kb/buyer-generic-eu.md");
const KB_HALAL = readIf("kb/halal_rules.md");

/* ====== prompts ====== */
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
- Be precise. If unsure, mark as "missing".
- Include Fix & Sources only for non-OK, but for OK items add a short "detail" and a compact "sources" entry.
- Use concise citations: "EU1169:Art 22; Annex VIII" or KB filenames: "buyer-generic-eu.md", "refs.md", "TDS: file.pdf".
- Core checks: Sales name, Ingredient order, Annex II allergen emphasis, QUID (Art 22), Net quantity, Date marking, Storage/use, FBO name/EU address, Nutrition declaration order per 100g/100ml, Language for country of sale, Claims.
`;

const HALAL_PROMPT = `
You are performing a Halal pre-audit screening based on halal_rules.md and buyer inputs.
Return ONLY a pure JSON array.
Each item: { "title":"", "status":"ok|issue|missing", "severity":"low|medium|high", "detail":"", "fix":"", "sources":[] }.
Consider forbidden ingredients (porcine, alcohol), gelatin/enzymes origin, carriers/solvents (ethanol), processing aids, logo/issuer authenticity, segregation risk.
`;

/* ====== OpenAI calls ====== */
async function askEU({ fields, imageDataUrl, labelPdfText, tdsText, extraText }) {
  const userParts = [];
  const kbText = [
    KB_HOUSE && `House Rules:\n${KB_HOUSE}`,
    KB_REFS  && `EU References:\n${KB_REFS}`,
    KB_BUYER && `Buyer Generic Rules:\n${KB_BUYER}`
  ].filter(Boolean).join("\n\n");
  if (kbText) userParts.push({ type: "text", text: clamp(kbText, 9000) });

  userParts.push({ type: "text", text: `Fields:\n${clamp(JSON.stringify(fields, null, 2), 3500)}` });
  if (extraText) userParts.push({ type: "text", text: `Extra rules:\n${clamp(extraText, 3500)}` });
  if (tdsText)   userParts.push({ type: "text", text: `TDS excerpt:\n${clamp(tdsText, 6000)}` });
  if (labelPdfText) userParts.push({ type: "text", text: `Label PDF text:\n${clamp(labelPdfText, 6000)}` });
  if (imageDataUrl) userParts.push({ type: "image_url", image_url: { url: imageDataUrl } });

  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.1,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userParts },
      { role: "user", content: "Return only the JSON object—no commentary, no code fences." }
    ]
  });
  return extractJson(r.choices?.[0]?.message?.content || "{}", false);
}

async function askHalal({ fields, imageDataUrl, labelPdfText, tdsText, extraText }) {
  const parts = [];
  const kb = (KB_HALAL ? `halal_rules.md:\n${KB_HALAL}\n\n` : "") + (KB_BUYER ? `buyer-generic-eu.md:\n${KB_BUYER}` : "");
  if (kb) parts.push({ type: "text", text: clamp(kb, 8000) });
  parts.push({ type: "text", text: `Fields:\n${clamp(JSON.stringify(fields, null, 2), 3500)}` });
  if (extraText) parts.push({ type: "text", text: `Extra rules:\n${clamp(extraText, 3500)}` });
  if (tdsText)   parts.push({ type: "text", text: `TDS excerpt:\n${clamp(tdsText, 6000)}` });
  if (labelPdfText) parts.push({ type: "text", text: `Label PDF text:\n${clamp(labelPdfText, 6000)}` });
  if (imageDataUrl) parts.push({ type: "image_url", image_url: { url: imageDataUrl } });

  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.1,
    messages: [
      { role: "system", content: HALAL_PROMPT },
      { role: "user", content: parts },
      { role: "user", content: "Return only the JSON array—no commentary, no code fences." }
    ]
  });
  return extractJson(r.choices?.[0]?.message?.content || "[]", true);
}

/* ====== deterministic checks ====== */
const COUNTRY_LANG = {
  italy: "it", germany: "de", france: "fr", spain: "es", portugal: "pt",
  netherlands: "nl", belgium: "nl", austria: "de", denmark: "da",
  sweden: "sv", finland: "fi", poland: "pl", romania: "ro", greece: "el",
  czechia: "cs", slovakia: "sk", slovenia: "sl", hungary: "hu", ireland: "en",
  "united kingdom": "en"
};

function keywordFromName(name) {
  if (!name) return "";
  const stop = new Set(["di","de","al","alla","allo","candite","canditi","sgocciolate","sgocciolato","sciroppo","glucosio","regolatore","acido","concentrato"]);
  const words = name.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu," ").split(/\s+/).filter(Boolean);
  for (const w of words) if (!stop.has(w) && w.length > 2) return w;
  return words[0] || "";
}

function upsert(checks, title, make) {
  const idx = checks.findIndex(c => (c?.title || "").toLowerCase() === title.toLowerCase());
  if (idx >= 0) checks[idx] = make(checks[idx]);
  else checks.push(make({ title, status: "issue", severity: "medium", detail: "", fix: "", sources: [] }));
}

function enforce(report, fields, joinedText) {
  const checks = Array.isArray(report.checks) ? report.checks : [];

  // Language compliance
  const need = COUNTRY_LANG[(fields.country_of_sale||"").toLowerCase()];
  if (need) {
    const have = Array.isArray(report.product?.languages_provided)
      ? report.product.languages_provided.map(x=>String(x||"").toLowerCase())
      : (fields.languages_provided||[]).map(x=>String(x||"").toLowerCase());
    if (!have.includes(need)) {
      upsert(checks, "Language Compliance", () => ({
        title: "Language Compliance",
        status: "issue",
        severity: "medium",
        detail: `Primary language "${need}" required for ${fields.country_of_sale} not present.`,
        fix: `Add mandatory particulars in "${need}" for sale in ${fields.country_of_sale}.`,
        sources: ["EU1169:Art 15"]
      }));
    } else {
      upsert(checks, "Language Compliance", () => ({
        title: "Language Compliance",
        status: "ok",
        severity: "low",
        detail: `Includes "${need}" for sale in ${fields.country_of_sale}.`,
        fix: "",
        sources: ["EU1169:Art 15"]
      }));
    }
  }

  // QUID
  const token = keywordFromName(fields.product_name || report.product?.name || "");
  if (token) {
    const quidRegex = new RegExp(`${token}\\s*[^\\n]{0,40}?\\d{1,3}\\s*%`, "i");
    const ok = quidRegex.test(joinedText || "");
    if (!ok) {
      upsert(checks, "QUID", () => ({
        title: "QUID",
        status: "issue",
        severity: "high",
        detail: `Sales name highlights "${token}", but no percentage (%) is found near sales name or in the ingredients list.`,
        fix: `Declare the percentage of "${token}" (e.g., "${token} 60%") near the sales name or in the ingredients list.`,
        sources: ["EU1169:Art 22; Annex VIII"]
      }));
    } else {
      upsert(checks, "QUID", () => ({
        title: "QUID",
        status: "ok",
        severity: "low",
        detail: `Percentage for "${token}" is present.`,
        fix: "",
        sources: ["EU1169:Art 22; Annex VIII"]
      }));
    }
  }

  report.checks = checks;
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

/* ====== PDF (styled) ====== */
function addHeader(doc, title) {
  doc.rect(36, 36, 523, 42).fill("#0f1530");
  doc.fill("#eaf0ff").fontSize(16).text(title, 44, 48, { width: 510, align: "left" });
  doc.moveDown(2).fill("#000");
}

function addFoot(doc) {
  doc.moveDown(1.0);
  doc.fontSize(8).fill("#667").text(
    "This preflight is an automated, best-effort screening based on the inputs provided and public/KB references. "+
    "It is not legal advice or a conclusive compliance opinion. Professional review is recommended.",
    { width: 520 }
  );
  doc.fill("#000");
}

function makePdf({ report, halalChecks, fields }) {
  const doc = new PDFDocument({ size: "A4", margin: 36 });
  const bufs = [];
  doc.on("data", d => bufs.push(d));
  doc.on("error", e => console.error("PDF error:", e));

  addHeader(doc, `${APP_NAME} — Compliance Report`);
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

  if (Array.isArray(halalChecks) && halalChecks.length) {
    doc.addPage();
    addHeader(doc, "Halal Pre-Audit");
    doc.fontSize(10).fill("#000");
    for (const c of halalChecks) {
      doc.fill(c.status === "ok" ? "#0a7" : c.severity === "high" ? "#c00" : c.severity === "medium" ? "#c70" : "#000")
         .text(`• ${c.title} [${c.status.toUpperCase()} | ${c.severity}]`);
      doc.fill("#000");
      if (c.detail) doc.text(`Detail: ${c.detail}`);
      if (c.status !== "ok" && c.fix) doc.text(`Fix: ${c.fix}`);
      if (Array.isArray(c.sources) && c.sources.length) doc.text(`Sources: ${c.sources.join("; ")}`);
      doc.moveDown(0.5);
    }
    addFoot(doc);
  }

  // Fix Pack page
  doc.addPage();
  addHeader(doc, "Fix Pack (copy-paste suggestions)");
  doc.fontSize(10).fill("#000");
  for (const c of report.checks || []) {
    if (c.status === "ok") {
      // Still list OK with source
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
  addFoot(doc);

  doc.end();
  const pdfBuffer = Buffer.concat(bufs);
  return pdfBuffer.toString("base64");
}

/* ====== handler ====== */
export default async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST" });

  try {
    const body = await readJsonBody(req);
    const {
      product_name, company_name, company_email,
      country_of_sale, languages_provided = [],
      shipping_scope, product_category,
      label_image_data_url, label_pdf_file,
      tds_file,
      reference_docs_text, halal_audit
    } = body || {};

    const fields = {
      product_name, company_name, company_email,
      country_of_sale, languages_provided,
      shipping_scope, product_category
    };

    // Parse TDS if PDF, else use as text
    let tdsText = "";
    if (tds_file?.base64) {
      if ((tds_file.name || "").toLowerCase().endsWith(".pdf")) {
        const pdfParse = (await import("pdf-parse")).default;
        const buf = Buffer.from(b64FromDataUrl(tds_file.base64), "base64");
        const parsed = await pdfParse(buf);
        tdsText = parsed.text || "";
      } else {
        try { tdsText = Buffer.from(b64FromDataUrl(tds_file.base64), "base64").toString("utf8"); } catch {}
      }
    }

    // Label PDF → text (if provided as PDF)
    let labelPdfText = "";
    if (label_pdf_file?.base64) {
      const pdfParse = (await import("pdf-parse")).default;
      const buf = Buffer.from(b64FromDataUrl(label_pdf_file.base64), "base64");
      const parsed = await pdfParse(buf);
      labelPdfText = parsed.text || "";
    }

    // 1st pass (LLM)
    const raw = await askEU({
      fields,
      imageDataUrl: label_image_data_url || null,
      labelPdfText: labelPdfText || null,
      tdsText: tdsText || null,
      extraText: reference_docs_text || ""
    });

    // Normalize
    const report = {
      version: "1.0",
      product: {
        name: raw?.product?.name || fields.product_name || "",
        country_of_sale: raw?.product?.country_of_sale || fields.country_of_sale || "",
        languages_provided: Array.isArray(raw?.product?.languages_provided)
          ? raw.product.languages_provided : (fields.languages_provided || [])
      },
      summary: raw?.summary || "",
      checks: Array.isArray(raw?.checks) ? raw.checks.map(c => ({
        title: c?.title || "Check",
        status: c?.status === "ok" ? "ok" : c?.status === "missing" ? "missing" : "issue",
        severity: ["low","medium","high"].includes(c?.severity) ? c.severity : "medium",
        detail: c?.detail || "",
        fix: c?.status === "ok" ? "" : (c?.fix || ""),
        sources: Array.isArray(c?.sources) ? c.sources : []
      })) : []
    };

    // Deterministic: language + QUID
    const joined = `${(labelPdfText||"")}\n${(tdsText||"")}\n${(reference_docs_text||"")}`.toLowerCase();
    enforce(report, fields, joined);

    // Recompute score/overall
    const { score, overall } = recomputeScore(report);
    report.score = score;
    report.overall_status = overall;

    // Optional Halal pre-audit
    let halalChecks = [];
    if (halal_audit) {
      const hal = await askHalal({
        fields,
        imageDataUrl: label_image_data_url || null,
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

    // PDF (always build)
    const pdf_base64 = makePdf({ report, halalChecks, fields });

    // Email (optional)
    let email_status = "skipped";
    if (process.env.RESEND_API_KEY && company_email) {
      const recipients = String(company_email).split(/[;,]/).map(s => s.trim()).filter(Boolean);
      try {
        await resend.emails.send({
          from: RESEND_FROM,
          to: recipients,
          subject: `${APP_NAME} — ${fields.product_name || "Your Product"}`,
          html: `<p>Hello ${fields.company_name || ""},</p>
                 <p>Attached is your preliminary compliance report for <strong>${fields.product_name || "your product"}</strong>.</p>
                 <p>Best,<br/>${APP_NAME}</p>`,
          attachments: [
            { filename: "Preflight_Report.pdf", content: pdf_base64, contentType: "application/pdf" }
          ]
        });
        email_status = `sent to ${recipients.length}`;
      } catch (e) {
        email_status = "failed: " + (e?.message || e);
      }
    }

    return sendJson(res, 200, {
      ok: true,
      version: "v4-clean",
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
