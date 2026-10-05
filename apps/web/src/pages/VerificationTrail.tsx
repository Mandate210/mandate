import Address from '@/components/Address'
import DataTable from '@/components/DataTable'
import { IncidentStatus } from '@/components/IncidentHistory'
import { AsOfLine, Failure, Loading } from '@/components/QueryState'
import { ApiError, isDemo, queries } from '@/lib/api'
import { ENTRY_STATE, amount, operationOf, short, utcSecond, windowOf } from '@/lib/format'
import { clockOf, settlementDelay, timelineOf } from '@/lib/incident'
import { cn } from '@/lib/utils'
import type { IncidentDetailResponse } from '@mandate/shared'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'

/**
 * Every input the decision depended on, so a third party can repeat it from an RPC
 * without this API (FR-011, FR-030, SC-007). «Copy all as JSON» hands over the response
 * exactly as `GET /incidents/:pubkey` returns it, full addresses and signatures included;
 * the abbreviations are for the screen only.
 */
const VerificationTrail = () => {
  const { id = '' } = useParams()
  const detail = useQuery(queries.incident(id))
  const config = useQuery(queries.config())

  const back = (
    <Link
      to={`/incident/${id}`}
      className="mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground hover:text-foreground transition-colors duration-150 inline-flex items-center gap-1.5"
    >
      <ArrowLeft className="h-3 w-3" /> Incident {short(id)}
    </Link>
  )

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
        <Loading what="the trail" />
      </div>
    )
  }
  return <Trail back={back} detail={detail.data} decimals={config.data.asset_decimals} />
}

const Trail = ({
  back,
  detail,
  decimals,
}: {
  back: React.ReactNode
  detail: IncidentDetailResponse
  decimals: number
}) => {
  const { incident, trigger, payout, verification } = detail
  const { origin, from } = clockOf(detail)
  const delay = settlementDelay(timelineOf(detail))
  const absent = incident.set_size - detail.attestations.length
  const sinceOrigin = (at: number) =>
    `T+${at - origin} s${from === 'opening' ? ' after the opening' : ''}`

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          {back}
          <h1 className="mt-3 mono text-[15px] uppercase tracking-[0.16em] font-medium">
            Verification trail
          </h1>
          <p className="mt-1.5 text-[13px] text-muted-foreground max-w-2xl leading-relaxed">
            Every input the decision depended on, listed so a third party can check it independently
            against the chain.
          </p>
        </div>
        <CopyJson detail={detail} />
      </div>

      {/* 1 — trigger */}
      <Section index="01" title="Trigger transaction">
        <Row label="Signature">
          <Address value={trigger.signature} kind="tx" />
        </Row>
        <Row label="Slot">{trigger.slot === null ? '—' : trigger.slot.toLocaleString('en-US')}</Row>
        <Row label="Block time">
          {trigger.block_time === null
            ? 'the RPC no longer returns this transaction'
            : utcSecond(trigger.block_time)}
        </Row>
        <Row label="Incident opened by">
          <Address value={incident.opener} />
          {detail.opened.signature !== null && (
            <>
              {' '}
              in <Address value={detail.opened.signature} kind="tx" />
            </>
          )}{' '}
          · {utcSecond(detail.opened.at)}
        </Row>
        <Row label="Opening bond">{amount(incident.bond, decimals)}</Row>
      </Section>

      {/* 2 — declaration snapshot */}
      <Section index="02" title="Declaration as it stood at the trigger" flush>
        <p className="px-4 py-3 text-[12px] text-muted-foreground border-b border-border">
          {verification.declaration_at_trigger.evaluated_at === null
            ? 'The trigger’s block time is unknown, so the states below cannot be pinned to it.'
            : `Entry states evaluated at ${utcSecond(verification.declaration_at_trigger.evaluated_at)} by the rule every attestor applies.`}
        </p>
        {verification.declaration_at_trigger.entries.length === 0 ? (
          <p className="px-4 py-4 mono text-[12.5px] text-muted-foreground">
            The protocol had declared no operation — no privileged transaction was covered by a
            declaration.
          </p>
        ) : (
          <DataTable
            rows={verification.declaration_at_trigger.entries}
            rowKey={(e) => e.address}
            columns={[
              { label: 'Operation', cell: (e) => operationOf(e), wide: true },
              {
                label: 'Window',
                cell: (e) => (
                  <span className="mono text-[12.5px] text-muted-foreground">{windowOf(e)}</span>
                ),
                wide: true,
              },
              {
                label: 'Effective from',
                cell: (e) => (
                  <span className="mono text-[12.5px] text-muted-foreground tabular-nums">
                    {utcSecond(e.effective_at)}
                  </span>
                ),
              },
              {
                label: 'At the trigger',
                cell: (e) => (
                  <span className="mono text-[12.5px] text-muted-foreground">
                    {ENTRY_STATE[e.state]}
                  </span>
                ),
              },
              { label: 'Entry', cell: (e) => <Address value={e.address} /> },
            ]}
          />
        )}
      </Section>

      {/* 3 — attestations */}
      <Section
        index="03"
        title={`Attestations — ${detail.attestations.length} of ${incident.set_size}`}
        flush
      >
        {detail.attestations.length === 0 ? (
          <p className="px-4 py-4 mono text-[12.5px] text-muted-foreground">
            No attestation has been recorded.
          </p>
        ) : (
          <DataTable
            rows={detail.attestations}
            rowKey={(a) => a.attestation}
            columns={[
              { label: 'Attestor', cell: (a) => <Address value={a.attestor} /> },
              {
                label: 'Verdict',
                cell: (a) => (
                  <span
                    className={cn(
                      'mono text-[13px]',
                      a.verdict === 'unauthorized' ? 'text-alert' : 'text-ok',
                    )}
                  >
                    {a.verdict === 'unauthorized' ? '✗ unauthorized' : '✓ authorized'}
                  </span>
                ),
              },
              {
                label: 'Submitted',
                cell: (a) => (
                  <span className="mono text-[12.5px] text-muted-foreground tabular-nums">
                    {utcSecond(a.submitted_at)} · {sinceOrigin(a.submitted_at)}
                  </span>
                ),
                wide: true,
              },
              { label: 'Account', cell: (a) => <Address value={a.attestation} /> },
              {
                label: 'Transaction',
                cell: (a) =>
                  a.signature === null ? (
                    <span className="mono text-[12.5px] text-dim-foreground">not indexed yet</span>
                  ) : (
                    <Address value={a.signature} kind="tx" />
                  ),
              },
            ]}
          />
        )}
        {absent > 0 && (
          <p className="px-4 py-3 text-[12px] text-muted-foreground border-t border-border">
            {absent} of {incident.set_size} attestors{' '}
            {incident.status === 'open' ? 'have not attested yet' : 'did not attest'}. A
            non-responding attestor neither blocks nor delays the quorum.
          </p>
        )}
      </Section>

      {/* 4 — decision */}
      <Section index="04" title="Decision">
        <Row label="Status">
          <IncidentStatus status={incident.status} />
        </Row>
        <Row label="Quorum rule">
          {incident.quorum_needed} unauthorized of {incident.set_size} — the set as it stood when
          the incident opened
        </Row>
        <Row label="Votes" alert={incident.votes_unauthorized >= incident.quorum_needed}>
          {incident.votes_unauthorized} unauthorized · {incident.votes_authorized} authorized
        </Row>
        <Row label="Attestation window">
          {utcSecond(incident.opened_at)} – {utcSecond(incident.deadline)}
        </Row>
      </Section>

      {/* 5 — payout */}
      <Section index="05" title="Payout">
        {payout === null ? (
          <Row label="Payout">
            {incident.status === 'open'
              ? 'none yet — the incident is open'
              : 'none — the window closed without a payable quorum'}
          </Row>
        ) : (
          <>
            <Row label="Transaction">
              <Address value={payout.signature} kind="tx" />
            </Row>
            <Row label="Amount" alert>
              {amount(payout.amount, decimals)}
            </Row>
            {BigInt(incident.shortfall) > 0n && (
              <Row label="Shortfall">
                {amount(incident.shortfall, decimals)} — the pool could not pay it; the policy keeps
                it
              </Row>
            )}
            <Row label="Beneficiary">
              <Address value={payout.beneficiary} /> — fixed by the policy when it was issued
            </Row>
            <Row label="Timestamp">
              {utcSecond(payout.at)} · {sinceOrigin(payout.at)}
            </Row>
            <Row label="Instruction">
              resolve — permissionless, sent{delay === null ? '' : ` ${delay} s`} after the
              attestation that completed the quorum; no appeal window
            </Row>
          </>
        )}
      </Section>

      {/* 6 — accounts */}
      <Section index="06" title="Accounts the decision read">
        <Row label="Program">
          <Address value={verification.program_id} />
        </Row>
        {Object.entries(verification.accounts).map(([label, address]) => (
          <Row key={label} label={label[0]?.toUpperCase() + label.slice(1)}>
            <Address value={address} />
          </Row>
        ))}
      </Section>

      <AsOfLine asOf={detail.as_of} />
    </div>
  )
}

const CopyJson = ({ detail }: { detail: IncidentDetailResponse }) => {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    const body = isDemo
      ? {
          note: 'Demo — invented data in the shape of the public API. Nothing here exists on chain.',
          ...detail,
        }
      : detail
    const text = JSON.stringify(body, null, 2)
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

  return (
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
  alert,
  children,
}: {
  label: string
  alert?: boolean
  children: React.ReactNode
}) => (
  <div className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-6 py-2.5 border-b border-border last:border-b-0">
    <span className="label sm:w-[200px] shrink-0">{label}</span>
    <span
      className={cn('mono text-[13px] break-words', alert ? 'text-alert' : 'text-foreground/90')}
    >
      {children}
    </span>
  </div>
)

export default VerificationTrail
