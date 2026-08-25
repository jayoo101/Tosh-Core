'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import { ethers } from 'ethers';
import toast from 'react-hot-toast';
import {
  ExternalLink, Clock, Shield, Rocket, Megaphone,
  Wallet, Timer, AlertTriangle, CheckCircle2,
  Globe, Twitter, Send, MessageSquare, Share2,
} from 'lucide-react';
import { CHAIN_ID, CHAIN_NAME, MAX_INVEST_ETH, EXPLORER_URL } from '@/lib/constants';
import { useNetwork } from '@/lib/useNetwork';
import { useWallet } from '@/hooks/useWallet';
import { useGasAllocation } from '@/hooks/useGasAllocation';
import { useFundData } from '@/hooks/useFundData';
import { useUserContribution } from '@/hooks/useUserContribution';
import { useCountdown } from '@/hooks/useCountdown';
import { fmtEth, fmtEthSmart, truncAddr, fmtUTC } from '@/lib/fmt';
import { FUND_ABI } from '@/lib/abis';
import { requireWallet, getSignerContract, handleTxError } from '@/lib/web3';
import { getActiveProvider } from '@/lib/walletProvider';
import IpfsImage from '@/components/IpfsImage';
import FinalizedDashboard from '@/components/FinalizedDashboard';


const TX_WAIT_TIMEOUT_MS = 90_000;
const TX_TIMEOUT_MSG = 'Transaction is taking longer than expected. Check your wallet or block explorer for status.';

function waitWithTimeout(txPromise) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('TX_WAIT_TIMEOUT')), TX_WAIT_TIMEOUT_MS);
  });
  return Promise.race([txPromise, timeout]).finally(() => clearTimeout(timer));
}

function safeHref(url) {
  if (!url || typeof url !== 'string') return null;
  const t = url.trim();
  return /^https?:\/\//i.test(t) ? t : null;
}

export default function InvestPage() {
  const params = useParams();
  const address = params?.address;

  const { account, connectWallet } = useWallet();
  const gasAlloc = useGasAllocation(account);
  const { project, loadError, isLoading, refresh: refreshFund } = useFundData(address);
  const { contribution: myContribution, rawContribution: myContributionWei, refresh: refreshContribution } = useUserContribution(address, account);

  const [amount, setAmount] = useState('');
  const [walletBalanceWei, setWalletBalanceWei] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processStatus, setProcessStatus] = useState('');
  const [investSuccess, setInvestSuccess] = useState(false);
  const [investError, setInvestError] = useState('');
  const [isRefunding, setIsRefunding] = useState(false);
  const [isClaimingTokens, setIsClaimingTokens] = useState(false);
  const [claimedSuccess, setClaimedSuccess] = useState(false);
  const [isLaunching, setIsLaunching] = useState(false);
  const [isAnnouncing, setIsAnnouncing] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const txLockRef = useRef(false);
  const pendingTimers = useRef([]);

  useEffect(() => {
    setIsMounted(true);
    return () => { pendingTimers.current.forEach(clearTimeout); };
  }, []);

  const { isCorrectChain } = useNetwork();

  useEffect(() => {
    if (!address || !ethers.utils.isAddress(address)) return;
    let provider;
    try {
      const raw = getActiveProvider();
      if (!raw) return;
      provider = new ethers.providers.Web3Provider(raw);
    } catch { return; }
    const fund = new ethers.Contract(address, FUND_ABI, provider);
    const onGrief = () => {
      toast.error('Network attack detected — pool creation aborted. Your funds are 100% safe. Refund now available.', { duration: 12000 });
      refreshFund();
    };
    fund.on('PoolGriefDetected', onGrief);
    return () => { fund.removeListener('PoolGriefDetected', onGrief); };
  }, [address, refreshFund]);

  useEffect(() => {
    if (!account) { setWalletBalanceWei(null); return; }
    const p = getActiveProvider();
    if (!p) return;
    let cancelled = false;
    const web3 = new ethers.providers.Web3Provider(p);
    web3.getBalance(account).then((b) => { if (!cancelled) setWalletBalanceWei(b); }).catch(() => {});
    return () => { cancelled = true; };
  }, [account, investSuccess]);

  const realAllocEth = gasAlloc.isLoaded && gasAlloc.maxAllocation > 0
    ? gasAlloc.maxAllocation
    : Number(MAX_INVEST_ETH);
  const realAllocStr = realAllocEth.toFixed(18);
  const maxInvest = realAllocEth;
  const amountNum = Number(amount) || 0;
  const maxAllocWei = ethers.utils.parseEther(realAllocStr);
  const remainingWei = maxAllocWei.sub(myContributionWei);
  const safeRemainingWei = remainingWei.isNegative() ? ethers.constants.Zero : remainingWei;
  const remaining = Number(ethers.utils.formatEther(safeRemainingWei));
  const maxReached = safeRemainingWei.isZero() || myContribution > 0;
  const isOverMax = maxReached || (amountNum + myContribution) > maxInvest;
  const smartMaxWei = walletBalanceWei !== null
    ? (safeRemainingWei.lt(walletBalanceWei) ? safeRemainingWei : walletBalanceWei)
    : safeRemainingWei;
  const smartMax = Number(ethers.utils.formatEther(smartMaxWei));

  // 24h Crucible countdown (raise end time)
  const { countdown, isEnded, isCritical } = useCountdown(
    project?.endTime,
    !!project && project.state === 0
  );

  // 6h deployment notice countdown
  const { countdown: launchCountdown } = useCountdown(
    project?.noticeEndMs,
    !!(project?.noticeEndMs && project.noticeEndMs > 0)
  );

  const refreshAll = useCallback(() => {
    refreshFund();
    refreshContribution();
  }, [refreshFund, refreshContribution]);

  const connectWalletWithToast = useCallback(async () => {
    try {
      await connectWallet();
    } catch (err) {
      if (err?.code !== 4001 && err?.code !== 'ACTION_REJECTED') toast.error(err?.message || 'Wallet connection failed');
    }
  }, [connectWallet]);

  const handleInvest = useCallback(async () => {
    if (txLockRef.current) return;
    const inputAmt = Number(amount) || 0;
    const currentTotal = Number(myContribution) || 0;
    const limit = realAllocEth;

    if (currentTotal > 0) {
      setInvestError('Your exclusive allocation for this project is already locked on-chain.');
      return;
    }
    if (inputAmt <= 0 || inputAmt > limit) {
      setInvestError(inputAmt <= 0 ? 'Enter a valid ETH amount' : `Blocked: ${inputAmt.toFixed(4)} ETH exceeds your allocation of ${limit.toFixed(4)} ETH`);
      return;
    }
    if (!requireWallet() || !account) { setInvestError('Wallet not connected.'); return; }
    if (!isCorrectChain) {
      toast.error(`Wrong network — switch to ${CHAIN_NAME} first.`);
      return;
    }

    txLockRef.current = true;
    setIsProcessing(true);
    setInvestSuccess(false);
    setInvestError('');

    try {
      const { signer, contract: fundContract } = getSignerContract(address, FUND_ABI);
      const userAddress = await signer.getAddress();

      let currentContribution;
      try {
        currentContribution = await fundContract.contributions(userAddress);
      } catch {
        setInvestError('RPC node unavailable — please refresh the page or try again in a moment.');
        setIsProcessing(false);
        return;
      }

      const investWei = ethers.utils.parseEther(amount);
      const newTotal = ethers.BigNumber.from(currentContribution).add(investWei);
      const onChainLimit = ethers.utils.parseEther(MAX_INVEST_ETH);

      if (newTotal.gt(onChainLimit)) {
        const alreadyEth = ethers.utils.formatEther(currentContribution);
        setInvestError(`On-chain limit enforced: you have already contributed ${alreadyEth} ETH. Your gas-based allocation is ${realAllocEth.toFixed(4)} ETH.`);
        setIsProcessing(false);
        refreshContribution();
        return;
      }

      setProcessStatus('GETTING ALLOCATION...');
      const sigRes = await fetch('/api/sign-allocation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userAddress, fundAddress: address }),
      });
      const sigData = await sigRes.json();
      if (!sigData.success) {
        const msg = sigRes.status === 429 ? `Allocation cooldown active: ${sigData.error || 'Try again later.'}` : (sigData.error || 'Signature request failed');
        setInvestError(msg);
        toast.error(msg);
        setIsProcessing(false);
        setProcessStatus('');
        return;
      }

      const { signature, maxAllocation, deadline } = sigData.data;

      setProcessStatus('CONFIRM IN WALLET...');
      const txArgs = [maxAllocation, deadline, signature];
      const txOverrides = { value: investWei };

      try {
        const estimated = await fundContract.estimateGas.contribute(...txArgs, txOverrides);
        txOverrides.gasLimit = estimated.mul(120).div(100);
      } catch {
        // estimation failed — let wallet decide gas
      }

      const tx = await fundContract.contribute(...txArgs, txOverrides);
      setProcessStatus('PROCESSING ON-CHAIN...');
      toast('Transaction pending...');
      await waitWithTimeout(tx.wait());

      setProcessStatus('');
      toast.success('Contribution confirmed on-chain');
      setInvestSuccess(true);
      setAmount('');
      refreshAll();
      fetch(`/api/gas-stats?address=${account}&force=true`).catch(() => {});
      pendingTimers.current.push(setTimeout(() => {
        setInvestSuccess(false);
        setProcessStatus('');
      }, 3000));
    } catch (err) {
      if (err?.message === 'TX_WAIT_TIMEOUT') {
        setProcessStatus('');
        toast.error(TX_TIMEOUT_MSG);
      } else {
        setProcessStatus('');
        setInvestError(handleTxError(err, { showToast: false }));
        pendingTimers.current.push(setTimeout(() => setInvestError(''), 5000));
      }
    } finally {
      setIsProcessing(false);
      txLockRef.current = false;
    }
  }, [address, account, amount, myContribution, isCorrectChain, refreshAll, refreshContribution]);

  const handleRefund = useCallback(async () => {
    if (txLockRef.current) return;
    if (!requireWallet() || !account) return;
    if (!isCorrectChain) { toast.error(`Wrong network — switch to ${CHAIN_NAME} first.`); return; }
    txLockRef.current = true;
    setIsRefunding(true);
    try {
      const { provider, contract } = getSignerContract(address, FUND_ABI);
      const balBefore = await provider.getBalance(account);
      console.log('[Refund] Pre-balance:', ethers.utils.formatEther(balBefore), 'ETH');

      const tx = await contract.claimRefund();
      console.log('[Refund] TX hash:', tx.hash);
      toast('Processing refund...');

      const receipt = await waitWithTimeout(tx.wait());
      console.log('[Refund] Confirmed in block', receipt.blockNumber, '| status:', receipt.status);

      if (receipt.status === 0) {
        toast.error('Transaction was mined but reverted on-chain. Check block explorer.');
        return;
      }

      const balAfter = await provider.getBalance(account);
      const refunded = balAfter.sub(balBefore);
      console.log('[Refund] Post-balance:', ethers.utils.formatEther(balAfter), 'ETH | delta:', ethers.utils.formatEther(refunded), 'ETH');

      toast.success(`Refund confirmed — +${ethers.utils.formatEther(refunded.abs())} ETH (incl. gas)`);
      refreshAll();
    } catch (err) {
      if (err?.message === 'TX_WAIT_TIMEOUT') { toast.error(TX_TIMEOUT_MSG); }
      else { console.error('[Refund] Failed:', err); handleTxError(err); }
    } finally {
      setIsRefunding(false);
      txLockRef.current = false;
    }
  }, [address, account, isCorrectChain, refreshAll]);

  const handleClaimTokens = useCallback(async () => {
    if (txLockRef.current) return;
    if (!requireWallet() || !account) return;
    if (!isCorrectChain) { toast.error(`Wrong network — switch to ${CHAIN_NAME} first.`); return; }
    txLockRef.current = true;
    setIsClaimingTokens(true);
    try {
      const { contract } = getSignerContract(address, FUND_ABI);
      const tx = await contract.claimTokens();
      toast('Claiming agent tokens...');
      await waitWithTimeout(tx.wait());
      toast.success('Agent tokens claimed successfully');
      setClaimedSuccess(true);
      refreshAll();
    } catch (err) {
      if (err?.message === 'TX_WAIT_TIMEOUT') toast.error(TX_TIMEOUT_MSG);
      else handleTxError(err);
    } finally {
      setIsClaimingTokens(false);
      txLockRef.current = false;
    }
  }, [address, account, isCorrectChain, refreshAll]);

  const handleAnnounce = useCallback(async () => {
    if (txLockRef.current) return;
    if (!requireWallet() || !account) return;
    if (!isCorrectChain) { toast.error(`Wrong network — switch to ${CHAIN_NAME} first.`); return; }
    txLockRef.current = true;
    setIsAnnouncing(true);
    try {
      const { contract } = getSignerContract(address, FUND_ABI);
      const tx = await contract.announceLaunch();
      toast('Announcing launch...');
      await waitWithTimeout(tx.wait());
      toast.success('Deployment notice initiated — 6-hour countdown has begun');
      refreshAll();
    } catch (err) {
      if (err?.message === 'TX_WAIT_TIMEOUT') toast.error(TX_TIMEOUT_MSG);
      else handleTxError(err);
    } finally {
      setIsAnnouncing(false);
      txLockRef.current = false;
    }
  }, [address, account, isCorrectChain, refreshAll]);

  const handleLaunch = useCallback(async () => {
    if (txLockRef.current) return;
    if (!requireWallet() || !account) return;
    if (!isCorrectChain) { toast.error(`Wrong network — switch to ${CHAIN_NAME} first.`); return; }
    txLockRef.current = true;
    setIsLaunching(true);
    try {
      const { contract } = getSignerContract(address, FUND_ABI);
      let gasLimit = ethers.BigNumber.from(3_500_000);
      try {
        const estimated = await contract.estimateGas.finalizeFunding();
        const buffered = estimated.mul(130).div(100);
        gasLimit = buffered.lt(gasLimit) ? gasLimit : buffered;
      } catch { /* estimation failed — use safe default */ }
      const tx = await contract.finalizeFunding({ gasLimit });
      toast('Deploying agent: creating Uniswap V3 pool + locking LP...');
      await waitWithTimeout(tx.wait());
      toast.success('Agent deployed — pool created, LP locked permanently');
      refreshAll();
    } catch (err) {
      if (err?.message === 'TX_WAIT_TIMEOUT') toast.error(TX_TIMEOUT_MSG);
      else handleTxError(err);
    } finally {
      setIsLaunching(false);
      txLockRef.current = false;
    }
  }, [address, account, isCorrectChain, refreshAll]);

  // ─── Validation: invalid address ───
  if (address && !ethers.utils.isAddress(address)) {
    return (
      <div className="min-h-screen text-white font-sans" style={{ background: '#050505' }}>
        <main className="max-w-2xl mx-auto py-20 px-4">
          <div className="rounded-2xl border border-red-500/30 bg-red-950/30 backdrop-blur-sm p-8 text-center">
            <AlertTriangle className="w-10 h-10 text-red-400 mx-auto mb-4" />
            <p className="text-sm font-mono font-bold text-red-400 uppercase tracking-wider mb-2">Invalid Project Address</p>
            <a href="/" className="inline-block text-xs font-semibold text-blue-400 border border-blue-400/30 rounded-full px-5 py-2 hover:bg-blue-400/10 transition-colors mt-4">
              Return to Agent Directory
            </a>
          </div>
        </main>
      </div>
    );
  }

  // ─── Error state ───
  if (loadError) {
    const errMsg = loadError?.message?.includes('rate') || loadError?.message?.includes('429')
      ? 'RPC rate limit reached — please wait and refresh.'
      : loadError?.message || 'Failed to fetch on-chain project data';
    return (
      <div className="min-h-screen text-white font-sans" style={{ background: '#050505' }}>
        <main className="max-w-2xl mx-auto py-20 px-4">
          <div className="rounded-2xl border border-red-500/30 bg-red-950/30 backdrop-blur-sm p-8 text-center">
            <AlertTriangle className="w-10 h-10 text-red-400 mx-auto mb-4" />
            <p className="text-sm font-mono font-bold text-red-400 uppercase tracking-wider mb-2">{errMsg}</p>
            <p className="text-xs text-zinc-500 font-mono mb-6">{address ? `Address: ${truncAddr(address)}` : 'No address provided'}</p>
            <a href="/" className="inline-block text-xs font-semibold text-blue-400 border border-blue-400/30 rounded-full px-5 py-2 hover:bg-blue-400/10 transition-colors">
              Return to Agent Directory
            </a>
          </div>
        </main>
      </div>
    );
  }

  // ─── Loading skeleton ───
  if (isLoading || !project) {
    return (
      <div className="min-h-screen text-zinc-300 font-sans" style={{ background: '#050505' }}>
        <main className="max-w-7xl mx-auto py-12 px-4 md:px-6 lg:px-8">
          <InvestPageSkeleton address={address} />
        </main>
      </div>
    );
  }

  const projectInitial = (project.name || project.symbol || '?').charAt(0).toUpperCase();
  const raisedNum = Number(project.raised);
  const capNum = Number(project.softCap);
  const progressPct = capNum > 0 ? (raisedNum / capNum) * 100 : 0;
  const isOverSubscribed = project.totalRaised && project.rawSoftCap && project.rawSoftCap.gt(0)
    ? project.totalRaised.gte(project.rawSoftCap)
    : false;
  // eslint-disable-next-line eqeqeq
  const canInvest = project.state == 0;
  const now = isMounted ? Date.now() : 0;
  const isExpiredIsolated = project.state === 2 && now > (project.launchDeadline || Infinity);
  const isOwner = account && project.projectOwner && account.toLowerCase() === project.projectOwner.toLowerCase();
  const isAnnounced = project.announcementTime > 0;
  const noticeElapsed = isAnnounced && now >= (project.noticeEndMs || 0);
  const isLaunchExpired = isAnnounced && noticeElapsed && project.launchExpirationMs > 0 && now > project.launchExpirationMs;
  const ownerCanLaunch = isOwner && project.state === 2 && !isExpiredIsolated && !isLaunchExpired;
  const investDisabled = !canInvest || isProcessing || !account || isOverMax || maxReached || !isCorrectChain;
  const isGriefed = !!project.poolGriefed;

  const stateBanner = getStateBanner(project.state, isAnnounced, noticeElapsed, isLaunchExpired, isExpiredIsolated, isGriefed);

  return (
    <div className="min-h-screen text-zinc-300 font-sans selection:bg-blue-600/30" style={{ background: '#050505' }}>
      <main className="max-w-7xl mx-auto py-12 px-4 md:px-6 lg:px-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* ═══════════ LEFT COLUMN — Agent Info & Metrics (2/3) ═══════════ */}
          <div className="lg:col-span-2 flex flex-col gap-6">
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/20 backdrop-blur-md p-6">
              <div className="flex items-start gap-5">
                <div className="relative w-20 h-20 md:w-24 md:h-24 rounded-xl bg-black border border-zinc-800 flex items-center justify-center shrink-0 shadow-inner overflow-hidden">
                  <InvestAvatar src={project.avatarUrl} fallback={projectInitial} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="px-3 py-1.5 rounded-full bg-blue-500/10 border border-blue-500/30 text-[11px] font-mono font-bold text-blue-400">
                      ${project.symbol}
                    </span>
                    <h1 className="text-2xl md:text-3xl font-black text-white truncate">{project.name}</h1>
                  </div>
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    {safeHref(project.socials?.twitter) && (
                      <a href={safeHref(project.socials.twitter)} target="_blank" rel="noopener noreferrer" className="w-9 h-9 rounded-lg bg-zinc-900/80 border border-zinc-700 flex items-center justify-center text-zinc-500 hover:text-blue-400 hover:border-blue-500/50 transition-colors" title="Twitter / X">
                        <Twitter className="w-4 h-4" />
                      </a>
                    )}
                    {(() => {
                      const raw = project.socials?.community || project.socials?.telegram;
                      const href = safeHref(raw);
                      if (!href) return null;
                      const isDiscord = /discord\.(gg|com)/i.test(href);
                      return (
                        <a href={href} target="_blank" rel="noopener noreferrer" className="w-9 h-9 rounded-lg bg-zinc-900/80 border border-zinc-700 flex items-center justify-center text-zinc-500 hover:text-blue-400 hover:border-blue-500/50 transition-colors" title={isDiscord ? 'Discord' : 'Telegram'}>
                          {isDiscord ? <MessageSquare className="w-4 h-4" /> : <Send className="w-4 h-4" />}
                        </a>
                      );
                    })()}
                    {safeHref(project.socials?.website) && (
                      <a href={safeHref(project.socials.website)} target="_blank" rel="noopener noreferrer" className="w-9 h-9 rounded-lg bg-zinc-900/80 border border-zinc-700 flex items-center justify-center text-zinc-500 hover:text-blue-400 hover:border-blue-500/50 transition-colors" title="Website">
                        <Globe className="w-4 h-4" />
                      </a>
                    )}
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(window.location.href).then(() => toast.success('Project link copied to clipboard'));
                      }}
                      className="w-9 h-9 rounded-lg bg-zinc-900/80 border border-zinc-700 flex items-center justify-center text-zinc-500 hover:text-blue-400 hover:border-blue-500/50 hover:bg-white/5 transition-colors"
                      title="Share"
                    >
                      <Share2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
              {project.createdAt > 0 && (
                <p className="mt-3 text-[11px] font-mono text-zinc-600">
                  LAUNCHED: {fmtUTC(project.createdAt)}
                </p>
              )}
            </div>

            {(project.description || project.skillEndpoint) && (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 overflow-hidden">
                <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-3 font-mono">/// Project Manifesto</div>
                {project.description && (
                  <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap break-words overflow-hidden">{project.description}</p>
                )}
                {safeHref(project.skillEndpoint) && (
                  <div className="flex items-center gap-2 p-2.5 mt-4 rounded-lg bg-blue-500/[0.06] border border-blue-500/20">
                    <Globe className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                    <a href={safeHref(project.skillEndpoint)} target="_blank" rel="noopener noreferrer" className="text-blue-400 text-xs font-mono truncate hover:underline">{project.skillEndpoint}</a>
                  </div>
                )}
              </div>
            )}

            <div className={`rounded-xl border px-4 py-3 flex items-center gap-3 ${stateBanner.classes} ${stateBanner.glow}`}>
              <span className={`w-2.5 h-2.5 rounded-full ${stateBanner.dot}`} />
              <span className="text-[11px] font-mono font-bold uppercase tracking-widest">Status: <span>{stateBanner.label}</span></span>
            </div>

            {isGriefed && (
              <div className="rounded-xl border-2 border-red-500/50 bg-red-500/[0.08] p-4 animate-pulse">
                <div className="flex items-center gap-3">
                  <AlertTriangle className="w-6 h-6 text-red-400 shrink-0" />
                  <div>
                    <p className="text-sm font-black text-red-400 font-mono uppercase tracking-wider">Malicious Network Attack Detected</p>
                    <p className="text-xs text-red-300/60 font-mono mt-1">All 4 Uniswap V3 fee-tier pools were front-run by an attacker. Pool creation has been aborted. Smart contract time-locks have been force-released — <span className="text-white font-bold">instant 100% refunds are now available</span>.</p>
                  </div>
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <MetricCard label="Total Sponsored" value={`${fmtEth(raisedNum)} ETH`} accent="text-blue-400" />
              <MetricCard label="Soft Cap" value={`${fmtEthSmart(capNum)} ETH`} sub={<span className="inline-flex items-center gap-1.5 mt-1.5 px-2.5 py-1 rounded-md bg-gradient-to-r from-purple-500/[0.08] to-pink-500/[0.06] border border-purple-500/20 text-[9px] font-bold font-mono text-purple-400 tracking-wider shadow-[0_0_12px_rgba(168,85,247,0.1)]">∞ NO HARD CAP</span>} accent="text-purple-400" />
            </div>

            <div className={`rounded-xl border p-4 ${isOverSubscribed ? 'border-emerald-500/30 bg-emerald-500/[0.03]' : 'border-zinc-800 bg-zinc-900/20'}`}>
              <div className="flex justify-between items-baseline text-sm mb-2.5">
                <span className="text-zinc-400 text-[10px] font-mono uppercase tracking-widest">IAO Progress</span>
                <span className={`font-mono tabular-nums font-bold ${isOverSubscribed ? 'text-emerald-400' : 'text-white'}`}>{progressPct.toFixed(1)}%</span>
              </div>
              <div className="w-full h-2 bg-zinc-800 rounded-full overflow-hidden relative">
                <div
                  className={[
                    'h-full rounded-full transition-all duration-1000',
                    project.state === 1
                      ? 'bg-red-500/80'
                      : isOverSubscribed
                        ? 'bg-gradient-to-r from-emerald-500 via-cyan-400 to-emerald-500 bg-[length:200%_100%] animate-[bar-flow_2s_linear_infinite] shadow-[0_0_12px_rgba(16,185,129,0.7)]'
                        : 'bg-blue-600 shadow-[0_0_10px_rgba(37,99,235,0.8)]',
                  ].join(' ')}
                  style={{ width: `${Math.min(progressPct, 100)}%` }}
                />
              </div>
              <div className="flex justify-between mt-2 text-[10px] font-mono text-zinc-600">
                <span><span className={isOverSubscribed ? 'text-emerald-500/80' : ''}>{fmtEth(raisedNum)}</span> / <span>{fmtEthSmart(capNum)}</span> ETH</span>
                <span>{isOverSubscribed ? <span className="text-emerald-500/80">STATUS: OVER-SUBSCRIBING</span> : 'TARGET: ∞'}</span>
              </div>
            </div>

            {project.state < 3 && (
              <div className={`relative rounded-xl border p-4 flex items-center gap-4 overflow-hidden ${
                isEnded
                  ? 'border-zinc-800 bg-zinc-900/10'
                  : isCritical
                    ? 'border-red-500/30 bg-red-500/[0.04] shadow-[0_0_30px_rgba(239,68,68,0.08)]'
                    : 'border-white/[0.06] bg-white/[0.02] backdrop-blur-sm'
              }`}>
                {!isEnded && !isCritical && (
                  <div className="absolute inset-0 bg-gradient-to-r from-blue-500/[0.03] via-transparent to-transparent pointer-events-none" />
                )}
                {isCritical && !isEnded && (
                  <div className="absolute inset-0 bg-gradient-to-r from-red-500/[0.06] via-transparent to-transparent pointer-events-none animate-pulse" />
                )}
                <div className={`relative shrink-0 ${isCritical && !isEnded ? 'animate-pulse' : ''}`}>
                  <Timer className={`w-5 h-5 ${isEnded ? 'text-zinc-600' : isCritical ? 'text-red-400 drop-shadow-[0_0_8px_rgba(239,68,68,0.6)]' : 'text-blue-400/60'}`} />
                </div>
                <div className="relative flex-1">
                  <div className={`text-[10px] font-bold uppercase tracking-widest mb-1 font-mono ${isEnded ? 'text-zinc-600' : isCritical ? 'text-red-400/70' : 'text-zinc-500'}`}>
                    {isEnded ? 'Crucible Phase Concluded' : '24h Crucible — Closes In'}
                  </div>
                  <div className={`font-mono tabular-nums font-black text-2xl tracking-tight leading-none ${
                    isEnded ? 'text-zinc-600'
                      : isCritical ? 'text-red-400 drop-shadow-[0_0_12px_rgba(239,68,68,0.6)]'
                      : 'text-white drop-shadow-[0_0_8px_rgba(255,255,255,0.15)]'
                  }`}>
                    {isEnded ? 'PHASE COMPLETE' : (countdown || '00:00:00')}
                  </div>
                </div>
                <div className={`relative flex flex-col items-center gap-1 shrink-0 ${isEnded ? 'text-zinc-600' : isCritical ? 'text-red-400' : 'text-blue-500/70'}`}>
                  <span className="relative flex h-2.5 w-2.5">
                    {!isEnded && (
                      <span className={`animate-ping absolute inset-0 rounded-full opacity-75 ${isCritical ? 'bg-red-400' : 'bg-blue-500'}`} />
                    )}
                    <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${isEnded ? 'bg-zinc-600' : isCritical ? 'bg-red-400 shadow-[0_0_8px_rgba(239,68,68,0.8)]' : 'bg-blue-500 shadow-[0_0_6px_rgba(59,130,246,0.6)]'}`} />
                  </span>
                  <span className="text-[8px] font-mono font-bold tracking-widest">
                    {isEnded ? 'ENDED' : isCritical ? 'URGENT' : 'LIVE'}
                  </span>
                </div>
              </div>
            )}

            {isAnnounced && project.state === 2 && !isExpiredIsolated && !isLaunchExpired && (
              <div key="tminus-banner">
                <TMinusBanner
                  noticeElapsed={noticeElapsed}
                  launchCountdown={launchCountdown}
                />
              </div>
            )}

          </div>

          {/* ═══════════ RIGHT COLUMN — Action Terminal + Dashboard (1/3, sticky) ═══════════ */}
          <div className="lg:col-span-1">
            <div className="sticky top-24 flex flex-col gap-6">
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/20 p-6 shadow-2xl shadow-blue-900/10 backdrop-blur-md">
                <ActionTerminal
                  project={project}
                  account={account}
                  isGriefed={isGriefed}
                  myContribution={myContribution}
                  amount={amount}
                  setAmount={setAmount}
                  remaining={remaining}
                  smartMax={smartMax}
                  smartMaxWei={smartMaxWei}
                  maxReached={maxReached}
                  isOverMax={isOverMax}
                  maxInvest={maxInvest}
                  gasAllocLoaded={gasAlloc.isLoaded}
                  investDisabled={investDisabled}
                  isProcessing={isProcessing}
                  processStatus={processStatus}
                  investSuccess={investSuccess}
                  investError={investError}
                  canInvest={canInvest}
                  isRefunding={isRefunding}
                  isClaimingTokens={isClaimingTokens}
                  claimedSuccess={claimedSuccess}
                  isAnnouncing={isAnnouncing}
                  isLaunching={isLaunching}
                  isCorrectChain={isCorrectChain}
                  isExpiredIsolated={isExpiredIsolated}
                  isLaunchExpired={isLaunchExpired}
                  ownerCanLaunch={ownerCanLaunch}
                  isAnnounced={isAnnounced}
                  noticeElapsed={noticeElapsed}
                  launchCountdown={launchCountdown}
                  raisedNum={raisedNum}
                  connectWallet={connectWalletWithToast}
                  handleInvest={handleInvest}
                  handleRefund={handleRefund}
                  handleClaimTokens={handleClaimTokens}
                  handleAnnounce={handleAnnounce}
                  handleLaunch={handleLaunch}
                />
              </div>

              {project.state >= 3 && (
                <FinalizedDashboard
                  tokenAddress={project.tokenAddress}
                  poolAddress={project.poolAddress}
                />
              )}
            </div>
          </div>
        </div>
      </main>

    </div>
  );
}

function InvestAvatar({ src, fallback }) {
  return (
    <IpfsImage
      src={src}
      alt={`${fallback} avatar`}
      fallback={<span className="text-4xl md:text-5xl font-black text-blue-500">{fallback}</span>}
    />
  );
}

function InvestPageSkeleton({ address }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 5000);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
      <div className="lg:col-span-2 flex flex-col gap-6">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/20 p-6 animate-pulse">
          <div className="flex items-start gap-5">
            <div className="w-20 h-20 rounded-xl bg-zinc-800" />
            <div className="flex-1 space-y-3">
              <div className="h-6 w-24 bg-zinc-800 rounded" />
              <div className="h-8 w-48 bg-zinc-800 rounded" />
              <div className="flex gap-2 mt-2">
                <div className="w-9 h-9 bg-zinc-800 rounded-lg" />
                <div className="w-9 h-9 bg-zinc-800 rounded-lg" />
                <div className="h-9 w-20 bg-zinc-800 rounded-lg" />
              </div>
            </div>
          </div>
        </div>
        <div className="h-14 rounded-xl bg-zinc-900/40 border border-zinc-800 animate-pulse" />
        <div className="grid grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="rounded-xl border border-zinc-800 bg-zinc-900/20 p-4 animate-pulse">
              <div className="h-3 w-20 bg-zinc-800 rounded mb-2" />
              <div className="h-6 w-16 bg-zinc-800 rounded" />
            </div>
          ))}
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/20 p-4 animate-pulse">
          <div className="flex justify-between mb-2">
            <div className="h-3 w-24 bg-zinc-800 rounded" />
            <div className="h-4 w-12 bg-zinc-800 rounded" />
          </div>
          <div className="h-2 w-full bg-zinc-800 rounded-full" />
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/20 p-4 flex items-center gap-4">
          <div className="w-5 h-5 bg-zinc-800 rounded" />
          <div className="flex-1">
            <div className="h-3 w-32 bg-zinc-800 rounded mb-2" />
            <div className="h-6 w-24 bg-zinc-800 rounded" />
          </div>
          <div className="w-8 h-8 border-2 border-zinc-700 border-t-blue-500 rounded-full animate-spin" />
        </div>
      </div>
      <div className="lg:col-span-1">
        <div className="sticky top-24 rounded-2xl border border-zinc-800 bg-zinc-900/20 p-6 animate-pulse">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-5 h-5 bg-zinc-800 rounded" />
            <div>
              <div className="h-4 w-28 bg-zinc-800 rounded mb-1" />
              <div className="h-3 w-36 bg-zinc-800 rounded" />
            </div>
          </div>
          <div className="h-12 w-full bg-zinc-800 rounded-xl mb-4" />
          <div className="h-12 w-full bg-zinc-800 rounded-xl" />
          <p className="text-center text-zinc-600 text-xs font-mono mt-4 uppercase tracking-wider">
            {slow ? 'NODE CONGESTED, STILL SCANNING...' : 'LOADING IAO DATA'} FOR <span>{truncAddr(address) || '—'}</span>
          </p>
        </div>
      </div>
    </div>
  );
}

function getStateBanner(state, isAnnounced, noticeElapsed, isLaunchExpired, isExpiredIsolated, isGriefed) {
  if (state === 0) return { label: 'IAO Funding Active', classes: 'bg-blue-500/10 border-blue-500/30 text-blue-400', dot: 'bg-blue-500 animate-pulse', glow: 'shadow-[0_0_20px_rgba(37,99,235,0.15)]' };
  if (state === 1 && isGriefed) return { label: 'Network Attack Detected — Immediate Refund', classes: 'bg-red-500/10 border-red-500/30 text-red-400', dot: 'bg-red-500 animate-pulse', glow: 'shadow-[0_0_20px_rgba(239,68,68,0.2)]' };
  if (state === 1) return { label: 'IAO Failed — Refunding', classes: 'bg-red-500/10 border-red-500/30 text-red-400', dot: 'bg-red-500', glow: '' };
  if (state >= 3) return { label: 'Agent Active — DEX Live', classes: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400', dot: 'bg-emerald-500', glow: 'shadow-[0_0_20px_rgba(16,185,129,0.15)]' };
  if (isLaunchExpired) return { label: 'Deployment Expired', classes: 'bg-red-500/10 border-red-500/30 text-red-400', dot: 'bg-red-500', glow: '' };
  if (isExpiredIsolated) return { label: 'Window Expired', classes: 'bg-amber-500/10 border-amber-500/30 text-amber-400', dot: 'bg-amber-500', glow: '' };
  if (isAnnounced && noticeElapsed) return { label: 'Ready to Deploy', classes: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400', dot: 'bg-emerald-500 animate-pulse', glow: 'shadow-[0_0_20px_rgba(16,185,129,0.15)]' };
  if (isAnnounced) return { label: '6h Deployment Notice Active', classes: 'bg-blue-500/10 border-blue-500/30 text-blue-400', dot: 'bg-blue-500 animate-pulse', glow: 'shadow-[0_0_20px_rgba(37,99,235,0.15)]' };
  return { label: 'Strategic Preparation', classes: 'bg-purple-500/10 border-purple-500/30 text-purple-400', dot: 'bg-purple-500', glow: 'shadow-[0_0_20px_rgba(168,85,247,0.15)]' };
}

function MetricCard({ label, value, accent, sub }) {
  const isBlue = accent?.includes('blue');
  return (
    <div className="relative rounded-xl border border-white/[0.06] bg-white/[0.02] backdrop-blur-sm p-4 space-y-1 overflow-hidden">
      <div className={`absolute inset-0 pointer-events-none ${
        isBlue
          ? 'bg-gradient-to-br from-blue-500/[0.04] via-transparent to-transparent'
          : 'bg-gradient-to-br from-purple-500/[0.04] via-transparent to-transparent'
      }`} />
      <p className="relative text-[9px] text-zinc-500 uppercase tracking-widest font-bold font-mono">{label}</p>
      <p className={`relative text-xl font-black font-mono tabular-nums ${accent} ${
        isBlue
          ? 'drop-shadow-[0_0_10px_rgba(59,130,246,0.5)]'
          : 'drop-shadow-[0_0_10px_rgba(168,85,247,0.4)]'
      }`}>{value}</p>
      {sub && <div className="relative">{sub}</div>}
    </div>
  );
}

function TMinusBanner({ noticeElapsed, launchCountdown }) {
  const isGreen = noticeElapsed;
  return (
    <div className={`rounded-xl border p-4 ${isGreen ? 'bg-emerald-500/[0.04] border-emerald-500/20' : 'bg-blue-500/[0.04] border-blue-500/20'}`}>
      <div className="flex items-center justify-between mb-1.5">
        <span className={`text-[10px] font-bold uppercase tracking-widest font-mono ${isGreen ? 'text-emerald-400' : 'text-blue-400'}`}>
          {noticeElapsed ? 'Notice Complete — Deployment Ready' : 'T-Minus — Agent Deployment In'}
        </span>
        <Megaphone className={`w-4 h-4 ${isGreen ? 'text-emerald-400/50' : 'text-blue-400/50'}`} />
      </div>
      <div className={`font-mono tabular-nums font-black text-2xl tracking-wider ${isGreen ? 'text-emerald-400' : 'text-blue-400'}`}>
        {noticeElapsed ? '✓ READY' : launchCountdown || '--:--:--'}
      </div>
      <div className="text-[10px] text-zinc-500 font-mono mt-1.5">
        {noticeElapsed
          ? 'The 6-hour notice period has passed. Agent liquidity can now be deployed.'
          : 'AI Developer initiated deployment notice. All sponsors have advance notice.'}
      </div>
    </div>
  );
}

function ActionTerminal({
  project, account, isGriefed, myContribution, amount, setAmount,
  remaining, smartMax, smartMaxWei, maxReached, isOverMax, maxInvest, gasAllocLoaded,
  investDisabled, isProcessing, processStatus, investSuccess, investError, canInvest,
  isRefunding, isClaimingTokens, claimedSuccess, isAnnouncing, isLaunching, isCorrectChain,
  isExpiredIsolated, isLaunchExpired, ownerCanLaunch, isAnnounced, noticeElapsed,
  launchCountdown, raisedNum,
  connectWallet, handleInvest, handleRefund, handleClaimTokens, handleAnnounce, handleLaunch,
}) {
  if (project.state === 1 && isGriefed) {
    return (
      <div key="action-state-griefed">
        <GriefedRefundPanel
          account={account}
          myContribution={myContribution}
          isRefunding={isRefunding}
          handleRefund={handleRefund}
          connectWallet={connectWallet}
        />
      </div>
    );
  }

  if (project.state === 1) {
    return (
      <div key="action-state-failed">
        <RefundPanel
        title="IAO FAILED"
        subtitle="SOFT CAP NOT REACHED"
        description="The IAO soft cap was not reached within the funding window."
        variant="red"
        account={account}
        myContribution={myContribution}
        isRefunding={isRefunding}
        handleRefund={handleRefund}
        connectWallet={connectWallet}
      />
      </div>
    );
  }

  if (isExpiredIsolated) {
    return (
      <div key="action-state-expired-isolated">
        <RefundPanel
        title="WINDOW EXPIRED"
        subtitle="30-DAY DEADLINE PASSED"
        description="AI Developer failed to deploy within 30 days. Your funds are eligible for a 100% refund."
        variant="amber"
        account={account}
        myContribution={myContribution}
        isRefunding={isRefunding}
        handleRefund={handleRefund}
        connectWallet={connectWallet}
      />
      </div>
    );
  }

  if (isLaunchExpired && project.state === 2) {
    return (
      <div key="action-state-deployment-expired">
        <RefundPanel
        title="DEPLOYMENT EXPIRED"
        subtitle="24H EXECUTION WINDOW CLOSED"
        description="The AI Developer announced but failed to deploy liquidity within the 24-hour execution window."
        variant="red"
        account={account}
        myContribution={myContribution}
        isRefunding={isRefunding}
        handleRefund={handleRefund}
        connectWallet={connectWallet}
      />
      </div>
    );
  }

  if (ownerCanLaunch) {
    return (
      <div key="action-state-owner-launch" className="space-y-5">
        <div className="flex items-center gap-3">
          <Rocket className={`w-5 h-5 ${!isAnnounced ? 'text-blue-400' : noticeElapsed ? 'text-emerald-400' : 'text-blue-400'}`} />
          <div>
            <h3 className="text-base font-black text-white font-mono">
              {!isAnnounced ? 'Ready to Announce' : noticeElapsed ? 'Ready to Deploy' : 'Deployment Notice Active'}
            </h3>
            <p className="text-[10px] text-zinc-500 font-mono uppercase">
              {!isAnnounced ? 'Strategic Preparation Phase' : noticeElapsed ? 'Deploy Agent to Uniswap V3' : 'Waiting for 6h notice period'}
            </p>
          </div>
        </div>

        <div className="p-3.5 rounded-xl bg-amber-500/[0.06] border border-amber-500/20">
          <div className="flex items-center gap-2 mb-1.5">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
            <span className="text-amber-300 text-[10px] font-bold uppercase tracking-wider font-mono">
              {!isAnnounced ? 'Anti-Stealth Protocol' : 'Permanent Action'}
            </span>
          </div>
          <p className="text-amber-300/60 text-[11px] font-mono leading-relaxed">
            {!isAnnounced
              ? 'Initiating starts a 6h public deployment notice. All sponsors see a countdown before agent liquidity deploys.'
              : 'This will lock liquidity forever and enable agent token claims. The LP NFT stays inside the contract permanently.'}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <MiniStat label="Total Raised" value={`${fmtEth(raisedNum)} ETH`} />
          <MiniStat label="Platform Fee" value={`${fmtEth(raisedNum * 0.05)} ETH`} />
        </div>

        {!isAnnounced ? (
          <>
            <ActionBtn onClick={handleAnnounce} disabled={isAnnouncing || !isCorrectChain} loading={isAnnouncing} variant="blue" label="INITIATE 6H DEPLOYMENT NOTICE" loadingLabel="BROADCASTING..." />
            <p className="text-[10px] text-zinc-500 font-mono text-center leading-relaxed">You have up to 30 days to fine-tune models and APIs before initiating the 6-hour deployment notice.</p>
          </>
        ) : noticeElapsed ? (
          <ActionBtn onClick={handleLaunch} disabled={isLaunching || !isCorrectChain} loading={isLaunching} variant="emerald" label="DEPLOY AGENT TO UNISWAP V3" loadingLabel="DEPLOYING AGENT..." />
        ) : (
          <div className="w-full py-4 rounded-xl bg-zinc-800/50 text-center">
            <div className="text-zinc-500 text-xs font-bold uppercase tracking-wider font-mono">Waiting for notice</div>
            <div className="text-blue-400 font-mono text-sm mt-1">{launchCountdown || '--:--:--'}</div>
          </div>
        )}
      </div>
    );
  }

  if (project.state === 2) {
    return (
      <div key="action-state-prep" className="space-y-5">
        <div className="flex items-center gap-3">
          <Shield className="w-6 h-6 text-purple-400" />
          <div>
            <h3 className="text-base font-black text-white font-mono">Strategic Preparation</h3>
            <p className="text-[10px] text-zinc-500 font-mono uppercase tracking-wider">Awaiting Deployment</p>
          </div>
        </div>
        <p className="text-xs text-zinc-500 font-mono leading-relaxed">Funds cryptographically secured. AI Developer has up to 30 days to initiate deployment.</p>
        {account && myContribution > 0 && (
          <PersonalAssetCard
            phase="locked"
            myContribution={myContribution}
            raisedNum={raisedNum}
            symbol={project.symbol}
            isClaimingTokens={false}
            handleClaimTokens={handleClaimTokens}
          />
        )}
      </div>
    );
  }

  if (project.state >= 3) {
    const isClaimed = claimedSuccess || (account && myContribution === 0);
    return (
      <div key="action-state-completed" className="space-y-5">
        <div className="flex items-center gap-3">
          <div className="relative">
            <CheckCircle2 className="w-6 h-6 text-emerald-400" />
            <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-emerald-400 rounded-full animate-ping opacity-60" />
          </div>
          <div>
            <h3 className="text-base font-black text-white font-mono">Agent is Live</h3>
            <p className="text-[10px] text-zinc-500 font-mono uppercase tracking-wider">DEX Liquidity Deployed</p>
          </div>
        </div>

        {account && (claimedSuccess || myContribution > 0) ? (
          <PersonalAssetCard
            phase={isClaimed ? 'claimed' : 'claimable'}
            myContribution={myContribution}
            raisedNum={raisedNum}
            symbol={project.symbol}
            isClaimingTokens={isClaimingTokens}
            handleClaimTokens={handleClaimTokens}
          />
        ) : !account ? (
          <div className="p-4 rounded-xl bg-zinc-800/40 border border-zinc-700/30 text-center">
            <p className="text-xs text-zinc-500 font-mono">Connect wallet to view your assets</p>
            <button onClick={connectWallet} className="mt-3 w-full py-2.5 rounded-lg border border-blue-500/30 text-blue-400 text-xs font-bold font-mono uppercase tracking-wider hover:bg-blue-500/10 transition-colors">
              CONNECT WALLET
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  const hasSponsored = account && myContribution > 0;

  if (hasSponsored) {
    return (
      <div key="action-state-already-sponsored" className="space-y-5">
        <div className="flex items-center gap-3">
          <div className="relative">
            <CheckCircle2 className="w-6 h-6 text-blue-400" />
            <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-blue-400 rounded-full animate-ping opacity-60" />
          </div>
          <div>
            <h3 className="text-base font-black text-white font-mono">Compute Sponsored</h3>
            <p className="text-[10px] text-zinc-500 font-mono uppercase tracking-wider">One-Time Allocation Filled</p>
          </div>
        </div>

        <div className="p-4 rounded-xl bg-blue-500/[0.06] border border-blue-500/20">
          <div className="flex items-center gap-2 mb-2">
            <Shield className="w-4 h-4 text-blue-400" />
            <span className="text-[10px] text-blue-400 font-mono font-bold uppercase tracking-wider">Sponsorship Locked</span>
          </div>
          <p className="text-xs text-zinc-400 font-mono leading-relaxed">
            Your <span className="text-white font-bold">{fmtEth(myContribution)} ETH</span> compute sponsorship is cryptographically secured on-chain.
            Your exclusive allocation for this project is now permanently locked. Awaiting pool deployment.
          </p>
        </div>

        <button
          disabled
          className="w-full py-4 rounded-xl font-black text-sm uppercase tracking-wider font-mono pointer-events-none bg-zinc-800/60 text-zinc-500 border border-zinc-700/40 cursor-not-allowed"
        >
          ALREADY SPONSORED
        </button>

        <PersonalAssetCard
          phase="locked"
          myContribution={myContribution}
          raisedNum={raisedNum}
          symbol={project.symbol}
          isClaimingTokens={false}
          handleClaimTokens={handleClaimTokens}
        />
      </div>
    );
  }

  return (
    <div key="action-state-funding" className="space-y-5">
      <div className="flex items-center gap-3">
        <Wallet className="w-5 h-5 text-blue-400" />
        <div>
          <h3 className="text-base font-black text-white font-mono">Sponsor Compute</h3>
          <p className="text-[10px] text-zinc-500 font-mono">
            Your Max Allocation: {gasAllocLoaded ? `${maxInvest.toFixed(4)} ETH` : <span className="animate-pulse">scanning...</span>}
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-[10px] text-zinc-500 uppercase tracking-wider block font-mono">Amount (ETH)</label>
        <div className="relative">
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            step="0.001"
            max={remaining}
            disabled={isProcessing}
            className={`w-full rounded-xl py-4 pl-4 pr-16 text-2xl font-mono font-bold text-white placeholder:text-zinc-700 bg-black/60 border focus:outline-none focus:ring-1 transition-all disabled:opacity-40 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none ${
              isOverMax ? 'border-red-500/60 focus:border-red-500 focus:ring-red-500/20' : 'border-zinc-700 focus:border-blue-500/50 focus:ring-blue-500/20'
            }`}
          />
          <button
            type="button"
            onClick={() => {
              if (!smartMaxWei || smartMaxWei.lte(0)) return;
              const raw = ethers.utils.formatEther(smartMaxWei);
              const dot = raw.indexOf('.');
              const truncated = dot >= 0 ? raw.slice(0, dot + 5) : raw;
              const v = parseFloat(truncated);
              setAmount(v > 0 ? String(v) : '');
            }}
            disabled={isProcessing || !smartMaxWei || smartMaxWei.lte(0)}
            className="absolute right-2 top-1/2 -translate-y-1/2 px-3 py-1.5 rounded-lg border border-zinc-600 bg-zinc-800 text-blue-500 text-[10px] font-bold font-mono uppercase hover:bg-zinc-700 hover:text-blue-400 disabled:opacity-40 transition-colors"
          >
            MAX
          </button>
        </div>
        {isOverMax && (
          <div className="text-red-400 text-[11px] font-mono flex items-center gap-1.5">
            <span className="w-1 h-1 rounded-full bg-red-500 shrink-0" />
            Exceeds your allocation of <span>{maxInvest.toFixed(4)}</span> ETH
          </div>
        )}
      </div>

      <button
        onClick={investDisabled ? undefined : handleInvest}
        disabled={investDisabled}
        className={[
          'w-full py-4 rounded-xl font-black text-sm uppercase tracking-wider transition-all relative overflow-hidden select-none font-mono',
          investDisabled && 'pointer-events-none opacity-60 cursor-not-allowed',
          isOverMax ? 'bg-red-500/10 text-red-400 border border-red-500/30'
            : !canInvest ? 'bg-zinc-700 text-zinc-500'
            : isProcessing ? 'bg-blue-600/90 text-white'
            : !account ? 'bg-zinc-700 text-zinc-500'
            : 'text-white bg-blue-600 hover:bg-blue-500 shadow-blue-600/20',
        ].filter(Boolean).join(' ')}
      >
        {isProcessing && <span className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-pulse" />}
        <span className="relative z-10">
          {isOverMax ? `EXCEEDS ${maxInvest.toFixed(4)} ETH LIMIT`
            : isProcessing ? (processStatus || 'PROCESSING...')
            : !canInvest ? 'IAO CLOSED'
            : !account ? 'CONNECT WALLET'
            : 'CONTRIBUTE ETH'}
        </span>
      </button>

      {!account && !investError && (
        <button onClick={connectWallet} className="w-full py-3 rounded-xl border border-blue-500/30 text-blue-400 text-xs font-bold font-mono uppercase tracking-wider hover:bg-blue-500/10 transition-colors">
          CONNECT WALLET
        </button>
      )}

      {investSuccess && (
        <div className="p-3.5 rounded-xl bg-blue-500/10 border border-blue-500/30">
          <div className="flex items-center gap-2 mb-1">
            <CheckCircle2 className="w-4 h-4 text-blue-500" />
            <span className="text-sm font-bold text-blue-400 font-mono">SPONSORSHIP CONFIRMED</span>
          </div>
          <p className="text-xs text-blue-300/60 font-mono">Progress will auto-refresh.</p>
        </div>
      )}

      {investError && (
        <div className="p-3.5 rounded-xl bg-red-500/10 border border-red-500/30">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <div>
              <div className="text-[10px] font-bold text-red-400 uppercase tracking-wider mb-0.5 font-mono">Transaction Failed</div>
              <div className="text-xs text-red-300/70 font-mono break-all leading-relaxed">{investError}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RefundPanel({ title, subtitle, description, variant, account, myContribution, isRefunding, handleRefund, connectWallet }) {
  const isAmber = variant === 'amber';
  const Icon = isAmber ? Clock : AlertTriangle;
  return (
    <div className="space-y-5 text-center">
      <Icon className={`w-10 h-10 mx-auto ${isAmber ? 'text-amber-400' : 'text-red-400'}`} />
      <h3 className="text-lg font-black text-white font-mono">{title}</h3>
      <p className={`text-[10px] font-mono uppercase tracking-wider ${isAmber ? 'text-amber-400/60' : 'text-red-400/60'}`}>{subtitle}</p>
      <p className="text-sm text-zinc-500 font-mono leading-relaxed">{description}</p>

      {account && myContribution > 0 && (
        <>
          <div className={`p-3 rounded-xl text-left ${isAmber ? 'bg-amber-500/[0.06] border-amber-500/20' : 'bg-red-500/[0.06] border-red-500/20'} border`}>
            <div className="text-[10px] text-zinc-500 font-mono uppercase">Your Sponsorship</div>
            <div className={`font-mono font-bold ${isAmber ? 'text-amber-400' : 'text-red-400'}`}>{fmtEth(myContribution)} ETH — eligible for full refund</div>
          </div>
          <ActionBtn onClick={handleRefund} disabled={isRefunding} loading={isRefunding} variant={isAmber ? 'amber' : 'red'} label="REFUND ETH" loadingLabel="PROCESSING..." />
        </>
      )}
      {account && myContribution === 0 && (
        <p className="text-zinc-600 text-xs font-mono">No sponsorship found for this wallet.</p>
      )}
      {!account && (
        <button onClick={connectWallet} className="w-full py-3 rounded-xl border border-blue-500/30 text-blue-400 text-xs font-bold font-mono uppercase tracking-wider hover:bg-blue-500/10 transition-colors">
          CONNECT WALLET
        </button>
      )}
    </div>
  );
}

function GriefedRefundPanel({ account, myContribution, isRefunding, handleRefund, connectWallet }) {
  const [refundSuccess, setRefundSuccess] = useState(false);

  const onRefund = useCallback(async () => {
    await handleRefund();
    setRefundSuccess(true);
  }, [handleRefund]);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-red-500/40 bg-red-500/[0.06] p-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-red-500/10 border border-red-500/30 flex items-center justify-center shrink-0">
            <Shield className="w-5 h-5 text-red-400" />
          </div>
          <div>
            <h3 className="text-sm font-black text-red-400 font-mono uppercase tracking-wider">Network Attack Detected</h3>
            <p className="text-[10px] text-red-400/50 font-mono uppercase tracking-wider mt-0.5">Pool Grief — All Fee Tiers Compromised</p>
          </div>
        </div>
        <div className="mt-3 p-3 rounded-lg bg-black/30 border border-red-500/10">
          <p className="text-xs text-zinc-300 font-mono leading-relaxed">
            A malicious actor pre-initialized all 4 Uniswap V3 fee-tier pools, preventing liquidity deployment.
            The smart contract has automatically aborted pool creation and <span className="text-white font-bold">unlocked immediate 100% refunds</span> — no time lock, no waiting period.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-3">
        <div className="flex items-center gap-2 mb-1">
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
          <span className="text-[10px] text-emerald-400 font-mono font-bold uppercase tracking-wider">Funds are 100% safe</span>
        </div>
        <p className="text-[11px] text-emerald-300/50 font-mono">Contract time-locks have been force-released. You can withdraw immediately.</p>
      </div>

      {account && myContribution > 0 && !refundSuccess && (
        <>
          <div className="p-3 rounded-xl bg-zinc-800/60 border border-zinc-700/40">
            <div className="text-[10px] text-zinc-500 font-mono uppercase">Your Contribution</div>
            <div className="text-xl font-black font-mono text-white mt-1">{fmtEth(myContribution)} <span className="text-sm text-zinc-500">ETH</span></div>
          </div>
          <button
            onClick={onRefund}
            disabled={isRefunding}
            className={[
              'w-full py-5 rounded-xl font-black text-base uppercase tracking-wider font-mono transition-all relative overflow-hidden',
              isRefunding
                ? 'bg-red-600/90 text-white animate-pulse'
                : 'bg-gradient-to-r from-red-600 to-orange-600 text-white hover:from-red-500 hover:to-orange-500 shadow-lg shadow-red-900/30 hover:shadow-red-800/40',
            ].join(' ')}
          >
            {isRefunding && <span className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent animate-pulse" />}
            <span className="relative z-10 flex items-center justify-center gap-2">
              {isRefunding ? (
                <>
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  PROCESSING REFUND...
                </>
              ) : (
                'CLAIM FULL REFUND'
              )}
            </span>
          </button>
        </>
      )}

      {account && refundSuccess && (
        <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-center">
          <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto mb-2" />
          <p className="text-sm font-bold text-emerald-400 font-mono">REFUND SUCCESSFUL</p>
          <p className="text-[11px] text-emerald-300/50 font-mono mt-1">ETH has been returned to your wallet.</p>
        </div>
      )}

      {account && myContribution === 0 && !refundSuccess && (
        <p className="text-zinc-600 text-xs font-mono text-center">No contribution found for this wallet.</p>
      )}

      {!account && (
        <button onClick={connectWallet} className="w-full py-3 rounded-xl border border-blue-500/30 text-blue-400 text-xs font-bold font-mono uppercase tracking-wider hover:bg-blue-500/10 transition-colors">
          CONNECT WALLET
        </button>
      )}
    </div>
  );
}

function ActionBtn({ onClick, disabled, loading, variant, label, loadingLabel, glow }) {
  const variants = {
    blue: 'text-white bg-blue-600 hover:bg-blue-500 shadow-blue-600/20',
    emerald: 'bg-emerald-600/20 text-emerald-400 border border-emerald-500/40 hover:bg-emerald-600/30' + (glow ? ' hover:shadow-[0_0_24px_rgba(16,185,129,0.3)]' : ''),
    amber: 'bg-amber-600/20 text-amber-400 border border-amber-500/40 hover:bg-amber-600/30',
    red: 'bg-red-600/20 text-red-400 border border-red-500/40 hover:bg-red-600/30',
  };
  const loadingClasses = {
    blue: 'bg-blue-600/90 text-white',
    emerald: 'bg-emerald-600/90 text-black',
    amber: 'bg-amber-600/90 text-black',
    red: 'bg-red-600/90 text-black',
  };
  const v = variants[variant] || variants.blue;
  const l = loadingClasses[variant] || loadingClasses.blue;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full py-4 rounded-xl font-black text-sm uppercase tracking-wider transition-all font-mono ${loading ? `${l} animate-pulse` : v}`}
    >
      {loading ? loadingLabel : label}
    </button>
  );
}

function MiniStat({ label, value }) {
  return (
    <div className="p-2.5 rounded-lg bg-black/30 border border-zinc-800/60 text-center">
      <div className="text-[9px] text-zinc-600 uppercase tracking-widest font-bold font-mono">{label}</div>
      <div className="text-sm font-black font-mono text-white mt-0.5">{value}</div>
    </div>
  );
}

const RETAIL_POOL = 21_000_000;

function fmtTokenCompact(n) {
  if (!n || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(2);
}

/**
 * DeFi-style micro-price formatter.
 * For very small numbers uses the subscript-zeros notation popular on DEX
 * trackers: "0.0₆238" means 6 leading zeros then "238".
 * Returns a React fragment with a styled <sub> tag for the zero count.
 */
function FmtMicroPrice({ value }) {
  if (!value || value <= 0) return <span>—</span>;
  if (value >= 0.01) return <span>{value.toFixed(6)}</span>;
  if (value >= 0.001) return <span>{value.toFixed(8)}</span>;

  const str = value.toFixed(18);
  const afterDot = str.split('.')[1] || '';
  let zeros = 0;
  for (const c of afterDot) {
    if (c === '0') zeros++;
    else break;
  }
  const sigDigits = afterDot.slice(zeros, zeros + 4).replace(/0+$/, '') || '0';
  return (
    <span>
      0.0<sub className="text-[70%] opacity-60">{zeros}</sub>{sigDigits}
    </span>
  );
}

function PersonalAssetCard({ phase, myContribution, raisedNum, symbol, isClaimingTokens, handleClaimTokens }) {
  const impliedPrice = raisedNum > 0 ? raisedNum / RETAIL_POOL : 0;
  const estTokens = raisedNum > 0 ? (myContribution / raisedNum) * RETAIL_POOL : 0;

  const isLocked    = phase === 'locked';
  const isClaimable = phase === 'claimable';
  const isClaimed   = phase === 'claimed';

  return (
    <div className={[
      'relative rounded-xl border overflow-hidden transition-all duration-500',
      isClaimed
        ? 'border-emerald-500/20 bg-emerald-950/10'
        : isClaimable
          ? 'border-emerald-500/30 bg-gradient-to-br from-emerald-950/20 via-zinc-900/60 to-zinc-900/80 shadow-[0_0_24px_rgba(16,185,129,0.08)]'
          : 'border-zinc-700/40 bg-zinc-900/30',
    ].join(' ')}>
      {isClaimable && (
        <div className="absolute inset-0 bg-gradient-to-b from-emerald-500/[0.04] to-transparent pointer-events-none" />
      )}

      <div className="relative z-10 p-4 space-y-3">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={[
              'w-1.5 h-1.5 rounded-full',
              isClaimed ? 'bg-emerald-400' : isClaimable ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-600',
            ].join(' ')} />
            <span className={[
              'text-[9px] font-bold uppercase tracking-widest font-mono',
              isClaimed ? 'text-emerald-400/70' : isClaimable ? 'text-emerald-400' : 'text-zinc-500',
            ].join(' ')}>
              {isClaimed ? 'CLAIMED' : isClaimable ? 'READY TO CLAIM' : 'LOCKED'}
            </span>
          </div>
          {isLocked && (
            <Shield className="w-3.5 h-3.5 text-zinc-600" />
          )}
        </div>

        {/* Stats grid */}
        {!isClaimed && (
          <>
            <div className="grid grid-cols-2 gap-2.5">
              <div className={[
                'p-3 rounded-lg border',
                isClaimable ? 'bg-black/40 border-zinc-800/60' : 'bg-black/20 border-zinc-800/40',
              ].join(' ')}>
                <div className="text-[8px] text-zinc-600 font-mono uppercase tracking-widest mb-1">Sponsored</div>
                <div className={[
                  'text-lg font-black font-mono leading-none',
                  isClaimable ? 'text-white' : 'text-zinc-400',
                ].join(' ')}>
                  {fmtEth(myContribution)}
                </div>
                <div className="text-[9px] text-zinc-600 font-mono mt-0.5">ETH</div>
              </div>
              <div className={[
                'p-3 rounded-lg border',
                isClaimable
                  ? 'bg-emerald-500/[0.04] border-emerald-500/10'
                  : 'bg-gradient-to-br from-blue-500/[0.04] to-violet-500/[0.02] border-blue-500/10',
              ].join(' ')}>
                <div className={[
                  'text-[8px] font-mono uppercase tracking-widest mb-1',
                  isClaimable ? 'text-zinc-600' : 'text-blue-500/60',
                ].join(' ')}>
                  {isClaimable ? 'Claimable' : 'Implied Price'}
                </div>
                {isClaimable ? (
                  <>
                    <div className="text-lg font-black font-mono leading-none text-emerald-400">
                      {fmtTokenCompact(estTokens)}
                    </div>
                    <div className="text-[9px] font-mono mt-0.5 text-emerald-500/50">{symbol || 'TOKEN'}</div>
                  </>
                ) : (
                  <>
                    <div className="text-lg font-black font-mono leading-none text-blue-400 tabular-nums">
                      {impliedPrice > 0 ? <FmtMicroPrice value={impliedPrice} /> : '—'}
                    </div>
                    <div className="text-[9px] font-mono mt-0.5 text-blue-500/40">ETH / token</div>
                  </>
                )}
              </div>
            </div>

          </>
        )}

        {/* Action zone */}
        {isClaimed ? (
          <div className="flex items-center gap-2.5 p-3 rounded-lg bg-emerald-500/[0.06] border border-emerald-500/15">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span className="text-xs text-emerald-400/90 font-mono font-bold">ASSETS WITHDRAWN TO WALLET</span>
          </div>
        ) : isClaimable ? (
          <button
            onClick={handleClaimTokens}
            disabled={isClaimingTokens}
            className="group w-full relative py-3.5 rounded-xl font-black text-sm uppercase tracking-wider font-mono text-white overflow-hidden transition-all duration-300 bg-gradient-to-r from-emerald-600 to-teal-500 hover:from-emerald-500 hover:to-teal-400 shadow-lg shadow-emerald-900/20 hover:shadow-emerald-800/30 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <span className="absolute inset-0 bg-gradient-to-r from-transparent via-white/[0.07] to-transparent translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-700" />
            {isClaimingTokens && (
              <span className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-pulse" />
            )}
            <span className="relative z-10 flex items-center justify-center gap-2">
              {isClaimingTokens ? (
                <>
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  CLAIMING...
                </>
              ) : (
                'CLAIM AGENT TOKENS'
              )}
            </span>
          </button>
        ) : (
          <div className="py-3 px-4 rounded-lg bg-zinc-800/30 border border-zinc-800/40 text-center">
            <span className="text-[10px] text-zinc-600 font-mono">Awaiting pool deployment to unlock claims</span>
          </div>
        )}
      </div>
    </div>
  );
}
