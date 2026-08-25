'use client';

import { useState, useEffect, useCallback } from 'react';
import { getWalletProvider, getActiveProvider, setActiveProvider, getWalletLabel, onProviderChange } from '@/lib/walletProvider';

export function useWallet() {
  const [account, setAccount] = useState('');
  const [provider, setProvider] = useState(() => getActiveProvider());

  // Sync React state whenever the module-level provider changes
  useEffect(() => onProviderChange((p) => setProvider(p)), []);

  // Auto-reconnect on mount if previously connected
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const savedType = localStorage.getItem('meritx_walletType');
    if (localStorage.getItem('isWalletConnected') !== 'true' || !savedType) return;

    const raw = getWalletProvider(savedType);
    if (!raw) return;
    setActiveProvider(raw);
    raw.request({ method: 'eth_accounts' })
      .then((accs) => { if (accs?.[0]) setAccount(accs[0]); })
      .catch(() => {});
  }, []);

  // Listen for account changes — re-attaches when provider changes
  useEffect(() => {
    if (!provider) { setAccount(''); return; }
    provider.request({ method: 'eth_accounts' })
      .then((accs) => { if (accs?.[0]) setAccount(accs[0]); })
      .catch(() => {});

    const handler = (accounts) => setAccount(accounts?.[0] ?? '');
    provider.on('accountsChanged', handler);
    return () => provider.removeListener('accountsChanged', handler);
  }, [provider]);

  const connectWallet = useCallback(async (walletType = 'metamask') => {
    if (typeof window === 'undefined') throw new Error('Not in browser');

    const raw = getWalletProvider(walletType);
    if (!raw) {
      throw new Error(`${getWalletLabel(walletType)} not detected. Please install it first.`);
    }

    setActiveProvider(raw);

    try {
      await raw.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
    } catch {
      // Some wallets don't support wallet_requestPermissions
    }

    const accounts = await raw.request({ method: 'eth_requestAccounts' });
    if (accounts?.[0]) {
      setAccount(accounts[0]);
      localStorage.setItem('isWalletConnected', 'true');
      localStorage.setItem('meritx_walletType', walletType);
    }
  }, []);

  return { account, connectWallet };
}
