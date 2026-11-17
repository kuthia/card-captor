/** Original, trusted code-native art shared by WebGL and the static SVG fallback. */
export const ROBOT_BODY = `
  <path d="M61 119v18H48" stroke="#343934" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M90 119v18h13" stroke="#343934" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="51" y="88" width="50" height="39" rx="15" fill="#EDB35B" stroke="#343934" stroke-width="3"/>
  <path d="M65 101h22" stroke="#FFF5DB" stroke-width="3" stroke-linecap="round"/>
  <circle cx="76" cy="114" r="3" fill="#343934"/>
  <path d="M51 97c-13 3-14 12-9 15" stroke="#343934" stroke-width="8" stroke-linecap="round"/>
  <path d="M99 98c10 4 13 5 21-1" stroke="#343934" stroke-width="8" stroke-linecap="round"/>
  <path d="M75 32V21" stroke="#343934" stroke-width="3" stroke-linecap="round"/>
  <circle cx="75" cy="17" r="5" fill="#EDB35B" stroke="#343934" stroke-width="2.5"/>
  <rect x="29" y="51" width="10" height="23" rx="5" fill="#EDB35B" stroke="#343934" stroke-width="3"/>
  <rect x="109" y="51" width="10" height="23" rx="5" fill="#EDB35B" stroke="#343934" stroke-width="3"/>
  <rect x="36" y="32" width="76" height="61" rx="23" fill="#FFF7E7" stroke="#343934" stroke-width="3"/>
  <rect x="46" y="44" width="56" height="33" rx="13" fill="#343934"/>
  <path d="M70 67c2 2 6 2 8 0" stroke="#B8D8B5" stroke-width="2" stroke-linecap="round"/>
  <rect x="119" y="71" width="31" height="42" rx="5" transform="rotate(14 119 71)" fill="#BAD4BD" stroke="#343934" stroke-width="2"/>
  <rect x="112" y="68" width="31" height="42" rx="5" transform="rotate(3 112 68)" fill="#F7D28E" stroke="#343934" stroke-width="2"/>
  <rect x="105" y="70" width="31" height="42" rx="5" transform="rotate(-9 105 70)" fill="#FFFAEF" stroke="#343934" stroke-width="2"/>
  <path d="m113 80 13-2m-12 10 12-2m-11 9 8-1" stroke="#A3AA99" stroke-width="2" stroke-linecap="round"/>
  <circle cx="114" cy="106" r="5" fill="#EDB35B" stroke="#343934" stroke-width="2.5"/>
`;

export const ROBOT_EYES = '<g fill="#B8D8B5"><rect x="58" y="54" width="7" height="11" rx="3.5"/><rect x="83" y="54" width="7" height="11" rx="3.5"/></g>';
export const ROBOT_SHADOW = '<ellipse cx="77" cy="146" rx="43" ry="6" fill="#343934" fill-opacity=".12"/>';

export function robotTextureSvg(resolution: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${168 * resolution}" height="${160 * resolution}" viewBox="0 0 168 160" fill="none">${ROBOT_BODY}</svg>`;
}
