/**
 * Figma-style custom cursors (SVG data URIs with hotspots). Each tool and
 * hover target gets its own cursor so the pointer always says what a drag will do.
 */
const svg = (body: string, size = 24) =>
  `url("data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}' viewBox='0 0 24 24'>${body}</svg>`)}")`;

const OUTLINE = "stroke='white' stroke-width='1.6' stroke-linejoin='round'";

export const CURSORS = {
  /** default select arrow, dark body with white outline (Figma-like) */
  select: `${svg(`<path d='M4 2.5l14.5 8-6.5 1.6-3.2 6.4z' fill='#111' ${OUTLINE}/>`)} 4 3, default`,
  /** arrow with a violet accent for interactive items */
  pointer: `${svg(`<path d='M4 2.5l14.5 8-6.5 1.6-3.2 6.4z' fill='#8b6cff' ${OUTLINE}/>`)} 4 3, pointer`,
  /** move: arrow + four-way badge */
  move: `${svg(`<path d='M4 2.5l12 6.6-5.4 1.4-2.6 5.3z' fill='#111' ${OUTLINE}/><g transform='translate(13 13)' fill='#111' stroke='white' stroke-width='1.2'><path d='M5 0l2 2.5H6v2h2V3.5L10.5 5 8 7V6H6v2h1L5 10 3 8h1V6H2v1L0 5l2-2v1h2V2.5H3z'/></g>`)} 4 3, move`,
  /** blade / razor tool */
  blade: `${svg(`<g fill='none' stroke='#111' stroke-width='3.4' stroke-linecap='round'><circle cx='6' cy='6' r='2.6'/><circle cx='6' cy='18' r='2.6'/><path d='M8 7.5L21 18M8 16.5L21 6'/></g><g fill='none' stroke='white' stroke-width='1.6' stroke-linecap='round'><circle cx='6' cy='6' r='2.6'/><circle cx='6' cy='18' r='2.6'/><path d='M8 7.5L21 18M8 16.5L21 6'/></g>`)} 12 12, crosshair`,
  /** hand (pan) */
  hand: `${svg(`<path d='M8 11V5.5a1.5 1.5 0 0 1 3 0V10V4.5a1.5 1.5 0 0 1 3 0V10V6a1.5 1.5 0 0 1 3 0v6c0 4-2.5 8-7 8-3 0-4.5-1.5-6-4l-2-3.5a1.5 1.5 0 0 1 2.6-1.5L8 13z' fill='white' stroke='#111' stroke-width='1.4' stroke-linejoin='round'/>`)} 12 12, grab`,
  grabbing: `${svg(`<path d='M7 11V9a1.5 1.5 0 0 1 3 0V10V8.5a1.5 1.5 0 0 1 3 0V10V9a1.5 1.5 0 0 1 3 0v3c0 4-2.5 8-7 8-3 0-4.5-1.5-6-4l-1-2a1.5 1.5 0 0 1 2.6-1.5L7 14z' fill='white' stroke='#111' stroke-width='1.4' stroke-linejoin='round'/>`)} 12 12, grabbing`,
  /** trim edges: bracket with arrow */
  trimLeft: `${svg(`<path d='M10 4h-4v16h4M14 12h7M18 9l3 3-3 3' fill='none' stroke='#111' stroke-width='3.4' stroke-linecap='round' stroke-linejoin='round'/><path d='M10 4h-4v16h4M14 12h7M18 9l3 3-3 3' fill='none' stroke='white' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/>`)} 6 12, ew-resize`,
  trimRight: `${svg(`<path d='M14 4h4v16h-4M10 12H3M6 9l-3 3 3 3' fill='none' stroke='#111' stroke-width='3.4' stroke-linecap='round' stroke-linejoin='round'/><path d='M14 4h4v16h-4M10 12H3M6 9l-3 3 3 3' fill='none' stroke='white' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/>`)} 18 12, ew-resize`,
  /** playhead scrub */
  scrub: `${svg(`<path d='M12 2v20' stroke='#111' stroke-width='3.4'/><path d='M12 2v20' stroke='#ff7a3d' stroke-width='1.6'/><path d='M7 3h10l-5 5z' fill='#ff7a3d' stroke='white' stroke-width='1.2'/>`)} 12 4, ew-resize`,
  /** scale handles */
  nwse: `${svg(`<path d='M5 5l14 14M5 5h5M5 5v5M19 19h-5M19 19v-5' fill='none' stroke='#111' stroke-width='3.4' stroke-linecap='round'/><path d='M5 5l14 14M5 5h5M5 5v5M19 19h-5M19 19v-5' fill='none' stroke='white' stroke-width='1.6' stroke-linecap='round'/>`)} 12 12, nwse-resize`,
  nesw: `${svg(`<path d='M19 5L5 19M19 5h-5M19 5v5M5 19h5M5 19v-5' fill='none' stroke='#111' stroke-width='3.4' stroke-linecap='round'/><path d='M19 5L5 19M19 5h-5M19 5v5M5 19h5M5 19v-5' fill='none' stroke='white' stroke-width='1.6' stroke-linecap='round'/>`)} 12 12, nesw-resize`,
  rotate: `${svg(`<path d='M19 12a7 7 0 1 1-2.1-5M19 4v4h-4' fill='none' stroke='#111' stroke-width='3.4' stroke-linecap='round'/><path d='M19 12a7 7 0 1 1-2.1-5M19 4v4h-4' fill='none' stroke='white' stroke-width='1.6' stroke-linecap='round'/>`)} 12 12, alias`,
  text: `${svg(`<path d='M9 4h6M9 20h6M12 4v16' stroke='#111' stroke-width='3.4' stroke-linecap='round'/><path d='M9 4h6M9 20h6M12 4v16' stroke='white' stroke-width='1.6' stroke-linecap='round'/>`)} 12 12, text`,
} as const;

/** Install the cursors as CSS custom properties so stylesheets can use var(--cur-*). */
export function installCursors() {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(CURSORS)) root.style.setProperty(`--cur-${k}`, v);
}
