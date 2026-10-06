import Address from '@/components/Address'
import { IncidentStatus } from '@/components/IncidentHistory'
import { AsOfLine, Failure, Loading } from '@/components/QueryState'
import { ApiError, queries } from '@/lib/api'
import { amount, short, utcSecond } from '@/lib/format'
import {
  type IncidentEvent,
  type Settlement,
  clockOf,
  endOf,
  settlementOf,
  timelineOf,
} from '@/lib/incident'
import { useNow, useReplay } from '@/lib/replay'
import { cn } from '@/lib/utils'
import type { IncidentDetailResponse } from '@mandate/shared'
import { useQuery } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeft, ArrowRight, Play, Square } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'

const back = (
  <Link
    to="/incidents"
    className="mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground hover:text-foreground transition-colors duration-150 inline-flex items-center gap-1.5"
  >
    <ArrowLeft className="h-3 w-3" /> Incidents
  </Link>
)

/**
 * One incident as the chain recorded it: the trigger, the opening, each attestation and
 * the payout, in seconds from the trigger. An open one counts live and refreshes every
 * ten seconds; a settled one can be replayed at the pace it happened.
 */
const IncidentTimeline = () => {
  const { id = '' } = useParams()
  const detail = useQuery(queries.incident(id))
  const config = useQuery(queries.config())

  if (detail.error instanceof ApiError && detail.error.code === 'NOT_FOUND') {
    return (
      <div className="space-y-4">
        {back}
        <div className="mono text-[13px] text-muted-foreground">No incident at {short(id)}.</div>
      </div>
    )
  }
  if (detail.error || config.error) {
    return (
      <div className="space-y-4">
        {back}
        <Failure error={detail.error ?? config.error} />
      </div>
    )
  }
  if (detail.data === undefined || config.data === undefined) {
    return (
      <div className="space-y-4">
        {back}
        <Loading what="the incident" />
      </div>
    )
  }
  return (
    <Timeline
      key={detail.data.incident.address}
      detail={detail.data}
      decimals={config.data.asset_decimals}
    />
  )
}

const Timeline = ({
  detail,
  decimals,
}: {
  detail: IncidentDetailResponse
  decimals: number
}) => {
  const { incident } = detail
  const open = incident.status === 'open'
  const { origin, from } = clockOf(detail)
  const events = timelineOf(detail)
  const end = endOf(detail)
  const replay = useReplay(end ?? 0)
  const now = useNow(open)

  const replaying = replay.elapsed !== null
  const elapsed = replay.elapsed ?? (end === null ? Math.max(0, now - origin) : end)
  const visible = replaying ? events.filter((e) => e.t <= elapsed) : events
  const attestations = visible.flatMap((e) => (e.kind === 'attestation' ? [e] : []))
  const tally = attestations.at(-1)?.tally ?? 0
  const paid = visible.some((e) => e.kind === 'payout')
  const settlement = settlementOf(events)

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {back}
        <div className="flex items-center gap-2">
          {end !== null &&
            (replaying ? (
              <button type="button" onClick={replay.stop} className={buttonClass}>
                <Square className="h-3 w-3" strokeWidth={2.5} /> Stop
              </button>
            ) : (
              <button type="button" onClick={replay.play} className={buttonClass}>
                <Play className="h-3 w-3" strokeWidth={2.5} /> Replay
              </button>
            ))}
          <Link to={`/incident/${incident.address}/verify`} className={buttonClass}>
            Verification trail <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </div>

      {/* ---- counter ---- */}
      <div className="panel rounded-sm overflow-hidden">
        <div className="flex flex-wrap items-stretch">
          <div className="flex-1 min-w-0 sm:min-w-[320px] px-6 py-7">
            <div className="label">
              {from === 'trigger' ? 'Since the trigger transaction' : 'Since the incident opened'}
            </div>
            <div className="mt-2 flex items-baseline gap-3">
              <span
                className={cn(
                  'mono tabular-nums leading-[0.85] font-medium tracking-[-0.03em]',
                  'text-[clamp(4.5rem,14vw,11rem)]',
                  paid ? 'text-alert' : 'text-foreground',
                )}
              >
                {open || replaying ? elapsed.toFixed(1) : elapsed.toLocaleString('en-US')}
              </span>
              <span
                className={cn(
                  'mono text-[clamp(1.25rem,3vw,2rem)] font-medium',
                  paid ? 'text-alert' : 'text-muted-foreground',
                )}
              >
                s
              </span>
            </div>
            <div className="mt-3 mono text-[11.5px] uppercase tracking-[0.16em]">
              <StatusLine
                detail={detail}
                decimals={decimals}
                replaying={replaying}
                paid={paid}
                speed={replay.speed}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-2 border-t xl:border-t-0 xl:border-l border-border divide-x divide-border xl:divide-x-0 w-full xl:w-auto">
            <Cell label="Incident">
              <span title={incident.address}>{short(incident.address)}</span>
            </Cell>
            <Cell label="Protocol">
              <Link
                to={`/protocol/${incident.protocol}`}
                title={incident.protocol}
                className="underline underline-offset-4 decoration-border-strong hover:decoration-foreground"
              >
                {short(incident.protocol)}
              </Link>
            </Cell>
            <Cell label="Quorum" alert={tally >= incident.quorum_needed}>
              {Math.min(tally, incident.quorum_needed)} / {incident.quorum_needed}
            </Cell>
            <Cell label="Payout" alert={paid}>
              {detail.payout !== null && paid
                ? amount(detail.payout.amount, decimals)
                : incident.status === 'closed_no_payout'
                  ? 'none'
                  : '—'}
            </Cell>
          </div>
        </div>
      </div>

      {/* ---- attestations ---- */}
      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 mb-2.5">
          <h2 className="label">
            Attestor set — {incident.set_size} when the incident opened, quorum{' '}
            {incident.quorum_needed}
          </h2>
          <span className="mono text-[10.5px] text-dim-foreground">
            absent members do not block the quorum
          </span>
        </div>
        {/* Each cell's ring falls into the 1px gap, so neighbours share one rule and a short
            last row leaves the panel's background rather than a block of border colour. */}
        <div className="panel rounded-sm overflow-hidden grid gap-px grid-cols-[repeat(auto-fit,minmax(150px,1fr))]">
          {attestations.map((a) => (
            <div
              key={a.attestor}
              className={cn(
                'px-3 py-3 ring-1 ring-border',
                a.verdict === 'unauthorized' && 'bg-alert-soft',
              )}
            >
              <Address value={a.attestor} className="text-[11px] text-foreground/85" />
              <div
                className={cn(
                  'mono text-[10.5px] uppercase tracking-[0.12em] mt-1.5',
                  a.verdict === 'unauthorized' ? 'text-alert' : 'text-ok',
                )}
              >
                {a.verdict === 'unauthorized' ? '✗ unauthorized' : '✓ authorized'}
              </div>
            </div>
          ))}
          {incident.set_size > attestations.length && (
            <div className="px-3 py-3 ring-1 ring-border">
              <div className="mono text-[11px] text-dim-foreground tabular-nums">
                {incident.set_size - attestations.length} of {incident.set_size}
              </div>
              <div className="mono text-[10.5px] uppercase tracking-[0.12em] mt-1.5 text-dim-foreground">
                {open || replaying ? '— yet to attest' : '— did not attest'}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ---- timeline ---- */}
      <div>
        <h2 className="label mb-2.5">Timeline</h2>
        <div className="panel rounded-sm px-4 sm:px-6 py-5">
          <div className="relative pl-[72px] sm:pl-[108px]">
            <div className="absolute left-[52px] sm:left-[88px] top-1 bottom-1 w-px bg-border" />
            <AnimatePresence initial={false}>
              {visible.map((ev) => (
                <Row
                  key={`${ev.kind}-${ev.kind === 'attestation' ? ev.attestor : ''}`}
                  ev={ev}
                  detail={detail}
                  decimals={decimals}
                  settlement={settlement}
                />
              ))}
            </AnimatePresence>
          </div>
        </div>
      </div>

      <AsOfLine asOf={detail.as_of} />
    </div>
  )
}

const buttonClass =
  'mono text-[11px] uppercase tracking-[0.14em] inline-flex items-center gap-2 px-3.5 h-8 rounded-sm border border-border-strong text-muted-foreground transition-colors duration-150 hover:text-foreground hover:border-foreground/40'

const StatusLine = ({
  detail,
  decimals,
  replaying,
  paid,
  speed,
}: {
  detail: IncidentDetailResponse
  decimals: number
  replaying: boolean
  paid: boolean
  speed: number
}) => {
  const { incident } = detail
  if (replaying && !paid) {
    return (
      <span className="text-muted-foreground animate-pulse-alert">
        Replaying the recorded timeline{speed > 1 ? ` at ×${Math.round(speed)}` : ''}…
      </span>
    )
  }
  if (incident.status === 'open') {
    return (
      <span className="text-muted-foreground animate-pulse-alert">
        Collecting attestations — window closes {utcSecond(incident.deadline)}
      </span>
    )
  }
  if (detail.payout !== null) {
    return (
      <span className="text-alert">
        Quorum: unauthorized → {amount(detail.payout.amount, decimals)} paid out
      </span>
    )
  }
  return (
    <span className="text-dim-foreground">
      Attestation window closed without a payout — {incident.votes_unauthorized} of{' '}
      {incident.quorum_needed} needed
    </span>
  )
}

const Cell = ({
  label,
  alert,
  children,
}: {
  label: string
  alert?: boolean
  children: React.ReactNode
}) => (
  <div className="px-5 py-4 min-w-0 sm:min-w-[150px] border-b border-border last:border-b-0 xl:border-b xl:last:border-b-0">
    <div className="label">{label}</div>
    <div
      className={cn(
        'mono text-[14px] mt-1.5 tabular-nums break-words',
        alert ? 'text-alert' : 'text-foreground',
      )}
    >
      {children}
    </div>
  </div>
)

const Row = ({
  ev,
  detail,
  decimals,
  settlement,
}: {
  ev: IncidentEvent
  detail: IncidentDetailResponse
  decimals: number
  settlement: Settlement | null
}) => {
  const { incident } = detail
  const alert = ev.kind === 'payout' || (ev.kind === 'attestation' && ev.verdict === 'unauthorized')
  const effective = detail.verification.declaration_at_trigger.entries.filter(
    (e) => e.state === 'effective',
  ).length

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.4, 0, 0.2, 1] }}
      className="relative pb-5 last:pb-0"
    >
      {/* time gutter */}
      <span className="absolute -left-[72px] sm:-left-[108px] top-0 mono text-[12px] tabular-nums text-muted-foreground w-[44px] sm:w-[64px] text-right">
        T+{ev.t}s
      </span>
      {/* node */}
      <span
        className={cn(
          'absolute -left-[24px] top-[5px] h-[7px] w-[7px] rounded-full ring-4 ring-surface',
          alert ? 'bg-alert' : 'bg-border-strong',
        )}
      />

      {ev.kind === 'payout' ? (
        <div className="rounded-sm border border-alert/50 bg-alert-soft px-4 py-3.5">
          <div className="mono text-[clamp(0.95rem,2.2vw,1.35rem)] text-alert font-medium tracking-tight break-words">
            PAYOUT {amount(ev.amount, decimals)} → {short(ev.beneficiary)}
          </div>
          <div className="mono text-[11.5px] text-alert/70 mt-1.5">
            {settlement?.kind === 'deciding-vote' ? (
              <>paid by the vote that completed the quorum, in the same transaction</>
            ) : settlement?.kind === 'separate' ? (
              <>
                sent by <span className="text-alert">resolve</span>, {settlement.delay} s after the
                quorum
              </>
            ) : (
              <>paid once the quorum was reached</>
            )}{' '}
            — no appeal window
          </div>
          <div className="mono text-[11.5px] text-muted-foreground mt-1 break-words">
            <Address value={ev.signature} kind="tx" /> · {utcSecond(ev.at)}
          </div>
        </div>
      ) : ev.kind === 'attestation' ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span
            className={cn(
              'mono text-[13px] w-[124px]',
              ev.verdict === 'unauthorized' ? 'text-alert' : 'text-ok',
            )}
          >
            {ev.verdict === 'unauthorized' ? '✗ unauthorized' : '✓ authorized'}
          </span>
          <Address value={ev.attestor} className="text-[13px] text-foreground/85" />
          {ev.verdict === 'unauthorized' && (
            <span
              className={cn(
                'mono text-[12px] tabular-nums px-1.5 py-0.5 rounded-sm border',
                ev.tally >= incident.quorum_needed
                  ? 'border-alert/60 bg-alert-soft text-alert'
                  : 'border-border text-muted-foreground',
              )}
            >
              {ev.tally}/{incident.quorum_needed}
            </span>
          )}
          {ev.quorumReached && (
            <span className="mono text-[11.5px] uppercase tracking-[0.16em] text-alert">
              ← quorum reached
            </span>
          )}
          <span className="mono text-[11.5px] text-dim-foreground sm:ml-auto">
            {ev.signature === null ? 'not indexed yet' : <Address value={ev.signature} kind="tx" />}
          </span>
        </div>
      ) : ev.kind === 'opened' ? (
        <div>
          <div className="flex flex-wrap items-baseline gap-x-4">
            <span className="text-[13.5px] font-medium">Incident opened</span>
            {ev.signature !== null && (
              <Address
                value={ev.signature}
                kind="tx"
                className="text-[13px] text-muted-foreground"
              />
            )}
          </div>
          <div className="mono text-[11.5px] mt-1 text-muted-foreground">
            by <Address value={ev.opener} /> · bond {amount(incident.bond, decimals)}
          </div>
          <div className="mono text-[11.5px] mt-1 text-muted-foreground">
            quorum {incident.quorum_needed} of {incident.set_size} · attestations accepted until{' '}
            {utcSecond(incident.deadline)}
          </div>
        </div>
      ) : (
        <div>
          <div className="flex flex-wrap items-baseline gap-x-4">
            <span className="text-[13.5px] font-medium">Privileged transaction</span>
            <Address value={ev.signature} kind="tx" className="text-[13px] text-muted-foreground" />
          </div>
          <div className="mono text-[11.5px] mt-1 text-muted-foreground">
            {ev.slot === null ? '' : `slot ${ev.slot.toLocaleString('en-US')} · `}
            {utcSecond(ev.at)}
          </div>
          <div className="mono text-[11.5px] mt-1 text-muted-foreground">
            {effective === 0
              ? 'no declaration entry was in force at its block time'
              : `${effective} declaration ${effective === 1 ? 'entry' : 'entries'} in force at its block time`}{' '}
            —{' '}
            <Link
              to={`/incident/${incident.address}/verify`}
              className="underline underline-offset-4 decoration-border-strong hover:decoration-foreground"
            >
              see the trail
            </Link>
          </div>
        </div>
      )}
    </motion.div>
  )
}

export default IncidentTimeline
