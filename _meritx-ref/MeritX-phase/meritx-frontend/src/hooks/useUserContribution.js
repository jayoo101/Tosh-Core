'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { ethers } from 'ethers';
import { FUND_ABI } from '@/lib/abis';
import { getRpcProvider } from '@/lib/web3';

/**
 * Hook: Fetch the connected user's contribution for a given fund.
 * Uses the configured RPC provider (not the wallet provider) so reads
 * succeed regardless of the wallet's currently-selected chain.
 */
export function useUserContribution(fundAddress, account) {
  const [contribution, setContribution] = useState(0);
  const [rawContribution, setRawContribution] = useState(ethers.constants.Zero);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    if (!fundAddress || !account) {
      setContribution(0);
      setRawContribution(ethers.constants.Zero);
      setError(null);
      return;
    }
    if (!ethers.utils.isAddress(fundAddress) || !ethers.utils.isAddress(account)) {
      setContribution(0);
      setRawContribution(ethers.constants.Zero);
      setError(null);
      return;
    }

    setIsLoading(true);
    try {
      const provider = getRpcProvider();
      const contract = new ethers.Contract(fundAddress, FUND_ABI, provider);
      const raw = await contract.contributions(account);
      if (mountedRef.current) {
        setRawContribution(raw);
        setContribution(Number(ethers.utils.formatEther(raw)));
        setError(null);
      }
    } catch (err) {
      console.warn('[useUserContribution] RPC read failed, preserving previous state:', err?.message);
      if (mountedRef.current) {
        setError(err);
      }
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, [fundAddress, account]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { contribution, rawContribution, isLoading, error, refresh };
}
