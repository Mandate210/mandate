import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

export interface Column<T> {
  label: string
  cell: (row: T) => ReactNode
  /** Classes for the column on wide screens: width, alignment. */
  className?: string
  /** Takes the whole width of a card on narrow screens. */
  wide?: boolean
}

/**
 * A table from `md` up, a card per row below it — the same fields either way, so a
 * phone shows everything a desktop does and nothing scrolls sideways.
 */
const DataTable = <T,>({
  rows,
  columns,
  rowKey,
}: {
  rows: T[]
  columns: Column<T>[]
  rowKey: (row: T) => string
}) => (
  <>
    <table className="hidden md:table w-full text-left">
      <thead>
        <tr className="rule-row bg-surface-raised/60">
          {columns.map((c) => (
            <th key={c.label} className={cn('px-4 py-2.5 label font-normal', c.className)}>
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={rowKey(row)} className="rule-row">
            {columns.map((c) => (
              <td key={c.label} className={cn('px-4 py-3 text-[13px] align-middle', c.className)}>
                {c.cell(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>

    <ul className="md:hidden divide-y divide-border">
      {rows.map((row) => (
        <li key={rowKey(row)} className="px-4 py-3.5">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
            {columns.map((c) => (
              <div key={c.label} className={cn('min-w-0', c.wide && 'col-span-2')}>
                <dt className="label">{c.label}</dt>
                <dd className="mt-1 text-[13px] break-words">{c.cell(row)}</dd>
              </div>
            ))}
          </dl>
        </li>
      ))}
    </ul>
  </>
)

export default DataTable
