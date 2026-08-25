'use client';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { ethers } from 'ethers';
import toast from 'react-hot-toast';
import {
  FACTORY_ADDRESS,
  TREASURY_WALLET,
  LISTING_FEE_ETH,
} from '@/lib/constants';
import { fmtEth, truncAddr } from '@/lib/fmt';
import { getActiveProvider } from '@/lib/walletProvider';
import { FACTORY_ABI, FUND_ABI, TOKEN_ABI } from '@/lib/abis';
import { getReadContract, getRpcProvider, getSignerContract, handleTxError } from '@/lib/web3';

// ── Permission tiers (env-driven, no hardcoded addresses) ──

const GENERAL_ADMINS = (process.env.NEXT_PUBLIC_ADMIN_WALLETS || '')
  .split(',')
  .map(a => a.trim().toLowerCase())
  .filter(Boolean);

const EMERGENCY_ADMIN = (process.env.NEXT_PUBLIC_EMERGENCY_ADMIN || '').trim().toLowerCase();

const STATE_LABELS = {
  0: { text: 'FUNDING',   color: 'text-blue-400',    dot: 'bg-blue-500 animate-pulse', bg: 'bg-blue-500/10 border-blue-500/20' },
  1: { text: 'FAILED',    color: 'text-red-400',     dot: 'bg-red-500',                bg: 'bg-red-500/10 border-red-500/20' },
  2: { text: 'PREPARING', color: 'text-amber-400',   dot: 'bg-amber-500 animate-pulse',bg: 'bg-amber-500/10 border-amber-500/20' },
  3: { text: 'DEX READY', color: 'text-emerald-400', dot: 'bg-emerald-500',            bg: 'bg-emerald-500/10 border-emerald-500/20' },
};
const STATE_FALLBACK = { text: 'UNKNOWN', color: 'text-zinc-500', dot: 'bg-zinc-500', bg: 'bg-zinc-500/10 border-zinc-500/20' };

export default function AdminDashboard() {
  const [account, setAccount] = useState('');
  const [projects, setProjects] = useState([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [treasuryBalance, setTreasuryBalance] = useState(null);
  const [factoryBalance, setFactoryBalance] = useState(null);
  const [onChainTreasury, setOnChainTreasury] = useState('');
  const [onChainOperator, setOnChainOperator] = useState('');

  // Circuit Breaker
  const [protocolPaused, setProtocolPaused] = useState(false);
  const [isUpdatingState, setIsUpdatingState] = useState(false);

  // ── Permission computation ──
  const isGeneralAdmin = account && GENERAL_ADMINS.includes(account.toLowerCase());
  const isEmergencyAdmin = account && EMERGENCY_ADMIN && account.toLowerCase() === EMERGENCY_ADMIN;
  const isTreasury = account && onChainTreasury && account.toLowerCase() === onChainTreasury.toLowerCase();
  const isEnvTreasury = account && TREASURY_WALLET && account.toLowerCase() === TREASURY_WALLET.toLowerCase();
  const isOperator = account && onChainOperator && onChainOperator !== ethers.constants.AddressZero && account.toLowerCase() === onChainOperator.toLowerCase();
  const canCollectFees = isTreasury || isOperator;
  const isAuthorized = isGeneralAdmin || isTreasury || isEnvTreasury || isOperator;

  const totalProjects = projects.length;
  const totalRaisedAll = useMemo(() => projects.reduce((sum, p) => sum + Number(p.totalRaised), 0), [projects]);
  const countByState = useMemo(() => projects.reduce((acc, p) => { acc[p.state] = (acc[p.state] || 0) + 1; return acc; }, {}), [projects]);

  const fetchSystemData = useCallback(async () => {
    if (typeof window === 'undefined' || !getActiveProvider() || !isAuthorized) return;
    if (!FACTORY_ADDRESS) { setProjects([]); setProjectsLoading(false); return; }
    setProjectsLoading(true);
    try {
      const provider = getRpcProvider();
      const factory = getReadContract(FACTORY_ADDRESS, FACTORY_ABI);

      factory.isPaused().then(setProtocolPaused).catch(() => {});
      factory.platformTreasury().then(addr => setOnChainTreasury(addr)).catch(() => {});
      factory.operator().then(addr => setOnChainOperator(addr)).catch(() => {});

      let addresses = [];
      try {
        const count = await factory.projectCount();
        const n = count.toNumber();
        addresses = n === 0 ? [] : await Promise.all(
          Array.from({ length: n }, (_, i) => factory.allDeployedProjects(i))
        );
      } catch { /* contract not deployed */ }

      const treasuryAddr = await factory.platformTreasury().catch(() => TREASURY_WALLET);
      const [treasuryBal, factoryBal] = await Promise.all([
        treasuryAddr ? provider.getBalance(treasuryAddr).catch(() => ethers.BigNumber.from(0)) : Promise.resolve(ethers.BigNumber.from(0)),
        provider.getBalance(FACTORY_ADDRESS).catch(() => ethers.BigNumber.from(0)),
      ]);
      setTreasuryBalance(ethers.utils.formatEther(treasuryBal));
      setFactoryBalance(ethers.utils.formatEther(factoryBal));

      const results = await Promise.all(
        addresses.map(async (addr) => {
          try {
            const fund = new ethers.Contract(addr, FUND_ABI, provider);
            const [tokenAddr, raised, state, softCap] = await Promise.all([
              fund.projectToken(),
              fund.totalRaised(),
              fund.currentState(),
              fund.SOFT_CAP(),
            ]);
            const token = new ethers.Contract(tokenAddr, TOKEN_ABI, provider);
            const [name, symbol] = await Promise.all([token.name(), token.symbol()]);
            const raisedEth = Number(ethers.utils.formatEther(raised));
            const capEth = Number(ethers.utils.formatEther(softCap));

            return {
              address: addr, name, symbol, totalRaised: raisedEth, softCap: capEth,
              state: Number(state), progress: Math.min((raisedEth / capEth) * 100, 100)
            };
          } catch { return { address: addr, name: 'ERR', state: -1 }; }
        })
      );
      setProjects(results);
    } catch (err) {
      const msg = err?.message || '';
      const isContractMissing = msg.includes('call revert') || msg.includes('CALL_EXCEPTION') || msg.includes('missing revert data');
      if (!isContractMissing) {
        if (process.env.NODE_ENV !== 'production') {
          // eslint-disable-next-line no-console
          console.error('System scan failed:', err);
        }
        toast.error('Failed to load protocol overview. Please retry shortly.');
      }
    }
    finally { setProjectsLoading(false); }
  }, [isAuthorized]);

  // ── Circuit Breaker (emergency admin only) ──
  const handleTogglePause = async () => {
    if (!isEmergencyAdmin || isUpdatingState) return;
    setIsUpdatingState(true);
    try {
      const { contract } = getSignerContract(FACTORY_ADDRESS, FACTORY_ABI);
      const tx = await contract.setProtocolPause(!protocolPaused);
      toast.loading('Synchronizing Circuit Breaker...', { id: 'pause' });
      await tx.wait();
      setProtocolPaused(!protocolPaused);
      toast.success(`Protocol is now ${!protocolPaused ? 'PAUSED' : 'LIVE'}`, { id: 'pause' });
    } catch (err) { handleTxError(err); }
    finally { setIsUpdatingState(false); }
  };

  useEffect(() => {
    const p = getActiveProvider();
    if (!p) return;
    p.request({ method: 'eth_accounts' }).then(accs => { if (accs[0]) setAccount(accs[0].toLowerCase()); });
    const handleAcc = (accs) => setAccount(accs[0]?.toLowerCase() || '');
    p.on('accountsChanged', handleAcc);
    return () => p.removeListener('accountsChanged', handleAcc);
  }, []);

  useEffect(() => {
    if (isAuthorized) {
      fetchSystemData();
    }
  }, [isAuthorized, fetchSystemData]);

  const [collectingFees, setCollectingFees] = useState({});
  const [hiddenProjects, setHiddenProjects] = useState({});

  const toggleVisibility = async (addr) => {
    const next = { ...hiddenProjects, [addr]: !hiddenProjects[addr] };
    setHiddenProjects(next);
    try {
      const res = await fetch('/api/admin/toggle-visibility', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.NEXT_PUBLIC_ADMIN_SECRET || ''}`,
        },
        body: JSON.stringify({ address: addr, hidden: next[addr] }),
      });
      if (!res.ok) {
        setHiddenProjects(prev => ({ ...prev, [addr]: !next[addr] }));
        toast.error('Visibility update failed — check ADMIN_SECRET');
      }
    } catch {
      setHiddenProjects(prev => ({ ...prev, [addr]: !next[addr] }));
      toast.error('Visibility update failed — network error');
    }
  };

  const handleCollectFees = async (addr) => {
    setCollectingFees(prev => ({ ...prev, [addr]: true }));
    try {
      const { contract } = getSignerContract(addr, FUND_ABI);
      await (await contract.collectTradingFees()).wait();
      toast.success('Fees Collected'); fetchSystemData();
    } catch (e) { handleTxError(e); }
    finally { setCollectingFees(prev => ({ ...prev, [addr]: false })); }
  };

  if (!account) return <div className="min-h-screen bg-black flex items-center justify-center font-mono text-blue-500 animate-pulse tracking-widest">AWAITING OPERATOR...</div>;
  if (!isAuthorized) return <div className="min-h-screen bg-red-950/20 flex items-center justify-center font-bold text-red-500 uppercase tracking-tighter">RESTRICTED_ACCESS</div>;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-300 font-sans p-8 selection:bg-blue-600/30">
      <div className="max-w-6xl mx-auto space-y-6">

        {/* Header */}
        <div className="flex justify-between items-end border-b border-zinc-800 pb-6">
          <div>
            <h1 className="text-3xl font-black text-white tracking-tighter italic uppercase">/// MERIT_X <span className="text-blue-500">SYSTEM ADMIN</span></h1>
            <div className="flex items-center gap-3 mt-1.5">
              <p className="text-[10px] font-mono text-zinc-600 uppercase tracking-widest">Protocol Command Center v7.2</p>
              <span className="flex items-center gap-1.5 text-[9px] font-mono font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                SYSTEM ONLINE
              </span>
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <div className="flex items-center gap-2">
              <div className="text-xs font-mono text-zinc-500 border border-zinc-800 px-4 py-2 rounded-lg bg-zinc-900/50">{truncAddr(account)}</div>
              {isEmergencyAdmin && (
                <span className="text-[9px] font-bold text-red-400 bg-red-500/10 border border-red-500/20 px-2 py-1 rounded-lg uppercase tracking-widest">Emergency</span>
              )}
              {isOperator && (
                <span className="text-[9px] font-bold text-purple-400 bg-purple-500/10 border border-purple-500/20 px-2 py-1 rounded-lg uppercase tracking-widest">Operator</span>
              )}
              {isTreasury && (
                <span className="text-[9px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-1 rounded-lg uppercase tracking-widest">Treasury</span>
              )}
              {isGeneralAdmin && !isEmergencyAdmin && !isOperator && !isTreasury && (
                <span className="text-[9px] font-bold text-blue-400 bg-blue-500/10 border border-blue-500/20 px-2 py-1 rounded-lg uppercase tracking-widest">Admin</span>
              )}
            </div>
            <div className="text-[9px] font-mono text-zinc-600 text-right space-y-0.5">
              {onChainTreasury && (
                <p>TREASURY: <span className={isTreasury ? 'text-emerald-500' : 'text-zinc-500'}>{truncAddr(onChainTreasury)}</span></p>
              )}
              {onChainOperator && onChainOperator !== ethers.constants.AddressZero && (
                <p>OPERATOR: <span className={isOperator ? 'text-purple-400' : 'text-zinc-500'}>{truncAddr(onChainOperator)}</span></p>
              )}
            </div>
          </div>
        </div>

        {/* Circuit Breaker */}
        <div className={`border rounded-2xl p-6 transition-all duration-500 ${protocolPaused ? 'bg-red-500/10 border-red-500/50' : 'bg-zinc-900/40 border-zinc-800/80'}`}>
          <div className="flex justify-between items-center">
            <div>
              <h2 className={`text-xs font-bold tracking-widest uppercase mb-1 ${protocolPaused ? 'text-red-400' : 'text-zinc-400'}`}>System Circuit Breaker</h2>
              <p className="text-[10px] text-zinc-600 font-mono italic tracking-tight">Emergency global halt for all project launches and funding contributions.</p>
            </div>
            <div className="flex flex-col items-end gap-1.5">
              <button
                onClick={handleTogglePause}
                disabled={!isEmergencyAdmin || isUpdatingState}
                className={`px-8 py-3 rounded-xl text-xs font-black tracking-widest transition-all ${
                  !isEmergencyAdmin
                    ? 'bg-zinc-800 text-zinc-600 cursor-not-allowed opacity-60'
                    : protocolPaused
                      ? 'bg-emerald-500 text-black hover:bg-emerald-400'
                      : 'bg-red-600 text-white hover:bg-red-500 shadow-xl shadow-red-900/20'
                }`}
              >
                {isUpdatingState ? '...' : (protocolPaused ? 'RESUME SYSTEM' : 'HALT SYSTEM')}
              </button>
              {!isEmergencyAdmin && (
                <p className="text-[9px] font-mono text-zinc-600 italic">Only Emergency Admin can trigger protocol pause.</p>
              )}
            </div>
          </div>
        </div>

        {/* Macro Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Stat label="Global TVL" value={fmtEth(totalRaisedAll)} unit="ETH" color="text-emerald-400" />
          <Stat label="Total Agents" value={totalProjects} color="text-blue-400" />
          <Stat label="Treasury" value={treasuryBalance ? Number(treasuryBalance).toFixed(3) : '—'} unit="ETH" />
          <Stat label="Listing Fee" value={LISTING_FEE_ETH} unit="ETH" />
        </div>

        {/* Factory Balance */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Stat label="Factory Balance" value={factoryBalance ? Number(factoryBalance).toFixed(3) : '—'} unit="ETH" color="text-cyan-400" />
          <Stat label="Funding Active" value={countByState[0] || 0} color="text-blue-400" />
          <Stat label="Preparing Launch" value={countByState[2] || 0} color="text-amber-400" />
          <Stat label="DEX Live" value={countByState[3] || 0} color="text-emerald-400" />
        </div>

        {/* Filter Badges */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[0, 1, 2, 3].map(s => {
            const cfg = STATE_LABELS[s];
            return (
              <div key={s} className={`p-4 rounded-xl border ${cfg.bg} flex flex-col items-center justify-center`}>
                <div className="flex items-center gap-1.5 mb-1">
                   <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
                   <span className={`text-[8px] font-black uppercase tracking-widest ${cfg.color}`}>{cfg.text}</span>
                </div>
                <span className="text-2xl font-black text-white">{countByState[s] || 0}</span>
              </div>
            );
          })}
        </div>

        {/* Directory */}
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-6 overflow-hidden">
           <h2 className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-6">Agent Registry</h2>
           <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="text-zinc-600 border-b border-zinc-800 uppercase font-bold text-[10px] tracking-wider">
                    <th className="py-3">Agent</th><th className="text-center">Status</th><th className="text-center">Visibility</th><th className="text-right">Raised</th><th className="text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/50">
                  {projects.map(p => {
                    const cfg = STATE_LABELS[p.state] || STATE_FALLBACK;
                    return (
                      <tr key={p.address} className="hover:bg-white/5 transition-all">
                        <td className="py-4">
                          <div className="font-bold text-white">{p.name}</div>
                          <div className="text-[10px] font-mono text-zinc-600">{truncAddr(p.address)}</div>
                        </td>
                        <td className="text-center">
                          <span className={`text-[9px] font-bold px-2 py-1 rounded border ${cfg.bg} ${cfg.color}`}>{cfg.text}</span>
                        </td>
                        <td className="text-center">
                          <button onClick={() => toggleVisibility(p.address)} className={`w-8 h-4 rounded-full relative transition-all ${hiddenProjects[p.address] ? 'bg-zinc-800' : 'bg-blue-600'}`}>
                            <div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-all ${hiddenProjects[p.address] ? 'left-0.5' : 'left-4.5'}`} />
                          </button>
                        </td>
                        <td className="text-right font-mono text-white">
                          <div>{p.totalRaised?.toFixed(3) ?? '0.000'} ETH</div>
                          <div className="w-24 h-0.5 bg-zinc-800 rounded-full ml-auto mt-1.5 overflow-hidden">
                            <div className="h-full bg-blue-500" style={{ width: `${p.progress || 0}%` }} />
                          </div>
                        </td>
                        <td className="text-right">
                          {p.state === 3 ? (
                            canCollectFees ? (
                              <button onClick={() => handleCollectFees(p.address)} disabled={collectingFees[p.address]} className="text-[10px] font-bold text-emerald-500 border border-emerald-500/30 px-2 py-1 rounded hover:bg-emerald-500 hover:text-black transition-all">
                                {collectingFees[p.address] ? '...' : 'SEND TO VAULT'}
                              </button>
                            ) : (
                              <span className="text-[9px] text-zinc-600 italic" title="Only operator or treasury wallet can collect fees">OPERATOR / TREASURY ONLY</span>
                            )
                          ) : <span className="text-[9px] text-zinc-700 italic">LOCKED</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
           </div>
        </div>

        {/* ═══ Active Projects Monitor ═══ */}
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-6 overflow-hidden">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">/// Active Projects Monitor</h2>
              <p className="text-[9px] text-zinc-700 font-mono mt-0.5">Real-time on-chain data — {projects.length} projects indexed</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  if (!projects.length) { toast.error('No project data to export'); return; }
                  const header = 'PROJECT,SYMBOL,FUND_ADDRESS,STATUS,RAISED_ETH,SOFT_CAP_ETH,PROGRESS_%\n';
                  const rows = projects.map(p => {
                    const s = STATE_LABELS[p.state] || STATE_FALLBACK;
                    return `${p.name},${p.symbol || ''},${p.address},${s.text},${(p.totalRaised ?? 0).toFixed(4)},${(p.softCap ?? 0).toFixed(4)},${(p.progress ?? 0).toFixed(1)}`;
                  }).join('\n');
                  const blob = new Blob([header + rows], { type: 'text/csv' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a'); a.href = url; a.download = `meritx-projects-${Date.now()}.csv`; a.click();
                  URL.revokeObjectURL(url);
                  toast.success('Project snapshot exported');
                }}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-wider border-2 border-amber-500/50 text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 hover:shadow-[0_0_16px_rgba(245,158,11,0.15)] transition-all"
              >
                EXPORT ACTIVE PROJECTS (CSV)
              </button>
              <button
                onClick={() => fetchSystemData()}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-wider border border-purple-500/40 text-purple-400 bg-purple-500/10 hover:bg-purple-500/20 transition-all"
              >
                REFRESH DATA
              </button>
            </div>
          </div>

          {projectsLoading && !projects.length ? (
            <div className="text-center py-12 text-zinc-600 font-mono text-xs animate-pulse tracking-widest">SCANNING CONTRACTS...</div>
          ) : !projects.length ? (
            <div className="text-center py-12 text-zinc-700 font-mono text-xs">[ NO PROJECTS DEPLOYED ]</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="text-zinc-600 border-b border-zinc-800 uppercase font-bold text-[9px] tracking-wider">
                    <th className="py-3 pr-2">#</th>
                    <th className="py-3">Project</th>
                    <th className="py-3">Fund Address</th>
                    <th className="py-3 text-center">Status</th>
                    <th className="py-3 text-right">Raised (ETH)</th>
                    <th className="py-3 text-right">Soft Cap (ETH)</th>
                    <th className="py-3 text-right">Progress</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/40">
                  {projects.map((p, i) => {
                    const cfg = STATE_LABELS[p.state] || STATE_FALLBACK;
                    return (
                      <tr key={p.address} className="hover:bg-white/[0.02] transition-colors">
                        <td className="py-3 pr-2 text-zinc-600 font-bold tabular-nums">{i + 1}</td>
                        <td className="py-3">
                          <span className="text-white font-bold">{p.name}</span>
                          {p.symbol && <span className="text-zinc-600 text-[10px] ml-1.5">${p.symbol}</span>}
                        </td>
                        <td className="py-3 font-mono text-zinc-400 text-[11px]">{truncAddr(p.address, 8, 6)}</td>
                        <td className="py-3 text-center">
                          <span className={`text-[9px] font-bold px-2 py-1 rounded border ${cfg.bg} ${cfg.color}`}>{cfg.text}</span>
                        </td>
                        <td className="py-3 text-right font-mono text-emerald-400 tabular-nums font-bold">{(p.totalRaised ?? 0).toFixed(4)}</td>
                        <td className="py-3 text-right font-mono text-zinc-400 tabular-nums">{(p.softCap ?? 0).toFixed(4)}</td>
                        <td className="py-3 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <div className="w-16 h-1 bg-zinc-800 rounded-full overflow-hidden">
                              <div className="h-full bg-blue-500 rounded-full" style={{ width: `${p.progress || 0}%` }} />
                            </div>
                            <span className="font-mono text-zinc-300 tabular-nums text-[10px]">{(p.progress ?? 0).toFixed(0)}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

function Stat({ label, value, unit, color }) {
  return (
    <div className="bg-zinc-900/40 border border-zinc-800 p-5 rounded-2xl">
      <p className="text-[9px] font-bold text-zinc-600 uppercase tracking-widest mb-2 font-mono">{label}</p>
      <p className={`text-2xl font-black font-mono tabular-nums ${color || 'text-white'}`}>
        {value} <span className="text-xs font-normal opacity-30">{unit}</span>
      </p>
    </div>
  );
}
