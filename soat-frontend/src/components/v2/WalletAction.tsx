'use client'

import { ActionButton, type ActionGate } from '@/components/ui'

/**
 * `ActionButton`, except it renders nothing while no wallet is connected. The
 * header's button is the one connect entry on the page, and most buyers hold
 * their Agent ID in an Agentic Wallet that cannot connect, so on the project
 * page Agent mode is the primary path.
 *
 * `open` keeps the connect prompt for actions that need no Agent ID (the shelf
 * ladder), where an ordinary wallet is the expected path.
 */
export function WalletAction({ gate, open = false }: { gate: ActionGate; open?: boolean }) {
  if (gate.verdict.kind === 'connect' && !open) return null
  return <ActionButton gate={gate} />
}
