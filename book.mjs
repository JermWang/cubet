// cubet bet book: every bet, every player and every balance lives here, on the server.
//   Players    anonymous visitors, identified by an HttpOnly session cookie (only its SHA-256 is stored)
//   Bets       created, taken, cancelled and settled here; nothing is simulated
//   Settlement a loop settles expired bets on the token's real market cap at the exact expiry time
//              (market.capAt: the GeckoTerminal candle that contains the expiry, converted to market cap)
//   Ledger     every balance change is written with its reason, so any balance can be audited
// Stakes are demo SOL: balances are numbers in this database, not on-chain funds.
// Storage: SQLite through Node's built-in node:sqlite (no dependencies). DB_PATH points at a persistent volume.
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const UNIT = 10_000;                         // balances are stored as integers of 0.0001 SOL
const toU = sol => Math.round(Number(sol) * UNIT);
const fromU = u => Number((u / UNIT).toFixed(4));
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const DURATIONS = [
  { label: '15 min', ms: 15 * 60e3 },
  { label: '1 h', ms: 60 * 60e3 },
  { label: '6 h', ms: 6 * 3600e3 },
  { label: '1 day', ms: 86400e3 },
  { label: '3 days', ms: 3 * 86400e3 },
  { label: '7 days', ms: 7 * 86400e3 },
];

export class BookError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new BookError(status, code, message); };

export function createBook({ dbPath, market, startingBalance = 1, maxDeposit = 1000, minStake = 0.01, maxStake = 100, maxOpenPerPlayer = 20, log = console }) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY, session_hash TEXT UNIQUE NOT NULL, handle TEXT NOT NULL,
      balance_u INTEGER NOT NULL DEFAULT 0, deposit_day TEXT, deposited_u INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS bets (
      id TEXT PRIMARY KEY, mint TEXT NOT NULL, symbol TEXT, name TEXT, image TEXT,
      dir TEXT NOT NULL CHECK (dir IN ('above','below')), target REAL NOT NULL, from_cap REAL NOT NULL,
      stake_u INTEGER NOT NULL, duration TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      owner TEXT NOT NULL REFERENCES players(id), taker TEXT REFERENCES players(id), taken_at INTEGER,
      state TEXT NOT NULL CHECK (state IN ('open','active','settled','expired','cancelled','void')),
      settled_cap REAL, settle_source TEXT, settle_candle INTEGER, settle_pair TEXT, creator_won INTEGER,
      settled_at INTEGER, settle_attempts INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS bets_state ON bets(state, expires_at);
    CREATE TABLE IF NOT EXISTS ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT, player TEXT NOT NULL, delta_u INTEGER NOT NULL,
      reason TEXT NOT NULL, bet_id TEXT, at INTEGER NOT NULL);
  `);

  const q = {
    playerBySession: db.prepare('SELECT * FROM players WHERE session_hash = ?'),
    playerById: db.prepare('SELECT * FROM players WHERE id = ?'),
    insertPlayer: db.prepare('INSERT INTO players (id, session_hash, handle, created_at) VALUES (?, ?, ?, ?)'),
    addBalance: db.prepare('UPDATE players SET balance_u = balance_u + ? WHERE id = ?'),
    setDeposit: db.prepare('UPDATE players SET deposit_day = ?, deposited_u = ? WHERE id = ?'),
    ledger: db.prepare('INSERT INTO ledger (player, delta_u, reason, bet_id, at) VALUES (?, ?, ?, ?, ?)'),
    bet: db.prepare('SELECT * FROM bets WHERE id = ?'),
    openCount: db.prepare("SELECT COUNT(*) n FROM bets WHERE owner = ? AND state = 'open'"),
    insertBet: db.prepare(`INSERT INTO bets (id, mint, symbol, name, image, dir, target, from_cap, stake_u, duration, created_at, expires_at, owner, state)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`),
    take: db.prepare("UPDATE bets SET taker = ?, taken_at = ?, state = 'active' WHERE id = ? AND state = 'open'"),
    setState: db.prepare('UPDATE bets SET state = ? WHERE id = ? AND state = ?'),
    settle: db.prepare(`UPDATE bets SET state = 'settled', settled_cap = ?, settle_source = ?, settle_candle = ?, settle_pair = ?,
                        creator_won = ?, settled_at = ? WHERE id = ? AND state = 'active'`),
    voided: db.prepare('UPDATE bets SET settled_at = ? WHERE id = ?'),
    attempt: db.prepare('UPDATE bets SET settle_attempts = settle_attempts + 1 WHERE id = ?'),
    due: db.prepare("SELECT * FROM bets WHERE state IN ('open','active') AND expires_at <= ? ORDER BY expires_at LIMIT 50"),
    live: db.prepare("SELECT * FROM bets WHERE state IN ('open','active') ORDER BY expires_at"),
    recent: db.prepare("SELECT * FROM bets WHERE state IN ('settled','void') ORDER BY settled_at DESC LIMIT ?"),
    mineDone: db.prepare("SELECT * FROM bets WHERE (owner = ? OR taker = ?) AND state IN ('settled','expired','void') ORDER BY expires_at DESC LIMIT 50"),
    handles: db.prepare('SELECT id, handle FROM players WHERE id IN (SELECT value FROM json_each(?))'),
    counts: db.prepare(`SELECT
        (SELECT COUNT(*) FROM bets) bets,
        (SELECT COUNT(*) FROM bets WHERE state = 'settled') settled,
        (SELECT COUNT(DISTINCT p) FROM (SELECT owner p FROM bets UNION SELECT taker FROM bets WHERE taker IS NOT NULL)) players`),
    settledAll: db.prepare("SELECT owner, taker, stake_u, creator_won FROM bets WHERE state = 'settled'"),
    activeAll: db.prepare("SELECT owner, taker, stake_u FROM bets WHERE state IN ('open','active')"),
  };

  // Every multi-step change runs in one transaction, so a crash never leaves a stake half-moved.
  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const out = fn(); db.exec('COMMIT'); return out; }
    catch (err) { db.exec('ROLLBACK'); throw err; }
  }
  function move(player, deltaU, reason, betId = null) {
    q.addBalance.run(deltaU, player);
    q.ledger.run(player, deltaU, reason, betId, Date.now());
  }

  /* ---------- players ---------- */
  const hash = s => createHash('sha256').update(s).digest('hex');
  const handleFor = () => { const r = randomBytes(8); const s = [...r].map(b => B58[b % 58]).join(''); return `${s.slice(0, 4)}…${s.slice(4)}`; };

  /** The player behind a session cookie, or null. */
  function player(session) {
    if (!session || session.length < 20 || session.length > 100) return null;
    return q.playerBySession.get(hash(session)) || null;
  }
  /** Create a new anonymous player, credit the starting demo balance, and return [session, player]. */
  function newPlayer() {
    const session = randomBytes(32).toString('base64url');
    const id = randomUUID();
    tx(() => {
      q.insertPlayer.run(id, hash(session), handleFor(), Date.now());
      if (startingBalance > 0) move(id, toU(startingBalance), 'starting demo balance');
    });
    return [session, q.playerById.get(id)];
  }
  const me = p => ({ id: p.id, handle: p.handle, balance: fromU(p.balance_u) });

  function funds(p, mode, amount) {
    const u = toU(amount);
    if (!Number.isFinite(u) || u <= 0) fail(400, 'bad_amount', 'Enter an amount above zero.');
    return tx(() => {
      const cur = q.playerById.get(p.id);
      if (mode === 'deposit') {
        const day = new Date().toISOString().slice(0, 10);
        const used = cur.deposit_day === day ? cur.deposited_u : 0;
        if (used + u > toU(maxDeposit)) fail(400, 'deposit_limit', `Demo deposits are limited to ${maxDeposit} SOL a day.`);
        q.setDeposit.run(day, used + u, p.id);
        move(p.id, u, 'demo deposit');
      } else if (mode === 'withdraw') {
        if (u > cur.balance_u) fail(400, 'insufficient', 'That is more than your available demo balance.');
        move(p.id, -u, 'demo withdrawal');
      } else fail(400, 'bad_mode', 'Unknown action.');
      return me(q.playerById.get(p.id));
    });
  }

  /* ---------- bets ---------- */
  async function create(p, input) {
    const mint = String(input?.mint || '');
    if (!MINT_RE.test(mint)) fail(400, 'bad_mint', 'Enter a valid Solana token address.');
    const dir = input?.dir;
    if (dir !== 'above' && dir !== 'below') fail(400, 'bad_dir', 'Choose Higher or Lower.');
    const dur = DURATIONS.find(d => d.label === input?.duration);
    if (!dur) fail(400, 'bad_duration', 'Choose a bet length.');
    const target = Number(input?.target);
    const stakeU = toU(input?.stake);
    if (!(stakeU >= toU(minStake) && stakeU <= toU(maxStake))) fail(400, 'bad_stake', `Stakes are ${minStake} to ${maxStake} SOL.`);
    // The token and its market cap come from our own server's live check, never from the browser.
    const tok = await market.token(mint);
    if (!tok.tradable || !(tok.cap > 0)) fail(400, 'no_market', 'This token has no DEX market cap to bet on.');
    if (!Number.isFinite(target) || target <= 0) fail(400, 'bad_target', 'Enter a target market cap.');
    if (dir === 'above' && target <= tok.cap) fail(400, 'bad_target', `For Higher, the target must be above the current market cap (${Math.round(tok.cap)}).`);
    if (dir === 'below' && target >= tok.cap) fail(400, 'bad_target', `For Lower, the target must be below the current market cap (${Math.round(tok.cap)}).`);
    const now = Date.now(), id = randomUUID();
    return tx(() => {
      const cur = q.playerById.get(p.id);
      if (cur.balance_u < stakeU) fail(400, 'insufficient', 'Deposit enough demo SOL to cover your stake.');
      if (q.openCount.get(p.id).n >= maxOpenPerPlayer) fail(400, 'too_many', `You can have up to ${maxOpenPerPlayer} open bets at once.`);
      q.insertBet.run(id, mint, tok.symbol || '', tok.name || '', tok.image || '', dir, target, tok.cap, stakeU, dur.label, now, now + dur.ms, p.id);
      move(p.id, -stakeU, 'stake: create', id);
      return id;
    });
  }

  // A bet can be taken until a quarter of its time is left (at least 2 minutes), so nobody
  // can take a side in the last seconds when the outcome is already obvious.
  const takeDeadline = b => b.expires_at - Math.max(2 * 60e3, (b.expires_at - b.created_at) * 0.25);

  function take(p, id) {
    return tx(() => {
      const b = q.bet.get(String(id));
      if (!b || b.state !== 'open') fail(409, 'not_open', 'This bet is no longer open.');
      if (b.owner === p.id) fail(400, 'own_bet', 'You cannot take your own bet.');
      if (Date.now() > takeDeadline(b)) fail(409, 'closing', 'Taking is closed: less than a quarter of this bet’s time is left.');
      const cur = q.playerById.get(p.id);
      if (cur.balance_u < b.stake_u) fail(400, 'insufficient', 'Deposit enough demo SOL to cover this stake.');
      if (q.take.run(p.id, Date.now(), b.id).changes !== 1) fail(409, 'not_open', 'Someone else just took this bet.');
      move(p.id, -b.stake_u, 'stake: take', b.id);
    });
  }

  function cancel(p, id) {
    return tx(() => {
      const b = q.bet.get(String(id));
      if (!b || b.owner !== p.id) fail(404, 'not_found', 'Bet not found.');
      if (q.setState.run('cancelled', b.id, 'open').changes !== 1) fail(409, 'not_open', 'Only open bets can be cancelled.');
      move(p.id, b.stake_u, 'refund: cancelled', b.id);
    });
  }

  /* ---------- settlement ---------- */
  const creatorWins = (b, cap) => (b.dir === 'above' ? cap > b.target : cap < b.target);
  let running = false;
  async function settleDue() {
    if (running) return;
    running = true;
    try {
      for (const b of q.due.all(Date.now())) {
        if (b.state === 'open') {
          // No one took it before it ended: the creator gets the stake back.
          tx(() => { if (q.setState.run('expired', b.id, 'open').changes === 1) move(b.owner, b.stake_u, 'refund: no taker', b.id); });
          continue;
        }
        try {
          const r = await market.capAt(b.mint, b.expires_at / 1000);
          const won = creatorWins(b, r.cap);
          tx(() => {
            if (q.settle.run(r.cap, r.source, r.candleTime ?? null, r.pair ?? null, won ? 1 : 0, Date.now(), b.id).changes !== 1) return;
            move(won ? b.owner : b.taker, b.stake_u * 2, 'payout: won', b.id);
          });
        } catch (err) {
          q.attempt.run(b.id);
          // If the market cap at expiry still can't be read after 6 hours, the bet is void and both
          // stakes go back. It is shown as void, never settled on a guess.
          if (Date.now() - b.expires_at > 6 * 3600e3) {
            tx(() => {
              if (q.setState.run('void', b.id, 'active').changes !== 1) return;
              q.voided.run(Date.now(), b.id);
              move(b.owner, b.stake_u, 'refund: void (no market data at expiry)', b.id);
              move(b.taker, b.stake_u, 'refund: void (no market data at expiry)', b.id);
            });
          }
          log.warn?.(`settle ${b.id} failed: ${err.message}`);
        }
      }
    } finally { running = false; }
  }

  /* ---------- reads ---------- */
  function handleMap(rows) {
    const ids = [...new Set(rows.flatMap(b => [b.owner, b.taker]).filter(Boolean))];
    return new Map(ids.length ? q.handles.all(JSON.stringify(ids)).map(r => [r.id, r.handle]) : []);
  }
  function view(b, names, viewer) {
    const mine = viewer && (b.owner === viewer || b.taker === viewer);
    return {
      id: b.id, token: { ca: b.mint, symbol: b.symbol, name: b.name, image: b.image },
      dir: b.dir, target: b.target, from: b.from_cap, stake: fromU(b.stake_u), duration: b.duration,
      createdAt: b.created_at, expiresAt: b.expires_at, takeUntil: b.state === 'open' ? takeDeadline(b) : null,
      state: b.state, owner: names.get(b.owner) || '—', taker: b.taker ? names.get(b.taker) || '—' : null,
      ownerIsMe: viewer === b.owner, takerIsMe: Boolean(viewer && viewer === b.taker), mine: Boolean(mine),
      settledCap: b.settled_cap, settleSource: b.settle_source, settleCandle: b.settle_candle, settlePair: b.settle_pair,
      creatorWon: b.creator_won == null ? null : Boolean(b.creator_won), settledAt: b.settled_at,
      won: b.state === 'settled' && mine ? (b.owner === viewer) === Boolean(b.creator_won) : null,
    };
  }
  function stats() {
    const live = q.live.all();
    const open = live.filter(b => b.state === 'open');
    const c = q.counts.get();
    return {
      open: open.length, openPot: fromU(open.reduce((s, b) => s + b.stake_u * 2, 0)),
      inPlay: live.length - open.length, players: c.players, totalBets: c.bets, settled: c.settled,
    };
  }
  /** Everything the terminal shows: live bets for everyone, plus the viewer's finished bets and recent settlements. */
  function snapshot(viewer) {
    const rows = [...q.live.all(), ...(viewer ? q.mineDone.all(viewer, viewer) : []), ...q.recent.all(30)];
    const seen = new Set(), uniq = rows.filter(b => !seen.has(b.id) && seen.add(b.id));
    const names = handleMap(uniq);
    return { now: Date.now(), bets: uniq.map(b => view(b, names, viewer)), stats: stats() };
  }
  function settlements(limit = 25) {
    const rows = q.recent.all(Math.min(100, limit));
    const names = handleMap(rows);
    return rows.map(b => view(b, names, null));
  }
  function leaderboard(viewer) {
    const map = new Map();
    const get = id => { if (!map.has(id)) map.set(id, { id, w: 0, l: 0, inPlayU: 0, plU: 0 }); return map.get(id); };
    for (const b of q.settledAll.all()) {
      const win = get(b.creator_won ? b.owner : b.taker), lose = get(b.creator_won ? b.taker : b.owner);
      win.w++; win.plU += b.stake_u; lose.l++; lose.plU -= b.stake_u;
    }
    for (const b of q.activeAll.all()) { get(b.owner).inPlayU += b.stake_u; if (b.taker) get(b.taker).inPlayU += b.stake_u; }
    const names = new Map(map.size ? q.handles.all(JSON.stringify([...map.keys()])).map(r => [r.id, r.handle]) : []);
    return [...map.values()]
      .sort((a, b) => b.plU - a.plU || b.w - a.w || b.inPlayU - a.inPlayU)
      .slice(0, 100)
      .map(r => ({ name: names.get(r.id) || '—', me: r.id === viewer, w: r.w, l: r.l, inPlay: fromU(r.inPlayU), pl: fromU(r.plU) }));
  }

  return { player, newPlayer, me, funds, create, take, cancel, settleDue, snapshot, settlements, leaderboard, stats, DURATIONS };
}
