import DemoNotice from '@/components/DemoNotice'
import { isDemo, queries } from '@/lib/api'
import { PROGRAM_EXPLORER } from '@/lib/program'
import { cn } from '@/lib/utils'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Link, NavLink } from 'react-router-dom'

const NAV = [
  { to: '/', label: 'Pools', end: true },
  { to: '/incidents', label: 'Incidents', end: false },
]

/**
 * How many incidents are open right now, from `/incidents?status=open` — the header's
 * one live signal, linking to them. A page holds twenty, so beyond that it says «20+».
 */
const OpenIncidents = () => {
  const open = useQuery(queries.incidents({ status: 'open' }))
  if (open.data === undefined) return null
  const count = open.data.incidents.length
  const label =
    count === 0 ? 'no open incidents' : `${count}${open.data.next_cursor === null ? '' : '+'} open`
  return (
    <Link
      to="/incidents?status=open"
      className={cn(
        'hidden sm:flex items-center gap-2 mono text-[10px] uppercase tracking-[0.16em] transition-colors duration-150',
        count === 0 ? 'text-dim-foreground hover:text-muted-foreground' : 'text-alert',
      )}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          count === 0 ? 'bg-border-strong' : 'bg-alert animate-pulse-alert',
        )}
      />
      {label}
    </Link>
  )
}

const AppShell = ({ children }: { children: ReactNode }) => (
  <div className="min-h-screen flex flex-col">
    {isDemo && <DemoNotice />}
    <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur-sm">
      <div className="mx-auto w-full max-w-[1400px] px-4 sm:px-6 h-14 flex items-center gap-4 sm:gap-8">
        <NavLink to="/" className="flex items-baseline gap-2 shrink-0">
          <span className="mono text-[13px] font-semibold tracking-[0.14em] uppercase">
            Mandate
          </span>
          <span className="hidden md:inline label">admin-abuse cover</span>
        </NavLink>

        <nav className="flex items-center gap-1">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  'mono text-[11px] uppercase tracking-[0.14em] px-2.5 sm:px-3 py-1.5 rounded-sm transition-colors duration-150',
                  isActive
                    ? 'text-foreground bg-surface-raised'
                    : 'text-muted-foreground hover:text-foreground',
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="ml-auto">
          <OpenIncidents />
        </div>
      </div>
    </header>

    <main className="flex-1 mx-auto w-full max-w-[1400px] px-4 sm:px-6 py-8">{children}</main>

    <footer className="border-t border-border">
      <div className="mx-auto w-full max-w-[1400px] px-4 sm:px-6 h-11 flex items-center">
        {isDemo ? (
          <span className="mono text-[10px] uppercase tracking-[0.2em] text-dim-foreground">
            Demo — mock data
          </span>
        ) : (
          <a
            href={PROGRAM_EXPLORER}
            target="_blank"
            rel="noreferrer"
            className="mono text-[10px] uppercase tracking-[0.2em] text-dim-foreground hover:text-muted-foreground transition-colors duration-150"
          >
            Devnet · read-only view of the program
          </a>
        )}
      </div>
    </footer>
  </div>
)

export default AppShell
