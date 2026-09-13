import { claimName, cleanName, ensureSchema, json, noDatabase, playerIdFromToken } from '../../lib/leaderboard.js';

export async function onRequestPost({ request, env }) {
  const db = env.DB;
  if (!db) return noDatabase();
  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid JSON' }, 400); }
  const playerId = await playerIdFromToken(body.token);
  if (!playerId) return json({ error: 'missing player token' }, 400);
  const name = cleanName(body.name);
  if (!name) return json({ error: 'name must be 2-16 letters, numbers, spaces, _ . or -' }, 400);

  await ensureSchema(db);
  if (!await claimName(db, playerId, name)) {
    return json({ error: 'That name belongs to another player. Choose a different name.' }, 409);
  }
  await db.prepare('UPDATE runs SET name = ?1 WHERE player_id = ?2').bind(name, playerId).run();
  return json({ ok: true, name });
}
