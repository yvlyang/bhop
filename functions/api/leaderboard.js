// GET /api/leaderboard?mode=auto  → top 50 for a mode (+ your own rank if you send x-player-token)
import { BOARD_SIZE, MODES, ensureSchema, json, noDatabase, playerIdFromToken, publicId, rankOf } from '../../lib/leaderboard.js';

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return noDatabase();
  const mode = new URL(request.url).searchParams.get('mode');
  if (!MODES.includes(mode)) return json({ error: 'mode must be auto or scroll' }, 400);
  await ensureSchema(db);

  const { results } = await db
    .prepare(`SELECT player_id, name, time, jumps, perf, sync, created_at, replay IS NOT NULL AS has_replay
              FROM runs WHERE mode = ?1 ORDER BY time ASC, created_at ASC LIMIT ?2`)
    .bind(mode, BOARD_SIZE)
    .all();

  let me = null;
  const playerId = await playerIdFromToken(request.headers.get('x-player-token'));
  if (playerId) {
    const mine = await db.prepare('SELECT name, time, created_at FROM runs WHERE player_id = ?1 AND mode = ?2').bind(playerId, mode).first();
    if (mine) me = { id: publicId(playerId), name: mine.name, time: mine.time, rank: await rankOf(db, mode, mine.time, mine.created_at) };
  }

  return json({
    mode,
    rows: results.map((r, i) => ({
      rank: i + 1, id: publicId(r.player_id), name: r.name, time: r.time,
      jumps: r.jumps, perf: r.perf, sync: r.sync, date: r.created_at, replay: !!r.has_replay,
    })),
    me,
  });
}
