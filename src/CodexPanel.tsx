import { codex, codexLine, codexTaskContent, codexTitle, CODEX_PHASE_LABELS, type CodexPhase, type CodexPreferences, type CodexSnapshot } from './codex';
import { desktop } from './provider';

function FeedItem({ threadId, title, content, phase, stale = false, time, onError }: {
  threadId: string; title: string; content: string; phase: CodexPhase; stale?: boolean; time?: string; onError: (error: unknown) => void;
}) {
  const heading = codexTitle(title);
  const body = codexLine(content);
  return <button className="codex-feed-item" data-phase={phase} data-stale={stale} disabled={!desktop}
    title={`${heading}\n${body}`} aria-label={`${heading}. ${body}. Codex에서 열기`}
    onClick={() => void codex.open(threadId).catch(onError)}>
    <span className="codex-feed-heading"><span className="codex-activity-dot" data-phase={phase} aria-hidden="true" />
      <strong>{heading}</strong>{time && <time dateTime={time}>{new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit' }).format(new Date(time))}</time>}
      <span className="codex-feed-arrow" aria-hidden="true">↗</span>
    </span>
    <span className="codex-feed-content">{body}</span>
  </button>;
}

export function CodexPanel({ snapshot, error, saving, onSave, onError }: {
  snapshot: CodexSnapshot; error: string | null; saving: boolean;
  onSave: (preferences: CodexPreferences) => void; onError: (error: unknown) => void;
}) {
  const connection = snapshot.connection === 'connected' ? '연결됨' : snapshot.connection === 'connecting' ? '연결 중' : snapshot.connection === 'disabled' || !snapshot.preferences.enabled ? '관측 꺼짐' : desktop ? '연결 대기' : '미리보기';
  return <div className="codex-panel">
    <div className="codex-connection"><span className={`signal-dot ${snapshot.connection === 'connected' ? 'signal-dot--connected' : ''}`} /><strong>Codex</strong><span>{connection}</span><span className="codex-readonly">읽기 전용</span></div>
    <div className="codex-controls">
      <label className="checkbox-field"><input type="checkbox" checked={snapshot.preferences.enabled} disabled={saving}
        onChange={event => onSave({ ...snapshot.preferences, enabled: event.target.checked })} /><span>Codex 작업 따라가기</span></label>
      <div className="codex-alert-controls">
        <label className="checkbox-field"><input type="checkbox" checked={snapshot.preferences.notifications} disabled={saving}
          onChange={event => onSave({ ...snapshot.preferences, notifications: event.target.checked })} /><span>알림</span></label>
        <label className="checkbox-field"><input type="checkbox" checked={snapshot.preferences.sound} disabled={saving}
          onChange={event => onSave({ ...snapshot.preferences, sound: event.target.checked })} /><span>사운드</span></label>
        <button className="text-button" disabled={saving || !desktop || !snapshot.preferences.enabled} onClick={() => void codex.testAlert().catch(onError)}>알림 테스트</button>
      </div>
    </div>
    {(error || snapshot.deliveryWarning) && <p className="codex-warning" role="status">{error || snapshot.deliveryWarning}</p>}
    {!desktop && <div className="codex-preview-tools"><p>합성 시나리오로 반응을 확인해 보세요.</p><div>
      <button onClick={() => codex.simulate('running')}>작업 시작</button><button onClick={() => codex.simulate('progress')}>진행 갱신</button><button onClick={() => codex.simulate('needsInput')}>확인 요청</button>
      <button onClick={() => codex.simulate('ready')}>완료</button><button onClick={() => codex.simulate('blocked')}>실패</button><button onClick={() => codex.simulate('reset')}>초기화</button>
    </div></div>}
    <p className="codex-detail" role="status">{snapshot.detail}</p>
    {snapshot.tasks.length > 0 ? <ul className="codex-tasks">{snapshot.tasks.map(task => <li key={task.id}>
      <FeedItem threadId={task.id} title={task.title} phase={task.phase} stale={task.stale} onError={onError}
        content={`${task.stale ? '마지막 확인 상태' : CODEX_PHASE_LABELS[task.phase]}${task.summary ? ` · ${codexTaskContent(task)}` : ''}`} />
    </li>)}</ul> : <div className="codex-empty"><span aria-hidden="true">✧</span><h2>{snapshot.preferences.enabled ? '작업이 시작되면 여기에서 만나요' : '잠시 쉬고 있어요'}</h2><p>{desktop ? 'Codex 앱에서 대화를 열면\n작업 상태와 결과를 챙겨 올게요.' : '데스크톱 앱에서 실제 Codex 작업을 따라가요.\n위 시나리오로 피드와 알림을 확인할 수 있어요.'}</p></div>}
    {snapshot.activities.length > 0 && <section className="codex-activity" aria-label="최근 Codex 활동"><h2>최근 활동</h2><ol>{snapshot.activities.slice(0, 12).map(item => <li key={item.id}>
      <FeedItem threadId={item.threadId} title={item.title} content={item.message} phase={item.phase} time={item.at} onError={onError} />
    </li>)}</ol></section>}
    <p className="codex-scope">열린 창에서 발견한 로컬 작업을 최대 12개 따라가요.<br />승인과 답변은 Codex 앱에서 진행해 주세요.</p>
  </div>;
}
