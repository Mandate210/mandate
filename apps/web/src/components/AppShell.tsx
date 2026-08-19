import DemoNotice from '@/components/DemoNotice'
import { INCIDENT } from '@/lib/mockData'
import { useScenario } from '@/lib/scenario'
import { cn } from '@/lib/utils'
import { Play, RotateCcw } from 'lucide-react'
import type { ReactNode } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'

const NAV = [
  { to: '/', label: 'Pools', end: true },
  { to: `/incident/${INCIDENT.id}`, label: 'Incident', end: true },
  { to: `/incident/${INCIDENT.id}/verify`, label: 'Verification', end: true },
]

const AppShell = ({ children }: { children: ReactNode }) => {
  const { status, run, reset } = useScenario()
  const navigate = useNavigate()

  const handleRun = () => {
    navigate(`/incident/${INCIDENT.id}`)
    run()
  }

  return (
    <div className="min-h-screen flex flex-col">
      <DemoNotice />
      <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur-sm">
        <div className="mx-auto w-full max-w-[1400px] px-6 h-14 flex items-center gap-8">
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
                    'mono text-[11px] uppercase tracking-[0.14em] px-3 py-1.5 rounded-sm transition-colors duration-150',
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

          <div className="ml-auto flex items-center gap-2">
            <span
              className={cn(
                'hidden lg:flex items-center gap-2 mono text-[10px] uppercase tracking-[0.16em] mr-2',
                status === 'idle' ? 'text-dim-foreground' : 'text-alert',
              )}
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  status === 'idle'
                    ? 'bg-border-strong'
                    : status === 'running'
                      ? 'bg-alert animate-pulse-alert'
                      : 'bg-alert',
                )}
              />
              {status === 'idle'
                ? 'no incidents'
                : status === 'running'
                  ? 'incident open'
                  : 'settled'}
            </span>

            <button
              type="button"
              onClick={handleRun}
              className="mono text-[11px] uppercase tracking-[0.14em] inline-flex items-center gap-2 px-3 h-8 rounded-sm bg-alert text-background font-medium transition-opacity duration-150 hover:opacity-85"
            >
              <Play className="h-3 w-3" strokeWidth={2.5} />
              Run scenario
            </button>
            <button
              type="button"
              onClick={reset}
              className="mono text-[11px] uppercase tracking-[0.14em] inline-flex items-center gap-2 px-3 h-8 rounded-sm border border-border-strong text-muted-foreground transition-colors duration-150 hover:text-foreground hover:border-foreground/40"
            >
              <RotateCcw className="h-3 w-3" strokeWidth={2.5} />
              Reset
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 mx-auto w-full max-w-[1400px] px-6 py-8">{children}</main>

      <footer className="border-t border-border">
        <div className="mx-auto w-full max-w-[1400px] px-6 h-11 flex items-center">
          <span className="mono text-[10px] uppercase tracking-[0.2em] text-dim-foreground">
            Demo — mock data
          </span>
        </div>
      </footer>
    </div>
  )
}

export default AppShell
