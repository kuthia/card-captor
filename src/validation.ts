import { DEFAULT_CONFIG, type SetupStatus } from './contracts';

/** The native feature-gated launcher supplies this exact, immutable schema. */
export function parseCharacterValidation(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).length === 2 && Object.hasOwn(candidate, 'version')
    && Object.hasOwn(candidate, 'backend') && candidate.version === 1 && candidate.backend === 'rive';
}

export const characterValidation = typeof window !== 'undefined' && parseCharacterValidation(
  (window as unknown as Record<string, unknown>).__CARD_CAPTOR_CHARACTER_VALIDATION__,
);

/** Interactive local cards; no real account, credentials, or persisted state. */
export function validationSetup(): SetupStatus {
  const statuses = [
    { name: '다음 행동', color: 'gray' },
    { name: '진행 중', color: 'blue' },
    { name: '완료', color: 'green' },
  ];
  return {
    config: { ...DEFAULT_CONFIG },
    hasToken: false,
    snapshot: {
      refreshedAt: '2026-11-18T00:00:00Z',
      hasMore: false,
      warning: 'Rive 로컬 검증용 합성 카드입니다.',
      cards: Array.from({ length: 6 }, (_, index) => ({
        id: `character-validation-${index + 1}`,
        source: 'notion' as const,
        title: `Rive 검증 카드 ${index + 1}`,
        url: '',
        status: statuses[index % statuses.length].name,
        statusColor: statuses[index % statuses.length].color,
        dueAt: '2026-11-18',
      })),
    },
  };
}
