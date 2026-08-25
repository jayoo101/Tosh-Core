'use client';
import { useState, useEffect, useCallback } from 'react';
import { CHAIN_ID, CHAIN_ID_HEX, CHAIN_NAME, RPC_URL, EXPLORER_URL } from './constants';
import { getActiveProvider, onProviderChange } from './walletProvider';

export function useNetwork() {
  const [chainId, setChainId] = useState(null);
  const [provider, setProvider] = useState(() => getActiveProvider());

  // Sync React state whenever the module-level provider changes
  useEffect(() => onProviderChange((p) => setProvider(p)), []);

  // Attach chainChanged listener — re-attaches when provider changes
  useEffect(() => {
    if (!provider) { setChainId(null); return; }
    provider.request({ method: 'eth_chainId' })
      .then(id => setChainId(Number(id)))
      .catch(() => {});
    const handler = (id) => setChainId(Number(id));
    provider.on('chainChanged', handler);
    return () => provider.removeListener('chainChanged', handler);
  }, [provider]);

  const isCorrectChain = chainId === null || chainId === CHAIN_ID;

  const switchToBase = useCallback(async () => {
    const p = getActiveProvider();
    if (!p) return;
    try {
      await p.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: CHAIN_ID_HEX }],
      });
    } catch (err) {
      if (err?.code === 4902) {
        try {
          await p.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: CHAIN_ID_HEX,
              chainName: CHAIN_NAME,
              nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
              rpcUrls: [RPC_URL],
              blockExplorerUrls: [EXPLORER_URL],
            }],
          });
        } catch (innerErr) {
          if (process.env.NODE_ENV !== 'production' && innerErr?.code !== 4001 && innerErr?.code !== 'ACTION_REJECTED') {
            console.warn('Failed to add chain:', innerErr);
          }
        }
      }
    }
  }, []);

  return { chainId, isCorrectChain, switchToBase };
}
