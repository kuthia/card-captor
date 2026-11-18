import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { currentMonitor, cursorPosition, getCurrentWindow } from '@tauri-apps/api/window';
import { DEFAULT_CONFIG, type AppConfig, type CharacterBackend, type SetupStatus } from './contracts';
import { clampPoint, containsPoint, physicalToLocal, placePanel, type Bounds, type Point } from './geometry';
import type { MotionState } from './motion';
import { CursorInputWriter, POINTER_FAR_MS, pointerPollDelay, startAdaptivePolling, startRoaming } from './activity-policy';
import { desktop, errorMessage, provider } from './provider';
import { Robot } from './Robot';
import { RefreshScheduler } from './refresh';
import { StatusEditor } from './StatusEditor';
import { StatusOptionsCache } from './status-options-cache';
import type { FeedSnapshot } from './contracts';
import { measurement, seededMeasurementRandom } from './benchmark';
import { characterValidation } from './validation';
import { RiveCharacter } from './RiveCharacter';

const PET = { width: 168, height: 180 };
const emptySetup: SetupStatus = { config: { ...DEFAULT_CONFIG }, hasToken: false, snapshot: null };
const stateLabels: Record<MotionState, string> = {
  idle: '잠깐 쉬는 중', walk: '카드 배달 중', dragging: '같이 이동해요', browsing: '천천히 살펴봐요', suspended: '여기서 기다릴게요',
};

function viewportBounds(): Bounds {
  return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
}

function homePosition(bounds: Bounds): Point {
  return clampPoint({ x: bounds.right - 230, y: bounds.bottom - PET.height - 42 }, PET, bounds, 16);
}

function Icon({ name }: { name: 'close' | 'settings' | 'refresh' | 'arrow' | 'pause' | 'play' }) {
  const paths = {
    close: <path d="m6 6 12 12M18 6 6 18" />,
    settings: <><path d="m9 3-1 3-3 1v4l2 1v2l-2 1v4l3 1 1 2h6l1-2 3-1v-4l-2-1v-2l2-1V7l-3-1-1-3Z" /><circle cx="12" cy="12" r="3" /></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 6a8 8 0 0 1 13 2M5 16a8 8 0 0 0 13 2" /></>,
    arrow: <><path d="M8 5h11v11M19 5 5 19" /></>,
    pause: <><path d="M8 5v14M16 5v14" /></>,
    play: <path d="m8 5 11 7-11 7Z" />,
  };
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function shortTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '시간 확인 불가' : new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit' }).format(date);
}

function dueDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric' }).format(date);
}

export default function App() {
  const [setup, setSetup] = useState<SetupStatus>(emptySetup);
  const [loaded, setLoaded] = useState(!desktop);
  const [draft, setDraft] = useState<AppConfig>({ ...DEFAULT_CONFIG });
  const [token, setToken] = useState('');
  const [deckOpen, setDeckOpen] = useState(measurement ? measurement.state === 'cards' : !desktop);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [hidden, setHidden] = useState(document.hidden);
  const [reduceMotion, setReduceMotion] = useState(window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [bounds, setBounds] = useState<Bounds>(viewportBounds);
  const [position, setPosition] = useState<Point>(() => homePosition(viewportBounds()));
  const [mode, setMode] = useState<MotionState>('idle');
  const [dragging, setDragging] = useState(false);
  const [roamRevision, setRoamRevision] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [previewBackend, setPreviewBackend] = useState<CharacterBackend>(characterValidation ? 'rive' : 'robot');
  const [selectingCharacter, setSelectingCharacter] = useState(false);
  const [characterError, setCharacterError] = useState<string | null>(null);
  const [panelSize, setPanelSize] = useState({ width: 352, height: 410 });
  const petRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const setupRef = useRef(setup);
  const boundsRef = useRef(bounds);
  const positionRef = useRef(position);
  const directionRef = useRef<-1 | 1>(1);
  const mutationBusy = useRef(false);
  const scheduler = useRef<RefreshScheduler<FeedSnapshot> | null>(null);
  const statusOptions = useRef(new StatusOptionsCache());
  const cursorInput = useRef<CursorInputWriter | null>(null);
  const mounted = useRef(true);
  const drag = useRef<{ pointerId: number; start: Point; origin: Point; moved: boolean } | null>(null);
  const measurementRandom = useRef(seededMeasurementRandom());
  const measurementPollMs = useRef<number | null>(null);
  const measurementReporter = useRef<() => void>(() => {});
  setupRef.current = setup;
  boundsRef.current = bounds;
  const connected = setup.hasToken && !!setup.config.viewId;
  const snapshot = setup.snapshot;
  const panelOpen = deckOpen || settingsOpen;
  const characterBackend = characterValidation || !desktop ? previewBackend : setup.config.characterBackend;

  const reportError = useCallback((value: unknown, fallback: string) => {
    if (mounted.current) setError(errorMessage(value, fallback));
  }, []);

  // Walking updates the composited layer, keeping the card UI out of the frame loop.
  const movePet = useCallback((next: Point, commit = false) => {
    const dx = next.x - positionRef.current.x;
    if (Math.abs(dx) > 0.01) directionRef.current = dx < 0 ? -1 : 1;
    positionRef.current = next;
    if (petRef.current) petRef.current.style.transform = `translate3d(${next.x}px, ${next.y}px, 0)`;
    if (commit) setPosition(next);
  }, []);

  if (!scheduler.current) scheduler.current = new RefreshScheduler<FeedSnapshot>({
    canRefresh: () => desktop && mounted.current && !mutationBusy.current && navigator.onLine
      && setupRef.current.hasToken && !!setupRef.current.config.viewId,
    load: () => provider.refresh(),
    accept: snapshot => {
      if (!mounted.current) return;
      statusOptions.current.retain(snapshot.cards.map(card => card.id));
      setSetup(value => ({ ...value, snapshot }));
      setError(null);
    },
    reject: value => reportError(value, '카드를 새로고침하지 못했습니다. 연결 설정과 네트워크를 확인해 주세요.'),
    busy: value => { if (mounted.current) setRefreshing(value); },
  });
  const refresh = useCallback(() => scheduler.current!.request(), []);

  useEffect(() => {
    mounted.current = true;
    let canceled = false;
    provider.getSetup().then(value => {
      if (canceled) return;
      setupRef.current = value;
      setSetup(value);
      setDraft(value.config);
      setLoaded(true);
      if (desktop && !measurement && !characterValidation && !value.hasToken) setSettingsOpen(true);
      void refresh();
    }).catch(value => {
      if (canceled) return;
      setLoaded(true);
      setDeckOpen(true);
      reportError(value, '연결 설정을 불러오지 못했습니다. 앱을 다시 실행해 주세요.');
    });
    return () => { canceled = true; mounted.current = false; };
  }, [refresh, reportError]);

  useEffect(() => {
    const onOnline = () => { setOnline(true); void refresh(); };
    const onOffline = () => setOnline(false);
    const onVisibility = () => { setHidden(document.hidden); if (!document.hidden) void refresh(); };
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onMotion = () => setReduceMotion(motion.matches);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisibility);
    motion.addEventListener('change', onMotion);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisibility);
      motion.removeEventListener('change', onMotion);
    };
  }, [refresh]);

  useEffect(() => {
    if (!desktop || !connected || !online || hidden) return;
    const timer = window.setInterval(() => void refresh(), Math.max(30, setup.config.refreshSeconds) * 1000);
    return () => window.clearInterval(timer);
  }, [connected, hidden, online, refresh, setup.config.refreshSeconds]);

  useEffect(() => {
    let canceled = false;
    const update = async () => {
      let next = viewportBounds();
      if (desktop) {
        try {
          const win = getCurrentWindow();
          const [monitor, origin, scale] = await Promise.all([currentMonitor(), win.outerPosition(), win.scaleFactor()]);
          if (monitor && !canceled) {
            const area = monitor.workArea;
            const topLeft = physicalToLocal(area.position, origin, scale);
            next = {
              left: Math.max(0, topLeft.x), top: Math.max(0, topLeft.y),
              right: Math.min(window.innerWidth, topLeft.x + area.size.width / scale),
              bottom: Math.min(window.innerHeight, topLeft.y + area.size.height / scale),
            };
          }
        } catch (value) {
          reportError(value, '화면의 작업 영역을 확인하지 못했습니다. 창 크기를 기준으로 표시합니다.');
        }
      }
      if (!canceled) {
        boundsRef.current = next;
        setBounds(next);
        movePet(clampPoint(positionRef.current, PET, next), true);
      }
    };
    void update();
    window.addEventListener('resize', update);
    return () => { canceled = true; window.removeEventListener('resize', update); };
  }, [movePet, reportError]);

  useLayoutEffect(() => {
    setPosition(positionRef.current);
    if (measurement?.state === 'idle') {
      setMode('idle');
      return;
    }
    return startRoaming({
      context: {
        browsing: panelOpen,
        suspended: !setup.config.roamingEnabled || hidden || reduceMotion,
        hovered: measurement?.state === 'moving' ? false : hovered,
        dragging,
      },
      size: PET,
      position: () => positionRef.current,
      bounds: () => boundsRef.current,
      move: (next, finished) => movePet(next, finished),
      state: next => setMode(value => value === next ? value : next),
      continuous: measurement?.state === 'moving',
      random: measurement ? measurementRandom.current : undefined,
    });
  }, [bounds, dragging, hidden, hovered, movePet, panelOpen, reduceMotion, roamRevision, setup.config.roamingEnabled]);

  useEffect(() => {
    if (!measurement || !desktop) return;
    let previous = '';
    const report = () => {
      const renderer = petRef.current?.querySelector('[data-renderer]')?.getAttribute('data-renderer') ?? 'initializing';
      const event = { mode, renderer, visible: !hidden, pointerPollMs: measurementPollMs.current };
      const key = JSON.stringify(event);
      if (key === previous) return;
      previous = key;
      void invoke('measurement_event', { event }).catch(() => {});
    };
    const observer = new MutationObserver(report);
    measurementReporter.current = report;
    const renderer = petRef.current?.querySelector('[data-renderer]');
    if (renderer) observer.observe(renderer, { attributes: true, attributeFilter: ['data-renderer'] });
    report();
    return () => { observer.disconnect(); measurementReporter.current = () => {}; };
  }, [hidden, mode]);

  useEffect(() => {
    if (!characterValidation || !desktop) return;
    const report = () => {
      const renderer = petRef.current?.querySelector<HTMLElement>('[data-renderer]');
      void invoke('validation_event', { event: {
        mode, renderer: renderer?.dataset.renderer ?? 'initializing', visible: !hidden,
        frameCount: Number(renderer?.dataset.frameCount ?? 0),
        x: positionRef.current.x, y: positionRef.current.y,
      } }).catch(() => {});
    };
    const observer = new MutationObserver(report);
    if (petRef.current) observer.observe(petRef.current, {
      subtree: true, attributes: true, attributeFilter: ['data-renderer'], childList: true,
    });
    report();
    const timer = window.setInterval(report, 1000);
    return () => { observer.disconnect(); window.clearInterval(timer); };
  }, [characterBackend, hidden, mode]);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel || !panelOpen) return;
    const observer = new ResizeObserver(() => setPanelSize({ width: panel.offsetWidth, height: panel.offsetHeight }));
    observer.observe(panel);
    return () => observer.disconnect();
  }, [panelOpen, settingsOpen]);

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let metricsAt = -Infinity;
    let origin: Point = { x: 0, y: 0 };
    let scale = 1;
    let failed = false;
    const win = getCurrentWindow();
    cursorInput.current ??= new CursorInputWriter(ignored => getCurrentWindow().setIgnoreCursorEvents(ignored));
    const input = cursorInput.current.acquire();
    const recordPollDelay = (delay: number | null) => {
      if (measurement && measurementPollMs.current !== delay) {
        measurementPollMs.current = delay;
        measurementReporter.current();
      }
    };
    const poll = async () => {
      if (disposed) return POINTER_FAR_MS;
      try {
        if (Date.now() - metricsAt >= 1000) {
          [origin, scale] = await Promise.all([win.outerPosition(), win.scaleFactor()]);
          metricsAt = Date.now();
        }
        if (disposed) return POINTER_FAR_MS;
        const cursor = physicalToLocal(await cursorPosition(), origin, scale);
        const regions = [petRef.current, panelRef.current]
          .filter((element): element is HTMLElement => element !== null)
          .map(element => element.getBoundingClientRect());
        const hit = drag.current !== null || regions.some(region => containsPoint(cursor, region, 3));
        if (disposed) return POINTER_FAR_MS;
        await input.set(!hit);
        if (disposed) return POINTER_FAR_MS;
        const delay = pointerPollDelay(cursor, regions, drag.current !== null);
        recordPollDelay(delay);
        return delay;
      } catch (value) {
        if (!failed) {
          failed = true;
          reportError(value, '마우스 통과 기능을 초기화하지 못했습니다. 앱을 다시 실행해 주세요.');
        }
        // Release the desktop if native hit testing fails mid-interaction.
        try { await input.set(true); } catch { /* Reported above. */ }
        if (!disposed) recordPollDelay(POINTER_FAR_MS);
        return POINTER_FAR_MS;
      }
    };
    if (hidden) {
      recordPollDelay(null);
      void input.set(true).catch(value => reportError(value, '창의 마우스 통과 상태를 변경하지 못했습니다.'));
    }
    const stop = startAdaptivePolling({ enabled: !hidden, poll });
    return () => {
      disposed = true;
      stop();
      void input.release().catch(() => {});
    };
  }, [hidden, reportError]);

  useEffect(() => {
    if (!desktop) return;
    invoke('set_panel_open', { open: panelOpen }).catch(value => reportError(value, '카드 창의 키보드 입력을 활성화하지 못했습니다.'));
  }, [panelOpen, reportError]);

  useEffect(() => {
    if (!panelOpen) return;
    const frame = requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus());
    return () => cancelAnimationFrame(frame);
  }, [panelOpen, settingsOpen]);

  const openSettings = useCallback(() => {
    if (measurement || characterValidation) return;
    movePet(positionRef.current, true);
    setDraft({ ...setupRef.current.config });
    setToken('');
    setDeckOpen(false);
    setSettingsOpen(true);
  }, [movePet]);

  const closePanel = useCallback(() => {
    if (measurement) return;
    setSettingsOpen(false);
    setDeckOpen(false);
    setToken('');
    petRef.current?.focus();
  }, []);

  const toggleDeck = useCallback(() => {
    if (measurement) return;
    movePet(positionRef.current, true);
    setSettingsOpen(false);
    setToken('');
    setDeckOpen(value => !value);
  }, [movePet]);

  const toggleRoaming = useCallback(async () => {
    if (measurement) return;
    if (mutationBusy.current) return;
    const current = setupRef.current;
    const config = { ...current.config, roamingEnabled: !current.config.roamingEnabled };
    if (!desktop || characterValidation) { setSetup(value => ({ ...value, config })); return; }
    const wasRefreshing = scheduler.current!.isRunning;
    mutationBusy.current = true;
    scheduler.current!.invalidate();
    let saved = false;
    try {
      const next = await provider.saveSetup(config, null);
      setupRef.current = next;
      setSetup(next);
      saved = true;
    } catch (value) { reportError(value, '산책 설정을 저장하지 못했습니다.'); }
    finally { mutationBusy.current = false; }
    if (saved && wasRefreshing) await scheduler.current!.request(true);
  }, [reportError]);

  async function changeCharacterBackend(backend: CharacterBackend) {
    if (measurement || backend === characterBackend || mutationBusy.current || !loaded) return;
    setCharacterError(null);
    if (!desktop || characterValidation) { setPreviewBackend(backend); return; }
    mutationBusy.current = true;
    setSelectingCharacter(true);
    try {
      const saved = await provider.setCharacterBackend(backend);
      if (!mounted.current) return;
      // A feed refresh may have finished during the save. Merge only this preference.
      setSetup(current => {
        const next = { ...current, config: { ...current.config, characterBackend: saved } };
        setupRef.current = next;
        return next;
      });
    } catch (value) {
      if (mounted.current) setCharacterError(errorMessage(value, '캐릭터 선택을 저장하지 못했습니다. 다시 시도해 주세요.'));
    } finally {
      mutationBusy.current = false;
      if (mounted.current) setSelectingCharacter(false);
    }
  }

  useEffect(() => {
    if (!desktop) return;
    let canceled = false;
    const cleanups: (() => void)[] = [];
    const register = async (name: string, handler: () => void) => {
      const unlisten = await listen(name, handler);
      if (canceled) unlisten(); else cleanups.push(unlisten);
    };
    Promise.all([
      register('toggle-deck', toggleDeck),
      register('toggle-roaming', () => void toggleRoaming()),
      register('open-settings', openSettings),
      register('reset-position', () => {
        const next = homePosition(boundsRef.current);
        movePet(next, true);
        setRoamRevision(value => value + 1);
      }),
    ]).catch(value => reportError(value, '트레이 메뉴를 연결하지 못했습니다.'));
    return () => { canceled = true; cleanups.forEach(cleanup => cleanup()); };
  }, [movePet, openSettings, reportError, toggleDeck, toggleRoaming]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && panelOpen) { event.preventDefault(); closePanel(); }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [closePanel, panelOpen]);

  function startDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (measurement) return;
    if (event.button !== 0) return;
    movePet(positionRef.current, true);
    drag.current = { pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, origin: { ...positionRef.current }, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }

  function moveDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.start.x;
    const dy = event.clientY - current.start.y;
    if (Math.hypot(dx, dy) > 5) current.moved = true;
    if (!current.moved) return;
    const next = clampPoint({ x: current.origin.x + dx, y: current.origin.y + dy }, PET, boundsRef.current);
    movePet(next, true);
  }

  function endDrag(event: ReactPointerEvent<HTMLButtonElement>, canceled = false) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!canceled && !current.moved) toggleDeck();
  }

  async function saveSetup(event: FormEvent) {
    event.preventDefault();
    if (!desktop || mutationBusy.current) return;
    if (!draft.viewId.trim()) { setError('Notion 뷰 URL 또는 뷰 ID를 입력해 주세요.'); return; }
    if (!setup.hasToken && !token.trim()) { setError('Notion 토큰을 입력해 주세요.'); return; }
    if (!Number.isFinite(draft.refreshSeconds) || draft.refreshSeconds < 30 || draft.refreshSeconds > 3600) {
      setError('새로고침 간격은 30초부터 3,600초 사이로 입력해 주세요.'); return;
    }
    mutationBusy.current = true;
    scheduler.current!.invalidate();
    setSaving(true);
    let saved = false;
    try {
      const next = await provider.saveSetup({ ...draft, viewId: draft.viewId.trim(), characterBackend: setupRef.current.config.characterBackend }, token.trim() || null);
      if (token.trim() || next.config.viewId !== setupRef.current.config.viewId) statusOptions.current.clear();
      setupRef.current = next;
      setSetup(next);
      setToken('');
      setSettingsOpen(false);
      setDeckOpen(true);
      setError(null);
      setStatusNotice(null);
      saved = true;
    } catch (value) { reportError(value, 'Notion 연결을 저장하지 못했습니다. 뷰와 토큰을 확인해 주세요.'); }
    finally { mutationBusy.current = false; if (mounted.current) setSaving(false); }
    if (saved) await scheduler.current!.request(true);
  }

  async function disconnect() {
    if (!desktop || mutationBusy.current) return;
    mutationBusy.current = true;
    scheduler.current!.invalidate();
    setSaving(true);
    try {
      await provider.disconnect();
      statusOptions.current.clear();
      const next = await provider.getSetup();
      setupRef.current = next;
      setSetup(next);
      setDraft(next.config);
      setToken('');
      setError(null);
      setStatusNotice(null);
    } catch (value) { reportError(value, '연결을 해제하지 못했습니다. 다시 시도해 주세요.'); }
    finally { mutationBusy.current = false; if (mounted.current) setSaving(false); }
  }

  async function updateStatus(id: string, fieldId: string, optionId: string) {
    if (!desktop || !navigator.onLine) throw new Error('온라인 상태의 데스크톱 앱에서 변경해 주세요.');
    if (mutationBusy.current) throw new Error('다른 변경을 처리하고 있습니다. 잠시 후 다시 시도해 주세요.');
    mutationBusy.current = true;
    setUpdatingStatus(true);
    setStatusNotice(null);
    scheduler.current!.invalidate();
    try {
      // Ignore and finish any older read before writing; it cannot replace the confirmed state.
      await scheduler.current!.waitForIdle();
      const result = await provider.updateCardStatus(id, fieldId, optionId);
      statusOptions.current.recordChange(id, fieldId, optionId);
      if (!mounted.current) return;
      const current = setupRef.current;
      const next = { ...current, snapshot: current.snapshot ? {
        ...current.snapshot,
        cards: current.snapshot.cards.map(card => card.id === result.card.id ? result.card : card),
      } : null };
      setupRef.current = next;
      setSetup(next);
      setError(null);
      setStatusNotice(result.warning ?? '상태를 변경했어요.');
    } finally {
      mutationBusy.current = false;
      if (mounted.current) setUpdatingStatus(false);
    }
    // Saved-view membership and sorting belong to Notion; never remove a card by guessing its filter.
    await scheduler.current!.request(true);
  }

  const panelPosition = placePanel(position, PET, panelSize, bounds);
  const issue = error || (!online ? '오프라인이에요. 다시 연결되면 카드를 새로고침합니다.' : null);
  const lastSuccess = snapshot ? shortTime(snapshot.refreshedAt) : null;

  return <main className={`scene ${desktop ? 'scene--desktop' : 'scene--preview'}`}
    data-measurement-state={measurement?.state} data-motion-state={mode} data-character-validation={characterValidation || undefined}>
    {characterValidation && <div className="validation-label">Rive 로컬 검증 · 합성 카드 6개 · {mode}</div>}
    {measurement && <div style={{ position: 'absolute', top: 12, left: 12, padding: '6px 10px', borderRadius: 6, background: '#fffdf5', color: '#657056', fontSize: 11 }}>
      측정 모드 / 합성 카드 20개 / {measurement.state}
    </div>}
    {!desktop && <>
      <div className="preview-heading"><span className="wordmark">card captor<span className="wordmark-dot">.</span></span><span className="preview-label"><span />브라우저 미리보기</span></div>
      <div className="preview-caption"><span className="eyebrow">A LITTLE DESKTOP COMPANION</span><p>필요한 카드를 챙겨 오는<br />작은 동료.</p><span>캡터를 눌러 카드 덱을 열고, 끌어서 옮겨 보세요.</span></div>
      <div className="preview-footnote">실제 Notion 연결은 데스크톱 앱에서 사용할 수 있어요.</div>
    </>}

    <button ref={petRef} className={`pet ${dragging ? 'pet--dragging' : ''}`} style={{ transform: `translate3d(${position.x}px, ${position.y}px, 0)` }}
      aria-label={`캡터, 카드 ${snapshot?.cards.length ?? 0}개. 눌러서 카드 덱 열기. 끌어서 이동.`}
      aria-expanded={panelOpen} aria-controls="captor-panel"
      onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={event => endDrag(event)}
      onPointerCancel={event => endDrag(event, true)} onLostPointerCapture={event => endDrag(event, true)}
      onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
      onClick={event => { if (event.detail === 0) toggleDeck(); }}
      onContextMenu={event => { event.preventDefault(); openSettings(); }}>
      {characterBackend === 'rive'
        ? <RiveCharacter state={mode} count={snapshot?.cards.length ?? 0} paused={hidden || reduceMotion} direction={directionRef} />
        : <Robot state={mode} count={snapshot?.cards.length ?? 0} paused={hidden || reduceMotion} />}
      <span className="pet-caption"><span className={`signal-dot ${issue ? 'signal-dot--warning' : connected ? 'signal-dot--connected' : ''}`} />{loaded ? stateLabels[mode] : '캡터가 일어나는 중'}</span>
    </button>

    {panelOpen && <section id="captor-panel" ref={panelRef} className={`panel ${settingsOpen ? 'panel--settings' : ''}`}
      style={{ left: panelPosition.x, top: panelPosition.y, maxHeight: Math.max(180, bounds.bottom - bounds.top - 28) }}
      aria-label={settingsOpen ? 'Notion 연결 설정' : '내 카드 덱'}>
      <header className="panel-header">
        <div><span className="eyebrow">{settingsOpen ? 'MAKE A CONNECTION' : 'YOUR LITTLE DECK'}</span><h1 tabIndex={-1} data-autofocus={!settingsOpen || undefined}>{settingsOpen ? 'Notion 연결하기' : '내 카드 덱'}{!settingsOpen && <span className="card-count">{snapshot?.cards.length ?? 0}</span>}</h1></div>
        <div className="header-actions">
          {!settingsOpen && !characterValidation && <button className="icon-button" aria-label="Notion 연결 설정" title="연결 설정" disabled={updatingStatus || selectingCharacter} onClick={openSettings}><Icon name="settings" /></button>}
          <button className="icon-button" aria-label="창 닫기" title="닫기 (Esc)" onClick={closePanel}><Icon name="close" /></button>
        </div>
      </header>

      {issue && <div className="notice notice--warning" role="status"><span aria-hidden="true">!</span><p>{issue}{snapshot && error && <small>마지막으로 가져온 카드는 그대로 보관하고 있어요.</small>}</p></div>}

      {settingsOpen ? <form onSubmit={saveSetup} className="settings-form">
        <p className="panel-description">평소 쓰던 Notion 뷰의 카드들을<br />캡터가 그대로 챙겨 올게요.</p>
        {!desktop && <div className="notice notice--preview"><p>브라우저 미리보기입니다. 토큰 입력과 연결은 데스크톱 앱에서 사용할 수 있어요.</p></div>}
        <label className="field">Notion 뷰 URL 또는 ID
          <input data-autofocus value={draft.viewId} onChange={event => setDraft(value => ({ ...value, viewId: event.target.value }))} placeholder="https://www.notion.so/…?v=…" autoComplete="off" spellCheck={false} disabled={!desktop || saving} required={desktop} />
          <span className="field-help">원하는 필터와 정렬을 적용한 뷰의 링크를 넣어 주세요.</span>
        </label>
        <label className="field">Notion 토큰 {setup.hasToken && <span className="saved-badge">저장됨</span>}
          <input type="password" value={token} onChange={event => setToken(event.target.value)} placeholder={setup.hasToken ? '기존 토큰 사용 · 교체할 때만 입력' : 'ntn_…'} autoComplete="off" spellCheck={false} disabled={!desktop || saving} required={desktop && !setup.hasToken} />
          <span className="field-help">담당자 ‘나’ 조건이 있는 뷰에는 개인 액세스 토큰(PAT)을 사용해 주세요. 상태 변경에는 원본 페이지의 콘텐츠 업데이트 권한이 필요해요.</span>
        </label>
        <div className="settings-row"><label className="field interval-field">새로고침 간격<div className="number-input"><input type="number" min={30} max={3600} step={1} value={draft.refreshSeconds} onChange={event => setDraft(value => ({ ...value, refreshSeconds: event.target.valueAsNumber }))} disabled={!desktop || saving} /><span>초</span></div></label><span className="interval-note">최소 30초<br />기본 1분</span></div>
        <label className="checkbox-field"><input type="checkbox" checked={draft.roamingEnabled} onChange={event => setDraft(value => ({ ...value, roamingEnabled: event.target.checked }))} disabled={!desktop || saving} /><span>카드 덱을 닫으면 자유롭게 산책하기</span></label>
        <p className="privacy-note"><span aria-hidden="true">⌑</span>토큰은 기기의 보안 저장소에 보관해요.</p>
        <button type="submit" className="primary-button" disabled={!desktop || saving}>{saving ? '연결 저장 중…' : '연결하고 카드 가져오기'}<span aria-hidden="true">↗</span></button>
        {setup.hasToken && <button type="button" className="text-button disconnect-button" onClick={() => void disconnect()} disabled={saving}>Notion 연결 해제</button>}
      </form> : <>
        <div className="feed-bar"><span className="source-label"><span className="notion-mark">N</span>{characterValidation ? '로컬 샘플' : 'Notion'}<span className="source-divider">/</span>{characterValidation ? '검증용 카드' : connected ? '연결된 뷰' : '연결 대기'}</span><button className={`icon-button refresh-button ${refreshing ? 'is-refreshing' : ''}`} aria-label="카드 새로고침" title="새로고침" disabled={!desktop || !connected || refreshing || updatingStatus || selectingCharacter || !online} onClick={() => void refresh()}><Icon name="refresh" /></button></div>
        {statusNotice && <p className="status-notice" role="status">{statusNotice}</p>}
        {snapshot && snapshot.cards.length > 0 ? <ol className="card-list">{snapshot.cards.map((card, index) => <li key={card.id} className="task-card-row">
          <span className="card-index">{String(index + 1).padStart(2, '0')}</span>
          <div className="card-content">
            <button className="task-card task-card--title" onClick={() => provider.openCard(card.id).catch(value => reportError(value, 'Notion 페이지를 열지 못했습니다. 다시 시도해 주세요.'))} disabled={!desktop || characterValidation}>
              <span className="card-title">{card.title || '제목 없음'}</span><span className="card-open"><Icon name="arrow" /></span>
            </button>
            {card.dueAt && <span className="due-date">{dueDate(card.dueAt)}</span>}
            <StatusEditor cardId={card.id} title={card.title || '제목 없음'} status={card.status} statusColor={card.statusColor}
              disabled={!desktop || !connected || !online || refreshing || saving || updatingStatus || selectingCharacter || !!measurement}
              getCached={() => statusOptions.current.get(card.id)}
              load={() => statusOptions.current.refresh(card.id, () => provider.getCardStatus(card.id))}
              onChange={(fieldId, optionId) => updateStatus(card.id, fieldId, optionId)} />
          </div>
        </li>)}</ol> : <div className="empty-state"><div className="empty-deck" aria-hidden="true"><span /><span /><span><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m6 12 4 4 8-9" /></svg></span></div><h2>{refreshing ? '카드를 챙겨 오는 중이에요' : connected ? '지금은 해당하는 카드가 없어요' : '아직 챙겨 온 카드가 없어요'}</h2><p>{connected ? 'Notion 뷰의 필터에 맞는 페이지가 생기면\n여기에 차곡차곡 모아 둘게요.' : '자주 보는 Notion 뷰를 연결해 주세요.\n필요한 카드들만 곁에 둘 수 있어요.'}</p>{!connected && <button className="connect-button" onClick={openSettings}>Notion 뷰 연결하기<span aria-hidden="true">↗</span></button>}</div>}
        {snapshot?.warning && <div className="feed-warning" role="status">{snapshot.warning}</div>}
        {snapshot?.hasMore && <p className="more-note">카드가 더 있어요. 목록 일부를 표시하고 있습니다.</p>}
        <div className="character-controls" role="group" aria-label="캐릭터 선택" aria-busy={selectingCharacter}>
          <span>캐릭터</span>
          <div className="character-options">
            <button aria-pressed={characterBackend === 'robot'} disabled={!loaded || selectingCharacter || saving || updatingStatus || !!measurement}
              onClick={() => void changeCharacterBackend('robot')}>기본 로봇</button>
            <button aria-pressed={characterBackend === 'rive'} disabled={!loaded || selectingCharacter || saving || updatingStatus || !!measurement}
              onClick={() => void changeCharacterBackend('rive')}>Rive · Centaur</button>
          </div>
          {selectingCharacter && <span className="character-saving" role="status">저장 중…</span>}
        </div>
        {characterError && <p className="character-setting-error" role="alert">{characterError}</p>}
        <footer className="panel-footer"><span className={error && snapshot ? 'stale-label' : ''}>{refreshing ? '카드 새로고침 중…' : lastSuccess ? `${lastSuccess}에 마지막으로 가져왔어요${error ? ' · 이전 카드' : ''}` : desktop ? '연결하면 카드를 가져올게요' : '브라우저 미리보기 · 카드 0개'}</span><button className="icon-button roam-button" aria-label={setup.config.roamingEnabled ? '산책 잠시 멈추기' : '산책 다시 시작하기'} title={setup.config.roamingEnabled ? '산책 잠시 멈추기' : '산책 다시 시작하기'} disabled={selectingCharacter} onClick={() => void toggleRoaming()}><Icon name={setup.config.roamingEnabled ? 'pause' : 'play'} /></button></footer>
      </>}
    </section>}
  </main>;
}
