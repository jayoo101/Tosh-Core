'use client';
import { useNetwork } from '@/lib/useNetwork';

export default function NetworkGuard() {
  const { isCorrectChain, switchToBase, chainId } = useNetwork();

  if (isCorrectChain || chainId === null) return null;

  return (
    <div className="sticky top-14 z-40 w-full bg-red-950/90 border-b border-red-500/30 backdrop-blur-md">
      <div className="max-w-6xl mx-auto px-4 py-3 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 sm:gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse shrink-0" />
          <p className="text-xs font-mono text-red-300">
            <span className="mr-1">{'\u26A0\uFE0F'}</span>
            Unsupported Network (chain {chainId}). Please switch to <span className="font-bold text-red-200">Base Mainnet</span> to use MeritX.
          </p>
        </div>
        <button
          onClick={switchToBase}
          className="shrink-0 px-5 py-2 rounded-lg bg-red-600 text-white text-xs font-bold uppercase tracking-wider hover:bg-red-500 transition-colors whitespace-nowrap"
        >
          SWITCH TO BASE MAINNET
        </button>
      </div>
    </div>
  );
}
