'use client';

import { useCallback } from 'react';
import useSWR from 'swr';

/**
 * Canonical chain list for gas display (must match server TARGET_CHAINS order).
 * Exported so consumers (modal, charts) can iterate without re-declaring.
 */
export const GAS_CHAINS = [
  { id: '0x1',    tag: 'ETH',  name: 'Ethereum' },
  { id: '0x2105', tag: 'BASE', name: 'Base' },
  { id: '0xa',    tag: 'OP',   name: 'Optimism' },
  { id: '0xa4b1', tag: 'ARB',  name: 'Arbitrum' },
];

async function fetchGasStats(account, force = false) {
  const qs = force ? `&force=true` : '';
  const res = await fetch(`/api/gas-stats?address=${account}${qs}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg = res.status === 503 ? 'SERVER_MISCONFIGURED'
      : res.status === 504 ? 'SCAN_TIMEOUT'
      : res.status === 429 ? 'RATE_LIMITED'
      : body.error || `HTTP_${res.status}`;
    throw new Error(msg);
  }
  return res.json();
}

/**
 * Single source of truth for a user's cross-chain gas expenditure and
 * derived allocation limit. Both Navbar and PogUnlockModal share this
 * SWR cache — identical key ensures deduplication and consistent numbers.
 *
 * @param {string|null} account - Connected wallet address (null = disabled)
 * @returns {{ totalGas, maxAllocation, eligible, breakdown, cooldown,
 *             minGasRequired, isLoading, error, refresh, chainGas }}
 */
export function useGasAllocation(account) {
  const key = account ? ['gas-allocation', account.toLowerCase()] : null;

  const { data, error, isLoading, mutate } = useSWR(key, () => fetchGasStats(account), {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    dedupingInterval: 60_000,
    refreshInterval: 0,
    errorRetryCount: 1,
  });

  const refresh = useCallback(
    (force = false) => mutate(() => fetchGasStats(account, force)),
    [account, mutate],
  );

  const breakdown = data?.breakdown ?? [];
  const chainGas = GAS_CHAINS.map(c => {
    const found = breakdown.find(b => b.chain === c.id);
    return found ? found.gasEth : 0;
  });

  return {
    totalGas:       data?.totalGas ?? 0,
    maxAllocation:  data?.maxAllocation ?? 0,
    eligible:       data?.eligible ?? false,
    breakdown,
    chainGas,
    cooldown:       data?.cooldown ?? { active: false, remainMs: 0 },
    minGasRequired: data?.minGasRequired ?? 0.1,
    scannedAt:      data?.scannedAt ?? null,
    isLoaded:       !!data,
    isLoading,
    error:          error ?? null,
    refresh,
  };
}
