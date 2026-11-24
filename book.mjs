// cubet bet book: every player, bet and balance lives here, on the server. Stakes are real SOL.
//   Players    Solana wallets. A player signs in by signing a one-time message with their wallet;
//              the server verifies the ed25519 signature and issues an HttpOnly session cookie.
//   Funds      Deposits are real SOL transfers to cubet's treasury wallet, credited once the transaction
//              is finalized on-chain (see payments.mjs). Withdrawals are real SOL transfers from the
//              treasury to the player's own wallet. Balances are kept in lamports.
//   Bets       created, taken, cancelled and settled here; nothing is simulated
//   Settlement a loop settles expired bets on the token's real market cap at the exact expiry time
//              (market.capAt: the GeckoTerminal candle that contains the expiry, converted to market cap)
//   Ledger     every balance change is written with its reason and reference (bet id or tx signature)
// Storage: SQLite through Node's built-in node:sqlite (no dependencies). DB_PATH points at a persistent volume.
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const LAMPORTS = 1_000_000_000;
const toL = sol => Math.round(Number(sol) * LAMPORTS);
export const fromL = l => Number((l / LAMPORTS).toFixed(9));
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const HOUSE = 'house';                 // ledger account for cubet's fee on settled pots
const SESSION_DAYS = 30;

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

export function createBook({ dbPath, market, minStake = 0.01, maxStake = 10, maxOpenPerPlayer = 20, feeBps = 0, minLiquidityUsd = 20000, log = console }) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');

  // The first version of cubet kept demo balances in these tables. They are moved aside (never mixed with
  // real funds) the first time this version starts.
  const cols = db.prepare("SELECT name FROM pragma_table_info('players')").all().map(r => r.name);
  if (cols.length && !cols.includes('wallet')) {
    db.exec(`ALTER TABLE players RENAME TO demo_players; ALTER TABLE bets RENAME TO demo_bets; ALTER TABLE ledger RENAME TO demo_ledger;
             DROP INDEX IF EXISTS bets_state;`);
    log.log?.('book: moved the old demo tables aside (demo_players, demo_bets, demo_ledger)');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY, wallet TEXT UNIQUE NOT NULL, handle TEXT NOT NULL,
      balance_l INTEGER NOT NULL DEFAULT 0 CHECK (balance_l >= 0), created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (
      hash TEXT PRIMARY KEY, player TEXT NOT NULL REFERENCES players(id), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS bets (
      id TEXT PRIMARY KEY, mint TEXT NOT NULL, symbol TEXT, name TEXT, image TEXT,
      dir TEXT NOT NULL CHECK (dir IN ('above','below')), target REAL NOT NULL, from_cap REAL NOT NULL,
      stake_l INTEGER NOT NULL CHECK (stake_l > 0), duration TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      owner TEXT NOT NULL REFERENCES players(id), taker TEXT REFERENCES players(id), taken_at INTEGER,
      state TEXT NOT NULL CHECK (state IN ('open','active','settled','expired','cancelled','void')),
      settled_cap REAL, settle_source TEXT, settle_candle INTEGER, settle_pair TEXT, creator_won INTEGER,
      fee_l INTEGER NOT NULL DEFAULT 0, settled_at INTEGER, settle_attempts INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS bets_state ON bets(state, expires_at);
    CREATE TABLE IF NOT EXISTS ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT, player TEXT NOT NULL, delta_l INTEGER NOT NULL,
      reason TEXT NOT NULL, ref TEXT, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS ledger_player ON ledger(player, id);
  `);

  const q = {
    playerBySession: db.prepare('SELECT p.* FROM sessions s JOIN players p ON p.id = s.player WHERE s.hash = ? AND s.expires_at > ?'),
    playerById: db.prepare('SELECT * FROM players WHERE id = ?'),
    playerByWallet: db.prepare('SELECT * FROM players WHERE wallet = ?'),
    insertPlayer: db.prepare('INSERT INTO players (id, wallet, handle, created_at) VALUES (?, ?, ?, ?)'),
    insertSession: db.prepare('INSERT INTO sessions (hash, player, created_at, expires_at) VALUES (?, ?, ?, ?)'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE hash = ?'),
    pruneSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
    addBalance: db.prepare('UPDATE players SET balance_l = balance_l + ? WHERE id = ?'),
    ledger: db.prepare('INSERT INTO ledger (player, delta_l, reason, ref, at) VALUES (?, ?, ?, ?, ?)'),
    houseBalance: db.prepare('SELECT COALESCE(SUM(delta_l), 0) n FROM ledger WHERE player = ?'),
    history: db.prepare('SELECT delta_l, reason, ref, at FROM ledger WHERE player = ? ORDER BY id DESC LIMIT ?'),
    bet: db.prepare('SELECT * FROM bets WHERE id = ?'),
    openCount: db.prepare("SELECT COUNT(*) n FROM bets WHERE owner = ? AND state = 'open'"),
    insertBet: db.prepare(`INSERT INTO bets (id, mint, symbol, name, image, dir, target, from_cap, stake_l, duration, created_at, expires_at, owner, state)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`),
    take: db.prepare("UPDATE bets SET taker = ?, taken_at = ?, state = 'active' WHERE id = ? AND state = 'open'"),
    setState: db.prepare('UPDATE bets SET state = ? WHERE id = ? AND state = ?'),
    settle: db.prepare(`UPDATE bets SET state = 'settled', settled_cap = ?, settle_source = ?, settle_candle = ?, settle_pair = ?,
                        creator_won = ?, fee_l = ?, settled_at = ? WHERE id = ? AND state = 'active'`),
    voided: db.prepare('UPDATE bets SET settled_at = ? WHERE id = ?'),
    attempt: db.prepare('UPDATE bets SET settle_attempts = settle_attempts + 1 WHERE id = ?'),
    due: db.prepare("SELECT * FROM bets WHERE state IN ('open','active') AND expires_at <= ? ORDER BY expires_at LIMIT 50"),
    live: db.prepare("SELECT * FROM bets WHERE state IN ('open','active') ORDER BY expires_at"),
    recent: db.prepare("SELECT * FROM bets WHERE state IN ('settled','void') ORDER BY settled_at DESC LIMIT ?"),
    mineDone: db.prepare("SELECT * FROM bets WHERE (owner = ? OR taker = ?) AND state IN ('settled','expired','void','cancelled') ORDER BY expires_at DESC LIMIT 50"),
    handles: db.prepare('SELECT id, handle FROM players WHERE id IN (SELECT value FROM json_each(?))'),
    counts: db.prepare(`SELECT
        (SELECT COUNT(*) FROM bets) bets,
        (SELECT COUNT(*) FROM bets WHERE state = 'settled') settled,
        (SELECT COUNT(*) FROM players) players`),
    settledAll: db.prepare("SELECT owner, taker, stake_l, fee_l, creator_won FROM bets WHERE state = 'settled'"),
    activeAll: db.prepare("SELECT owner, taker, stake_l FROM bets WHERE state IN ('open','active')"),
    liabilities: db.prepare(`SELECT
        (SELECT COALESCE(SUM(balance_l), 0) FROM players) balances,
        (SELECT COALESCE(SUM(stake_l), 0) FROM bets WHERE state = 'open') open_stakes,
        (SELECT COALESCE(SUM(stake_l * 2), 0) FROM bets WHERE state = 'active') active_pots`),
  };

  // Every multi-step change runs in one transaction, so a crash never leaves funds half-moved.
  let depth = 0;
  function tx(fn) {
    if (depth) return fn();                       // already inside a transaction (payments call in)
    db.exec('BEGIN IMMEDIATE'); depth++;
    try { const out = fn(); depth--; db.exec('COMMIT'); return out; }
    catch (err) { depth--; db.exec('ROLLBACK'); throw err; }
  }
  function move(player, deltaL, reason, ref = null) {
    if (player !== HOUSE) {
      const cur = q.playerById.get(player);
      if (!cur) fail(500, 'no_player', 'Unknown player.');
      if (cur.balance_l + deltaL < 0) fail(400, 'insufficient', 'That is more than your available balance.');
      q.addBalance.run(deltaL, player);
    }
    q.ledger.run(player, deltaL, reason, ref, Date.now());
  }

  /* ---------- players and sessions ---------- */
  const hash = s => createHash('sha256').update(s).digest('hex');
  const handleOf = wallet => `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;

  /** The player behind a session cookie, or null. */
  function player(session) {
    if (!session || session.length < 20 || session.length > 100) return null;
    return q.playerBySession.get(hash(session), Date.now()) || null;
  }
  /** Find or create the player for a verified wallet and open a new session. Returns [session, player, isNew]. */
  function signIn(wallet) {
    const session = randomBytes(32).toString('base64url');
    return tx(() => {
      let p = q.playerByWallet.get(wallet), isNew = false;
      if (!p) { q.insertPlayer.run(randomUUID(), wallet, handleOf(wallet), Date.now()); p = q.playerByWallet.get(wallet); isNew = true; }
      const now = Date.now();
      q.pruneSessions.run(now);
      q.insertSession.run(hash(session), p.id, now, now + SESSION_DAYS * 86400e3);
      return [session, p, isNew];
    });
  }
  const signOut = session => { if (session) q.deleteSession.run(hash(session)); };
  const me = p => ({ id: p.id, wallet: p.wallet, handle: p.handle, balance: fromL(p.balance_l) });
  const refresh = p => q.playerById.get(p.id);
  const history = (p, limit = 50) => q.history.all(p.id, limit).map(r => ({ amount: fromL(r.delta_l), reason: r.reason, ref: r.ref, at: r.at }));

  /* ---------- bets ---------- */
  async function create(p, input) {
    const mint = String(input?.mint || '');
    if (!MINT_RE.test(mint)) fail(400, 'bad_mint', 'Enter a valid Solana token address.');
    const dir = input?.dir;
    if (dir !== 'above' && dir !== 'below') fail(400, 'bad_dir', 'Choose Higher or Lower.');
    const dur = DURATIONS.find(d => d.label === input?.duration);
    if (!dur) fail(400, 'bad_duration', 'Choose a bet length.');
    const target = Number(input?.target);
    const stakeL = toL(input?.stake);
    if (!(stakeL >= toL(minStake) && stakeL <= toL(maxStake))) fail(400, 'bad_stake', `Stakes are ${minStake} to ${maxStake} SOL.`);
    // The token and its market cap come from our own server's live check, never from the browser.
    const tok = await market.token(mint);
    if (!tok.tradable || !(tok.cap > 0)) fail(400, 'no_market', 'This token has no DEX market cap to bet on.');
    // Thin pools are easy to push around at the last minute, so real-SOL bets need a real pool.
    if (!(Number(tok.liquidity) >= minLiquidityUsd)) fail(400, 'low_liquidity', `This token's top pool has under $${minLiquidityUsd.toLocaleString('en-US')} of liquidity, so it can't be bet on yet.`);
    if (!Number.isFinite(target) || target <= 0) fail(400, 'bad_target', 'Enter a target market cap.');
    if (dir === 'above' && target <= tok.cap) fail(400, 'bad_target', `For Higher, the target must be above the current market cap (${Math.round(tok.cap)}).`);
    if (dir === 'below' && target >= tok.cap) fail(400, 'bad_target', `For Lower, the target must be below the current market cap (${Math.round(tok.cap)}).`);
    const now = Date.now(), id = randomUUID();
    return tx(() => {
      if (q.openCount.get(p.id).n >= maxOpenPerPlayer) fail(400, 'too_many', `You can have up to ${maxOpenPerPlayer} open bets at once.`);
      q.insertBet.run(id, mint, tok.symbol || '', tok.name || '', tok.image || '', dir, target, tok.cap, stakeL, dur.label, now, now + dur.ms, p.id);
      move(p.id, -stakeL, 'stake: create', id);
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
      if (refresh(p).balance_l < b.stake_l) fail(400, 'insufficient', 'Deposit enough SOL to cover this stake.');
      if (q.take.run(p.id, Date.now(), b.id).changes !== 1) fail(409, 'not_open', 'Someone else just took this bet.');
      move(p.id, -b.stake_l, 'stake: take', b.id);
    });
  }

  function cancel(p, id) {
    return tx(() => {
      const b = q.bet.get(String(id));
      if (!b || b.owner !== p.id) fail(404, 'not_found', 'Bet not found.');
      if (q.setState.run('cancelled', b.id, 'open').changes !== 1) fail(409, 'not_open', 'Only open bets can be cancelled.');
      move(p.id, b.stake_l, 'refund: cancelled', b.id);
    });
  }

  /* ---------- settlement ---------- */
  const creatorWins = (b, cap) => (b.dir === 'above' ? cap > b.target : cap < b.target);
  const feeOf = pot => Math.floor(pot * feeBps / 10_000);
  let running = false;
  async function settleDue() {
    if (running) return;
    running = true;
    try {
      for (const b of q.due.all(Date.now())) {
        if (b.state === 'open') {
          // No one took it before it ended: the creator gets the stake back.
          tx(() => { if (q.setState.run('expired', b.id, 'open').changes === 1) move(b.owner, b.stake_l, 'refund: no taker', b.id); });
          continue;
        }
        try {
          const r = await market.capAt(b.mint, b.expires_at / 1000);
          const won = creatorWins(b, r.cap), pot = b.stake_l * 2, fee = feeOf(pot);
          tx(() => {
            if (q.settle.run(r.cap, r.source, r.candleTime ?? null, r.pair ?? null, won ? 1 : 0, fee, Date.now(), b.id).changes !== 1) return;
            move(won ? b.owner : b.taker, pot - fee, 'payout: won', b.id);
            if (fee) move(HOUSE, fee, 'fee: settled pot', b.id);
          });
        } catch (err) {
          q.attempt.run(b.id);
          // If the market cap at expiry still can't be read after 6 hours, the bet is void and both
          // stakes go back. It is shown as void, never settled on a guess.
          if (Date.now() - b.expires_at > 6 * 3600e3) {
            tx(() => {
              if (q.setState.run('void', b.id, 'active').changes !== 1) return;
              q.voided.run(Date.now(), b.id);
              move(b.owner, b.stake_l, 'refund: void (no market data at expiry)', b.id);
              move(b.taker, b.stake_l, 'refund: void (no market data at expiry)', b.id);
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
      dir: b.dir, target: b.target, from: b.from_cap, stake: fromL(b.stake_l), fee: fromL(b.fee_l), duration: b.duration,
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
      open: open.length, openPot: fromL(open.reduce((s, b) => s + b.stake_l * 2, 0)),
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
    const get = id => { if (!map.has(id)) map.set(id, { id, w: 0, l: 0, inPlayL: 0, plL: 0 }); return map.get(id); };
    for (const b of q.settledAll.all()) {
      const win = get(b.creator_won ? b.owner : b.taker), lose = get(b.creator_won ? b.taker : b.owner);
      win.w++; win.plL += b.stake_l - b.fee_l; lose.l++; lose.plL -= b.stake_l;
    }
    for (const b of q.activeAll.all()) { get(b.owner).inPlayL += b.stake_l; if (b.taker) get(b.taker).inPlayL += b.stake_l; }
    const names = new Map(map.size ? q.handles.all(JSON.stringify([...map.keys()])).map(r => [r.id, r.handle]) : []);
    return [...map.values()]
      .sort((a, b) => b.plL - a.plL || b.w - a.w || b.inPlayL - a.inPlayL)
      .slice(0, 100)
      .map(r => ({ name: names.get(r.id) || '—', me: r.id === viewer, w: r.w, l: r.l, inPlay: fromL(r.inPlayL), pl: fromL(r.plL) }));
  }
  /** What cubet owes, in lamports: player balances, stakes locked in bets, and unswept house fees. */
  function liabilities() {
    const r = q.liabilities.get();
    const house = q.houseBalance.get(HOUSE).n;
    return { balances: r.balances, lockedInBets: r.open_stakes + r.active_pots, houseFees: house, total: r.balances + r.open_stakes + r.active_pots + house };
  }

  return {
    db, tx, move, fail, player, signIn, signOut, me, refresh, history, create, take, cancel, settleDue,
    snapshot, settlements, leaderboard, stats, liabilities, houseBalance: () => q.houseBalance.get(HOUSE).n,
    playerByWallet: w => q.playerByWallet.get(w) || null, DURATIONS, minStake, maxStake, feeBps, minLiquidityUsd,
  };
}
