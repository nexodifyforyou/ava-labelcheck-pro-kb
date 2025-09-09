// ========= BRAND / NAME =========
// ***** CHANGE HERE: your public app name used in PDF & emails *****
const APP_NAME = "LabelCheck"; // e.g., "LabelGuard", "Regulaid"
// =================================

export const config = { runtime: "nodejs" };

import OpenAI from "openai";
import PDFDocument from "pdfkit";
import { Resend } from "resend";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const LAYOUT_VERSION = "v3";

// --- Lazy OpenAI client (clean error if key missing) ---
let _openai = null;
function getOpenAI() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Missing OPENAI_API_KEY");
  if (!_openai) _openai = new OpenAI({ apiKey: key });
  return _openai;
}

const resend = new Resend(process.env.RESEND_API_KEY);

// ---- Load House Rules (persistent KB) ----
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const kbPath = path.join(__dirname, "..", "kb", "house_rules.md");
let KB_TEXT = "";
try { KB_TEXT = fs.readFileSync(kbPath, "utf-8"); } catch { KB_TEXT = ""; }

// ---- Required checks & system prompt ----
const REQUIRED_IDS = [
  "name_of_food","ingredients","allergens","quid","net_qty",
  "date_marking","storage_use","business_address","nutrition","language","claims"
];

const SYSTEM_PROMPT =
  "You are a food label compliance assistant for the EU (Regulation (EU) No 1169/2011). " +
  "Use OCR on the provided label image and base every decision on actual text you can see. " +
  "Return ONLY valid JSON with keys: version, product, overall_status, summary, checks. " +
  "product MUST include: name (headline on front or sales name, title-case it), country_of_sale, languages_provided. " +
  "checks MUST contain exactly these ids: " + REQUIRED_IDS.join(", ") + ". " +
  "For each check, set status: ok (present & compliant), issue (present but non-compliant/ambiguous), missing (not present). " +
  "Include a short 'detail' that quotes/mentions the snippet you saw (e.g., \"Ingredienti: …\"). Provide a practical 'fix'. " +
  "Scope: packaged foods B2C in EU. Check: name of food; ingredients list; allergens emphasis (Annex II) within list; QUID when an ingredient is highlighted; " +
  "net quantity with legal units; date marking ('use by' vs 'best before'); storage/conditions of use; FBO name + EU postal address (or EU importer); " +
  "nutrition declaration per 100 g/ml; language(s) appropriate to country_of_sale. If outside scope, say so in summary.";

// ---- Default fix text for each check (used when model omits "fix") ----
const DEFAULT_FIX = {
  name_of_food: "Include the legal/sales name on the front in a prominent position.",
  ingredients: "Provide a full ingredient list in descending order by weight.",
  allergens: "Emphasize Annex II allergens within the ingredient list using bold (not ALL CAPS).",
  quid: "Declare QUID (%) next to the highlighted ingredient in the name/presentation.",
  net_qty: "Show net quantity with legal units (g/kg or ml/l).",
  date_marking: "Use 'best before' (min. durability) or 'use by' (safety) with a clear date format.",
  storage_use: "Add storage conditions and any specific conditions of use.",
  business_address: "Provide the FBO name and an EU postal address (or EU importer if needed).",
  nutrition: "Provide nutrition declaration per 100 g/ml (table or linear format).",
  language: "Ensure mandatory particulars are in the language(s) of the country of sale.",
  claims: "Substantiate claims and ensure any nutrition/health claims meet EU rules."
};
function ensureFix(id, status, fix) {
  if (fix && String(fix).trim()) return fix;
  return status === "ok" ? "No action needed." : (DEFAULT_FIX[id] || "Provide compliant text per EU 1169/2011.");
}

// ---- helpers ----
function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}

// ---------- normalizeReport (bullet-proof + default fixes) ----------
function normalizeReport(raw, fields) {
  const r = raw && typeof raw === "object" ? raw : {};
  const product = r.product || {};

  // Make sure checks is ALWAYS an array
  let rawChecks = [];
  if (Array.isArray(r.checks)) rawChecks = r.checks;
  else if (r.checks && typeof r.checks === "object") rawChecks = Object.values(r.checks);

  const REQUIRED_CHECKS = [
    ["name_of_food","Name of food"],
    ["ingredients","Ingredient list"],
    ["allergens","Allergen declaration"],
    ["quid","QUID"],
    ["net_qty","Net quantity"],
    ["date_marking","Date marking"],
    ["storage_use","Storage/conditions of use"],
    ["business_address","Business name & EU address"],
    ["nutrition","Nutrition declaration"],
    ["language","Language compliance"],
    ["claims","Claims (if any)"]
  ];

  const checksById = new Map(rawChecks.map(c => [c.id, c]));
  const checks = REQUIRED_CHECKS.map(([id, title]) => {
    const c = checksById.get(id) || {};
    const status = (c.status || "missing").toLowerCase();
    const sev =
      c.severity ? String(c.severity).toLowerCase() :
      status === "missing" ? "high" :
      status === "issue" ? "medium" : "low";
    return {
      id,
      title,
      status: ["ok","issue","missing"].includes(status) ? status : "missing",
      severity: ["low","medium","high"].includes(sev) ? sev : "medium",
      detail: c.detail || "",
      fix: ensureFix(id, status, c.fix || "")
    };
  });

  // deterministic overall
  const hasHigh = checks.some(c => c.status !== "ok" && c.severity === "high");
  const hasMedium = checks.some(c => c.status !== "ok" && c.severity === "medium");
  const overall_status = hasHigh ? "fail" : hasMedium ? "caution" : "pass";

  const finalProduct = {
    name: product.name || (fields.product_name ? String(fields.product_name) : ""),
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

// ---------- Model call (with fallback) ----------
async function analyzeLabel({ fields, label_image_data_url }) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        { type: "text", text: "House Rules (apply in addition to EU 1169/2011):" },
        { type: "text", text: KB_TEXT || "(none)" },
        { type: "text", text: "Provided fields (JSON): " + JSON.stringify(fields) },
        { type: "text", text:
          "Explicitly extract: product.name (headline/sales name), ingredients list text (if present), date marking, net quantity, nutrition snippet, " +
          "business operator block. If 'Ingredienti' or equivalent is visible, do NOT mark 'ingredients' as missing." },
        { type: "image_url", image_url: { url: label_image_data_url } },
        { type: "text", text:
          "Return ONLY JSON with keys: version, product, overall_status, summary, checks. " +
          "checks must include exactly these ids: " + REQUIRED_IDS.join(", ") + "." }
      ]
    }
  ];

  const models = ["gpt-4o", "gpt-4o-mini"];
  for (const model of models) {
    try {
      const resp = await getOpenAI().chat.completions.create({ model, messages, temperature: 0 });
      let text = resp.choices?.[0]?.message?.content || "{}";
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start >= 0 && end >= 0) text = text.slice(start, end + 1);
      return JSON.parse(text);
    } catch (e) {
      console.error("analyzeLabel error on", model, e?.message || e);
    }
  }

  // last resort shell
  return {
    version: "1.0",
    product: { name: fields.product_name || "", country_of_sale: fields.country_of_sale || "", languages_provided: fields.languages_provided || [] },
    overall_status: "caution",
    summary: "Model call failed; returning minimal shell.",
    checks: REQUIRED_IDS.map(id => ({ id, title: id, status: "missing", severity: "medium", detail: "", fix: ensureFix(id, "missing", "") }))
  };
}

// ---------- Recovery: focused extraction for all core snippets ----------
async function recoverEssentials(label_image_data_url, fields) {
  const messages = [
    { role: "system", content:
      "You extract ONLY what is visible on the label image. Return JSON with exact keys: " +
      "{ name, ingredients_text, net_qty_text, date_marking_text, nutrition_text, business_text, languages_detected }." },
    { role: "user", content: [
      { type: "text", text:
        "1) Find the sales name/headline (front) or 'name of food'. Title-case it for 'name'.\n" +
        "2) Find the ingredients list block. Look for words like: 'Ingredienti', 'Ingredients', 'Ingredientes', 'Ingrédients'. Put that paragraph into 'ingredients_text'.\n" +
        "3) Find net quantity (e.g., '5 kg', '500 g', '750 ml'). Put exact text into 'net_qty_text'.\n" +
        "4) Find date marking (e.g., 'Da consumarsi preferibilmente entro il: 25/10/2024' or 'Best before ...'). Put into 'date_marking_text'.\n" +
        "5) Detect nutrition table/line (e.g., 'Valori nutrizionali / 100g', 'Energy 1254 kJ ...'). Put a short snippet into 'nutrition_text'.\n" +
        "6) Find Business Operator / address block (company name + address). Put into 'business_text'.\n" +
        "7) Guess languages on the label as ISO codes (e.g., ['it','de','en']) and put into 'languages_detected'." },
      { type: "image_url", image_url: { url: label_image_data_url } },
      { type: "text", text: "Return ONLY JSON with keys: { name, ingredients_text, net_qty_text, date_marking_text, nutrition_text, business_text, languages_detected }." }
    ]}
  ];
  try {
    const resp = await getOpenAI().chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0
    });
    let txt = resp.choices?.[0]?.message?.content || "{}";
    const s = txt.indexOf("{"), e = txt.lastIndexOf("}");
    if (s >= 0 && e >= 0) txt = txt.slice(s, e + 1);
    const parsed = JSON.parse(txt);
    if (!Array.isArray(parsed.languages_detected)) parsed.languages_detected = [];
    return parsed;
  } catch (e) {
    console.error("recoverEssentials:", e?.message || e);
    return { languages_detected: [] };
  }
}

function applyRecovered(report, recovered, fields) {
  const out = JSON.parse(JSON.stringify(report));
  // Fill product name if missing
  if (recovered.name && (!out.product.name || !out.product.name.trim())) {
    out.product.name = recovered.name;
  }

  // Helper to set a check OK with snippet
  const okWith = (id, snippet) => {
    const c = out.checks.find(ch => ch.id === id);
    if (!c) return;
    c.status = "ok";
    c.severity = "low";
    if (snippet && !c.detail) c.detail = (id === "ingredients" ? "Detected list: " : "") + snippet.trim();
    c.fix = ensureFix(id, c.status, c.fix);
  };

  if (recovered.ingredients_text) okWith("ingredients", recovered.ingredients_text.slice(0, 400) + (recovered.ingredients_text?.length > 400 ? "…" : ""));
  if (recovered.net_qty_text)    okWith("net_qty", recovered.net_qty_text);
  if (recovered.date_marking_text) okWith("date_marking", recovered.date_marking_text);
  if (recovered.nutrition_text)  okWith("nutrition", recovered.nutrition_text);
  if (recovered.business_text)   okWith("business_address", recovered.business_text);

  // Language compliance heuristic
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
      } else {
        langCheck.status = "issue";
        langCheck.severity = "medium";
        langCheck.detail = `Detected languages: ${detected.join(", ") || "-"}. Required: ${required.join(", ") || "-"}.`;
      }
      langCheck.fix = ensureFix("language", langCheck.status, langCheck.fix);
    }
  }

  // Ensure each check has a fix
  out.checks = out.checks.map(c => ({ ...c, fix: ensureFix(c.id, c.status, c.fix) }));

  // recompute overall
  const hasHigh = out.checks.some(c => c.status !== "ok" && c.severity === "high");
  const hasMedium = out.checks.some(c => c.status !== "ok" && c.severity === "medium");
  out.overall_status = hasHigh ? "fail" : hasMedium ? "caution" : "pass";
  return out;
}

// ---------- PDF (layout v3: tidy, non-overlapping, readable) ----------
function buildPdf({ report, company_name, product_name, shipping_scope }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 56 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageW = doc.page.width;
    const M = doc.page.margins.left;
    const W = pageW - M * 2;

    const today = new Date().toISOString().split("T")[0];
    const reportId = "AVA-" + today.replace(/-/g,"") + "-" + Math.floor(Math.random()*1e6).toString().padStart(6,"0");

    // Header (title left, stamp right)
    doc.font("Helvetica-Bold").fontSize(22).fillColor("#0b1020")
       .text(`${APP_NAME} — Compliance Assessment ( ${LAYOUT_VERSION} )`, M, M, { width: W - 180 });
    doc.moveDown(0.25);
    doc.font("Helvetica").fontSize(10).fillColor("#666")
       .text("Preliminary analysis based on EU 1169/2011 + House Rules.", { width: W - 180 });

    // Stamp
    const stamp = { x: M + W - 160, y: M - 8, w: 160, h: 64 };
    doc.save();
    doc.lineWidth(1.5).strokeColor("#4f7dff").roundedRect(stamp.x, stamp.y, stamp.w, stamp.h, 8).stroke();
    doc.fillColor("#4f7dff").font("Helvetica-Bold").fontSize(12).text("VERIFIED", stamp.x + 12, stamp.y + 12);
    doc.fillColor("#888").font("Helvetica").fontSize(9).text(today, stamp.x + 12, stamp.y + 32);
    doc.restore();

    // Ensure we start below stamp
    const belowStampY = stamp.y + stamp.h + 12;
    if (doc.y < belowStampY) doc.y = belowStampY;

    // Meta block
    const kv = (k, v) => {
      doc.font("Helvetica-Bold").fillColor("#111").text(k + ": ", { continued: true });
      doc.font("Helvetica").fillColor("#222").text(v || "-");
    };
    doc.fillColor("#111").font("Helvetica-Bold").fontSize(12).text("Report Details");
    kv("Report ID", reportId);
    kv("Company", company_name || "-");
    kv("Product", product_name || "-");
    kv("Shipping scope", shipping_scope || "-");
    kv("Country of sale", report?.product?.country_of_sale || "-");
    kv("Languages", (report?.product?.languages_provided || []).join(", ") || "-");

    // Overall status badge + summary
    doc.moveDown(0.6);
    const overall = (report?.overall_status || "caution").toLowerCase();
    const badgeText = overall.toUpperCase();
    const badgeColor = overall === "pass" ? "#10b981" : overall === "fail" ? "#ef4444" : "#f59e0b";
    const badgeW = doc.widthOfString(badgeText) + 16;
    const badgeH = 18;
    const xBadge = M;
    const yBadge = doc.y;

    doc.save();
    doc.fillColor(badgeColor).roundedRect(xBadge, yBadge, badgeW, badgeH, 6).fill();
    doc.fillColor("#fff").font("Helvetica-Bold").fontSize(10).text(badgeText, xBadge + 8, yBadge + 4);
    doc.restore();

    doc.moveDown(1.1);
    doc.font("Helvetica").fontSize(11).fillColor("#333")
       .text(report?.summary || "-", M, doc.y, { width: W });

    // Divider
    doc.moveDown(0.6);
    doc.lineWidth(0.6).strokeColor("#e5e7eb").moveTo(M, doc.y).lineTo(M + W, doc.y).stroke();
    doc.moveDown(0.4);

    // Checks
    doc.font("Helvetica-Bold").fontSize(13).fillColor("#0b1020").text("Checks");
    doc.moveDown(0.2);

    const drawCheck = (c) => {
      const title = c.title || "Untitled check";
      const statusText = (c.status || "").toUpperCase();
      const sev = (c.severity || "").toLowerCase();
      const tagColor = c.status === "ok" ? "#10b981" : c.status === "missing" ? "#ef4444" : "#f59e0b";

      // Title
      const yStart = doc.y;
      doc.fillColor("#111").font("Helvetica-Bold").fontSize(12).text("• " + title, M, yStart);

      // Status tag (right)
      const tag = `[${statusText} | ${sev}]`;
      doc.save();
      doc.fillColor(tagColor).font("Helvetica-Bold").fontSize(9)
         .text(tag, M, yStart, { width: W, align: "right" });
      doc.restore();

      // Detail & Fix
      if (c.detail) {
        doc.moveDown(0.15);
        doc.font("Helvetica").fontSize(10).fillColor("#444")
           .text("Detail: " + c.detail, M + 14, doc.y, { width: W - 14 });
      }
      if (c.fix) {
        doc.moveDown(0.1);
        doc.font("Helvetica").fontSize(10).fillColor("#0b3d02")
           .text("Fix: " + c.fix, M + 14, doc.y, { width: W - 14 });
      }

      // Divider
      doc.moveDown(0.35);
      doc.lineWidth(0.4).strokeColor("#eef2f7").moveTo(M, doc.y).lineTo(M + W, doc.y).stroke();
      doc.moveDown(0.25);
    };

    for (const c of (report?.checks || [])) drawCheck(c);

    // Footer
    doc.moveDown(0.6);
    doc.font("Helvetica").fontSize(8).fillColor("#7a7a7a")
       .text("Disclaimer: Automated triage. For legal compliance, consult qualified professionals.", M, doc.y, { width: W, align: "center" });

    doc.end();
  });
}

// ---- API handler ----
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
      reference_docs_text = "", label_image_data_url
    } = body || {};

    if (!label_image_data_url) return sendJson(res, 400, { error: "label_image_data_url is required" });
    if (!company_email) return sendJson(res, 400, { error: "company_email is required" });

    const fields = {
      product_name, company_name, company_email, country_of_sale,
      languages_provided, shipping_scope, product_category, reference_docs_text
    };

    // First pass → normalize
    let rawReport;
    try {
      rawReport = await analyzeLabel({ fields, label_image_data_url });
    } catch (e) {
      return sendJson(res, 500, { error: "OpenAI setup error: " + (e?.message || String(e)) });
    }

    // Normalize with a safety net
    let report;
    try {
      report = normalizeReport(rawReport, fields);
    } catch (e) {
      console.error("normalizeReport failed:", e?.message || e, rawReport);
      report = {
        version: "1.0",
        product: {
          name: fields.product_name || "",
          country_of_sale: fields.country_of_sale || "",
          languages_provided: fields.languages_provided || [],
        },
        overall_status: "caution",
        summary: "Normalization error; using fallback.",
        checks: []
      };
    }

    // Second-pass recovery (fills name, ingredients, net qty, date, nutrition, business, languages)
    const rec = await recoverEssentials(label_image_data_url, fields);
    report = applyRecovered(report, rec, fields);

    // PDF
    let pdf_base64 = null;
    let email_status = "skipped";
    const debug = [];

    try {
      const pdfBuffer = await buildPdf({ report, company_name, product_name, shipping_scope });
      pdf_base64 = pdfBuffer.toString("base64");
    } catch (e) {
      console.error("PDF build failed:", e?.message || e);
      debug.push("pdf_error:" + (e?.message || String(e)));
    }

    // Email (optional)
    if (process.env.RESEND_API_KEY && pdf_base64) {
      try {
        const pdfBufferForEmail = Buffer.from(pdf_base64, "base64");
        await resend.emails.send({
          // ***** CHANGE HERE if you verify your own domain in Resend *****
          from: `${APP_NAME} Reports <onboarding@resend.dev>`,
          to: company_email,
          subject: `${APP_NAME} — Compliance Report — ${product_name || "Your Product"}`,
          html: `<p>Hello ${company_name || ""},</p>
                 <p>Attached is your preliminary compliance report for <strong>${product_name || "your product"}</strong>.</p>
                 <p>Best,<br/>${APP_NAME}</p>`,
          attachments: [{ filename: `${APP_NAME.replace(/\s+/g,"_")}_Report.pdf`, content: pdfBufferForEmail, contentType: "application/pdf" }]
        });
        email_status = "sent";
      } catch (e) {
        email_status = "failed: " + (e?.message || String(e));
        debug.push("email_error:" + (e?.message || String(e)));
      }
    }

    return sendJson(res, 200, { report, pdf_base64, email_status, layout: LAYOUT_VERSION, debug });
  } catch (err) {
    return sendJson(res, 500, { error: err?.message || String(err) });
  }
}
