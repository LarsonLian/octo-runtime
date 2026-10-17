import { useEffect, useRef, useState } from 'react'

export function ActivityLabel({ text, busy, announce }: { text: string; busy: boolean; announce: boolean }) {
  const element = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(!document.hidden)
  const [intersecting, setIntersecting] = useState(true)
  useEffect(() => {
    const update = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', update)
    const observer = typeof IntersectionObserver === 'undefined' ? undefined
      : new IntersectionObserver(entries => setIntersecting(entries[0]?.isIntersecting ?? false))
    if (element.current) observer?.observe(element.current)
    return () => {
      document.removeEventListener('visibilitychange', update)
      observer?.disconnect()
    }
  }, [])
  return <span ref={element} className="process-summary__label activity-label" role={announce ? 'status' : undefined}
    aria-live={announce ? 'polite' : undefined} aria-atomic={announce || undefined} data-busy={busy || undefined} title={text}>
    <span>{text}</span>
    {busy && visible && intersecting && <span className="activity-label__shine" data-text={text} aria-hidden="true" />}
  </span>
}
