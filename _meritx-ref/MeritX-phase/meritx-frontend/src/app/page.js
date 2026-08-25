'use client';
import { useState, useEffect, useMemo, Component, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { ethers } from 'ethers';
import useSWR from 'swr';
import { AnimatePresence, motion } from 'framer-motion';
import Link from 'next/link';
import { FileText, Github } from 'lucide-react';
import { FACTORY_ADDRESS } from '@/lib/constants';
import { FACTORY_ABI, FUND_ABI, TOKEN_ABI } from '@/lib/abis';
import { getRpcProvider } from '@/lib/web3';
import { useAgentMetadata } from '@/hooks/useAgentMetadata';
import IpfsImage from '@/components/IpfsImage';
import { fmtUTC } from '@/lib/fmt';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const RPC_TIMEOUT_MS = 20_000;

// ── Multicall3 (canonical address, deployed on all EVM chains incl. Base) ──
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MC_ABI = [
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[])',
];
const fundIface = new ethers.utils.Interface(FUND_ABI);
const tokenIface = new ethers.utils.Interface(TOKEN_ABI);
const FUND_READS = ['projectToken', 'totalRaised', 'SOFT_CAP', 'currentState', 'raiseEndTime', 'ipfsURI', 'RAISE_DURATION'];

// Module-level provider — reused via shared FallbackProvider for resilience
const _provider = getRpcProvider();

function decodeSafe(iface, fn, data) {
  try { return iface.decodeFunctionResult(fn, data)[0]; } catch { return null; }
}

const bn = (v) => (v?.toNumber ? v.toNumber() : Number(v ?? 0));

// SWR deep-compare: skip re-renders when on-chain data hasn't actually changed
function projectsEqual(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((p, i) => {
    const q = b[i];
    return p.address === q.address && p.state === q.state
      && p.raised === q.raised && p.progress === q.progress;
  });
}

async function _fetchProjects() {
  if (!FACTORY_ADDRESS) return [];
  const factory = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, _provider);
  const mc = new ethers.Contract(MULTICALL3, MC_ABI, _provider);

  let addresses;
  try {
    const count = await factory.projectCount();
    const n = count.toNumber();
    addresses = n === 0 ? [] : await Promise.all(
      Array.from({ length: n }, (_, i) => factory.allDeployedProjects(i))
    );
  } catch {
    return [];
  }
  if (addresses.length === 0) return [];

  // Round 1 — batch ALL fund reads into a single RPC call
  const fundCalls = addresses.flatMap(addr =>
    FUND_READS.map(fn => ({
      target: addr,
      allowFailure: true,
      callData: fundIface.encodeFunctionData(fn),
    }))
  );
  const r1 = await mc.aggregate3(fundCalls);

  const stride = FUND_READS.length;
  const fundSlices = [];
  const tokenAddrs = [];

  for (let i = 0; i < addresses.length; i++) {
    const base = i * stride;
    const get = (off, fn) => {
      const slot = r1[base + off];
      return slot.success ? decodeSafe(fundIface, fn, slot.returnData) : null;
    };
    const tokenAddr = get(0, 'projectToken');
    const raised    = get(1, 'totalRaised');
    const softCap   = get(2, 'SOFT_CAP');
    const state     = get(3, 'currentState');
    const endTime   = get(4, 'raiseEndTime');
    const ipfsURI   = get(5, 'ipfsURI');
    const raiseDur  = get(6, 'RAISE_DURATION');

    if (!tokenAddr || raised == null || softCap == null || state == null) {
      fundSlices.push(null);
      tokenAddrs.push(null);
      continue;
    }

    const endSec = bn(endTime);
    const durSec = raiseDur ? bn(raiseDur) : 0;
    const createdAt = durSec > 0 ? (endSec - durSec) * 1000 : 0;

    tokenAddrs.push(tokenAddr);
    fundSlices.push({
      address: addresses[i], raised, softCap,
      state: bn(state),
      endTime: endSec * 1000,
      createdAt,
      ipfsURI: ipfsURI || '',
    });
  }

  // Round 2 — batch ALL token name+symbol reads into a single RPC call
  const validIdxs = [];
  const tokenCalls = [];
  tokenAddrs.forEach((addr, i) => {
    if (!addr || !fundSlices[i]) return;
    validIdxs.push(i);
    tokenCalls.push(
      { target: addr, allowFailure: true, callData: tokenIface.encodeFunctionData('name') },
      { target: addr, allowFailure: true, callData: tokenIface.encodeFunctionData('symbol') },
    );
  });

  const r2 = tokenCalls.length > 0 ? await mc.aggregate3(tokenCalls) : [];

  const nameMap = new Map();
  const symMap  = new Map();
  validIdxs.forEach((oi, ci) => {
    nameMap.set(oi, r2[ci * 2]?.success   ? decodeSafe(tokenIface, 'name',   r2[ci * 2].returnData)     : 'Unknown');
    symMap.set(oi,  r2[ci * 2 + 1]?.success ? decodeSafe(tokenIface, 'symbol', r2[ci * 2 + 1].returnData) : '???');
  });

  const projects = [];
  for (let i = 0; i < fundSlices.length; i++) {
    const fd = fundSlices[i];
    if (!fd) continue;
    try {
      const raisedNum = Number(ethers.utils.formatEther(fd.raised));
      const capNum    = Number(ethers.utils.formatEther(fd.softCap));
      projects.push({
        address: fd.address,
        name: nameMap.get(i) || 'Unknown',
        symbol: symMap.get(i) || '???',
        state: fd.state,
        raised: raisedNum,
        softCap: capNum,
        progress: capNum > 0 ? (raisedNum / capNum) * 100 : 0,
        endTime: fd.endTime,
        createdAt: fd.createdAt,
        ipfsURI: fd.ipfsURI,
      });
    } catch {
      // skip unmappable fund
    }
  }

  return projects;
}

async function fetchAllProjects() {
  try {
    const result = await Promise.race([
      _fetchProjects(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('RPC timeout — node did not respond within 20s')), RPC_TIMEOUT_MS)
      ),
    ]);
    return result;
  } catch (err) {
    const msg = err?.message || '';
    const isContractMissing = msg.includes('call revert') || msg.includes('CALL_EXCEPTION')
      || msg.includes('could not decode') || msg.includes('missing revert data');
    if (isContractMissing) {
      return [];
    }
    throw err;
  }
}

function statusBadge(state) {
  switch (state) {
    case 0: return { text: '[IAO]\u00A0FUNDING', color: 'text-blue-400 bg-blue-400/10 border-blue-400/20' };
    case 1: return { text: '[ERR]\u00A0IAO_FAILED', color: 'text-red-400 bg-red-500/10 border-red-500/20' };
    case 2: return { text: '[PREP]\u00A0INITIALIZING', color: 'text-purple-400 bg-purple-500/10 border-purple-500/20' };
    case 3: return { text: '[LIVE]\u00A0AGENT_ACTIVE', color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' };
    default: return { text: 'UNKNOWN', color: 'text-zinc-500 bg-zinc-500/10 border-zinc-500/20' };
  }
}

function CardCountdown({ endTime, state }) {
  const [text, setText] = useState('--:--:--');
  useEffect(() => {
    if (state !== 0) { setText(state === 1 ? 'TERMINATED' : 'ENDED'); return; }
    const tick = () => {
      const diff = endTime - Date.now();
      if (diff <= 0) { setText('00:00:00'); return; }
      const h = String(Math.floor(diff / 3_600_000)).padStart(2, '0');
      const m = String(Math.floor((diff % 3_600_000) / 60_000)).padStart(2, '0');
      const s = String(Math.floor((diff % 60_000) / 1000)).padStart(2, '0');
      setText(`${h}:${m}:${s}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [endTime, state]);
  return <span className="text-[10px] font-mono tabular-nums text-zinc-500">{text}</span>;
}

function SkeletonCard() {
  return (
    <div className="relative p-6 rounded-2xl bg-zinc-900/20 backdrop-blur-md border border-zinc-800 overflow-hidden">
      <div className="absolute inset-0 -translate-x-full animate-[shimmer_2s_infinite] bg-gradient-to-r from-transparent via-white/[0.03] to-transparent" />
      <div className="flex justify-between items-start mb-6">
        <div className="w-12 h-12 rounded-xl bg-zinc-800/80" />
        <div className="w-32 h-5 rounded bg-zinc-800/60" />
      </div>
      <div className="w-40 h-6 rounded bg-zinc-800/80 mb-2" />
      <div className="w-48 h-3 rounded bg-zinc-800/40 mb-4" />
      <div className="w-full h-3 rounded bg-zinc-800/30 mb-2" />
      <div className="w-3/4 h-3 rounded bg-zinc-800/20 mb-6" />
      <div className="space-y-3">
        <div className="flex justify-between">
          <div className="w-24 h-3 rounded bg-zinc-800/40" />
          <div className="w-12 h-3 rounded bg-zinc-800/40" />
        </div>
        <div className="w-full h-1 rounded-full bg-zinc-800" />
        <div className="flex justify-between">
          <div className="w-20 h-2.5 rounded bg-zinc-800/30" />
          <div className="w-20 h-2.5 rounded bg-zinc-800/30" />
        </div>
      </div>
      <div className="mt-8 flex items-center justify-between">
        <div className="w-16 h-3 rounded bg-zinc-800/40" />
        <div className="w-28 h-8 rounded-lg bg-zinc-800/60" />
      </div>
    </div>
  );
}

class ProjectErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { hasError: false }; }
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(err) {
    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.error('ProjectGrid render error:', err);
    }
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="p-8 rounded-xl border border-red-500/20 bg-red-500/5 text-center">
          <p className="text-red-400 text-sm font-mono mb-3">RENDER_ERROR — project grid exception</p>
          <button
            onClick={() => this.setState({ hasError: false })}
            className="text-xs font-bold text-blue-400 hover:underline"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// AvatarImg now delegates to the resilient IpfsImage component
// which auto-cycles through multiple IPFS gateways on 429/504 errors.
function AvatarImg({ src, alt }) {
  return (
    <IpfsImage
      src={src}
      alt={alt}
      fallback={<span className="text-2xl font-black text-blue-500">{(alt || '?').charAt(0)}</span>}
    />
  );
}

function ProjectCard({ project: p }) {
  const meta = useAgentMetadata(p.ipfsURI);
  const avatarUrl = meta.avatarUrl;
  const description = meta.description;
  const isMetaLoading = meta.isMetaLoading;

  const badge = statusBadge(p.state);
  const isFailed = p.state === 1;
  const displayDesc = description || 'AI Agent tokenized via Initial Agent Offering on Base.';

  return (
    <Link
      href={`/invest/${encodeURIComponent(p.address)}`}
      className={`block relative group p-6 rounded-2xl transition-all duration-500 bg-zinc-900/20 backdrop-blur-md border hover:shadow-[0_0_30px_rgba(37,99,235,0.1)] ${
        p.state === 3
          ? 'border-emerald-500/30 hover:border-emerald-500/50 shadow-[0_0_20px_rgba(16,185,129,0.06)]'
          : 'border-zinc-800 hover:border-blue-500/50'
      }`}
    >
      <div className="flex justify-between items-start mb-6">
        <div className="w-12 h-12 rounded-xl bg-black border border-zinc-800 flex items-center justify-center overflow-hidden shadow-inner shrink-0 relative">
          {isMetaLoading ? (
            <div className="absolute inset-0 bg-zinc-800 animate-pulse rounded-xl" />
          ) : avatarUrl ? (
            <AvatarImg src={avatarUrl} alt={p.name} />
          ) : (
            <span className="text-2xl font-black text-blue-500">{p.name.charAt(0)}</span>
          )}
        </div>
        <span className={`flex items-center gap-1.5 text-[9px] font-bold px-2 py-1 rounded border uppercase tracking-widest ${badge.color}`}>
          {p.state === 3 && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_6px_rgba(52,211,153,0.7)]" />}
          {badge.text}
        </span>
      </div>

      <h3 className="text-xl font-bold text-white mb-1 tracking-tight group-hover:text-blue-400 transition-colors">{p.name}</h3>
      <p className="text-xs text-zinc-500 font-mono mb-4 uppercase tracking-tighter">
        ${p.symbol} &middot; {p.address.slice(0, 6)}...{p.address.slice(-4)}
      </p>

      {isMetaLoading ? (
        <div className="min-h-[40px] mb-6 space-y-2">
          <div className="h-3 w-full rounded bg-zinc-800/40 animate-pulse" />
          <div className="h-3 w-3/4 rounded bg-zinc-800/30 animate-pulse" />
        </div>
      ) : (
        <p className="text-sm text-zinc-400 line-clamp-3 min-h-[40px] mb-6 leading-relaxed break-words overflow-hidden">
          {displayDesc}
        </p>
      )}

      <div className="space-y-3">
        <div className="flex justify-between text-xs font-mono">
          <span className="text-zinc-500 uppercase">IAO Progress</span>
          <span className="text-white font-bold">{Math.min(p.progress, 100).toFixed(1)}%</span>
        </div>
        <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-1000 ${
              isFailed
                ? 'bg-red-500/80'
                : p.state === 3
                  ? 'bg-gradient-to-r from-emerald-500 to-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.6)]'
                  : 'bg-gradient-to-r from-blue-600 via-cyan-500 to-blue-500 shadow-[0_0_10px_rgba(6,182,212,0.6)]'
            }`}
            style={{ width: `${Math.min(100, p.progress)}%` }}
          />
        </div>
        <div className="flex justify-between text-[10px] font-mono text-zinc-500">
          <span>Raised: {p.raised.toFixed(4)} ETH</span>
          <span>Target: {p.softCap.toFixed(4)} ETH</span>
        </div>
        {p.createdAt > 0 && (
          <div className="text-[10px] font-mono text-zinc-600">
            LAUNCHED: {fmtUTC(p.createdAt)}
          </div>
        )}
      </div>

      <div className="mt-8 flex items-center justify-between">
        <CardCountdown endTime={p.endTime} state={p.state} />
        <span className={`text-xs font-bold px-4 py-2 rounded-lg transition-all shadow-lg ${
          p.state === 0
            ? 'text-white bg-blue-600 hover:bg-blue-500 shadow-blue-600/20'
            : p.state === 3
              ? 'text-white bg-emerald-600 hover:bg-emerald-500 shadow-emerald-600/20'
              : p.state === 2
                ? 'text-white bg-purple-600 hover:bg-purple-500 shadow-purple-600/20'
                : 'text-zinc-400 bg-zinc-800 shadow-none'
        }`}>
          {p.state === 0 ? 'SPONSOR COMPUTE' : p.state === 3 ? 'VIEW AGENT' : p.state === 2 ? 'INITIALIZING' : 'DETAILS'}
        </span>
      </div>
    </Link>
  );
}

function readHiddenMap() {
  try { return JSON.parse(localStorage.getItem('meritx-hidden-projects') || '{}'); } catch { return {}; }
}

function isValidEvmAddress(addr) {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

function ReferralCapture() {
  const searchParams = useSearchParams();
  useEffect(() => {
    const ref = searchParams.get('ref');
    if (ref && isValidEvmAddress(ref)) {
      localStorage.setItem('meritx_referrer', ref);
    }
  }, [searchParams]);
  return null;
}

export default function Home() {
  const { data: allProjects, error, isValidating, mutate } = useSWR(
    'meritx-projects',
    fetchAllProjects,
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: true,
      refreshInterval: 60_000,
      dedupingInterval: 30_000,
      errorRetryCount: 2,
      errorRetryInterval: 15_000,
      fallbackData: [],
      keepPreviousData: true,
      compare: projectsEqual,
    }
  );

  const [isMounted, setIsMounted] = useState(false);
  const [hiddenMap, setHiddenMap] = useState({});
  useEffect(() => {
    setIsMounted(true);
    setHiddenMap(readHiddenMap());
    const onStorage = (e) => { if (e.key === 'meritx-hidden-projects') setHiddenMap(readHiddenMap()); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const projects = useMemo(() => {
    const raw = allProjects || [];
    const filtered = raw.filter(p => !hiddenMap[p.address]);
    return filtered;
  }, [allProjects, hiddenMap]);

  const hasNoData = !allProjects || allProjects.length === 0;
  const isFirstLoad = hasNoData && isValidating && !error;

  const [activeTab, setActiveTab] = useState('live');

  const { live, launching, completed, archived } = useMemo(() => {
    const now = isMounted ? Date.now() : 0;
    const live = [], launching = [], completed = [], archived = [];

    for (const p of projects) {
      const age = now - p.endTime;
      if (p.state === 0) {
        live.push(p);
      } else if (p.state === 1) {
        archived.push(p);
      } else if (p.state === 2) {
        launching.push(p);
      } else if (p.state === 3) {
        (now > 0 && age > THIRTY_DAYS_MS) ? archived.push(p) : completed.push(p);
      } else {
        archived.push(p);
      }
    }

    live.sort((a, b) => b.createdAt - a.createdAt || b.progress - a.progress);
    launching.sort((a, b) => b.createdAt - a.createdAt || a.address.localeCompare(b.address));
    completed.sort((a, b) => b.createdAt - a.createdAt || b.progress - a.progress);

    return { live, launching, completed, archived };
  }, [projects, isMounted]);

  const TAB_CONFIG = [
    { key: 'live', label: 'Funding Agents', count: live.length },
    { key: 'launching', label: 'Initializing', count: launching.length },
    { key: 'completed', label: 'Active Agents', count: completed.length },
    { key: 'archived', label: 'Archived', count: archived.length },
  ];
  const tabMap = { live, launching, completed, archived };
  const tabProjects = tabMap[activeTab] || live;

  const [a2aLogs, setA2aLogs] = useState([]);
  useEffect(() => {
    const logs = [
      '> Agent_Alpha invoked Compute_Node_7 [12ms]',
      '> Settlement successful: 0.002 ETH via Base L2',
      '> opML Verification: Proof verified by TEE',
      '> Yield distributed to PoP liquidity sink',
      '> A2A handshake: QuantMind <-> ResearchBot',
    ];
    let id = 0;
    setA2aLogs([{ id: id++, text: logs[0] }]);
    const interval = setInterval(() => {
      setA2aLogs(prev => {
        const next = { id: id++, text: logs[Math.floor(Math.random() * logs.length)] };
        return [next, ...prev].slice(0, 5);
      });
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen font-sans selection:bg-blue-600/30" style={{ background: '#050505' }}>
      <Suspense fallback={null}><ReferralCapture /></Suspense>
      <main className="max-w-6xl mx-auto px-4 pb-24 text-zinc-300">

        {/* ═══════════════ HERO ═══════════════ */}
        <section className="pt-10 pb-8 border-b border-zinc-800/60">
          <div className="max-w-3xl">
            <div className="flex items-center gap-3 mb-4">
              <span className="bg-blue-600 text-white text-[10px] font-bold px-2.5 py-0.5 rounded">BASE L2</span>
              <span className="text-zinc-500 text-[10px] font-mono animate-pulse tracking-widest uppercase">Uplink: Secure</span>
            </div>
            <h1 className="text-3xl sm:text-4xl lg:text-5xl font-black tracking-tighter text-white leading-[1.08] mb-3">
              The Settlement Protocol for{' '}
              <span className="text-blue-500">Autonomous AI Economies.</span>
            </h1>
            <p className="text-zinc-400 text-sm max-w-xl leading-relaxed">
              Base-layer infrastructure for Agent-to-Agent (A2A) commerce, powered by the Price-of-Proof consensus.
            </p>
            <div className="flex items-center gap-4 mt-5 flex-wrap">
              <Link
                href="/litepaper"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-bold uppercase tracking-wider text-zinc-300 bg-transparent border border-zinc-700 hover:border-blue-500/50 hover:text-white transition-all"
              >
                <FileText size={14} className="text-blue-400" />
                READ LITEPAPER
              </Link>
              <a
                href="https://github.com/jayoo101/meritx-core"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-bold uppercase tracking-wider text-zinc-300 bg-transparent border border-zinc-700 hover:border-blue-500/50 hover:text-white transition-all"
              >
                <Github size={14} className="text-blue-400" />
                GitHub
              </a>

              <div className="hidden sm:block w-[1px] h-10 bg-zinc-800 mx-2" />

              <div className="flex items-center gap-5 sm:gap-4 px-2">
                <a href="https://x.com/MeritX_HQ" target="_blank" rel="noopener noreferrer" className="text-zinc-500 hover:text-zinc-100 transition-colors" aria-label="X / Twitter">
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
                </a>
                <a href="https://warpcast.com/meritx" target="_blank" rel="noopener noreferrer" className="text-zinc-500 hover:text-zinc-100 transition-colors" aria-label="Farcaster">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round"><path d="M4 10v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" /><polyline points="4 10 12 4 20 10" /><line x1="12" y1="12" x2="12" y2="18" /></svg>
                </a>
                <a href="https://discord.gg/meritx" target="_blank" rel="noopener noreferrer" className="text-zinc-500 hover:text-zinc-100 transition-colors" aria-label="Discord">
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189z" /></svg>
                </a>
              </div>
            </div>
          </div>
        </section>

        {/* ═══════════════ A2A LIVE TICKER ═══════════════ */}
        <div className="py-3 border-b border-zinc-800/40 overflow-hidden">
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1.5 shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shadow-[0_0_6px_rgba(16,185,129,0.6)]" />
              <span className="text-[9px] font-mono text-zinc-500 uppercase tracking-widest">A2A Feed</span>
            </span>
            <div className="flex-1 overflow-hidden">
              <div className="flex gap-8 text-[10px] font-mono text-blue-400/50 whitespace-nowrap">
                <AnimatePresence initial={false}>
                  {a2aLogs.map(log => (
                    <motion.span
                      key={log.id}
                      initial={{ opacity: 0, x: 20 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.3 }}
                      className="shrink-0"
                    >
                      {log.text}
                    </motion.span>
                  ))}
                </AnimatePresence>
              </div>
            </div>
          </div>
        </div>

        {/* ═══════════════ AGENT DIRECTORY ═══════════════ */}
        <section id="directory" className="pt-8">

          {/* Status indicator + REFRESH_RADAR */}
          {!error && (
            <div className="flex items-center gap-2 mb-6">
              <span className={`w-2 h-2 rounded-full ${isValidating ? 'bg-blue-500 animate-pulse' : hasNoData && !isFirstLoad ? 'bg-emerald-500/50 animate-pulse' : 'bg-blue-500/40'}`} />
              <span className="text-[10px] font-mono text-zinc-500 tracking-wider flex-1 min-w-0">
                {isValidating && isFirstLoad
                  ? 'Scanning IAOs...'
                  : isValidating
                    ? 'REFRESHING RADAR...'
                    : hasNoData && !isFirstLoad
                      ? 'BASE_L2_UPLINK: PENDING_DEPLOYMENT \u2014 Awaiting mainnet initialization'
                      : `IAO radar \u2014 ${live.length} funding \u00B7 ${launching.length} initializing \u00B7 ${completed.length} active \u00B7 auto-sync 30s`}
              </span>
              {!isFirstLoad && (
                <button
                  onClick={() => mutate()}
                  disabled={isValidating}
                  className={[
                    'shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[9px] font-black font-mono uppercase tracking-wider border transition-all',
                    isValidating
                      ? 'border-blue-500/30 bg-blue-500/10 text-blue-400 cursor-wait'
                      : 'border-zinc-700 bg-zinc-900/60 text-zinc-400 hover:border-blue-500/40 hover:text-blue-400 hover:bg-blue-500/10',
                  ].join(' ')}
                >
                  {isValidating && <span className="w-2.5 h-2.5 border border-blue-500/50 border-t-blue-400 rounded-full animate-spin" />}
                  {isValidating ? 'SCANNING...' : '[ REFRESH_RADAR ]'}
                </button>
              )}
            </div>
          )}

          {/* Network error — only for real RPC failures, not contract-not-deployed */}
          {error && (
            <div className="mb-6 flex items-center gap-3 px-4 py-3 rounded-xl border border-zinc-800 bg-zinc-900/40">
              <span className="w-2 h-2 rounded-full bg-amber-500/60 animate-pulse shrink-0" />
              <p className="text-[10px] font-mono text-zinc-500 tracking-wider">
                {error.message?.includes('rate') || error.message?.includes('429')
                  ? 'RPC_RATE_LIMIT \u2014 auto-retry in progress'
                  : error.message?.includes('timeout')
                    ? 'RPC_TIMEOUT \u2014 node latency exceeded 20s threshold'
                    : 'SYNC_INTERRUPTED \u2014 retrying shortly'}
              </p>
              <button
                onClick={() => mutate()}
                className="text-[9px] font-mono text-zinc-600 hover:text-blue-400 transition-colors ml-auto shrink-0"
              >
                RETRY
              </button>
            </div>
          )}

          {/* Tab Bar */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1 p-1 bg-zinc-900/60 border border-zinc-800/60 rounded-xl mb-6">
            {TAB_CONFIG.map(tab => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={[
                  'py-2.5 px-3 text-[10px] font-bold uppercase tracking-widest rounded-lg transition-all flex items-center justify-center gap-1.5',
                  activeTab === tab.key
                    ? 'bg-zinc-800 text-white shadow-sm'
                    : 'text-zinc-500 hover:text-zinc-300',
                ].join(' ')}
              >
                {tab.label}
                {tab.count > 0 && (
                  <span className={[
                    'inline-flex items-center justify-center min-w-[18px] h-[18px] rounded-full text-[9px] font-black px-1',
                    activeTab === tab.key ? 'bg-blue-500/20 text-blue-400' : 'bg-zinc-800/80 text-zinc-600',
                  ].join(' ')}>
                    {tab.count}
                  </span>
                )}
              </button>
            ))}
          </div>

          <ProjectErrorBoundary>
            <AnimatePresence mode="wait">
              <motion.div
                key={activeTab}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
              >
                {tabProjects.length === 0 && !isFirstLoad ? (
                  <div className="relative flex flex-col items-center justify-center py-24 text-center">
                    {/* Radar pulse rings */}
                    <div className="relative w-28 h-28 mb-8">
                      <span className="absolute inset-0 rounded-full border border-blue-500/20 animate-ping" style={{ animationDuration: '3s' }} />
                      <span className="absolute inset-3 rounded-full border border-blue-500/15 animate-ping" style={{ animationDuration: '3s', animationDelay: '0.5s' }} />
                      <span className="absolute inset-6 rounded-full border border-blue-500/10 animate-ping" style={{ animationDuration: '3s', animationDelay: '1s' }} />
                      <span className="absolute inset-0 flex items-center justify-center">
                        <span className="w-3 h-3 rounded-full bg-blue-500/60 shadow-[0_0_12px_rgba(59,130,246,0.5)]" />
                      </span>
                    </div>
                    <p className="text-[11px] font-mono font-bold uppercase tracking-[0.25em] text-zinc-500 mb-2">
                      No Active Agents Detected
                    </p>
                    <p className="text-[10px] font-mono text-zinc-600 max-w-xs mb-6">
                      {activeTab === 'live' && 'The radar is clear. Be the first to deploy an autonomous agent on Base L2.'}
                      {activeTab === 'launching' && 'No agents currently in the initialization pipeline.'}
                      {activeTab === 'completed' && 'No agents have completed deployment yet.'}
                      {activeTab === 'archived' && 'No archived agent records found.'}
                    </p>
                    <Link
                      href="/launch"
                      className="group relative inline-flex items-center gap-2.5 px-6 py-3 rounded-xl text-xs font-black uppercase tracking-wider text-white overflow-hidden bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 shadow-lg shadow-blue-900/20 hover:shadow-blue-800/30 transition-all duration-300"
                    >
                      <span className="absolute inset-0 bg-gradient-to-r from-transparent via-white/[0.07] to-transparent translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-700" />
                      <svg className="w-4 h-4 relative z-10" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
                      <span className="relative z-10">DEPLOY GENESIS AGENT</span>
                    </Link>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {tabProjects.map((p) => (
                      <ProjectCard key={p.address} project={p} />
                    ))}
                    {isFirstLoad && [1, 2, 3].map(i => <SkeletonCard key={`sk-${i}`} />)}
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          </ProjectErrorBoundary>
        </section>

        {/* ═══════════════ THE TRUST PIPELINE — Hardware Infrastructure ═══════════════ */}
        <style jsx global>{`
          @keyframes cableFlow { 0%{background-position:200% 0} 100%{background-position:-200% 0} }
          @keyframes ledBreathe { 0%,100%{opacity:.4} 50%{opacity:1} }
          .cable-flow{background-size:200% 100%;animation:cableFlow 4s linear infinite}
          .led-breathe{animation:ledBreathe 2.5s ease-in-out infinite}
        `}</style>
        <section className="relative z-10 pt-28 md:pt-36 pb-12 md:pb-16 bg-transparent overflow-hidden">
          <div className="mb-16 md:mb-20 px-4">
            <h3 className="text-xs font-mono text-zinc-600 tracking-widest uppercase mb-4">
              // PROTOCOL_WORKFLOW
            </h3>
            <h2 className="text-3xl md:text-5xl font-medium text-zinc-100 tracking-tight leading-tight">
              The Trust Pipeline.
            </h2>
          </div>

          {/* ── Desktop: horizontal hardware rack ── */}
          <div className="hidden md:block">
            <div className="grid grid-cols-5 gap-0">
              {PIPELINE_STEPS.map((s, i) => (
                <div key={i} className="relative group flex flex-col items-center">
                  {/* Cable connector between boxes */}
                  {i < 4 && (
                    <div className="absolute top-[130px] -right-[2px] w-[calc(100%-0px)] h-[6px] z-0 flex flex-col justify-center gap-[2px] pointer-events-none" style={{ left: '50%' }}>
                      <div className="h-[1px] bg-gradient-to-r from-zinc-700 via-zinc-600/40 to-zinc-700 cable-flow" style={{ backgroundImage: `linear-gradient(90deg, transparent, ${s.glow}33, transparent)` }} />
                      <div className="h-[2px] bg-zinc-800/80" />
                      <div className="h-[1px] bg-gradient-to-r from-zinc-700 via-zinc-600/40 to-zinc-700" />
                    </div>
                  )}

                  {/* Hardware chassis */}
                  <div className={`relative w-full mx-2 rounded-2xl border overflow-hidden transition-all duration-500 md:min-h-[320px] flex flex-col ${s.chassis} group-hover:scale-[1.01]`}>
                    {/* Top bezel — LED strip */}
                    <div className={`h-1 w-full ${s.ledStrip}`} />

                    {/* LED indicator */}
                    <div className="absolute top-4 right-4 flex items-center gap-1.5">
                      <div className={`w-2 h-2 rounded-full ${s.led} led-breathe`} />
                      <span className="text-[7px] font-mono text-zinc-600 uppercase">Active</span>
                    </div>

                    {/* Inner panel */}
                    <div className="flex-1 flex flex-col p-6 pt-8">
                      {/* Tag row */}
                      <div className="flex items-center gap-2 mb-5">
                        <span className="text-[9px] font-mono text-zinc-500 bg-black/60 border border-zinc-800 px-2 py-0.5 rounded">
                          STEP {s.step}
                        </span>
                        <span className="text-[9px] font-mono text-zinc-700">|</span>
                        <span className={`text-[9px] font-mono font-bold ${s.tagColor}`}>{s.tag}</span>
                      </div>

                      {/* Title */}
                      <h4 className="text-lg font-bold text-zinc-100 mb-3 tracking-tight group-hover:text-white transition-colors">
                        {s.title}
                      </h4>

                      {/* Description */}
                      <p className="text-[12px] text-zinc-400 leading-relaxed mt-auto">
                        {s.description}
                      </p>
                    </div>

                    {/* Bottom bezel — circuit trace */}
                    <div className="h-px mx-4 mb-3 bg-gradient-to-r from-transparent via-zinc-800 to-transparent" />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ── Mobile: vertical hardware stack ── */}
          <div className="md:hidden relative pl-4 pr-2">
            {/* Vertical cable */}
            <div className="absolute left-[19px] top-0 bottom-0 w-[2px] bg-zinc-800 z-0">
              <div className="absolute inset-0 bg-gradient-to-b from-emerald-900/30 via-transparent to-emerald-900/30 cable-flow" style={{ backgroundSize: '100% 200%', animationDirection: 'reverse' }} />
            </div>

            <div className="space-y-8 relative z-10">
              {PIPELINE_STEPS.map((s, i) => (
                <div key={i} className="relative flex gap-4">
                  {/* Node */}
                  <div className="shrink-0 w-[38px] h-[38px] rounded-xl bg-black border border-zinc-700 flex items-center justify-center z-10">
                    <div className={`w-2.5 h-2.5 rounded-full ${s.led} led-breathe`} />
                  </div>

                  {/* Chassis */}
                  <div className={`flex-1 rounded-xl border overflow-hidden ${s.chassis}`}>
                    <div className={`h-0.5 w-full ${s.ledStrip}`} />
                    <div className="p-5">
                      <div className="flex items-center gap-2 mb-3">
                        <span className="text-[9px] font-mono text-zinc-500 bg-black/60 border border-zinc-800 px-2 py-0.5 rounded">STEP {s.step}</span>
                        <span className="text-[9px] font-mono text-zinc-700">|</span>
                        <span className={`text-[9px] font-mono font-bold ${s.tagColor}`}>{s.tag}</span>
                      </div>
                      <h4 className="text-base font-bold text-zinc-100 mb-2">{s.title}</h4>
                      <p className="text-[12px] text-zinc-400 leading-relaxed">{s.description}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ═══════════════ FOOTER ═══════════════ */}
        <footer className="mt-6 pt-6 pb-8 border-t border-zinc-800/60">
          <div className="flex items-center justify-between">
            <span className="text-sm font-black text-white tracking-tighter">Merit<span className="text-blue-500">X</span></span>
            <span className="text-[10px] text-zinc-600 font-mono">&copy; {new Date().getFullYear()} MeritX Protocol</span>
          </div>
        </footer>
      </main>
    </div>
  );
}

// ═══════════════ PIPELINE STEPS (5 core primitives) ═══════════════

// ═══════════════ PIPELINE STEPS — Hardware-themed (5 core primitives) ═══════════════

const PIPELINE_STEPS = [
  {
    step: '01', tag: 'DEFENSE', tagColor: 'text-emerald-400',
    title: 'Gas-Gated Allocation',
    description: 'On-chain gas history gates allocation. Zero bots, zero Sybils. Only real humans can sponsor AI compute.',
    chassis: 'bg-gradient-to-br from-zinc-900 via-zinc-950 to-zinc-900 border-zinc-700/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_4px_24px_rgba(0,0,0,0.5)] hover:border-emerald-800/50 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_4px_32px_rgba(16,185,129,0.08)]',
    ledStrip: 'bg-gradient-to-r from-transparent via-emerald-500/60 to-transparent',
    led: 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]',
    glow: '#10b981',
  },
  {
    step: '02', tag: 'ASSET', tagColor: 'text-blue-400',
    title: 'Autonomous Tokenization',
    description: 'Permissionless token minting via the MeritX Factory. 100% fair launch with zero pre-mine or team allocation.',
    chassis: 'bg-[#0a0a0a] border-blue-900/30 shadow-[inset_0_1px_0_rgba(59,130,246,0.06),0_4px_24px_rgba(0,0,0,0.5)] hover:border-blue-700/40 hover:shadow-[inset_0_1px_0_rgba(59,130,246,0.1),0_4px_32px_rgba(59,130,246,0.08)]',
    ledStrip: 'bg-gradient-to-r from-transparent via-blue-500/60 to-transparent',
    led: 'bg-blue-400 shadow-[0_0_6px_rgba(96,165,250,0.8)]',
    glow: '#3b82f6',
  },
  {
    step: '03', tag: 'NOTICE', tagColor: 'text-amber-400',
    title: '6h Anti-Stealth',
    description: 'Mandatory 6-hour public notice before any agent launch. All sponsors get advance warning — no insider launches.',
    chassis: 'bg-gradient-to-br from-zinc-950 via-[#0d0a07] to-zinc-950 border-amber-900/25 shadow-[inset_0_1px_0_rgba(245,158,11,0.05),0_4px_24px_rgba(0,0,0,0.5)] hover:border-amber-700/40 hover:shadow-[inset_0_1px_0_rgba(245,158,11,0.08),0_4px_32px_rgba(245,158,11,0.06)]',
    ledStrip: 'bg-gradient-to-r from-transparent via-amber-500/60 to-transparent',
    led: 'bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.8)]',
    glow: '#f59e0b',
  },
  {
    step: '04', tag: 'LIQUIDITY', tagColor: 'text-purple-400',
    title: '95% POL',
    description: '95% of raised ETH is permanently locked in Uniswap V3. The LP NFT stays in-contract forever. Zero rug pull risk.',
    chassis: 'bg-zinc-950 border-purple-900/25 shadow-[inset_0_2px_12px_rgba(147,51,234,0.04),0_4px_24px_rgba(0,0,0,0.5)] hover:border-purple-700/40 hover:shadow-[inset_0_2px_16px_rgba(147,51,234,0.08),0_4px_32px_rgba(147,51,234,0.06)]',
    ledStrip: 'bg-gradient-to-r from-transparent via-purple-500/60 to-transparent',
    led: 'bg-purple-400 shadow-[0_0_6px_rgba(192,132,252,0.8)]',
    glow: '#a855f7',
  },
  {
    step: '05', tag: 'ENGINE', tagColor: 'text-lime-400',
    title: 'Price-of-Proof',
    description: 'Continuous token expansion tied to market demand. AI developers earn compute subsidies as their agent usage grows.',
    chassis: 'bg-gradient-to-br from-[#070a05] via-zinc-950 to-[#070a05] border-lime-900/25 shadow-[inset_0_1px_0_rgba(132,204,22,0.05),0_4px_24px_rgba(0,0,0,0.5)] hover:border-lime-700/40 hover:shadow-[inset_0_1px_0_rgba(132,204,22,0.08),0_4px_32px_rgba(132,204,22,0.06)]',
    ledStrip: 'bg-gradient-to-r from-transparent via-lime-500/60 to-transparent',
    led: 'bg-lime-400 shadow-[0_0_6px_rgba(163,230,53,0.8)]',
    glow: '#84cc16',
  },
];


