// api/health.js
export const config = { runtime: "nodejs" };

export default function handler(req, res) {
  res.status(200).json({
    ok: true,
    ts: new Date().toISOString(),
    // Bump this when you ship changes you want to verify in the browser:
    version: "v3-score-recompute-pdf-email"
  });
}

