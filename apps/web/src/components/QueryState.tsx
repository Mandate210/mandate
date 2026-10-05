import { ApiError, ContractError } from '@/lib/api'
import { utcSecond } from '@/lib/format'
import type { AsOf } from '@mandate/shared'

/**
 * What a page shows while its data is on the way, and when it did not come. Never the
 * fixtures in its place (`lib/api.ts`): a blank page with the reason is honest, a page
 * of invented numbers is not.
 */
export const Loading = ({ what }: { what: string }) => (
  <div className="mono text-[12px] text-dim-foreground py-6" aria-live="polite">
    Reading {what}…
  </div>
)

const explain = (error: unknown): { title: string; detail: string } => {
  if (error instanceof ApiError) {
    if (error.code === 'RATE_LIMITED') {
      return {
        title: 'Too many requests from this address',
        detail:
          error.retryAfterSeconds === null
            ? error.message
            : `Try again in ${error.retryAfterSeconds} s.`,
      }
    }
    return { title: `The API answered ${error.status} ${error.code}`, detail: error.message }
  }
  if (error instanceof ContractError) {
    return {
      title: 'The API sent a response this page does not understand',
      detail: error.message,
    }
  }
  return {
    title: 'The API could not be reached',
    detail: error instanceof Error ? error.message : String(error),
  }
}

export const Failure = ({ error }: { error: unknown }) => {
  const { title, detail } = explain(error)
  return (
    <div role="alert" className="panel rounded-sm px-4 py-4">
      <div className="mono text-[11px] uppercase tracking-[0.14em] text-foreground">{title}</div>
      <div className="mono text-[12px] text-muted-foreground mt-1.5 break-words">{detail}</div>
    </div>
  )
}

/** The moment a response describes: every figure on the page is as of this. */
export const AsOfLine = ({ asOf }: { asOf: AsOf }) => (
  <p className="mono text-[11px] text-dim-foreground">
    As of slot {asOf.slot.toLocaleString('en-US')} · {utcSecond(asOf.unix_ts)}
  </p>
)
