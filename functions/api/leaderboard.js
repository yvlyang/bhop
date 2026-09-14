// GET /api/leaderboard?mode=auto  → top 100 for a mode (+ your own rank if you send x-player-token)
import { BOARD_SIZE, boardKey, ensureSchema, json, noDatabase, playerIdFromToken, publicId, rankOf } from '../../lib/leaderboard.js';

export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return noDatabase();
  const params = new URL(request.url).searchParams;
  const map = params.get('map') ?? 'bhop_brick', requestedMode = params.get('mode');
  const mode = boardKey(map, requestedMode);
  if (!mode) return json({ error: 'unknown map or mode' }, 400);
  await ensureSchema(db);

  const { results } = await db
    .prepare(`SELECT r.player_id, r.name, r.time, r.jumps, r.perf, r.sync, r.created_at, r.replay IS NOT NULL AS has_replay,
                     COALESCE(c.runs, 0) AS runs
              FROM runs r LEFT JOIN run_counts c ON c.player_id = r.player_id AND c.mode = r.mode
              WHERE r.mode = ?1 ORDER BY r.time ASC, r.created_at ASC LIMIT ?2`)
    .bind(mode, BOARD_SIZE)
    .all();

  const totals = await db.prepare('SELECT COALESCE(SUM(runs), 0) AS runs FROM run_counts WHERE mode = ?1').bind(mode).first();

  let me = null;
  const playerId = await playerIdFromToken(request.headers.get('x-player-token'));
  if (playerId) {
    const mine = await db.prepare('SELECT name, time, created_at FROM runs WHERE player_id = ?1 AND mode = ?2').bind(playerId, mode).first();
    const count = await db.prepare('SELECT runs FROM run_counts WHERE player_id = ?1 AND mode = ?2').bind(playerId, mode).first();
    me = {
      id: publicId(playerId), runs: count?.runs ?? 0,
      ...(mine ? { name: mine.name, time: mine.time, rank: await rankOf(db, mode, mine.time, mine.created_at) } : {}),
    };
  }

  return json({
    map, mode: requestedMode,
    rows: results.map((r, i) => ({
      rank: i + 1, id: publicId(r.player_id), name: r.name, time: r.time,
      jumps: r.jumps, perf: r.perf, sync: r.sync, date: r.created_at, replay: !!r.has_replay, runs: r.runs,
    })),
    totalRuns: totals?.runs ?? 0,
    me,
  });
}
