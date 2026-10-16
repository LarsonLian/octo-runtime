import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown, Folder, Globe, Hand, ShieldAlert, SquareTerminal, TriangleAlert, createLucideIcon } from 'lucide-react'
import type { ApprovalMode } from '@mininglamp-oss/octo-runtime-protocol'
import { Popover } from '@/components/Popover'
import { Modal } from '@/components/Modal'
import { useT } from '@/lib/i18n'

const AssistedApprovalIcon = createLucideIcon('AssistedApproval', [
  ['path', { d: 'M10.4 3.7a4 4 0 0 1 3.2 0l4.6 2A3 3 0 0 1 20 8.4v6.3a5 5 0 0 1-2.5 4.3l-3.5 2a4 4 0 0 1-4 0l-3.5-2A5 5 0 0 1 4 14.7V8.4a3 3 0 0 1 1.8-2.7z', key: 'shield' }],
  ['path', { d: 'm8 10 2 2-2 2M12.5 15H16', key: 'terminal' }],
])

interface ApprovalPolicyPickerProps {
  value: ApprovalMode
  disabled: boolean
  onChange: (value: ApprovalMode) => void
  allowedModes?: readonly ApprovalMode[]
}

export function ApprovalPolicyPicker({ value, disabled, onChange, allowedModes = ['ask', 'assisted', 'full_access'] }: ApprovalPolicyPickerProps) {
  const t = useT()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const [open, setOpen] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [showFullAccess, setShowFullAccess] = useState(false)
  useEffect(() => {
    if (disabled) setOpen(false)
    else if (open) {
      const selectedItem = menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]:not(:disabled)')
      const firstItem = menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)')
      const focusTarget = selectedItem ?? firstItem
      focusTarget?.focus()
    }
  }, [open, disabled])
  const options = [
    { value: 'ask', label: t('chat.composer.permissionAsk'), description: t('chat.composer.permissionAskDescription'), icon: Hand },
    { value: 'assisted', label: t('chat.composer.permissionOnDemand'), description: t('chat.composer.permissionOnDemandDescription'), icon: AssistedApprovalIcon },
    { value: 'full_access', label: t('chat.composer.permissionAllow'), description: t('chat.composer.permissionAllowDescription'), icon: ShieldAlert },
  ] as const
  const selected = options.find((option) => option.value === value) ?? options[0]
  const Icon = selected.icon
  const close = () => { setOpen(false); triggerRef.current?.focus() }
  const cancelFullAccess = () => { setShowFullAccess(false); triggerRef.current?.focus() }

  return <>
    <button
      ref={triggerRef}
      type="button"
      className={`composer-control approval-policy-trigger${value === 'full_access' ? ' approval-policy-trigger--full-access' : ''}`}
      aria-label={t('chat.composer.permissionTitle')}
      aria-haspopup="menu"
      aria-expanded={open && !disabled}
      aria-controls={open && !disabled ? menuId : undefined}
      disabled={disabled}
      onClick={() => setOpen(!open)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true) }
      }}
    >
      <Icon size={14} aria-hidden />
      <span>{selected.label}</span>
      <ChevronDown size={12} aria-hidden />
    </button>
    {open && !disabled && <Popover anchor={triggerRef} side="top" align="start" gap={8} width={320} className="approval-policy-popover" autoFocus onDismiss={(reason) => {
      if (reason === 'escape') close()
      else setOpen(false)
    }}>
      <div className="approval-policy-menu__header">
        <span>{t('chat.composer.permissionPrompt')}</span>
        <button type="button" onClick={() => { close(); setShowHelp(true) }}>{t('chat.composer.permissionLearnMore')}</button>
      </div>
      <div ref={menuRef} id={menuId} role="menu" aria-label={t('chat.composer.permissionTitle')} onKeyDown={(event) => {
        if (event.key === 'Escape') { event.stopPropagation(); close(); return }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)'))
        const current = items.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
        items[next]?.focus()
      }}>
        {options.map((option) => <button
          key={option.value}
          type="button"
          role="menuitemradio"
          aria-checked={value === option.value}
          disabled={!allowedModes.includes(option.value)}
          className={`approval-policy-option${option.value === 'full_access' ? ' approval-policy-option--full-access' : ''}`}
          onClick={() => {
            close()
            if (option.value === 'full_access' && value !== 'full_access') setShowFullAccess(true)
            else onChange(option.value)
          }}
        >
          <option.icon size={18} aria-hidden />
          <span className="approval-policy-option__copy"><span>{option.label}</span><small>{option.description}</small></span>
          {value === option.value && <Check size={17} aria-hidden />}
        </button>)}
      </div>
    </Popover>}
    {showFullAccess && !showHelp && <Modal
      title={<><TriangleAlert size={16} aria-hidden /><span>{t('chat.composer.fullAccessConfirmTitle')}</span></>}
      description={t('chat.composer.fullAccessConfirmDescription')}
      size="md" className="approval-full-access-dialog" hideCloseButton onClose={cancelFullAccess}
    >
      <div className="approval-full-access-dialog__capabilities">
        {([
          { icon: Folder, name: 'Files', className: 'files' },
          { icon: SquareTerminal, name: 'Terminal', className: 'terminal' },
          { icon: Globe, name: 'Internet', className: 'internet' },
        ] as const).map(({ icon: CapabilityIcon, name, className }) => <div key={name} className="approval-full-access-dialog__capability">
          <CapabilityIcon size={20} className={`approval-full-access-dialog__icon--${className}`} aria-hidden />
          <div><h3>{t(`chat.composer.fullAccess${name}Title`)}</h3><p>{t(`chat.composer.fullAccess${name}Description`)}</p></div>
        </div>)}
      </div>
      <div className="approval-full-access-dialog__warning">
        <p>{t('chat.composer.fullAccessConfirmWarning')}</p>
        <button type="button" onClick={() => setShowHelp(true)}>{t('chat.composer.permissionLearnMore')}</button>
      </div>
      <div className="approval-full-access-dialog__actions">
        <button type="button" onClick={cancelFullAccess}>{t('common.cancel')}</button>
        <button type="button" className="approval-full-access-dialog__confirm" disabled={disabled || !allowedModes.includes('full_access')} onClick={() => {
          onChange('full_access')
          cancelFullAccess()
        }}><TriangleAlert size={14} aria-hidden />{t('chat.composer.fullAccessConfirmAction')}</button>
      </div>
    </Modal>}
    {showHelp && <Modal title={t('chat.composer.permissionTitle')} size="md" className="approval-policy-help" onClose={() => { setShowHelp(false); if (!showFullAccess) triggerRef.current?.focus() }}>
      {options.map((option) => <div key={option.value} className="approval-policy-help__item">
        <option.icon size={20} aria-hidden />
        <div><h3>{option.label}</h3><p>{option.description}</p></div>
      </div>)}
    </Modal>}
  </>
}
