import { cn } from '@/lib/utils'

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
      'mono text-[10.5px] uppercase tracking-[0.12em] px-2 py-1 rounded-sm border inline-flex items-center gap-1.5 whitespace-nowrap',
      tone === 'on' && 'border-border-strong text-foreground/80',
      tone === 'off' && 'border-border text-dim-foreground',
      tone === 'alert' && 'border-alert/50 bg-alert-soft text-alert',
      pulse && 'animate-pulse-alert',
    )}
  >
    {children}
  </span>
)

export default Pill
