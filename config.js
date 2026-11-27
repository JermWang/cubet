/* cubet: settings.
   Token names, logos, market caps and charts are live on-chain/market data fetched through /api.
   Bets, balances and settlement live in the shared bet book on the server (book.mjs); every player is real.
   Stakes are real SOL (payments.mjs). This file only decides which coins to feature, the copy, and defaults shown in the UI;
   the server enforces the real limits.
   Colours live at the top of styles.css; drawings live in art.js and fx.js. */
window.CUBET = {
  brand: {
    name: 'cubet',
    title: 'cubet — stack your call',
    tagline: 'Set a market-cap target, find someone who disagrees, and the winner takes the whole stack.',
    footer: 'cubet · live Solana market data · real SOL',
  },

  // The official cubet token. One place for the contract address: the splash page's copy button reads it,
  // and the TOKEN_CA environment variable overrides it on the server. Blank = the button shows "coming soon".
  token: {
    ca: '3NSUeHQXrcwqibJ78MDQ2YcXqL7pyP35b61MraQXpump',
  },

  currency: 'SOL',
  storageKey: 'cubet-v2',       // browser key for the theme preference only
  minStake: 0.01,               // stake limits shown in the UI (MIN_STAKE / MAX_STAKE, enforced on the server)
  maxStake: 10,
  defaultStake: 0.1,
  refreshSeconds: 20,           // how often live market caps refresh in the terminal

  // Bet lengths. `ms` is used for the countdown and to settle at the exact expiry time.
  durations: [
    { label: '15 min', ms: 15 * 60e3 },
    { label: '1 h', ms: 60 * 60e3 },
    { label: '6 h', ms: 6 * 3600e3 },
    { label: '1 day', ms: 86400e3 },
    { label: '3 days', ms: 3 * 86400e3 },
    { label: '7 days', ms: 7 * 86400e3 },
  ],

  motion: {
    boil: false,                // optional hand-drawn wobble on the hero scene
  },

  // Real Solana mints featured when the live "trending" feed is unavailable. Names, logos and caps load live.
  featured: [
    'GTBxUiw6wJdmmkCGZgRHLyYxqu1vG4KtRpeox6yDpump', // JEANPHIL
    '98kfF7rmsg1QDUEoCqNE7g7M1FdrTt92TEp2CLzypump', // PAID
    'A13oRB9FFaiUjfi6LdCg6p9ka1u8SfGkUFs4SKvPpump', // TOAD
    'CbyTNf7UPzvewHh4Zp6umogM2RWahhmGRJWLJnPwpump', // BIKE TYSON
  ],

};
