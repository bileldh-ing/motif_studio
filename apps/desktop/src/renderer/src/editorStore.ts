/**
 * Editor session: wraps the immutable History from editor-core and exposes
 * React hooks. The project document is the single source of truth; React
 * components never hold their own copy of timeline data.
 */
import { useSyncExternalStore, useRef, useCallback } from "react";
import { History } from "@motif/editor-core";
import type { Project } from "@motif/project-schema";
import type { DerivedMedia } from "../../shared/api";

type Listener = () => void;

export interface UiState {
  playhead: number;
  playing: boolean;
  selection: string[];
  zoom: number; // pixels per frame
  dirty: boolean;
  savedAt: string | null;
  toast: { kind: "info" | "error" | "ok"; text: string; id: number } | null;
  missing: Set<string>;
  derived: Record<string, DerivedMedia>;
  leftTab: LeftTab;
  inspectorTab: InspectorTab;
  tool: "select" | "blade" | "hand";
  showExport: boolean;
  showShortcuts: boolean;
  showPalette: boolean;
  /** Figma-style label that follows the cursor while dragging */
  cursorChip: { x: number; y: number; text: string } | null;
  guides: { v: boolean; h: boolean } | null;
  /** long-running local job (AI, stabilize…) */
  job: { label: string; fraction: number | null } | null;
}

export type LeftTab = "media" | "audio" | "text" | "shapes" | "effects" | "transitions" | "captions" | "ai";
export type InspectorTab = "video" | "animation" | "adjust" | "speed" | "audio" | "text" | "shape";

export class EditorSession {
  history: History;
  clipboard: import("@motif/editor-core").ClipboardData | null = null;
  path: string;
  ui: UiState;
  private listeners = new Set<Listener>();
  private uiVersion = 0;
  private snapshot: { project: Project; ui: UiState; v: number };

  constructor(project: Project, path: string, missing: string[]) {
    this.history = new History(project);
    this.path = path;
    this.ui = {
      playhead: project.ui.playhead ?? 0,
      playing: false,
      selection: [],
      zoom: 3,
      dirty: false,
      savedAt: null,
      toast: null,
      missing: new Set(missing),
      derived: {},
      leftTab: "media",
      inspectorTab: "video",
      tool: "select",
      showExport: false,
      showShortcuts: false,
      showPalette: false,
      cursorChip: null,
      guides: null,
      job: null,
    };
    this.snapshot = { project, ui: this.ui, v: 0 };
    this.history.subscribe(() => {
      this.ui = { ...this.ui, dirty: true };
      this.bump();
    });
  }

  private bump() {
    this.uiVersion++;
    this.snapshot = { project: this.history.state, ui: this.ui, v: this.uiVersion };
    for (const l of this.listeners) l();
  }

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getSnapshot = () => this.snapshot;

  get project() {
    return this.history.state;
  }

  setUi(patch: Partial<UiState>) {
    this.ui = { ...this.ui, ...patch };
    this.bump();
  }

  toast(text: string, kind: "info" | "error" | "ok" = "info") {
    const id = Date.now();
    this.setUi({ toast: { text, kind, id } });
    setTimeout(() => {
      if (this.ui.toast?.id === id) this.setUi({ toast: null });
    }, kind === "error" ? 6000 : 3000);
  }

  /** Run a timeline command; errors become a toast and leave the project untouched. */
  run(label: string, fn: (p: Project) => Project): boolean {
    try {
      this.history.apply(label, fn);
      return true;
    } catch (e: any) {
      this.toast(e.message ?? String(e), "error");
      return false;
    }
  }

  runCoalesced(label: string, key: string, fn: (p: Project) => Project): boolean {
    try {
      this.history.applyCoalesced(label, key, fn);
      return true;
    } catch (e: any) {
      this.toast(e.message ?? String(e), "error");
      return false;
    }
  }

  markSaved(at: string) {
    this.setUi({ dirty: false, savedAt: at });
  }
}

export function useSession(s: EditorSession) {
  return useSyncExternalStore(s.subscribe, s.getSnapshot);
}

/** Stable callback that always sees the latest closure. */
export function useEvent<T extends (...a: any[]) => any>(fn: T): T {
  const r = useRef(fn);
  r.current = fn;
  return useCallback(((...a: any[]) => r.current(...a)) as T, []);
}
