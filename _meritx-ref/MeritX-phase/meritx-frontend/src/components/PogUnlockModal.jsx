'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useGasAllocation, GAS_CHAINS } from '@/hooks/useGasAllocation';

const CHAINS = [
  { id: '0x1',    tag: 'ETH',  name: 'Ethereum', x: 18, y: 22 },
  { id: '0x2105', tag: 'BASE', name: 'Base',     x: 78, y: 18 },
  { id: '0xa4b1', tag: 'ARB',  name: 'Arbitrum', x: 14, y: 72 },
  { id: '0xa',    tag: 'OP',   name: 'Optimism', x: 82, y: 76 },
];

const STEP = { IDLE: 'idle', FETCH: 'fetching', HARVEST: 'harvesting', SHATTER: 'shatter', REVEAL: 'reveal' };
const HX = '0123456789ABCDEF';
const rh = (n) => Array.from({ length: n }, () => HX[Math.random() * 16 | 0]).join('');

function useCleanup() {
  const timers = useRef([]); const rafs = useRef([]);
  const addTimer = useCallback((fn, ms) => { const id = setTimeout(fn, ms); timers.current.push(id); return id; }, []);
  const addRaf = useCallback((fn) => { const id = requestAnimationFrame(fn); rafs.current.push(id); return id; }, []);
  const nukeAll = useCallback(() => {
    timers.current.forEach(clearTimeout); rafs.current.forEach(cancelAnimationFrame);
    timers.current = []; rafs.current = [];
  }, []);
  useEffect(() => nukeAll, [nukeAll]);
  return { addTimer, addRaf, nukeAll };
}

function Starfield({ visible }) {
  const canvasRef = useRef(null); const starsRef = useRef([]); const rafRef = useRef(0); const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    const c = canvasRef.current; if (!c) return;
    const ctx = c.getContext('2d');
    const resize = () => { c.width = window.innerWidth; c.height = window.innerHeight; };
    resize(); window.addEventListener('resize', resize);
    if (starsRef.current.length === 0) {
      starsRef.current = Array.from({ length: 80 }, () => ({
        x: Math.random() * c.width, y: Math.random() * c.height,
        r: Math.random() * 1 + 0.2, sp: Math.random() * 0.25 + 0.04, a: Math.random(),
      }));
    }
    function draw() {
      if (!mountedRef.current) return;
      ctx.clearRect(0, 0, c.width, c.height);
      for (const s of starsRef.current) {
        s.a += s.sp * 0.015; if (s.a > 1) s.a = 0;
        const alpha = s.a < 0.5 ? s.a * 2 : (1 - s.a) * 2;
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(139,92,246,${alpha * 0.18})`;
        ctx.fill();
      }
      rafRef.current = requestAnimationFrame(draw);
    }
    draw();
    return () => { mountedRef.current = false; cancelAnimationFrame(rafRef.current); window.removeEventListener('resize', resize); };
  }, []);
  return <canvas ref={canvasRef} className="absolute inset-0 z-0 pointer-events-none" style={{ opacity: visible ? 1 : 0 }} />;
}

function ScrambleText({ value, active, lockMs }) {
  const [txt, setTxt] = useState('');
  const ivRef = useRef(null); const tmRef = useRef(null); const lockedRef = useRef(false);
  useEffect(() => {
    clearInterval(ivRef.current); clearTimeout(tmRef.current); lockedRef.current = false;
    if (!active) { setTxt(''); return; }
    ivRef.current = setInterval(() => { if (!lockedRef.current) setTxt(`0x${rh(8)}`); }, 35);
    tmRef.current = setTimeout(() => { lockedRef.current = true; clearInterval(ivRef.current); setTxt(value); }, lockMs);
    return () => { clearInterval(ivRef.current); clearTimeout(tmRef.current); };
  }, [active, value, lockMs]);
  return <span>{active ? txt : ''}</span>;
}

function TermLine({ children, delay }) {
  const [show, setShow] = useState(delay === 0);
  const tmRef = useRef(null);
  useEffect(() => {
    clearTimeout(tmRef.current);
    if (delay > 0 && !show) tmRef.current = setTimeout(() => setShow(true), delay);
    return () => clearTimeout(tmRef.current);
  }, [delay, show]);
  if (!show) return null;
  return (
    <div className="pog-term-line flex gap-2 text-[11px] font-mono leading-relaxed">
      <span className="text-violet-800 select-none shrink-0">&gt;</span>
      <span className="text-violet-400/70">{children}</span>
    </div>
  );
}

export default function PogUnlockModal({ isOpen, onClose, account }) {
  const gasAlloc = useGasAllocation(account);
  const gasRef = useRef(gasAlloc);
  gasRef.current = gasAlloc;

  const [step, setStep] = useState(STEP.IDLE);
  const [err, setErr] = useState('');
  const [chainLocked, setChainLocked] = useState([false, false, false, false]);
  const [totalAnim, setTotalAnim] = useState(0);
  const [showFinal, setShowFinal] = useState(false);

  const abortRef = useRef(null);
  const { addTimer, addRaf, nukeAll } = useCleanup();

  const resetAll = useCallback(() => {
    nukeAll(); abortRef.current?.abort();
    setStep(STEP.IDLE); setErr('');
    setChainLocked([false, false, false, false]); setTotalAnim(0); setShowFinal(false);
  }, [nukeAll]);

  useEffect(() => { if (!isOpen) resetAll(); }, [isOpen, resetAll]);
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const startHarvest = useCallback((sig) => {
    if (sig.aborted) return;
    const tot = gasRef.current.totalGas || 0;
    setTotalAnim(0); setChainLocked([false, false, false, false]); setStep(STEP.HARVEST);
    CHAINS.forEach((_, i) => {
      addTimer(() => { if (!sig.aborted) setChainLocked(p => { const n = [...p]; n[i] = true; return n; }); }, 500 + i * 600);
    });
    const rampDur = 500 + CHAINS.length * 600;
    const t0 = performance.now();
    function tick(now) {
      if (sig.aborted) return;
      const p = Math.min((now - t0) / rampDur, 1);
      const eased = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      setTotalAnim(tot * eased);
      if (p < 1) addRaf(tick); else setTotalAnim(tot);
    }
    addRaf(tick);
    addTimer(() => { if (!sig.aborted) { setTotalAnim(tot); startShatter(sig); } }, rampDur + 300);
  }, [addTimer, addRaf]); // eslint-disable-line react-hooks/exhaustive-deps

  const startShatter = useCallback((sig) => {
    if (sig.aborted) return;
    setStep(STEP.SHATTER);
    addTimer(() => {
      if (sig.aborted) return;
      setStep(STEP.REVEAL);
      addTimer(() => { if (!sig.aborted) setShowFinal(true); }, 400);
    }, 1800);
  }, [addTimer]);

  const initScan = useCallback(async () => {
    if (!account) return;
    setErr(''); setStep(STEP.FETCH);
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      if (!gasRef.current.isLoaded) {
        await Promise.race([
          gasRef.current.refresh(false),
          new Promise((_, rej) => {
            const tid = setTimeout(() => rej(new Error('TIMEOUT')), 30000);
            ctrl.signal.addEventListener('abort', () => { clearTimeout(tid); rej(new Error('ABORTED')); });
          }),
        ]);
        if (ctrl.signal.aborted) return;
      }
      addTimer(() => { if (!ctrl.signal.aborted) startHarvest(ctrl.signal); }, 2200);
    } catch (e) {
      if (ctrl.signal.aborted || e.message === 'ABORTED') return;
      setErr(
        e.message === 'TIMEOUT' ? 'TIMEOUT — NODE_UNREACHABLE'
          : e.message === 'RATE_LIMITED' ? 'RATE_LIMITED — wait and retry'
          : e.message === 'SCAN_TIMEOUT' ? 'SCAN_TIMEOUT — high tx volume, retry'
          : e.message || 'SCAN_FAILED'
      );
      setStep(STEP.IDLE);
    }
  }, [account, addTimer, startHarvest]);

  if (!isOpen) return null;

  const realVals = gasAlloc.chainGas;
  const totalGas = gasAlloc.totalGas;
  const maxAlloc = gasAlloc.maxAllocation;
  const eligible = gasAlloc.eligible;

  return (
    <div
      className={`fixed inset-0 z-[99999] overflow-hidden ${step === STEP.SHATTER ? 'pog-heavy-shake' : ''}`}
      style={{ background: 'radial-gradient(ellipse at 50% 40%, #18122B 0%, #0a0a0f 55%, #000000 100%)' }}
    >
      <Starfield visible={true} />
      <div className="absolute inset-0 z-[1] pointer-events-none opacity-[0.015]" style={{
        backgroundImage: 'repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(139,92,246,0.04) 2px,rgba(139,92,246,0.04) 4px)',
      }} />
      <div className="absolute inset-0 z-10 flex flex-col items-center justify-center">
        {renderStep(step, {
          err, initScan, account,
          chainLocked, realVals, totalAnim, totalGas,
          maxAlloc, eligible, showFinal,
          minGasRequired: gasAlloc.minGasRequired,
          onClose: () => {
            try { if (account) localStorage.setItem(`meritx_pog_cleared_${account.toLowerCase()}`, 'true'); } catch (_) {}
            onClose();
          },
        })}
      </div>
    </div>
  );
}

function renderStep(step, ctx) {
  switch (step) {

    case STEP.IDLE:
      return (
        <div key="idle" className="flex flex-col items-center gap-8 px-6 pog-fade-in">
          <div className="relative w-36 h-36 flex items-center justify-center">
            <div className="absolute inset-0 rounded-full border border-white/[0.03]" />
            <div className="absolute inset-4 rounded-full border border-violet-500/[0.06]" />
            <div className="absolute inset-0 rounded-full border border-violet-400/[0.08] animate-spin" style={{ animationDuration: '15s' }} />
            <span className="text-violet-400/40 font-mono text-2xl font-bold tracking-wider">PoG</span>
          </div>

          <div className="text-center space-y-3 max-w-xs">
            <div className="font-mono text-[10px] text-violet-500/60 tracking-[0.25em] uppercase">
              Proof-of-Gas Verification
            </div>
            <p className="text-[10px] font-mono text-zinc-600 leading-relaxed">
              On-chain gas expenditure analysis across 4 networks.
              <br />
              Historical consumption determines access level.
            </p>
          </div>

          {ctx.err && (
            <div className="font-mono text-[10px] text-zinc-400 bg-white/[0.02] border border-white/[0.05] rounded px-4 py-2.5">
              <span className="text-red-400/70">ERR:</span> {ctx.err}
            </div>
          )}

          <div className="flex flex-col items-center gap-1.5">
            <button
              onClick={ctx.initScan}
              disabled={!ctx.account}
              className="group px-8 py-4 rounded-lg font-mono font-bold text-xs uppercase tracking-[0.15em]
                bg-white/[0.02] border border-white/[0.06] text-violet-400
                hover:bg-violet-500/[0.06] hover:border-violet-500/20 hover:shadow-[0_0_40px_rgba(139,92,246,0.06)]
                disabled:opacity-15 disabled:cursor-not-allowed transition-all duration-300 active:scale-[0.98]"
            >
              [ INIT ]_CROSS_CHAIN_TRACE
            </button>
            <span className="text-[9px] font-mono text-zinc-700 tracking-widest">[ INIT_ONCHAIN_TRACE ]</span>
          </div>
        </div>
      );

    case STEP.FETCH:
      return (
        <div key="fetch" className="w-full max-w-md px-8 pog-fade-in">
          <div className="space-y-2.5">
            <TermLine delay={0}>BYPASSING_NODE_VERIFICATION...</TermLine>
            <TermLine delay={350}>CONNECTING_MULTI_CHAIN_INDEXER [0x1, 0x2105, 0xa4b1, 0xa]</TermLine>
            <TermLine delay={750}>EXTRACTING_HISTORICAL_GAS_DATA...</TermLine>
            <TermLine delay={1200}>DECODING_RECEIPT_MANIFESTS...</TermLine>
          </div>
          <div className="mt-4 text-[9px] font-mono text-zinc-700 tracking-widest">
            [ BYPASSING_NODES... EXTRACTING_TRACE_DATA... ]
          </div>
          <div className="flex items-center gap-1.5 mt-5">
            <span className="text-violet-800 text-xs font-mono">&gt;</span>
            <span className="w-2 h-4 bg-violet-500 pog-cursor-blink drop-shadow-[0_0_6px_rgba(139,92,246,0.5)]" />
          </div>
        </div>
      );

    case STEP.HARVEST:
      return (
        <div key="harvest" className="w-full h-full flex items-center justify-center pog-fade-in">
          {CHAINS.map((c, i) => {
            const locked = ctx.chainLocked[i];
            return (
              <div
                key={c.id}
                className="absolute flex flex-col items-center gap-1 transition-all duration-700"
                style={{ left: `${c.x}%`, top: `${c.y}%`, transform: 'translate(-50%,-50%)' }}
              >
                <div className={`w-16 h-16 sm:w-20 sm:h-20 rounded-full border flex items-center justify-center transition-all duration-700
                  ${locked ? 'border-white/10 bg-white/[0.015]' : 'border-white/[0.03]'}`}
                  style={{ boxShadow: locked ? '0 0 20px rgba(139,92,246,0.08)' : 'none' }}
                >
                  <div className="text-center">
                    <div className={`text-[9px] font-mono font-bold tracking-wider transition-colors duration-500
                      ${locked ? 'text-violet-400' : 'text-zinc-700'}`}>
                      {c.tag}
                    </div>
                    <div className={`font-mono font-black text-sm tabular-nums transition-colors duration-500 min-w-[75px] text-center
                      ${locked ? 'text-white/90' : 'text-violet-500/25'}`}>
                      {locked
                        ? ctx.realVals[i].toFixed(4)
                        : <ScrambleText value={ctx.realVals[i].toFixed(4)} active={!locked} lockMs={450} />
                      }
                    </div>
                  </div>
                </div>
                <span className="text-[7px] font-mono text-zinc-700 tracking-wider">{c.name}</span>
              </div>
            );
          })}

          <div className="relative z-20 flex flex-col items-center">
            <div className="w-32 h-32 sm:w-40 sm:h-40 rounded-full border border-white/[0.05] flex items-center justify-center"
              style={{ background: 'radial-gradient(circle, rgba(139,92,246,0.02) 0%, transparent 70%)' }}
            >
              <div className="text-center">
                <div className="text-[7px] font-mono text-zinc-600 uppercase tracking-[0.3em] mb-1">TOTAL_GAS_CONSUMED</div>
                <div className="text-3xl sm:text-4xl font-black font-mono text-violet-400 tabular-nums tracking-tight drop-shadow-[0_0_15px_rgba(139,92,246,0.4)]">
                  {ctx.totalAnim.toFixed(4)}
                </div>
                <div className="text-[10px] font-mono text-zinc-600 mt-0.5">ETH</div>
              </div>
            </div>
            <div className="mt-3 text-[8px] font-mono text-zinc-700 tracking-widest">
              AGGREGATING_CONSUMPTION_LOGS...
            </div>
            <div className="flex gap-1.5 mt-3">
              {CHAINS.map((_, i) => (
                <div key={i} className={`w-1.5 h-1.5 rounded-full transition-all duration-500 ${
                  ctx.chainLocked[i] ? 'bg-violet-400 shadow-[0_0_6px_rgba(139,92,246,0.6)]' : 'bg-zinc-800'
                }`} />
              ))}
            </div>
          </div>
        </div>
      );

    case STEP.SHATTER:
      return (
        <div key="shatter" className="flex flex-col items-center justify-center pog-fade-in">
          <div className="text-[9px] font-mono text-violet-500/50 tracking-[0.3em] uppercase mb-6 animate-pulse">
            CALIBRATING_ACCESS_THRESHOLD...
          </div>
          <div
            className="pog-glitch-text text-6xl sm:text-8xl font-black font-mono text-white/90 tabular-nums tracking-tighter"
            data-text={ctx.totalGas.toFixed(4)}
          >
            {ctx.totalGas.toFixed(4)}
          </div>
          <div className="text-[10px] font-mono text-zinc-700 mt-3 tracking-wider">TOTAL_GAS_CONSUMED (ETH)</div>
          <div className="mt-6 text-[9px] font-mono text-zinc-700 tracking-widest">
            [ CALIBRATING_CLEARANCE_THRESHOLD... ]
          </div>
        </div>
      );

    case STEP.REVEAL:
      return (
        <div key="reveal" className="flex flex-col items-center justify-center px-6">
          {!ctx.showFinal ? (
            <div key="decomp" className="text-violet-500/20 font-mono text-[10px] tracking-[0.4em] animate-pulse">
              RESOLVING...
            </div>
          ) : (
            <div key="final" className="pog-fade-scale-in flex flex-col items-center text-center max-w-md">
              {ctx.eligible ? <EligibleReveal ctx={ctx} /> : <IneligibleReveal ctx={ctx} />}
            </div>
          )}
        </div>
      );

    default:
      return null;
  }
}

function EligibleReveal({ ctx }) {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="text-[9px] font-mono text-zinc-600 tracking-[0.25em] uppercase mb-8">
        [ ACCESS_LEVEL_GRANTED ]
      </div>

      <div className="relative mb-6">
        <div className="absolute -inset-20 rounded-full bg-white/[0.01] blur-3xl pointer-events-none" />
        <div className="absolute -inset-10 rounded-full bg-violet-500/[0.02] blur-2xl pointer-events-none" />
        <div className="pog-artifact-text text-7xl sm:text-9xl font-black font-mono tabular-nums tracking-tighter">
          {ctx.maxAlloc.toFixed(2)}
        </div>
        <div className="text-xl font-mono text-zinc-500 font-bold mt-1 tracking-widest">ETH</div>
      </div>

      <div className="text-[9px] font-mono text-zinc-600 tracking-widest mb-8">
        // SOVEREIGN_ACCESS_REFORGED
      </div>

      <div className="w-full max-w-xs rounded border border-white/[0.04] bg-white/[0.01] p-3 mb-8 space-y-1">
        {CHAINS.map((c, i) => (
          <div key={c.id} className="flex items-center justify-between">
            <span className="text-[8px] font-mono text-zinc-700">{c.tag}://{c.name}</span>
            <span className="text-[9px] font-mono text-zinc-500 tabular-nums">{ctx.realVals[i].toFixed(4)}</span>
          </div>
        ))}
        <div className="border-t border-white/[0.04] pt-1 mt-1 flex justify-between">
          <span className="text-[8px] font-mono text-zinc-600">TOTAL</span>
          <span className="text-[9px] font-mono text-white/70 font-bold tabular-nums">{ctx.totalGas.toFixed(4)} ETH</span>
        </div>
      </div>

      <div className="flex flex-col items-center gap-1.5">
        <button
          onClick={ctx.onClose}
          className="group px-10 py-4 rounded-lg font-mono font-bold text-xs uppercase tracking-[0.15em]
            bg-white/[0.02] border border-white/[0.06] text-violet-400
            hover:bg-violet-500/[0.06] hover:border-violet-500/20 hover:shadow-[0_0_40px_rgba(139,92,246,0.06)]
            transition-all duration-300 active:scale-[0.98]"
        >
          [ EXECUTE ]_ENTER_NEXUS
        </button>
        <span className="text-[9px] font-mono text-zinc-700 tracking-widest">[ CONFIRM_AUTHORIZATION ]</span>
      </div>
    </div>
  );
}

function IneligibleReveal({ ctx }) {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="text-[9px] font-mono text-zinc-600 tracking-[0.25em] uppercase mb-8">
        [ SCAN_COMPLETE ]
      </div>
      <div className="text-6xl sm:text-7xl font-black font-mono text-zinc-400 tabular-nums tracking-tighter mb-2">
        {ctx.totalGas.toFixed(4)}
      </div>
      <div className="text-sm font-mono text-zinc-700 mb-6 tracking-wider">TOTAL_GAS_CONSUMED (ETH)</div>

      <div className="text-[9px] font-mono text-zinc-600 mb-2 tracking-widest">
        // INSUFFICIENT_GAS_FOOTPRINT
      </div>
      <div className="text-[9px] font-mono text-zinc-700 mb-8">
        MINIMUM_REQUIRED: {ctx.minGasRequired ?? 0.1} ETH
      </div>

      <div className="flex flex-col items-center gap-1.5">
        <button
          onClick={ctx.onClose}
          className="group px-10 py-4 rounded-lg font-mono font-bold text-xs uppercase tracking-[0.15em]
            bg-white/[0.02] border border-white/[0.04] text-zinc-500
            hover:bg-white/[0.04] hover:text-zinc-400 transition-all duration-300 active:scale-[0.98]"
        >
          [ EXIT ]_CONTINUE
        </button>
        <span className="text-[9px] font-mono text-zinc-700 tracking-widest">[ CONTINUE_BROWSING ]</span>
      </div>
    </div>
  );
}
