'use client';
import { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';
import toast from 'react-hot-toast';
import { useNetwork } from '@/lib/useNetwork';
import { getActiveProvider } from '@/lib/walletProvider';
import { CHAIN_NAME } from '@/lib/constants';
import { FUND_ABI, TOKEN_ABI } from '@/lib/abis';
import { getSignerContract, getReadContract, handleTxError } from '@/lib/web3';
import { fmtUTC } from '@/lib/fmt';

const TX_WAIT_TIMEOUT_MS = 90_000;
const TX_TIMEOUT_MSG = 'Transaction is taking longer than expected. Check your wallet or block explorer for status.';
function waitWithTimeout(txPromise) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('TX_WAIT_TIMEOUT')), TX_WAIT_TIMEOUT_MS);
  });
  return Promise.race([txPromise, timeout]).finally(() => clearTimeout(timer));
}

export default function InflationStats({ fundAddress }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [minting, setMinting] = useState(false);
  const [error, setError] = useState(null);
  const { isCorrectChain } = useNetwork();

  const fetchData = useCallback(async () => {
    if (!fundAddress) return;
    try {
      const fund = getReadContract(fundAddress, FUND_ABI);

      const [finalized, pool] = await Promise.all([
        fund.isFinalized(),
        fund.uniswapPool(),
      ]);

      if (!finalized || pool === ethers.constants.AddressZero) {
        setData({ finalized, poolReady: false });
        setLoading(false);
        return;
      }

      const tokenAddr = await fund.projectToken();
      const token = getReadContract(tokenAddr, TOKEN_ABI);

      let twapTick, targetSupply, currentSupply, initialSupply, lastMint, cooldown;
      try {
        [twapTick, currentSupply, initialSupply, lastMint, cooldown] = await Promise.all([
          fund.getTWAP(),
          token.totalSupply(),
          fund.INITIAL_SUPPLY(),
          fund.lastMintTime(),
          fund.RATE_WINDOW(),
        ]);
        targetSupply = await fund.calculateTargetSupply(twapTick);
      } catch {
        setData({ finalized, poolReady: true, twapNotReady: true });
        setLoading(false);
        return;
      }

      const currentNum = Number(ethers.utils.formatEther(currentSupply));
      const targetNum = Number(ethers.utils.formatEther(targetSupply));
      const initialNum = Number(ethers.utils.formatEther(initialSupply));
      const mintable = targetNum > currentNum ? targetNum - currentNum : 0;
      const growthPct = initialNum > 0 ? ((targetNum - initialNum) / initialNum) * 100 : 0;
      const nextMintAt = (Number(lastMint) + Number(cooldown)) * 1000;
      const canMint = mintable > 0 && Date.now() >= nextMintAt;

      setData({
        finalized,
        poolReady: true,
        twapNotReady: false,
        currentSupply: currentNum,
        targetSupply: targetNum,
        initialSupply: initialNum,
        mintable,
        growthPct,
        canMint,
        nextMintAt,
        twapTick: Number(twapTick),
      });
      setError(null);
    } catch (err) {
      if (process.env.NODE_ENV !== 'production') {
        // eslint-disable-next-line no-console
        console.error('InflationStats fetch error:', err);
      }
      setError('Failed to read inflation data');
    } finally {
      setLoading(false);
    }
  }, [fundAddress]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleMint = async () => {
    if (!fundAddress || !getActiveProvider()) return;
    if (!isCorrectChain) { toast.error(`Wrong network — switch to ${CHAIN_NAME} first.`); return; }
    setMinting(true);
    try {
      const { contract } = getSignerContract(fundAddress, FUND_ABI);
      const tx = await contract.mintInflation({ gasLimit: 500000 });
      toast('Minting inflation...');
      await waitWithTimeout(tx.wait());
      toast.success('Inflation minted — 0.1% caller reward sent to your wallet');
      fetchData();
    } catch (err) {
      if (err?.message === 'TX_WAIT_TIMEOUT') { toast.error(TX_TIMEOUT_MSG); return; }
      handleTxError(err);
    } finally {
      setMinting(false);
    }
  };

  if (loading) {
    return (
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 animate-pulse">
        <div className="h-4 bg-zinc-800 rounded w-40 mb-3" />
        <div className="h-20 bg-zinc-800/50 rounded" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-red-500/20 bg-red-950/20 p-5">
        <p className="text-xs text-red-400 font-mono">{error}</p>
      </div>
    );
  }

  if (!data || !data.finalized) {
    return (
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
        <h3 className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-2 flex items-center gap-2">
          <span className="text-purple-500 font-mono">&gt;</span> PoP INFLATION ENGINE
        </h3>
        <p className="text-xs text-zinc-600 font-mono">Activates after finalization + pool creation</p>
      </div>
    );
  }

  if (!data.poolReady) {
    return (
      <div className="rounded-2xl border border-amber-500/20 bg-amber-950/10 p-5">
        <h3 className="text-[10px] font-bold uppercase tracking-widest text-amber-500 mb-2 flex items-center gap-2">
          <span className="font-mono">&gt;</span> PoP INFLATION ENGINE
        </h3>
        <p className="text-xs text-amber-400/70 font-mono">Awaiting Uniswap V3 pool creation via finalizeFunding()</p>
      </div>
    );
  }

  if (data.twapNotReady) {
    return (
      <div className="rounded-2xl border border-purple-500/20 bg-purple-950/10 p-5">
        <h3 className="text-[10px] font-bold uppercase tracking-widest text-purple-500 mb-2 flex items-center gap-2">
          <span className="font-mono">&gt;</span> PoP INFLATION ENGINE
        </h3>
        <p className="text-xs text-purple-400/70 font-mono">Pool created. TWAP oracle warming up (needs ~30 min of trading history).</p>
      </div>
    );
  }

  const supplyGrowthPct = data.initialSupply > 0
    ? ((data.currentSupply - data.initialSupply) / data.initialSupply) * 100
    : 0;
  const potentialPct = data.currentSupply > 0
    ? (data.mintable / data.currentSupply) * 100
    : 0;
  const meterPct = Math.min(Math.max(data.growthPct, 0), 100);

  return (
    <div className="rounded-2xl border border-purple-500/20 bg-zinc-900/40 backdrop-blur-sm p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] font-bold uppercase tracking-widest text-purple-500 flex items-center gap-2">
          <span className="font-mono">&gt;</span> PoP INFLATION ENGINE
        </h3>
        <span className="flex items-center gap-1.5 text-[10px] font-mono text-purple-400/60">
          <span className="w-1.5 h-1.5 rounded-full bg-purple-500 animate-pulse" />
          TWAP tick: {data.twapTick}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div className="p-2.5 rounded-lg bg-black/30 border border-zinc-800/60">
          <p className="text-[9px] text-zinc-600 uppercase tracking-widest mb-1">Current Supply</p>
          <p className="text-sm font-black font-mono text-white tabular-nums">
            {(data.currentSupply / 1e6).toFixed(2)}<span className="text-[10px] text-zinc-600 ml-1">M</span>
          </p>
        </div>
        <div className="p-2.5 rounded-lg bg-black/30 border border-zinc-800/60">
          <p className="text-[9px] text-zinc-600 uppercase tracking-widest mb-1">Target Supply</p>
          <p className="text-sm font-black font-mono text-purple-400 tabular-nums">
            {(data.targetSupply / 1e6).toFixed(2)}<span className="text-[10px] text-zinc-600 ml-1">M</span>
          </p>
        </div>
        <div className="p-2.5 rounded-lg bg-black/30 border border-zinc-800/60">
          <p className="text-[9px] text-zinc-600 uppercase tracking-widest mb-1">Mintable</p>
          <p className={`text-sm font-black font-mono tabular-nums ${data.mintable > 0 ? 'text-emerald-400' : 'text-zinc-500'}`}>
            {data.mintable > 1000 ? (data.mintable / 1e6).toFixed(4) + 'M' : data.mintable.toFixed(2)}
          </p>
        </div>
      </div>

      {/* Growth Potential Meter */}
      <div>
        <div className="flex justify-between items-baseline text-[10px] mb-1.5">
          <span className="text-zinc-500 font-mono">Growth Potential</span>
          <span className="font-mono text-purple-400 tabular-nums">{potentialPct.toFixed(3)}%</span>
        </div>
        <div className="w-full h-2 bg-zinc-800 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-purple-600 to-purple-400 transition-all duration-700"
            style={{ width: `${Math.min(meterPct, 100)}%` }}
          />
        </div>
        <div className="flex justify-between text-[9px] text-zinc-600 font-mono mt-1">
          <span>S0 = {(data.initialSupply / 1e6).toFixed(2)}M</span>
          <span>Supply grew {supplyGrowthPct.toFixed(4)}% since genesis</span>
        </div>
      </div>

      {/* Mint Trigger */}
      <button
        onClick={data.canMint ? handleMint : undefined}
        disabled={!data.canMint || minting || !isCorrectChain}
        className={[
          'w-full py-3.5 rounded-xl font-black text-xs uppercase tracking-wider transition-all',
          !data.canMint || minting || !isCorrectChain
            ? 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
            : 'bg-purple-600/20 text-purple-400 border border-purple-500/30 hover:bg-purple-600/30 hover:shadow-[0_0_20px_rgba(147,51,234,0.15)]',
        ].join(' ')}
      >
        {minting
          ? 'MINTING...'
          : data.canMint
            ? 'TRIGGER PROTOCOL MINT (0.1% CALLER REWARD)'
            : data.mintable > 0
              ? `COOLDOWN ACTIVE \u2014 NEXT MINT ${fmtUTC(data.nextMintAt)}`
              : 'NO INFLATION NEEDED (PRICE AT OR BELOW GENESIS)'}
      </button>
    </div>
  );
}
