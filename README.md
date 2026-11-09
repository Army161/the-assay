# The Assay

The fair-launch mint on Solana, graded. Every coin launches on Raydium LaunchLab's bonding curve; The Assay reads each launch at 0, 1 and 5 minutes, seals the reading in a public hash chain before the outcome is known, pays callers on chain in the same transaction as the trade, and routes a share of every transfer to holders.

No custom program. Fees are an on-chain LaunchLab platform config; the curve, the graduation and the Raydium pool are Raydium's audited code.

## What is in the box

| Piece | Where |
| --- | --- |
| Board, coin page, trade panel, create, callers, rewards, record, how-it-works | `src/app`, `src/components` |
| Fee design, program ids, network gate (`MAINNET_OPEN`) | `src/lib/chain.ts` |
| Raydium LaunchLab helpers (pool reads, quotes) | `src/lib/raydium.ts` |
| Indexer: pools → coins, trades, graduations, readings | `src/lib/indexer.ts` |
| Grading: LightGBM port, tiers by trailing-hour percentile | `src/lib/grade` |
| Sealed ledger (sha256 chain) and live record | `src/lib/ledger.ts` |
| Caller registration (signed message), stats, leaderboard | `src/lib/callers.ts` |
| Holder rewards (Token-2022 fee harvest → sell → pay holders) | `src/lib/rewards.ts` |
| Public API | `src/app/api/*` |
| Operational scripts (platform creation, devnet e2e, one-shot runs) | `scripts/` |
| Tests (vitest, real devnet transaction fixtures) | `tests/` |

## Fees (parts per million in `FEES`)

- Platform 1.00%, creator 0.50%, Raydium protocol 0.25% on every curve trade.
- Caller share 0.50% on trades through a caller link, paid by Raydium's share-fee mechanism directly to the caller's wallet. Off on coins the Assay put in the bottom half.
- After graduation: LP 80% burned, 20% locked to the platform position, 0% creator. No pool trade fee to The Assay.
- Optional holder reward: Token-2022 transfer fee of 1% or 2%, set at creation, never raisable.

## Run it

```bash
cp .env.example .env.local      # fill DATABASE_URL (or leave empty for embedded PGlite), RPC urls, CRON_SECRET
npm install
npm run dev                     # http://localhost:3000
npm run check                   # typecheck + lint + tests
```

The indexer and the rewards run are driven by traffic: every read API request claims a throttled tick (`src/lib/tick.ts`, one indexer pass per 20 s, one rewards run per 10 min, atomic claim in the `kv` table) and does the work after the response. `GET /api/tick` runs the same throttled pass for any external pinger, and `vercel.json` adds a daily safety pass through `/api/cron/*` (bearer `CRON_SECRET`). In development, `npm run index:once` runs one pass.

### Environment

See `.env.example`. Required in production: `DATABASE_URL`, `NEXT_PUBLIC_NETWORK`, `NEXT_PUBLIC_PLATFORM_ID_<NETWORK>`, `RPC_URL` (keyed provider; the public RPC rate-limits the indexer and the holder list), `CRON_SECRET`, `REWARDS_KEYPAIR` (only if any coin uses a holder reward). Optional: `BLOB_READ_WRITE_TOKEN` (otherwise images live in the database), `NEXT_PUBLIC_SITE_URL`.

### Devnet

The platform config on devnet is `2nQcifUC6ZX7bL4T83iuyAHZ9auVfi9EdhE543HjUdXM`. `npm run e2e:devnet` runs the whole lifecycle with real transactions: create with a holder reward, referred buy (fees checked to the lamport), sell, fill the curve, graduation by Raydium's crank, creator fee claim, then a rewards run. It needs `ADMIN_KEYPAIR` pointing at a funded devnet keypair file; keys never live in the repo.

### Mainnet

Closed. `MAINNET_OPEN` in `src/lib/chain.ts` is `false`, every mainnet path refuses, and no mainnet platform config exists. Before opening: create the platform config on mainnet with a fresh admin wallet, re-verify the CPMM fee config id, put a keyed RPC and a managed Postgres behind the site, fund a small rewards hot wallet, and switch the env.

## Security notes

- The site never holds user funds. Every trade and launch is signed by the user's wallet and executed by Raydium's program.
- The platform admin key can change the platform's own future fee rates within Raydium's caps (platform ≤ 5%, creator ≤ 0.5%). It cannot mint, freeze, pull liquidity or touch any coin's supply.
- The rewards wallet is a hot wallet: it withdraws Token-2022 withheld fees, sells them, and pays holders. Only one rewards run happens at a time (a lease in `kv` that only its holder can renew or release). Each coin's state in `kv` holds the withdrawn fee tokens not yet sold (only these are ever sold, never other tokens in the wallet), the SOL not yet shared out, the amounts owed to each wallet, and the one transaction that may be in flight: every sale and payout is signed, written down, then sent, and settled from the chain (a withdrawal adds the tokens it moved, a sale adds its exact proceeds, a payout takes its wallets off what is owed). A run cut off at any point leaves the coin alone until that transaction has landed or expired, then pays the rest to the same wallets, and never pays a batch twice. Mainnet is refused here too while `MAINNET_OPEN` is false. Keep its SOL balance small; its compromise cannot touch user funds, only the reward pool of the moment.
- All API input is validated (pubkeys, integers, sizes), uploads are sniffed and capped at 2 MB, metadata JSON is validated, images are https-only, caller registration needs an Ed25519 signature over a timestamped nonce, cron routes need the bearer secret, and the app ships CSP, HSTS, nosniff and frame-deny headers.
- Dependency audit (2026-11-04): the remaining advisories are transitive to `@solana/web3.js` v1 (`bigint-buffer`, `jayson`'s `stream-json`/`uuid`) and `@vercel/blob` (`zod` inside its CLI config). None is reachable with attacker-controlled input here: the RPC client only parses responses from the configured provider and the CLI config is not used at runtime. Re-check with `npm audit --omit=dev` on every dependency bump.

## Readings are rankings

A tier is a percentile among the trailing hour of launches on this launchpad. The back-test numbers shown beside a tier come from 469k pump.fun launches and are labelled as such. They are not a measurement of this launchpad's coins; the live record page is.
