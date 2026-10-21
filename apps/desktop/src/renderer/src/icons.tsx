/** Minimal stroke icon set (24×24, 1.8px strokes) drawn for MOTIF. */
import type { CSSProperties } from "react";

const P: Record<string, string> = {
  media: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  audio: "M9 18V6l11-2v12M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm11-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
  text: "M5 6V4h14v2M12 4v16M9 20h6",
  shapes: "M4 14h7v7H4zM17.5 3l4.5 8h-9zM17.5 14a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7z",
  effects: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z",
  transitions: "M4 5h7v14H4zM13 5h7v14h-7M9 9l3 3-3 3",
  captions: "M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-4 3v-3H5a2 2 0 0 1-2-2zM7 10h4M13 10h4M7 13h10",
  ai: "M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2M9 9h6v6H9z",
  filters: "M8 8a5 5 0 1 0 0 0zM8 3a5 5 0 1 1 0 10A5 5 0 0 1 8 3zm8 6a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm-4 6a5 5 0 1 1 0 6",
  select: "M5 3l13 7-6 1.5L9.5 18z",
  blade: "M6 6a2.5 2.5 0 1 0 0 .01M6 18a2.5 2.5 0 1 0 0 .01M8 7.5L20 18M8 16.5L20 6",
  hand: "M8 11V5.5a1.5 1.5 0 0 1 3 0V10m0-5.5a1.5 1.5 0 0 1 3 0V10m0-4a1.5 1.5 0 0 1 3 0v6c0 4-2.5 8-7 8-3 0-4.5-1.5-6-4l-2-3.5a1.5 1.5 0 0 1 2.6-1.5L8 13",
  undo: "M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3",
  redo: "M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3",
  split: "M12 3v18M5 8l-2 4 2 4M19 8l2 4-2 4",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  play: "M7 4l13 8-13 8z",
  pause: "M7 4h3v16H7zM14 4h3v16h-3z",
  prev: "M19 5v14l-9-7zM6 5v14",
  next: "M5 5v14l9-7zM18 5v14",
  stepb: "M15 6l-6 6 6 6",
  stepf: "M9 6l6 6-6 6",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zm10-3a3 3 0 1 1 0 6 3 3 0 0 1 0-6z",
  eyeoff: "M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.3 4M6.6 6.6C3.8 8.4 2 12 2 12s4 7 10 7a9.6 9.6 0 0 0 5.4-1.6",
  lock: "M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3",
  unlock: "M6 11h12v9H6zM8 11V8a4 4 0 0 1 7.5-2",
  volume: "M4 9h4l5-4v14l-5-4H4zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11",
  mute: "M4 9h4l5-4v14l-5-4H4zM17 9l5 6M22 9l-5 6",
  plus: "M12 5v14M5 12h14",
  crop: "M6 2v14a2 2 0 0 0 2 2h14M2 6h14a2 2 0 0 1 2 2v14",
  adjust: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4",
  fullscreen: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  export: "M12 3v12M7 8l5-5 5 5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4",
  search: "M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM21 21l-5-5",
  command: "M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z",
  save: "M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM7 3v5h8V3M7 21v-7h10v7",
  home: "M3 11l9-8 9 8M5 9v11h14V9",
  marker: "M6 3h12v18l-6-5-6 5z",
  magnet: "M6 3v8a6 6 0 0 0 12 0V3h-4v8a2 2 0 0 1-4 0V3zM6 7h4M14 7h4",
  zoomin: "M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM21 21l-5-5M8 11h6M11 8v6",
  zoomout: "M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM21 21l-5-5M8 11h6",
  star: "M12 3l2.8 5.8 6.2.9-4.5 4.4 1 6.2L12 17.4 6.5 20.3l1-6.2L3 9.7l6.2-.9z",
  flip: "M12 3v18M8 7L3 12l5 5zM16 7l5 5-5 5z",
  freeze: "M12 2v20M4.9 4.9l14.2 14.2M2 12h20M4.9 19.1L19.1 4.9",
  reverse: "M3 12a9 9 0 1 0 3-6.7M3 4v5h5",
  speed: "M12 14l4-6M4 18a9 9 0 1 1 16 0",
  mic: "M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3",
  wave: "M3 12h2M7 8v8M11 5v14M15 9v6M19 7v10M21 12h0",
  wand: "M15 4V2M15 10V8M11 6h2M17 6h2M4 20L14 10M18 13l1 1M6 4l1 1",
  check: "M5 12l5 5L20 7",
  x: "M6 6l12 12M18 6L6 18",
  chevron: "M6 9l6 6 6-6",
  copy: "M8 8h12v12H8zM4 16V4h12",
  stabilize: "M3 12h4l2-5 3 10 2-5h7",
  scissorsAudio: "M4 12h16M8 8v8M16 8v8",
  sparkle: "M12 2l2 6 6 2-6 2-2 6-2-6-6-2 6-2z",
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 18, style, className }: { name: IconName | string; size?: number; style?: CSSProperties; className?: string }) {
  const d = P[name] ?? P.sparkle!;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className} style={style}>
      <path d={d} />
    </svg>
  );
}
