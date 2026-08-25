import { ethers } from 'ethers';

function isHexAddress(value) {
  if (typeof value !== 'string') return false;
  if (!value.startsWith('0x') || value.length !== 42) return false;
  // Basic hex check; checksum is validated by ethers
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) return false;
  try {
    ethers.utils.getAddress(value);
    return true;
  } catch {
    return false;
  }
}

function isValidHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function validateEnvOrThrow() {
  const problems = [];

  const factory = process.env.NEXT_PUBLIC_FACTORY_ADDRESS;
  const treasury = process.env.NEXT_PUBLIC_TREASURY_WALLET;
  const signer = process.env.NEXT_PUBLIC_SIGNER_ADDRESS;
  const weth = process.env.NEXT_PUBLIC_WETH_ADDRESS;
  const rawChainId = process.env.NEXT_PUBLIC_CHAIN_ID;
  const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;

  if (factory && !isHexAddress(factory)) {
    problems.push('NEXT_PUBLIC_FACTORY_ADDRESS is set but not a valid 0x address.');
  }
  if (!treasury || !isHexAddress(treasury)) {
    problems.push('NEXT_PUBLIC_TREASURY_WALLET is missing or not a valid 0x address.');
  }
  if (!signer || !isHexAddress(signer)) {
    problems.push('NEXT_PUBLIC_SIGNER_ADDRESS is missing or not a valid 0x address.');
  }
  if (!weth || !isHexAddress(weth)) {
    problems.push('NEXT_PUBLIC_WETH_ADDRESS is missing or not a valid 0x address.');
  }

  const chainId = rawChainId ? Number(rawChainId) : 8453;
  if (!Number.isInteger(chainId) || chainId <= 0) {
    problems.push('NEXT_PUBLIC_CHAIN_ID is missing or invalid.');
  }

  // Prevent "radar blind" misreads: wrong RPC for the configured chainId.
  if (!rpcUrl || !isValidHttpUrl(rpcUrl)) {
    problems.push('NEXT_PUBLIC_RPC_URL is missing or invalid (must be a http(s) URL).');
  } else {
    const lower = rpcUrl.toLowerCase();
    if (chainId === 84532 && (lower.includes('mainnet.base.org') || lower.includes('basescan.org'))) {
      problems.push('NEXT_PUBLIC_RPC_URL appears to be Base mainnet, but NEXT_PUBLIC_CHAIN_ID is Base Sepolia (84532).');
    }
    if (chainId === 8453 && (lower.includes('sepolia') || lower.includes('base-sepolia'))) {
      problems.push('NEXT_PUBLIC_RPC_URL appears to be Base Sepolia, but NEXT_PUBLIC_CHAIN_ID is Base mainnet (8453).');
    }
  }

  if (problems.length > 0) {
    // Throwing here prevents the app from rendering, which is desired for misconfigurations.
    throw new Error(
      `Critical environment misconfiguration:\n${problems
        .map((p) => ` - ${p}`)
        .join('\n')}`,
    );
  }
}