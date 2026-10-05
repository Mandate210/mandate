import Address from '@/components/Address'
import DataTable, { type Column } from '@/components/DataTable'
import IncidentHistory from '@/components/IncidentHistory'
import Pill from '@/components/Pill'
import { AsOfLine, Failure, Loading } from '@/components/QueryState'
import { ApiError, queries } from '@/lib/api'
import {
  ENTRY_STATE,
  amount,
  freeCapital,
  operationOf,
  percent,
  short,
  utcDay,
  utcMinute,
  windowOf,
} from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  type ConfigResponse,
  type DeclarationEntryResponse,
  type Policy,
  type ProtocolDetailResponse,
  quorumNeeded,
} from '@mandate/shared'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'

/**
 * One protocol, its pool, the policies holding a reservation on it, its declaration
 * and its whole incident history (FR-029) — each from its own endpoint, so a section
 * that fails says so without taking the rest of the page with it.
 */
const ProtocolDetail = () => {
  const { id = '' } = useParams()
  const detail = useQuery(queries.protocol(id))
  const config = useQuery(queries.config())

  const back = (
    <Link
      to="/"
      className="mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground hover:text-foreground transition-colors duration-150 inline-flex items-center gap-1.5"
    >
      <ArrowLeft className="h-3 w-3" /> Pools
    </Link>
  )

  if (detail.error instanceof ApiError && detail.error.code === 'NOT_FOUND') {
    return (
      <div className="space-y-4">
        {back}
        <div className="mono text-[13px] text-muted-foreground">
          No protocol is registered at {short(id)}.
        </div>
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
        <Loading what="the protocol" />
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <div>
        {back}
        <Header detail={detail.data} config={config.data} />
      </div>
      <Notices detail={detail.data} config={config.data} />
      <Coverage detail={detail.data} decimals={config.data.asset_decimals} />
      <Declaration protocol={id} />
      <Incidents protocol={id} decimals={config.data.asset_decimals} />
      <Accounts detail={detail.data} />
      <AsOfLine asOf={detail.data.as_of} />
    </div>
  )
}

/* ---------------------------------------------------------------- */
/* Header                                                            */
/* ---------------------------------------------------------------- */

const Header = ({ detail, config }: { detail: ProtocolDetailResponse; config: ConfigResponse }) => {
  const { pool, protocol } = detail
  const decimals = config.asset_decimals
  return (
    <div className="mt-3 flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
      <div>
        <div className="label">Protocol</div>
        <h1 className="text-[22px] font-medium tracking-tight mt-1">
          <Address value={protocol.address} />
        </h1>
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:flex sm:flex-wrap sm:gap-x-8">
        <Meta label="Pool capital" value={amount(pool.total_assets, decimals)} />
        <Meta label="Reserved" value={amount(pool.locked_limit, decimals)} />
        <Meta
          label="Free"
          value={amount(freeCapital(pool.total_assets, pool.locked_limit), decimals)}
        />
        <Meta label="Utilization" value={percent(pool.utilization_bps)} />
        <Meta
          label="Attestor quorum"
          value={`${quorumNeeded(config.attestor_count, config.quorum_bps)} of ${config.attestor_count}`}
        />
      </div>
    </div>
  )
}

/** What stops new cover or flags an incident — said once, above the details. */
const Notices = ({
  detail,
  config,
}: { detail: ProtocolDetailResponse; config: ConfigResponse }) => {
  const open = detail.recent_incidents.find((i) => i.status === 'open')
  const lines = [
    config.paused &&
      'New policies are paused across every pool. Policies already in force still pay out.',
    detail.protocol.new_policies_paused && 'New policies for this protocol are paused.',
  ].filter((line): line is string => typeof line === 'string')

  return (
    <>
      {detail.pool.open_incidents > 0 && (
        <Link
          to={open === undefined ? '#incidents' : `/incident/${open.address}`}
          className="block panel rounded-sm border-alert/40 bg-alert-soft/40 px-4 py-3 transition-colors duration-150 hover:bg-alert-soft/70"
        >
          <div className="flex flex-wrap items-center gap-3">
            <span className="h-1.5 w-1.5 rounded-full bg-alert animate-pulse-alert" />
            <span className="mono text-[11px] uppercase tracking-[0.14em] text-alert">
              {detail.pool.open_incidents === 1
                ? 'Incident open — attestations are being collected'
                : `${detail.pool.open_incidents} incidents open — attestations are being collected`}
            </span>
            {open !== undefined && (
              <span className="mono text-[11px] text-muted-foreground">
                trigger {short(open.trigger_signature)}
              </span>
            )}
          </div>
        </Link>
      )}
      {lines.map((line) => (
        <div
          key={line}
          className="panel rounded-sm px-4 py-3 mono text-[12px] text-muted-foreground"
        >
          {line}
        </div>
      ))}
    </>
  )
}

/* ---------------------------------------------------------------- */
/* Coverage                                                          */
/* ---------------------------------------------------------------- */

/** `in_force` is the rule; the stored status only says why a policy is not. */
const policyState = (policy: Policy, now: number): { label: string; on: boolean } => {
  if (policy.in_force) return { label: 'In force', on: true }
  if (policy.status === 'pending') return { label: 'Premium unpaid', on: false }
  if (now < policy.start_ts) return { label: 'Not started', on: false }
  return { label: 'Ended', on: false }
}

const Coverage = ({ detail, decimals }: { detail: ProtocolDetailResponse; decimals: number }) => (
  <Section title="Coverage">
    {detail.policies.length === 0 ? (
      <div className="px-4 py-6 mono text-[13px] text-muted-foreground">
        No policy holds a reservation on this pool, so an incident here pays nothing.
      </div>
    ) : (
      <div className="divide-y divide-border">
        {detail.policies.map((policy) => {
          const state = policyState(policy, detail.as_of.unix_ts)
          const limit = BigInt(policy.limit)
          const retention = BigInt(policy.retention)
          return (
            <div key={policy.address}>
              <div className="flex flex-wrap items-center gap-3 px-4 pt-3.5">
                <span className="mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                  Policy #{policy.seq}
                </span>
                <Address value={policy.address} className="text-[12px] text-muted-foreground" />
                <Pill tone={state.on ? 'on' : 'off'}>{state.label}</Pill>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
                <Field label="Policy limit" value={amount(policy.limit, decimals)} />
                <Field
                  label="Protocol retention"
                  value={amount(policy.retention, decimals)}
                  sub={
                    limit === 0n
                      ? undefined
                      : `${percent(Number((retention * 10_000n) / limit))} of the limit`
                  }
                />
                <Field label="Remaining limit" value={amount(policy.remaining_limit, decimals)} />
                <Field
                  label="Payable on incident"
                  value={amount(policy.payable, decimals)}
                  emphasis
                />
                <Field
                  label="Term"
                  value={`${utcDay(policy.start_ts)} – ${utcDay(policy.end_ts)}`}
                />
                <div className="px-4 py-4">
                  <div className="label">Beneficiary</div>
                  <div className="mt-1.5 text-[14px]">
                    <Address value={policy.beneficiary} />
                  </div>
                  {policy.beneficiary === detail.protocol.treasury && (
                    <div className="mono text-[11.5px] text-dim-foreground mt-0.5">
                      the protocol's treasury
                    </div>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    )}
  </Section>
)

/* ---------------------------------------------------------------- */
/* Declaration                                                       */
/* ---------------------------------------------------------------- */

const DECLARATION_COLUMNS: Column<DeclarationEntryResponse>[] = [
  {
    label: 'Operation',
    cell: (e) => <span className="mono text-[12.5px] break-all">{operationOf(e)}</span>,
    className: 'w-[30%]',
    wide: true,
  },
  {
    label: 'Window',
    cell: (e) => <span className="mono text-[12.5px] text-muted-foreground">{windowOf(e)}</span>,
    wide: true,
  },
  {
    label: 'Submitted',
    cell: (e) => (
      <span className="mono text-[12.5px] text-muted-foreground">{utcDay(e.submitted_at)}</span>
    ),
  },
  {
    label: 'Effective from',
    cell: (e) => (
      <span className="mono text-[12.5px] text-muted-foreground">
        {utcMinute(e.effective_at)} UTC
      </span>
    ),
  },
  { label: 'Status', cell: (e) => <DeclStatus entry={e} />, className: 'w-[12%]' },
]

const Declaration = ({ protocol }: { protocol: string }) => {
  const declarations = useQuery(queries.declarations(protocol))
  return (
    <Section title="Declaration of allowed operations">
      {declarations.error ? (
        <Failure error={declarations.error} />
      ) : declarations.data === undefined ? (
        <div className="px-4">
          <Loading what="the declaration" />
        </div>
      ) : declarations.data.entries.length === 0 ? (
        <div className="px-4 py-6 mono text-[13px] text-muted-foreground">
          Nothing declared: every privileged transaction is an incident.
        </div>
      ) : (
        <DataTable
          rows={declarations.data.entries}
          columns={DECLARATION_COLUMNS}
          rowKey={(e) => e.address}
        />
      )}
      <p className="px-4 py-3 text-[12px] text-muted-foreground leading-relaxed border-t border-border">
        Widening the declaration takes effect after a delay. Narrowing or revoking it takes effect
        immediately.
      </p>
    </Section>
  )
}

const DeclStatus = ({ entry }: { entry: DeclarationEntryResponse }) => (
  <span
    className={cn(
      'mono text-[10.5px] uppercase tracking-[0.12em] px-2 py-1 rounded-sm border inline-block',
      entry.state === 'effective' && 'border-border-strong text-foreground/85',
      entry.state === 'expired' && 'border-border text-dim-foreground',
      (entry.state === 'pending' || entry.state === 'scheduled') &&
        'border-border-strong text-muted-foreground',
      entry.state === 'revoked' && 'border-alert/50 text-alert',
    )}
  >
    {ENTRY_STATE[entry.state]}
  </span>
)

/* ---------------------------------------------------------------- */
/* Incidents                                                         */
/* ---------------------------------------------------------------- */

const Incidents = ({ protocol, decimals }: { protocol: string; decimals: number }) => (
  <section id="incidents">
    <h2 className="label mb-2.5">Incident history</h2>
    <IncidentHistory
      filter={{ protocol }}
      decimals={decimals}
      empty="No incident has been opened against this protocol."
    />
  </section>
)

/* ---------------------------------------------------------------- */
/* Accounts                                                          */
/* ---------------------------------------------------------------- */

const Accounts = ({ detail }: { detail: ProtocolDetailResponse }) => {
  const { protocol, pool } = detail
  const accounts = [
    { label: 'Protocol', address: protocol.address },
    { label: 'Pool', address: pool.pool },
    { label: 'Authority', address: protocol.authority },
    { label: 'Treasury', address: protocol.treasury },
  ]
  return (
    <Section title="Accounts">
      <div className="px-4 py-4 space-y-5">
        <AddressGrid items={accounts} />
        <div>
          <div className="mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground mb-3">
            {protocol.privileged.length === 1
              ? '1 privileged address, watched by the attestors'
              : `${protocol.privileged.length} privileged addresses, watched by the attestors`}
          </div>
          <AddressGrid
            items={protocol.privileged.map((address, i) => ({
              label: `privileged ${i + 1}`,
              address,
            }))}
          />
        </div>
      </div>
    </Section>
  )
}

const AddressGrid = ({ items }: { items: { label: string; address: string }[] }) => (
  <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-2">
    {items.map((item) => (
      <div key={item.label} className="rounded-sm border border-border px-3.5 py-3">
        <div className="mono text-[10px] uppercase tracking-[0.14em] text-dim-foreground">
          {item.label}
        </div>
        <div className="text-[13px] mt-1">
          <Address value={item.address} />
        </div>
      </div>
    ))}
  </div>
)

/* ---------------------------------------------------------------- */
/* Pieces                                                            */
/* ---------------------------------------------------------------- */

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section>
    <h2 className="label mb-2.5">{title}</h2>
    <div className="panel rounded-sm overflow-hidden">{children}</div>
  </section>
)

const Field = ({
  label,
  value,
  sub,
  emphasis,
}: {
  label: string
  value: string
  sub?: string | undefined
  emphasis?: boolean
}) => (
  <div className="px-4 py-4">
    <div className="label">{label}</div>
    <div
      className={cn(
        'mono mt-1.5 tabular-nums',
        emphasis ? 'text-[17px] text-alert font-medium' : 'text-[14px]',
      )}
    >
      {value}
    </div>
    {sub && <div className="mono text-[11.5px] text-dim-foreground mt-0.5">{sub}</div>}
  </div>
)

const Meta = ({ label, value }: { label: string; value: string }) => (
  <div>
    <div className="label">{label}</div>
    <div className="mono text-[13px] mt-1 tabular-nums">{value}</div>
  </div>
)

export default ProtocolDetail
