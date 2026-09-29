/**
 * The `/apply` form's rules, shared by the page and `POST /api/apply`.
 *
 * One module so the form cannot accept what the route refuses. The route is
 * the one that counts — the form only runs the same checks early so an
 * applicant sees the problem beside the field instead of after a round trip.
 *
 * Lengths are counted in code points, not UTF-16 units: the 200-character
 * limit on `ecosystemIntegration` is written for Chinese applicants, and a
 * limit that counted an emoji as two would disagree with the counter they see.
 */

export const APPLICATION_LIMITS = {
  projectName: 40,
  demoOrRepo: 300,
  ecosystemIntegration: 200,
  /** Below this, the answer cannot name a circuit or a BEM flow. */
  ecosystemIntegrationMin: 10,
  /** Links or addresses in `demoOrRepo`. */
  demoOrRepoItems: 3,
} as const

export type ApplicationField =
  | 'projectName'
  | 'demoOrRepo'
  | 'ecosystemIntegration'
  | 'telegramHandle'
  | 'rulesAccepted'

export type ApplicationErrorCode = 'required' | 'tooLong' | 'tooShort' | 'invalid'

export type ApplicationErrors = Partial<Record<ApplicationField, ApplicationErrorCode>>

export interface ApplicationInput {
  projectName: string
  demoOrRepo: string
  ecosystemIntegration: string
  telegramHandle: string
  rulesAccepted: boolean
}

export function codePointLength(s: string): number {
  return Array.from(s).length
}

/** C0/C1 controls other than newline and tab; they have no business in a review card. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g

function clean(s: string): string {
  return s.replace(CONTROL_CHARS, '').trim()
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s)
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.includes('.')
  } catch {
    return false
  }
}

/** Whitespace- or comma-separated; each item a link or a contract address. */
export function splitDemoOrRepo(s: string): string[] {
  return s.split(/[\s,，]+/).map((x) => x.trim()).filter(Boolean)
}

/**
 * `@name`, `name` or a `t.me/name` link, normalised to `@name`.
 * Telegram usernames are 5–32 of `[A-Za-z0-9_]` and start with a letter.
 */
export function normaliseTelegramHandle(s: string): string | null {
  let h = s.trim()
  h = h.replace(/^https?:\/\//i, '').replace(/^(t\.me|telegram\.me)\//i, '')
  h = h.replace(/^@/, '').replace(/\/+$/, '')
  return /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(h) ? `@${h}` : null
}

/** The review-group card. Plain text — see `POST /api/apply`. */
export function formatApplicationCard(a: ApplicationInput, meta: { locale: string; at: Date }): string {
  return [
    'Tosh project application',
    '',
    `Project: ${a.projectName}`,
    `Telegram: ${a.telegramHandle}  https://t.me/${a.telegramHandle.slice(1)}`,
    '',
    'Verifiable output:',
    a.demoOrRepo,
    '',
    'TapeOut / $BEM integration:',
    a.ecosystemIntegration,
    '',
    'Rules (ownerless launch + shelf mechanism): accepted',
    `Locale: ${meta.locale} · ${meta.at.toISOString()}`,
  ].join('\n')
}

export function validateApplication(raw: Partial<Record<keyof ApplicationInput, unknown>>): {
  value: ApplicationInput | null
  errors: ApplicationErrors
} {
  const str = (v: unknown) => (typeof v === 'string' ? clean(v) : '')
  const errors: ApplicationErrors = {}

  const projectName = str(raw.projectName).replace(/\s+/g, ' ')
  if (!projectName) errors.projectName = 'required'
  else if (codePointLength(projectName) > APPLICATION_LIMITS.projectName) errors.projectName = 'tooLong'

  const demoOrRepo = str(raw.demoOrRepo)
  const items = splitDemoOrRepo(demoOrRepo)
  if (items.length === 0) errors.demoOrRepo = 'required'
  else if (codePointLength(demoOrRepo) > APPLICATION_LIMITS.demoOrRepo) errors.demoOrRepo = 'tooLong'
  else if (
    items.length > APPLICATION_LIMITS.demoOrRepoItems
    || !items.every((x) => isHttpUrl(x) || EVM_ADDRESS.test(x))
  ) errors.demoOrRepo = 'invalid'

  const ecosystemIntegration = str(raw.ecosystemIntegration)
  const eiLen = codePointLength(ecosystemIntegration)
  if (eiLen === 0) errors.ecosystemIntegration = 'required'
  else if (eiLen > APPLICATION_LIMITS.ecosystemIntegration) errors.ecosystemIntegration = 'tooLong'
  else if (eiLen < APPLICATION_LIMITS.ecosystemIntegrationMin) errors.ecosystemIntegration = 'tooShort'

  const rawHandle = str(raw.telegramHandle)
  const telegramHandle = normaliseTelegramHandle(rawHandle)
  if (!rawHandle) errors.telegramHandle = 'required'
  else if (!telegramHandle) errors.telegramHandle = 'invalid'

  const rulesAccepted = raw.rulesAccepted === true
  if (!rulesAccepted) errors.rulesAccepted = 'required'

  if (Object.keys(errors).length > 0) return { value: null, errors }
  return {
    value: {
      projectName,
      demoOrRepo: items.join('\n'),
      ecosystemIntegration,
      telegramHandle: telegramHandle!,
      rulesAccepted,
    },
    errors,
  }
}
