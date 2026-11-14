import type { Metadata } from "next";
import Link from "next/link";
import { FEES, LAUNCH, NETWORK, MAINNET_OPEN, LAUNCHLAB, PLATFORM_ID, pct, EXPLORER } from "@/lib/chain";
import { CHECKPOINT_LABEL, TIERS } from "@/lib/grade/assay";

export const metadata: Metadata = { title: "How it works", description: "Fees, graduation, the Assay grade, caller pay and holder rewards, each one a program rule you can read on chain." };

const tradeFee = (FEES.platformFeeRate + FEES.creatorFeeRate + FEES.protocolFeeRate) / 10_000;

export default function HowItWorks() {
  const platform = PLATFORM_ID[NETWORK];
  return (
    <div className="pt-6 max-w-3xl mx-auto space-y-6">
      <section className="card p-6 sm:p-8">
        <div className="eyebrow mb-2">How it works</div>
        <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight">Every fee is a program rule. Every grade is sealed. Nothing here is a promise.</h1>
        <p className="text-text-2 mt-3">The Assay runs on Raydium LaunchLab, the bonding-curve program that powers most of Solana&apos;s launchpads. We did not write a token program. Our fee rules live in one on-chain platform config that anyone can read, and the curve, the graduation and the Raydium pool are Raydium&apos;s own audited code.</p>
        <nav className="mt-4 flex flex-wrap gap-2 text-sm">{[["#fees", "Fees"], ["#curve", "The curve"], ["#grade", "The grade"], ["#callers", "Callers"], ["#rewards", "Holder rewards"], ["#creators", "Creators"], ["#safety", "Safety"], ["#network", "Network"]].map(([h, l]) => <a key={h} href={h} className="chip chip-muted hover:text-text">{l}</a>)}</nav>
      </section>

      <Section id="fees" title="Fees on every curve trade" lead={`${tradeFee.toFixed(2)}% of each buy and sell on the curve, split three ways inside the same transaction.`}>
        <table className="table"><tbody>
          <tr><td>Platform</td><td className="num text-right">{pct(FEES.platformFeeRate)}</td><td className="text-text-2">Runs the site, the indexer, the grading and the rewards runs.</td></tr>
          <tr><td>Creator</td><td className="num text-right">{pct(FEES.creatorFeeRate)}</td><td className="text-text-2">Paid to the wallet that launched the coin, claimable any time, while the coin is on the curve.</td></tr>
          <tr><td>Raydium</td><td className="num text-right">{pct(FEES.protocolFeeRate)}</td><td className="text-text-2">Raydium&apos;s protocol fee on LaunchLab.</td></tr>
          <tr><td>Caller, when a link was used</td><td className="num text-right">+{pct(FEES.callerShareRate)}</td><td className="text-text-2">Only on trades that came through a caller link, and only on coins outside the bottom half. Paid on chain in the trade itself.</td></tr>
        </tbody></table>
        <p className="kicker mt-3">After graduation, trades happen on Raydium&apos;s CPMM pool, which charges Raydium&apos;s own swap fee (0.25% on mainnet, plus Raydium&apos;s small pool-creator fee where it applies). The Assay charges nothing on pool trades, but the 20% of the pool&apos;s liquidity locked to the platform earns its share of the pool&apos;s liquidity fees, like any liquidity provider.</p>
      </Section>

      <Section id="curve" title="The curve and graduation" lead={`Every coin starts with ${LAUNCH.supply.toLocaleString()} tokens. ${LAUNCH.totalSellA.toLocaleString()} are sold on a constant-product curve until ${LAUNCH.totalFundRaisingSol} SOL has been raised.`}>
        <ul className="text-sm text-text-2 space-y-2 list-disc pl-5">
          <li>The price is set by the curve alone. There is no presale, no team allocation and no way for a creator to mint more.</li>
          <li>When the curve is full, Raydium migrates the raised SOL and the remaining tokens into a Raydium CPMM pool. This takes seconds and nobody at The Assay can stop or steer it.</li>
          <li>The pool&apos;s liquidity is split by a rule in the platform config: {FEES.lp.burnScale / 10_000}% burned, {FEES.lp.platformScale / 10_000}% locked in a position the platform cannot withdraw. Creators get {FEES.lp.creatorScale / 10_000}% of the LP. There is no key that can pull liquidity.</li>
          <li>The board marks a coin &ldquo;graduating&rdquo; between the last curve trade and the pool opening, and &ldquo;graduated&rdquo; once the pool is live.</li>
        </ul>
      </Section>

      <Section id="grade" title="The Assay grade" lead="Every launch is read three times: at launch, at one minute, and at five minutes. Each reading ranks the coin against every other launch in the trailing hour.">
        <ul className="text-sm text-text-2 space-y-2 list-disc pl-5">
          <li>The reading is a percentile, not a prediction. Tiers: {TIERS.map((t) => t.label).join(", ")}. &ldquo;Top 10%&rdquo; means the model scored this launch above 90% of the hour&apos;s launches.</li>
          <li>The models are gradient-boosted trees trained on 469k pump.fun launches. The inputs are things you can check: the creator&apos;s buy, the creator&apos;s history, copycat names, early buyers, wallet concentration, dev sells. Each checkpoint ({Object.values(CHECKPOINT_LABEL).join(", ").toLowerCase()}) uses only what was knowable at that moment.</li>
          <li>Every reading is added to a hash chain the instant it is made: each reading includes the hash of the one before, so changing a grade after the coin&apos;s fate is known breaks the chain check on the record. Rewriting every hash after it would pass that check but change the chain&apos;s head hash, which the record publishes, so anyone who kept an earlier head or a reading&apos;s hash can catch it. <Link href="/record" className="text-amber-2 hover:underline">The record</Link> shows the live graduation rate by tier and the chain check.</li>
          <li>The back-test odds shown next to a tier are pump.fun history. They are shown so you can see what carried over, not as a claim about this launchpad&apos;s coins.</li>
          <li>A coin the indexer could not read in time is marked &ldquo;not read&rdquo; and ranked below every coin that was read. A missing grade is never hidden.</li>
        </ul>
      </Section>

      <Section id="callers" title="Callers" lead={`Anyone with a wallet can register as a caller. Trades that come through your link pay you ${pct(FEES.callerShareRate)} of the trade, on chain, in the same transaction.`}>
        <ul className="text-sm text-text-2 space-y-2 list-disc pl-5">
          <li>Register by signing a message with your wallet. No sign-up, no email, no custody. Your code is derived from your wallet.</li>
          <li>The share is Raydium&apos;s share-fee mechanism: the trader&apos;s wallet sends it directly to yours. The Assay never touches it and cannot withhold it.</li>
          <li>Caller pay switches off on coins the Assay put in the bottom half at their latest reading. Calling junk does not pay. The leaderboard shows every caller&apos;s referred volume and the graduation rate of what they called.</li>
          <li><Link href="/callers" className="text-amber-2 hover:underline">Become a caller →</Link></li>
        </ul>
      </Section>

      <Section id="rewards" title="Holder rewards" lead={`A creator can launch with a transfer fee of ${FEES.holderRewardBps.filter(Boolean).map((b) => `${b / 100}%`).join(" or ")}, withheld inside the token on every transfer and paid to holders in SOL.`}>
        <ul className="text-sm text-text-2 space-y-2 list-disc pl-5">
          <li>The fee is a Token-2022 extension set at creation. While the coin is on the curve, the authority that could change it belongs to Raydium&apos;s LaunchLab program, not to The Assay. At graduation LaunchLab hands it to The Assay&apos;s rewards wallet, which gives it up for good on its next run, so the fee stays as launched. (Any Token-2022 fee change would also only take effect two epochs later, in public on chain.)</li>
          <li>The rewards wallet holds one other authority: collecting the withheld fees, which is how holders get paid. It never holds anyone&apos;s tokens beyond those fees, and never pool funds, platform fees or creator fees.</li>
          <li>About every ten minutes the rewards run collects the withheld tokens, sells them on the coin&apos;s own market, and pays the top 120 holders pro rata, excluding the curve, the pool and the platform. Each run is listed with its transactions.</li>
          <li>Because the fee applies to every transfer, buys and sells on a reward coin deliver slightly less than a plain coin. The trade panel shows what you receive after the fee.</li>
          <li><Link href="/rewards" className="text-amber-2 hover:underline">Every payout →</Link></li>
        </ul>
      </Section>

      <Section id="creators" title="For creators" lead={`Launching costs the network fee plus Raydium's pool-creation deposit, and nothing to The Assay. You earn ${pct(FEES.creatorFeeRate)} of every curve trade.`}>
        <ul className="text-sm text-text-2 space-y-2 list-disc pl-5">
          <li>Upload an image, pick a name and symbol, optionally add links and a holder reward. The image and metadata are stored at a public URL and the mint is created in one transaction you sign.</li>
          <li>Your creator fee accrues in a vault that only your wallet can claim from. Claim from the coin page whenever you like while the coin is on the curve.</li>
          <li>An optional first buy in the creation transaction lets you take a position before anyone else. The Assay shows it on the coin page as &ldquo;dev bought x%&rdquo; so traders see it, and a large one lowers your grade.</li>
          <li>Selling your own coin is visible to everyone and marks the coin &ldquo;dev sold&rdquo;. The grade is built to reward creators who stay.</li>
          <li><Link href="/create" className="text-amber-2 hover:underline">Launch a coin →</Link></li>
        </ul>
      </Section>

      <Section id="safety" title="Safety" lead="What we can and cannot do.">
        <ul className="text-sm text-text-2 space-y-2 list-disc pl-5">
          <li>The Assay never holds your funds. Every trade is signed by your wallet and settled by Raydium&apos;s program.</li>
          <li>Nobody can mint more tokens, freeze a wallet, change the curve or pull the pool. Those keys do not exist on a LaunchLab coin.</li>
          <li>The platform wallet can change the platform&apos;s own fee rates for future trades within Raydium&apos;s caps (platform fee at most 5%, creator fee at most 0.5%). It cannot touch an existing coin&apos;s supply, liquidity or holders.</li>
          <li>Memecoins are risky and most go to zero. A grade is a ranking among this hour&apos;s launches, not advice.</li>
        </ul>
      </Section>

      <Section id="network" title="Network" lead={NETWORK === "mainnet" ? "Running on Solana mainnet." : "Running on Solana devnet: test SOL, test coins, real program code."}>
        <table className="table"><tbody>
          <tr><td>Network</td><td className="num">{NETWORK}{NETWORK === "mainnet" && !MAINNET_OPEN ? " (trading closed until launch)" : ""}</td></tr>
          <tr><td>LaunchLab program</td><td className="font-mono text-xs break-all"><a className="hover:text-amber-2" href={EXPLORER(LAUNCHLAB[NETWORK].program.toBase58(), "address")} target="_blank" rel="noreferrer">{LAUNCHLAB[NETWORK].program.toBase58()}</a></td></tr>
          <tr><td>Platform config</td><td className="font-mono text-xs break-all">{platform ? <a className="hover:text-amber-2" href={EXPLORER(platform.toBase58(), "address")} target="_blank" rel="noreferrer">{platform.toBase58()}</a> : "not configured"}</td></tr>
          <tr><td>Graduation target</td><td className="num">{LAUNCH.totalFundRaisingSol} SOL</td></tr>
        </tbody></table>
        {NETWORK === "devnet" && <p className="kicker mt-3">Need devnet SOL? Use <a className="text-amber-2 hover:underline" href="https://faucet.solana.com" target="_blank" rel="noreferrer">faucet.solana.com</a> and set your wallet to devnet.</p>}
      </Section>
    </div>
  );
}

function Section({ id, title, lead, children }: { id: string; title: string; lead: string; children: React.ReactNode }) {
  return (
    <section id={id} className="card p-5 sm:p-6 scroll-mt-20">
      <h2 className="font-display text-xl font-bold">{title}</h2>
      <p className="text-text-2 mt-1 mb-3">{lead}</p>
      {children}
    </section>
  );
}
