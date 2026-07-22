import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { INCIDENT, TIMELINE } from './mockData'

type ScenarioStatus = 'idle' | 'running' | 'settled'

interface ScenarioContextValue {
  status: ScenarioStatus
  /** elapsed seconds since the trigger transaction, frozen at settlement */
  elapsed: number
  /** events whose timestamp has been reached */
  visibleEvents: typeof TIMELINE
  run: () => void
  reset: () => void
}

const ScenarioContext = createContext<ScenarioContextValue | null>(null)

const STOP_AT = INCIDENT.settledAt // 22s

export const ScenarioProvider = ({ children }: { children: ReactNode }) => {
  const [status, setStatus] = useState<ScenarioStatus>('idle')
  const [elapsed, setElapsed] = useState(0)
  const frame = useRef<number | null>(null)
  const startedAt = useRef(0)

  const stop = useCallback(() => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current)
      frame.current = null
    }
  }, [])

  const tick = useCallback(() => {
    const seconds = (performance.now() - startedAt.current) / 1000
    if (seconds >= STOP_AT) {
      setElapsed(STOP_AT)
      setStatus('settled')
      stop()
      return
    }
    setElapsed(seconds)
    frame.current = requestAnimationFrame(tick)
  }, [stop])

  const run = useCallback(() => {
    stop()
    setStatus('running')
    setElapsed(0)
    startedAt.current = performance.now()
    frame.current = requestAnimationFrame(tick)
  }, [stop, tick])

  const reset = useCallback(() => {
    stop()
    setStatus('idle')
    setElapsed(0)
  }, [stop])

  useEffect(() => stop, [stop])

  const visibleEvents = useMemo(() => {
    if (status === 'idle') return []
    if (status === 'settled') return TIMELINE
    return TIMELINE.filter((e) => e.t <= elapsed)
  }, [status, elapsed])

  const value = useMemo(
    () => ({ status, elapsed, visibleEvents, run, reset }),
    [status, elapsed, visibleEvents, run, reset],
  )

  return <ScenarioContext.Provider value={value}>{children}</ScenarioContext.Provider>
}

export const useScenario = () => {
  const ctx = useContext(ScenarioContext)
  if (!ctx) throw new Error('useScenario must be used inside ScenarioProvider')
  return ctx
}
