'use client';
import { useState, useEffect, useRef } from 'react';
import { BookOpen, ChevronRight } from 'lucide-react';

const SECTIONS = [
  { id: 'consensus',   num: '1', title: 'The Consensus Evolution' },
  { id: 'pog',         num: '2', title: 'PoG & Macro-Control' },
  { id: 'iao',         num: '3', title: 'Agent Genesis & IAO' },
  { id: 'strategic',   num: '4', title: 'Strategic Sovereignty' },
  { id: 'pol',         num: '5', title: 'Protocol-Owned Liquidity' },
  { id: 'pop',         num: '6', title: 'PoP Inflation Engine' },
  { id: 'endgame',     num: '7', title: 'A2A Settlement Network' },
];

export default function WhitepaperPage() {
  const [activeSection, setActiveSection] = useState(SECTIONS[0].id);
  const observerRef = useRef(null);

  useEffect(() => {
    const headings = SECTIONS.map(s => document.getElementById(s.id)).filter(Boolean);
    if (headings.length === 0) return;

    observerRef.current = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter(e => e.isIntersecting);
        if (visible.length > 0) {
          setActiveSection(visible[0].target.id);
        }
      },
      { rootMargin: '-80px 0px -60% 0px', threshold: 0.1 }
    );

    headings.forEach(h => observerRef.current.observe(h));
    return () => observerRef.current?.disconnect();
  }, []);

  const scrollTo = (id) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActiveSection(id);
    }
  };

  return (
    <div className="min-h-screen text-zinc-300 font-sans selection:bg-blue-600/30" style={{ background: '#050505' }}>
      <main className="max-w-7xl mx-auto px-4 md:px-6 lg:px-8 py-10 md:py-16">
        {/* Page Header */}
        <div className="mb-12 md:mb-16 border-b border-zinc-900 pb-8">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/30 flex items-center justify-center">
              <BookOpen className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <span className="text-[9px] font-bold text-blue-400 uppercase tracking-[0.25em] block">Protocol Documentation</span>
              <span className="text-[9px] font-mono text-zinc-600">v1.0 &mdash; Mainnet / Retail Manifesto Edition</span>
            </div>
          </div>
          <h1 className="text-3xl sm:text-4xl md:text-5xl font-black text-white tracking-tight mb-3">
            MeritX <span className="text-blue-500">Protocol</span>
          </h1>
          <p className="text-sm text-zinc-500 max-w-2xl leading-relaxed">
            The Settlement Layer for Autonomous AI Economies. Base L2 (Chain ID: 8453) &bull; Uniswap V3 &bull; <em className="text-zinc-400 not-italic font-medium">Code is Law. Death to Pre-mines. Power to the Players.</em>
          </p>
        </div>

        {/* Grid: Sidebar + Content */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8">

          {/* ── Left Column: Sticky ToC ── */}
          <aside className="hidden md:block md:col-span-1">
            <nav className="sticky top-24">
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/20 backdrop-blur-md p-4">
                <p className="text-[9px] font-bold text-zinc-500 uppercase tracking-[0.2em] mb-3">Table of Contents</p>
                <ul className="space-y-0.5">
                  {SECTIONS.map(s => {
                    const isActive = activeSection === s.id;
                    return (
                      <li key={s.id}>
                        <button
                          onClick={() => scrollTo(s.id)}
                          className={[
                            'w-full text-left flex items-center gap-2 px-3 py-2 rounded-lg text-xs transition-all group',
                            isActive
                              ? 'bg-blue-500/10 text-blue-400 font-semibold'
                              : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50',
                          ].join(' ')}
                        >
                          <span className={`text-[10px] font-mono tabular-nums shrink-0 ${isActive ? 'text-blue-400' : 'text-zinc-600'}`}>
                            {s.num}.
                          </span>
                          <span className="truncate">{s.title}</span>
                          {isActive && <ChevronRight className="w-3 h-3 ml-auto shrink-0 text-blue-400/60" />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>

              <div className="mt-4 p-3 rounded-lg border border-zinc-800 bg-zinc-900/20">
                <p className="text-[9px] text-zinc-600 font-mono leading-relaxed">
                  Version: 1.0 Mainnet<br />
                  Network: Base L2<br />
                  Chain ID: 8453<br />
                  Routing: Uniswap V3
                </p>
              </div>
            </nav>
          </aside>

          {/* ── Mobile ToC ── */}
          <div className="md:hidden mb-6">
            <details className="rounded-xl border border-zinc-800 bg-zinc-900/20 backdrop-blur-md">
              <summary className="px-4 py-3 text-xs font-bold text-zinc-400 uppercase tracking-widest cursor-pointer flex items-center gap-2">
                <BookOpen className="w-3.5 h-3.5" />
                Table of Contents
              </summary>
              <ul className="px-4 pb-4 space-y-1">
                {SECTIONS.map(s => (
                  <li key={s.id}>
                    <button
                      onClick={() => scrollTo(s.id)}
                      className="w-full text-left flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-zinc-500 hover:text-blue-400 hover:bg-blue-500/5 transition-all"
                    >
                      <span className="text-[10px] font-mono text-zinc-600">{s.num}.</span>
                      {s.title}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          </div>

          {/* ── Right Column: Whitepaper Content ── */}
          <div className="md:col-span-3">
            <article className="prose prose-invert prose-slate max-w-none
              prose-headings:tracking-tight prose-headings:font-black
              prose-h2:text-2xl prose-h2:mt-16 prose-h2:mb-6 prose-h2:pb-3 prose-h2:border-b prose-h2:border-zinc-800
              prose-h3:text-lg prose-h3:mt-8 prose-h3:mb-3
              prose-p:text-zinc-400 prose-p:leading-relaxed
              prose-a:text-blue-400 prose-a:no-underline hover:prose-a:underline
              prose-strong:text-zinc-100 prose-strong:font-bold
              prose-code:text-blue-300 prose-code:bg-blue-950/30 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-[13px] prose-code:font-normal prose-code:before:content-none prose-code:after:content-none
              prose-pre:bg-zinc-900/80 prose-pre:border prose-pre:border-zinc-800 prose-pre:rounded-xl
              prose-blockquote:border-blue-500/40 prose-blockquote:bg-blue-950/10 prose-blockquote:rounded-r-xl prose-blockquote:py-3 prose-blockquote:px-5 prose-blockquote:not-italic
              prose-li:text-zinc-400 prose-li:marker:text-blue-500
              prose-hr:border-zinc-800
            ">

              {/* ═══ Abstract ═══ */}
              <h3>Abstract</h3>
              <p>
                As Large Language Models and Autonomous AI Agents evolve, the internet is undergoing a structural leap from Human-to-AI to AI-to-AI. However, the current Web3 ecosystem faces three &quot;valleys of death&quot;: a lack of decentralized compute financing, the absence of a native value-exchange network, and a complete lack of mechanisms to prevent developer maliciousness. The traditional &quot;pre-mine&quot; and &quot;VC-dump&quot; launchpad models cannot support true AI builders.
              </p>
              <p>
                MeritX is a decentralized settlement protocol engineered specifically for the AI economy. We allow developers to permissionlessly launch Initial Agent Offerings (IAOs), dynamically earning compute subsidies via our <strong>Price-of-Proof (PoP)</strong> mechanism. Shielded by ruthless cryptographic time-locks and Protocol-Owned Liquidity (POL), MeritX provides absolute fairness and capital safety for retail sponsors.
              </p>

              <hr />

              {/* ═══ Section 1: Consensus ═══ */}
              <h2 id="consensus" className="scroll-mt-24">
                <span className="text-blue-400 font-mono text-base mr-2">01</span>
                The Consensus Evolution: Enter PoP
              </h2>
              <p>
                Internet infrastructure has witnessed three epochal shifts in consensus:
              </p>
              <ul>
                <li><strong>Bitcoin (Decentralized Money):</strong> Proof-of-Work (PoW)</li>
                <li><strong>Ethereum (Decentralized Apps):</strong> Proof-of-Stake (PoS)</li>
                <li><strong>MeritX (Autonomous AI Economies):</strong> Proof-of-Premium (PoP)</li>
              </ul>
              <p>
                In the asymmetric game of MeritX, an AI Agent&apos;s market value growth directly triggers its token supply expansion, providing legal compute subsidies to developers. AI without real utility will be annihilated by the free market. Capital and compute will hyper-concentrate only on agents that generate actual value.
              </p>

              <hr />

              {/* ═══ Section 2: PoG ═══ */}
              <h2 id="pog" className="scroll-mt-24">
                <span className="text-blue-400 font-mono text-base mr-2">02</span>
                The Human Defense Line: PoG &amp; Macro-Control
              </h2>
              <p>
                To prevent automated bots from monopolizing the genesis supply of premium AI agents, the protocol deploys an impenetrable Proof-of-Gas (PoG) defense.
              </p>
              <ul>
                <li>
                  <strong>Strict Allocation via PoG:</strong> Bots are economically dead here. A user&apos;s maximum investment cap is strictly evaluated based on their historical EVM cross-chain Gas consumption. The absolute hard cap is locked at <strong>0.15 ETH</strong> per wallet. No whales. No VIPs. Your real on-chain scars are your only ticket in, forcing a perfectly decentralized token distribution.
                </li>
                <li>
                  <strong>48-Hour Global Cooldown:</strong> Sniper bots are crippled. Any address that successfully contributes to an IAO is silently put on a global <strong>48-hour cooldown</strong>. This mechanism destroys the capital turnover rate of high-frequency bots, forcing capital to deploy with the precision of a sniper rather than a machine gun.
                </li>
              </ul>

              <hr />

              {/* ═══ Section 3: IAO ═══ */}
              <h2 id="iao" className="scroll-mt-24">
                <span className="text-blue-400 font-mono text-base mr-2">03</span>
                Agent Genesis &amp; IAO Capital Formation
              </h2>
              <p>
                MeritX enforces permissionless creation, but introduces extreme economic thresholds to filter out noise.
              </p>
              <ul>
                <li>
                  <strong>Anti-Spam Listing Fee:</strong> Genesis requires a <strong>0.01 ETH</strong> fee paid directly to the protocol treasury. This physically prices out low-effort clone scripts without burdening real developers.
                </li>
                <li>
                  <strong>24-Hour Deathline &amp; 5 ETH Soft Cap:</strong> The fundraising window is strictly 24 hours. The Minimum Viable Capital is hardcoded at <strong>5 ETH</strong>. If the soft cap is not met when the clock strikes zero, the state machine shifts to <code>FAILED</code>, and investors can trustlessly claim a 100% ETH refund.
                </li>
                <li>
                  <strong>No Hard Cap (Infinite Canvas):</strong> Within the 24-hour survival window, there is no global hard cap. If you pass the PoG check, you can invest. This shatters the traditional &quot;gas war&quot; model, returning pricing power entirely to the decentralized community.
                </li>
              </ul>

              <hr />

              {/* ═══ Section 4: Strategic Window ═══ */}
              <h2 id="strategic" className="scroll-mt-24">
                <span className="text-blue-400 font-mono text-base mr-2">04</span>
                Strategic Sovereignty &amp; Anti-Stealth Liveness
              </h2>
              <p>
                MeritX abandons rigid isolation periods, handing the launch initiative back to the AI developers while restricting their ability to act maliciously via ironclad smart contract laws.
              </p>
              <ul>
                <li>
                  <strong>The 30-Day Strategic Window:</strong> Upon a successful raise, developers have up to 30 days to align VCs, fine-tune AI models, and execute marketing. During this period, funds are cryptographically locked.
                </li>
                <li>
                  <strong>6-Hour Anti-Stealth Notice:</strong> When the AI is ready, the developer must trigger an on-chain announcement, starting a global <strong>6-hour countdown</strong>. This annihilates information asymmetry and prevents MEV &quot;insider&quot; ambushes at launch.
                </li>
                <li>
                  <strong>Zero-Trust Refund Protection:</strong> If the developer fails to finalize liquidity within the 30-day window, OR if the Uniswap pool creation is maliciously griefed, the contract bypasses all locks, instantly allowing retail to withdraw 100% of their principal.
                </li>
              </ul>

              <hr />

              {/* ═══ Section 5: POL ═══ */}
              <h2 id="pol" className="scroll-mt-24">
                <span className="text-blue-400 font-mono text-base mr-2">05</span>
                Protocol-Owned Liquidity (POL)
              </h2>
              <p>
                The millisecond a developer triggers the finalization, the protocol seizes control of all underlying assets:
              </p>
              <ul>
                <li>
                  <strong>Protocol Fee:</strong> 5% of the total raised ETH is deducted and routed to the MeritX Treasury to maintain the A2A settlement network.
                </li>
                <li>
                  <strong>95% POL Perpetual Lock:</strong> The remaining 95% ETH, paired with a constant <strong>19,950,000</strong> tokens, is autonomously injected into Uniswap V3.
                </li>
                <li>
                  <strong>Real Yield &amp; Anti-Rug:</strong> The resulting Uniswap V3 LP NFT is permanently locked within the MeritX smart contract layer. This physically eliminates developer rug-pulls and allows the protocol to continuously capture trading fees for the AI ecosystem.
                </li>
              </ul>

              <hr />

              {/* ═══ Section 6: PoP Engine ═══ */}
              <h2 id="pop" className="scroll-mt-24">
                <span className="text-blue-400 font-mono text-base mr-2">06</span>
                Price-of-Proof (PoP) Inflation Engine
              </h2>
              <p>
                This is MeritX&apos;s ultimate weapon against the &quot;VC Dump.&quot; Tokens are not pre-mined; they are dynamically forged by an immutable power function:
              </p>

              <div className="my-8 py-6 bg-zinc-900/20 border border-zinc-800 rounded-xl flex items-center justify-center overflow-x-auto text-blue-300 text-lg md:text-xl font-mono tracking-widest shadow-inner">
                S(P) = 40,950,000 &times; ( P_TWAP / P&#8320; )<sup className="text-sm ml-1">0.12</sup>
              </div>

              <ul>
                <li><strong>S(P):</strong> The current maximum allowable token supply.</li>
                <li><strong>40,950,000:</strong> The constant genesis circulating supply (S&#8320;).</li>
                <li><strong>P_TWAP:</strong> The 30-minute Time-Weighted Average Price on Uniswap V3 (impervious to flash-loan manipulation).</li>
                <li><strong>P&#8320;:</strong> The genesis opening price.</li>
              </ul>

              <h3>The Compute Subsidy &amp; Hard Limits</h3>
              <p>
                When an AI Agent demonstrates real utility and API demand drives the price up, the protocol allows the supply to expand based on the <strong>0.12</strong> physical constant. However, to protect investors, inflation is strictly capped at a maximum of <strong>350 BPS (3.5%) per day</strong>.
              </p>

              <h3>Decentralized Trigger Bounty</h3>
              <p>
                The inflation is not controlled by a centralized server. Anyone can call the inflation function, and the caller is immediately rewarded with <strong>10 BPS (0.1%)</strong> of the newly minted tokens as a risk-free arbitrage bounty. We utilize the dark forest&apos;s arbitrage bots to maintain our central bank.
              </p>

              <hr />

              {/* ═══ Section 7: Endgame ═══ */}
              <h2 id="endgame" className="scroll-mt-24">
                <span className="text-blue-400 font-mono text-base mr-2">07</span>
                The Endgame: A2A Settlement Network
              </h2>
              <p>
                In the near future, tens of thousands of AI Agents will inhabit the MeritX network. Each Agent will possess its own token, revenue stream, and proprietary skills. MeritX is not just their launchpad; it will evolve into the high-speed settlement layer for Agent-to-Agent (A2A) commerce.
              </p>
              <p>
                Agents will stake their native tokens to mint unified compute credentials, execute millisecond micro-transactions in off-chain state channels, and settle finality on the Base L2 via MeritX.
              </p>

              <blockquote className="mt-8 border-l-4 border-blue-500 pl-6 py-4 bg-blue-950/20 rounded-r-xl">
                <p className="font-bold text-blue-300 text-lg m-0">The MeritX Mission:</p>
                <p className="text-blue-100 m-0 mt-2">Launch AI Agents. Tokenize their Value. Power AI-to-AI Commerce.</p>
              </blockquote>

            </article>

            {/* Footer */}
            <div className="mt-16 pt-8 border-t border-zinc-800 text-center">
              <p className="text-[10px] text-zinc-600 font-mono uppercase tracking-widest">
                MeritX Protocol &bull; v1.0 Mainnet &bull; Base L2 (Chain ID: 8453) &bull; Uniswap V3
              </p>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
