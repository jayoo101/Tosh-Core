// MeritX Protocol — Base L2 Configuration (Single Source of Truth)
// MAINNET ONLY — hardcoded safety net prevents any testnet misconfiguration.

// Network — locked to Base Mainnet. Env overrides are accepted ONLY if they
// match mainnet chain ID. Any stale Sepolia config is forcefully corrected.
const _rawChainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID) || 8453;
export const CHAIN_ID     = _rawChainId === 8453 ? 8453 : 8453;
export const CHAIN_ID_HEX = '0x2105';
export const CHAIN_NAME   = 'Base';
export const RPC_URL      = (() => {
  const url = process.env.NEXT_PUBLIC_RPC_URL || '';
  if (url && !url.toLowerCase().includes('sepolia')) return url;
  return 'https://base.llamarpc.com';
})();
export const EXPLORER_URL = 'https://basescan.org';

// Contract addresses — MUST be set via env. No hardcoded fallback to prevent
// accidental calls to stale/wrong-network contracts.
export const FACTORY_ADDRESS = process.env.NEXT_PUBLIC_FACTORY_ADDRESS || '';

// Protocol treasury & well-known addresses
export const TREASURY_WALLET = process.env.NEXT_PUBLIC_TREASURY_WALLET || '';
export const WETH_ADDRESS    = process.env.NEXT_PUBLIC_WETH_ADDRESS    || '0x4200000000000000000000000000000000000006';

// Economic parameters (mainnet defaults — match on-chain constants)
export const SOFT_CAP_ETH    = process.env.NEXT_PUBLIC_SOFT_CAP_ETH    || '5';
export const MAX_INVEST_ETH  = process.env.NEXT_PUBLIC_MAX_INVEST_ETH  || '0.15';
export const LISTING_FEE_ETH = process.env.NEXT_PUBLIC_LISTING_FEE_ETH || '0.01';
