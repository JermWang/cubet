# cubet

A market-cap betting terminal for any Solana token. Token data is live and checked on-chain, every other player is a real visitor, and the server settles each bet on the real market cap at its expiry. Stakes are demo SOL for now.

- **Live:** https://www.cubetsolana.xyz (also https://cubet-production.up.railway.app)
- **X:** https://x.com/cubetsol
- **`/`**: landing page. Every call to action leads to the terminal.
- **`/terminal`**: the betting terminal: open bets, My Bets, settled bets, create a bet, leaderboard, demo wallet.
- **`/proof`**: live checks against the real integrations, every settlement with the price candle it used, and the limits below.

## What's real and what isn't yet

| Real | Not yet |
|---|---|
| Token check: every contract address is verified on-chain (`getAccountInfo`: SPL / Token-2022 mint, decimals, supply, mint and freeze authority) | Stakes are demo SOL: balances are numbers in cubet's database. No wallet connects and nothing is sent on-chain, so there are no bet transactions |
| Names, symbols, logos, live market caps, 24h change, liquidity, volume (DexScreener) | Settlement runs on cubet's server, not an on-chain program. Every result can be recomputed from the public candle it records |
| Trending coins and chart history (GeckoTerminal OHLCV) | No cubet token has been launched |
| Real players: one shared bet book on the server (`book.mjs`). No bots, no sample players | |
| Settlement: the market cap in the GeckoTerminal candle containing the expiry minute (the live DexScreener cap if it ended in the last two minutes). No data at expiry for 6 hours → void, both refunded | |
| Ledger: every balance change is recorded with its reason | |

## Run locally

Double-click `START.cmd`, or run `npm start`, then open http://localhost:4174. You need Node.js 22.13 or newer (for the built-in `node:sqlite`). There are no dependencies and no build step. Copy `.env.example` to `.env` to change settings; it works without any keys.

## Environment variables

**Nothing is required.** Everything works on free public data sources. Two optional keys make it production-grade:

| Variable | Where | What it does |
|---|---|---|
| `SOLANA_RPC_URL` | **plug in (secret)** | Your Helius / QuickNode / Triton / Alchemy RPC URL. Without it, the public RPC is used, which is rate-limited |
| `COINGECKO_API_KEY` | **plug in (optional, secret)** | Switches charts and trending to CoinGecko's on-chain API for higher rate limits |
| `PUBLIC_URL` | `https://www.cubetsolana.xyz` | Share-link, canonical URL and og:image |
| `DB_PATH` | `/data/cubet.db` on Railway | The shared bet book (SQLite, Node's built-in `node:sqlite`). Railway volume `cubet-volume` is mounted at `/data`. Locally defaults to `data/cubet.db` |
| `DATA_CACHE_SECONDS` | `20` | Server-side market data cache |
| `API_RATE_LIMIT` | `120` | Data API requests per minute per visitor |
| `NODE_ENV`, `HOST`, `CACHE_MAX_AGE` | `production`, `0.0.0.0`, `3600` | Server |
| `APP_NAME`, `APP_TITLE`, `APP_TAGLINE`, `APP_FOOTER` | filled | Branding (public) |
| `CURRENCY`, `STORAGE_KEY`, `MAX_DEPOSIT`, `DEFAULT_STAKE` | filled | Demo economy (public). `MAX_DEPOSIT` is the daily demo deposit limit per player, enforced by the server |
| `ART_BOIL` | `false` | Optional hand-drawn wobble on the hero scene |
| `PORT` | injected by Railway | Don't set it |

To set the secrets on Railway, open the dashboard → cubet → Variables, or run:

```bash
railway variables --service cubet --set "SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY"
```

They're declared as `preserve()` in `.railway/railway.ts`, so `railway config apply` never overwrites or removes them.

## Deploy (Railway)

The project already exists and is live: Railway project **cubet**, service **cubet**, environment **production**.

| To do this… | Run |
|---|---|
| Ship code changes | `npm run deploy` (same as `railway up --service cubet`) |
| See logs | `railway logs --service cubet` |
| Change public settings in code | edit `.railway/railway.ts`, then `railway config plan` and `railway config apply` |

Every deploy gets a new asset version (`/app.js?v=<deploy id>`). Browsers cache scripts for a year but never mix a new page with old code.

> **Windows note:** `railway config plan` and `apply` fail with "requires Railway CLI 5.42.1 or newer" when the CLI was installed through npm. Point it at the real binary:
> `_="$APPDATA/npm/node_modules/@railway/cli/bin/railway.exe" railway config apply`

## Design

- **Brand:** a glowing 3D wireframe cube that tumbles in the nav, using real perspective projection with depth-shaded edges and pointer parallax (`fx.js` → `FX.cube`). A nested, counter-rotating version anchors the final call to action, over a hand-written WebGL aura shader (`FX.aura`).
- **Live markets feed:** this is the landing page's main section. Each trending Solana coin gets a bet-first card with:
  - **Question:** "Where does X close in 24 hours?"
  - **Live price:** its market cap, plus a trend line built from real 24h/6h/1h/5m price changes.
  - **Range bar:** where the cap sits between an upside and a downside target.
  - **Real stats:** volume and liquidity, plus any open bets.
  - **Buttons:** Higher / Lower open the terminal with the bet filled in.

  Tabs sort the cards (Trending, Top gainers, Top losers, Largest). A search box takes any contract address. Caps refresh every 20 seconds and flash as they change.
- **Framer-style interactions:**
  - **Nav:** mega-menu panels that dim the page.
  - **Text:** links fade up to white, arrows nudge, and headlines blur in word by word.
  - **Cards and inputs:** cursor-tracked spotlight borders, a light that orbits focused inputs, and blur-in reveals on scroll.
- **Charts** (`art.js` → `Art.chart`): smooth market-cap lines with a glow, a dashed target line, a shaded winning zone, a pulsing "now" dot, and a hover crosshair with value and time.
- **One palette:** black, hairlines and blue aura light everywhere. Green and red only ever mean up and down.
- **Type:** Inter (variable, with optical sizing) and Geist Mono for numbers, both served locally under the SIL OFL (`fonts/LICENSE-*.txt`).
- **Accessibility:** everything respects `prefers-reduced-motion`. Light theme is available from the wallet panel.

## Files

| File | Role |
|---|---|
| `index.html`, `landing.css`, `landing.js` | Landing page + live markets feed |
| `terminal.html`, `app.js` | Betting terminal (bet list, wizard, wallet, leaderboard), driven by the bet book API |
| `proof.html`, `proof.js` | Proof page: live checks, settlement ledger, limits, source links |
| `book.mjs` | The shared bet book: players, bets, balances, ledger, settlement loop (SQLite) |
| `styles.css` | Design system, charts, motion |
| `fx.js` | 3D cube, WebGL aura, spotlight, mega menu, chart hover, reveals |
| `art.js` | Drawn UI: token logos, avatars, sparklines, charts, glyphs |
| `data.js` | Browser client for the data API |
| `market.mjs` | Server-side Solana RPC / DexScreener / GeckoTerminal client with caching |
| `server.mjs` | Dependency-free server: pages, `/api/*`, sessions, gzip, caching, CSP, `/healthz` |
| `config.js` | Featured coins, durations, stake limits, copy |
| `.railway/railway.ts` | Railway infrastructure and env vars |

### Data API

| Route | Returns |
|---|---|
| `/api/token/:mint` | On-chain verification + live market data |
| `/api/tokens?mints=a,b` | Batch live market data |
| `/api/trending` | Trending Solana tokens |
| `/api/chart/:mint?tf=1h\|1d\|1w\|1m` | Market-cap history |
| `/api/cap-at/:mint?t=<unix>` | Market cap at a past moment (settlement), with the pool and candle used |

### Bet book API

Players are anonymous: `POST /api/session` sets an HttpOnly `cubet_sid` cookie (only its SHA-256 is stored). POSTs must be JSON from the same origin.

| Route | Does |
|---|---|
| `GET /api/me` · `POST /api/session` | This browser's player (`handle`, demo `balance`) |
| `POST /api/funds` `{mode, amount}` | Demo deposit (daily limit) or withdrawal |
| `GET /api/book` | Open and in-play bets for everyone, your finished bets, recent settlements, stats |
| `POST /api/bets` `{mint, dir, target, duration, stake}` | Create a bet. The server re-checks the token and the target against the live cap |
| `POST /api/bets/:id/take` · `/cancel` | Take the other side (open until a quarter of the time is left) or cancel your open bet |
| `GET /api/leaderboard` · `/api/settlements` · `/api/stats` | Rankings by demo P/L, settlement records, book totals |

### Terminal deep links

`/terminal#create` · `#mine` · `#leaderboard` · `/terminal?coin=<mint>&dir=above&target=8000000&duration=7%20days&stake=0.5` (opens step 2 prefilled)
