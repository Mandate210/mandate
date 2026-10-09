import Pill from '@/components/Pill'
import { AsOfLine, Failure, Loading } from '@/components/QueryState'
import UtilizationBar from '@/components/UtilizationBar'
import { queries } from '@/lib/api'
import { amount, freeCapital, short } from '@/lib/format'
import { cn } from '@/lib/utils'
import { type PoolSummary, quorumNeeded } from '@mandate/shared'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'

/**
 * Every pool, as `GET /pools` has it (FR-029): capital, what policies reserved of it,
 * what is free for a new one, and how loaded it is.
 */
const Pools = () => {
  const pools = useQuery(queries.pools())
  const config = useQuery(queries.config())

  return (
    <div className="space-y-8">
      <div>
        <h1 className="mono text-[15px] uppercase tracking-[0.16em] font-medium">Cover pools</h1>
        <p className="mt-1.5 text-[13px] text-muted-foreground max-w-xl leading-relaxed">
          Parametric cover against unauthorized use of privileged admin access. The attestor vote
          that completes the quorum pays out in the same transaction — no appeal window, no human
          sign-off.
        </p>
      </div>

      {pools.error || config.error ? (
        <Failure error={pools.error ?? config.error} />
      ) : pools.data === undefined || config.data === undefined ? (
        <Loading what="pools" />
      ) : (
        <PoolList
          pools={pools.data.pools}
          decimals={config.data.asset_decimals}
          attestors={config.data.attestor_count}
          quorum={quorumNeeded(config.data.attestor_count, config.data.quorum_bps)}
        >
          <AsOfLine asOf={pools.data.as_of} />
        </PoolList>
      )}

      <p className="mono text-[11px] text-dim-foreground">
        A policy's limit can only come from capital no other policy has reserved.
      </p>
    </div>
  )
}

const sum = (pools: PoolSummary[], field: (p: PoolSummary) => string | bigint): bigint =>
  pools.reduce((total, p) => total + BigInt(field(p)), 0n)

const PoolList = ({
  pools,
  decimals,
  attestors,
  quorum,
  children,
}: {
  pools: PoolSummary[]
  decimals: number
  attestors: number
  quorum: number
  children: React.ReactNode
}) => {
  const navigate = useNavigate()
  const open = pools.reduce((n, p) => n + p.open_incidents, 0)
  const free = (p: PoolSummary) => freeCapital(p.total_assets, p.locked_limit)

  return (
    <>
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:flex sm:flex-wrap sm:gap-x-10">
        <Stat
          label="Pool capital"
          value={amount(
            sum(pools, (p) => p.total_assets),
            decimals,
          )}
        />
        <Stat
          label="Reserved"
          value={amount(
            sum(pools, (p) => p.locked_limit),
            decimals,
          )}
        />
        <Stat label="Free" value={amount(sum(pools, free), decimals)} />
        <Stat label="Open incidents" value={String(open)} alert={open > 0} />
        <Stat label="Attestor quorum" value={`${quorum} of ${attestors}`} />
      </div>

      {pools.length === 0 ? (
        <div className="panel rounded-sm px-4 py-6 mono text-[13px] text-muted-foreground">
          No protocol has a pool yet.
        </div>
      ) : (
        <>
          <div className="hidden md:block panel rounded-sm overflow-hidden">
            <table className="w-full text-left">
              <thead>
                <tr className="rule-row bg-surface-raised/60">
                  <Th className="w-[16%]">Protocol</Th>
                  <Th className="text-right">Pool capital</Th>
                  <Th className="text-right">Reserved</Th>
                  <Th className="text-right">Free</Th>
                  <Th className="w-[18%]">Utilization</Th>
                  <Th className="w-[18%]">Status</Th>
                  <Th className="w-[3%]" />
                </tr>
              </thead>
              <tbody>
                {pools.map((p) => (
                  <tr
                    key={p.protocol}
                    tabIndex={0}
                    onClick={() => navigate(`/protocol/${p.protocol}`)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        navigate(`/protocol/${p.protocol}`)
                      }
                    }}
                    className="rule-row group cursor-pointer transition-colors duration-150 hover:bg-surface-raised/70 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-[-1px]"
                  >
                    <Td>
                      <span className="mono text-[13px] font-medium" title={p.protocol}>
                        {short(p.protocol)}
                      </span>
                    </Td>
                    <Td className="mono text-right text-[13px] tabular-nums">
                      {amount(p.total_assets, decimals)}
                    </Td>
                    <Td className="mono text-right text-[13px] tabular-nums">
                      {amount(p.locked_limit, decimals)}
                    </Td>
                    <Td className="mono text-right text-[13px] tabular-nums">
                      {amount(free(p), decimals)}
                    </Td>
                    <Td>
                      <UtilizationBar bps={p.utilization_bps} />
                    </Td>
                    <Td>
                      <PoolStatus pool={p} />
                    </Td>
                    <Td>
                      <ChevronRight className="h-3.5 w-3.5 text-dim-foreground transition-colors duration-150 group-hover:text-foreground" />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="md:hidden space-y-2">
            {pools.map((p) => (
              <li key={p.protocol}>
                <Link
                  to={`/protocol/${p.protocol}`}
                  className="panel rounded-sm block px-4 py-3.5 transition-colors duration-150 hover:bg-surface-raised/70"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="mono text-[13px] font-medium" title={p.protocol}>
                      {short(p.protocol)}
                    </span>
                    <PoolStatus pool={p} />
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5">
                    <CardField label="Pool capital" value={amount(p.total_assets, decimals)} />
                    <CardField label="Reserved" value={amount(p.locked_limit, decimals)} />
                    <CardField label="Free" value={amount(free(p), decimals)} />
                    <div>
                      <dt className="label">Utilization</dt>
                      <dd className="mt-1">
                        <UtilizationBar bps={p.utilization_bps} />
                      </dd>
                    </div>
                  </dl>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      {children}
    </>
  )
}

const PoolStatus = ({ pool }: { pool: PoolSummary }) =>
  pool.open_incidents > 0 ? (
    <Pill tone="alert" pulse>
      {pool.open_incidents === 1 ? 'Incident open' : `${pool.open_incidents} incidents open`}
    </Pill>
  ) : pool.policies_in_force > 0 ? (
    <Pill tone="on">
      {pool.policies_in_force === 1
        ? 'Policy in force'
        : `${pool.policies_in_force} policies in force`}
    </Pill>
  ) : (
    <Pill tone="off">No policy in force</Pill>
  )

const Stat = ({
  label,
  value,
  alert,
}: {
  label: string
  value: string
  alert?: boolean
}) => (
  <div>
    <div className="label">{label}</div>
    <div
      className={cn('mono text-[15px] mt-1 tabular-nums', alert ? 'text-alert' : 'text-foreground')}
    >
      {value}
    </div>
  </div>
)

const CardField = ({ label, value }: { label: string; value: string }) => (
  <div>
    <dt className="label">{label}</dt>
    <dd className="mono text-[12.5px] mt-1 tabular-nums">{value}</dd>
  </div>
)

const Th = ({ children, className }: { children?: React.ReactNode; className?: string }) => (
  <th
    className={cn(
      'px-4 py-2.5 label font-normal',
      className?.includes('text-right') && 'text-right',
      className,
    )}
  >
    {children}
  </th>
)

const Td = ({ children, className }: { children?: React.ReactNode; className?: string }) => (
  <td className={cn('px-4 py-3.5 align-middle', className)}>{children}</td>
)

export default Pools
