import { getCharacter, type CharacterId } from './characters';
import { ROBOT_BODY, ROBOT_EYES, ROBOT_SHADOW } from './renderer/art';

/** Trusted bundled art, shared by the picker and the renderer's static fallback. */
export function CharacterStill({ characterId, lifted = false }: { characterId: CharacterId; lifted?: boolean }) {
  const character = getCharacter(characterId);
  return <svg viewBox="0 0 168 160" fill="none" aria-hidden="true" className="character-still">
    <g dangerouslySetInnerHTML={{ __html: ROBOT_SHADOW }} />
    <g transform={lifted ? 'rotate(-7 75 140) translate(0 -5)' : undefined}>
      {character.image
        ? <image href={character.image} width="168" height="160" />
        : <g dangerouslySetInnerHTML={{ __html: ROBOT_BODY + ROBOT_EYES }} />}
    </g>
  </svg>;
}
