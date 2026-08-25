"use client";

import { useState } from 'react';
import { EXPLORER_URL } from '@/lib/constants';

export default function FinalizedDashboard({ tokenAddress, poolAddress }) {
  const [copiedText, setCopiedText] = useState("");

  const handleCopy = (text, label) => {
    navigator.clipboard.writeText(text);
    setCopiedText(label);
    setTimeout(() => setCopiedText(""), 2000);
  };

  const formatAddress = (addr) => {
    if (!addr) return "N/A";
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  return (
    <div className="w-full max-w-2xl mx-auto mt-8 bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl overflow-hidden font-sans">
      
      <div className="p-6 border-b border-zinc-800">
        <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" /> Deployment Successful
        </h2>
        
        <div className="space-y-4">
          <div className="flex justify-between items-center bg-zinc-800 p-3 rounded-lg">
            <div>
              <p className="text-xs text-zinc-400 uppercase tracking-wider mb-1">Token Contract</p>
              <p className="text-sm text-zinc-200 font-mono">{formatAddress(tokenAddress)}</p>
            </div>
            <button 
              onClick={() => handleCopy(tokenAddress, 'token')}
              className="px-4 py-2 text-sm font-medium text-blue-400 bg-blue-900/30 hover:bg-blue-900/50 rounded-md transition-colors"
            >
              {copiedText === 'token' ? 'COPIED' : 'COPY'}
            </button>
          </div>

          <div className="flex justify-between items-center bg-zinc-800 p-3 rounded-lg">
            <div>
              <p className="text-xs text-zinc-400 uppercase tracking-wider mb-1">Liquidity Pool (Uniswap V3)</p>
              <p className="text-sm text-zinc-200 font-mono">{formatAddress(poolAddress)}</p>
            </div>
            <button 
              onClick={() => handleCopy(poolAddress, 'pool')}
              className="px-4 py-2 text-sm font-medium text-purple-400 bg-purple-900/30 hover:bg-purple-900/50 rounded-md transition-colors"
            >
              {copiedText === 'pool' ? 'COPIED' : 'COPY'}
            </button>
          </div>
        </div>
      </div>

      <div className="p-6 bg-zinc-900/50">
        <h3 className="text-sm text-zinc-400 uppercase tracking-wider mb-4">Portals</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          
          <a 
            href={`https://app.uniswap.org/swap?outputCurrency=${tokenAddress}&chain=base`}
            target="_blank" 
            rel="noopener noreferrer"
            className="flex items-center justify-center py-3 px-4 bg-pink-600 hover:bg-pink-500 text-white font-bold rounded-xl transition-all shadow-lg shadow-pink-900/20"
          >
            Trade on Uniswap
          </a>

          <a 
            href={`${EXPLORER_URL}/token/${tokenAddress}`}
            target="_blank" 
            rel="noopener noreferrer"
            className="flex items-center justify-center py-3 px-4 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-xl transition-all shadow-lg shadow-blue-900/20"
          >
            View on BaseScan
          </a>

        </div>
      </div>

    </div>
  );
}
