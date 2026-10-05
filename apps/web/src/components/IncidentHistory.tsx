import Address from '@/components/Address'
import DataTable, { type Column } from '@/components/DataTable'
import Pill from '@/components/Pill'
import { Failure, Loading } from '@/components/QueryState'
import { type IncidentFilter, queries } from '@/lib/api'
import { amount, short, utcMinute } from '@/lib/format'
import type { IncidentSummary } from '@mandate/shared'
import { useInfiniteQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'

const linkClass =
  'mono underline underline-offset-4 decoration-border-strong hover:decoration-foreground transition-colors duration-150'

export const IncidentStatus = ({ status }: { status: IncidentSummary['status'] }) =>
  status === 'open' ? (
    <Pill tone="alert" pulse>
      Open
    </Pill>
  ) : status === 'paid_out' ? (
    <Pill tone="on">Paid out</Pill>
  ) : (
    <Pill tone="off">Closed, no payout</Pill>
  )

const columns = (decimals: number, withProtocol: boolean): Column<IncidentSummary>[] => [
  {
    label: 'Opened',
    cell: (i) => (
      <span className="mono text-[12.5px] text-muted-foreground">{utcMinute(i.opened_at)} UTC</span>
    ),
  },
  {
    label: 'Incident',
    cell: (i) => (
      <Link to={`/incident/${i.address}`} title={i.address} className={linkClass}>
        {short(i.address)}
      </Link>
    ),
  },
  ...(withProtocol
    ? [
        {
          label: 'Protocol',
          cell: (i: IncidentSummary) => (
            <Link to={`/protocol/${i.protocol}`} title={i.protocol} className={linkClass}>
              {short(i.protocol)}
            </Link>
          ),
        },
      ]
    : []),
  { label: 'Trigger', cell: (i) => <Address value={i.trigger_signature} kind="tx" /> },
  {
    label: 'Attestations',
    cell: (i) => (
      <span className="mono text-[12.5px] tabular-nums text-muted-foreground">
        {i.votes_unauthorized} unauthorized · {i.votes_authorized} authorized / {i.quorum_needed}{' '}
        needed
      </span>
    ),
    wide: true,
  },
  { label: 'Status', cell: (i) => <IncidentStatus status={i.status} /> },
  {
    label: 'Payout',
    cell: (i) => (
      <span className="mono text-[12.5px] tabular-nums">
        {i.status === 'paid_out' ? amount(i.payout, decimals) : '—'}
      </span>
    ),
    className: 'text-right',
  },
]

/**
 * Incidents, newest first, a page at a time for as long as the API has older ones
 * (FR-029). One protocol's on its page; every protocol's on `/incidents`, where the
 * protocol gets a column of its own.
 */
const IncidentHistory = ({
  filter = {},
  decimals,
  empty,
}: {
  filter?: IncidentFilter
  decimals: number
  /** What to say when there is nothing — it depends on what was asked. */
  empty: string
}) => {
  const history = useInfiniteQuery(queries.incidentHistory(filter))
  const incidents = history.data?.pages.flatMap((page) => page.incidents) ?? []

  return (
    <div className="panel rounded-sm overflow-hidden">
      {history.error && incidents.length === 0 ? (
        <Failure error={history.error} />
      ) : history.data === undefined ? (
        <div className="px-4">
          <Loading what="incidents" />
        </div>
      ) : incidents.length === 0 ? (
        <div className="px-4 py-6 mono text-[13px] text-muted-foreground">{empty}</div>
      ) : (
        <DataTable
          rows={incidents}
          columns={columns(decimals, filter.protocol === undefined)}
          rowKey={(i) => i.address}
        />
      )}
      {history.hasNextPage && (
        <div className="border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={() => history.fetchNextPage()}
            disabled={history.isFetchingNextPage}
            className="mono text-[11px] uppercase tracking-[0.14em] px-3 h-8 rounded-sm border border-border-strong text-muted-foreground transition-colors duration-150 hover:text-foreground hover:border-foreground/40 disabled:opacity-50"
          >
            {history.isFetchingNextPage ? 'Reading…' : 'Show older incidents'}
          </button>
        </div>
      )}
      {history.error && incidents.length > 0 && <Failure error={history.error} />}
    </div>
  )
}

export default IncidentHistory
