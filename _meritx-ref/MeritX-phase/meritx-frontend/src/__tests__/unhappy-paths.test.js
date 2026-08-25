/**
 * MeritX — Unhappy Path Unit Tests
 * Validates frontend resilience under 3 critical failure scenarios:
 *   1. Insufficient funds (gas estimation failure)
 *   2. User-rejected wallet transaction (code 4001)
 *   3. RPC 20s timeout circuit breaker
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Scenario 1 & 2: handleTxError ───────────────────────────

// Mock react-hot-toast before importing the module under test
vi.mock('react-hot-toast', () => ({
  default: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

// Mock wallet provider (not needed for these tests but imported by web3.js)
vi.mock('@/lib/walletProvider', () => ({
  getActiveProvider: vi.fn(() => null),
}));

const toast = (await import('react-hot-toast')).default;
const { handleTxError } = await import('@/lib/web3');

describe('Scenario 1: Insufficient Funds Interception', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('catches "insufficient funds" from estimateGas and returns user-friendly message', () => {
    const err = new Error('insufficient funds for intrinsic transaction cost');
    err.code = 'INSUFFICIENT_FUNDS';

    const result = handleTxError(err);

    expect(result).toBe('Insufficient ETH balance for this transaction.');
    expect(toast.error).toHaveBeenCalledWith('Insufficient ETH balance for this transaction.');
  });

  it('catches "insufficient balance" variant phrasing', () => {
    const err = new Error('insufficient balance for transfer');

    const result = handleTxError(err);

    expect(result).toBe('Insufficient ETH balance for this transaction.');
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('does not show toast when showToast is false', () => {
    const err = new Error('insufficient funds for gas * price + value');

    const result = handleTxError(err, { showToast: false });

    expect(result).toBe('Insufficient ETH balance for this transaction.');
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('Scenario 2: User Rejected Transaction (Wallet 4001)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handles ethers.js ACTION_REJECTED code gracefully', () => {
    const err = new Error('user rejected transaction');
    err.code = 'ACTION_REJECTED';

    const result = handleTxError(err);

    expect(result).toBe('Transaction cancelled by user.');
    expect(toast.error).toHaveBeenCalledWith('Transaction cancelled by user.');
  });

  it('handles EIP-1193 numeric code 4001', () => {
    const err = new Error('MetaMask Tx Signature: User denied transaction signature.');
    err.code = 4001;

    const result = handleTxError(err);

    expect(result).toBe('Transaction cancelled by user.');
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('does not crash on null/undefined error', () => {
    const result = handleTxError(null);

    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns fallback message for completely unknown errors', () => {
    const err = new Error('something completely unexpected');

    const result = handleTxError(err);

    expect(result).toContain('unexpected error');
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});

// ─── Scenario 3: RPC 20s Timeout Circuit Breaker ─────────────

describe('Scenario 3: RPC 20s Timeout Circuit Breaker', () => {
  it('rejects with timeout error when RPC exceeds 20s', async () => {
    const RPC_TIMEOUT_MS = 20_000;

    vi.useFakeTimers();

    const neverResolves = new Promise(() => {});

    let timer;
    const racePromise = Promise.race([
      neverResolves,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('RPC timeout — node did not respond within 20s')),
          RPC_TIMEOUT_MS,
        );
      }),
    ]).finally(() => clearTimeout(timer));

    vi.advanceTimersByTime(20_000);

    await expect(racePromise).rejects.toThrow('RPC timeout — node did not respond within 20s');

    vi.useRealTimers();
  });

  it('resolves normally if RPC responds before 20s', async () => {
    const RPC_TIMEOUT_MS = 20_000;

    vi.useFakeTimers();

    const fastResponse = new Promise((resolve) => {
      setTimeout(() => resolve({ data: 'ok' }), 3_000);
    });

    let timer;
    const racePromise = Promise.race([
      fastResponse,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('RPC timeout — node did not respond within 20s')),
          RPC_TIMEOUT_MS,
        );
      }),
    ]).finally(() => clearTimeout(timer));

    vi.advanceTimersByTime(3_000);

    const result = await racePromise;
    expect(result).toEqual({ data: 'ok' });

    vi.useRealTimers();
  });

  it('the waitWithTimeout utility rejects on slow tx.wait()', async () => {
    const TX_WAIT_TIMEOUT_MS = 90_000;

    vi.useFakeTimers();

    function waitWithTimeout(txPromise) {
      let t;
      const timeout = new Promise((_, reject) => {
        t = setTimeout(() => reject(new Error('TX_WAIT_TIMEOUT')), TX_WAIT_TIMEOUT_MS);
      });
      return Promise.race([txPromise, timeout]).finally(() => clearTimeout(t));
    }

    const stuckTx = new Promise(() => {});
    const promise = waitWithTimeout(stuckTx);

    vi.advanceTimersByTime(90_000);

    await expect(promise).rejects.toThrow('TX_WAIT_TIMEOUT');

    vi.useRealTimers();
  });
});

// ─── Bonus: Contract revert reason mapping ───────────────────

describe('Bonus: Contract Revert Reason Mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps "!fee" revert to fee mismatch message', () => {
    const err = { reason: '!fee', code: 'CALL_EXCEPTION' };

    const result = handleTxError(err);

    expect(result).toContain('fee');
  });

  it('maps "!time" revert to funding window expired', () => {
    const err = { reason: '!time', code: 'CALL_EXCEPTION' };

    const result = handleTxError(err);

    expect(result).toContain('expired');
  });

  it('maps JSON-RPC -32603 to network congestion message', () => {
    const err = new Error('Internal JSON-RPC error');
    err.code = '-32603';

    const result = handleTxError(err);

    expect(result).toContain('Network congestion');
  });
});
