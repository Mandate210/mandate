import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { percent } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * `utilization_bps` as a bar. No threshold of ours colours it: the program has none —
 * a new policy's limit has to fit in free capital (FR-027), whatever the ratio. The one
 * state worth alarm is above 100%, a pool that reserved more than it holds, which the
 * program is meant to make impossible and the contract leaves uncapped so it shows.
 */
const UtilizationBar = ({ bps }: { bps: number }) => {
  const overPromised = bps > 10_000

  const bar = (
    <div className="flex items-center gap-3 w-full max-w-[180px]">
      <div className="h-1.5 flex-1 bg-surface-raised rounded-full overflow-hidden">
        <div
          className={cn(
            'h-full rounded-full transition-all duration-500',
            overPromised ? 'bg-alert' : 'bg-foreground/55',
          )}
          style={{ width: `${Math.min(bps / 100, 100)}%` }}
        />
      </div>
      <span
        className={cn(
          'mono text-[12px] tabular-nums min-w-12 text-right',
          overPromised ? 'text-alert' : 'text-muted-foreground',
        )}
      >
        {percent(bps)}
      </span>
    </div>
  )

  if (!overPromised) return bar

  return (
    <TooltipProvider delayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="cursor-help w-full max-w-[180px]">{bar}</div>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          className="bg-surface-raised border-border-strong mono text-[11px]"
        >
          Reserved limits exceed the pool's assets
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export default UtilizationBar
