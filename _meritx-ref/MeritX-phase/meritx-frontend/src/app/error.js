'use client';

import { useEffect } from 'react';

export default function GlobalError({ error, reset }) {
  useEffect(() => {
    console.error('[MeritX] Unhandled render error:', error);
  }, [error]);

  return (
    <div className="min-h-[80vh] flex flex-col items-center justify-center px-6 text-center" style={{ background: '#050505' }}>
      <div className="relative mb-8">
        <div className="w-20 h-20 rounded-2xl border border-red-500/30 bg-red-500/[0.06] flex items-center justify-center shadow-[0_0_40px_rgba(239,68,68,0.15)]">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-red-500">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </div>
        <span className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full animate-ping opacity-60" />
      </div>

      <p className="text-red-500/80 font-mono text-[10px] font-bold tracking-[0.3em] uppercase mb-3">
        /// SYSTEM EXCEPTION
      </p>
      <h1 className="text-2xl sm:text-3xl font-black text-white tracking-tight mb-3">
        Unexpected Failure
      </h1>
      <p className="text-sm text-zinc-500 font-mono max-w-md mb-2 leading-relaxed">
        A runtime error interrupted the current operation. Your funds and on-chain state are unaffected.
      </p>
      <p className="text-xs text-zinc-700 font-mono mb-8 max-w-sm break-all">
        {error?.message?.slice(0, 120) || 'Unknown error'}
      </p>

      <button
        onClick={reset}
        className="group relative px-8 py-3 rounded-xl text-sm font-black uppercase tracking-wider text-white overflow-hidden bg-gradient-to-r from-red-600 to-red-500 hover:from-red-500 hover:to-red-400 shadow-lg shadow-red-900/20 hover:shadow-red-800/30 transition-all duration-300"
      >
        <span className="absolute inset-0 bg-gradient-to-r from-transparent via-white/[0.07] to-transparent translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-700" />
        <span className="relative z-10 flex items-center gap-2">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M1 4v6h6" /><path d="M3.51 15a9 9 0 102.13-9.36L1 10" />
          </svg>
          Reboot System
        </span>
      </button>

      <p className="text-[9px] text-zinc-700 font-mono mt-6 tracking-wider">
        If this persists, clear cache and reconnect your wallet.
      </p>
    </div>
  );
}
