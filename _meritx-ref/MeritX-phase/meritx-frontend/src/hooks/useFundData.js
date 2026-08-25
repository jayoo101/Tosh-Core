'use client';

import { useCallback } from 'react';
import useSWR from 'swr';
import { ethers } from 'ethers';
import { FUND_ABI, TOKEN_ABI } from '@/lib/abis';
import { fetchIPFSMetadata } from '@/lib/ipfs';
import { getRpcProvider } from '@/lib/web3';

const RPC_TIMEOUT_MS = 30_000;

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MC_ABI = [
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[])',
];

const fundIface = new ethers.utils.Interface(FUND_ABI);
const tokenIface = new ethers.utils.Interface(TOKEN_ABI);

const FUND_READS = [
  'projectToken',       // 0
  'totalRaised',        // 1
  'SOFT_CAP',           // 2
  'raiseEndTime',       // 3
  'currentState',       // 4
  'projectOwner',       // 5
  'LAUNCH_WINDOW',      // 6
  'launchAnnouncementTime', // 7
  'PRE_LAUNCH_NOTICE',  // 8
  'LAUNCH_EXPIRATION',  // 9
  'ipfsURI',            // 10
  'RAISE_DURATION',     // 11
  'uniswapPool',        // 12
  'poolGriefed',        // 13
  'launchDeadline',     // 14
];

function decodeSafe(iface, fn, result) {
  if (!result?.success) return null;
  try { return iface.decodeFunctionResult(fn, result.returnData)[0]; } catch { return null; }
}

async function fetchFundData(address) {
  if (!address || !ethers.utils.isAddress(address)) {
    throw new Error('Invalid fund address');
  }

  const provider = getRpcProvider();
  const mc = new ethers.Contract(MULTICALL3, MC_ABI, provider);

  // ── Round 1: ALL 15 fund reads → 1 single RPC call via Multicall3 ──
  const fundCalls = FUND_READS.map(fn => ({
    target: address,
    allowFailure: true,
    callData: fundIface.encodeFunctionData(fn),
  }));
  const r1 = await mc.aggregate3(fundCalls);

  const tokenAddr    = decodeSafe(fundIface, 'projectToken', r1[0]);
  const totalRaised  = decodeSafe(fundIface, 'totalRaised', r1[1]) ?? ethers.constants.Zero;
  const softCap      = decodeSafe(fundIface, 'SOFT_CAP', r1[2]) ?? ethers.constants.Zero;
  const raiseEndTime = decodeSafe(fundIface, 'raiseEndTime', r1[3]) ?? ethers.constants.Zero;
  const state        = decodeSafe(fundIface, 'currentState', r1[4]) ?? 0;
  const projectOwner = decodeSafe(fundIface, 'projectOwner', r1[5]) ?? ethers.constants.AddressZero;
  const launchWindow = decodeSafe(fundIface, 'LAUNCH_WINDOW', r1[6]) ?? ethers.BigNumber.from(30 * 86400);
  const announceTime = decodeSafe(fundIface, 'launchAnnouncementTime', r1[7]) ?? ethers.BigNumber.from(0);
  const noticeDur    = decodeSafe(fundIface, 'PRE_LAUNCH_NOTICE', r1[8]) ?? ethers.BigNumber.from(21600);
  const expirationDur = decodeSafe(fundIface, 'LAUNCH_EXPIRATION', r1[9]) ?? ethers.BigNumber.from(86400);
  const ipfsURI      = decodeSafe(fundIface, 'ipfsURI', r1[10]) ?? '';
  const raiseDuration = decodeSafe(fundIface, 'RAISE_DURATION', r1[11]) ?? ethers.BigNumber.from(0);
  const poolAddr     = decodeSafe(fundIface, 'uniswapPool', r1[12]) ?? ethers.constants.AddressZero;
  const griefed      = decodeSafe(fundIface, 'poolGriefed', r1[13]) ?? false;
  const onChainDeadline = decodeSafe(fundIface, 'launchDeadline', r1[14]) ?? ethers.BigNumber.from(0);

  if (!tokenAddr || tokenAddr === ethers.constants.AddressZero) {
    throw new Error('Failed to read projectToken — contract may not exist at this address');
  }

  // ── Round 2: token name + symbol (1 RPC) in parallel with IPFS fetch ──
  const tokenCalls = [
    { target: tokenAddr, allowFailure: true, callData: tokenIface.encodeFunctionData('name') },
    { target: tokenAddr, allowFailure: true, callData: tokenIface.encodeFunctionData('symbol') },
  ];

  const ipfsPromise = ipfsURI
    ? fetchIPFSMetadata(ipfsURI).catch(() => null)
    : Promise.resolve(null);

  const [r2, meta] = await Promise.all([
    mc.aggregate3(tokenCalls),
    ipfsPromise,
  ]);

  const name   = decodeSafe(tokenIface, 'name', r2[0]) ?? 'Unknown';
  const symbol = decodeSafe(tokenIface, 'symbol', r2[1]) ?? '???';

  let avatarUrl = null;
  let description = '';
  let socials = {};
  let skillEndpoint = '';
  if (meta) {
    avatarUrl = meta.image || null;
    description = meta.description || '';
    socials = meta.socials || {};
    skillEndpoint = meta.skillEndpoint || '';
  }

  const endSec = Number(raiseEndTime);
  const durSec = Number(raiseDuration);
  const createdAtMs = durSec > 0 ? (endSec - durSec) * 1000 : 0;
  const announceSec = Number(announceTime);
  const noticeSec = Number(noticeDur);
  const expirationSec = Number(expirationDur);
  const noticeEndMs = announceSec > 0 ? (announceSec + noticeSec) * 1000 : 0;

  const deadlineSec = Number(onChainDeadline);
  const launchDeadlineMs = deadlineSec > 0
    ? deadlineSec * 1000
    : (endSec + Number(launchWindow)) * 1000;
  const launchExpirationMs = announceSec > 0 ? (announceSec + noticeSec + expirationSec) * 1000 : 0;

  return {
    address,
    name,
    symbol,
    tokenAddress: tokenAddr,
    state: Number(state),
    raised: ethers.utils.formatEther(totalRaised),
    softCap: ethers.utils.formatEther(softCap),
    totalRaised,
    rawSoftCap: softCap,
    endTime: endSec * 1000,
    createdAt: createdAtMs,
    raiseEndTime: endSec,
    launchDeadline: launchDeadlineMs,
    projectOwner,
    announcementTime: announceSec,
    noticeEndMs,
    launchExpirationMs,
    ipfsURI,
    avatarUrl,
    description,
    socials,
    skillEndpoint,
    poolAddress: poolAddr,
    poolGriefed: !!griefed,
  };
}

async function fetchFundDataWithTimeout(address) {
  let timer;
  try {
    return await Promise.race([
      fetchFundData(address),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('RPC timeout — node did not respond within 30s')), RPC_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Hook: Fetch MeritX Fund contract data with SWR (caching, revalidation).
 * Uses Multicall3 to batch all on-chain reads into 2 RPC calls total.
 */
export function useFundData(address) {
  const key = address && ethers.utils.isAddress(address) ? ['meritx-fund', address] : null;

  const { data, error, isLoading, mutate } = useSWR(
    key,
    () => fetchFundDataWithTimeout(address),
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: true,
      refreshInterval: 60_000,
      dedupingInterval: 30_000,
      errorRetryCount: 2,
      onErrorRetry: (err, _key, _config, revalidate, { retryCount }) => {
        if (retryCount >= 2) return;
        const is429 = /429|rate.limit|too many/i.test(err?.message ?? '');
        const delay = is429
          ? Math.min(15_000 * 2 ** retryCount, 60_000)
          : Math.min(5_000 * 2 ** retryCount, 30_000);
        setTimeout(() => revalidate({ retryCount }), delay);
      },
    }
  );

  const refresh = useCallback(() => mutate(), [mutate]);

  return {
    project: data,
    loadError: error,
    isLoading: isLoading && !data,
    refresh,
    mutate,
  };
}
