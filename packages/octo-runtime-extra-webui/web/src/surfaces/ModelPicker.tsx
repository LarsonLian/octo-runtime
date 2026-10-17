import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { ArrowLeft, Check, ChevronDown, ChevronRight, RotateCcw, Settings2, TerminalSquare } from 'lucide-react'
import type { RuntimeAdapter } from '@shared/contracts'
import { Popover } from '@/components/Popover'
import { providerName } from '@/lib/provider-names'
import { providerIcon } from '@/lib/provider-icons'
import { useT } from '@/lib/i18n'
import { DEFAULT_REASONING_EFFORT } from '@/lib/execution-context'
import { requestSettings } from '@/settings/navigation'

const efforts = ['low', 'medium', 'high', 'xhigh']
const effortLabelKeys: Record<string, 'chat.composer.effortLevels.low' | 'chat.composer.effortLevels.medium' | 'chat.composer.effortLevels.high' | 'chat.composer.effortLevels.xhigh'> = {
  low: 'chat.composer.effortLevels.low',
  medium: 'chat.composer.effortLevels.medium',
  high: 'chat.composer.effortLevels.high',
  xhigh: 'chat.composer.effortLevels.xhigh',
}

export function AdapterMark({ type }: { type: string }) {
  const icon = providerIcon(type)
  if (!icon) return <TerminalSquare size={18} aria-hidden />
  if (icon.monochrome) return <span className="provider-glyph" aria-hidden style={{ maskImage: `url("${icon.url}")`, WebkitMaskImage: `url("${icon.url}")` }} />
  return icon.darkURL ? <><img className="provider-mark provider-mark--light" src={icon.url} alt="" /><img className="provider-mark provider-mark--dark" src={icon.darkURL} alt="" /></> : <img className="provider-mark" src={icon.url} alt="" />
}

interface ModelPickerProps {
  adapter: string
  adapters: RuntimeAdapter[]
  model: string
  models: string[]
  effort: string
  disabled: boolean
  loading?: boolean
  modelEnabled: boolean
  effortEnabled: boolean
  onAdapter: (value: string) => void
  onModel: (value: string) => void
  onEffort: (value: string) => void
  onAddModel?: (value: string) => void
  modelReason?: string
  adapterLocked?: boolean
  modelSupported?: boolean
}

export function ModelPicker(props: ModelPickerProps) {
  const t = useT()
  const [dragValue, setDragValue] = useState<number | null>(null)
  const dragging = useRef(false)
  const currentEffort = props.effort || DEFAULT_REASONING_EFFORT
  const sliderValue = dragValue ?? Math.max(0, efforts.indexOf(currentEffort))
  const displayEffort = dragValue === null ? currentEffort : efforts[Math.round(dragValue)]
  const effortLabel = effortLabelKeys[displayEffort] ? t(effortLabelKeys[displayEffort]) : displayEffort
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const id = useId()
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'models' | 'adapters'>('models')
  const engineOptions = props.adapters.filter(adapter => adapter.providerType !== 'kiro')
  const close = () => { setOpen(false); trigger.current?.focus() }
  useEffect(() => { if (props.disabled) setOpen(false) }, [props.disabled])
  useEffect(() => {
    if (open) panel.current?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)')?.focus()
  }, [open, view])
  return <>
    <button ref={trigger} type="button" className="composer-control model-picker-trigger" aria-label={t('chat.composer.model')} title={props.adapter ? providerName(props.adapter) : t('chat.composer.adapter')} aria-haspopup="dialog" aria-expanded={open && !props.disabled} aria-controls={open ? id : undefined} disabled={props.disabled} onClick={() => { setView('models'); setOpen(!open) }} onKeyDown={(event) => {
      if (event.key === 'ArrowDown') { event.preventDefault(); setView('models'); setOpen(true) }
    }}>
      <AdapterMark type={props.adapter} /><span aria-live="polite">{props.loading ? t('runtime.health.detail.enginesDetecting') : props.model || t('settings.models.default')}</span><ChevronDown size={14} aria-hidden />
    </button>
    {open && !props.disabled && <Popover anchor={trigger} side="top" align="end" width={296} gap={8} ignore=".model-picker-trigger" className="model-picker-popover" onDismiss={(reason) => { if (reason === 'escape') close(); else setOpen(false) }}>
      <div ref={panel} id={id} role="dialog" aria-label={t('chat.composer.model')} onKeyDown={(event) => {
        if (event.key === 'Escape') { event.stopPropagation(); close() }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || event.target instanceof HTMLInputElement) return
        event.preventDefault()
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
        const current = items.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
        items[next]?.focus()
      }}>
        {view === 'models' ? <>
          <div className="model-picker-heading"><strong>{props.adapter ? providerName(props.adapter) : t('settings.models.engine')}</strong><span>{t('chat.composer.model')}</span></div>
          <div role="group" aria-label={t('chat.composer.model')}>
            {['', ...(props.modelSupported === false ? [] : new Set(props.models.filter(Boolean)))].map((model) => <button type="button" key={model} data-model-option={model || 'default'} className="model-picker-option" aria-pressed={props.model === model} disabled={!!model && !props.modelEnabled} title={model && !props.modelEnabled ? props.modelReason : undefined} onClick={() => { props.onModel(model); close() }}>
              <AdapterMark type={props.adapter} /><span className="model-picker-label">{model || t('settings.models.default')}</span>{props.model === model && <Check size={17} aria-hidden />}
            </button>)}
          </div>
          {props.modelReason && <p className="model-picker-notice" role="status">{props.modelReason}</p>}
          <div className="model-picker-effort">
            <div><span>{t('chat.composer.reasoning')}</span><strong>{effortLabel}</strong><button type="button" aria-label={t('chat.composer.resetEffort')} title={t('chat.composer.resetEffort')} disabled={currentEffort === DEFAULT_REASONING_EFFORT || !props.effortEnabled} onClick={() => props.onEffort(DEFAULT_REASONING_EFFORT)}><RotateCcw size={15} /></button></div>
            <div className="model-picker-slider" data-disabled={!props.effortEnabled} style={{ '--effort-progress': sliderValue / 3 } as CSSProperties}>
              <div className="model-picker-slider__dots" aria-hidden>{efforts.map((effort) => <i key={effort} data-filled={!!displayEffort && efforts.indexOf(effort) <= sliderValue} />)}</div>
              <input type="range" min={0} max={3} step={0.01} value={sliderValue} aria-label={t('chat.composer.reasoning')} aria-valuetext={effortLabel} disabled={!props.effortEnabled} onPointerDown={(event) => { dragging.current = true; event.currentTarget.setPointerCapture?.(event.pointerId) }} onChange={(event) => {
                const value = Number(event.target.value)
                if (dragging.current) setDragValue(value)
                else props.onEffort(efforts[Math.round(value)])
              }} onPointerUp={(event) => {
                dragging.current = false
                props.onEffort(efforts[Math.round(Number(event.currentTarget.value))])
                setDragValue(null)
              }} onPointerCancel={() => { dragging.current = false; setDragValue(null) }} onKeyDown={(event) => {
                const delta = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 0
                if (delta || event.key === 'Home' || event.key === 'End') {
                  event.preventDefault()
                  props.onEffort(efforts[event.key === 'Home' ? 0 : event.key === 'End' ? 3 : Math.max(0, Math.min(3, Math.round(sliderValue) + delta))])
                }
              }} />
            </div>
          </div>
          <button type="button" className="model-picker-option model-picker-secondary" aria-label={t('settings.models.chooseEngine')} disabled={props.adapterLocked} onClick={() => setView('adapters')}><AdapterMark type={props.adapter} /><span className="model-picker-label">{props.adapter ? providerName(props.adapter) : t('settings.models.chooseEngine')}</span><ChevronRight size={16} /></button>
          <button type="button" className="model-picker-option" onClick={() => { close(); requestSettings('providers') }}><Settings2 size={18} /><span className="model-picker-label">{t('settings.models.manage')}</span><ChevronRight size={16} /></button>
        </> : <>
          <button type="button" className="model-picker-option model-picker-back" onClick={() => setView('models')}><ArrowLeft size={16} /><span className="model-picker-label">{t('settings.models.chooseEngine')}</span></button>
          <div role="group" aria-label={t('settings.models.engine')}>
            {engineOptions.map(adapter => {
              const missingConfiguration = adapter.unavailableReason === 'runtime_configuration_missing'
              return <button type="button" key={adapter.providerType} className="model-picker-option" data-engine-option={adapter.providerType} aria-pressed={props.adapter === adapter.providerType} disabled={!adapter.available || props.adapterLocked} title={!adapter.available ? t(missingConfiguration ? 'settings.models.connectionMissing' : 'settings.models.runtimeUnavailable') : undefined} onClick={() => { if (adapter.available && !props.adapterLocked) props.onAdapter(adapter.providerType); setView('models') }}>
                <AdapterMark type={adapter.providerType} /><span className="model-picker-label">{providerName(adapter.providerType)}</span>
                {!adapter.available && <span className="model-picker-status">{t(missingConfiguration ? 'settings.models.notConfigured' : 'settings.models.unavailableEngine')}</span>}
                {props.adapter === adapter.providerType && <Check size={17} aria-hidden />}
              </button>
            })}
            {!engineOptions.length && <p className="model-picker-empty">{t('settings.runtimes.adapters.empty')}</p>}
          </div>
          <button type="button" className="model-picker-option model-picker-secondary" onClick={() => { close(); requestSettings('runtimes') }}><Settings2 size={18} /><span className="model-picker-label">{t('settings.models.manageEngine')}</span><ChevronRight size={16} /></button>
        </>}
      </div>
    </Popover>}
  </>
}
