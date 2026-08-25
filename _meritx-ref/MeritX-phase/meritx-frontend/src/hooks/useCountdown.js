'use client';

import { useState, useEffect } from 'react';

function formatCountdown(ms) {
  if (ms <= 0) return '00:00:00';
  const h = String(Math.floor(ms / 3_600_000)).padStart(2, '0');
  const m = String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, '0');
  const s = String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

/**
 * Hook: Live countdown from target timestamp to now.
 * @param {number} targetMs - Target timestamp in milliseconds
 * @param {boolean} enabled - Whether to run the countdown
 * @returns {{ countdown: string, isEnded: boolean, isCritical: boolean }}
 */
export function useCountdown(targetMs, enabled = true) {
  const [countdown, setCountdown] = useState('--:--:--');
  const [isEnded, setIsEnded] = useState(false);
  const [isCritical, setIsCritical] = useState(false);

  useEffect(() => {
    if (!enabled || !targetMs) {
      setCountdown('--:--:--');
      setIsEnded(false);
      setIsCritical(false);
      return;
    }

    const tick = () => {
      const diff = targetMs - Date.now();
      if (diff <= 0) {
        setCountdown('00:00:00');
        setIsEnded(true);
        setIsCritical(false);
        return;
      }
      setCountdown(formatCountdown(diff));
      setIsEnded(false);
      setIsCritical(diff <= 60 * 60 * 1000);
    };

    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [targetMs, enabled]);

  return { countdown, isEnded, isCritical };
}
