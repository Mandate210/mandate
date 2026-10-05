import { isDemo } from '@/lib/api'
import { short } from '@/lib/format'
import { explorerUrl } from '@/lib/program'
import { cn } from '@/lib/utils'

/**
 * An account or a transaction, shortened, linking to the explorer — so every address
 * on a page can be checked against the chain in one click (SC-007). The full value is
 * in the tooltip and in what gets copied.
 *
 * Not a link in a demo build: the fixtures' addresses belong to nobody, and an explorer
 * page saying «not found» would read as the chain contradicting the page.
 */
const Address = ({
  value,
  kind = 'address',
  className,
}: {
  value: string
  kind?: 'address' | 'tx'
  className?: string
}) => {
  const classes = cn('mono tabular-nums', className)
  if (isDemo) {
    return (
      <span title={value} className={classes}>
        {short(value)}
      </span>
    )
  }
  return (
    <a
      href={explorerUrl(kind, value)}
      target="_blank"
      rel="noreferrer"
      title={value}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        classes,
        'underline underline-offset-4 decoration-border-strong hover:decoration-foreground transition-colors duration-150',
      )}
    >
      {short(value)}
    </a>
  )
}

export default Address
