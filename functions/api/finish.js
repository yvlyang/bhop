import { boardKey, ensureSchema, json, noDatabase, playerIdFromToken } from '../../lib/leaderboard.js';

export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return noDatabase();
  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid JSON' }, 400); }
  const playerId = await playerIdFromToken(body.token);
  if (!playerId) return json({ error: 'missing player token' }, 400);
  const mode = boardKey(body.map, body.mode);
  if (!mode) return json({ error: 'unknown map or mode' }, 400);
  if (!Number.isFinite(body.time) || body.time < 3 || body.time > 3600) return json({ error: 'time out of range' }, 400);

  await ensureSchema(db);
  const now = Date.now();
  const row = await db.prepare('SELECT runs, updated_at FROM run_counts WHERE player_id = ?1 AND mode = ?2').bind(playerId, mode).first();
  if (row && now - row.updated_at < 2500) return json({ ok: true, runs: row.runs });
  await db
    .prepare(`INSERT INTO run_counts (player_id, mode, runs, updated_at) VALUES (?1, ?2, 1, ?3)
              ON CONFLICT (player_id, mode) DO UPDATE SET runs = runs + 1, updated_at = excluded.updated_at`)
    .bind(playerId, mode, now)
    .run();
  return json({ ok: true, runs: (row?.runs ?? 0) + 1 });
}
