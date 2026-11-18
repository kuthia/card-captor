import { invoke, isTauri } from '@tauri-apps/api/core';
import { DEFAULT_CONFIG, type AppConfig, type CardProvider, type CardStatusEditor, type FeedSnapshot, type SetupStatus, type StatusUpdateResult } from './contracts';
import { measurement, measurementSetup } from './benchmark';
import { readPreviewCharacter, savePreviewCharacter, type CharacterId } from './characters';

export const desktop = isTauri();
const previewError = () => Promise.reject(new Error('데스크톱 앱에서 Notion을 연결해 주세요.'));
const measurementError = () => Promise.reject(new Error('측정 모드에서는 연결과 외부 동작을 변경하지 않습니다.'));

export const provider: CardProvider = measurement ? {
  getSetup: async () => measurementSetup(),
  setCharacter: measurementError,
  saveSetup: measurementError,
  refresh: measurementError,
  disconnect: measurementError,
  openCard: measurementError,
  getCardStatus: measurementError,
  updateCardStatus: measurementError,
} : desktop ? {
  getSetup: () => invoke<SetupStatus>('get_setup'),
  setCharacter: id => invoke<CharacterId>('set_character', { characterId: id }),
  saveSetup: (config: AppConfig, token: string | null) => invoke<SetupStatus>('save_setup', { config, token }),
  refresh: () => invoke<FeedSnapshot>('refresh_feed'),
  disconnect: () => invoke<void>('disconnect'),
  openCard: (id: string) => invoke<void>('open_card', { id }),
  getCardStatus: (id: string) => invoke<CardStatusEditor>('get_card_status', { id }),
  updateCardStatus: (id: string, fieldId: string, optionId: string) => invoke<StatusUpdateResult>('update_card_status', { id, fieldId, optionId }),
} : {
  getSetup: async () => ({ config: { ...DEFAULT_CONFIG, characterId: readPreviewCharacter() }, hasToken: false, snapshot: null }),
  setCharacter: async id => savePreviewCharacter(id),
  saveSetup: previewError,
  refresh: previewError,
  disconnect: previewError,
  openCard: previewError,
  getCardStatus: previewError,
  updateCardStatus: previewError,
};

export function errorMessage(error: unknown, fallback: string): string {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /[가-힣]/.test(text) ? text : fallback;
}
