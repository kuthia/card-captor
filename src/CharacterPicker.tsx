import { CHARACTERS, getCharacter, type CharacterId } from './characters';
import { CharacterStill } from './CharacterStill';

export function CharacterPicker({ selected, pending, disabled, error, onSelect }: {
  selected: CharacterId;
  pending: CharacterId | null;
  disabled: boolean;
  error: string | null;
  onSelect: (id: CharacterId) => void;
}) {
  return <div className="character-picker" aria-busy={pending !== null}>
    <p className="panel-description">카드를 챙겨 올 작은 동료를 골라 주세요.<br />선택하면 바로 곁에 나타나요.</p>
    {/* Keep radio focus through async saves so consecutive arrow keys keep working. */}
    <fieldset className="character-options" aria-disabled={disabled}>
      <legend className="sr-only">함께할 캐릭터</legend>
      {CHARACTERS.map(character => <label key={character.id} className="character-option" data-selected={selected === character.id}>
        <input type="radio" name="character" value={character.id} checked={selected === character.id}
          aria-disabled={disabled} onChange={() => { if (!disabled) onSelect(character.id); }} />
        <span className="character-option-art"><CharacterStill characterId={character.id} /></span>
        <span className="character-option-name">{character.name}<span className="character-option-check" aria-hidden="true">{selected === character.id ? '✓' : ''}</span></span>
        <span className="character-option-role">{character.role}</span>
        <span className="character-option-description">{character.description}</span>
      </label>)}
    </fieldset>
    <p className="character-selection-status" role="status">{pending ? `${getCharacter(pending).name}를 불러오는 중…` : `${getCharacter(selected).name}와 함께하고 있어요.`}</p>
    {error && <p className="character-selection-error" role="alert">{error}</p>}
    <p className="character-picker-note">선택한 캐릭터는 다음에 켤 때도 함께해요.</p>
  </div>;
}
