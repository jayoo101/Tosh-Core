'use client'

import { useState, type FormEvent } from 'react'

import { Badge, Button, Card, Field, PageHeader } from '@/components/ui'
import { CHAIN_BYLINE } from '@/lib/contracts'
import { fill, useLocale, useT, type Dictionary } from '@/i18n'
import {
  APPLICATION_LIMITS,
  codePointLength,
  normaliseTelegramHandle,
  validateApplication,
  type ApplicationErrorCode,
  type ApplicationErrors,
  type ApplicationField,
} from '@/lib/projectApplication'

type Status =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent'; handle: string }
  | { kind: 'failed'; message: string }

function errorText(t: Dictionary['apply'], field: ApplicationField, code: ApplicationErrorCode | undefined): string | null {
  if (!code) return null
  if (code === 'required') return field === 'rulesAccepted' ? t.errRules : t.errRequired
  if (code === 'tooShort') return fill(t.errTooShort, { min: APPLICATION_LIMITS.ecosystemIntegrationMin })
  if (code === 'tooLong') {
    const max = field === 'projectName' ? APPLICATION_LIMITS.projectName
      : field === 'demoOrRepo' ? APPLICATION_LIMITS.demoOrRepo
      : APPLICATION_LIMITS.ecosystemIntegration
    return fill(t.errTooLong, { max })
  }
  return field === 'telegramHandle' ? t.errTelegramInvalid : t.errDemoInvalid
}

/**
 * `/apply`. Errors show per field only after the first submit attempt, so an
 * empty form does not open covered in red.
 */
export function ApplyForm() {
  const t = useT().apply
  const locale = useLocale()

  const [projectName, setProjectName] = useState('')
  const [demoOrRepo, setDemoOrRepo] = useState('')
  const [ecosystemIntegration, setEcosystemIntegration] = useState('')
  const [telegramHandle, setTelegramHandle] = useState('')
  const [rulesAccepted, setRulesAccepted] = useState(false)
  const [company, setCompany] = useState('')
  const [attempted, setAttempted] = useState(false)
  const [serverErrors, setServerErrors] = useState<ApplicationErrors>({})
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  const input = { projectName, demoOrRepo, ecosystemIntegration, telegramHandle, rulesAccepted }
  const local = validateApplication(input).errors
  const errors: ApplicationErrors = attempted ? { ...serverErrors, ...local } : {}
  const err = (f: ApplicationField) => errorText(t, f, errors[f])

  const edit = <T,>(set: (v: T) => void) => (v: T) => {
    set(v)
    if (Object.keys(serverErrors).length) setServerErrors({})
    if (status.kind === 'failed') setStatus({ kind: 'idle' })
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setAttempted(true)
    if (Object.keys(local).length > 0) {
      setStatus({ kind: 'failed', message: t.fixFields })
      return
    }
    setStatus({ kind: 'sending' })
    try {
      const res = await fetch('/api/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...input, locale, company }),
      })
      if (res.ok) {
        setStatus({ kind: 'sent', handle: normaliseTelegramHandle(telegramHandle) ?? telegramHandle })
        return
      }
      if (res.status === 400) {
        const body = (await res.json().catch(() => null)) as { fields?: ApplicationErrors } | null
        setServerErrors(body?.fields ?? {})
        setStatus({ kind: 'failed', message: t.fixFields })
        return
      }
      setStatus({
        kind: 'failed',
        message: res.status === 429 ? t.errRateLimited : res.status === 503 ? t.errUnavailable : t.errGeneric,
      })
    } catch {
      setStatus({ kind: 'failed', message: t.errGeneric })
    }
  }

  function reset() {
    setProjectName('')
    setDemoOrRepo('')
    setEcosystemIntegration('')
    setTelegramHandle('')
    setRulesAccepted(false)
    setAttempted(false)
    setServerErrors({})
    setStatus({ kind: 'idle' })
  }

  const eiCount = codePointLength(ecosystemIntegration.trim())
  const rules = [t.rule1, t.rule2, t.rule3, t.rule4]

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10 flex flex-col gap-card-lg">
      <PageHeader
        eyebrow={t.eyebrow}
        title={t.title}
        accent={t.accent}
        subtitle={t.subtitle}
        status={<Badge tone="neutral">{CHAIN_BYLINE}</Badge>}
      />

      {status.kind === 'sent' ? (
        <Card tone="ok" title={t.successTitle}>
          <div className="flex flex-col items-start gap-card">
            <p className="text-note text-text-secondary leading-relaxed">
              {fill(t.successBody, { handle: status.handle })}
            </p>
            <Button variant="ghost" size="sm" label={t.another} onClick={reset} />
          </div>
        </Card>
      ) : (
        <form onSubmit={submit} noValidate className="flex flex-col gap-card-lg">
          <Card title={t.formTitle} subtitle={t.formSubtitle} interactive={false}>
            <div className="flex flex-col gap-card">
              <Field
                label={t.projectName}
                name="projectName"
                value={projectName}
                onValueChange={edit(setProjectName)}
                placeholder={t.projectNamePlaceholder}
                hint={t.projectNameHint}
                error={err('projectName')}
              />
              <Field
                label={t.demoOrRepo}
                name="demoOrRepo"
                multiline
                rows={2}
                value={demoOrRepo}
                onValueChange={edit(setDemoOrRepo)}
                placeholder={t.demoOrRepoPlaceholder}
                hint={t.demoOrRepoHint}
                error={err('demoOrRepo')}
              />
              <Field
                label={t.ecosystem}
                name="ecosystemIntegration"
                multiline
                rows={4}
                value={ecosystemIntegration}
                onValueChange={edit(setEcosystemIntegration)}
                placeholder={t.ecosystemPlaceholder}
                hint={fill(t.ecosystemHint, { count: eiCount, max: APPLICATION_LIMITS.ecosystemIntegration })}
                error={err('ecosystemIntegration')}
              />
              <Field
                label={t.telegram}
                name="telegramHandle"
                value={telegramHandle}
                onValueChange={edit(setTelegramHandle)}
                placeholder={t.telegramPlaceholder}
                hint={t.telegramHint}
                error={err('telegramHandle')}
              />

              {/* Honeypot: off-screen rather than `display:none`, which some bots skip. */}
              <div aria-hidden className="absolute -left-[10000px] top-auto h-px w-px overflow-hidden">
                <label>
                  {t.honeypot}
                  <input
                    type="text"
                    name="company"
                    tabIndex={-1}
                    autoComplete="off"
                    value={company}
                    onChange={(e) => setCompany(e.target.value)}
                  />
                </label>
              </div>
            </div>
          </Card>

          <Card title={t.rulesTitle} interactive={false} tone={errors.rulesAccepted ? 'danger' : 'default'}>
            <div className="flex flex-col gap-card">
              <ol className="flex list-decimal flex-col gap-gap-tight pl-5 text-note text-text-secondary leading-relaxed">
                {rules.map((r) => <li key={r}>{r}</li>)}
              </ol>
              <label className="flex cursor-pointer items-start gap-gap-tight text-note text-text-primary">
                <input
                  type="checkbox"
                  checked={rulesAccepted}
                  onChange={(e) => edit(setRulesAccepted)(e.target.checked)}
                  className="mt-1 h-4 w-4 accent-brand"
                />
                <span>{t.rulesAccept}</span>
              </label>
              {err('rulesAccepted') && (
                <span className="font-mono text-label tracking-[0.12em] text-danger">{err('rulesAccepted')}</span>
              )}
            </div>
          </Card>

          <div className="flex flex-col gap-gap-tight">
            {status.kind === 'sending'
              ? <Button type="submit" size="lg" full label={t.submit} busy busyLabel={t.submitting} />
              : <Button type="submit" size="lg" full label={t.submit} />}
            {status.kind === 'failed' && (
              <p role="alert" className="font-mono text-label tracking-[0.12em] text-danger">{status.message}</p>
            )}
          </div>
        </form>
      )}
    </main>
  )
}
