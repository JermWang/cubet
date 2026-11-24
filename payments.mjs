// cubet payments: real SOL in and out of the treasury wallet.
//   Sign-in     the player signs a one-time message (nonce, domain, time) with their wallet; we verify ed25519.
//   Deposits    a SOL transfer from the player's own wallet to the treasury, credited once the transaction is
//               FINALIZED. Found two ways: the browser reports the signature right after sending, and a scanner
//               reads the treasury's transaction history, so a deposit is never missed. Each (signature, sender)
//               is credited exactly once (primary key). Transfers from wallets that never signed in wait as
//               "unclaimed" and are credited the moment that wallet signs in.
//   Withdrawals only ever to the player's own signed-in wallet. The balance is debited and the signed transaction
//               (with its signature) is stored BEFORE it is sent, so a crash or retry can never pay twice; a
//               reconciler re-sends it until it confirms, or refunds the balance once its blockhash has expired
//               and the network confirms it never landed.
//   Fees        cubet's fee on settled pots (FEE_BPS) accrues to the house ledger and is swept to FEE_WALLET.
//   Solvency    treasury balance on-chain vs. everything cubet owes, published on the Proof page.
// With no TREASURY_SECRET_KEY set, payments are OFF: no deposits, withdrawals or new bets. Never a fallback.
import { randomBytes } from 'node:crypto';
import { b58encode, isAddress, verifySignature, loadKeypair, transferMessage, signedTransaction, rpcClient, LAMPORTS } from './sol.mjs';
import { HOUSE, fromL } from './book.mjs';

const RENT_EXEMPT_MIN = 890_880;          // lamports a 0-data system account must keep
const NETWORK_FEE_L = 10_000;             // charged per withdrawal; covers the 5,000 base fee + the priority fee
const toL = sol => Math.round(Number(sol) * LAMPORTS);
const CU_LIMIT = 2_000;                   // a SOL transfer plus two compute-budget instructions uses ~450 CU

/** All System Program transfers INTO `treasury` in a parsed transaction, summed per sender (lamports). */
export function parseTransfersIn(txn, treasury) {
  const out = new Map();
  const all = [...(txn?.transaction?.message?.instructions || []), ...(txn?.meta?.innerInstructions || []).flatMap(i => i.instructions || [])];
  for (const ix of all) {
    const p = ix.parsed;
    if (ix.program !== 'system' || !p || (p.type !== 'transfer' && p.type !== 'transferWithSeed')) continue;
    const info = p.info || {};
    if (info.destination !== treasury) continue;
    const from = info.source || info.from, l = Number(info.lamports);
    if (!from || !Number.isSafeInteger(l) || l <= 0) continue;
    out.set(from, (out.get(from) || 0) + l);
  }
  return out;
}

export function createPayments({ book, rpcUrl, cluster = 'mainnet-beta', treasurySecret, feeWallet = '', minDeposit = 0.01,
  minWithdraw = 0.02, maxWithdrawPerDay = 25, withdrawalsPaused = false, feeSweepMin = 0.1, domain = 'cubet', log = console }) {
  const { db, tx, move, fail } = book;
  const rpc = rpcClient(rpcUrl);
  let keypair = null, configError = null;
  try { keypair = loadKeypair(treasurySecret); } catch (err) { configError = `TREASURY_SECRET_KEY is invalid: ${err.message}`; }
  if (feeWallet && !isAddress(feeWallet)) { configError = 'FEE_WALLET is not a valid Solana address.'; feeWallet = ''; }
  const enabled = Boolean(keypair) && !configError;
  const treasury = keypair?.address || null;
  if (configError) log.error?.(`payments OFF: ${configError}`);
  else if (!enabled) log.warn?.('payments OFF: set TREASURY_SECRET_KEY to turn on deposits, withdrawals and betting.');
  else log.log?.(`payments ON · ${cluster} · treasury ${treasury}`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS deposits (
      signature TEXT NOT NULL, sender TEXT NOT NULL, lamports INTEGER NOT NULL, player TEXT,
      status TEXT NOT NULL CHECK (status IN ('credited','unclaimed')), slot INTEGER, block_time INTEGER,
      credited_at INTEGER, seen_at INTEGER NOT NULL, PRIMARY KEY (signature, sender));
    CREATE TABLE IF NOT EXISTS scanned (signature TEXT PRIMARY KEY, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS withdrawals (
      id TEXT PRIMARY KEY, player TEXT NOT NULL, to_wallet TEXT NOT NULL, debit_l INTEGER NOT NULL, send_l INTEGER NOT NULL,
      signature TEXT UNIQUE NOT NULL, raw TEXT NOT NULL, last_valid INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','confirmed','failed')), error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS withdrawals_status ON withdrawals(status);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  const q = {
    deposit: db.prepare('SELECT * FROM deposits WHERE signature = ?'),
    insertDeposit: db.prepare(`INSERT OR IGNORE INTO deposits (signature, sender, lamports, player, status, slot, block_time, credited_at, seen_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    unclaimedFor: db.prepare("SELECT * FROM deposits WHERE sender = ? AND status = 'unclaimed'"),
    claim: db.prepare("UPDATE deposits SET status = 'credited', player = ?, credited_at = ? WHERE signature = ? AND sender = ? AND status = 'unclaimed'"),
    scanned: db.prepare('SELECT 1 FROM scanned WHERE signature = ?'),
    markScanned: db.prepare('INSERT OR IGNORE INTO scanned (signature, at) VALUES (?, ?)'),
    insertW: db.prepare(`INSERT INTO withdrawals (id, player, to_wallet, debit_l, send_l, signature, raw, last_valid, status, created_at, updated_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`),
    pendingW: db.prepare("SELECT * FROM withdrawals WHERE status = 'pending' ORDER BY created_at"),
    setW: db.prepare('UPDATE withdrawals SET status = ?, error = ?, updated_at = ? WHERE id = ? AND status = ?'),
    wById: db.prepare('SELECT * FROM withdrawals WHERE id = ?'),
    wSig: db.prepare('SELECT 1 FROM withdrawals WHERE signature = ?'),
    wToday: db.prepare("SELECT COALESCE(SUM(debit_l), 0) n FROM withdrawals WHERE player = ? AND status != 'failed' AND created_at > ?"),
    wPendingSum: db.prepare("SELECT COALESCE(SUM(send_l), 0) n FROM withdrawals WHERE status = 'pending'"),
    housePending: db.prepare("SELECT 1 FROM withdrawals WHERE player = ? AND status = 'pending'"),
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    recentDeposits: db.prepare('SELECT signature, sender, lamports, status, block_time, credited_at FROM deposits ORDER BY seen_at DESC LIMIT ?'),
    recentW: db.prepare("SELECT id, player, to_wallet, send_l, signature, status, created_at, updated_at FROM withdrawals ORDER BY created_at DESC LIMIT ?"),
    myDeposits: db.prepare('SELECT signature, lamports, status, block_time, credited_at FROM deposits WHERE player = ? ORDER BY seen_at DESC LIMIT 20'),
    myW: db.prepare('SELECT id, send_l, debit_l, signature, status, error, created_at FROM withdrawals WHERE player = ? ORDER BY created_at DESC LIMIT 20'),
    totals: db.prepare(`SELECT (SELECT COALESCE(SUM(lamports),0) FROM deposits) dep, (SELECT COUNT(*) FROM deposits) depN,
                               (SELECT COALESCE(SUM(send_l),0) FROM withdrawals WHERE status = 'confirmed') wd, (SELECT COUNT(*) FROM withdrawals WHERE status = 'confirmed') wdN`),
  };
  const requireOn = () => { if (!enabled) fail(503, 'payments_off', configError ? 'Payments are paused while cubet fixes its configuration.' : 'Deposits and withdrawals are not switched on yet.'); };

  /* ---------- sign-in with a wallet ---------- */
  const nonces = new Map();                      // nonce → { wallet, message, exp }
  // `host` is the page the visitor is on, so the wallet shows a message for the same domain it's connected from.
  function challenge(wallet, host) {
    if (!isAddress(wallet)) fail(400, 'bad_wallet', 'That is not a Solana wallet address.');
    const site = /^[a-z0-9.-]{1,100}(:\d{1,5})?$/i.test(String(host || '')) ? String(host).toLowerCase() : domain;
    const now = Date.now();
    for (const [k, v] of nonces) if (v.exp < now) nonces.delete(k);
    if (nonces.size > 20000) fail(429, 'busy', 'Too many sign-in attempts right now. Try again in a minute.');
    const nonce = randomBytes(16).toString('hex');
    const message = `${site} wants you to sign in with your Solana account:\n${wallet}\n\n` +
      `Signing proves you own this wallet. It is not a transaction and costs nothing.\n\n` +
      `URI: https://${site}\nVersion: 1\nNonce: ${nonce}\nIssued At: ${new Date(now).toISOString()}`;
    nonces.set(nonce, { wallet, message, exp: now + 5 * 60e3 });
    return { nonce, message };
  }
  function verifySignIn(wallet, nonce, signature) {
    const n = nonces.get(String(nonce));
    nonces.delete(String(nonce));                  // single use, pass or fail
    if (!n || n.exp < Date.now() || n.wallet !== wallet) fail(400, 'expired', 'That sign-in request expired. Try again.');
    if (!verifySignature(wallet, new TextEncoder().encode(n.message), signature)) fail(401, 'bad_signature', 'The wallet signature did not match.');
    const [session, player, isNew] = book.signIn(wallet);
    claimFor(player);
    return { session, player: book.refresh(player), isNew };
  }
  function claimFor(player) {
    tx(() => {
      for (const d of q.unclaimedFor.all(player.wallet)) {
        if (q.claim.run(player.id, Date.now(), d.signature, d.sender).changes === 1) move(player.id, d.lamports, 'deposit', d.signature);
      }
    });
  }

  /* ---------- deposits ---------- */
  /** Read one transaction and credit any deposits in it. Returns 'credited' | 'unclaimed' | 'none' | 'pending'. */
  async function processSignature(signature) {
    if (q.wSig.get(signature)) { q.markScanned.run(signature, Date.now()); return 'none'; }   // our own withdrawal
    const txn = await rpc('getTransaction', [signature, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 1 }]);
    if (!txn) return 'pending';                                                                 // not finalized yet
    q.markScanned.run(signature, Date.now());
    if (txn.meta?.err) return 'none';
    const inflows = [...parseTransfersIn(txn, treasury)].filter(([sender]) => sender !== treasury);
    if (!inflows.length) return 'none';
    // Defense in depth: only credit what the treasury's balance actually gained in this transaction.
    const keys = (txn.transaction?.message?.accountKeys || []).map(k => k.pubkey || k);
    const ti = keys.indexOf(treasury);
    const gained = ti >= 0 ? txn.meta.postBalances[ti] - txn.meta.preBalances[ti] : 0;
    const total = inflows.reduce((s, [, l]) => s + l, 0);
    if (gained < total) { log.error?.(`deposit ${signature}: transfers say ${total} lamports but the treasury gained ${gained}; not credited`); return 'none'; }
    let result = 'none';
    tx(() => {
      for (const [sender, lamports] of inflows) {
        if (sender === treasury) continue;
        const p = book.playerByWallet(sender);
        const ins = q.insertDeposit.run(signature, sender, lamports, p?.id || null, p ? 'credited' : 'unclaimed', txn.slot ?? null, txn.blockTime ?? null, p ? Date.now() : null, Date.now());
        if (ins.changes === 1 && p) move(p.id, lamports, 'deposit', signature);
        result = p ? 'credited' : result === 'credited' ? result : 'unclaimed';
      }
    });
    return result;
  }
  /** The browser reports a deposit it just sent. Read-only for anyone else's transfer: it only credits the sender. */
  async function reportDeposit(player, signature) {
    requireOn();
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(String(signature))) fail(400, 'bad_signature', 'That is not a transaction signature.');
    const known = q.deposit.get(signature);
    if (known) return { status: known.status, player: book.me(book.refresh(player)) };
    const status = await processSignature(signature);
    return { status, player: book.me(book.refresh(player)) };
  }

  // Scan the treasury's history (finalized), newest first, until we reach what we've already seen.
  let scanning = false;
  async function scan() {
    if (!enabled || scanning) return;
    scanning = true;
    try {
      const cursor = q.getMeta.get('scan_cursor')?.value || undefined;
      let before, newest = null;
      const todo = [];
      for (let page = 0; page < 10; page++) {
        const sigs = await rpc('getSignaturesForAddress', [treasury, { limit: 200, commitment: 'finalized', ...(before ? { before } : {}), ...(cursor ? { until: cursor } : {}) }]);
        if (!sigs.length) break;
        newest ??= sigs[0].signature;
        for (const s of sigs) if (!s.err && !q.scanned.get(s.signature)) todo.push(s.signature);
        if (sigs.length < 200) break;
        before = sigs.at(-1).signature;
      }
      for (const sig of todo.reverse()) {
        const r = await processSignature(sig).catch(err => { log.warn?.(`deposit scan ${sig}: ${err.message}`); return 'error'; });
        if (r === 'error' || r === 'pending') { newest = null; break; }     // retry from the old cursor next time
      }
      if (newest) q.setMeta.run('scan_cursor', newest);
    } catch (err) {
      log.warn?.(`deposit scan: ${err.message}`);
    } finally { scanning = false; }
  }

  /* ---------- withdrawals ---------- */
  async function treasuryLamports() { return (await rpc('getBalance', [treasury, { commitment: 'confirmed' }])).value; }

  // Priority fee from what the network paid recently (75th percentile), kept inside the fee charged per
  // withdrawal: at most (NETWORK_FEE_L - 5,000 base) lamports over CU_LIMIT compute units.
  async function priorityPrice() {
    const cap = Math.floor((NETWORK_FEE_L - 5_000) * 1e6 / CU_LIMIT);
    try {
      const fees = (await rpc('getRecentPrioritizationFees', [[treasury]])).map(f => f.prioritizationFee).filter(n => n > 0).sort((a, b) => a - b);
      const p75 = fees.length ? fees[Math.floor(fees.length * 0.75)] : 0;
      return Math.min(cap, Math.max(100_000, p75));
    } catch { return 500_000; }
  }
  async function buildTransfer(to, lamports) {
    const [{ value }, cuPrice] = await Promise.all([rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]), priorityPrice()]);
    const message = transferMessage({ from: treasury, to, lamports, blockhash: value.blockhash, cuPrice, cuLimit: CU_LIMIT });
    const sig = keypair.sign(message);
    return { signature: b58encode(sig), raw: Buffer.from(signedTransaction(message, sig)).toString('base64'), lastValid: value.lastValidBlockHeight };
  }
  const sendRaw = raw => rpc('sendTransaction', [raw, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 }]);

  let withdrawing = Promise.resolve();          // one withdrawal at a time, so treasury checks never race
  function withdraw(player, amount) {
    const run = withdrawing.then(() => doWithdraw(player, amount));
    withdrawing = run.catch(() => {});
    return run;
  }
  async function doWithdraw(player, amount) {
    requireOn();
    if (withdrawalsPaused) fail(503, 'paused', 'Withdrawals are paused for maintenance. Your balance is safe; try again soon.');
    const debit = toL(amount);
    if (!Number.isSafeInteger(debit) || debit < toL(minWithdraw)) fail(400, 'bad_amount', `The minimum withdrawal is ${minWithdraw} SOL.`);
    const p = book.refresh(player);
    if (debit > p.balance_l) fail(400, 'insufficient', 'That is more than your available balance.');
    if (q.wToday.get(p.id, Date.now() - 86400e3).n + debit > toL(maxWithdrawPerDay)) fail(400, 'daily_limit', `Withdrawals are limited to ${maxWithdrawPerDay} SOL per 24 hours.`);
    return sendWithdrawal(p.id, p.wallet, debit);
  }
  async function sendWithdrawal(playerId, to, debit) {
    const send = debit - NETWORK_FEE_L;
    const bal = await treasuryLamports();
    if (bal - q.wPendingSum.get().n - send - NETWORK_FEE_L < RENT_EXEMPT_MIN) {
      log.error?.(`withdrawal blocked: treasury ${bal} lamports cannot cover ${send}`);
      fail(503, 'treasury_low', 'Withdrawals are briefly unavailable. Your balance is safe; try again soon.');
    }
    const t = await buildTransfer(to, send);
    const id = randomBytes(8).toString('hex'), now = Date.now();
    tx(() => {
      move(playerId, -debit, 'withdrawal', t.signature);
      q.insertW.run(id, playerId, to, debit, send, t.signature, t.raw, t.lastValid, now, now);
    });
    try { await sendRaw(t.raw); }
    catch (err) {
      // Preflight rejected it, so it can never land: refund right away.
      if (/simulat|preflight|insufficient|invalid/i.test(err.message)) { failWithdrawal(q.wById.get(id), err.message); fail(502, 'send_failed', 'The network rejected the withdrawal. Your balance was not charged.'); }
      log.warn?.(`withdrawal ${id} send: ${err.message} (the reconciler will retry)`);
    }
    return { id, signature: t.signature, amount: fromL(send) };
  }
  function failWithdrawal(w, error) {
    tx(() => {
      if (q.setW.run('failed', String(error).slice(0, 300), Date.now(), w.id, 'pending').changes !== 1) return;
      move(w.player, w.debit_l, 'refund: withdrawal did not land', w.signature);
    });
  }
  // Pending withdrawals: confirm, re-send, or refund once the blockhash has expired and it never landed.
  let reconciling = false;
  async function reconcile() {
    if (!enabled || reconciling) return;
    reconciling = true;
    try {
      const pending = q.pendingW.all();
      if (pending.length) {
        const { value } = await rpc('getSignatureStatuses', [pending.map(w => w.signature), { searchTransactionHistory: true }]);
        const height = await rpc('getBlockHeight', [{ commitment: 'confirmed' }]);
        for (const [i, w] of pending.entries()) {
          const s = value[i];
          if (s?.err) failWithdrawal(w, JSON.stringify(s.err));
          else if (s && (s.confirmationStatus === 'finalized' || s.confirmationStatus === 'confirmed')) q.setW.run('confirmed', null, Date.now(), w.id, 'pending');
          else if (!s && height > w.last_valid + 10) failWithdrawal(w, 'blockhash expired before the transaction landed');
          else if (!s) await sendRaw(w.raw).catch(() => {});
        }
      }
      // Sweep cubet's fees to the fee wallet.
      const house = book.houseBalance();
      if (feeWallet && house >= toL(feeSweepMin) && !q.housePending.get(HOUSE)) await sendWithdrawal(HOUSE, feeWallet, house).catch(err => log.warn?.(`fee sweep: ${err.message}`));
    } catch (err) {
      log.warn?.(`reconcile: ${err.message}`);
    } finally { reconciling = false; }
  }

  /* ---------- reads ---------- */
  const explorer = sig => `https://solscan.io/tx/${sig}${cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`}`;
  function publicConfig() {
    return { enabled, cluster, treasury, minDeposit, minWithdraw, maxWithdrawPerDay, networkFee: fromL(NETWORK_FEE_L), withdrawalsPaused,
      feeBps: book.feeBps, minStake: book.minStake, maxStake: book.maxStake, minLiquidityUsd: book.minLiquidityUsd };
  }
  async function status() {
    const owed = book.liabilities(), pending = q.wPendingSum.get().n;
    let onchain = null;
    if (enabled) { try { onchain = await treasuryLamports(); } catch { /* shown as unavailable */ } }
    const t = q.totals.get();
    return {
      ...publicConfig(),
      treasuryBalance: onchain == null ? null : fromL(onchain),
      owed: { total: fromL(owed.total + pending), balances: fromL(owed.balances), lockedInBets: fromL(owed.lockedInBets), houseFees: fromL(owed.houseFees), pendingWithdrawals: fromL(pending) },
      solvent: onchain == null ? null : onchain >= owed.total + pending,
      totals: { deposited: fromL(t.dep), deposits: t.depN, withdrawn: fromL(t.wd), withdrawals: t.wdN },
    };
  }
  function transfers(limit = 25) {
    const n = Math.min(100, limit);
    return {
      deposits: q.recentDeposits.all(n).map(d => ({ signature: d.signature, url: explorer(d.signature), from: d.sender, amount: fromL(d.lamports), status: d.status, at: (d.block_time || 0) * 1000 || d.credited_at })),
      withdrawals: q.recentW.all(n).map(w => ({ signature: w.signature, url: explorer(w.signature), to: w.to_wallet, amount: fromL(w.send_l), status: w.status, kind: w.player === HOUSE ? 'fee sweep' : 'withdrawal', at: w.created_at })),
    };
  }
  function mine(player) {
    return {
      deposits: q.myDeposits.all(player.id).map(d => ({ signature: d.signature, url: explorer(d.signature), amount: fromL(d.lamports), status: d.status, at: d.credited_at })),
      withdrawals: q.myW.all(player.id).map(w => ({ id: w.id, signature: w.signature, url: explorer(w.signature), amount: fromL(w.send_l), status: w.status, error: w.error, at: w.created_at })),
    };
  }
  async function blockhash() { requireOn(); const { value } = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]); return { blockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight }; }
  // For wallets that can sign but not send: relay the player's signed deposit transaction as-is.
  async function relay(raw) {
    requireOn();
    if (typeof raw !== 'string' || raw.length > 1700 || !/^[A-Za-z0-9+/=]+$/.test(raw)) fail(400, 'bad_tx', 'Invalid transaction.');
    return { signature: await rpc('sendTransaction', [raw, { encoding: 'base64', preflightCommitment: 'confirmed' }]) };
  }

  return { enabled, treasury, cluster, challenge, verifySignIn, reportDeposit, withdraw, scan, reconcile, status, transfers, mine, publicConfig, blockhash, relay, explorer };
}
