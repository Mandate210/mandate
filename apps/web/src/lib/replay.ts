import { useCallback, useEffect, useRef, useState } from 'react'
import { replaySpeed } from './incident'

/**
 * Plays a settled incident's recorded timeline back from its trigger (T055) — what the
 * M0 «Run scenario» showed with invented events, now with the chain's own, at the
 * seconds the chain gives them. Local to the page: nothing else reads a replay.
 */
export const useReplay = (duration: number) => {
  const [elapsed, setElapsed] = useState<number | null>(null)
  const frame = useRef<number | null>(null)
  const speed = replaySpeed(duration)

  const stop = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    setElapsed(null)
  }, [])

  const play = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    const started = performance.now()
    const tick = () => {
      const seconds = ((performance.now() - started) / 1000) * speed
      if (seconds >= duration) {
        frame.current = null
        setElapsed(null)
        return
      }
      setElapsed(seconds)
      frame.current = requestAnimationFrame(tick)
    }
    setElapsed(0)
    frame.current = requestAnimationFrame(tick)
  }, [duration, speed])

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
    },
    [],
  )

  /** `elapsed` is `null` when nothing is playing — the page shows the whole record. */
  return { elapsed, speed, play, stop }
}

/** Wall-clock seconds, ticking while `live` — the counter of an incident still open. */
export const useNow = (live: boolean): number => {
  const [now, setNow] = useState(() => Date.now() / 1000)
  useEffect(() => {
    if (!live) return
    const id = window.setInterval(() => setNow(Date.now() / 1000), 100)
    return () => window.clearInterval(id)
  }, [live])
  return now
}
