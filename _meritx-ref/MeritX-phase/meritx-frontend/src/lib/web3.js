// [AUDIT FIX] H3: Mark as client module — accesses window.ethereum
'use client';

import { ethers } from 'ethers';
import toast from 'react-hot-toast';
import { CHAIN_ID, RPC_URL } from '@/lib/constants';
import { getActiveProvider } from '@/lib/walletProvider';

const RPC_TIMEOUT_MS = 25_000;
const MAX_RETRIES    = 3;
const RETRY_BASE_MS  = 600;
let _rpcProvider;

/**
 * StaticJsonRpcProvider subclass that retries ONLY on 502/503 (server errors).
 * 429 (rate limit) and 403 (Cloudflare) are thrown immediately so
 * FallbackProvider can promote the next tier without wasting time.
 */
class RetryJsonRpcProvider extends ethers.providers.StaticJsonRpcProvider {
  async send(method, params) {
    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await super.send(method, params);
      } catch (err) {
        lastError = err;
        const code = err?.status ?? err?.statusCode ?? err?.error?.status;
        const msg = err?.message ?? '';
        if (code === 429 || code === 403) throw err;
        if (/rate.limit|too many req|cloudflare|challenge/i.test(msg)) throw err;
        const isServerError = [502, 503].includes(code) || /server error/i.test(msg);
        if (!isServerError || attempt === MAX_RETRIES) throw err;
        await new Promise(r => setTimeout(r, RETRY_BASE_MS * 2 ** attempt));
      }
    }
    throw lastError;
  }
}

/**
 * Resilient read-only provider with 3-tier automatic failover.
 *
 *   Tier 1 (PRIMARY)  : NEXT_PUBLIC_RPC_URL  — high-perf paid node (Alchemy)
 *   Tier 2 (SECONDARY): first entry of NEXT_PUBLIC_RPC_URL_FALLBACK
 *   Tier 3 (TERTIARY) : remaining entries of NEXT_PUBLIC_RPC_URL_FALLBACK
 *
 * Each tier uses RetryJsonRpcProvider for 429 back-off. FallbackProvider
 * (quorum=1) promotes the next tier when a provider stalls beyond its
 * configured stallTimeout.
 */
export function getRpcProvider() {
  if (_rpcProvider) return _rpcProvider;

  const fallbackRaw = process.env.NEXT_PUBLIC_RPC_URL_FALLBACK || '';
  const fallbackUrls = fallbackRaw.split(',').map(s => s.trim()).filter(Boolean);

  if (fallbackUrls.length === 0) {
    _rpcProvider = new RetryJsonRpcProvider(
      { url: RPC_URL, timeout: RPC_TIMEOUT_MS, skipFetchSetup: true },
      CHAIN_ID,
    );
  } else {
    const allUrls = [RPC_URL, ...fallbackUrls];
    const STALL_TIMEOUTS = [5000, 8000, 12000];
    const configs = allUrls.map((url, i) => ({
      provider: new RetryJsonRpcProvider(
        { url, timeout: RPC_TIMEOUT_MS, skipFetchSetup: true },
        CHAIN_ID,
      ),
      priority: i + 1,
      stallTimeout: STALL_TIMEOUTS[i] ?? 12000,
      weight: 1,
    }));
    _rpcProvider = new ethers.providers.FallbackProvider(configs, 1);
  }

  return _rpcProvider;
}

/**
 * Returns true if a browser wallet is available, false with a toast otherwise.
 */
export function requireWallet() {
  if (!getActiveProvider()) {
    toast.error('Please connect a wallet first.');
    return false;
  }
  return true;
}

/**
 * Creates a Web3Provider → signer → Contract in one call.
 * @param {string} address - Contract address
 * @param {string[]} abi    - Human-readable ABI array
 * @returns {{ provider, signer, contract }}
 */
export function getSignerContract(address, abi) {
  const raw = getActiveProvider();
  if (!raw) throw new Error('No wallet connected');
  const provider = new ethers.providers.Web3Provider(raw);
  const signer = provider.getSigner();
  const contract = new ethers.Contract(address, abi, signer);
  return { provider, signer, contract };
}

/**
 * Creates a read-only Contract backed by the user's provider (no signer).
 */
export function getReadContract(address, abi) {
  const provider = getRpcProvider();
  return new ethers.Contract(address, abi, provider);
}

/**
 * Extract the deepest revert reason string from an ethers.js error.
 * Ethers v5 buries it in different places depending on error type.
 */
function extractRevertReason(err) {
  const candidates = [
    err?.reason,
    err?.error?.reason,
    err?.error?.data?.message,
    err?.data?.message,
    err?.errorArgs?.[0],
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0 && c.length < 200) return c;
  }
  const msg = String(err?.message || '');
  const match = msg.match(/reverted with reason string '([^']+)'/);
  if (match) return match[1];
  const execMatch = msg.match(/execution reverted: ?(.+?)"/);
  if (execMatch) return execMatch[1].trim();
  return '';
}

/**
 * Map well-known contract revert strings to user-friendly messages.
 */
const REVERT_MAP = {
  '!rna':                    'Refund not available: the funding period has not ended, or the project has already been finalized.',
  '!funds':                  'No contribution found for this wallet — nothing to refund.',
  '!refund':                 'ETH transfer failed — your wallet may be a contract that rejects ETH.',
  '!contrib':               'No contribution found — you may have already claimed.',
  '!ready':                 'Tokens cannot be claimed yet — the project has not been finalized.',
  '!time':                  'Funding window has expired.',
  '!expired':               'Backend signature has expired — please retry.',
  '!sig':                   'Signature verification failed — please retry.',
  '!alloc':                 'Amount exceeds your allocation limit.',
  '!fee':                   'Listing fee does not match — please refresh the page.',
  '!treasury':              'Only the treasury wallet can perform this action. Please switch to the treasury address.',
  '!ac':                    'Only the operator or treasury wallet can collect fees.',
  '!paused':                'The protocol is currently paused by the emergency admin.',
  '!cd':                    'Global cooldown active — please wait before contributing again.',
  '!all-pools-polluted':    'All Uniswap V3 fee-tier pools are contaminated. Please contact the team.',
  '!rl':                    'Inflation rate limit reached — try again later.',
  '!notice':                'On-chain notice period has not been reached yet. Please wait for the countdown to finish.',
  '!window':                'The launch deployment window has expired.',
  '!le':                    'Launch expiration exceeded — the deployment window has closed.',
  '!cap':                   'Soft cap not reached — funding target has not been met.',
  '!done':                  'This project has already been finalized.',
  '!no-pool':               'Unable to create or find a suitable Uniswap V3 pool.',
  '!tick-attack':           'Price manipulation detected — tick deviation too large. Please try again later.',
  '!lp':                    'Liquidity position creation failed.',
  '!owner':                 'Only the project owner can perform this action.',
};

/**
 * Standardized transaction error handler.
 * Returns a user-friendly error string. Optionally shows a toast.
 */
export function handleTxError(err, { showToast = true } = {}) {
  console.error('[MeritX TX Error]', err);

  // 1) User rejected in wallet
  if (err?.code === 'ACTION_REJECTED' || err?.code === 4001) {
    const msg = 'Transaction cancelled by user.';
    if (showToast) toast.error(msg);
    return msg;
  }

  // 2) Try to extract a meaningful revert reason first
  const revertReason = extractRevertReason(err);
  if (revertReason) {
    const key = revertReason.toLowerCase();
    for (const [pattern, friendly] of Object.entries(REVERT_MAP)) {
      if (key.includes(pattern)) {
        if (showToast) toast.error(friendly);
        return friendly;
      }
    }
    const msg = `Contract reverted: ${revertReason}`;
    if (showToast) toast.error(msg);
    return msg;
  }

  const rawReason = String(
    err?.reason || err?.error?.reason || err?.data?.message || err?.message || ''
  ).toLowerCase();

  // 3) JSON-RPC internal errors
  if (String(err?.code) === '-32603' || rawReason.includes('internal json-rpc error')) {
    const msg = 'Transaction failed: Network congestion or RPC error. Please retry.';
    if (showToast) toast.error(msg);
    return msg;
  }

  // 4) Balance / funds
  if (rawReason.includes('insufficient funds') || rawReason.includes('insufficient balance')) {
    const msg = 'Insufficient ETH balance for this transaction.';
    if (showToast) toast.error(msg);
    return msg;
  }

  // 5) Fallback
  const msg = 'Transaction failed: An unexpected error occurred. Check the browser console for details.';
  if (showToast) toast.error(msg);
  return msg;
}
