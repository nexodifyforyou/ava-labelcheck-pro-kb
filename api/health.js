export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true, ts: new Date().toISOString() }));
}
