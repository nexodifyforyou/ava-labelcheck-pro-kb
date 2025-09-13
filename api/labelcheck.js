// ========= BRAND / NAME =========
// ***** CHANGE HERE: your public app name used in PDF & emails *****
const APP_NAME = "Nexodify’s Label Compliance Preflight";
// =================================

export const config = { runtime: "nodejs" };

import OpenAI from "openai";
import PDFDocument from "pdfkit";
import { Resend } from "resend";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";

// ======= MODEL & CORPUS SETTINGS (safe defaults) =======
const MODEL_NAME = "gpt-4o";
const FALLBACK_MODEL = "gpt-4o-mini";
const MAX_CORPUS_CHARS = 16000; // whole sections only, stop before exceeding
const LAYOUT_VERSION = "v5";    // PDF/version marker
// =======================================================

// --- Lazy OpenAI client ---
let _openai = null;
function getOpenAI() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Missing OPENAI_API_KEY");
  if (!_openai) _openai = new OpenAI({ apiKey: key });
  return _openai;
}
const resend = new Resend(process.env.RESEND_API_KEY);

// ---------- EU required checks & messages ----------
const EU_CHECK_IDS = [
  "name_of_food","ingredients","allergens","quid","net_qty",
  "date_marking","storage_use","business_address","nutrition","language","claims"
];

const EU_TITLES = {
  name_of_food: "Name of food",
  ingredients: "Ingredient list",
  allergens: "Allergen declaration",
  quid: "QUID",
  net_qty: "Net quantity",
  date_marking: "Date marking",
  storage_use: "Storage/conditions of use",
  business_address: "Business name & EU address",
  nutrition: "Nutrition declaration",
  language: "Language compliance",
  claims: "Claims (if any)"
};

const DEFAULT_FIX = {
  name_of_food: "Include the legal/sales name on the front in a prominent position.",
  ingredients: "Provide a full ingredient list in descending order by weight.",
  allergens: "Emphasize Annex II allergens within the ingredient list using bold.",
  quid: "Declare the % next to the highlighted ingredient in or near the name.",
  net_qty: "Show net quantity with legal units (g/ml) in the same field of vision as the name.",
  date_marking: "Add 'best before' (or 'use by' where applicable) with a clear date format.",
  storage_use: "Add storage conditions and any specific conditions of use.",
  business_address: "Provide the FBO name and EU postal address (or EU importer if needed).",
  nutrition: "Provide nutrition declaration per 100 g/ml in the prescribed order/units.",
  language: "Ensure mandatory particulars are in the language(s) of the country of sale.",
  claims: "Ensure claims are permitted and substantiated; remove or adjust if not."
};

function fixFor(id, status, fix) {
  if (status === "ok") return "";
  if (fix && String(fix).trim()) return fix;
  return DEFAULT_FIX[id] || "Provide compliant text per EU 1169/2011.";
}

const SYSTEM_PROMPT_EU =
  "You are a food label preflight assistant for the EU (Regulation (EU) No 1169/2011). " +
  "Decision order: (1) Label artwork (image/PDF text), (2) TDS + Extra rules (authoritative unless illegal), " +
  "(3) refs.md EU anchors, (4) other /kb files. Ignore irrelevant sources. " +
  "If the label is missing something that TDS confirms, set status=issue, severity=medium and explain it's supported by TDS but not visible on artwork. " +
  "Return ONLY valid JSON: { version, product, summary, checks }. " +
  "product MUST include: name, country_of_sale, languages_provided[]. " +
  "checks MUST be an array of exactly these ids: " + EU_CHECK_IDS.join(", ") + ". " +
  "Each check: { id, status: ok|issue|missing, severity: low|medium|high, detail, fix, sources[] }. " +
  "Provide 'fix' and 'sources' ONLY for issue/missing; keep ok items clean. " +
  "Citations use exact KB filenames (no 'KB:'), 'TDS: <filename>' for TDS, and refs.md tags like 'EU1169:Art 9(1)(b)'. " +
  "Be concise and specific; return only the JSON object.";

const SYSTEM_PROMPT_HALAL =
  "You are performing a Halal pre-audit triage based on halal_rules.md and any buyer/cert files provided. " +
  "Use decision order: (1) label artwork (image/PDF text), (2) TDS + Extra rules, (3) halal_rules.md, (4) other KB. " +
  "Return ONLY JSON: { checks: [ { id, title, status, severity, detail, fix, sources[] } ] }. " +
  "Include checks for: prohibited ingredients (alcohol/porcine/gelatin/enzymes), flavour carriers/solvents, certification mark & issuer, cross-contamination/segregation, traceability/docs if label claims Halal. " +
  "Provide fix & sources ONLY for issue/missing; keep ok clean. Be concise.";

// ---------- IO & KB ingestion ----------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const kbDir = path.join(__dirname, "..", "kb");

async function extractFromPdfBuffer(buf) {
  try {
    const data = await pdfParse(buf);
    return (data.text || "").trim();
  } catch {
    return "";
  }
}
async function extractFromDocxBuffer(buf) {
  try {
    const { value } = await mammoth.convertToHtml({ buffer: buf });
    const text = value
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return text;
  } catch {
    return "";
  }
}

async function loadRepoKB() {
  const out = [];
  try {
    const files = fs.existsSync(kbDir) ? fs.readdirSync(kbDir) : [];
    files.sort((a, b) => {
      if (a.toLowerCase() === "refs.md") return -1;
      if (b.toLowerCase() === "refs.md") return 1;
      return a.localeCompare(b);
    });
    for (const f of files) {
      if (!/\.(md|txt|pdf|docx)$/i.test(f)) continue;
      const p = path.join(kbDir, f);
      let text = "";
      if (/\.(md|txt)$/i.test(f)) {
        text = fs.readFileSync(p, "utf-8");
      } else if (/\.pdf$/i.test(f)) {
        text = await extractFromPdfBuffer(fs.readFileSync(p));
      } else if (/\.docx$/i.test(f)) {
        text = await extractFromDocxBuffer(fs.readFileSync(p));
      }
      if (text && text.trim()) out.push({ name: f, text: text.trim() });
    }
  } catch {}
  return out;
}

async function extractTextFromUpload(fileObj) {
  if (!fileObj || !fileObj.name || !fileObj.base64) return null;
  const name = fileObj.name;
  try {
    const comma = fileObj.base64.indexOf(",");
    const b64 = comma >= 0 ? fileObj.base64.slice(comma + 1) : fileObj.base64;
    const buf = Buffer.from(b64, "base64");
    if (/\.pdf$/i.test(name)) {
      const text = await extractFromPdfBuffer(buf);
      return { name, text };
    } else if (/\.docx$/i.test(name)) {
      const text = await extractFromDocxBuffer(buf);
      return { name, text };
    } else if (/\.(md|txt)$/i.test(name)) {
      const text = buf.toString("utf-8");
      return { name, text };
    } else if (/\.(jpg|jpeg|png)$/i.test(name)) {
      // not text; return null here (images go as data URLs elsewhere)
      return null;
    } else {
      // Unknown: try utf-8
      return { name, text: buf.toString("utf-8") };
    }
  } catch {
    return null;
  }
}

function buildCorpus({ repoKB, labelPdfText, labelPdfName, tdsDoc, extraText }) {
  let remaining = MAX_CORPUS_CHARS;
  const parts = [];
  const push = (title, text) => {
    if (!text || !text.trim()) return;
    const chunk = `\n\n=== ${title} ===\n${text.trim()}\n`;
    if (chunk.length <= remaining) {
      parts.push(chunk);
      remaining -= chunk.length;
    }
  };

  const refs = repoKB.find(d => d.name.toLowerCase() === "refs.md");
  if (refs) push(refs.name, refs.text);
  if (labelPdfText) push(`Label PDF Text (${labelPdfName || "label.pdf"})`, labelPdfText);
  if (tdsDoc) push(`TDS: ${tdsDoc.name}`, tdsDoc.text);
  if (extraText && extraText.trim()) push("Client Extra Rules", extraText.trim());
  for (const d of repoKB) {
    if (refs && d.name === refs.name) continue;
    push(d.name, d.text);
    if (remaining <= 0) break;
  }
  return parts.join("").trim();
}

// ---------- Normalize & score ----------
function normalizeEuReport(raw, fields) {
  const r = raw && typeof raw === "object" ? raw : {};
  const product = r.product || {};
  let rawChecks = Array.isArray(r.checks) ? r.checks : (r.checks && typeof r.checks === "object" ? Object.values(r.checks) : []);

  const byId = new Map(rawChecks.map(c => [c.id, c]));
  const checks = EU_CHECK_IDS.map(id => {
    const c = byId.get(id) || {};
    const status = (c.status || "missing").toLowerCase();
    let sev = c.severity ? String(c.severity).toLowerCase() :
      status === "missing" ? "high" : status === "issue" ? "medium" : "low";

    let sources = [];
    if (status !== "ok") {
      const s = Array.isArray(c.sources) ? c.sources : [];
      sources = [...new Set(s.map(x => String(x).trim()).filter(Boolean))].slice(0, 3);
    }

    return {
      id,
      title: EU_TITLES[id] || id,
      status: ["ok","issue","missing"].includes(status) ? status : "missing",
      severity: ["low","medium","high"].includes(sev) ? sev : "medium",
      detail: c.detail || "",
      fix: fixFor(id, status, c.fix || ""),
      sources
    };
  });

  const hasHigh = checks.some(c => c.status !== "ok" && c.severity === "high");
  const hasMed = checks.some(c => c.status !== "ok" && c.severity === "medium");
  const overall_status = hasHigh ? "fail" : hasMed ? "caution" : "pass";

  const finalProduct = {
    name: product.name || (fields.product_name || ""),
    country_of_sale: product.country_of_sale || (fields.country_of_sale || ""),
    languages_provided: Array.isArray(product.languages_provided)
      ? product.languages_provided
      : (fields.languages_provided || [])
  };

  return {
    version: "1.0",
    product: finalProduct,
    overall_status,
    summary: r.summary || (overall_status === "pass" ? "All core items present." : "Issues found—see fixes."),
    checks
  };
}

function scoreFromChecks(checks, halalChecks = []) {
  // Start 100; deduct for issues/missing.
  let score = 100;
  const all = [...(checks || []), ...(halalChecks || [])];
  for (const c of all) {
    if (c.status === "ok") continue;
    if (c.severity === "high") score -= 12;
    else if (c.severity === "medium") score -= 6;
    else score -= 3;
  }
  if (score < 0) score = 0;
  if (score > 100) score = 100;
  return score;
}

function buildFixPack(euReport, halalChecks, meta) {
  const lines = [];
  lines.push(`${APP_NAME} — Fix Pack`);
  lines.push(`Product: ${meta.product_name || "-"}`);
  lines.push(`Company: ${meta.company_name || "-"}`);
  lines.push(`Date: ${new Date().toISOString()}`);
  lines.push("");
  const add = (prefix, c) => {
    const src = Array.isArray(c.sources) && c.sources.length ? ` [Sources: ${c.sources.join("; ")}]` : "";
    const detail = c.detail ? ` — ${c.detail}` : "";
    const fix = c.fix ? c.fix : "Add compliant text as per cited sources.";
    lines.push(`${prefix} ${c.title}: ${c.status.toUpperCase()} | ${c.severity}${detail}`);
    lines.push(`   → ${fix}${src}`);
    lines.push("");
  };
  for (const c of (euReport?.checks || [])) {
    if (c.status !== "ok") add("EU", c);
  }
  for (const c of (halalChecks || [])) {
    if (c.status !== "ok") add("Halal", c);
  }
  return lines.join("\n");
}

// ---------- Model calls ----------
async function callJsonModel({ model, messages }) {
  const resp = await getOpenAI().chat.completions.create({ model, messages, temperature: 0 });
  let text = resp.choices?.[0]?.message?.content || "{}";
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s >= 0 && e >= 0) text = text.slice(s, e + 1);
  return JSON.parse(text);
}

async function analyzeEU({ fields, corpus, label_image_data_url, label_pdf_text, label_pdf_name }) {
  const userContent = [
    { type: "text", text: "Knowledge Corpus (read in order; ignore irrelevant):" },
    { type: "text", text: corpus || "(empty)" },
    { type: "text", text: "Provided fields (JSON): " + JSON.stringify(fields) }
  ];
  if (label_pdf_text) {
    userContent.push({ type: "text", text: `Label PDF extracted text (${label_pdf_name || "label.pdf"}):` });
    userContent.push({ type: "text", text: label_pdf_text.slice(0, 8000) });
  }
  if (label_image_data_url) {
    userContent.push({ type: "image_url", image_url: { url: label_image_data_url } });
  }
  userContent.push({ type: "text", text:
    "Return ONLY JSON with keys: version, product, summary, checks. checks must include exactly: " +
    EU_CHECK_IDS.join(", ") + ". Provide fix & sources only for issue/missing." });

  const messages = [
    { role: "system", content: SYSTEM_PROMPT_EU },
    { role: "user", content: userContent }
  ];

  for (const m of [MODEL_NAME, FALLBACK_MODEL]) {
    try { return await callJsonModel({ model: m, messages }); }
    catch (e) { console.error("EU analyze error on", m, e?.message || e); }
  }
  return { version: "1.0", product: {}, summary: "Model failed.", checks: EU_CHECK_IDS.map(id => ({ id, status:"missing", severity:"medium", detail:"", fix:"", sources:[] })) };
}

async function analyzeHalal({ fields, corpus, label_image_data_url, label_pdf_text, label_pdf_name }) {
  const userContent = [
    { type: "text", text: "Halal-relevant Corpus (includes halal_rules.md):" },
    { type: "text", text: corpus || "(empty)" },
    { type: "text", text: "Provided fields (JSON): " + JSON.stringify(fields) }
  ];
  if (label_pdf_text) {
    userContent.push({ type: "text", text: `Label PDF extracted text (${label_pdf_name || "label.pdf"}):` });
    userContent.push({ type: "text", text: label_pdf_text.slice(0, 8000) });
  }
  if (label_image_data_url) userContent.push({ type: "image_url", image_url: { url: label_image_data_url } });
  userContent.push({ type: "text", text:
    "Return ONLY JSON: { checks: [ { id, title, status, severity, detail, fix, sources } ] }. Provide fix & sources only for issue/missing." });

  const messages = [
    { role: "system", content: SYSTEM_PROMPT_HALAL },
    { role: "user", content: userContent }
  ];
  for (const m of [MODEL_NAME, FALLBACK_MODEL]) {
    try { return await callJsonModel({ model: m, messages }); }
    catch (e) { console.error("Halal analyze error on", m, e?.message || e); }
  }
  return { checks: [] };
}

async function recoverEssentialsFromImage(label_image_data_url) {
  if (!label_image_data_url) return { languages_detected: [] };
  const messages = [
    { role: "system", content:
      "Extract ONLY from the label image. Return JSON { name, ingredients_text, net_qty_text, date_marking_text, nutrition_text, business_text, languages_detected }." },
    { role: "user", content: [
      { type: "text", text: "Find: sales name; ingredients list; net quantity; date marking; nutrition snippet; business operator block; languages present (ISO codes)." },
      { type: "image_url", image_url: { url: label_image_data_url } },
      { type: "text", text: "Return ONLY JSON with keys above." }
    ]}
  ];
  try {
    const resp = await callJsonModel({ model: FALLBACK_MODEL, messages });
    if (!Array.isArray(resp.languages_detected)) resp.languages_detected = [];
    return resp;
  } catch (e) {
    console.error("recoverEssentials:", e?.message || e);
    return { languages_detected: [] };
  }
}

function applyRecovered(report, recovered, fields) {
  const out = JSON.parse(JSON.stringify(report));
  const okWith = (id, snippet) => {
    const c = out.checks.find(ch => ch.id === id);
    if (!c) return;
    c.status = "ok";
    c.severity = "low";
    if (snippet && !c.detail) c.detail = snippet.slice(0, 400) + (snippet.length > 400 ? "…" : "");
    c.fix = "";
    c.sources = [];
  };
  if (recovered.name && (!out.product.name || !out.product.name.trim())) out.product.name = recovered.name;
  if (recovered.ingredients_text) okWith("ingredients", "Detected list: " + recovered.ingredients_text);
  if (recovered.net_qty_text)    okWith("net_qty", recovered.net_qty_text);
  if (recovered.date_marking_text) okWith("date_marking", recovered.date_marking_text);
  if (recovered.nutrition_text)  okWith("nutrition", recovered.nutrition_text);
  if (recovered.business_text)   okWith("business_address", recovered.business_text);

  const langCheck = out.checks.find(ch => ch.id === "language");
  if (langCheck) {
    const required = (fields.languages_provided || []).map(s => s.toLowerCase());
    const detected = (recovered.languages_detected || []).map(s => s.toLowerCase());
    if (required.length && detected.length) {
      const overlap = required.some(code => detected.includes(code));
      if (overlap) {
        langCheck.status = "ok";
        langCheck.severity = "low";
        if (!langCheck.detail) langCheck.detail = `Detected languages: ${detected.join(", ")}`;
        langCheck.fix = "";
        langCheck.sources = [];
      } else {
        langCheck.status = "issue";
        langCheck.severity = "medium";
        langCheck.detail = `Detected: ${detected.join(", ") || "-"}; Required: ${required.join(", ") || "-"}.`;
      }
    }
  }

  const hasHigh = out.checks.some(c => c.status !== "ok" && c.severity === "high");
  const hasMed = out.checks.some(c => c.status !== "ok" && c.severity === "medium");
  out.overall_status = hasHigh ? "fail" : hasMed ? "caution" : "pass";
  return out;
}

// ---------- PDF ----------
function buildPdf({ report, halalChecks, score, meta }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 56 });
    const chunks = [];
    doc.on("data", c => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const M = doc.page.margins.left;
    const W = doc.page.width - M * 2;
    const today = new Date().toISOString().split("T")[0];

    doc.font("Helvetica-Bold").fontSize(22).fillColor("#0b1020")
      .text(`${APP_NAME} — Compliance Preflight (${LAYOUT_VERSION})`, M, M, { width: W - 170 });
    doc.moveDown(0.2);
    doc.font("Helvetica").fontSize(10).fillColor("#666")
      .text("Preliminary assistant output with citations; not legal advice.", { width: W - 170 });

    // Stamp box
    const stamp = { x: M + W - 160, y: M - 8, w: 160, h: 64 };
    doc.save();
    doc.lineWidth(1.5).strokeColor("#4f7dff").roundedRect(stamp.x, stamp.y, stamp.w, stamp.h, 8).stroke();
    doc.fillColor("#4f7dff").font("Helvetica-Bold").fontSize(12).text("SCORE", stamp.x + 12, stamp.y + 10);
    doc.fillColor("#0b1020").font("Helvetica-Bold").fontSize(18).text(String(score).padStart(3," "), stamp.x + 12, stamp.y + 28);
    doc.restore();

    const kv = (k, v) => {
      doc.font("Helvetica-Bold").fillColor("#111").text(k + ": ", { continued: true });
      doc.font("Helvetica").fillColor("#222").text(v || "-");
    };
    doc.moveDown(1);
    doc.font("Helvetica-Bold").fontSize(12).text("Report Details");
    kv("Date", today);
    kv("Company", meta.company_name || "-");
    kv("Product", meta.product_name || "-");
    kv("Country of sale", report?.product?.country_of_sale || "-");
    kv("Languages", (report?.product?.languages_provided || []).join(", ") || "-");
    kv("Halal pre-audit", meta.halal_audit ? "ON" : "OFF");

    doc.moveDown(0.6);
    const overall = (report?.overall_status || "caution").toLowerCase();
    const badgeText = overall.toUpperCase();
    const badgeColor = overall === "pass" ? "#10b981" : overall === "fail" ? "#ef4444" : "#f59e0b";
    const badgeW = doc.widthOfString(badgeText) + 16;
    doc.save();
    doc.fillColor(badgeColor).roundedRect(M, doc.y, badgeW, 18, 6).fill();
    doc.fillColor("#fff").font("Helvetica-Bold").fontSize(10).text(badgeText, M + 8, doc.y + 4);
    doc.restore();

    doc.moveDown(1.1);
    doc.font("Helvetica").fontSize(11).fillColor("#333")
      .text(report?.summary || "-", M, doc.y, { width: W });

    doc.moveDown(0.6);
    doc.lineWidth(0.6).strokeColor("#e5e7eb").moveTo(M, doc.y).lineTo(M + W, doc.y).stroke();
    doc.moveDown(0.4);

    // Section drawer
    const drawSection = (title) => {
      doc.font("Helvetica-Bold").fontSize(13).fillColor("#0b1020").text(title);
      doc.moveDown(0.2);
    };
    const drawCheck = (c) => {
      const tagColor = c.status === "ok" ? "#10b981" : c.status === "missing" ? "#ef4444" : "#f59e0b";
      const yStart = doc.y;
      doc.fillColor("#111").font("Helvetica-Bold").fontSize(12).text("• " + (c.title || "Untitled"), M, yStart);
      const tag = `[${(c.status || "").toUpperCase()} | ${(c.severity || "").toLowerCase()}]`;
      doc.save();
      doc.fillColor(tagColor).font("Helvetica-Bold").fontSize(9).text(tag, M, yStart, { width: W, align: "right" });
      doc.restore();
      if (c.detail) {
        doc.moveDown(0.1);
        doc.font("Helvetica").fontSize(10).fillColor("#444").text("Detail: " + c.detail, M + 14, doc.y, { width: W - 14 });
      }
      if (c.status !== "ok") {
        if (c.fix) {
          doc.moveDown(0.1);
          doc.font("Helvetica").fontSize(10).fillColor("#0b3d02").text("Fix: " + c.fix, M + 14, doc.y, { width: W - 14 });
        }
        if (Array.isArray(c.sources) && c.sources.length) {
          doc.moveDown(0.1);
          doc.font("Helvetica").fontSize(9).fillColor("#555").text("Sources: " + c.sources.join("; "), M + 14, doc.y, { width: W - 14 });
        }
      }
      doc.moveDown(0.35);
      doc.lineWidth(0.4).strokeColor("#eef2f7").moveTo(M, doc.y).lineTo(M + W, doc.y).stroke();
      doc.moveDown(0.25);
    };

    drawSection("EU 1169/2011 Checks");
    for (const c of (report?.checks || [])) drawCheck(c);

    if (Array.isArray(halalChecks) && halalChecks.length) {
      doc.moveDown(0.6);
      drawSection("Halal Pre-Audit");
      for (const c of halalChecks) drawCheck(c);
    }

    doc.moveDown(0.6);
    doc.font("Helvetica").fontSize(8).fillColor("#7a7a7a")
      .text("Disclaimer: Preliminary preflight with citations. For legal compliance, consult qualified professionals.", M, doc.y, { width: W, align: "center" });

    doc.end();
  });
}

// ---------- API handler ----------
function sendJson(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST" });

    const body = await new Promise((resolve, reject) => {
      let data = "";
      req.on("data", c => (data += c));
      req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch (e) { reject(e); } });
      req.on("error", reject);
    });

    const {
      product_name, company_name, company_email, country_of_sale,
      languages_provided = [], shipping_scope = "local", product_category = "general",
      reference_docs_text = "",
      halal_audit = false,
      // label can be either image (data URL) OR a PDF file object:
      label_image_data_url,
      label_pdf_file, // { name, base64 }
      tds_file // { name, base64 }
    } = body || {};

    if (!company_email) return sendJson(res, 400, { error: "company_email is required" });
    if (!label_image_data_url && !label_pdf_file) return sendJson(res, 400, { error: "Provide a label image (jpg/png) or a label PDF." });

    const fields = {
      product_name, company_name, company_email, country_of_sale,
      languages_provided, shipping_scope, product_category, reference_docs_text
    };

    // KB + uploads → corpus
    const repoKB = await loadRepoKB();
    const tdsDoc = await extractTextFromUpload(tds_file);
    let labelPdfText = null, labelPdfName = null;
    if (label_pdf_file && /\.pdf$/i.test(label_pdf_file.name || "")) {
      const parsed = await extractTextFromUpload(label_pdf_file);
      if (parsed && parsed.text) { labelPdfText = parsed.text; labelPdfName = parsed.name; }
    }
    const corpus = buildCorpus({ repoKB, labelPdfText, labelPdfName, tdsDoc, extraText: reference_docs_text });

    // EU analysis
    const rawEU = await analyzeEU({ fields, corpus, label_image_data_url, label_pdf_text: labelPdfText, label_pdf_name: labelPdfName });
    let euReport = normalizeEuReport(rawEU, fields);

    // Recovery (image-only) to flip obvious items to OK
    if (label_image_data_url) {
      const rec = await recoverEssentialsFromImage(label_image_data_url);
      euReport = applyRecovered(euReport, rec, fields);
    }

    // Halal (optional)
    let halalChecks = [];
    if (halal_audit) {
      const halalRaw = await analyzeHalal({ fields, corpus, label_image_data_url, label_pdf_text: labelPdfText, label_pdf_name: labelPdfName });
      halalChecks = Array.isArray(halalRaw.checks) ? halalRaw.checks.map(c => ({
        id: c.id || "halal_item",
        title: c.title || "Halal check",
        status: (c.status || "missing").toLowerCase(),
        severity: (c.severity || (c.status === "missing" ? "high" : "medium")).toLowerCase(),
        detail: c.detail || "",
        fix: c.status === "ok" ? "" : (c.fix || "Provide compliant wording per cited rules."),
        sources: (Array.isArray(c.sources) ? [...new Set(c.sources.map(s => String(s).trim()).filter(Boolean))] : []).slice(0,3)
      })) : [];
    }

    // Score & artifacts
    const score = scoreFromChecks(euReport.checks, halalChecks);
    const fixpack_text = buildFixPack(euReport, halalChecks, { product_name, company_name });

    // Build PDF
    let pdf_base64 = null;
    try {
      const pdfBuffer = await buildPdf({
        report: euReport,
        halalChecks,
        score,
        meta: { company_name, product_name, halal_audit }
      });
      pdf_base64 = pdfBuffer.toString("base64");
    } catch (e) {
      console.error("PDF build failed:", e?.message || e);
    }

    // Email (optional)
    let email_status = "skipped";
    if (process.env.RESEND_API_KEY && pdf_base64) {
      try {
        await resend.emails.send({
          from: `${APP_NAME} Reports <onboarding@resend.dev>`,
          to: company_email,
          subject: `${APP_NAME} — Preflight Report — ${product_name || "Your Product"}`,
          html: `<p>Hello ${company_name || ""},</p>
                 <p>Attached is your preliminary preflight report for <strong>${product_name || "your product"}</strong>.</p>
                 <p>Best,<br/>${APP_NAME}</p>`,
          attachments: [{ filename: `${APP_NAME.replace(/\s+/g,"_")}_Report.pdf`, content: Buffer.from(pdf_base64, "base64"), contentType: "application/pdf" }]
        });
        email_status = "sent";
      } catch (e) {
        email_status = "failed: " + (e?.message || String(e));
      }
    }

    return sendJson(res, 200, {
      version: "1.0",
      layout: LAYOUT_VERSION,
      score,
      halal_audit,
      report: euReport,
      halal_checks: halalChecks,
      pdf_base64,
      fixpack_text,
      email_status
    });

  } catch (err) {
    return sendJson(res, 500, { error: err?.message || String(err) });
  }
}
