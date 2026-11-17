import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { StatusEditor } from './StatusEditor';

describe('status change entry point', () => {
  it('exposes a separate status control without fetching or writing during card rendering', () => {
    const load = vi.fn();
    const onChange = vi.fn();
    const html = renderToStaticMarkup(<StatusEditor cardId="card-one" title="검토할 작업" status="검토 대기" statusColor="purple"
      disabled={false} load={load} onChange={onChange} />);
    expect(load).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(html).toContain('aria-label="검토할 작업 상태 변경, 현재 검토 대기"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-color="purple"');
    expect(html).toContain('검토 대기</span>');
    expect(html).not.toContain('<section');
    expect(html).not.toContain('<a ');
  });

  it('keeps an unavailable empty-status control explicit and disabled', () => {
    const html = renderToStaticMarkup(<StatusEditor cardId="card-two" title="새 작업" disabled
      load={vi.fn()} onChange={vi.fn()} />);
    expect(html).toContain('상태 변경</span>');
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-label="새 작업 상태 변경"');
  });
});
