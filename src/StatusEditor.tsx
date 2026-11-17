import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { CardStatusEditor, CardStatusField } from './contracts';

interface StatusEditorProps {
  cardId: string;
  title: string;
  status?: string;
  statusColor?: string;
  disabled: boolean;
  getCached?(): CardStatusEditor | undefined;
  load(): Promise<CardStatusEditor>;
  onChange(fieldId: string, optionId: string): Promise<void>;
}

function message(error: unknown, fallback: string): string {
  const value = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /[가-힣]/.test(value) ? value : fallback;
}

/** The page-opening control is a sibling; status selection never follows the page link. */
export function StatusEditor({ cardId, title, status, statusColor, disabled, getCached, load, onChange }: StatusEditorProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hasOptions, setHasOptions] = useState(false);
  const [pending, setPending] = useState(false);
  const [fields, setFields] = useState<CardStatusField[]>([]);
  const [fieldId, setFieldId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const openRef = useRef(false);
  const pendingRef = useRef(false);
  const restoreFocus = useRef(false);
  const localCache = useRef<CardStatusEditor | undefined>(undefined);
  const panelId = useId();
  const field = fields.find(value => value.id === fieldId);

  useEffect(() => {
    mounted.current = true;
    generation.current += 1;
    openRef.current = false;
    pendingRef.current = false;
    restoreFocus.current = false;
    setOpen(false);
    setLoading(false);
    setHasOptions(false);
    setPending(false);
    setFields([]);
    setFieldId('');
    setError(null);
    localCache.current = undefined;
    return () => {
      mounted.current = false;
      openRef.current = false;
      generation.current += 1;
    };
  }, [cardId]);

  useEffect(() => {
    if (!restoreFocus.current || open || disabled || pending) return;
    restoreFocus.current = false;
    if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true });
  }, [open, disabled, pending]);

  const current = (version: number) => mounted.current && openRef.current && generation.current === version;

  function close() {
    if (pendingRef.current) return;
    generation.current += 1;
    openRef.current = false;
    setOpen(false);
    setLoading(false);
    setError(null);
    restoreFocus.current = true;
  }

  async function loadOptions() {
    if (disabled || pendingRef.current) return;
    const version = ++generation.current;
    openRef.current = true;
    setOpen(true);
    setLoading(true);
    const cached = getCached ? getCached() : localCache.current;
    const usable = cached?.cardId === cardId ? cached : undefined;
    setHasOptions(usable !== undefined);
    setFields(usable?.fields ?? []);
    setFieldId(previous => usable?.fields.some(field => field.id === previous) ? previous : usable?.fields[0]?.id ?? '');
    setError(null);
    try {
      const editor = await load();
      if (!current(version)) return;
      if (editor.cardId !== cardId) throw new Error('카드가 변경되었습니다. 상태 목록을 다시 열어 주세요.');
      localCache.current = editor;
      setHasOptions(true);
      setFields(editor.fields);
      setFieldId(previous => editor.fields.some(field => field.id === previous) ? previous : editor.fields[0]?.id ?? '');
    } catch (value) {
      if (!current(version)) return;
      const detail = message(value, '상태 목록을 가져오지 못했습니다. 다시 시도해 주세요.');
      setError(usable ? `이전 상태 목록을 표시하고 있어요. ${detail}` : detail);
    } finally {
      if (current(version)) setLoading(false);
    }
  }

  async function select(optionId: string) {
    if (disabled || pendingRef.current || !field || optionId === field.currentOptionId) return;
    if (!field.options.some(option => option.id === optionId)) return;
    pendingRef.current = true;
    setPending(true);
    // A background read started before this write cannot replace its confirmed result.
    const version = ++generation.current;
    setLoading(false);
    setError(null);
    try {
      await onChange(field.id, optionId);
      if (!current(version)) return;
      const confirmed = fields.map(value => value.id === field.id ? { ...value, currentOptionId: optionId } : value);
      localCache.current = { cardId, fields: confirmed };
      setFields(confirmed);
      pendingRef.current = false;
      setPending(false);
      close();
    } catch (value) {
      if (!current(version)) return;
      setError(message(value, '상태 변경 결과를 확인하지 못했습니다. 카드를 새로고침한 뒤 다시 시도해 주세요.'));
    } finally {
      if (current(version)) {
        pendingRef.current = false;
        setPending(false);
      }
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Escape' || !openRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }

  return <div className="status-editor" onKeyDown={onKeyDown}>
    <button ref={trigger} type="button" className="status-tag status-trigger status-color" data-color={statusColor} disabled={disabled || pending}
      aria-label={`${title} 상태 변경${status ? `, 현재 ${status}` : ''}`} aria-expanded={open} aria-controls={panelId}
      onClick={() => { if (openRef.current) close(); else void loadOptions(); }}>
      {status && <span className="status-option-dot" aria-hidden="true" />}<span className="status-trigger-label">{status || '상태 변경'}</span><svg className="status-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    {open && <section id={panelId} className="status-picker" aria-label={`${title} 작업 상태`} aria-busy={(loading && !hasOptions) || pending}>
      <header className="status-picker-header"><span>작업 상태</span><button type="button" className="status-picker-close" disabled={pending}
        aria-label="상태 선택 닫기" onClick={close}>닫기</button></header>
      {loading && !hasOptions ? <p className="status-picker-note" role="status">상태 목록을 가져오는 중…</p> : <>
        {fields.length > 1 && <label className="status-property-label">변경할 속성
          <select value={fieldId} disabled={disabled || pending} onChange={event => { setFieldId(event.target.value); setError(null); }}>
            {fields.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}
          </select>
        </label>}
        {field && <>
          {fields.length === 1 && <p className="status-property-name">{field.name}</p>}
          <div className="status-options" role="group" aria-label={`${field.name} 선택`}>
            {field.options.map(option => <button key={option.id} type="button" className="status-option"
              data-color={option.color} aria-pressed={option.id === field.currentOptionId}
              disabled={disabled || pending || option.id === field.currentOptionId} onClick={() => void select(option.id)}>
              <span className="status-option-pill status-color" data-color={option.color}><span className="status-option-dot" aria-hidden="true" /><span className="status-option-name">{option.name}</span></span>
              {option.id === field.currentOptionId && <span className="status-current">현재</span>}
            </button>)}
          </div>
          {field.options.length === 0 && <p className="status-picker-note">선택할 수 있는 상태가 없어요. Notion에서 상태 옵션을 확인해 주세요.</p>}
        </>}
        {!error && fields.length === 0 && <p className="status-picker-note">이 카드에는 변경할 수 있는 상태 속성이 없어요.</p>}
      </>}
      {pending && <p className="status-picker-note" role="status">상태 변경 중…</p>}
      {error && <div className="status-picker-error" role="alert"><p>{error}</p><button type="button" disabled={disabled || loading || pending} onClick={() => void loadOptions()}>상태 목록 다시 가져오기</button></div>}
    </section>}
  </div>;
}
