import welluniImage from './assets/characters/welluni.png';

export type CharacterId = 'robot' | 'welluni';

export const CHARACTERS = [
  { id: 'robot', name: '캡터', role: '작은 카드 배달부', description: '필요한 카드를 꼼꼼히 챙겨요.', image: null },
  { id: 'welluni', name: '웰루니', role: '좋은잠 웰룬의 막내 엔지니어', description: '초승달을 달고 곁에서 함께해요.', image: welluniImage },
] as const;

export function getCharacter(id: CharacterId) {
  return CHARACTERS.find(character => character.id === id) ?? CHARACTERS[0];
}

const PREVIEW_KEY = 'card-captor.character';

export function readPreviewCharacter(): CharacterId {
  try {
    return localStorage.getItem(PREVIEW_KEY) === 'welluni' ? 'welluni' : 'robot';
  } catch { return 'robot'; }
}

export function savePreviewCharacter(id: CharacterId): CharacterId {
  try { localStorage.setItem(PREVIEW_KEY, id); }
  catch { throw new Error('캐릭터를 저장하지 못했어요. 브라우저의 로컬 저장소 설정을 확인해 주세요.'); }
  return id;
}
