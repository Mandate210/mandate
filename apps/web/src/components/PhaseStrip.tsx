import { type IncidentEvent, type Milestone, labelSlots, sinceLabel } from '@/lib/incident'
import { cn } from '@/lib/utils'
import { useLayoutEffect, useRef, useState } from 'react'

const NAME: Record<Milestone['kind'], string> = {
  trigger: 'trigger',
  opened: 'opened',
  quorum: 'quorum',
  paid: 'paid out',
  decided: 'quorum · paid',
  closed: 'window closed',
}

/** Wide enough for the longest name in `label` type; the layout keeps labels this far apart. */
const LABEL_WIDTH = 116
const ROW_HEIGHT = 40
const TRACK = 5

/**
 * The incident on one axis, to scale (T058): every attestation as a tick, the moments
 * that matter named, and how far the clock has run — the counter's number given a
 * shape. It repeats what the timeline below lists, so it is hidden from screen readers.
 */
const PhaseStrip = ({
  events,
  milestones,
  span,
  elapsed,
  live,
}: {
  events: IncidentEvent[]
  milestones: Milestone[]
  /** Seconds the axis covers. */
  span: number
  /** Seconds the clock has run: live, replayed, or the whole record. */
  elapsed: number
  live: boolean
}) => {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const x = (t: number) => (Math.min(Math.max(t, 0), span) / Math.max(span, 1)) * width
  const slots = labelSlots(
    milestones.map((m) => x(m.t)),
    width,
    LABEL_WIDTH,
  )
  const rows = Math.max(1, ...slots.map((s) => s.row + 1))

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="relative w-full"
      style={{ height: TRACK * 2 + 6 + rows * ROW_HEIGHT }}
    >
      {width > 0 && (
        <>
          <div className="absolute inset-x-0 h-px bg-border-strong" style={{ top: TRACK }} />
          <div
            className="absolute left-0 h-[3px] -translate-y-px bg-muted-foreground/60"
            style={{ top: TRACK, width: x(elapsed) }}
          />
          {live && (
            <span
              className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground animate-pulse-alert"
              style={{ top: TRACK + 0.5, left: x(elapsed) }}
            />
          )}

          {events.map((e) =>
            e.kind === 'attestation' ? (
              <span
                key={`tick-${e.attestor}`}
                className={cn(
                  'absolute top-0 w-[2px] h-[11px] -translate-x-1/2 transition-opacity duration-150',
                  e.verdict === 'unauthorized' ? 'bg-alert' : 'bg-ok',
                  e.t > elapsed && 'opacity-25',
                )}
                style={{ left: x(e.t) }}
              />
            ) : null,
          )}

          {milestones.map((m, i) => {
            const slot = slots[i] ?? { row: 0, align: 'start' }
            const at = x(m.t)
            const reached = m.t <= elapsed
            const money = m.kind === 'paid' || m.kind === 'decided'
            const top = TRACK * 2 + 6 + slot.row * ROW_HEIGHT
            return (
              <div key={m.kind}>
                {slot.row > 0 && (
                  <span
                    className="absolute w-px bg-border"
                    style={{ left: at, top: TRACK, height: top - TRACK }}
                  />
                )}
                <span
                  className={cn(
                    'absolute h-[9px] w-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full border transition-colors duration-150',
                    !reached
                      ? 'border-border-strong bg-surface'
                      : money
                        ? 'border-alert bg-alert'
                        : m.kind === 'closed'
                          ? 'border-dim-foreground bg-dim-foreground'
                          : 'border-foreground bg-foreground',
                  )}
                  style={{ top: TRACK + 0.5, left: at }}
                />
                <div
                  className={cn(
                    'absolute whitespace-nowrap transition-colors duration-150',
                    slot.align === 'end' ? 'text-right' : 'text-left',
                  )}
                  style={{
                    top,
                    left: slot.align === 'start' ? at : at - LABEL_WIDTH,
                    width: LABEL_WIDTH,
                  }}
                >
                  <div
                    className={cn(
                      'mono text-[12px] tabular-nums',
                      !reached ? 'text-dim-foreground' : money ? 'text-alert' : 'text-foreground',
                    )}
                  >
                    {sinceLabel(m.t)}
                  </div>
                  <div className={cn('label mt-0.5', !reached && 'text-dim-foreground')}>
                    {NAME[m.kind]}
                  </div>
                </div>
              </div>
            )
          })}
        </>
      )}
    </div>
  )
}

export default PhaseStrip
