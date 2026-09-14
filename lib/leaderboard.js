// Shared leaderboard logic for the Cloudflare Pages Functions in /functions/api.
// Storage: one D1 table, one row per player per mode (their best run).
// Replays are only kept for the top 10 of each mode; ranks 11-50 keep just the time.

export const MODES = ['auto', 'scroll'];
export const BOARD_SIZE = 50;
export const REPLAY_SLOTS = 10;

const DT = 0.01; // the game runs at 100 tick

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS runs (
     player_id  TEXT NOT NULL,
     mode       TEXT NOT NULL,
     name       TEXT NOT NULL,
     time       REAL NOT NULL,
     jumps      INTEGER NOT NULL DEFAULT 0,
     perf       INTEGER,
     sync       INTEGER,
     replay     TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (player_id, mode)
   )`,
  'CREATE INDEX IF NOT EXISTS runs_by_time ON runs (mode, time, created_at)',
  `CREATE TABLE IF NOT EXISTS player_names (
     name_key TEXT PRIMARY KEY COLLATE NOCASE,
     player_id TEXT NOT NULL
   )`,
  // Reserve existing names for their earliest recorded owner. Never release an
  // old name on rename: someone else's old replay must not become impersonatable.
  `INSERT OR IGNORE INTO player_names (name_key, player_id)
   SELECT lower(trim(name)), player_id FROM runs ORDER BY created_at, player_id`,
  // OR IGNORE inside a trigger inherits the outer statement's conflict handling and breaks the PB upsert
  'DROP TRIGGER IF EXISTS reserve_run_name_0',
  'DROP TRIGGER IF EXISTS reserve_run_name_1',
  ...['INSERT', 'UPDATE OF name, player_id'].map((event, i) =>
    `CREATE TRIGGER IF NOT EXISTS reserve_run_name_v2_${i} BEFORE ${event} ON runs BEGIN
       INSERT INTO player_names (name_key, player_id)
         SELECT lower(trim(NEW.name)), NEW.player_id
         WHERE NOT EXISTS (SELECT 1 FROM player_names WHERE name_key = lower(trim(NEW.name)));
       SELECT CASE WHEN (SELECT player_id FROM player_names WHERE name_key = lower(trim(NEW.name))) != NEW.player_id
         THEN RAISE(ABORT, 'NAME_TAKEN') END;
     END`),
  `CREATE TABLE IF NOT EXISTS run_counts (
     player_id  TEXT NOT NULL,
     mode       TEXT NOT NULL,
     runs       INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (player_id, mode)
   )`,
];

let schemaReady = false;
export async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  schemaReady = true;
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function noDatabase() {
  return json({ error: 'Leaderboard database is not connected (bind a D1 database as DB).' }, 503);
}

export async function playerIdFromToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9-]{20,64}$/.test(token)) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('bhop_brick:' + token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// public id shown to other players (never the secret token)
export const publicId = (playerId) => playerId.slice(0, 16);

export function cleanName(name) {
  const n = String(name ?? '').trim().replace(/\s+/g, ' ');
  return /^[A-Za-z0-9_.\- ]{2,16}$/.test(n) ? n : null;
}

export async function rankOf(db, mode, time, createdAt) {
  const row = await db
    .prepare('SELECT COUNT(*) AS ahead FROM runs WHERE mode = ?1 AND (time < ?2 OR (time = ?2 AND created_at < ?3))')
    .bind(mode, time, createdAt)
    .first();
  return (row?.ahead ?? 0) + 1;
}

/* ---------------------------------------------------------------------------
   Replay validation. The replay records the player's position, speed and keys
   every tick, so the server can check the run is physically plausible:
   - it leaves the start zone and reaches the end zone at the claimed time
   - no teleporting, except to the map's real teleport destinations
   - speeds stay within the engine's limits
   - Scroll runs never hold jump through a landing (that would be autohop)
   It can't prove the inputs are human, but it stops edited times, noclip and
   position hacks.
   --------------------------------------------------------------------------- */

// map data in game (three.js) coordinates
const START_ZONE = { min: { x: 122, y: 129, z: -2112 }, max: { x: 479, y: 385, z: -1885 } };
const END_ZONE = { min: { x: -616, y: 129, z: 2280 }, max: { x: -264, y: 385, z: 2458 } };
const TELEPORT_DESTS = [
  [-436.228, 129, 1607.56], [300, 130, -2009], [297.882, 129, -1252.46], [-49.7462, 129, -171.112], [-55.2081, 129, 554.016],
];
const HULL_HALF = 16, HULL_HEIGHT = 72, MAX_VELOCITY = 3500;
const SPACE_BIT = 16;

const inZone = (f, z, pad = 0) =>
  f.x + HULL_HALF + pad > z.min.x && f.x - HULL_HALF - pad < z.max.x &&
  f.z + HULL_HALF + pad > z.min.z && f.z - HULL_HALF - pad < z.max.z &&
  f.y + HULL_HEIGHT + pad > z.min.y && f.y - pad < z.max.y;

const nearTeleportDest = (f) => TELEPORT_DESTS.some(([x, y, z]) => Math.hypot(f.x - x, f.z - z) < 3 && Math.abs(f.y - y) < 6);

function decodeFrames(b64, n) {
  const bin = atob(b64);
  if (bin.length !== n * 14) throw new Error('replay size does not match its frame count');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const dv = new DataView(bytes.buffer);
  return (i) => {
    const o = i * 14;
    return { x: dv.getInt16(o) / 8, y: dv.getInt16(o + 2) / 8, z: dv.getInt16(o + 4) / 8, speed: dv.getUint16(o + 11) / 4, keys: dv.getUint8(o + 13) };
  };
}

export function validateRun(body) {
  const fail = (error) => ({ ok: false, error });
  const { mode, time, replay: r } = body ?? {};
  if (!MODES.includes(mode)) return fail('unknown mode');
  if (!Number.isFinite(time) || time < 3 || time > 3600) return fail('time out of range');
  if (!r || r.v !== 1 || r.mode !== mode || Math.abs(r.time - time) > 1e-6) return fail('replay does not match the run');
  if (!Number.isInteger(r.n) || r.n < 3 || r.n > 60500) return fail('bad replay length');
  if (!Number.isInteger(r.startIdx) || r.startIdx < 1 || r.startIdx >= r.n) return fail('bad replay start');
  if (!Number.isFinite(r.startTime) || r.startTime < 0 || r.startTime > DT + 1e-9) return fail('bad start time');
  if (!Array.isArray(r.events) || r.events.length > 20000 || typeof r.b64 !== 'string') return fail('bad replay data');

  let frame;
  try { frame = decodeFrames(r.b64, r.n); } catch (e) { return fail(e.message); }

  // start: the tick before the run began was inside the start zone
  if (!inZone(frame(r.startIdx - 1), START_ZONE, 2)) return fail('run does not begin at the start zone');

  // the timer starts on the first jump, so there can't be a jump while still waiting in the start zone
  let zoneFrom = r.startIdx - 1;
  while (zoneFrom > 0 && inZone(frame(zoneFrom - 1), START_ZONE, 2)) zoneFrom--;
  if (r.events.some((e) => e && e.type === 'jump' && e.tick >= zoneFrom && e.tick < r.startIdx)) return fail('the timer must start on your first jump');
  if (frame(r.startIdx - 1).speed > 255) return fail('too fast leaving the start zone');

  // finish: the first tick inside the end zone must match the claimed time (±2 ticks for quantization)
  const expected = r.startIdx + Math.ceil((time - r.startTime) / DT - 1e-9);
  let finish = -1;
  for (let i = r.startIdx + 1; i < r.n; i++) if (inZone(frame(i), END_ZONE)) { finish = i; break; }
  if (finish < 0) return fail('run never reaches the end zone');
  if (Math.abs(finish - expected) > 2) return fail('time does not match the replay');

  // movement between ticks
  let prev = frame(r.startIdx);
  for (let i = r.startIdx + 1; i <= finish; i++) {
    const f = frame(i);
    if (f.speed > MAX_VELOCITY) return fail('speed over the engine limit');
    const horizontal = Math.hypot(f.x - prev.x, f.z - prev.z);
    const allowed = Math.max(f.speed, prev.speed) * DT * 1.6 + 3;
    if ((horizontal > allowed || Math.abs(f.y - prev.y) > 45) && !nearTeleportDest(f)) return fail(`impossible movement at tick ${i}`);
    prev = f;
  }

  // jumps inside the run
  const jumps = r.events.filter((e) => e && e.type === 'jump' && Number.isInteger(e.tick) && e.tick >= r.startIdx && e.tick <= finish);
  if (mode === 'scroll') {
    for (const e of jumps) if (e.tick > 0 && frame(e.tick - 1).keys & SPACE_BIT) return fail('jump was held through a landing (autohop) in Scroll mode');
  }
  const hops = jumps.filter((e) => e.j && e.j.perf != null);
  const perf = hops.length ? Math.round((100 * hops.filter((e) => e.j.perf).length) / hops.length) : null;
  const sync = Number.isFinite(body.sync) ? Math.max(0, Math.min(100, Math.round(body.sync))) : null;
  return { ok: true, jumps: jumps.length, perf, sync };
}

// The unique key and conditional insert make concurrent claims atomic.
export async function claimName(db, playerId, name) {
  await db.prepare('INSERT OR IGNORE INTO player_names (name_key, player_id) VALUES (?1, ?2)')
    .bind(name.toLowerCase(), playerId).run();
  const owner = await db.prepare('SELECT player_id FROM player_names WHERE name_key = ?1')
    .bind(name.toLowerCase()).first();
  return owner?.player_id === playerId;
}
