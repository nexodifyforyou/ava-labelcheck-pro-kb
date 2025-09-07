

import OpenAI from "openai";
import PDFDocument from "pdfkit";
import { Resend } from "resend";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);

const SYSTEM_PROMPT = `You are AVA LabelCheck, an EU food label compliance assistant focused on Regulation (EU) No 1169/2011 and related guidance. Read the label image OCR + user fields + house rules, then output STRICT JSON.

JSON schema keys: version, product, overall_status, summary, checks.
Each check: { id, title, status: ok|issue|missing, severity: low|medium|high, detail, fix }.

Rules: Be precise and practical. Do not invent facts—mark missing/unclear. Keep fixes actionable. Scope: packaged foods B2C in EU. Check core EU 1169/2011 items (name, ingredients, allergens/Annex II emphasis, QUID, net qty units, date marking “use by” vs “best before”, storage/use, business name+EU postal address, nutrition (per 100 g/ml), legibility (assume unknown if not given), language of sale country). If outside scope, say so in summary.`;

import fs from "fs";
import path from "path";
import url from "url";
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const kbPath = path.join(__dirname, "..", "kb", "house_rules.md");
let KB_TEXT = "";
try { KB_TEXT = fs.readFileSync(kbPath, "utf-8"); } catch { KB_TEXT = ""; }

async function analyzeLabel({ fields, label_image_data_url }) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: [
        { type: "text", text: "Use this House Rules text in addition to EU 1169/2011:" },
        { type: "text", text: KB_TEXT || "(none)" },
        { type: "text", text: "Provided fields (JSON): " + JSON.stringify(fields) },
        { type: "image_url", image_url: { url: label_image_data_url } },
        { type: "text", text: "Return ONLY valid JSON with keys: version, product, overall_status, summary, checks." }
    ]}
  ];

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    temperature: 0
  });

  let text = resp.choices?.[0]?.message?.content || "{}";
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end >= 0) text = text.slice(start, end + 1);
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { parsed = { version: "1.0", product: {}, overall_status: "caution", summary: "Parsing error; partial output.", checks: [] }; }
  return parsed;
}

function buildPdf({ report, company_name, product_name, shipping_scope }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on("data", c => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const now = new Date().toISOString().split("T")[0];

    doc.fillColor("#0b1020").fontSize(22).text("AVA LabelCheck — Compliance Assessment", { align: "left" });
    doc.moveDown(0.2);
    doc.fillColor("#444").fontSize(10).text("Preliminary analysis based on EU 1169/2011 + AVA House Rules.", { align: "left" });
    doc.moveDown(0.6);

    doc.save();
    doc.rect(400, 40, 160, 60).strokeColor("#4f7dff").lineWidth(2).stroke();
    doc.fillColor("#4f7dff").fontSize(12).text("AVA VERIFIED", 410, 55);
    doc.fillColor("#888").fontSize(9).text(now, 410, 72);
    doc.restore();

    doc.moveDown(0.5);
    doc.fillColor("#000").fontSize(12);
    doc.text(`Company: ${company_name}`);
    doc.text(`Product: ${product_name}`);
    doc.text(`Shipping scope: ${shipping_scope}`);
    doc.text(`Country of sale: ${report?.product?.country_of_sale || "-"}`);
    doc.text(`Languages: ${(report?.product?.languages_provided || []).join(", ") || "-"}`);

    doc.moveDown(0.6);
    const status = (report?.overall_status || "caution").toUpperCase();
    doc.fillColor("#000").fontSize(14).text(`Overall: ${status}`);
    doc.moveDown(0.2);
    doc.fillColor("#333").fontSize(11).text(report?.summary || "-", { align: "left" });

    doc.moveDown(0.6);
    doc.fillColor("#000").fontSize(13).text("Checks", { underline: true });
    doc.moveDown(0.3);
    for (const c of (report?.checks || [])) {
      doc.fillColor("#111").fontSize(12).text(`• ${c.title} [${(c.status||"").toUpperCase()} | ${c.severity}]`);
      doc.fillColor("#444").fontSize(10).text(`Detail: ${c.detail || "-"}`);
      doc.fillColor("#0b3d02").fontSize(10).text(`Fix: ${c.fix || "-"}`);
      doc.moveDown(0.3);
    }

    doc.moveDown(0.5);
    doc.fillColor("#777").fontSize(8).text("Disclaimer: Automated triage. For legal compliance, consult qualified professionals. © AVA LabelCheck", { align: "center" });

    doc.end();
  });
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

    const body = await new Promise((resolve) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => resolve(JSON.parse(data || "{}")));
    });

    const {
      product_name,
      company_name,
      company_email,
      country_of_sale,
      languages_provided = [],
      shipping_scope = "local",
      product_category = "general",
      reference_docs_text = "",
      label_image_data_url
    } = body || {};

    if (!label_image_data_url) return res.status(400).json({ error: "label_image_data_url is required" });
    if (!company_email) return res.status(400).json({ error: "company_email is required" });

    const fields = {
      product_name, company_name, company_email, country_of_sale,
      languages_provided, shipping_scope, product_category,
      reference_docs_text
    };

    const report = await analyzeLabel({ fields, label_image_data_url });

    const pdfBuffer = await buildPdf({ report, company_name, product_name, shipping_scope });
    const pdf_base64 = pdfBuffer.toString("base64");

    let email_status = "skipped";
    if (process.env.RESEND_API_KEY) {
      try {
        await resend.emails.send({
          from: "AVA LabelCheck <onboarding@resend.dev>",
          to: company_email,
          subject: `AVA LabelCheck Report — ${product_name || "Your Product"}`,
          html: `<p>Hello ${company_name || ""},</p><p>Attached is your preliminary compliance report for <strong>${product_name || "your product"}</strong>.</p><p>Best,<br/>AVA LabelCheck</p>`,
          attachments: [{ filename: "AVA_LabelCheck_Report.pdf", content: pdf_base64, contentType: "application/pdf" }]
        });
        email_status = "sent";
      } catch (e) {
        email_status = "failed: " + (e?.message || e);
      }
    }

    return res.status(200).json({ report, pdf_base64, email_status });
  } catch (err) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
}
