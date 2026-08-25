'use client';
import { useState, useEffect, useMemo } from 'react';
import { truncAddr } from '@/lib/fmt';
import { getActiveProvider } from '@/lib/walletProvider';

// ── Mock: Syndicate Network (Referrals) ──
const MOCK_SYNDICATE = Array.from({ length: 20 }, (_, i) => ({
  rank: i + 1,
  address: `0x${(0xa0000 + i * 7919).toString(16).padStart(40, '0')}`,
  recruits: Math.max(0, Math.floor(300 / (i + 1) + Math.random() * 10)),
  points: Math.max(0, Math.floor(50000 / (i + 1) + Math.random() * 500)),
}));

// ── Mock: Capital (Investment Volume) ──
const MOCK_CAPITAL = Array.from({ length: 20 }, (_, i) => ({
  rank: i + 1,
  address: `0x${(0xc0000 + i * 5471).toString(16).padStart(40, '0')}`,
  projects: Math.max(1, Math.floor(15 / (i + 1) + Math.random() * 2)),
  volume: +(Math.max(0.05, 25 / (i + 1) + Math.random() * 1.5)).toFixed(4),
}));

// ── Mock: Compute Burned (Gas) ──
const MOCK_GAS = Array.from({ length: 20 }, (_, i) => ({
  rank: i + 1,
  address: `0x${(0xb0000 + i * 6133).toString(16).padStart(40, '0')}`,
  txCount: Math.max(0, Math.floor(8000 / (i + 1) + Math.random() * 200)),
  gasBurned: +(Math.max(0.01, 12 / (i + 1) + Math.random() * 0.5)).toFixed(4),
}));

const TABS = {
  syndicate: {
    id: 'syndicate',
    label: '📡 SYNDICATE',
    accent: 'blue',
    stats: [
      { label: 'TOTAL MERIT PTS', value: MOCK_SYNDICATE.reduce((s, l) => s + l.points, 0).toLocaleString(), color: 'text-purple-400' },
      { label: 'ACTIVE OPERATORS', value: '1,247', color: 'text-cyan-400' },
      { label: 'TOTAL REFERRALS', value: MOCK_SYNDICATE.reduce((s, l) => s + l.recruits, 0).toLocaleString(), color: 'text-emerald-400' },
    ],
    columns: [
      { key: 'rank', label: 'RANK', align: '' },
      { key: 'address', label: 'OPERATOR', align: '' },
      { key: 'recruits', label: 'RECRUITS', align: 'text-right' },
      { key: 'points', label: 'MERIT PTS', align: 'text-right' },
    ],
    podiumMeta: (e) => [
      { label: 'RECRUITS', value: e.recruits },
      { label: 'MERIT PTS', value: e.points.toLocaleString() },
    ],
    cellRender: (entry, col) => {
      if (col.key === 'rank') return <span className="text-zinc-500 text-xs font-bold tabular-nums">#{entry.rank}</span>;
      if (col.key === 'address') return <span className="text-zinc-300 text-xs">{truncAddr(entry.address, 8, 6)}</span>;
      if (col.key === 'recruits') return <span className="text-zinc-400 text-xs font-bold tabular-nums text-right">{entry.recruits}</span>;
      return <span className="text-purple-400 text-xs font-black tabular-nums text-right">{entry.points.toLocaleString()}</span>;
    },
  },
  capital: {
    id: 'capital',
    label: 'CAPITAL',
    accent: 'emerald',
    stats: [
      { label: 'TOTAL VOLUME', value: MOCK_CAPITAL.reduce((s, l) => s + l.volume, 0).toFixed(2) + ' ETH', color: 'text-emerald-400' },
      { label: 'UNIQUE BACKERS', value: '631', color: 'text-cyan-400' },
      { label: 'PROJECTS FUNDED', value: MOCK_CAPITAL.reduce((s, l) => s + l.projects, 0).toLocaleString(), color: 'text-purple-400' },
    ],
    columns: [
      { key: 'rank', label: 'RANK', align: '' },
      { key: 'address', label: 'OPERATOR', align: '' },
      { key: 'projects', label: 'PROJECTS', align: 'text-right' },
      { key: 'volume', label: 'VOLUME (ETH)', align: 'text-right' },
    ],
    podiumMeta: (e) => [
      { label: 'PROJECTS', value: e.projects },
      { label: 'VOLUME', value: e.volume + ' E' },
    ],
    cellRender: (entry, col) => {
      if (col.key === 'rank') return <span className="text-zinc-500 text-xs font-bold tabular-nums">#{entry.rank}</span>;
      if (col.key === 'address') return <span className="text-zinc-300 text-xs">{truncAddr(entry.address, 8, 6)}</span>;
      if (col.key === 'projects') return <span className="text-zinc-400 text-xs font-bold tabular-nums text-right">{entry.projects}</span>;
      return <span className="text-emerald-400 text-xs font-black tabular-nums text-right">{entry.volume} ETH</span>;
    },
  },
  gas: {
    id: 'gas',
    label: 'GAS BURNED',
    accent: 'orange',
    stats: [
      { label: 'TOTAL GAS BURNED', value: MOCK_GAS.reduce((s, l) => s + l.gasBurned, 0).toFixed(2) + ' ETH', color: 'text-orange-400' },
      { label: 'ACTIVE BURNERS', value: '892', color: 'text-cyan-400' },
      { label: 'TOTAL TX COUNT', value: MOCK_GAS.reduce((s, l) => s + l.txCount, 0).toLocaleString(), color: 'text-emerald-400' },
    ],
    columns: [
      { key: 'rank', label: 'RANK', align: '' },
      { key: 'address', label: 'OPERATOR', align: '' },
      { key: 'txCount', label: 'TX COUNT', align: 'text-right' },
      { key: 'gasBurned', label: 'GAS BURNED', align: 'text-right' },
    ],
    podiumMeta: (e) => [
      { label: 'TX COUNT', value: e.txCount.toLocaleString() },
      { label: 'GAS BURNED', value: e.gasBurned + ' E' },
    ],
    cellRender: (entry, col) => {
      if (col.key === 'rank') return <span className="text-zinc-500 text-xs font-bold tabular-nums">#{entry.rank}</span>;
      if (col.key === 'address') return <span className="text-zinc-300 text-xs">{truncAddr(entry.address, 8, 6)}</span>;
      if (col.key === 'txCount') return <span className="text-zinc-400 text-xs font-bold tabular-nums text-right">{entry.txCount.toLocaleString()}</span>;
      return <span className="text-orange-400 text-xs font-black tabular-nums text-right">{entry.gasBurned} ETH</span>;
    },
  },
};

const MEDAL = { 1: '👑', 2: '🥈', 3: '🥉' };
const PODIUM_STYLES = {
  1: 'border-yellow-500/50 bg-yellow-500/[0.04] shadow-[0_0_20px_rgba(234,179,8,0.08)]',
  2: 'border-zinc-400/40 bg-zinc-400/[0.03] shadow-[0_0_14px_rgba(161,161,170,0.06)]',
  3: 'border-amber-700/40 bg-amber-700/[0.03] shadow-[0_0_14px_rgba(180,83,9,0.06)]',
};
const PODIUM_TEXT = {
  1: 'text-yellow-400',
  2: 'text-zinc-300',
  3: 'text-amber-600',
};

export default function LeaderboardPage() {
  const [account, setAccount] = useState('');
  const [activeTab, setActiveTab] = useState('syndicate');

  useEffect(() => {
    const p = getActiveProvider();
    if (p) {
      p.request({ method: 'eth_accounts' }).then((a) => {
        if (a?.[0]) setAccount(a[0]);
      }).catch(() => {});
    }
  }, []);

  const tab = TABS[activeTab];
  const DATA_MAP = { syndicate: MOCK_SYNDICATE, capital: MOCK_CAPITAL, gas: MOCK_GAS };
  const data = DATA_MAP[activeTab];
  const top3 = useMemo(() => data.slice(0, 3), [data]);
  const rest = useMemo(() => data.slice(3), [data]);

  const MY_ENTRIES = {
    syndicate: { rank: 142, address: account, recruits: 3, points: 510 },
    capital: { rank: 56, address: account, projects: 4, volume: 1.245 },
    gas: { rank: 89, address: account, txCount: 247, gasBurned: 0.312 },
  };
  const myEntry = account ? MY_ENTRIES[activeTab] : null;

  return (
    <div className="min-h-screen bg-zinc-950 text-white font-mono px-4 py-12 md:px-8 lg:px-16 max-w-5xl mx-auto">

      {/* ═══ Hero ═══ */}
      <div className="mb-10 text-center">
        <h1 className="text-2xl md:text-3xl font-black tracking-widest uppercase bg-gradient-to-r from-cyan-400 via-blue-500 to-purple-500 bg-clip-text text-transparent drop-shadow-[0_0_20px_rgba(59,130,246,0.3)]">
          /// Syndicate Leaderboard
        </h1>
        <p className="text-zinc-500 text-xs mt-3 max-w-md mx-auto leading-relaxed">
          Top operatives ranked by Merit Points and network expansion.
        </p>
      </div>

      {/* ═══ Tab Toggle ═══ */}
      <div className="flex items-center justify-center gap-2 mb-10">
        {Object.values(TABS).map((t) => {
          const isActive = activeTab === t.id;
          const accentMap = {
            blue: { border: 'border-blue-500', text: 'text-blue-400', bg: 'bg-blue-500/10' },
            emerald: { border: 'border-emerald-500', text: 'text-emerald-400', bg: 'bg-emerald-500/10' },
            orange: { border: 'border-orange-500', text: 'text-orange-400', bg: 'bg-orange-500/10' },
          };
          const a = accentMap[t.accent] || accentMap.blue;
          return (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={[
                'px-4 py-2.5 rounded-lg text-[10px] font-bold tracking-widest uppercase border-2 transition-all duration-200',
                isActive
                  ? `${a.border} ${a.text} ${a.bg}`
                  : 'border-zinc-800 text-zinc-600 hover:text-zinc-400 hover:border-zinc-700',
              ].join(' ')}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {/* ═══ Global Stats ═══ */}
      <div className="grid grid-cols-3 gap-3 mb-10">
        {tab.stats.map((s) => (
          <div key={s.label} className="rounded-lg border border-zinc-800/70 bg-zinc-900/50 p-4 text-center">
            <div className="text-[9px] text-zinc-500 tracking-widest font-bold mb-1.5">{s.label}</div>
            <div className={`text-xl font-black tabular-nums ${s.color}`}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* ═══ Top 3 Podium ═══ */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-10">
        {top3.map((entry, idx) => {
          const rank = idx + 1;
          const meta = tab.podiumMeta(entry);
          return (
            <div
              key={`${activeTab}-${rank}`}
              className={`rounded-xl border p-5 flex flex-col items-center text-center transition-all ${PODIUM_STYLES[rank]}`}
            >
              <span className="text-3xl mb-2">{MEDAL[rank]}</span>
              <span className={`text-lg font-black tabular-nums ${PODIUM_TEXT[rank]}`}>#{rank}</span>
              <span className="text-sm text-zinc-300 mt-1">{truncAddr(entry.address, 6, 4)}</span>
              <div className="mt-3 grid grid-cols-2 gap-4 w-full text-center">
                {meta.map((m) => (
                  <div key={m.label}>
                    <div className="text-[8px] text-zinc-600 tracking-widest">{m.label}</div>
                    <div className={`text-base font-black tabular-nums ${PODIUM_TEXT[rank]}`}>{m.value}</div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* ═══ Rank Table ═══ */}
      <div className="rounded-xl border border-zinc-800/70 bg-zinc-900/30 overflow-hidden mb-6">
        <div className="grid grid-cols-[60px_1fr_100px_120px] text-[9px] text-zinc-600 tracking-widest font-bold border-b border-zinc-800/60 px-4 py-3">
          {tab.columns.map((c) => (
            <span key={c.key} className={c.align}>{c.label}</span>
          ))}
        </div>
        {rest.map((entry) => (
          <div
            key={`${activeTab}-${entry.rank}`}
            className="grid grid-cols-[60px_1fr_100px_120px] items-center px-4 py-3 border-b border-zinc-800/30 hover:bg-zinc-800/20 transition-colors"
          >
            {tab.columns.map((c) => (
              <span key={c.key}>{tab.cellRender(entry, c)}</span>
            ))}
          </div>
        ))}
      </div>

      {/* ═══ Current User Sticky Bar ═══ */}
      {myEntry && (
        <div className="sticky bottom-4 z-50">
          <div className="rounded-xl border border-blue-500/30 bg-zinc-950/95 backdrop-blur-md shadow-[0_0_30px_rgba(59,130,246,0.1)] px-5 py-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
              <span className="text-[10px] text-zinc-500 tracking-widest font-bold">YOUR RANK</span>
              <span className="text-blue-400 text-sm font-black tabular-nums">#{myEntry.rank}</span>
            </div>
            <div className="flex items-center gap-5">
              {tab.podiumMeta(myEntry).map((m) => (
                <div key={m.label} className="text-right">
                  <div className="text-[8px] text-zinc-600 tracking-widest">{m.label}</div>
                  <div className={`text-sm font-black tabular-nums ${{ syndicate: 'text-purple-400', capital: 'text-emerald-400', gas: 'text-orange-400' }[activeTab]}`}>{m.value}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
