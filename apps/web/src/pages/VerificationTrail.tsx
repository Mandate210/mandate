import { ATTESTATIONS, ATTESTOR_SET, DECLARATION_SNAPSHOT, INCIDENT, usdc } from '@/lib/mockData'
import { cn } from '@/lib/utils'
import { ArrowLeft, Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

const buildJson = () => ({
  incident_id: INCIDENT.id,
  protocol: INCIDENT.protocolName,
  opened_at: INCIDENT.openedAt,
  quorum_rule: {
    required: INCIDENT.quorumRequired,
    attestor_set_size: INCIDENT.attestorSetSize,
    attestor_set: ATTESTOR_SET,
    acceptance_window_seconds: INCIDENT.acceptanceWindow,
  },
  trigger_transaction: {
    signature: INCIDENT.triggerSignature,
    timestamp: INCIDENT.openedAt,
    observations: [
      'signer 3 of 5',
      'durable nonce',
      'outside maintenance window',
      'matches no effective declaration entry',
    ],
  },
  declaration_snapshot: DECLARATION_SNAPSHOT,
  attestations: ATTESTATIONS.map((a) => ({
    attestor: a.attestor,
    verdict: a.verdict,
    timestamp: a.timestamp,
    signature: a.signature,
  })),
  non_responding_attestors: ATTESTOR_SET.filter((a) => !ATTESTATIONS.some((x) => x.attestor === a)),
  payout: {
    signature: INCIDENT.payoutSignature,
    amount: `${INCIDENT.payoutAmount} USDC`,
    beneficiary: INCIDENT.beneficiary,
    beneficiary_label: INCIDENT.beneficiaryLabel,
    settled_at: `T+${INCIDENT.settledAt}s`,
    timestamp: '2026-08-11 09:14:24 UTC',
  },
  note: 'Demo — mock data. Addresses and signatures are truncated placeholders.',
})

const VerificationTrail = () => {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    const text = JSON.stringify(buildJson(), null, 2)
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
  }

  const absent = ATTESTOR_SET.filter((a) => !ATTESTATIONS.some((x) => x.attestor === a))

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link
            to={`/incident/${INCIDENT.id}`}
            className="mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground hover:text-foreground transition-colors duration-150 inline-flex items-center gap-1.5"
          >
            <ArrowLeft className="h-3 w-3" /> Incident {INCIDENT.id}
          </Link>
          <h1 className="mt-3 mono text-[15px] uppercase tracking-[0.16em] font-medium">
            Verification trail
          </h1>
          <p className="mt-1.5 text-[13px] text-muted-foreground max-w-2xl leading-relaxed">
            Every input the payout depended on, listed so a third party can check it independently.
          </p>
        </div>
        <button
          type="button"
          onClick={copy}
          className={cn(
            'mono text-[11px] uppercase tracking-[0.14em] inline-flex items-center gap-2 px-3.5 h-8 rounded-sm border transition-colors duration-150',
            copied
              ? 'border-alert/60 bg-alert-soft text-alert'
              : 'border-border-strong text-muted-foreground hover:text-foreground hover:border-foreground/40',
          )}
        >
          {copied ? (
            <>
              <Check className="h-3 w-3" strokeWidth={2.5} /> Copied
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" strokeWidth={2.5} /> Copy all as JSON
            </>
          )}
        </button>
      </div>

      {/* 1 — trigger */}
      <Section index="01" title="Trigger transaction">
        <Row label="Signature" value={INCIDENT.triggerSignature} />
        <Row label="Timestamp" value={INCIDENT.openedAt} />
        <Row label="Signers" value="3 of 5 Security Council" />
        <Row label="Nonce" value="durable nonce" />
        <Row label="Maintenance window" value="outside declared window" alert />
        <Row label="Declaration match" value="no effective entry matched" alert />
      </Section>

      {/* 2 — declaration snapshot */}
      <Section index="02" title="Declaration entries effective when the incident opened" flush>
        <table className="w-full text-left">
          <thead>
            <tr className="rule-row bg-surface-raised/60">
              <th className="px-4 py-2.5 label font-normal w-[34%]">Operation</th>
              <th className="px-4 py-2.5 label font-normal w-[24%]">Window</th>
              <th className="px-4 py-2.5 label font-normal w-[18%]">Effective from</th>
              <th className="px-4 py-2.5 label font-normal">Status at snapshot</th>
            </tr>
          </thead>
          <tbody>
            {DECLARATION_SNAPSHOT.map((d) => (
              <tr key={d.operation} className="rule-row">
                <td className="px-4 py-3 text-[13px]">{d.operation}</td>
                <td className="px-4 py-3 mono text-[12.5px] text-muted-foreground">{d.window}</td>
                <td className="px-4 py-3 mono text-[12.5px] text-muted-foreground tabular-nums">
                  {d.effectiveFrom}
                </td>
                <td className="px-4 py-3 mono text-[12.5px] text-muted-foreground">{d.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {/* 3 — attestations */}
      <Section index="03" title={`Attestations — ${ATTESTATIONS.length} recorded`} flush>
        <table className="w-full text-left">
          <thead>
            <tr className="rule-row bg-surface-raised/60">
              <th className="px-4 py-2.5 label font-normal w-[18%]">Attestor</th>
              <th className="px-4 py-2.5 label font-normal w-[20%]">Verdict</th>
              <th className="px-4 py-2.5 label font-normal w-[28%]">Timestamp</th>
              <th className="px-4 py-2.5 label font-normal">Transaction</th>
            </tr>
          </thead>
          <tbody>
            {ATTESTATIONS.map((a) => (
              <tr key={a.id} className="rule-row">
                <td className="px-4 py-3 mono text-[13px]">{a.attestor}</td>
                <td
                  className={cn(
                    'px-4 py-3 mono text-[13px]',
                    a.verdict === 'unauthorized' ? 'text-alert' : 'text-ok',
                  )}
                >
                  {a.verdict === 'unauthorized' ? '✗ unauthorized' : '✓ authorized'}
                </td>
                <td className="px-4 py-3 mono text-[12.5px] text-muted-foreground tabular-nums">
                  {a.timestamp}
                </td>
                <td className="px-4 py-3 mono text-[12.5px] text-muted-foreground">
                  {a.signature}
                </td>
              </tr>
            ))}
            {absent.map((a) => (
              <tr key={a} className="rule-row">
                <td className="px-4 py-3 mono text-[13px] text-dim-foreground">{a}</td>
                <td className="px-4 py-3 mono text-[13px] text-dim-foreground">— no attestation</td>
                <td className="px-4 py-3 mono text-[12.5px] text-dim-foreground">—</td>
                <td className="px-4 py-3 mono text-[12.5px] text-dim-foreground">—</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="px-4 py-3 text-[12px] text-muted-foreground">
          A non-responding attestor neither blocks nor delays the quorum.
        </p>
      </Section>

      {/* 4 — payout */}
      <Section index="04" title="Payout">
        <Row label="Transaction" value={INCIDENT.payoutSignature} />
        <Row label="Amount" value={usdc(INCIDENT.payoutAmount)} alert />
        <Row label="Beneficiary" value={`${INCIDENT.beneficiary} · ${INCIDENT.beneficiaryLabel}`} />
        <Row label="Timestamp" value="2026-08-11 09:14:24 UTC" />
        <Row label="Relation to quorum" value="same transaction that recorded the quorum" />
      </Section>

      {/* 5 — quorum rule */}
      <Section index="05" title="Quorum rule in force at that moment">
        <Row label="Rule" value={`${INCIDENT.quorumRequired} of ${INCIDENT.attestorSetSize}`} />
        <Row label="Attestor set" value={ATTESTOR_SET.join(', ')} />
        <Row label="Acceptance window" value={`T+0s … T+${INCIDENT.acceptanceWindow}s`} />
        <Row label="Opening bond" value={usdc(INCIDENT.bond)} />
        <Row label="Settled at" value={`T+${INCIDENT.settledAt}s`} alert />
      </Section>
    </div>
  )
}

const Section = ({
  index,
  title,
  children,
  flush,
}: {
  index: string
  title: string
  children: React.ReactNode
  flush?: boolean
}) => (
  <section>
    <h2 className="label mb-2.5 flex items-center gap-2">
      <span className="text-dim-foreground">{index}</span>
      <span>{title}</span>
    </h2>
    <div className={cn('panel rounded-sm overflow-hidden', !flush && 'px-4 py-1')}>{children}</div>
  </section>
)

const Row = ({
  label,
  value,
  alert,
}: {
  label: string
  value: string
  alert?: boolean
}) => (
  <div className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-6 py-2.5 border-b border-border last:border-b-0">
    <span className="label sm:w-[200px] shrink-0">{label}</span>
    <span className={cn('mono text-[13px] break-all', alert ? 'text-alert' : 'text-foreground/90')}>
      {value}
    </span>
  </div>
)

export default VerificationTrail
