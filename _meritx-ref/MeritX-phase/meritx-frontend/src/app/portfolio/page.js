'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { ethers } from 'ethers';
import toast from 'react-hot-toast';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { FACTORY_ADDRESS, CHAIN_NAME } from '@/lib/constants';
import { useNetwork } from '@/lib/useNetwork';
import { useWallet } from '@/hooks/useWallet';
import { fmtEth, truncAddr } from '@/lib/fmt';
import { FACTORY_ABI, FUND_ABI, TOKEN_ABI } from '@/lib/abis';
import { getActiveProvider } from '@/lib/walletProvider';
import { getReadContract, getRpcProvider, getSignerContract, handleTxError } from '@/lib/web3';

const TX_WAIT_TIMEOUT_MS = 90_000;
const TX_TIMEOUT_MSG = 'Transaction is taking longer than expected. Check your wallet or block explorer for status.';
function waitWithTimeout(txPromise) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('TX_WAIT_TIMEOUT')), TX_WAIT_TIMEOUT_MS);
  });
  return Promise.race([txPromise, timeout]).finally(() => clearTimeout(timer));
}

const STATE_LABELS = {
  0: { text: 'FUNDING',    color: 'text-blue-400',    dot: 'bg-blue-500 animate-pulse', border: 'border-blue-500/20' },
  1: { text: 'FAILED',     color: 'text-red-400',     dot: 'bg-red-500',                border: 'border-red-500/20' },
  2: { text: 'PREPARING',  color: 'text-amber-400',   dot: 'bg-amber-500',              border: 'border-amber-500/20' },
  3: { text: 'DEX LIVE',   color: 'text-emerald-400', dot: 'bg-emerald-500',            border: 'border-emerald-500/20' },
};

export default function PortfolioPage() {
  const { account, connectWallet } = useWallet();
  const [projects, setProjects] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [actionAddr, setActionAddr] = useState(null);
  const mountedRef = useRef(true);

  useEffect(() => () => { mountedRef.current = false; }, []);

  const { isCorrectChain } = useNetwork();

  // ── Portfolio fetch (safe — never blocks page) ──
  const loadPortfolio = useCallback(async () => {
    if (!account || !getActiveProvider()) return;
    if (!FACTORY_ADDRESS) { setProjects([]); return; }
    setIsLoading(true);
    setError(null);
    try {
      const provider = getRpcProvider();
      const factory = getReadContract(FACTORY_ADDRESS, FACTORY_ABI);

      let addresses = [];
      try {
        const count = await factory.projectCount();
        const n = count.toNumber();
        addresses = n === 0 ? [] : await Promise.all(
          Array.from({ length: n }, (_, i) => factory.allDeployedProjects(i))
        );
      } catch {
        if (mountedRef.current) setProjects([]);
        return;
      }

      let launchWindowSec = 30 * 86400;
      let preLaunchNoticeSec = 21600;
      let launchExpirationSec = 86400;
      if (addresses.length > 0) {
        try {
          const probe = new ethers.Contract(addresses[0], FUND_ABI, provider);
          const [lw, pln, lex] = await Promise.all([
            probe.LAUNCH_WINDOW(),
            probe.PRE_LAUNCH_NOTICE().catch(() => ethers.BigNumber.from(process.env.NEXT_PUBLIC_PRE_LAUNCH_NOTICE || 21600)),
            probe.LAUNCH_EXPIRATION().catch(() => ethers.BigNumber.from(process.env.NEXT_PUBLIC_LAUNCH_EXPIRATION || 86400)),
          ]);
          launchWindowSec = Number(lw);
          preLaunchNoticeSec = Number(pln);
          launchExpirationSec = Number(lex);
        } catch {}
      }

      const results = await Promise.all(
        addresses.map(async (addr) => {
          try {
            const fund = new ethers.Contract(addr, FUND_ABI, provider);
            const [tokenAddr, owner, raised, softCap, endTime, state, contrib, finalized, announceTime] = await Promise.all([
              fund.projectToken(),
              fund.projectOwner(),
              fund.totalRaised(),
              fund.SOFT_CAP(),
              fund.raiseEndTime(),
              fund.currentState(),
              fund.contributions(account),
              fund.isFinalized().catch(() => false),
              fund.launchAnnouncementTime().catch(() => ethers.BigNumber.from(0)),
            ]);

            const contribEth = Number(ethers.utils.formatEther(contrib));
            const isOwner = owner.toLowerCase() === account.toLowerCase();
            if (contribEth <= 0 && !isOwner) return null;

            const token = new ethers.Contract(tokenAddr, TOKEN_ABI, provider);
            const [name, symbol] = await Promise.all([token.name(), token.symbol()]);

            const endSec = Number(endTime);
            const stateNum = Number(state);
            const raisedEth = Number(ethers.utils.formatEther(raised));
            const capEth = Number(ethers.utils.formatEther(softCap));
            const launchDeadlineMs = (endSec + launchWindowSec) * 1000;
            const isExpired = stateNum === 2 && Date.now() > launchDeadlineMs;
            const announceSec = Number(announceTime);
            const noticeEndMs = announceSec > 0 ? (announceSec + preLaunchNoticeSec) * 1000 : 0;
            const launchExpirationMs = announceSec > 0 ? (announceSec + preLaunchNoticeSec + launchExpirationSec) * 1000 : 0;
            const noticeHasElapsed = announceSec > 0 && Date.now() >= noticeEndMs;
            const isLaunchExpired = announceSec > 0 && noticeHasElapsed && launchExpirationMs > 0 && Date.now() > launchExpirationMs;

            return {
              address: addr, name, symbol,
              state: stateNum, contribution: contribEth,
              raised: raisedEth, softCap: capEth,
              progress: capEth > 0 ? Math.min((raisedEth / capEth) * 100, 100) : 0,
              isOwner, isFinalized: finalized, isExpired,
              launchDeadlineMs, isAnnounced: announceSec > 0,
              noticeElapsed: noticeHasElapsed, isLaunchExpired,
            };
          } catch { return null; }
        })
      );
      if (mountedRef.current) setProjects(results.filter(Boolean));
    } catch (err) {
      if (process.env.NODE_ENV !== 'production') console.error('Portfolio load failed:', err);
      if (mountedRef.current) setError('Failed to load agent data');
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, [account]);

  useEffect(() => { loadPortfolio(); }, [loadPortfolio]);

  // ── Transaction handlers ──
  const handleClaimTokens = async (addr) => {
    if (!isCorrectChain) return toast.error(`Wrong network — switch to ${CHAIN_NAME} first.`);
    setActionAddr(addr);
    try {
      const { contract } = getSignerContract(addr, FUND_ABI);
      const tx = await contract.claimTokens({ gasLimit: 300_000 });
      toast('Claiming tokens...');
      await waitWithTimeout(tx.wait());
      toast.success('Agent tokens claimed');
      loadPortfolio();
    } catch (err) {
      if (err?.message === 'TX_WAIT_TIMEOUT') toast.error(TX_TIMEOUT_MSG);
      else handleTxError(err);
    } finally { setActionAddr(null); }
  };

  const handleClaimRefund = async (addr) => {
    if (!isCorrectChain) return toast.error(`Wrong network — switch to ${CHAIN_NAME} first.`);
    setActionAddr(addr);
    try {
      const { contract } = getSignerContract(addr, FUND_ABI);
      const tx = await contract.claimRefund({ gasLimit: 300_000 });
      toast('Processing refund...');
      await waitWithTimeout(tx.wait());
      toast.success('Refund claimed');
      loadPortfolio();
    } catch (err) {
      if (err?.message === 'TX_WAIT_TIMEOUT') toast.error(TX_TIMEOUT_MSG);
      else handleTxError(err);
    } finally { setActionAddr(null); }
  };

  const handleAnnounce = async (addr) => {
    if (!isCorrectChain) return toast.error(`Wrong network — switch to ${CHAIN_NAME} first.`);
    setActionAddr(addr);
    try {
      const { contract } = getSignerContract(addr, FUND_ABI);
      const tx = await contract.announceLaunch({ gasLimit: 200_000 });
      toast('Initiating deployment notice...');
      await waitWithTimeout(tx.wait());
      toast.success('Deployment notice initiated — 6-hour countdown started');
      loadPortfolio();
    } catch (err) {
      if (err?.message === 'TX_WAIT_TIMEOUT') toast.error(TX_TIMEOUT_MSG);
      else handleTxError(err);
    } finally { setActionAddr(null); }
  };

  const handleLaunch = async (addr) => {
    if (!isCorrectChain) return toast.error(`Wrong network — switch to ${CHAIN_NAME} first.`);
    setActionAddr(addr);
    try {
      const { contract } = getSignerContract(addr, FUND_ABI);
      let gasLimit = ethers.BigNumber.from(3_500_000);
      try {
        const estimated = await contract.estimateGas.finalizeFunding();
        const buffered = estimated.mul(130).div(100);
        gasLimit = buffered.lt(gasLimit) ? gasLimit : buffered;
      } catch {}
      const tx = await contract.finalizeFunding({ gasLimit });
      toast('Deploying agent: creating Uniswap V3 pool + locking LP...');
      await waitWithTimeout(tx.wait());
      toast.success('Agent deployed — pool created, LP locked permanently');
      loadPortfolio();
    } catch (err) {
      if (err?.message === 'TX_WAIT_TIMEOUT') toast.error(TX_TIMEOUT_MSG);
      else handleTxError(err);
    } finally { setActionAddr(null); }
  };

  function getAction(p) {
    const busy = actionAddr === p.address;
    if (p.state === 1 && p.contribution > 0)
      return { label: busy ? 'REFUNDING...' : 'CLAIM REFUND', handler: () => handleClaimRefund(p.address), color: 'red', disabled: busy };
    if (p.state === 2 && p.isLaunchExpired && p.contribution > 0)
      return { label: busy ? 'REFUNDING...' : 'CLAIM REFUND (EXPIRED)', handler: () => handleClaimRefund(p.address), color: 'red', disabled: busy };
    if (p.state === 2 && p.isExpired && p.contribution > 0)
      return { label: busy ? 'REFUNDING...' : 'CLAIM REFUND', handler: () => handleClaimRefund(p.address), color: 'amber', disabled: busy };
    if (p.state === 2 && p.isLaunchExpired)
      return { label: 'DEPLOYMENT EXPIRED', handler: null, color: 'red', disabled: true };
    if (p.state === 2 && !p.isExpired && p.isOwner && !p.isAnnounced)
      return { label: busy ? 'INITIATING...' : 'INITIATE NOTICE', handler: () => handleAnnounce(p.address), color: 'cyan', disabled: busy };
    if (p.state === 2 && !p.isExpired && !p.isLaunchExpired && p.isOwner && p.isAnnounced && p.noticeElapsed)
      return { label: busy ? 'DEPLOYING...' : 'DEPLOY TO V3', handler: () => handleLaunch(p.address), color: 'emerald', disabled: busy };
    if (p.state === 2 && !p.isExpired && p.isAnnounced && !p.noticeElapsed)
      return { label: 'T-MINUS ACTIVE', handler: null, color: 'cyan', disabled: true };
    if (p.state === 2 && !p.isExpired)
      return { label: 'PREPARING', handler: null, color: 'zinc', disabled: true };
    if (p.state >= 3 && p.isFinalized && p.contribution > 0)
      return { label: busy ? 'CLAIMING...' : 'CLAIM AGENT TOKENS', handler: () => handleClaimTokens(p.address), color: 'blue', disabled: busy };
    if (p.state === 0)
      return { label: 'IAO FUNDING', handler: null, color: 'zinc', disabled: true };
    return { label: 'VIEW', handler: null, color: 'zinc', disabled: true };
  }

  const btnColors = {
    red:     'bg-red-500/10 text-red-400 border-red-500/30 hover:bg-red-500/20',
    amber:   'bg-amber-500/10 text-amber-400 border-amber-500/30 hover:bg-amber-500/20',
    emerald: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20',
    blue:    'bg-blue-500/10 text-blue-400 border-blue-500/30 hover:bg-blue-500/20',
    cyan:    'bg-cyan-500/10 text-cyan-400 border-cyan-500/30 hover:bg-cyan-500/20',
    zinc:    'bg-zinc-800/50 text-zinc-500 border-zinc-700/40',
  };

  // ── No wallet ──
  if (!account) {
    return (
      <div className="min-h-screen bg-[#050505] flex flex-col items-center justify-center font-mono space-y-6">
        <div className="text-2xl font-black tracking-tighter text-white">Merit<span className="text-blue-500">X</span> Backed Agents</div>
        <p className="text-white/20 text-sm tracking-widest uppercase animate-pulse">Connect wallet to view your backed agents</p>
        <button onClick={() => connectWallet().catch(err => {
          if (err?.code !== 4001 && err?.code !== 'ACTION_REJECTED') toast.error(err?.message || 'Wallet connection failed');
        })} className="px-8 py-3 rounded-full border border-blue-500/30 text-blue-500 font-bold text-sm hover:bg-blue-500 hover:text-black transition-all">
          CONNECT WALLET
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-300 font-sans selection:bg-blue-600/30" suppressHydrationWarning>
      <main className="max-w-5xl mx-auto px-4 md:px-6 py-10 space-y-10">

        {/* ── Header ── */}
        <div className="border-b border-zinc-800/60 pb-6">
          <h1 className="text-3xl font-black text-white tracking-tight mb-2">My Backed Agents</h1>
          <p className="text-xs font-mono text-zinc-600">
            Wallet <span className="text-zinc-400">{truncAddr(account)}</span>
          </p>
        </div>

        {/* ══════════════════════════════════════════════
            Backed Agents List
           ══════════════════════════════════════════════ */}
        <section>
          <div className="flex items-center gap-2 mb-6">
            <div className="w-2 h-2 rounded-full bg-blue-500" />
            <h2 className="text-sm font-bold text-white uppercase tracking-widest">Backed Agents</h2>
            <span className="text-[10px] font-mono text-zinc-600 ml-auto">{projects.length} agent{projects.length !== 1 ? 's' : ''}</span>
          </div>

          {isLoading ? (
            <div key="agents-loading" className="flex flex-col items-center justify-center py-20 gap-3">
              <span className="w-5 h-5 border-2 border-zinc-700 border-t-blue-500 rounded-full animate-spin" />
              <span className="text-zinc-600 text-xs font-mono">Scanning backed agents...</span>
            </div>
          ) : error ? (
            <div key="agents-error" className="p-6 rounded-xl border border-red-500/20 bg-red-500/5 text-center space-y-3">
              <p className="text-red-400 text-sm font-mono">{error}</p>
              <button onClick={loadPortfolio} className="text-xs font-bold text-blue-400 hover:underline">Retry</button>
            </div>
          ) : projects.length === 0 ? (
            <div key="agents-empty" className="text-center py-20 space-y-4">
              <p className="text-zinc-600 font-mono text-sm">No backed agents found for this wallet.</p>
              <Link href="/" className="text-blue-400 text-xs font-bold hover:underline">Browse IAO Directory &rarr;</Link>
            </div>
          ) : (
            <div key="agents-list" className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <AnimatePresence>
                {projects.map((p, i) => {
                  const cfg = STATE_LABELS[p.state] || STATE_LABELS[0];
                  const action = getAction(p);
                  return (
                    <motion.div
                      key={p.address}
                      initial={{ opacity: 0, y: 16 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.95 }}
                      transition={{ duration: 0.25, delay: i * 0.04 }}
                      className={`rounded-2xl border ${cfg.border} bg-zinc-900/40 backdrop-blur-sm p-5 hover:bg-zinc-900/60 transition-colors flex flex-col`}
                    >
                      <Link href={`/invest/${p.address}`} className="group flex items-start gap-3 mb-4">
                        <div className="w-11 h-11 rounded-xl bg-black border border-zinc-800 flex items-center justify-center shrink-0">
                          <span className="text-lg font-black text-blue-500">{p.name.charAt(0)}</span>
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="text-base font-bold text-white group-hover:text-blue-400 transition-colors truncate">{p.name}</h3>
                            <span className="text-[10px] font-mono text-zinc-600">${p.symbol}</span>
                            {p.isOwner && (
                              <span className="px-1.5 py-0.5 rounded bg-purple-500/10 border border-purple-500/30 text-[8px] font-bold uppercase tracking-widest text-purple-400">AI Dev</span>
                            )}
                          </div>
                          <p className="text-[10px] font-mono text-zinc-600 mt-0.5">{truncAddr(p.address)}</p>
                        </div>
                      </Link>

                      <div className="flex items-center justify-between mb-3">
                        <span className="flex items-center gap-1.5 text-[10px] font-mono">
                          <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
                          <span className={cfg.color}>{cfg.text}</span>
                        </span>
                        <span className="text-[10px] font-mono text-zinc-600 tabular-nums">{p.progress.toFixed(0)}%</span>
                      </div>

                      <div className="flex items-center gap-2 mb-4">
                        <div className="flex-1 h-1 bg-zinc-800 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${p.state === 1 ? 'bg-red-500/80' : p.state >= 3 ? 'bg-emerald-500' : 'bg-blue-600'}`}
                            style={{ width: `${p.progress}%` }}
                          />
                        </div>
                      </div>

                      <div className="flex items-center justify-between text-[10px] font-mono text-zinc-500 mb-4">
                        {p.contribution > 0 ? (
                          <span className="text-white font-bold tabular-nums">{fmtEth(p.contribution)} <span className="text-zinc-600">ETH sponsored</span></span>
                        ) : (
                          <span>&mdash;</span>
                        )}
                        <span className="tabular-nums">{fmtEth(p.raised)} / {fmtEth(p.softCap, 0)} ETH</span>
                      </div>

                      <div className="mt-auto">
                        {action.handler ? (
                          <button
                            onClick={action.handler}
                            disabled={action.disabled}
                            className={`w-full py-2.5 rounded-lg text-[10px] font-bold uppercase tracking-wider border transition-all disabled:opacity-50 disabled:animate-pulse ${btnColors[action.color]}`}
                          >
                            {action.label}
                          </button>
                        ) : (
                          <span className={`block w-full text-center py-2.5 rounded-lg text-[10px] font-bold uppercase tracking-wider border ${btnColors[action.color]}`}>
                            {action.label}
                          </span>
                        )}
                      </div>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function MetricCard({ label, value, sub, accent, highlight }) {
  return (
    <div className={`rounded-xl border px-5 py-4 transition-all ${highlight ? 'border-[#FF00A8]/30 bg-[#FF00A8]/[0.04]' : 'border-zinc-800/40 bg-zinc-900/40'}`}>
      <p className="text-[10px] font-mono uppercase tracking-widest text-zinc-600 mb-1.5">{label}</p>
      <p className={`text-lg font-black tabular-nums ${accent}`}>{value}</p>
      {sub && <p className="text-[10px] font-mono text-zinc-600 mt-1">{sub}</p>}
    </div>
  );
}
