'use client'

/**
 * The one place a public-site wallet connection starts.
 *
 * Every Connect button — the navbar's and every action card's — calls `open()`
 * from here instead of picking a connector itself. Inside the Binance app there
 * is exactly one wallet worth offering, so `open()` connects it straight away
 * rather than showing a list of one.
 *
 * A connection that lands on another chain is asked to switch as a separate
 * request, not through `connect({ chainId })`: wagmi fails the whole connect
 * when that switch is dismissed, and a wallet that is connected on the wrong
 * chain is recoverable — the gate turns every action into "Switch to …".
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { QrCode, Wallet, X } from 'lucide-react'
import { useConnect, useConnectors, useSwitchChain, type Connector } from 'wagmi'

import { fill, useT } from '@/i18n'
import { ACTIVE_CHAIN_LABEL, TARGET_CHAIN_ID } from '@/lib/contracts'
import {
  BINANCE_CONNECTOR_ID,
  BROWSER_CONNECTOR_ID,
  WALLETCONNECT_CONNECTOR_ID,
  binanceDeepLink,
  binanceProvider,
  isBinanceRdns,
  isInBinanceApp,
  isMobileBrowser,
} from '@/lib/wallets'
import { toshToast } from '@/components/ui/toast'

type WalletPicker = { open: () => void; isConnecting: boolean }

const PickerContext = createContext<WalletPicker | null>(null)

/** `null` outside `WalletPickerProvider` — callers fall back to a bare connect. */
export function useWalletPicker(): WalletPicker | null {
  return useContext(PickerContext)
}

/**
 * Switches the picker off for a subtree, so every Connect inside it falls back
 * to the generic injected connector. `/admin` wraps itself in this: an operator
 * signs from a browser extension and nothing else.
 */
export function WithoutWalletPicker({ children }: { children: React.ReactNode }) {
  return <PickerContext.Provider value={null}>{children}</PickerContext.Provider>
}

type Row = {
  key:  string
  name: string
  hint: string
  icon: React.ReactNode
  act:  () => void
}

export function WalletPickerProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setOpen] = useState(false)
  const connectors = useConnectors()
  const { connectAsync, isPending } = useConnect()
  const { switchChainAsync } = useSwitchChain()
  const t = useT().wallet

  const connectWith = useCallback(async (connector: Connector) => {
    setOpen(false)
    try {
      const { chainId } = await connectAsync({ connector })
      if (chainId !== TARGET_CHAIN_ID) {
        await switchChainAsync({ chainId: TARGET_CHAIN_ID }).catch(toshToast.fromError)
      }
    } catch (error) {
      toshToast.fromError(error)
    }
  }, [connectAsync, switchChainAsync])

  const open = useCallback(() => {
    const binance = connectors.find((c) => c.id === BINANCE_CONNECTOR_ID)
    if (binance && isInBinanceApp()) {
      void connectWith(binance)
      return
    }
    setOpen(true)
  }, [connectors, connectWith])

  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, close])

  const rows = useMemo<Row[]>(() => {
    if (!isOpen) return []
    const walletConnect = connectors.find((c) => c.id === WALLETCONNECT_CONNECTOR_ID)
    const announced = connectors.filter(
      (c) => c.type === 'injected' && c.id !== BROWSER_CONNECTOR_ID && c.id !== BINANCE_CONNECTOR_ID,
    )
    const binanceAnnounced = announced.find((c) => isBinanceRdns(c.id))
    const binanceInjected = binanceProvider(window)
      ? connectors.find((c) => c.id === BINANCE_CONNECTOR_ID)
      : undefined
    const binanceReady = binanceAnnounced ?? binanceInjected

    const binanceRow: Row = { key: 'binance', name: 'Binance Wallet', icon: <BinanceMark />, hint: '', act: () => {} }
    if (binanceReady) {
      binanceRow.hint = t.binanceDetected
      binanceRow.act = () => { void connectWith(binanceReady) }
    } else if (isMobileBrowser()) {
      binanceRow.hint = t.binanceOpenApp
      binanceRow.act = () => { window.location.assign(binanceDeepLink(window.location.href, TARGET_CHAIN_ID)) }
    } else if (walletConnect) {
      binanceRow.hint = t.binanceScan
      binanceRow.act = () => { void connectWith(walletConnect) }
    } else {
      binanceRow.hint = t.binanceInstall
      binanceRow.act = () => {
        setOpen(false)
        window.open(binanceDeepLink(window.location.href, TARGET_CHAIN_ID), '_blank', 'noopener,noreferrer')
      }
    }

    const others = announced.filter((c) => !isBinanceRdns(c.id))
    const list: Row[] = [binanceRow]
    for (const c of others) {
      list.push({
        key:  c.uid,
        name: c.name,
        hint: t.detected,
        icon: c.icon ? <WalletIcon src={c.icon} /> : <GenericIcon><Wallet className="h-4 w-4" /></GenericIcon>,
        act:  () => { void connectWith(c) },
      })
    }

    const browser = connectors.find((c) => c.id === BROWSER_CONNECTOR_ID)
    const ambient = (window as Window & { ethereum?: { isBinance?: boolean } }).ethereum
    if (browser && others.length === 0 && ambient && !ambient.isBinance) {
      list.push({
        key:  'browser',
        name: t.browserWallet,
        hint: t.browserWalletHint,
        icon: <GenericIcon><Wallet className="h-4 w-4" /></GenericIcon>,
        act:  () => { void connectWith(browser) },
      })
    }

    if (walletConnect) {
      list.push({
        key:  'walletconnect',
        name: 'WalletConnect',
        hint: t.walletConnectHint,
        icon: <GenericIcon><QrCode className="h-4 w-4" /></GenericIcon>,
        act:  () => { void connectWith(walletConnect) },
      })
    }
    return list
  }, [isOpen, connectors, connectWith, t])

  const value = useMemo(() => ({ open, isConnecting: isPending }), [open, isPending])

  return (
    <PickerContext.Provider value={value}>
      {children}
      {isOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-bg-base/80 px-6"
          role="dialog"
          aria-modal="true"
          aria-label={t.title}
          onClick={close}
        >
          <div
            className="flex w-full max-w-sm flex-col gap-4 rounded-panel border border-border-subtle
                       bg-surface-elevated p-card-lg shadow-overlay"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-4">
              <h4 className="text-title text-text-primary">{t.title}</h4>
              <button
                type="button"
                aria-label={t.close}
                onClick={close}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-input
                           border border-border-subtle text-text-tertiary
                           transition-colors hover:border-brand/40 hover:text-brand"
              >
                <X aria-hidden className="h-3.5 w-3.5" />
              </button>
            </div>

            <ul className="flex flex-col gap-2">
              {rows.map((row) => (
                <li key={row.key}>
                  <button
                    type="button"
                    onClick={row.act}
                    className="flex w-full items-center gap-3 rounded-input border border-border-subtle
                               bg-surface-card/60 px-3 py-2.5 text-left transition-colors
                               hover:border-brand/40"
                  >
                    {row.icon}
                    <span className="flex min-w-0 flex-col">
                      <span className="text-body font-medium text-text-primary">{row.name}</span>
                      <span className="truncate text-note text-text-tertiary">{row.hint}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            <p className="text-label leading-relaxed tracking-wider text-text-quiet">
              {fill(t.footer, { chain: ACTIVE_CHAIN_LABEL })}
            </p>
          </div>
        </div>
      )}
    </PickerContext.Provider>
  )
}

function GenericIcon({ children }: { children: React.ReactNode }) {
  return (
    <span
      aria-hidden
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-input
                 border border-border-subtle text-text-secondary"
    >
      {children}
    </span>
  )
}

function WalletIcon({ src }: { src: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" width={32} height={32} className="h-8 w-8 shrink-0 rounded-input" />
}

// Binance's brand colours, not ours — they stay literal so a palette change
// here cannot recolour another company's mark.
const BINANCE_DARK = 'rgb(30 32 38)'
const BINANCE_YELLOW = 'rgb(243 186 47)'

function BinanceMark() {
  return (
    <span
      aria-hidden
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-input"
      style={{ background: BINANCE_DARK }}
    >
      <svg viewBox="0 0 126.61 126.61" className="h-5 w-5" fill={BINANCE_YELLOW}>
        <path d="m38.73 53.2 24.59-24.58 24.6 24.6 14.3-14.31L63.32 0 24.42 38.9zM0 63.31l14.3-14.31 14.31 14.31-14.31 14.3zM38.73 73.41l24.59 24.59 24.6-24.6 14.31 14.29-38.9 38.91-38.91-38.88zM98 63.31l14.3-14.31 14.31 14.3-14.31 14.32z" />
        <path d="m77.83 63.3-14.51-14.52-10.73 10.73-1.24 1.23-2.54 2.54 14.51 14.5 14.51-14.47z" />
      </svg>
    </span>
  )
}
