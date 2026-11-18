/** Provider-independent presentation contract. Native credentials never cross back into the UI. */
export interface CardSummary {
  id: string;
  source: 'notion';
  title: string;
  url: string;
  status?: string;
  statusColor?: string;
  dueAt?: string;
}

export interface FeedSnapshot {
  cards: CardSummary[];
  refreshedAt: string;
  hasMore: boolean;
  warning?: string;
}

/** Provider-owned field and option IDs; the UI never invents workflow states. */
export interface StatusOption {
  id: string;
  name: string;
  color?: string;
}

export interface CardStatusField {
  id: string;
  name: string;
  currentOptionId?: string | null;
  options: StatusOption[];
}

export interface CardStatusEditor {
  cardId: string;
  fields: CardStatusField[];
}

export interface StatusUpdateResult {
  card: CardSummary;
  warning?: string;
}

export type CharacterBackend = 'robot' | 'rive';

export interface AppConfig {
  viewId: string;
  refreshSeconds: number;
  roamingEnabled: boolean;
  characterBackend: CharacterBackend;
}

export interface SetupStatus {
  config: AppConfig;
  hasToken: boolean;
  snapshot: FeedSnapshot | null;
}

export const DEFAULT_CONFIG: AppConfig = {
  viewId: '',
  refreshSeconds: 60,
  roamingEnabled: true,
  characterBackend: 'robot',
};

export interface CardProvider {
  getSetup(): Promise<SetupStatus>;
  saveSetup(config: AppConfig, token: string | null): Promise<SetupStatus>;
  setCharacterBackend(backend: CharacterBackend): Promise<CharacterBackend>;
  refresh(): Promise<FeedSnapshot>;
  disconnect(): Promise<void>;
  openCard(id: string): Promise<void>;
  getCardStatus(id: string): Promise<CardStatusEditor>;
  updateCardStatus(id: string, fieldId: string, optionId: string): Promise<StatusUpdateResult>;
}
