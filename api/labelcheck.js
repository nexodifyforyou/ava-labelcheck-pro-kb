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
// Your optional knowledge base files (put them in /kb)
const KB_HOUSE = readIfExists("kb/house_rules.md");
const KB_REFS = readIfExists("kb/refs.md");
const KB_BUYER = readIfExists("kb/buyer/generic.md");
const KB_HALAL = readIfExists("kb/halal/basics.md");

/* -------------------- prompt system messages ---------------------- */
const SYSTEM_PROMPT = `
You are an expert EU food label compliance assistant for Regulation (EU) No 1169/2011.
Return a JSON object with:
- version: "1.0"
- product: { name, country_of_sale, languages_provided: string[] }
- summary: a 1-2 sentence overview
- checks: array of items { title, status: "ok"|"issue"|"missing", severity: "low"|"medium"|"high", detail, fix, sources[] }

Rules:
- Be precise. If unsure, mark as "missing" with a short detail.
- Only include Fix and Sources for non-OK items.
- Cite concise sources using tags (e.g., "EU1169:Art 22; Annex VIII") and/or KB filenames when relevant.
- Do NOT invent facts. If an item is present on the label/TDS, mark it OK.
- Important topics: sales name, ingredient list (descending order), allergen emphasis (Annex II), QUID (Art 22), net quantity, date marking, storage/conditions of use, FBO name/EU address, nutrition table order per 100g/100ml, language compliance for the country of sale, and claims.
`;

const HALAL_SYSTEM_PROMPT = `
You are performing a Halal pre-audit screening on a product label and specs.
Return JSON array of checks: each { title, status: "ok"|"issue"|"missing", severity: "low"|"medium"|"high", detail, fix, sources[] }.
Consider forbidden ingredients (porcine products, alcohol, non-halal gelatin), solvents/carriers (ethanol), processing aids, logo/issuer authenticity, segregation/contamination risk.
- If nothing problematic is detected, return [].
- Cite concise sources (e.g., "Halal-KB:basics.md") only for non-OK.
`;

/* ----------------------- model call helpers ----------------------- */
async function analyzeEU({ fields, imageDataUrl, pdfText, tdsText, extraRules }) {
  const userParts = [];

  const kbText = [
    KB_HOUSE && `House Rules:\n${KB_HOUSE}`,
    KB_REFS && `EU References:\n${KB_REFS}`,
    KB_BUYER && `Buyer Generic Rules:\n${KB_BUYER}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  userParts.push({
    type: "text",
    text:
      `Use the following guidance and references if relevant:\n` +
      clampText(kbText, 9000),
  });

  userParts.push({
    type: "text",
    text:
      `Product fields:\n` + clampText(JSON.stringify(fields, null, 2), 3000),
  });

  if (extraRules) {
    userParts.push({
      type: "text",
      text: `Client Extra Rules (use if relevant):\n${clampText(extraRules, 3000)}`,
    });
  }
  if (tdsText) {
    userParts.push({
      type: "text",
      text: `Extracted TDS text:\n${clampText(tdsText, 6000)}`,
    });
  }
  if (pdfText) {
    userParts.push({
      type: "text",
      text: `Extracted Label PDF text:\n${clampText(pdfText, 6000)}`,
    });
  }
  if (imageDataUrl) {
    userParts.push({
      type: "image_url",
      image_url: { url: imageDataUrl },
    });
  }

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userParts },
      {
        role: "user",
        content:
          "Return ONLY JSON. Keys: version, product{name,country_of_sale,languages_provided}, summary, checks[].",
      },
    ],
  });

  const txt = resp.choices?.[0]?.message?.content?.trim() || "{}";
  try {
    return JSON.parse(txt);
  } catch {
    // Fallback minimal shape
    return { version: "1.0", product: {}, summary: txt.slice(0, 500), checks: [] };
  }
}

async function analyzeHalal({ fields, imageDataUrl, pdfText, tdsText, extraRules }) {
  const parts = [];
  const kb = (KB_HALAL ? `Halal KB:\n${KB_HALAL}\n\n` : "") +
             (KB_BUYER ? `Buyer/Halal rules:\n${KB_BUYER}` : "");
  if (kb) parts.push({ type: "text", text: clampText(kb, 8000) });
  parts.push({ type: "text", text: `Fields:\n${clampText(JSON.stringify(fields, null, 2), 3000)}` });
  if (extraRules) parts.push({ type: "text", text: `Client Extras:\n${clampText(extraRules, 3000)}` });
  if (tdsText) parts.push({ type: "text", text: `TDS excerpt:\n${clampText(tdsText, 6000)}` });
  if (pdfText) parts.push({ type: "text", text: `Label PDF excerpt:\n${clampText(pdfText, 6000)}` });
  if (imageDataUrl) parts.push({ type: "image_url", image_url: { url: imageDataUrl } });

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      { role: "system", content: HALAL_SYSTEM_PROMPT },
      { role: "user", content: parts },
      { role: "user", content: "Return ONLY a JSON array of checks." },
    ],
  });

  const txt = resp.choices?.[0]?.message?.content?.trim() || "[]";
  try { return JSON.parse(txt); } catch { return []; }
}

/* ------------------------ post-processors ------------------------- */
function normalizeReport(r, fields) {
  const report = {
    version: "1.0",
    product: {
      name: r?.product?.name || fields?.product_name || "",
      country_of_sale: r?.product?.country_of_sale || fields?.country_of_sale || "",
      languages_provided: Array.isArray(r?.product?.languages_provided)
        ? r.product.languages_provided
        : (fields?.languages_provided || []),
    },
    summary: r?.summary || "",
    checks: Array.isArray(r?.checks) ? r.checks : [],
  };

  // force shape for checks
  report.checks = report.checks.map(c => ({
    title: c?.title || "Unlabeled check",
    status: (c?.status === "ok" ? "ok" : (c?.status === "missing" ? "missing" : "issue")),
    severity: ["low", "medium", "high"].includes(c?.severity) ? c.severity : "medium",
    detail: c?.detail || "",
    fix: (c?.status === "ok") ? "" : (c?.fix || ""),
    sources: (c?.status === "ok") ? [] : (Array.isArray(c?.sources) ? c.sources : []),
  }));

  // scoring + overall
  let score = 100;
  let hasHigh = false, hasMedium = false;
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

function buildFixPack(report, halalChecks) {
  const lines = [];
  lines.push(`${APP_NAME} — Fix Pack`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Product: ${report.product?.name || "-"}`);
  lines.push("");
  const add = (c, prefix = "") => {
    if (c.status === "ok") return;
    lines.push(`${prefix}${c.title} [${c.severity.toUpperCase()}]`);
    if (c.detail) lines.push(`- ${c.detail}`);
    if (c.fix) lines.push(`→ Fix: ${c.fix}`);
    if (Array.isArray(c.sources) && c.sources.length) lines.push(`Sources: ${c.sources.join("; ")}`);
    lines.push("");
  };
  for (const c of report.checks) add(c);
  if (Array.isArray(halalChecks)) for (const c of halalChecks) add(c, "Halal: ");
  return lines.join("\n");
}

function makePdf({ report, halalChecks, fields }) {
  const doc = new PDFDocument({ size: "A4", margin: 36 });
  const bufs = [];
  doc.on("data", d => bufs.push(d));
  doc.on("error", e => console.error("PDF error:", e));

  doc.fontSize(18).text(`${APP_NAME} — Compliance Assessment`, { align: "left" });
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor("#555").text(`Preliminary analysis based on EU 1169/2011 + KB references. Generated: ${new Date().toISOString()}`);
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

  doc.end();
  const pdfBuffer = Buffer.concat(bufs);
  return pdfBuffer.toString("base64");
}

/* ============================== handler ============================== */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "Use POST" });
  }

  try {
    const body = await req.json();
    const {
      product_name,
      company_name,
      company_email,
      country_of_sale,
      languages_provided = [],
      shipping_scope,
      product_category,
      label_image_data_url,
      label_pdf_file, // { name, base64: dataurl }
      tds_file,        // { name, base64: dataurl }
      reference_docs_text,
      halal_audit
    } = body || {};

    const fields = {
      product_name,
      company_name,
      company_email,
      country_of_sale,
      languages_provided,
      shipping_scope,
      product_category
    };

    /* ---------- extract optional TDS text ---------- */
    let tdsText = "";
    if (tds_file?.base64) {
      // we do not parse docx; we just send raw text (for .txt/.md)
      // for pdf TDS, we can reuse pdf-parse lazily
      if ((tds_file.name || "").toLowerCase().endsWith(".pdf")) {
        const pdfParse = (await import("pdf-parse")).default; // lazy
        const tbuf = safeB64ToBuffer(tds_file.base64);
        const parsed = await pdfParse(tbuf);
        tdsText = parsed.text || "";
      } else {
        // base64 decode to string best-effort; if it fails, skip
        try { tdsText = safeB64ToBuffer(tds_file.base64).toString("utf8"); } catch {}
      }
    }

    /* ---------- extract label PDF text if provided ---------- */
    let labelPdfText = "";
    if (label_pdf_file?.base64) {
      const pdfParse = (await import("pdf-parse")).default; // <--- LAZY IMPORT
      const buf = safeB64ToBuffer(label_pdf_file.base64);
      const parsed = await pdfParse(buf);
      labelPdfText = parsed.text || "";
    }

    /* ---------- primary EU analysis ---------- */
    const rawReport = await analyzeEU({
      fields,
      imageDataUrl: label_image_data_url || null,
      pdfText: labelPdfText || null,
      tdsText: tdsText || null,
      extraRules: reference_docs_text || ""
    });

    let report = normalizeReport(rawReport, fields);

    /* ---------- optional Halal analysis ---------- */
    let halalChecks = [];
    if (halal_audit) {
      halalChecks = await analyzeHalal({
        fields,
        imageDataUrl: label_image_data_url || null,
        pdfText: labelPdfText || null,
        tdsText: tdsText || null,
        extraRules: reference_docs_text || ""
      });
      // normalize halal checks shape
      halalChecks = (Array.isArray(halalChecks) ? halalChecks : []).map(c => ({
        title: c?.title || "Halal check",
        status: (c?.status === "ok" ? "ok" : (c?.status === "missing" ? "missing" : "issue")),
        severity: ["low","medium","high"].includes(c?.severity) ? c.severity : "medium",
        detail: c?.detail || "",
        fix: (c?.status === "ok") ? "" : (c?.fix || ""),
        sources: (c?.status === "ok") ? [] : (Array.isArray(c?.sources) ? c.sources : []),
      }));
    }

    /* ---------- fix pack + PDF ---------- */
    const fixpack_text = buildFixPack(report, halalChecks);
    const pdf_base64 = makePdf({ report, halalChecks, fields });

    /* ---------- email (optional) ---------- */
    let email_status = "skipped";
    if (process.env.RESEND_API_KEY && company_email) {
      try {
        await resend.emails.send({
          from: `${APP_NAME} <onboarding@resend.dev>`,
          to: company_email,
          subject: `${APP_NAME} — ${fields.product_name || "Your Product"}`,
          html: `<p>Hello ${fields.company_name || ""},</p>
                 <p>Attached is your preliminary compliance report for <strong>${fields.product_name || "your product"}</strong>.</p>
                 <p>Best,<br/>${APP_NAME}</p>`,
          attachments: [
            { filename: "Preflight_Report.pdf", content: pdf_base64, contentType: "application/pdf" },
            { filename: "Fix_Pack.txt", content: Buffer.from(fixpack_text).toString("base64"), contentType: "text/plain" }
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
      fixpack_text,
      email_status
    });
  } catch (err) {
    console.error("API error:", err);
    return sendJson(res, 500, { error: err?.message || String(err) });
  }
}
