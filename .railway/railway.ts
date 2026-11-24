// Railway infrastructure for cubet: one web service.
//   Preview changes:  railway config plan
//   Apply them:       railway config apply
//   Ship new code:    railway up --service cubet
// Values here are committed to source, so only public settings live here. Secrets (your RPC URL,
// API keys) are set in the Railway dashboard and marked preserve() so applying never touches them.
import { defineRailway, project, service, preserve } from "railway/iac";

export const partial = "cubet";

export default defineRailway(() => {
  const web = service("cubet", {
    start: "node server.mjs",
    healthcheck: "/healthz",
    healthcheckTimeout: 60,
    env: {
      // Data providers. Plug these in from the Railway dashboard (Variables tab):
      //   SOLANA_RPC_URL     your Helius / QuickNode / Triton RPC URL (falls back to the public RPC)
      //   COINGECKO_API_KEY  optional, higher limits for charts and trending
      SOLANA_RPC_URL: preserve(),
      COINGECKO_API_KEY: preserve(),
      DATA_CACHE_SECONDS: "20",
      API_RATE_LIMIT: "120",

      // Server. PORT is injected by Railway. Don't set it.
      NODE_ENV: "production",
      HOST: "0.0.0.0",
      CACHE_MAX_AGE: "3600",
      // Canonical URL, share links and og:image. www.cubetsolana.xyz and cubetsolana.xyz are attached in Railway.
      PUBLIC_URL: "https://www.cubetsolana.xyz",
      // The shared bet book (SQLite) lives on the persistent volume "cubet-volume" mounted at /data.
      DB_PATH: "/data/cubet.db",

      // Branding
      APP_NAME: "cubet",
      APP_TITLE: "cubet — stack your call",
      APP_TAGLINE: "Set a market-cap target, find someone who disagrees, and the winner takes the whole stack.",
      APP_FOOTER: "cubet · live Solana market data · real SOL",

      // Token. The official contract address for the splash page's copy button. Fill it in on the
      // Railway dashboard at launch; blank shows "coming soon".
      TOKEN_CA: preserve(),

      // Real SOL. Secrets and money settings are filled in on the Railway dashboard and kept by preserve():
      //   TREASURY_SECRET_KEY  the treasury wallet's secret key (blank = payments off, no bets)
      //   FEE_WALLET           where fees are swept      FEE_BPS  fee on settled pots (200 = 2%)
      TREASURY_SECRET_KEY: preserve(),
      FEE_WALLET: preserve(),
      FEE_BPS: preserve(),
      PAYMENTS_RPC_URL: preserve(),
      SOLANA_CLUSTER: "mainnet-beta",
      FEE_SWEEP_MIN: "0.1",
      MIN_STAKE: "0.01",
      MAX_STAKE: preserve(),
      MIN_DEPOSIT: "0.01",
      MIN_WITHDRAW: "0.02",
      MAX_WITHDRAW_PER_DAY: preserve(),
      WITHDRAWALS_PAUSED: preserve(),
      MIN_LIQUIDITY_USD: "20000",

      // Display
      CURRENCY: "SOL",
      STORAGE_KEY: "cubet-v2",
      DEFAULT_STAKE: "0.1",

      // Art
      ART_BOIL: "false",
    },
  });

  return project("cubet", {
    resources: [web],
  });
});
