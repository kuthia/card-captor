import { DEFAULT_CONFIG, type SetupStatus } from './contracts';

export type MeasurementState = 'idle' | 'moving' | 'cards';
export interface MeasurementConfig { version: 1; state: MeasurementState; cardCount: 20 }

/** Only the feature-gated native launcher supplies this immutable startup value. */
export function parseMeasurementConfig(value: unknown): MeasurementConfig | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || candidate.cardCount !== 20
    || !['idle', 'moving', 'cards'].includes(String(candidate.state))) return null;
  return { version: 1, state: candidate.state as MeasurementState, cardCount: 20 };
}

export const measurement = typeof window === 'undefined' ? null : parseMeasurementConfig(
  (window as unknown as Record<string, unknown>).__CARD_CAPTOR_MEASUREMENT__,
);

/** Equal local fixtures in all states: no credentials, storage, or remote requests. */
export function measurementSetup(): SetupStatus {
  return {
    config: { ...DEFAULT_CONFIG },
    hasToken: false,
    snapshot: {
      refreshedAt: '2026-11-17T00:00:00Z',
      hasMore: false,
      cards: Array.from({ length: 20 }, (_, index) => ({
        id: `measurement-${index + 1}`,
        source: 'notion' as const,
        title: `측정용 합성 카드 ${String(index + 1).padStart(2, '0')}`,
        url: 'https://www.notion.so/',
        status: index % 3 === 0 ? '진행 중' : '다음 행동',
        dueAt: '2026-11-18',
      })),
    },
  };
}

export function seededMeasurementRandom(): () => number {
  let seed = 0x43415244;
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
}
