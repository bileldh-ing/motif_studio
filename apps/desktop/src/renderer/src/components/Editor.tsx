import { useEffect, useMemo, useRef, useState } from "react";
import { splitClip, rippleDelete, liftClips, duplicateClip, findClip, addMarker, projectDuration, clipEnd, copyClips, pasteClips, freezeFrame, secondsToFrames, updateClip } from "@motif/editor-core";
import { EditorSession, useSession, useEvent, type LeftTab } from "../editorStore";
import { Viewer } from "./Viewer";
import { Timeline } from "./Timeline";
import { Inspector } from "./Inspector";
import { LeftPanel, importIntoSession } from "./LeftPanel";
import { ExportDialog } from "./ExportDialog";
import { Icon, type IconName } from "../icons";

export const SHORTCUTS: [string, string][] = [
  ["Space", "Play / pause"],
  ["← / →  (Shift: 1 s)", "Previous / next frame"],
  ["Home / End", "Go to start / end"],
  ["V / B / H", "Select, Blade and Hand tools"],
  ["S or Ctrl/⌘+B", "Split selected clip (or all clips under the playhead)"],
  ["Delete", "Ripple delete selected clips"],
  ["Shift+Delete", "Delete leaving a gap"],
  ["Ctrl/⌘+C / X / V", "Copy / cut / paste clips at the playhead"],
  ["Ctrl/⌘+D", "Duplicate clip"],
  ["Ctrl/⌘+A", "Select all clips"],
  ["Ctrl/⌘+Z / Ctrl/⌘+Shift+Z", "Undo / redo"],
  ["Ctrl/⌘+K", "Command palette"],
  ["Ctrl/⌘+S", "Save"],
  ["Ctrl/⌘+I", "Import media"],
  ["Ctrl/⌘+E", "Export"],
  ["F", "Freeze frame at the playhead"],
  ["I / O", "Set in / out point"],
  ["M", "Add marker"],
  ["+ / −  or Ctrl+wheel", "Zoom timeline"],
  ["Shift while rotating", "Snap rotation to 15°"],
  ["Esc", "Cancel drag / deselect"],
];

interface Cmd {
  id: string;
  label: string;
  icon: IconName;
  hint?: string;
  run: () => void;
}

import { CloudSyncDialog } from "./Cloud";

export function Editor({ session, onClose }: { session: EditorSession; onClose: () => void }) {
  const [showCloud, setShowCloud] = useState(false);
  const { project, ui } = useSession(session);
  const [leftW, setLeftW] = useState(360);
  const [rightW, setRightW] = useState(320);
  const [tlH, setTlH] = useState(320);
  const fps = project.profile.fps;
  const lastAutosave = useRef(project);
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
        return session.setUi({ showExport: true, playing: false, showPalette: false });
      case "shortcuts":
        return session.setUi({ showShortcuts: true, showPalette: false });
      case "palette":
        return session.setUi({ showPalette: !session.ui.showPalette });
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
      case "copy":
      case "cut":
        if (!sel.length) return;
        try {
          session.clipboard = copyClips(p, sel);
          if (cmd === "cut") {
            session.run("Cut", (x) => liftClips(x, sel));
            session.setUi({ selection: [] });
          } else session.toast(`Copied ${sel.length} clip${sel.length > 1 ? "s" : ""}`, "info");
        } catch (e: any) {
          session.toast(e.message, "error");
        }
        return;
      case "paste": {
        const cb = session.clipboard;
        if (!cb) return session.toast("Nothing to paste", "info");
        let ids: string[] = [];
        if (session.run("Paste", (x) => {
          const r = pasteClips(x, cb, ph);
          ids = r.ids;
          return r.project;
        }))
          session.setUi({ selection: ids });
        return;
      }
      case "selectAll":
        return session.setUi({ selection: p.tracks.flatMap((t) => t.clips.map((c) => c.id)) });
      case "freeze": {
        const target = (sel[0] && findClip(p, sel[0])) || p.tracks.flatMap((t) => t.clips.filter((c) => c.kind === "media" && ph >= c.start && ph < clipEnd(c)).map((c) => findClip(p, c.id))).find((h) => h && p.assets.find((a) => a.id === h.clip.assetId)?.kind === "video");
        if (!target) return session.toast("Put the playhead over a video clip", "info");
        return session.run("Freeze frame", (x) => freezeFrame(x, target.clip.id, ph, secondsToFrames(2, fps)).project);
      }
      case "reverse":
        if (sel[0]) {
          const h = findClip(p, sel[0]);
          if (h) session.run("Reverse", (x) => updateClip(x, h.clip.id, { reverse: !h.clip.reverse }));
        }
        return;
      case "marker":
        return session.run("Add marker", (x) => addMarker(x, ph));
      case "in":
        return session.run("Set in point", (x) => ({ ...x, inPoint: ph, outPoint: x.outPoint !== undefined && x.outPoint > ph ? x.outPoint : undefined }));
      case "out":
        return session.run("Set out point", (x) => ({ ...x, outPoint: ph + 1, inPoint: x.inPoint !== undefined && x.inPoint <= ph ? x.inPoint : 0 }));
      case "tool-select":
      case "tool-blade":
      case "tool-hand":
        return session.setUi({ tool: cmd.slice(5) as "select" | "blade" | "hand" });
    }
  });

  useEffect(() => window.motif.onMenu(command), [command]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        return command("palette");
      }
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (session.ui.showExport || session.ui.showPalette) return;
      const k = e.key;
      const one = Math.round(fps.num / fps.den);
      const lk = k.toLowerCase();
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
      else if ((lk === "s" && !mod) || (mod && lk === "b")) {
        e.preventDefault();
        command("split");
      } else if (k === "Delete" || k === "Backspace") {
        e.preventDefault();
        command(e.shiftKey ? "lift" : "ripple");
      } else if (mod && lk === "d") {
        e.preventDefault();
        command("duplicate");
      } else if (mod && lk === "c") command("copy");
      else if (mod && lk === "x") command("cut");
      else if (mod && lk === "v") command("paste");
      else if (mod && lk === "a") {
        e.preventDefault();
        command("selectAll");
      } else if (mod && lk === "z") {
        e.preventDefault();
        command(e.shiftKey ? "redo" : "undo");
      } else if (mod && lk === "y") {
        e.preventDefault();
        command("redo");
      } else if (mod && lk === "s") {
        e.preventDefault();
        command("save");
      } else if (mod && lk === "e") {
        e.preventDefault();
        command("export");
      } else if (mod && lk === "i") {
        e.preventDefault();
        command("import");
      } else if (!mod && lk === "i") command("in");
      else if (!mod && lk === "o") command("out");
      else if (!mod && lk === "m") command("marker");
      else if (!mod && lk === "f") command("freeze");
      else if (!mod && lk === "v") command("tool-select");
      else if (!mod && lk === "b") command("tool-blade");
      else if (!mod && lk === "h") command("tool-hand");
      else if (k === "+" || k === "=") session.setUi({ zoom: Math.min(24, session.ui.zoom * 1.25) });
      else if (k === "-") session.setUi({ zoom: Math.max(0.2, session.ui.zoom / 1.25) });
      else if (k === "Escape") session.setUi({ selection: [], showShortcuts: false, tool: "select" });
      else if (k === "?") session.setUi({ showShortcuts: true });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [session, fps, command]);

  useEffect(() => {
    const h = () => {
      if (session.ui.dirty) window.motif.autosave(session.path, session.project).catch(() => {});
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

  const cmds: Cmd[] = useMemo(() => {
    const tab = (k: LeftTab, label: string, icon: IconName): Cmd => ({ id: `tab-${k}`, label: `Open ${label}`, icon, run: () => session.setUi({ leftTab: k }) });
    return [
      { id: "import", label: "Import media…", icon: "media", hint: "Ctrl+I", run: () => command("import") },
      { id: "export", label: "Export…", icon: "export", hint: "Ctrl+E", run: () => command("export") },
      { id: "save", label: "Save project", icon: "save", hint: "Ctrl+S", run: () => command("save") },
      { id: "split", label: "Split at playhead", icon: "split", hint: "S", run: () => command("split") },
      { id: "freeze", label: "Freeze frame", icon: "freeze", hint: "F", run: () => command("freeze") },
      { id: "reverse", label: "Reverse selected clip", icon: "reverse", run: () => command("reverse") },
      { id: "dup", label: "Duplicate clip", icon: "copy", hint: "Ctrl+D", run: () => command("duplicate") },
      { id: "marker", label: "Add marker", icon: "marker", hint: "M", run: () => command("marker") },
      { id: "blade", label: "Blade tool", icon: "blade", hint: "B", run: () => command("tool-blade") },
      { id: "select", label: "Select tool", icon: "select", hint: "V", run: () => command("tool-select") },
      { id: "hand", label: "Hand tool", icon: "hand", hint: "H", run: () => command("tool-hand") },
      tab("captions", "auto captions", "captions"),
      tab("audio", "text to speech", "mic"),
      tab("effects", "filters", "filters"),
      tab("transitions", "transitions", "transitions"),
      tab("shapes", "shapes", "shapes"),
      tab("text", "text styles", "text"),
      tab("ai", "AI tools (silence, stabilize, extract audio)", "wand"),
      { id: "keys", label: "Keyboard shortcuts", icon: "command", hint: "?", run: () => command("shortcuts") },
      { id: "home", label: "Back to projects", icon: "home", run: () => command("home") },
    ];
  }, [session, command]);

  const h = session.history;
  return (
    <div className="editor app-bg" style={{ gridTemplateRows: `56px minmax(0,1fr) 8px ${tlH}px` }}>
      <header className="topbar glass-panel">
        <button className="brand-btn" onClick={goHome} title="Back to projects">
          <span className="logo-orb" aria-hidden />
          <span className="brand-txt"><b>MOTIF</b><small>Video Studio</small></span>
        </button>
        <div className="top-tools">
          <button className="icon-btn" title="Import (Ctrl+I)" onClick={() => command("import")}><Icon name="media" /></button>
          <button className="icon-btn" title="Command palette (Ctrl+K)" onClick={() => command("palette")}><Icon name="command" /></button>
          <button className="icon-btn" title="Save (Ctrl+S)" onClick={() => command("save")}><Icon name="save" /></button>
          <button className="icon-btn" title="Shortcuts (?)" onClick={() => command("shortcuts")}><Icon name="ai" /></button>
        </div>
        <div className="crumb">
          <span className="dim">Projects /</span> <b>{project.title}</b>
          <span className={"save-dot" + (ui.dirty ? " dirty" : "")} title={ui.dirty ? "Unsaved changes" : "Saved"} />
          <span className="save-state">{ui.dirty ? "Unsaved" : ui.savedAt ? `Saved ${new Date(ui.savedAt).toLocaleTimeString()}` : "Saved"}</span>
        </div>
        <span className="grow" />
        {ui.job && (
          <div className="job-pill glass" role="status">
            <span className="spinner" />
            {ui.job.label}{ui.job.fraction !== null ? ` ${Math.round(ui.job.fraction * 100)}%` : "…"}
            <button className="icon-btn" title="Cancel" onClick={() => (session as any).currentJob && window.motif.cancelJob((session as any).currentJob)}><Icon name="x" size={12} /></button>
          </div>
        )}
        <button className="icon-btn" disabled={!h.canUndo} title={h.undoLabel ? `Undo ${h.undoLabel}` : "Undo"} onClick={() => command("undo")}><Icon name="undo" /></button>
        <button className="icon-btn" disabled={!h.canRedo} title={h.redoLabel ? `Redo ${h.redoLabel}` : "Redo"} onClick={() => command("redo")}><Icon name="redo" /></button>
        <button className="cloud-btn" title="MOTIF Cloud: upload, sync and version history" onClick={() => setShowCloud(true)}>☁ Cloud</button>
        <button className="export-btn" onClick={() => command("export")}><Icon name="export" size={16} /> Export</button>
      </header>

      <div className="work" style={{ gridTemplateColumns: `${leftW}px 8px minmax(0, 1fr) 8px ${rightW}px` }}>
        <LeftPanel session={session} />
        <div className="vsplit" onPointerDown={resizer("x", () => leftW, setLeftW, 300, 560)} role="separator" aria-orientation="vertical" />
        <Viewer session={session} />
        <div className="vsplit" onPointerDown={resizer("x", () => rightW, setRightW, 270, 480, true)} role="separator" aria-orientation="vertical" />
        <Inspector session={session} />
      </div>
      <div className="hsplit" onPointerDown={resizer("y", () => tlH, setTlH, 180, 620, true)} role="separator" aria-orientation="horizontal" />
      <Timeline session={session} />

      {ui.showExport && <ExportDialog session={session} />}
      {showCloud && <CloudSyncDialog path={session.path} project={project} onClose={() => setShowCloud(false)} onSynced={(m) => { session.setUi({ dirty: false, savedAt: new Date().toISOString() }); session.toast(m, "ok"); }} />}
      {ui.showPalette && <CommandPalette cmds={cmds} onClose={() => session.setUi({ showPalette: false })} />}
      {ui.showShortcuts && (
        <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && session.setUi({ showShortcuts: false })}>
          <div className="modal glass-strong" role="dialog" aria-modal="true" aria-labelledby="kb-h">
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
      {ui.cursorChip && <div className="cursor-chip" style={{ left: ui.cursorChip.x + 16, top: ui.cursorChip.y + 18 }}>{ui.cursorChip.text}</div>}
      {ui.toast && <div className={"toast glass " + ui.toast.kind} role="status">{ui.toast.text}</div>}
    </div>
  );
}

function CommandPalette({ cmds, onClose }: { cmds: Cmd[]; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const list = cmds.filter((c) => c.label.toLowerCase().includes(q.toLowerCase()));
  const run = (c?: Cmd) => {
    if (!c) return;
    onClose();
    setTimeout(c.run, 0);
  };
  return (
    <div className="modal-back top" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette glass-strong" role="dialog" aria-label="Command palette">
        <div className="palette-input">
          <Icon name="search" size={16} />
          <input
            autoFocus
            placeholder="Type a command…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setI(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") setI((v) => Math.min(list.length - 1, v + 1));
              else if (e.key === "ArrowUp") setI((v) => Math.max(0, v - 1));
              else if (e.key === "Enter") run(list[i]);
              else if (e.key === "Escape") onClose();
            }}
          />
        </div>
        <div className="palette-list" role="listbox">
          {list.map((c, idx) => (
            <button key={c.id} role="option" aria-selected={idx === i} className={idx === i ? "on" : ""} onMouseEnter={() => setI(idx)} onClick={() => run(c)}>
              <Icon name={c.icon} size={15} />
              <span>{c.label}</span>
              {c.hint && <kbd>{c.hint}</kbd>}
            </button>
          ))}
          {list.length === 0 && <div className="empty">No matching command</div>}
        </div>
      </div>
    </div>
  );
}
