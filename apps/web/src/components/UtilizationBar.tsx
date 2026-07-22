import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

const UtilizationBar = ({ value }: { value: number }) => {
  const warning = value > 80

  const bar = (
    <div className="flex items-center gap-3 w-full max-w-[180px]">
      <div className="h-1.5 flex-1 bg-surface-raised rounded-full overflow-hidden">
        <div
          className={cn(
            'h-full rounded-full transition-all duration-500',
            warning ? 'bg-alert' : 'bg-foreground/55',
          )}
          style={{ width: `${Math.max(value, 0)}%` }}
        />
      </div>
      <span
        className={cn(
          'mono text-[12px] tabular-nums w-9 text-right',
          warning ? 'text-alert' : 'text-muted-foreground',
        )}
      >
        {value}%
      </span>
    </div>
  )

  if (!warning) return bar

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
          Pool nearly exhausted — no new policies accepted
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export default UtilizationBar
