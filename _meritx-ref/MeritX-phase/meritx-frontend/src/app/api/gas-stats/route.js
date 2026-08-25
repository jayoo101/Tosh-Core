import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { CHAIN_ID } from '@/lib/constants';
import { scanAllChainGas } from '@/lib/moralis-gas';
import { createRateLimiter } from '@/lib/rateLimit';

export const runtime = 'nodejs';
export const maxDuration = 30;

const ROUTE_TIMEOUT_MS = 25_000;
const ipLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });
const forceLimiter = createRateLimiter({ windowMs: 300_000, max: 2 });
const MAX_CACHE_ENTRIES = 5000;

function getClientIP(request) {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || 'unknown';
}

const MIN_GAS_ETH = Number(process.env.MIN_GAS_ETH ?? 0.1);
const MAX_GAS_ETH = 5;
const ALLOCATION_RATIO = Number(process.env.ALLOCATION_RATIO ?? 0.05);
const MAX_ALLOCATION_ETH = 0.15;
const GLOBAL_COOLDOWN_MS = Number(process.env.GLOBAL_COOLDOWN_MS) || 48 * 60 * 60 * 1000;
const GAS_CACHE_TTL_MS = 48 * 60 * 60 * 1000;

const gasCache = new Map();

export async function GET(req) {
  const ip = getClientIP(req);
  const rl = ipLimiter(ip);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Please wait before retrying.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rl.retryAfterMs || 60_000) / 1000)) } }
    );
  }

  const { searchParams } = new URL(req.url);
  const address = searchParams.get('address');
  let forceRevalidate = searchParams.get('force') === 'true';

  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 });
  }

  if (forceRevalidate) {
    const frl = forceLimiter(ip);
    if (!frl.allowed) forceRevalidate = false;
  }

  const apiKey = process.env.MORALIS_API_KEY;
  if (!apiKey) {
    console.error('[gas-stats] FATAL: MORALIS_API_KEY is not set in environment variables');
    return NextResponse.json({ error: 'MORALIS_API_KEY not configured on server' }, { status: 503 });
  }

  const cacheKey = address.toLowerCase();

  try {
    let gasData;
    let scanTs;
    const cached = gasCache.get(cacheKey);
    const cacheAge = cached ? Date.now() - cached.ts : Infinity;
    const cacheValid = cached && cacheAge < GAS_CACHE_TTL_MS;

    if (cacheValid && !forceRevalidate) {
      gasData = cached.data;
      scanTs = cached.ts;
      console.log(`[gas-stats] cache HIT for ${cacheKey} (age: ${Math.round(cacheAge / 60000)}min)`);
    } else {
      let routeTimer;
      const result = await Promise.race([
        scanAllChainGas(address, apiKey, '[gas-stats]'),
        new Promise((_, reject) => {
          routeTimer = setTimeout(() => reject(new Error('ROUTE_TIMEOUT')), ROUTE_TIMEOUT_MS);
        }),
      ]).finally(() => clearTimeout(routeTimer));

      gasData = result;
      scanTs = Date.now();
      if (gasCache.size >= MAX_CACHE_ENTRIES) gasCache.clear();
      gasCache.set(cacheKey, { ts: scanTs, data: gasData });
      console.log(`[gas-stats] cache ${forceRevalidate ? 'BUST' : 'MISS'} → SET for ${cacheKey} | totalGas=${gasData.totalGas.toFixed(6)}`);
    }

    const { totalGas, chains: perChain } = gasData;
    const cappedGas = Math.min(totalGas, MAX_GAS_ETH);
    const maxAllocation = Math.min(cappedGas * ALLOCATION_RATIO, MAX_ALLOCATION_ETH);

    const cooldownResult = await fetchCooldown(address);

    return NextResponse.json({
      totalGas,
      minGasRequired: MIN_GAS_ETH,
      eligible: totalGas >= MIN_GAS_ETH,
      maxAllocation,
      breakdown: (perChain || []).map(c => ({ chain: c.chain, gasEth: Number(c.gas.toFixed(6)) })),
      cooldown: cooldownResult,
      cached: cacheValid && !forceRevalidate,
      scannedAt: scanTs,
      nextScanAt: scanTs + GAS_CACHE_TTL_MS,
    });
  } catch (err) {
    if (err?.message === 'ROUTE_TIMEOUT') {
      console.error('[gas-stats] scan exceeded route timeout for', cacheKey);
      return NextResponse.json({ error: 'Scan timed out — high transaction volume. Please retry.' }, { status: 504 });
    }
    console.error('[gas-stats] scan failed:', err);
    return NextResponse.json({ error: 'Scan failed' }, { status: 500 });
  }
}

async function fetchCooldown(userAddress) {
  try {
    const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;
    const factoryAddress = process.env.NEXT_PUBLIC_FACTORY_ADDRESS;
    if (!rpcUrl || !factoryAddress) return { active: false, remainMs: 0 };

    const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID || CHAIN_ID);
    const provider = new ethers.providers.StaticJsonRpcProvider(
      { url: rpcUrl, timeout: 20000, skipFetchSetup: true }, chainId,
    );
    const factory = new ethers.Contract(
      factoryAddress,
      ['function lastContributionTime(address) view returns (uint256)'],
      provider,
    );

    const lastSec = await factory.lastContributionTime(userAddress);
    const lastMs = Number(lastSec) * 1000;
    if (lastMs === 0) return { active: false, remainMs: 0 };

    const elapsed = Date.now() - lastMs;
    if (elapsed < GLOBAL_COOLDOWN_MS) {
      return { active: true, remainMs: GLOBAL_COOLDOWN_MS - elapsed };
    }
    return { active: false, remainMs: 0 };
  } catch (err) {
    console.warn('[gas-stats] cooldown check failed:', err?.message);
    return { active: false, remainMs: 0 };
  }
}
