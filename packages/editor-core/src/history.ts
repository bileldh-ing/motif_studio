/**
 * Undo/redo history built on immutable project states. Each committed command
 * records a label and the state before it. Because projects are immutable
 * with structural sharing, snapshots are cheap.
 */
import type { Project } from "@motif/project-schema";

export interface HistoryEntry {
  label: string;
  before: Project;
  after: Project;
}

export class History {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private listeners = new Set<() => void>();

  constructor(private current: Project, private readonly limit = 500) {}

  get state(): Project {
    return this.current;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  get undoLabel(): string | null {
    return this.undoStack.at(-1)?.label ?? null;
  }
  get redoLabel(): string | null {
    return this.redoStack.at(-1)?.label ?? null;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  /** Apply a pure command. If it throws, history and state are unchanged. */
  apply(label: string, fn: (p: Project) => Project): Project {
    const before = this.current;
    const after = fn(before);
    if (after === before) return before;
    this.undoStack.push({ label, before, after });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    this.current = after;
    this.emit();
    return after;
  }

  /** Replace state without recording (e.g. UI-only fields like playhead). */
  replaceSilently(p: Project) {
    this.current = p;
    this.emit();
  }

  undo(): Project {
    const e = this.undoStack.pop();
    if (!e) return this.current;
    this.redoStack.push(e);
    this.current = e.before;
    this.emit();
    return this.current;
  }

  redo(): Project {
    const e = this.redoStack.pop();
    if (!e) return this.current;
    this.undoStack.push(e);
    this.current = e.after;
    this.emit();
    return this.current;
  }

  reset(p: Project) {
    this.undoStack = [];
    this.redoStack = [];
    this.current = p;
    this.emit();
  }
}
