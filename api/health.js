export const config = { runtime: 'edge' };

export default async function handler(req) {
  return new Response(
    JSON.stringify({ ok: true, ts: new Date().toISOString() }),
    { headers: { 'content-type': 'application/json' } }
  );
}
