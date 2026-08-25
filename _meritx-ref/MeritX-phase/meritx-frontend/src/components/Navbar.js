'use client';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { ethers } from 'ethers';
import toast from 'react-hot-toast';
import { AnimatePresence, motion } from 'framer-motion';
import { fmtEth, truncAddr } from '@/lib/fmt';
import {
  FACTORY_ADDRESS,
  CHAIN_ID,
  CHAIN_ID_HEX,
  CHAIN_NAME,
  RPC_URL,
  EXPLORER_URL,
} from '@/lib/constants';
import { FACTORY_ABI, FUND_ABI, TOKEN_ABI } from '@/lib/abis';
import { getReadContract, getRpcProvider, getSignerContract, handleTxError } from '@/lib/web3';
import { getWalletProvider, getActiveProvider, setActiveProvider, getSupportedWallets, getWalletLabel } from '@/lib/walletProvider';
import { useNetwork } from '@/lib/useNetwork';
import { useGasAllocation } from '@/hooks/useGasAllocation';
import PogUnlockModal from '@/components/PogUnlockModal';

// ---- Cooldown Formatter ----
function formatCooldown(ms) {
  const totalSec = Math.ceil(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

// ---- Circular Progress Ring ----

function RingProgress({ pct, size = 36, stroke = 3, colorClass = 'text-blue-500' }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c - (Math.min(Math.max(pct, 0), 100) / 100) * c;
  return (
    <svg width={size} height={size} className="-rotate-90" viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-zinc-800" />
      <circle
        cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke}
        stroke="currentColor" className={colorClass}
        strokeDasharray={c} strokeDashoffset={offset} strokeLinecap="round"
        style={{ transition: 'stroke-dashoffset 0.6s ease' }}
      />
    </svg>
  );
}

// ---- Tab Button ----


// ---- Drawer Project Card ----

const ACTION_COLORS = {
  claim:  { btn: 'bg-blue-500/10 text-blue-400 border-blue-500/30 hover:bg-blue-500/20', ring: 'text-blue-500' },
  refund: { btn: 'bg-red-500/10 text-red-400 border-red-500/30 hover:bg-red-500/20', ring: 'text-red-500' },
  amber:  { btn: 'bg-amber-500/10 text-amber-400 border-amber-500/30 hover:bg-amber-500/20', ring: 'text-amber-500' },
  live:   { btn: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30', ring: 'text-cyan-500' },
  none:   { btn: 'bg-zinc-800/50 text-zinc-500 border-zinc-700/40', ring: 'text-zinc-600' },
};

const DRAWER_RETAIL_POOL = 21_000_000;

function fmtMicroPriceStr(value) {
  if (!value || value <= 0) return '—';
  if (value >= 0.01) return value.toFixed(6);
  if (value >= 0.001) return value.toFixed(8);
  const str = value.toFixed(18);
  const afterDot = str.split('.')[1] || '';
  let zeros = 0;
  for (const c of afterDot) {
    if (c === '0') zeros++;
    else break;
  }
  const sig = afterDot.slice(zeros, zeros + 4).replace(/0+$/, '') || '0';
  return `0.0(${zeros})${sig}`;
}

function DrawerCard({ p, actionAddr, onClaim, onRefund }) {
  const busy = actionAddr === p.address;
  const action = getCardAction(p);
  const impliedPrice = p.raised > 0 ? p.raised / DRAWER_RETAIL_POOL : 0;

  const handleClick = () => {
    if (action.type === 'claim') onClaim(p.address);
    else if (action.type === 'refund') onRefund(p.address);
  };

  const colors = ACTION_COLORS[action.type] || ACTION_COLORS.none;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className="py-2.5 group"
    >
      <div className="flex items-center gap-2.5">
        {/* Icon + Progress Ring */}
        <div className="relative shrink-0">
          <RingProgress pct={p.progress} colorClass={colors.ring} />
          <span className="absolute inset-0 flex items-center justify-center text-[11px] font-black text-white">
            {p.name.charAt(0)}
          </span>
        </div>

        {/* Info */}
        <Link href={`/invest/${p.address}`} className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-semibold text-zinc-200 truncate group-hover:text-blue-400 transition-colors">
              {p.name}
            </span>
            <span className="text-[9px] font-mono text-zinc-600">${p.symbol}</span>
            {p.isOwner && (
              <span className="px-1 py-px rounded bg-purple-500/10 border border-purple-500/30 text-[7px] font-bold text-purple-400 uppercase">
                AI Dev
              </span>
            )}
            {p.isDelisted && (
              <span className="px-1 py-px rounded bg-zinc-700/30 border border-zinc-600/40 text-[7px] font-bold text-zinc-500 uppercase">
                Delisted
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-[10px] font-mono">
            <span className="text-zinc-600">Sponsored:</span>
            <span className="text-zinc-300 font-bold tabular-nums">{fmtEth(p.contribution)} ETH</span>
            {impliedPrice > 0 && (
              <span className="text-blue-400/60 tabular-nums">@ {fmtMicroPriceStr(impliedPrice)}</span>
            )}
            {p.isNoticeLive && (
              <span className="flex items-center gap-1 text-cyan-400">
                <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                T-Minus
              </span>
            )}
          </div>
        </Link>

        {/* Action */}
        {action.type !== 'none' ? (
          <button
            onClick={handleClick}
            disabled={busy}
            className={[
              'shrink-0 px-3 py-1.5 rounded-lg text-[9px] font-bold uppercase tracking-wider border transition-all',
              busy ? 'opacity-50 animate-pulse' : '',
              colors.btn,
            ].join(' ')}
          >
            {busy ? '...' : action.label}
          </button>
        ) : (
          <Link
            href={`/invest/${p.address}`}
            className="shrink-0 px-3 py-1.5 rounded-lg text-[9px] font-bold uppercase tracking-wider border border-zinc-700 bg-zinc-800/50 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 transition-colors"
          >
            {action.label}
          </Link>
        )}
      </div>

      {/* Mini progress bar */}
      {p.state === 0 && (
        <div className="flex items-center gap-2 mt-1.5 ml-[46px]">
          <div className="flex-1 h-1 rounded-full bg-zinc-800 overflow-hidden">
            <div
              className="h-full rounded-full bg-blue-500/70 transition-all duration-500"
              style={{ width: `${Math.min(p.progress, 100)}%` }}
            />
          </div>
          <span className="text-[8px] font-mono font-bold text-zinc-500 tabular-nums shrink-0">{Math.round(p.progress)}%</span>
        </div>
      )}
    </motion.div>
  );
}

function getCardAction(p) {
  if (p.state === 1 && p.contribution > 0) return { type: 'refund', label: 'RECLAIM' };
  if (p.state === 2 && (p.isLaunchExpired || p.isExpired) && p.contribution > 0) return { type: 'refund', label: 'RECLAIM' };
  if (p.state >= 3 && p.isFinalized && p.contribution > 0) return { type: 'claim', label: 'CLAIM' };
  if (p.state === 0) return { type: 'none', label: 'FUNDING' };
  if (p.state === 2 && p.isNoticeLive) return { type: 'live', label: 'NOTICE' };
  if (p.state === 2) return { type: 'none', label: 'PREPARING' };
  return { type: 'none', label: 'VIEW' };
}

// ---- Main Navbar ----

export default function Navbar() {
  const pathname = usePathname();
  const [account, setAccount] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerProjects, setDrawerProjects] = useState([]);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [actionAddr, setActionAddr] = useState(null);
  const gasAlloc = useGasAllocation(account);
  const [cooldownEndAt, setCooldownEndAt] = useState(0);
  const [cooldownLeft, setCooldownLeft] = useState(0);
  const [copied, setCopied] = useState(false);
  const [walletModalOpen, setWalletModalOpen] = useState(false);
  const [pogModalOpen, setPogModalOpen] = useState(false);
  const pogPromptedRef = useRef(false);
  const prevPogAccountRef = useRef('');
  const { isCorrectChain } = useNetwork();

  const connectWithType = async (walletType) => {
    if (typeof window === 'undefined') return;
    const raw = getWalletProvider(walletType);
    if (!raw) { toast.error(`${getWalletLabel(walletType)} not detected. Please install it first.`); return; }
    setActiveProvider(raw);
    try {
      try { await raw.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] }); } catch {}
      const accounts = await raw.request({ method: 'eth_requestAccounts' });
      if (accounts?.[0]) {
        setAccount(accounts[0]);
        localStorage.setItem('isWalletConnected', 'true');
        localStorage.setItem('meritx_walletType', walletType);
        setWalletModalOpen(false);
      }
    } catch (err) {
      if (err?.code !== 4001 && err?.code !== 'ACTION_REJECTED') toast.error('Wallet connection failed');
    }
  };

  const disconnectWallet = () => {
    setAccount('');
    localStorage.removeItem('isWalletConnected');
    localStorage.removeItem('meritx_walletType');
    setActiveProvider(null);
    setDrawerOpen(false);
  };

  const switchWallet = async () => {
    const p = getActiveProvider();
    if (!p) return toast.error('No wallet connected');
    try {
      await p.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
      const accounts = await p.request({ method: 'eth_requestAccounts' });
      if (accounts?.[0]) {
        setAccount(accounts[0]);
        toast.success('Wallet switched');
      }
    } catch (err) {
      if (err?.code !== 4001 && err?.code !== 'ACTION_REJECTED') toast.error('Wallet switch failed');
    }
  };

  // ── Capture ?inviter= from URL and persist to localStorage ──
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const params = new URLSearchParams(window.location.search);
      const inviter = params.get('inviter');
      if (inviter && /^0x[a-fA-F0-9]{40}$/.test(inviter)) {
        localStorage.setItem('meritx_inviter', inviter.toLowerCase());
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const savedType = localStorage.getItem('meritx_walletType');
    let eth = getActiveProvider();

    if (localStorage.getItem('isWalletConnected') === 'true' && savedType) {
      const raw = getWalletProvider(savedType);
      if (raw) { setActiveProvider(raw); eth = raw; }
    }

    if (!eth) return;

    eth.request({ method: 'eth_accounts' })
      .then((accs) => { if (accs?.[0]) setAccount(accs[0]); })
      .catch(() => {});

    const onAccountsChanged = (accs) => {
      if (accs.length > 0) { setAccount(accs[0]); localStorage.setItem('isWalletConnected', 'true'); }
      else { setAccount(''); localStorage.removeItem('isWalletConnected'); }
    };

    const onChainChanged = (chainId) => {
      const p = getActiveProvider();
      if (!p) return;
      if (Number(chainId) !== Number(CHAIN_ID)) {
        toast('Switching to ' + CHAIN_NAME + '...');
        p.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: CHAIN_ID_HEX }],
        }).catch(() => {
          p.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: CHAIN_ID_HEX,
              chainName: CHAIN_NAME,
              nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
              rpcUrls: [RPC_URL],
              blockExplorerUrls: [EXPLORER_URL],
            }],
          }).catch(() => {});
        });
      }
    };

    eth.on('accountsChanged', onAccountsChanged);
    eth.on('chainChanged', onChainChanged);
    return () => {
      eth.removeListener('accountsChanged', onAccountsChanged);
      eth.removeListener('chainChanged', onChainChanged);
    };
  }, []);

  // ── Drawer data fetch (contract failure isolated) ──
  const fetchDrawerData = useCallback(async () => {
    if (!account || typeof window === 'undefined' || !getActiveProvider()) return;
    if (!isCorrectChain) {
      toast.error(`Please switch to ${CHAIN_NAME} to view portfolio.`);
      return;
    }
    if (!FACTORY_ADDRESS) { setDrawerProjects([]); setDrawerLoading(false); return; }
    setDrawerLoading(true);
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
        setDrawerProjects([]);
        return;
      }

      let hiddenMap = {};
      try { hiddenMap = JSON.parse(localStorage.getItem('meritx-hidden-projects') || '{}'); } catch {}

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
            const stateNum = Number(state);

            if (stateNum === 1 && contribEth <= 0) return null;
            if (contribEth <= 0 && !isOwner) return null;

            const token = new ethers.Contract(tokenAddr, TOKEN_ABI, provider);
            const [name, symbol] = await Promise.all([token.name(), token.symbol()]);

            const endSec = Number(endTime);
            const raisedEth = Number(ethers.utils.formatEther(raised));
            const capEth = Number(ethers.utils.formatEther(softCap));
            const launchDeadlineMs = (endSec + launchWindowSec) * 1000;
            const announceSec = Number(announceTime);
            const noticeEndMs = announceSec > 0 ? (announceSec + preLaunchNoticeSec) * 1000 : 0;
            const launchExpirationMs = announceSec > 0 ? (announceSec + preLaunchNoticeSec + launchExpirationSec) * 1000 : 0;
            const noticeHasElapsed = announceSec > 0 && Date.now() >= noticeEndMs;
            const isNoticeLive = announceSec > 0 && !noticeHasElapsed;

            return {
              address: addr,
              name, symbol,
              state: stateNum,
              contribution: contribEth,
              raised: raisedEth,
              softCap: capEth,
              progress: capEth > 0 ? Math.min((raisedEth / capEth) * 100, 100) : 0,
              isOwner,
              isFinalized: finalized,
              isExpired: stateNum === 2 && Date.now() > launchDeadlineMs,
              isLaunchExpired: announceSec > 0 && noticeHasElapsed && launchExpirationMs > 0 && Date.now() > launchExpirationMs,
              isNoticeLive,
              isAnnounced: announceSec > 0,
              noticeElapsed: noticeHasElapsed,
              isDelisted: !!hiddenMap[addr],
            };
          } catch { return null; }
        })
      );
      setDrawerProjects(results.filter(Boolean));
    } catch {
      setDrawerProjects([]);
    } finally {
      setDrawerLoading(false);
    }
  }, [account, isCorrectChain]);

  // Cooldown ticker — only runs when drawer is visible
  useEffect(() => {
    if (!drawerOpen || cooldownEndAt <= 0) { setCooldownLeft(0); return; }
    const tick = () => {
      const remain = cooldownEndAt - Date.now();
      setCooldownLeft(remain > 0 ? remain : 0);
      return remain;
    };
    if (tick() <= 0) return;
    const id = setInterval(() => { if (tick() <= 0) clearInterval(id); }, 1000);
    return () => clearInterval(id);
  }, [drawerOpen, cooldownEndAt]);

  useEffect(() => {
    const ms = gasAlloc.cooldown?.remainMs || 0;
    setCooldownEndAt(ms > 0 ? Date.now() + ms : 0);
  }, [gasAlloc.cooldown?.remainMs]);

  useEffect(() => {
    if (!account) {
      prevPogAccountRef.current = '';
      pogPromptedRef.current = false;
      setPogModalOpen(false);
      return;
    }
    if (prevPogAccountRef.current && prevPogAccountRef.current.toLowerCase() !== account.toLowerCase()) {
      pogPromptedRef.current = false;
    }
    prevPogAccountRef.current = account;

    if (!pogPromptedRef.current) {
      pogPromptedRef.current = true;
      try {
        const key = `meritx_pog_cleared_${account.toLowerCase()}`;
        if (localStorage.getItem(key)) return;
      } catch (_) {}
      const timer = setTimeout(() => setPogModalOpen(true), 500);
      return () => clearTimeout(timer);
    }
  }, [account]);

  const openDrawer = () => {
    setDrawerOpen(true);
    fetchDrawerData();
  };

  const handleClaim = async (addr) => {
    const p = getActiveProvider();
    if (!p) return toast.error('Wallet not connected.');
    try {
      const walletChain = Number(await p.request({ method: 'eth_chainId' }));
      if (walletChain !== CHAIN_ID) { toast.error(`Wrong network — switch to ${CHAIN_NAME} first.`); return; }
    } catch { /* proceed and let tx error handle it */ }
    setActionAddr(addr);
    try {
      const { contract } = getSignerContract(addr, FUND_ABI);
      const tx = await contract.claimTokens({ gasLimit: 300000 });
      toast('Claiming tokens...');
      await tx.wait();
      toast.success('Agent tokens claimed');
      fetchDrawerData();
    } catch (err) {
      handleTxError(err);
    } finally { setActionAddr(null); }
  };

  const handleRefund = async (addr) => {
    const p = getActiveProvider();
    if (!p) return toast.error('Wallet not connected.');
    try {
      const walletChain = Number(await p.request({ method: 'eth_chainId' }));
      if (walletChain !== CHAIN_ID) { toast.error(`Wrong network — switch to ${CHAIN_NAME} first.`); return; }
    } catch { /* proceed and let tx error handle it */ }
    setActionAddr(addr);
    try {
      const { contract } = getSignerContract(addr, FUND_ABI);
      const tx = await contract.claimRefund({ gasLimit: 300000 });
      toast('Processing refund...');
      await tx.wait();
      toast.success('Refund claimed');
      fetchDrawerData();
    } catch (err) {
      handleTxError(err);
    } finally { setActionAddr(null); }
  };

  // ---- Categorize projects into tabs ----
  const { active, claimable, refunds, hasLiveNotice } = useMemo(() => {
    const active = [];
    const claimable = [];
    const refunds = [];
    let hasLiveNotice = false;

    for (const p of drawerProjects) {
      if (p.isNoticeLive) hasLiveNotice = true;

      if (p.state >= 3 && p.isFinalized && p.contribution > 0) {
        claimable.push(p);
        continue;
      }

      if (
        (p.state === 1 && p.contribution > 0) ||
        (p.state === 2 && p.isExpired && p.contribution > 0) ||
        (p.state === 2 && p.isLaunchExpired && p.contribution > 0)
      ) {
        refunds.push(p);
        continue;
      }

      if (p.state === 1) continue;

      if (p.state === 0 || (p.state === 2 && p.isNoticeLive)) {
        active.push(p);
        continue;
      }

      if (p.state === 2 || p.state >= 3) {
        active.push(p);
        continue;
      }
    }

    return { active, claimable, refunds, hasLiveNotice };
  }, [drawerProjects]);

  const totalCount = active.length + claimable.length + refunds.length;
  const totalInvested = useMemo(() => drawerProjects.reduce((s, p) => s + (p.contribution || 0), 0), [drawerProjects]);

  if (pathname === '/admin') return null;

  return (
    <>
      <nav className="sticky top-0 z-50 w-full border-b border-zinc-800/60 bg-zinc-950/80 backdrop-blur-xl">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/" className="text-lg font-black text-white tracking-tighter">
              Merit<span className="text-blue-500">X</span>
            </Link>
            <div className="hidden sm:flex items-center gap-1 text-[11px] font-mono">
              <Link href="/" className={`px-3 py-1.5 rounded-md transition-colors ${pathname === '/' ? 'text-blue-400 bg-blue-500/10' : 'text-zinc-500 hover:text-zinc-300'}`}>
                Agent Directory
              </Link>
              <Link href="/launch" className={`px-3 py-1.5 rounded-md transition-colors ${pathname === '/launch' ? 'text-blue-400 bg-blue-500/10' : 'text-zinc-500 hover:text-zinc-300'}`}>
                Agent Tokenization
              </Link>
              {/* Leaderboard hidden — requires off-chain indexer */}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden sm:inline text-[9px] text-zinc-600 font-mono tracking-wider">{CHAIN_NAME}</span>
            {account ? (
              <button onClick={openDrawer} className="group flex items-center gap-2 px-3 py-1.5 rounded-lg border border-zinc-700 bg-zinc-900 hover:border-blue-500/40 transition-all text-xs font-mono">
                {hasLiveNotice && <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />}
                {!hasLiveNotice && <span className="w-2 h-2 rounded-full bg-blue-500" />}
                <span className="text-zinc-400 group-hover:text-white transition-colors">{account.slice(0, 6)}...{account.slice(-4)}</span>
              </button>
            ) : (
              <button onClick={() => setWalletModalOpen(true)} className="px-4 py-1.5 rounded-lg border border-blue-500/40 text-blue-400 text-xs font-bold uppercase tracking-wider hover:bg-blue-600 hover:text-white transition-all animate-[pulseGlow_2s_ease-in-out_infinite] shadow-[0_0_8px_rgba(59,130,246,0.3)]">
                CONNECT WALLET
              </button>
            )}
          </div>
        </div>
      </nav>

      {/* ---- Smart Wallet Drawer ---- */}
      <AnimatePresence>
        {drawerOpen && (
          <motion.div
            key="drawer-root"
            className="fixed inset-0 z-[100]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            {/* Backdrop */}
            <div
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
              onClick={() => setDrawerOpen(false)}
            />

            {/* Drawer panel */}
            <motion.div
              className="absolute right-0 top-0 h-full w-80 z-[1] bg-zinc-950 border-l border-zinc-800/80 shadow-[0_0_80px_rgba(0,0,0,0.6)] flex flex-col"
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 30, stiffness: 300 }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="p-5 pb-4 border-b border-zinc-800/60 shrink-0">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h2 className="text-sm font-black text-white uppercase tracking-widest">My Profile</h2>
                    <p className="text-[10px] text-zinc-600 font-mono mt-0.5">{CHAIN_NAME}</p>
                  </div>
                  <button
                    onClick={() => setDrawerOpen(false)}
                    className="w-8 h-8 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-500 hover:text-white hover:border-zinc-600 transition-all"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                  </button>
                </div>

                {/* Operator Identity */}
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-600/20 to-purple-600/20 border border-blue-500/20 flex items-center justify-center">
                    <span className="text-blue-400 font-black text-sm">{account ? account.slice(2, 4).toUpperCase() : '--'}</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-mono text-zinc-300 truncate">{truncAddr(account, 10, 6)}</p>
                    {hasLiveNotice && (
                      <p className="flex items-center gap-1 text-[9px] font-bold text-cyan-400 uppercase tracking-widest mt-0.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                        Live T-Minus Active
                      </p>
                    )}
                  </div>
                  <div className="flex gap-1.5 shrink-0">
                    <button
                      onClick={switchWallet}
                      className="w-8 h-8 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-500 hover:text-blue-400 hover:border-blue-500/30 transition-all"
                      title="Switch Wallet"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M16 3h5v5M4 20L21 3M21 16v5h-5M4 4l17 17"/></svg>
                    </button>
                    <button
                      onClick={disconnectWallet}
                      className="w-8 h-8 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-500 hover:text-red-400 hover:border-red-500/30 transition-all"
                      title="Disconnect"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>
                    </button>
                  </div>
                </div>
              </div>

              {/* ═══ HUD Tactical Panel — pinned below header ═══ */}
              <div className="px-4 pt-4 pb-2 shrink-0">
                <div className="rounded-lg border border-zinc-800/70 bg-zinc-900/50 p-3">
                  {gasAlloc.isLoading && !gasAlloc.isLoaded ? (
                    <div className="flex items-center justify-center gap-2 py-4">
                      <span className="w-3 h-3 border border-cyan-500/50 border-t-cyan-400 rounded-full animate-spin" />
                      <span className="text-cyan-500/60 font-mono text-[9px] animate-pulse tracking-wider">SCANNING MULTI-CHAIN...</span>
                    </div>
                  ) : (
                    <>
                      {/* Hero — Total Exposure */}
                      <div className="mb-3">
                        <div className="text-emerald-500/70 font-mono text-[9px] font-bold tracking-widest mb-1">TOTAL EXPOSURE</div>
                        <div className="text-emerald-300 font-mono text-2xl font-black tabular-nums tracking-tight leading-none">
                          {totalInvested.toFixed(4)}
                          <span className="text-sm text-emerald-600 ml-1">ETH</span>
                        </div>
                      </div>

                      {/* Terminal Stats */}
                      <div className="border-t border-zinc-800/50 pt-2.5 space-y-1.5">
                        <div className="flex justify-between items-center">
                          <span className="text-zinc-500 font-mono text-[10px]">GAS BURNED</span>
                          <span className="text-orange-400 font-mono text-xs font-bold tabular-nums">
                            {gasAlloc.isLoaded ? gasAlloc.totalGas.toFixed(4) : '—'} ETH
                          </span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-zinc-500 font-mono text-[10px]">MAX ALLOC</span>
                          <span className="text-cyan-400 font-mono text-xs font-bold tabular-nums">
                            {gasAlloc.isLoaded ? gasAlloc.maxAllocation.toFixed(4) : '—'} ETH
                          </span>
                        </div>
                      </div>

                      {/* Status Indicator */}
                      <div className="border-t border-zinc-800/50 pt-2 mt-2.5">
                        {cooldownLeft > 0 ? (
                          <div className="text-red-500 font-mono text-xs flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                            <span className="font-bold tracking-wider text-[9px]">ON COOLDOWN</span>
                            <span className="ml-auto font-black tabular-nums text-[11px]">[ {formatCooldown(cooldownLeft)} ]</span>
                          </div>
                        ) : (
                          <div className="text-emerald-500 font-mono text-xs flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full bg-emerald-500 drop-shadow-[0_0_6px_rgba(16,185,129,0.6)]" />
                            <span className="font-bold tracking-wider text-[9px]">STATUS: READY TO DEPLOY</span>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* ═══ Syndicate Recruitment — pinned below HUD ═══ */}
              <div className="px-4 pt-1 pb-3 shrink-0">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-blue-500/80 font-mono text-[10px] font-bold tracking-widest">/// SYNDICATE RECRUITMENT</span>
                  <span className="text-yellow-400 bg-yellow-400/10 px-1.5 py-0.5 rounded text-[9px] font-mono font-bold border border-yellow-500/20 tabular-nums">0 PTS</span>
                </div>
                {account ? (
                  <>
                    <div className="flex gap-1.5">
                      <input
                        readOnly
                        value={`${process.env.NEXT_PUBLIC_APP_URL || (typeof window !== 'undefined' ? window.location.origin : '')}/?inviter=${account}`}
                        className="bg-zinc-900 border border-zinc-800 text-zinc-500 text-[9px] px-2 py-1.5 rounded-md w-full font-mono outline-none truncate"
                      />
                      <button
                        onClick={() => {
                          const origin = process.env.NEXT_PUBLIC_APP_URL || window.location.origin;
                          const link = `${origin}/?inviter=${account}`;
                          navigator.clipboard.writeText(link).then(() => {
                            setCopied(true);
                            setTimeout(() => setCopied(false), 2000);
                          }).catch(() => toast.error('Failed to copy'));
                        }}
                        className={`px-2.5 py-1.5 rounded-md text-[9px] font-mono font-bold shrink-0 border transition-all duration-200 ${copied ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/50 scale-95 shadow-[inset_0_0_8px_rgba(16,185,129,0.15)]' : 'bg-blue-600/20 text-blue-400 border-blue-500/30 hover:bg-blue-600/30 active:scale-95'}`}
                      >
                        {copied ? 'COPIED' : 'COPY'}
                      </button>
                    </div>
                    <p className="text-zinc-700 text-[9px] font-mono mt-1">Recruit agents to earn Merit Points.</p>
                  </>
                ) : (
                  <p className="text-zinc-600 font-mono text-[10px] border border-dashed border-zinc-800 rounded-md py-2 text-center">CONNECT WALLET</p>
                )}
              </div>

              {/* ═══ Tactical Divider ═══ */}
              <div className="mx-4 border-b border-zinc-800/80 shrink-0" />

              {/* ═══ Agent Lists — scrollable zone ═══ */}
              <div className="flex-1 overflow-y-auto px-4 pt-4 pb-2 min-h-0">
                {drawerLoading ? (
                  <div className="flex flex-col items-center justify-center py-12 gap-3">
                    <span className="w-5 h-5 border-2 border-zinc-700 border-t-blue-500 rounded-full animate-spin" />
                    <span className="text-zinc-600 text-[10px] font-mono tracking-wider">Scanning on-chain state...</span>
                  </div>
                ) : (
                  <div className="space-y-0">
                    {/* /// ACTIVE DEPLOYMENTS */}
                    <div className="text-emerald-400/80 font-mono text-[10px] font-bold tracking-widest mb-2">/// ACTIVE DEPLOYMENTS</div>
                    {active.length > 0 ? (
                      <div className="divide-y divide-zinc-800/40 mb-1">
                        {active.map((p) => (
                          <DrawerCard key={p.address} p={p} actionAddr={actionAddr} onClaim={handleClaim} onRefund={handleRefund} />
                        ))}
                      </div>
                    ) : (
                      <div className="py-3 mb-1 text-center border border-dashed border-zinc-800/50 rounded-lg">
                        <p className="text-[9px] font-mono text-zinc-700 tracking-wider">[ 0 ACTIVE DEPLOYMENTS ]</p>
                      </div>
                    )}

                    {/* /// READY TO CLAIM */}
                    <div className="text-purple-400 font-mono text-[10px] font-bold tracking-widest mb-2 mt-5">/// READY TO CLAIM</div>
                    {claimable.length > 0 ? (
                      <div className="divide-y divide-zinc-800/40 mb-1">
                        {claimable.map((p) => (
                          <div key={p.address} className="rounded-lg border border-purple-500/20 bg-purple-500/[0.03] shadow-[0_0_12px_rgba(168,85,247,0.06)] -mx-1 px-1">
                            <DrawerCard p={p} actionAddr={actionAddr} onClaim={handleClaim} onRefund={handleRefund} />
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="py-3 mb-1 text-center border border-dashed border-zinc-800/50 rounded-lg">
                        <p className="text-[9px] font-mono text-zinc-700 tracking-wider">[ 0 CLAIMABLE ]</p>
                      </div>
                    )}

                    {/* /// ARCHIVED & REFUNDS */}
                    <div className="text-zinc-600 font-mono text-[10px] font-bold tracking-widest mb-2 mt-5">/// ARCHIVED &amp; REFUNDS</div>
                    {refunds.length > 0 ? (
                      <div className="divide-y divide-zinc-800/40">
                        {refunds.map((p) => (
                          <DrawerCard key={p.address} p={p} actionAddr={actionAddr} onClaim={handleClaim} onRefund={handleRefund} />
                        ))}
                      </div>
                    ) : (
                      <div className="py-3 text-center border border-dashed border-zinc-800/50 rounded-lg">
                        <p className="text-[9px] font-mono text-zinc-700 tracking-wider">[ 0 REFUNDS ]</p>
                      </div>
                    )}
                  </div>
                )}
              </div>

            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ---- Wallet Selection Modal ---- */}
      <AnimatePresence>
        {walletModalOpen && (
          <motion.div
            key="wallet-modal-root"
            className="fixed inset-0 z-[200] flex items-center justify-center"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setWalletModalOpen(false)} />
            <motion.div
              className="relative z-[1] w-[90vw] max-w-[380px] mx-auto rounded-2xl border border-zinc-800 bg-zinc-950 shadow-[0_0_60px_rgba(0,0,0,0.8)] p-5"
              initial={{ scale: 0.92, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.92, opacity: 0 }}
              transition={{ type: 'spring', damping: 25, stiffness: 400 }}
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-black text-white uppercase tracking-widest">CONNECT WALLET</h3>
                <button onClick={() => setWalletModalOpen(false)} className="w-7 h-7 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-500 hover:text-white transition-colors">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
              </div>
              <p className="text-[10px] text-zinc-600 font-mono mb-4">Select your preferred wallet provider.</p>
              <div className="grid grid-cols-2 gap-2.5">
                {getSupportedWallets().map(({ key, label, icon }) => (
                  <button
                    key={key}
                    onClick={() => connectWithType(key)}
                    className="flex items-center gap-2.5 px-3 py-3 rounded-xl border border-zinc-800 bg-zinc-900/50 text-zinc-300 text-[11px] font-mono font-bold hover:bg-zinc-800 hover:border-blue-500/50 hover:text-white transition-all group"
                  >
                    <img src={icon} alt={label} className="w-7 h-7 rounded-lg shrink-0" />
                    <span className="leading-tight whitespace-nowrap">{label}</span>
                  </button>
                ))}
              </div>
              <p className="text-[9px] text-zinc-700 font-mono mt-3 text-center">EIP-1193 compatible · {CHAIN_NAME}</p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <PogUnlockModal
        isOpen={pogModalOpen}
        onClose={() => setPogModalOpen(false)}
        account={account}
      />
    </>
  );
}
