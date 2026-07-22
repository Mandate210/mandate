import { type DeclarationEntry, INCIDENT, getProtocol, usdc } from '@/lib/mockData'
import { useScenario } from '@/lib/scenario'
import { cn } from '@/lib/utils'
import { ArrowLeft } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'

const ProtocolDetail = () => {
  const { id } = useParams()
  const protocol = getProtocol(id)
  const { status } = useScenario()

  if (!protocol) {
    return (
      <div className="mono text-[13px] text-muted-foreground">
        Unknown protocol.{' '}
        <Link to="/" className="text-foreground underline underline-offset-4">
          Back to pools
        </Link>
      </div>
    )
  }

  const c = protocol.coverage
  const hasPolicy = protocol.policyStatus === 'active'
  const incidentHere = protocol.id === INCIDENT.protocolId && status !== 'idle'

  return (
    <div className="space-y-8">
      <div>
        <Link
          to="/"
          className="mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground hover:text-foreground transition-colors duration-150 inline-flex items-center gap-1.5"
        >
          <ArrowLeft className="h-3 w-3" /> Pools
        </Link>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
          <h1 className="text-[22px] font-medium tracking-tight">{protocol.name}</h1>
          <div className="flex items-center gap-8">
            <Meta label="Pool capital" value={usdc(protocol.poolCapital)} />
            <Meta label="Utilization" value={`${protocol.utilization}%`} />
            <Meta
              label="Attestor set"
              value={`${protocol.quorum} of ${protocol.attestors} quorum`}
            />
          </div>
        </div>
      </div>

      {incidentHere && (
        <Link
          to={`/incident/${INCIDENT.id}`}
          className="block panel rounded-sm border-alert/40 bg-alert-soft/40 px-4 py-3 transition-colors duration-150 hover:bg-alert-soft/70"
        >
          <div className="flex flex-wrap items-center gap-3">
            <span className="h-1.5 w-1.5 rounded-full bg-alert animate-pulse-alert" />
            <span className="mono text-[11px] uppercase tracking-[0.14em] text-alert">
              {status === 'running'
                ? `Incident ${INCIDENT.id} open`
                : `Incident ${INCIDENT.id} settled — payout released`}
            </span>
            <span className="mono text-[11px] text-muted-foreground">
              trigger {INCIDENT.triggerSignature}
            </span>
          </div>
        </Link>
      )}

      {/* Coverage */}
      <Section title="Coverage">
        {hasPolicy ? (
          <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-5 divide-y md:divide-y-0 md:divide-x divide-border">
            <Field label="Policy limit" value={usdc(c.limit)} />
            <Field
              label="Protocol retention"
              value={`${c.retentionPct}%`}
              sub={usdc(c.retentionAmount)}
            />
            <Field label="Payable on incident" value={usdc(c.payable)} emphasis />
            <Field label="Term" value={c.term} />
            <Field label="Beneficiary" value={c.beneficiary} sub="protocol treasury" />
          </div>
        ) : (
          <div className="px-4 py-6">
            <div className="mono text-[13px] text-muted-foreground">
              No active policy. Pool capital is staked but no coverage has been written.
            </div>
            <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-6">
              <Inline label="Policy limit" value="0 USDC" />
              <Inline label="Payable on incident" value="0 USDC" />
              <Inline label="Term" value="—" />
              <Inline label="Beneficiary" value={c.beneficiary} />
            </div>
          </div>
        )}
      </Section>

      {/* Declaration */}
      <Section title="Declaration of allowed operations">
        <table className="w-full text-left">
          <thead>
            <tr className="rule-row bg-surface-raised/60">
              <th className="px-4 py-2.5 label font-normal w-[32%]">Operation</th>
              <th className="px-4 py-2.5 label font-normal w-[24%]">Window</th>
              <th className="px-4 py-2.5 label font-normal">Submitted</th>
              <th className="px-4 py-2.5 label font-normal">Effective from</th>
              <th className="px-4 py-2.5 label font-normal w-[14%]">Status</th>
            </tr>
          </thead>
          <tbody>
            {protocol.declaration.map((d) => (
              <tr key={d.operation} className="rule-row">
                <td className="px-4 py-3 text-[13px]">{d.operation}</td>
                <td className="px-4 py-3 mono text-[12.5px] text-muted-foreground">{d.window}</td>
                <td className="px-4 py-3 mono text-[12.5px] text-muted-foreground tabular-nums">
                  {d.submitted}
                </td>
                <td className="px-4 py-3 mono text-[12.5px] text-muted-foreground tabular-nums">
                  {d.effectiveFrom}
                </td>
                <td className="px-4 py-3">
                  <DeclStatus status={d.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="px-4 py-3 text-[12px] text-muted-foreground leading-relaxed">
          Widening the declaration takes effect after a delay. Narrowing or revoking it takes effect
          immediately.
        </p>
      </Section>

      {/* Privileged addresses */}
      <Section title="Privileged addresses">
        <div className="px-4 py-4">
          <div className="mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground mb-3">
            Security Council — 5 signers
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-px bg-border rounded-sm overflow-hidden">
            {protocol.signers.map((s) => (
              <div key={s.label} className="bg-surface px-3.5 py-3">
                <div className="mono text-[10px] uppercase tracking-[0.14em] text-dim-foreground">
                  {s.label}
                </div>
                <div className="mono text-[13px] mt-1">{s.address}</div>
              </div>
            ))}
          </div>
        </div>
      </Section>
    </div>
  )
}

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
  sub?: string
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

const Inline = ({ label, value }: { label: string; value: string }) => (
  <div>
    <div className="label">{label}</div>
    <div className="mono text-[13px] mt-1 text-muted-foreground">{value}</div>
  </div>
)

const Meta = ({ label, value }: { label: string; value: string }) => (
  <div>
    <div className="label">{label}</div>
    <div className="mono text-[13px] mt-1 tabular-nums">{value}</div>
  </div>
)

const DeclStatus = ({ status }: { status: DeclarationEntry['status'] }) => (
  <span
    className={cn(
      'mono text-[10.5px] uppercase tracking-[0.12em] px-2 py-1 rounded-sm border inline-block',
      status === 'Effective' && 'border-border-strong text-foreground/85',
      status === 'Spent' && 'border-border text-dim-foreground',
      status === 'Pending' && 'border-border-strong text-muted-foreground',
      status === 'Revoked' && 'border-alert/50 text-alert',
    )}
  >
    {status}
  </span>
)

export default ProtocolDetail
