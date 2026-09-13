// GET /api/replay?mode=auto&id=<public id>  → a top-10 replay
import { MODES, ensureSchema, json, noDatabase } from '../../lib/leaderboard.js';

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return noDatabase();
  const params = new URL(request.url).searchParams;
  const mode = params.get('mode'), id = params.get('id') || '';
  if (!MODES.includes(mode) || !/^[a-f0-9]{16}$/.test(id)) return json({ error: 'bad mode or id' }, 400);
  await ensureSchema(db);

  const row = await db
    .prepare('SELECT name, time, replay FROM runs WHERE mode = ?1 AND substr(player_id, 1, 16) = ?2 AND replay IS NOT NULL')
    .bind(mode, id)
    .first();
  if (!row) return json({ error: 'no replay for that run (only the top 10 keep replays)' }, 404);

  // the stored replay is already JSON, so splice it in rather than parse + re-stringify ~100 KB
  return new Response(`{"name":${JSON.stringify(row.name)},"time":${row.time},"replay":${row.replay}}`, {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60' },
  });
}
