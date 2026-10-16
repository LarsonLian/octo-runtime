import {useRef,useState,useCallback,useLayoutEffect} from 'react'
import {AlertTriangle,ArrowDown} from 'lucide-react'
import {useT} from '@/lib/i18n'
import {Transcript} from './Transcript'
import type {OwnerSubject,ConversationMessage} from '@shared/contracts'
import type {MessageView} from '@shared/work-state'
const INITIAL_MESSAGES=40,PAGE_SIZE=40,NEAR_BOTTOM_PX=24
export function TranscriptScroller({ history, historyError, live, executionStatusById, owner }: {
  owner?: OwnerSubject | null
  history: ConversationMessage[]
  historyError: string
  live: MessageView[]
  executionStatusById: Record<string, { status: string; failureCode?: string }>
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const t = useT()
  const stickToBottom = useRef(true)
  const prependHeight = useRef<number | null>(null)
  const [visibleCount, setVisibleCount] = useState(INITIAL_MESSAGES)
  const [showJump, setShowJump] = useState(false)

  const syncPinned = useCallback(() => {
    const el = scroller.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX
    stickToBottom.current = near
    setShowJump(!near)
  }, [])

  const jumpToBottom = useCallback(() => {
    stickToBottom.current = true
    setShowJump(false)
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  // 粘底：内容增长时保持贴底；用户上滚后停止跟随
  const liveTail = live.at(-1)
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || !stickToBottom.current) return
    el.scrollTop = el.scrollHeight
  }, [history.length, live.length, liveTail?.content, liveTail?.items?.length])

  // 补页后补偿滚动位置，不让视口跳动
  useLayoutEffect(() => {
    const previousHeight = prependHeight.current
    const el = scroller.current
    if (previousHeight == null || !el) return
    prependHeight.current = null
    el.scrollTop += el.scrollHeight - previousHeight
  }, [visibleCount])

  const loadEarlier = () => {
    const el = scroller.current
    if (el) prependHeight.current = el.scrollHeight
    stickToBottom.current = false
    setVisibleCount((count) => count + PAGE_SIZE)
  }

  const visibleHistory = history.slice(Math.max(0, history.length - visibleCount))
  const hasEarlier = history.length > visibleHistory.length

  return (
    <div className="transcript-scroller">
      <div
        ref={scroller}
        onScroll={syncPinned}
        className="transcript transcript-scroll"
      >
        {historyError ? (
          <div className="transcript-error">
            <AlertTriangle size={16} className="transcript-error__icon" />
            <p className="transcript-error__text">{t('chat.error.historyFailedDetail', { message: historyError })}</p>
          </div>
        ) : (
          <Transcript
            owner={owner}
            history={visibleHistory}
            live={live}
            executionStatusById={executionStatusById}
          />
        )}
        {hasEarlier && (
          <div className="transcript-more">
            <button
              type="button"
              onClick={loadEarlier}
              className="transcript-more__btn"
            >
              {t('chat.history.loadEarlier')}
            </button>
          </div>
        )}
        <div className="transcript-spacer" aria-hidden />
      </div>
      {showJump && (
        <button
          type="button"
          title={t('chat.scroll.toBottom')}
          aria-label={t('chat.scroll.toBottom')}
          onClick={jumpToBottom}
          className="transcript-jump"
        >
          <ArrowDown size={13} />
        </button>
      )}
    </div>
  )
}
