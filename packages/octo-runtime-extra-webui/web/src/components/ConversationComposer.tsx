import type { ReactNode } from 'react'
import { ArrowUp, Square } from 'lucide-react'
import { cn } from './cn'
import './conversation-composer.css'

export interface ConversationComposerProps {
  editor: ReactNode
  toolbarLeft?: ReactNode
  toolbarRight?: ReactNode
  header?: ReactNode
  footer?: ReactNode
  className?: string
  sendLabel: string
  sendDisabled?: boolean
  sending?: boolean
  onSend: () => void
  running?: boolean
  stopping?: boolean
  stopLabel?: string
  onStop?: () => void
}

export function ConversationComposer({
  editor, toolbarLeft, toolbarRight, header, footer, className, sendLabel, sendDisabled = false, sending = false,
  onSend, running = false, stopping = false, stopLabel, onStop,
}: ConversationComposerProps) {
  return (
    <div className={cn('ui-conversation-composer', footer != null && 'ui-conversation-composer--with-footer', className)}>
      {header != null && <div className="ui-conversation-composer__header">{header}</div>}
      <div data-composer-box className="ui-conversation-composer__card">
        <div className="ui-conversation-composer__editor">{editor}</div>
        <div className="ui-conversation-composer__toolbar">
          <div className="ui-conversation-composer__tools">{toolbarLeft}</div>
          <div className="ui-conversation-composer__actions">
            {toolbarRight}
            <button
              type="button"
              className={cn('ui-conversation-composer__send', running && 'is-running')}
              aria-label={running ? stopLabel : sendLabel}
              title={running ? stopLabel : sendLabel}
              aria-busy={running ? stopping : sending}
              disabled={running ? stopping || !onStop : sendDisabled || sending}
              onClick={running ? onStop : onSend}
            >
              {running ? <Square size={14} fill="currentColor" aria-hidden /> : <ArrowUp size={22} aria-hidden />}
            </button>
          </div>
        </div>
      </div>
      {footer != null && <div className="ui-conversation-composer__footer">{footer}</div>}
    </div>
  )
}
