/**
 * The wallets the public site can connect, and how each is reached.
 *
 * Binance Wallet is listed first and always shown, with its mark, because the
 * Binance dApp listing checks for exactly that ("Binance logo exposure") in the
 * connect flow on web and in the app. It is reached three ways, in order:
 *
 *   1. An injected provider — the Binance app's in-app browser sets
 *      `window.ethereum.isBinance`, the desktop extension sets
 *      `window.binancew3w.ethereum`, and either may also announce itself over
 *      EIP-6963 with a `binance` rdns.
 *   2. On a phone without one: a deep link that reopens this page inside the
 *      Binance app — see `binanceDeepLink`.
 *   3. On a desktop without one: WalletConnect, scanned with the Binance app.
 *
 * Binance's `@binance/w3w-wagmi-connector-v2` is not used because it peers on
 * wagmi 2 and this app is on wagmi 3; the listing guide accepts Reown /
 * WalletConnect in its place.
 *
 * ⚠ `/admin` does not go through any of this. It opts out of the picker and
 *   connects with a bare `injected()`, so an operator only ever signs from a
 *   browser extension.
 */

import { injected, walletConnect } from 'wagmi/connectors'
import type { CreateConnectorFn } from 'wagmi'
import type { EIP1193Provider } from 'viem'

export const BINANCE_CONNECTOR_ID = 'wallet.binance.com'
export const WALLETCONNECT_CONNECTOR_ID = 'walletConnect'
export const BROWSER_CONNECTOR_ID = 'injected'

const WALLETCONNECT_PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim() || null

type BinanceWindow = Window & {
  binancew3w?: { ethereum?: EIP1193Provider }
  ethereum?: EIP1193Provider & { isBinance?: boolean }
}

export function binanceProvider(w?: Window): EIP1193Provider | undefined {
  const win = w as BinanceWindow | undefined
  if (win?.binancew3w?.ethereum) return win.binancew3w.ethereum
  if (win?.ethereum?.isBinance) return win.ethereum
  return undefined
}

export function isInBinanceApp(): boolean {
  if (typeof window === 'undefined') return false
  return (window as BinanceWindow).ethereum?.isBinance === true
}

export function isMobileBrowser(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
}

/**
 * A link that reopens `url` inside the Binance app's dApp browser, or sends a
 * visitor without the app to its download page first.
 *
 * Mirrors `getDeepLink` in `@binance/w3w-utils`, which is not imported: its
 * entry point also loads that SDK's crypto and transport layers, and this is
 * the only thing needed from it. The `appId` is Binance's in-app browser.
 */
export function binanceDeepLink(url: string, chainId: number): string {
  const startPagePath = btoa('/pages/browser/index')
  const startPageQuery = btoa(`url=${url}&defaultChainId=${chainId}`)
  const bnc = 'bnc://app.binance.com/mp/app?appId=yFK5FCqYprrXDiVFbhyRx7'
    + `&startPagePath=${startPagePath}&startPageQuery=${startPageQuery}`
  return `https://app.binance.com/en/download?_dp=${btoa(bnc)}`
}

export function isBinanceRdns(id: string): boolean {
  return /binance/i.test(id)
}

export function makeConnectors(siteUrl: string, siteIcon: string): CreateConnectorFn[] {
  const connectors: CreateConnectorFn[] = [
    injected({
      shimDisconnect: true,
      target: {
        id:       BINANCE_CONNECTOR_ID,
        name:     'Binance Wallet',
        provider: (w) => binanceProvider(w as unknown as Window | undefined),
      },
    }),
    injected({ shimDisconnect: true }),
  ]
  if (WALLETCONNECT_PROJECT_ID) {
    connectors.push(walletConnect({
      projectId:   WALLETCONNECT_PROJECT_ID,
      showQrModal: true,
      metadata: {
        name:        'ToshX',
        description: 'Fair-launch terminal for agent tokens',
        url:         siteUrl,
        icons:       [siteIcon],
      },
    }))
  }
  return connectors
}
