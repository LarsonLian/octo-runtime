import { useEffect, useState } from 'react'
import { useT } from '@/lib/i18n'
import type { MessageView } from '@shared/work-state'

export function ExecutionTimer({ message, status }: { message: MessageView; status: string }) {
  const translate = useT()
  const startedAt = message.startedAt
  const [elapsed, setElapsed] = useState<number | undefined>(() => initialElapsed(startedAt))
  useEffect(() => {
    const initial = initialElapsed(startedAt)
    if (initial === undefined) {
      setElapsed(undefined)
      return
    }
    if (message.transportError || status === 'disconnected') return
    const baseline = performance.now()
    setElapsed(initial)
    const timer = setInterval(() => setElapsed(initial + performance.now() - baseline), 1000)
    return () => clearInterval(timer)
  }, [message.executionId, startedAt, message.transportError, status])
  if (elapsed === undefined || startedAt === undefined) return null
  let label = ''
  if (elapsed !== undefined && startedAt !== undefined) {
    const seconds = Math.floor(elapsed / 1000)
    const minutes = Math.floor(seconds / 60)
    label = seconds < 60 ? translate('chat.presentation.runningSeconds', { seconds })
      : minutes < 60 ? translate('chat.presentation.runningMinutes', { minutes, seconds: seconds % 60 })
        : translate('chat.presentation.runningHours', { hours: Math.floor(minutes / 60), minutes: minutes % 60, seconds: seconds % 60 })
  }
  return <span className="exec-elapsed" data-running-timer>{label}</span>
}

function initialElapsed(startedAt: number | undefined): number | undefined {
  if (startedAt === undefined || !Number.isFinite(startedAt) || startedAt <= 0) return undefined
  const elapsed = Date.now() - startedAt
  return elapsed >= 0 ? elapsed : undefined
}
