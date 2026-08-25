import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { CHAIN_ID } from '@/lib/constants';
import { scanAllChainGas } from '@/lib/moralis-gas';
import { createRateLimiter } from '@/lib/rateLimit';

export const runtime = 'nodejs';
export const maxDuration = 30;

const ROUTE_TIMEOUT_MS = 25_000;
const GLOBAL_COOLDOWN_MS = Number(process.env.GLOBAL_COOLDOWN_MS) || 48 * 60 * 60 * 1000;
const SIG_TTL_SECS       = 3600;

const MIN_GAS_ETH = Number(process.env.MIN_GAS_ETH ?? 0.1);
const MAX_GAS_ETH = 5;
const ALLOCATION_RATIO = Number(process.env.ALLOCATION_RATIO ?? 0.05);
const MAX_ALLOCATION_ETH = 0.15;

const ipLimiter = createRateLimiter({ windowMs: 60_000, max: 5 });

function getClientIP(request) {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || 'unknown';
}

export async function POST(request) {
  // ⚠️ CRITICAL: This private key MUST correspond to the `backendSigner` address
  // stored in every MeritXFund contract (set via MeritXFactory at deployment).
  // A mismatch will cause all contribute() calls to revert with "!sig".
  const privateKey = process.env.BACKEND_SIGNER_PRIVATE_KEY;
  if (!privateKey) {
    console.error('[sign-allocation] FATAL: BACKEND_SIGNER_PRIVATE_KEY is not set');
    return NextResponse.json({ success: false, error: 'Server configuration error' }, { status: 503 });
  }

  const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;
  if (!rpcUrl) {
    console.error('[sign-allocation] FATAL: NEXT_PUBLIC_RPC_URL is not set');
    return NextResponse.json({ success: false, error: 'Server configuration error' }, { status: 503 });
  }

  const factoryAddress = process.env.NEXT_PUBLIC_FACTORY_ADDRESS;
  if (!factoryAddress) {
    console.error('[sign-allocation] FATAL: NEXT_PUBLIC_FACTORY_ADDRESS is not set');
    return NextResponse.json({ success: false, error: 'Server configuration error' }, { status: 503 });
  }

  const moralisKey = process.env.MORALIS_API_KEY;
  if (!moralisKey) {
    console.error('[sign-allocation] FATAL: MORALIS_API_KEY is not set');
    return NextResponse.json({ success: false, error: 'Server configuration error' }, { status: 503 });
  }

  const ip = getClientIP(request);
  const rl = ipLimiter(ip);
  if (!rl.allowed) {
    return NextResponse.json(
      { success: false, error: 'Rate limit exceeded. Please wait before retrying.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rl.retryAfterMs || 60_000) / 1000)) } }
    );
  }

  let body;
  try { body = await request.json(); } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const { userAddress, fundAddress } = body || {};
  if (!userAddress || !fundAddress) {
    return NextResponse.json({ success: false, error: 'Missing required fields: userAddress, fundAddress' }, { status: 400 });
  }
  if (!ethers.utils.isAddress(userAddress) || !ethers.utils.isAddress(fundAddress)) {
    return NextResponse.json({ success: false, error: 'Invalid address format' }, { status: 400 });
  }

  let step = 'init';
  try {
    // ── Cooldown check ──
    step = 'cooldown';
    const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID || CHAIN_ID);
    const provider = new ethers.providers.StaticJsonRpcProvider(
      { url: rpcUrl, timeout: 20000, skipFetchSetup: true }, chainId,
    );
    const factory = new ethers.Contract(
      factoryAddress,
      ['function lastContributionTime(address) view returns (uint256)'],
      provider,
    );

    let lastContribSec;
    try {
      lastContribSec = await factory.lastContributionTime(userAddress);
    } catch (e) {
      console.error(`[sign-allocation] cooldown RPC failed — refusing to issue signature:`, e?.message);
      return NextResponse.json(
        { success: false, error: 'Failed to verify cooldown status due to RPC error. Please try again.' },
        { status: 503 }
      );
    }

    const lastTimeMs = Number(lastContribSec) * 1000;
    if (lastTimeMs > 0) {
      const elapsed = Date.now() - lastTimeMs;
      if (elapsed < GLOBAL_COOLDOWN_MS) {
        const remain = Math.ceil((GLOBAL_COOLDOWN_MS - elapsed) / 1000);
        const display = remain >= 3600 ? `~${Math.ceil(remain / 3600)}h` : `~${Math.ceil(remain / 60)}min`;
        return NextResponse.json({ success: false, error: `Global cooldown active. Try again in ${display}.` }, { status: 429 });
      }
    }

    // ── Multi-chain gas scan via Moralis (Sybil defense) ──
    step = 'gas-scan';
    let scanTimer;
    const { chains: perChain, totalGas: totalGasEth } = await Promise.race([
      scanAllChainGas(userAddress, moralisKey, '[sign-allocation]'),
      new Promise((_, reject) => {
        scanTimer = setTimeout(() => reject(new Error('SCAN_TIMEOUT')), ROUTE_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(scanTimer));
    console.debug(`[sign-allocation] ${userAddress.slice(0, 8)}… totalGas=${totalGasEth.toFixed(4)}`);

    if (totalGasEth < MIN_GAS_ETH) {
      return NextResponse.json({
        success: false,
        error: `Total L2/L1 gas spent must be >= ${MIN_GAS_ETH} ETH. Your total: ${totalGasEth.toFixed(6)} ETH.`,
        breakdown: perChain.map(c => ({ chain: c.chain, gasEth: Number(c.gas.toFixed(6)) })),
      }, { status: 403 });
    }

    const cappedGas = Math.min(totalGasEth, MAX_GAS_ETH);
    const allocation = Math.min(cappedGas * ALLOCATION_RATIO, MAX_ALLOCATION_ETH);
    const maxAllocation = ethers.utils.parseEther(allocation.toFixed(18));

    // ── Nonce ──
    step = 'nonce';
    const fundContract = new ethers.Contract(
      fundAddress, ['function nonces(address) view returns (uint256)'], provider,
    );

    let nonce;
    try {
      nonce = await fundContract.nonces(userAddress);
    } catch (e) {
      console.warn(`[sign-allocation] nonces() failed for fund=${fundAddress}:`, e?.message);
      return NextResponse.json(
        { success: false, error: 'Invalid fund address — contract does not support nonces().' },
        { status: 400 }
      );
    }

    // ── Sign ──
    // Hash fields MUST match MeritXFund.contribute() exactly:
    // keccak256(abi.encodePacked(msg.sender, _maxAlloc, nonces[msg.sender], _deadline, address(this), block.chainid))
    step = 'sign';
    const deadline = Math.floor(Date.now() / 1000) + SIG_TTL_SECS;
    const wallet = new ethers.Wallet(privateKey);
    console.debug(`[sign-allocation] sig issued, deadline=${deadline}`);
    const hash = ethers.utils.solidityKeccak256(
      ['address', 'uint256', 'uint256', 'uint256', 'address', 'uint256'],
      [userAddress, maxAllocation, nonce, deadline, fundAddress, chainId],
    );
    const signature = await wallet.signMessage(ethers.utils.arrayify(hash));

    return NextResponse.json({
      success: true,
      data: {
        signature,
        maxAllocation: maxAllocation.toString(),
        deadline,
        nonce: nonce.toString(),
        signer: wallet.address,
        gasProfile: {
          totalGasEth: Number(totalGasEth.toFixed(6)),
          cappedGasEth: Number(cappedGas.toFixed(6)),
          allocationEth: Number(allocation.toFixed(6)),
          breakdown: perChain.map(c => ({ chain: c.chain, gasEth: Number(c.gas.toFixed(6)) })),
        },
      },
    });
  } catch (err) {
    if (err?.message === 'SCAN_TIMEOUT') {
      console.error(`[sign-allocation] gas scan exceeded route timeout for ${userAddress}`);
      return NextResponse.json({ success: false, error: 'Gas scan timed out — high transaction volume. Please retry.' }, { status: 504 });
    }
    console.error(`[sign-allocation] Error at step="${step}":`, err?.message);
    return NextResponse.json({ success: false, error: `Failed at step: ${step}` }, { status: 500 });
  }
}
