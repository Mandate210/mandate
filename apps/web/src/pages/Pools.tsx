import UtilizationBar from '@/components/UtilizationBar'
import { INCIDENT, PROTOCOLS, usdc } from '@/lib/mockData'
import { useScenario } from '@/lib/scenario'
import { cn } from '@/lib/utils'
import { ChevronRight } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

const Pools = () => {
  const navigate = useNavigate()
  const { status } = useScenario()

  const totalCapital = PROTOCOLS.reduce((s, p) => s + p.poolCapital, 0)
  const totalCoverage = PROTOCOLS.reduce((s, p) => s + p.activeCoverage, 0)

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <h1 className="mono text-[15px] uppercase tracking-[0.16em] font-medium">Cover pools</h1>
          <p className="mt-1.5 text-[13px] text-muted-foreground max-w-xl leading-relaxed">
            Parametric cover against unauthorized use of privileged admin access. Payout is released
            by the transaction that records the attestor quorum.
          </p>
        </div>
        <div className="flex gap-10">
          <Stat label="Pool capital" value={usdc(totalCapital)} />
          <Stat label="Active coverage" value={usdc(totalCoverage)} />
          <Stat
            label="Open incidents"
            value={status === 'running' ? '1' : '0'}
            alert={status === 'running'}
          />
        </div>
      </div>

      <div className="panel rounded-sm overflow-hidden">
        <table className="w-full text-left">
          <thead>
            <tr className="rule-row bg-surface-raised/60">
              <Th className="w-[22%]">Protocol</Th>
              <Th className="text-right">Pool capital</Th>
              <Th className="text-right">Active coverage</Th>
              <Th className="w-[20%]">Utilization</Th>
              <Th className="text-right w-[9%]">Attestors</Th>
              <Th className="w-[18%]">Status</Th>
              <Th className="w-[3%]" />
            </tr>
          </thead>
          <tbody>
            {PROTOCOLS.map((p) => {
              const settled = status === 'settled' && p.id === INCIDENT.protocolId
              const open = status === 'running' && p.id === INCIDENT.protocolId
              return (
                <tr
                  key={p.id}
                  tabIndex={0}
                  onClick={() => navigate(`/protocol/${p.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      navigate(`/protocol/${p.id}`)
                    }
                  }}
                  className="rule-row group cursor-pointer transition-colors duration-150 hover:bg-surface-raised/70 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-[-1px]"
                >
                  <Td>
                    <span className="text-[13.5px] font-medium">{p.name}</span>
                    <div className="mono text-[10.5px] text-dim-foreground mt-0.5">
                      {p.coverage.beneficiary}
                    </div>
                  </Td>
                  <Td className="mono text-right text-[13px] tabular-nums">
                    {usdc(p.poolCapital)}
                  </Td>
                  <Td className="mono text-right text-[13px] tabular-nums">
                    {usdc(p.activeCoverage)}
                  </Td>
                  <Td>
                    <UtilizationBar value={p.utilization} />
                  </Td>
                  <Td className="mono text-right text-[13px] tabular-nums text-muted-foreground">
                    {p.attestors}
                  </Td>
                  <Td>
                    {open ? (
                      <Pill tone="alert" pulse>
                        Incident open
                      </Pill>
                    ) : settled ? (
                      <Pill tone="alert">Payout released</Pill>
                    ) : p.policyStatus === 'active' ? (
                      <Pill tone="on">Active policy</Pill>
                    ) : (
                      <Pill tone="off">No policy</Pill>
                    )}
                  </Td>
                  <Td>
                    <ChevronRight className="h-3.5 w-3.5 text-dim-foreground transition-colors duration-150 group-hover:text-foreground" />
                  </Td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <p className="mono text-[11px] text-dim-foreground">
        Utilization above 80% suspends acceptance of new policies for that pool.
      </p>
    </div>
  )
}

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

const Pill = ({
  children,
  tone,
  pulse,
}: {
  children: React.ReactNode
  tone: 'on' | 'off' | 'alert'
  pulse?: boolean
}) => (
  <span
    className={cn(
      'mono text-[10.5px] uppercase tracking-[0.12em] px-2 py-1 rounded-sm border inline-flex items-center gap-1.5',
      tone === 'on' && 'border-border-strong text-foreground/80',
      tone === 'off' && 'border-border text-dim-foreground',
      tone === 'alert' && 'border-alert/50 bg-alert-soft text-alert',
      pulse && 'animate-pulse-alert',
    )}
  >
    {children}
  </span>
)

export default Pools
