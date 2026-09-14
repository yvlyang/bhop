// POST /api/runs  → submit a finished run with its replay; keeps each player's best per mode
import {
  MODES, REPLAY_SLOTS, claimName, cleanName, ensureSchema, json, noDatabase, playerIdFromToken, rankOf, validateRun,
} from '../../lib/leaderboard.js';

const MAX_BODY = 2_000_000; // a 10-minute replay is ~1.2 MB of JSON

export async function onRequestPost(context) {
  try { return await submitRun(context); } catch (e) { return json({ error: 'server error, try again' }, 500); }
}

async function submitRun({ request, env }) {
  const db = env.DB;
  if (!db) return noDatabase();
  if (Number(request.headers.get('content-length') || 0) > MAX_BODY) return json({ error: 'replay too large' }, 413);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid JSON' }, 400); }

  const name = cleanName(body.name);
  if (!name) return json({ error: 'name must be 2-16 letters, numbers, spaces, _ . or -' }, 400);
  const playerId = await playerIdFromToken(body.token);
  if (!playerId) return json({ error: 'missing player token' }, 400);
  if (!MODES.includes(body.mode)) return json({ error: 'mode must be auto or scroll' }, 400);

  const check = validateRun(body);
  if (!check.ok) return json({ error: `run rejected: ${check.error}` }, 422);

  await ensureSchema(db);
  if (!await claimName(db, playerId, name)) {
    return json({ error: 'That name belongs to another player. Choose a different name.' }, 409);
  }
  const now = Date.now();
  const existing = await db.prepare('SELECT time, created_at, updated_at FROM runs WHERE player_id = ?1 AND mode = ?2').bind(playerId, body.mode).first();
  const improved = !existing || body.time < existing.time;
  if (improved && existing && now - existing.updated_at < 5000) return json({ error: 'too many submissions, try again in a few seconds' }, 429);

  if (improved) {
    await db
      .prepare(`INSERT INTO runs (player_id, mode, name, time, jumps, perf, sync, replay, created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
                ON CONFLICT (player_id, mode) DO UPDATE SET
                  name = excluded.name, time = excluded.time, jumps = excluded.jumps, perf = excluded.perf, sync = excluded.sync,
                  replay = excluded.replay, created_at = excluded.created_at, updated_at = excluded.updated_at`)
      .bind(playerId, body.mode, name, body.time, check.jumps, check.perf, check.sync, JSON.stringify(body.replay), now)
      .run();
    // only the top 10 keep their replay
    await db
      .prepare(`UPDATE runs SET replay = NULL WHERE mode = ?1 AND replay IS NOT NULL AND player_id NOT IN
                (SELECT player_id FROM runs WHERE mode = ?1 ORDER BY time ASC, created_at ASC LIMIT ?2)`)
      .bind(body.mode, REPLAY_SLOTS)
      .run();
  } else {
    await db.prepare('UPDATE runs SET name = ?1 WHERE player_id = ?2 AND mode = ?3').bind(name, playerId, body.mode).run();
  }

  const best = improved ? { time: body.time, created_at: now } : existing;
  return json({ ok: true, improved, time: best.time, rank: await rankOf(db, body.mode, best.time, best.created_at) });
}
