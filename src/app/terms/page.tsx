import type { Metadata } from "next";

export const metadata: Metadata = { title: "Terms, risks and privacy", description: "The rules for using The Assay, the risks of trading memecoins, and what data the site keeps." };

const UPDATED = "12 November 2026";

export default function Terms() {
  return (
    <div className="pt-6 max-w-3xl mx-auto space-y-6">
      <section className="card p-6 sm:p-8">
        <div className="eyebrow mb-2">Terms, risks and privacy</div>
        <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight">Read this before you trade.</h1>
        <p className="text-text-2 mt-3">By using this site you agree to these terms. If you do not agree, do not use it. Last updated {UPDATED}.</p>
        <nav className="mt-4 flex flex-wrap gap-2 text-sm">{[["#risk", "Risk"], ["#service", "The service"], ["#eligibility", "Who may use it"], ["#conduct", "Rules"], ["#grades", "Grades"], ["#callers", "Callers"], ["#privacy", "Privacy"], ["#liability", "Liability"]].map(([h, l]) => <a key={h} href={h} className="chip chip-muted hover:text-text">{l}</a>)}</nav>
      </section>

      <Section id="risk" title="Risk: you can lose everything" lead="Memecoins are speculative. Most of them go to zero, often within minutes.">
        <ul className="text-sm text-text-2 space-y-2 list-disc pl-5">
          <li>Only trade money you can afford to lose in full. Prices on a bonding curve and in a new pool move violently, and a coin can lose almost all of its value in one block.</li>
          <li>Anyone can launch a coin here. A coin&apos;s name, image, description or links say nothing about who made it or whether it has any value. Creators and early buyers can sell at any time.</li>
          <li>Transactions on Solana are final. A trade sent from your wallet cannot be reversed by us or by anyone else. Check every amount before you sign.</li>
          <li>The programs that hold funds are Raydium&apos;s, not ours. Smart contracts, wallets, RPC providers and the Solana network can fail, be exploited or halt.</li>
          <li>Nothing on this site is investment, financial, legal or tax advice. You are responsible for any taxes on your trades and rewards.</li>
        </ul>
      </Section>

      <Section id="service" title="What the service is" lead="The Assay is a website that builds Solana transactions for you to sign in your own wallet.">
        <ul className="text-sm text-text-2 space-y-2 list-disc pl-5">
          <li>We never hold your funds or your keys. Every launch, trade and claim is a transaction your wallet signs and sends to Raydium LaunchLab.</li>
          <li>The site, the indexer, the grades and the rewards runs are provided as they are, without warranties of any kind. They may be slow, wrong, incomplete or offline.</li>
          <li>We may change, pause or stop the site, or any part of it, at any time. Coins and pools on chain keep working without the site.</li>
          <li>We may hide a coin, its image or its description from this site, for example for illegal content, impersonation or abuse. Hiding a coin here does not change it on chain.</li>
        </ul>
      </Section>

      <Section id="eligibility" title="Who may use it" lead="You must be at least 18 and allowed to use a service like this where you live.">
        <ul className="text-sm text-text-2 space-y-2 list-disc pl-5">
          <li>Do not use the site if you are a resident of, or located in, a country or region under comprehensive sanctions (including Cuba, Iran, North Korea, Syria and the Russian-occupied regions of Ukraine), or if you are on a sanctions list.</li>
          <li>Do not use the site where trading or launching tokens like these is against the law. It is your job to know the rules where you are.</li>
        </ul>
      </Section>

      <Section id="conduct" title="Rules for creators and traders" lead="Breaking these may get a coin hidden from the site.">
        <ul className="text-sm text-text-2 space-y-2 list-disc pl-5">
          <li>Do not launch a coin that impersonates a real person, company or project, or that claims an endorsement it does not have.</li>
          <li>Do not upload content that is illegal, sexualises minors, infringes someone else&apos;s rights, or harasses anyone.</li>
          <li>Do not promise returns, run coordinated pump schemes, wash trade, or use the site to launder money.</li>
          <li>Do not attack the site, flood it with requests, or try to get around its limits.</li>
        </ul>
      </Section>

      <Section id="grades" title="Grades are rankings, not advice" lead="A grade compares one launch with other recent launches. It is not a prediction and not a recommendation.">
        <p className="text-sm text-text-2">Grades are made by a model from early trading data. A high grade can fall to zero; a low grade can run. Each grade is sealed into a public, hash-chained record when it is made, so you can check that it was not changed afterwards, but that says nothing about whether it was right.</p>
      </Section>

      <Section id="callers" title="Callers" lead="Callers share links and earn a share of trading fees on trades made through them.">
        <ul className="text-sm text-text-2 space-y-2 list-disc pl-5">
          <li>A caller is not our employee or agent and does not speak for The Assay. Treat any call as one person&apos;s opinion.</li>
          <li>Callers must say plainly that they are paid on trades through their link, and must follow the advertising and disclosure rules where they and their audience are.</li>
          <li>Caller pay is set by the on-chain trade instruction and may change for future trades. We may stop showing a caller&apos;s links for abuse.</li>
        </ul>
      </Section>

      <Section id="privacy" title="Privacy" lead="We keep as little as we can. There are no accounts, emails or tracking cookies.">
        <ul className="text-sm text-text-2 space-y-2 list-disc pl-5">
          <li>Wallet addresses, trades and coin details are public on Solana. The site indexes and shows them, including on caller and rewards pages.</li>
          <li>Images and descriptions you upload for a coin are public and may stay public on chain after the site hides them.</li>
          <li>Our hosting provider keeps short-lived server logs, including IP addresses, to run the site and stop abuse. We use IP addresses for rate limits and do not sell or share them.</li>
          <li>Your wallet and your RPC provider may collect their own data under their own terms.</li>
        </ul>
      </Section>

      <Section id="liability" title="Liability" lead="To the fullest extent the law allows, we are not liable for your losses.">
        <p className="text-sm text-text-2">That includes losses from trading, from coins launched by others, from bugs or outages in the site, Raydium, Solana, wallets or RPC providers, and from anything a creator or caller says or does. Where the law does not allow this limit, our liability is limited to the smallest amount it allows. We may update these terms; the date at the top shows when they last changed, and using the site after a change means you accept it.</p>
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
