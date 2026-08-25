'use client';

const WALLETS = {
  metamask:  { label: 'MetaMask',  icon: '/wallets/metamask.svg', detect: () => {
    const provs = window.ethereum?.providers;
    if (Array.isArray(provs)) {
      const mm = provs.find(p => p.isMetaMask && !p.isOkxWallet && !p.isBitKeep);
      if (mm) return mm;
    }
    return window.ethereum?.isMetaMask ? window.ethereum : null;
  }},
  coinbase:  { label: 'Coinbase Wallet', icon: '/wallets/coinbase.svg', detect: () => {
    if (window.coinbaseWalletExtension) return window.coinbaseWalletExtension;
    const provs = window.ethereum?.providers;
    if (Array.isArray(provs)) {
      const cb = provs.find(p => p.isCoinbaseWallet || p.isCoinbaseBrowser);
      if (cb) return cb;
    }
    return window.ethereum?.isCoinbaseWallet ? window.ethereum : null;
  }},
  okx:       { label: 'OKX Wallet',      icon: '/wallets/okx.svg',      detect: () => window.okxwallet ?? null },
  binance:   { label: 'Binance Wallet',  icon: '/wallets/binance.svg',  detect: () => window.BinanceChain ?? null },
  trust:     { label: 'Trust Wallet',    icon: '/wallets/trust.svg',    detect: () => window.trustwallet?.ethereum ?? window.trustwallet ?? null },
  bitget:    { label: 'Bitget Wallet',   icon: '/wallets/bitget.svg',   detect: () => window.bitkeep?.ethereum ?? null },
};

let _activeProvider = null;
let _disconnected = false;
const _listeners = new Set();

export function getWalletProvider(walletType) {
  if (typeof window === 'undefined') return null;
  const entry = WALLETS[walletType];
  if (!entry) return null;
  return entry.detect();
}

export function getActiveProvider() {
  if (_disconnected) return null;
  if (_activeProvider) return _activeProvider;
  return (typeof window !== 'undefined' && window.ethereum) ? window.ethereum : null;
}

export function setActiveProvider(provider) {
  _activeProvider = provider;
  _disconnected = provider === null;
  _listeners.forEach(fn => fn(provider));
}

export function onProviderChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

export function getWalletLabel(walletType) {
  return WALLETS[walletType]?.label ?? walletType;
}

export function getSupportedWallets() {
  return Object.entries(WALLETS).map(([key, { label, icon }]) => ({ key, label, icon }));
}
