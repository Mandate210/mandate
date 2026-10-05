import IncidentHistory from '@/components/IncidentHistory'
import { Failure, Loading } from '@/components/QueryState'
import { queries } from '@/lib/api'
import { cn } from '@/lib/utils'
import { type IncidentSummary, incidentStatusSchema } from '@mandate/shared'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'

type Status = IncidentSummary['status']

const FILTERS: { status: Status | undefined; label: string; empty: string }[] = [
  { status: undefined, label: 'All', empty: 'No incident has been opened yet.' },
  { status: 'open', label: 'Open', empty: 'No incident is open right now.' },
  { status: 'paid_out', label: 'Paid out', empty: 'No incident has been paid out.' },
  {
    status: 'closed_no_payout',
    label: 'Closed, no payout',
    empty: 'No incident has closed without a payout.',
  },
]

/**
 * Every incident the program has recorded, across all protocols — where a third party
 * picks one to check (SC-007). The filter lives in the URL, so a link to «open
 * incidents» stays one.
 */
const Incidents = () => {
  const [params, setParams] = useSearchParams()
  const parsed = incidentStatusSchema.safeParse(params.get('status'))
  const status = parsed.success ? parsed.data : undefined
  const active = FILTERS.find((f) => f.status === status) ?? FILTERS[0]
  const config = useQuery(queries.config())

  return (
    <div className="space-y-6">
      <div>
        <h1 className="mono text-[15px] uppercase tracking-[0.16em] font-medium">Incidents</h1>
        <p className="mt-1.5 text-[13px] text-muted-foreground max-w-2xl leading-relaxed">
          Every incident opened against a covered protocol, newest first. Each one links to its
          timeline and to the trail a third party needs to repeat the decision.
        </p>
      </div>

      <fieldset className="flex flex-wrap gap-1">
        <legend className="sr-only">Filter by status</legend>
        {FILTERS.map((f) => (
          <button
            key={f.label}
            type="button"
            aria-pressed={f === active}
            onClick={() => setParams(f.status === undefined ? {} : { status: f.status })}
            className={cn(
              'mono text-[11px] uppercase tracking-[0.14em] px-3 h-8 rounded-sm border transition-colors duration-150',
              f === active
                ? 'border-border-strong bg-surface-raised text-foreground'
                : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            {f.label}
          </button>
        ))}
      </fieldset>

      {config.error ? (
        <Failure error={config.error} />
      ) : config.data === undefined ? (
        <Loading what="the program’s configuration" />
      ) : (
        <IncidentHistory
          key={active?.label}
          filter={status === undefined ? {} : { status }}
          decimals={config.data.asset_decimals}
          empty={active?.empty ?? ''}
        />
      )}
    </div>
  )
}

export default Incidents
