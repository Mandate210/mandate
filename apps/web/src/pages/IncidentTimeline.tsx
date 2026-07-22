import { ATTESTOR_SET, INCIDENT, TIMELINE, type TimelineEvent, usdc } from '@/lib/mockData'
import { useScenario } from '@/lib/scenario'
import { cn } from '@/lib/utils'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowRight, Play } from 'lucide-react'
import { Link } from 'react-router-dom'

const VOTES: Record<string, 'unauthorized' | 'authorized'> = TIMELINE.reduce(
  (acc, e) => {
    if (e.kind === 'attestation' && e.attestor && e.verdict) acc[e.attestor] = e.verdict
    return acc
  },
  {} as Record<string, 'unauthorized' | 'authorized'>,
)

const IncidentTimeline = () => {
  const { status, elapsed, visibleEvents, run } = useScenario()

  const settled = status === 'settled'
  const idle = status === 'idle'

  const votedSoFar = new Set(
    visibleEvents.flatMap((e) => (e.kind === 'attestation' && e.attestor ? [e.attestor] : [])),
  )
  const tally = visibleEvents.filter(
    (e) => e.kind === 'attestation' && e.verdict === 'unauthorized',
  ).length

  return (
    <div className="space-y-8">
      {/* ---- counter ---- */}
      <div className="panel rounded-sm overflow-hidden">
        <div className="flex flex-wrap items-stretch">
          <div className="flex-1 min-w-[320px] px-6 py-7">
            <div className="label">Elapsed since trigger transaction</div>
            <div className="mt-2 flex items-baseline gap-3">
              <span
                className={cn(
                  'mono tabular-nums leading-[0.85] font-medium tracking-[-0.03em]',
                  'text-[clamp(4.5rem,14vw,11rem)]',
                  settled ? 'text-alert' : idle ? 'text-dim-foreground' : 'text-foreground',
                )}
              >
                {elapsed.toFixed(1)}
              </span>
              <span
                className={cn(
                  'mono text-[clamp(1.25rem,3vw,2rem)] font-medium',
                  settled ? 'text-alert' : 'text-muted-foreground',
                )}
              >
                s
              </span>
            </div>
            <div className="mt-3 mono text-[11.5px] uppercase tracking-[0.16em]">
              {idle ? (
                <span className="text-dim-foreground">No incidents — run the scenario</span>
              ) : settled ? (
                <span className="text-alert">Unauthorized transaction → money in the treasury</span>
              ) : (
                <span className="text-muted-foreground animate-pulse-alert">
                  Collecting attestations…
                </span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-2 border-t xl:border-t-0 xl:border-l border-border divide-x divide-border xl:divide-x-0 w-full xl:w-auto">
            <Cell label="Incident" value={INCIDENT.id} />
            <Cell label="Protocol" value={INCIDENT.protocolName} />
            <Cell
              label="Quorum"
              value={`${Math.min(tally, INCIDENT.quorumRequired)} / ${INCIDENT.quorumRequired}`}
              alert={tally >= INCIDENT.quorumRequired}
            />
            <Cell label="Payable" value={usdc(INCIDENT.payoutAmount)} alert={settled} />
          </div>
        </div>
      </div>

      {/* ---- attestor set ---- */}
      <div>
        <div className="flex items-baseline justify-between gap-4 mb-2.5">
          <h2 className="label">
            Attestor set — {INCIDENT.attestorSetSize} members, quorum {INCIDENT.quorumRequired}
          </h2>
          <span className="mono text-[10.5px] text-dim-foreground">
            absent members do not block the quorum
          </span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-px bg-border rounded-sm overflow-hidden">
          {ATTESTOR_SET.map((a) => {
            const voted = votedSoFar.has(a)
            const verdict = voted ? VOTES[a] : undefined
            return (
              <div
                key={a}
                className={cn(
                  'bg-surface px-3 py-3 transition-colors duration-500',
                  verdict === 'unauthorized' && 'bg-alert-soft',
                )}
              >
                <div className="mono text-[11px] text-foreground/85">{a}</div>
                <div
                  className={cn(
                    'mono text-[10.5px] uppercase tracking-[0.12em] mt-1.5',
                    verdict === 'unauthorized' && 'text-alert',
                    verdict === 'authorized' && 'text-ok',
                    !voted && 'text-dim-foreground',
                  )}
                >
                  {verdict === 'unauthorized'
                    ? '✗ unauthorized'
                    : verdict === 'authorized'
                      ? '✓ authorized'
                      : '— no vote'}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* ---- timeline ---- */}
      <div>
        <h2 className="label mb-2.5">Timeline</h2>

        {idle ? (
          <div className="panel rounded-sm px-6 py-14 flex flex-col items-center gap-4">
            <p className="mono text-[12px] text-muted-foreground text-center">
              No incidents recorded for {INCIDENT.protocolName}.
            </p>
            <button
              type="button"
              onClick={run}
              className="mono text-[11px] uppercase tracking-[0.14em] inline-flex items-center gap-2 px-3.5 h-8 rounded-sm bg-alert text-background font-medium transition-opacity duration-150 hover:opacity-85"
            >
              <Play className="h-3 w-3" strokeWidth={2.5} /> Run scenario
            </button>
          </div>
        ) : (
          <div className="panel rounded-sm px-4 sm:px-6 py-5">
            <div className="relative pl-[92px] sm:pl-[108px]">
              <div className="absolute left-[72px] sm:left-[88px] top-1 bottom-1 w-px bg-border" />
              <AnimatePresence initial={false}>
                {visibleEvents.map((ev) => (
                  <Row key={ev.id} ev={ev} />
                ))}
              </AnimatePresence>
            </div>
          </div>
        )}
      </div>

      {settled && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.6 }}>
          <Link
            to={`/incident/${INCIDENT.id}/verify`}
            className="mono text-[11px] uppercase tracking-[0.14em] inline-flex items-center gap-2 px-3.5 h-8 rounded-sm border border-border-strong text-muted-foreground transition-colors duration-150 hover:text-foreground hover:border-foreground/40"
          >
            Verification trail <ArrowRight className="h-3 w-3" />
          </Link>
        </motion.div>
      )}
    </div>
  )
}

const Cell = ({
  label,
  value,
  alert,
}: {
  label: string
  value: string
  alert?: boolean
}) => (
  <div className="px-5 py-4 min-w-[150px] border-b border-border last:border-b-0 xl:border-b xl:last:border-b-0">
    <div className="label">{label}</div>
    <div
      className={cn(
        'mono text-[14px] mt-1.5 tabular-nums',
        alert ? 'text-alert' : 'text-foreground',
      )}
    >
      {value}
    </div>
  </div>
)

const Row = ({ ev }: { ev: TimelineEvent }) => {
  const isPayout = ev.kind === 'payout'
  const isQuorum = ev.quorumReached
  const unauthorized = ev.verdict === 'unauthorized'

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.4, 0, 0.2, 1] }}
      className="relative pb-5 last:pb-0"
    >
      {/* time gutter */}
      <span className="absolute -left-[92px] sm:-left-[108px] top-0 mono text-[12px] tabular-nums text-muted-foreground w-[56px] sm:w-[64px] text-right">
        T+{ev.t}s
      </span>
      {/* node */}
      <span
        className={cn(
          'absolute -left-[24px] sm:-left-[24px] top-[5px] h-[7px] w-[7px] rounded-full ring-4 ring-surface',
          isPayout || unauthorized ? 'bg-alert' : 'bg-border-strong',
        )}
      />

      {isPayout ? (
        <div className="rounded-sm border border-alert/50 bg-alert-soft px-4 py-3.5">
          <div className="mono text-[clamp(0.95rem,2.2vw,1.35rem)] text-alert font-medium tracking-tight">
            PAYOUT {usdc(INCIDENT.payoutAmount)} → {INCIDENT.beneficiaryLabel}
          </div>
          <div className="mono text-[11.5px] text-alert/70 mt-1.5">
            released by the same transaction that recorded the quorum
          </div>
          <div className="mono text-[11.5px] text-muted-foreground mt-1">
            {ev.signature} · {ev.timestamp}
          </div>
        </div>
      ) : ev.kind === 'attestation' ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span
            className={cn('mono text-[13px] w-[140px]', unauthorized ? 'text-alert' : 'text-ok')}
          >
            {unauthorized ? '✗ unauthorized' : '✓ authorized'}
          </span>
          <span className="mono text-[13px] text-foreground/85 w-[96px]">{ev.attestor}</span>
          {ev.tally != null && (
            <span
              className={cn(
                'mono text-[12px] tabular-nums px-1.5 py-0.5 rounded-sm border',
                isQuorum
                  ? 'border-alert/60 bg-alert-soft text-alert'
                  : 'border-border text-muted-foreground',
              )}
            >
              {ev.tally}/{INCIDENT.quorumRequired}
            </span>
          )}
          {isQuorum && (
            <span className="mono text-[11.5px] uppercase tracking-[0.16em] text-alert">
              ← quorum reached
            </span>
          )}
          <span className="mono text-[11.5px] text-dim-foreground ml-auto">{ev.signature}</span>
        </div>
      ) : (
        <div>
          <div className="flex flex-wrap items-baseline gap-x-4">
            <span className="text-[13.5px] font-medium">{ev.title}</span>
            <span className="mono text-[13px] text-muted-foreground">{ev.signature}</span>
          </div>
          {ev.lines?.map((line) => (
            <div
              key={line}
              className={cn(
                'mono text-[11.5px] mt-1',
                line.startsWith('✗') ? 'text-alert' : 'text-muted-foreground',
              )}
            >
              {line}
            </div>
          ))}
        </div>
      )}
    </motion.div>
  )
}

export default IncidentTimeline
