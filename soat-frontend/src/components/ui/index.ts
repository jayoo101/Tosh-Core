/**
 * Tosh design-system primitives.
 *
 * One job: a single import surface for every surface in the app.
 *
 *   import { Card, Readout, ActionButton, useActionGate, revertOrder } from '@/components/ui'
 *
 * NON-OBVIOUS CONSTRAINT — these are all client components or client hooks.
 * A React Server Component cannot import from here; put a `'use client'`
 * boundary in between.
 */

export { cn, type ClassValue } from './cn'

export {
  CLOCK_UNSYNCED,
  useNowMs,
  useNowSec,
  useIsHydrated,
  type ClockCadence,
} from './useClock'

export {
  EM_DASH,
  classifyHorizon,
  formatAmount,
  formatCountdown,
  formatCountdownMs,
  formatDuration,
  formatExact,
  formatHorizonLabel,
  formatHorizonUtc,
  percentOf,
  truncateHex,
  truncateTxHash,
  type AmountOptions,
  type Horizon,
  type HorizonLabels,
  type TruncateOptions,
} from './format'

export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from './Button'
export { Badge, type BadgeProps, type Tone } from './Badge'
export { Card, CardFooter, CardWell, type CardPadding, type CardProps, type CardTone } from './Card'
export {
  PageHeader,
  SectionHeader,
  type PageHeaderProps,
  type SectionHeaderProps,
} from './PageHeader'
export {
  Readout,
  ReadoutGrid,
  type ReadoutProps,
  type ReadoutSize,
  type ReadoutTone,
} from './Readout'
export { Field, FieldAffix, type FieldProps } from './Field'
export { Progress, type ProgressProps, type ProgressTone } from './Progress'
export { Skeleton, SkeletonReadout, SkeletonText, type SkeletonProps } from './Skeleton'
export { AddressLink, type AddressLinkProps, type ExplorerKind } from './AddressLink'

export {
  isUserRejection,
  shortErrorMessage,
  toshToast,
  useTxLifecycleToast,
  type ToastMessage,
  type ToastOptions,
  type TxToastLabels,
  type UseTxToastArgs,
} from './toast'

export { useTxAction, type TxAction, type TxActionOptions, type TxRequest } from './useTxAction'

export {
  ActionGateProvider,
  revertOrder,
  useActionGate,
  useAmbientGate,
  type ActionBlocker,
  type ActionGate,
  type ActionGateOptions,
  type ActionVerdict,
  type AmbientGate,
  type VerdictTone,
} from './actionGate'

export { ActionButton, type ActionButtonProps } from './ActionButton'
