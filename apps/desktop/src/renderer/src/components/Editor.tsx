import { useEffect, useRef, useState } from "react";
import { splitClip, rippleDelete, liftClips, duplicateClip, findClip, addMarker, projectDuration, clipEnd } from "@motif/editor-core";
import { EditorSession, useSession, useEvent } from "../editorStore";
import { Viewer } from "./Viewer";
import { Timeline } from "./Timeline";
import { Inspector } from "./Inspector";
import { LeftPanel, importIntoSession } from "./LeftPanel";
import { ExportDialog } from "./ExportDialog";

export const SHORTCUTS: [string, string][] = [
  ["Space", "Play / pause"],
  ["← / →", "Previous / next frame (Shift: 1 second)"],
  ["Home / End", "Go to start / end"],
  ["S or Ctrl/⌘+B", "Split selected clip (or all clips under the playhead)"],
  ["Delete", "Ripple delete selected clips"],
  ["Shift+Delete", "Delete leaving a gap"],
  ["Ctrl/⌘+D", "Duplicate clip"],
  ["Ctrl/⌘+Z / Ctrl/⌘+Shift+Z", "Undo / redo"],
  ["Ctrl/⌘+S", "Save"],
  ["Ctrl/⌘+I", "Import media"],
  ["Ctrl/⌘+E", "Export"],
  ["I / O", "Set in / out point"],
  ["M", "Add marker"],
  ["+ / −", "Zoom timeline"],
  ["Esc", "Cancel drag / deselect"],
];

export function Editor({ session, onClose }: { session: EditorSession; onClose: () => void }) {
  const { project, ui } = useSession(session);
  const [leftW, setLeftW] = useState(300);
  const [rightW, setRightW] = useState(300);
  const [tlH, setTlH] = useState(300);
  const fps = project.profile.fps;
  const lastAutosave = useRef(project);
  // exposed for the automated smoke test (read-only use)
  (window as any).__motifSession = session;

  const save = useEvent(async () => {
    try {
      const r = await window.motif.saveProject(session.path, { ...session.project, ui: { ...session.project.ui, playhead: session.ui.playhead } });
      session.markSaved(r.savedAt);
      session.toast("Saved", "ok");
    } catch (e: any) {
      session.toast(`Save failed: ${e.message}`, "error");
    }
  });

  // autosave to the recovery slot (never overwrites the user's file silently)
  useEffect(() => {
    let timer: ReturnType<typeof setInterval>;
    window.motif.getSettings().then((s) => {
      timer = setInterval(() => {
        if (session.project !== lastAutosave.current && session.ui.dirty) {
          lastAutosave.current = session.project;
          window.motif.autosave(session.path, session.project).catch(() => {});
        }
      }, s.autosaveSeconds * 1000);
    });
    return () => clearInterval(timer);
  }, [session]);

  const goHome = useEvent(async () => {
    if (session.ui.dirty && !confirm("You have unsaved changes. Save before leaving?\n\nOK = save, Cancel = stay")) return;
    if (session.ui.dirty) await save();
    onClose();
  });

  const command = useEvent((cmd: string) => {
    const p = session.project;
    const ph = session.ui.playhead;
    const sel = session.ui.selection;
    switch (cmd) {
      case "undo":
        return session.history.undo();
      case "redo":
        return session.history.redo();
      case "save":
        return save();
      case "home":
        return goHome();
      case "export":
        return session.setUi({ showExport: true, playing: false });
      case "shortcuts":
        return session.setUi({ showShortcuts: true });
      case "import":
        return window.motif.importMediaDialog().then((r) => importIntoSession(session, r));
      case "split": {
        const targets = sel.length ? sel : p.tracks.flatMap((t) => t.clips.filter((c) => ph > c.start && ph < clipEnd(c) && !t.locked).map((c) => c.id));
        const inside = targets.filter((id) => {
          const h = findClip(p, id);
          return h && ph > h.clip.start && ph < clipEnd(h.clip);
        });
        if (!inside.length) return session.toast("Put the playhead inside a clip to split it", "info");
        return session.run("Split", (x) => inside.reduce((acc, id) => splitClip(acc, id, ph).project, x));
      }
      case "ripple":
        if (!sel.length) return;
        session.run("Ripple delete", (x) => sel.reduce((acc, id) => (findClip(acc, id) ? rippleDelete(acc, id) : acc), x));
        return session.setUi({ selection: [] });
      case "lift":
        if (!sel.length) return;
        session.run("Delete", (x) => liftClips(x, sel));
        return session.setUi({ selection: [] });
      case "duplicate":
        if (sel[0]) session.run("Duplicate", (x) => duplicateClip(x, sel[0]!).project);
        return;
      case "marker":
        return session.run("Add marker", (x) => addMarker(x, ph));
      case "in":
        return session.run("Set in point", (x) => ({ ...x, inPoint: ph, outPoint: x.outPoint !== undefined && x.outPoint > ph ? x.outPoint : undefined }));
      case "out":
        return session.run("Set out point", (x) => ({ ...x, outPoint: ph + 1, inPoint: x.inPoint !== undefined && x.inPoint <= ph ? x.inPoint : 0 }));
    }
  });

  useEffect(() => window.motif.onMenu(command), [command]);

  // keyboard shortcuts; ignored while typing in a field
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (session.ui.showExport) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key;
      const one = Math.round(fps.num / fps.den);
      if (k === " ") {
        e.preventDefault();
        session.setUi({ playing: !session.ui.playing });
      } else if (k === "ArrowLeft") {
        e.preventDefault();
        session.setUi({ playing: false, playhead: Math.max(0, session.ui.playhead - (e.shiftKey ? one : 1)) });
      } else if (k === "ArrowRight") {
        e.preventDefault();
        session.setUi({ playing: false, playhead: session.ui.playhead + (e.shiftKey ? one : 1) });
      } else if (k === "Home") session.setUi({ playhead: 0 });
      else if (k === "End") session.setUi({ playhead: Math.max(0, projectDuration(session.project) - 1) });
      else if ((k === "s" && !mod) || (mod && k.toLowerCase() === "b")) {
        e.preventDefault();
        command("split");
      } else if (k === "Delete" || k === "Backspace") {
        e.preventDefault();
        command(e.shiftKey ? "lift" : "ripple");
      } else if (mod && k.toLowerCase() === "d") {
        e.preventDefault();
        command("duplicate");
      } else if (mod && k.toLowerCase() === "z") {
        e.preventDefault();
        command(e.shiftKey ? "redo" : "undo");
      } else if (mod && k.toLowerCase() === "y") {
        e.preventDefault();
        command("redo");
      } else if (mod && k.toLowerCase() === "s") {
        e.preventDefault();
        command("save");
      } else if (mod && k.toLowerCase() === "e") {
        e.preventDefault();
        command("export");
      } else if (mod && k.toLowerCase() === "i") {
        e.preventDefault();
        command("import");
      } else if (!mod && k.toLowerCase() === "i") command("in");
      else if (!mod && k.toLowerCase() === "o") command("out");
      else if (!mod && k.toLowerCase() === "m") command("marker");
      else if (k === "+" || k === "=") session.setUi({ zoom: Math.min(24, session.ui.zoom * 1.25) });
      else if (k === "-") session.setUi({ zoom: Math.max(0.2, session.ui.zoom / 1.25) });
      else if (k === "Escape") session.setUi({ selection: [], showShortcuts: false });
      else if (k === "?") session.setUi({ showShortcuts: true });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [session, fps, command]);

  // warn on window close with unsaved changes
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (session.ui.dirty) {
        window.motif.autosave(session.path, session.project).catch(() => {});
      }
      void e;
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [session]);

  const resizer = (axis: "x" | "y", get: () => number, set: (v: number) => void, min: number, max: number, invert = false) => (e: React.PointerEvent) => {
    const start = axis === "x" ? e.clientX : e.clientY;
    const v0 = get();
    const move = (ev: PointerEvent) => {
      const d = (axis === "x" ? ev.clientX : ev.clientY) - start;
      set(Math.max(min, Math.min(max, v0 + (invert ? -d : d))));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", () => window.removeEventListener("pointermove", move), { once: true });
  };

  const h = session.history;
  return (
    <div className="editor" style={{ gridTemplateRows: `48px 1fr 6px ${tlH}px` }}>
      <header className="topbar">
        <button className="ghost" onClick={goHome} title="Back to projects">◆ MOTIF</button>
        <span className="proj-title">{project.title}</span>
        <span className={"save-state" + (ui.dirty ? " dirty" : "")}>{ui.dirty ? "Unsaved changes" : ui.savedAt ? `Saved ${new Date(ui.savedAt).toLocaleTimeString()}` : "Saved"}</span>
        <span className="grow" />
        <button disabled={!h.canUndo} title={h.undoLabel ? `Undo ${h.undoLabel}` : "Undo"} onClick={() => command("undo")}>↶</button>
        <button disabled={!h.canRedo} title={h.redoLabel ? `Redo ${h.redoLabel}` : "Redo"} onClick={() => command("redo")}>↷</button>
        <span className="sep" />
        <button onClick={() => command("split")} title="Split (S)">Split</button>
        <button onClick={() => command("ripple")} disabled={!ui.selection.length} title="Ripple delete (Delete)">Delete</button>
        <span className="sep" />
        <button onClick={() => session.setUi({ showShortcuts: true })} title="Keyboard shortcuts (?)">Keys</button>
        <button onClick={() => command("save")}>Save</button>
        <button className="primary" onClick={() => command("export")}>Export</button>
      </header>

      <div className="work" style={{ gridTemplateColumns: `${leftW}px 6px minmax(0, 1fr) 6px ${rightW}px` }}>
        <LeftPanel session={session} />
        <div className="vsplit" onPointerDown={resizer("x", () => leftW, setLeftW, 220, 520)} role="separator" aria-orientation="vertical" />
        <Viewer session={session} />
        <div className="vsplit" onPointerDown={resizer("x", () => rightW, setRightW, 240, 480, true)} role="separator" aria-orientation="vertical" />
        <Inspector session={session} />
      </div>
      <div className="hsplit" onPointerDown={resizer("y", () => tlH, setTlH, 160, 600, true)} role="separator" aria-orientation="horizontal" />
      <Timeline session={session} />

      {ui.showExport && <ExportDialog session={session} />}
      {ui.showShortcuts && (
        <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && session.setUi({ showShortcuts: false })}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="kb-h">
            <h3 id="kb-h">Keyboard shortcuts</h3>
            <table className="kb">
              <tbody>
                {SHORTCUTS.map(([k, v]) => (
                  <tr key={k}><td><kbd>{k}</kbd></td><td>{v}</td></tr>
                ))}
              </tbody>
            </table>
            <div className="modal-actions"><button onClick={() => session.setUi({ showShortcuts: false })}>Close</button></div>
          </div>
        </div>
      )}
      {ui.toast && <div className={"toast " + ui.toast.kind} role="status">{ui.toast.text}</div>}
    </div>
  );
}
