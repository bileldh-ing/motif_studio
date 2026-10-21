import { useEffect, useState } from "react";
import type { RenderPreset } from "@motif/project-schema";
import { projectDuration, framesToSeconds, formatTimecode } from "@motif/editor-core";
import { EditorSession, useSession } from "../editorStore";

type Status =
  | { s: "idle" }
  | { s: "running"; jobId: string; fraction: number; stage: string; startedAt: number }
  | { s: "done"; outputPath: string; elapsedMs: number; problems: string[] }
  | { s: "error"; error: string }
  | { s: "cancelled" };

export function ExportDialog({ session }: { session: EditorSession }) {
  const { project } = useSession(session);
  const [presets, setPresets] = useState<RenderPreset[]>([]);
  const [presetId, setPresetId] = useState("");
  const [fpsMatch, setFpsMatch] = useState(true);
  const [crf, setCrf] = useState(20);
  const [encSpeed, setEncSpeed] = useState<RenderPreset["preset"]>("medium");
  const [useRange, setUseRange] = useState(false);
  const [status, setStatus] = useState<Status>({ s: "idle" });
  const [encoders, setEncoders] = useState<string[]>([]);
  const fps = project.profile.fps;
  const total = projectDuration(project);
  const close = () => status.s !== "running" && session.setUi({ showExport: false });

  useEffect(() => {
    window.motif.presets().then((ps) => {
      // add a preset matching the project canvas
      const match: RenderPreset = { id: "project", name: `Match project · ${project.profile.width}×${project.profile.height}`, container: "mp4", videoCodec: "libx264", audioCodec: "aac", width: project.profile.width, height: project.profile.height, fps, crf: 20, audioBitrateK: 192, preset: "medium" };
      setPresets([match, ...ps]);
      setPresetId("project");
    });
    window.motif.appInfo().then((i) => setEncoders(i.encoders));
    const offP = window.motif.onRenderProgress((e) => setStatus((st) => (st.s === "running" && st.jobId === e.jobId ? { ...st, fraction: e.fraction, stage: e.stage } : st)));
    const offD = window.motif.onRenderDone((e) =>
      setStatus((st) => {
        if (st.s !== "running" || st.jobId !== e.jobId) return st;
        if (e.cancelled) return { s: "cancelled" };
        if (e.error) return { s: "error", error: e.error };
        return { s: "done", outputPath: e.outputPath!, elapsedMs: e.elapsedMs!, problems: e.problems ?? [] };
      }),
    );
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => {
      offP();
      offD();
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const preset = presets.find((p) => p.id === presetId);
  const hasRange = project.inPoint !== undefined && project.outPoint !== undefined && project.outPoint > project.inPoint;
  const available = (p: RenderPreset) => encoders.length === 0 || (encoders.includes(p.videoCodec) && encoders.includes(p.audioCodec));

  const start = async () => {
    if (!preset) return;
    const final: RenderPreset = { ...preset, crf, preset: encSpeed, fps: fpsMatch ? fps : preset.fps };
    const out = await window.motif.chooseExportPath(project.title, final.container);
    if (!out) return;
    const range = useRange && hasRange ? { start: project.inPoint!, end: project.outPoint! } : undefined;
    try {
      const { jobId } = await window.motif.startRender(session.project, final, out, range);
      setStatus({ s: "running", jobId, fraction: 0, stage: "preparing", startedAt: Date.now() });
    } catch (e: any) {
      setStatus({ s: "error", error: e.message });
    }
  };

  const elapsed = status.s === "running" ? (Date.now() - status.startedAt) / 1000 : 0;
  const eta = status.s === "running" && status.fraction > 0.03 ? elapsed / status.fraction - elapsed : null;

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal export" role="dialog" aria-modal="true" aria-labelledby="exp-h">
        <h3 id="exp-h">Export</h3>
        {total === 0 ? (
          <p>The timeline is empty. Add a clip before exporting.</p>
        ) : (
          <>
            <div className="exp-grid">
              <label className="field">
                <span>Preset</span>
                <select value={presetId} onChange={(e) => setPresetId(e.target.value)} disabled={status.s === "running"}>
                  {presets.map((p) => (
                    <option key={p.id} value={p.id} disabled={!available(p)}>
                      {p.name}{available(p) ? "" : " (encoder missing)"}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Quality (CRF {crf}, lower = better)</span>
                <input type="range" min={14} max={36} value={crf} onChange={(e) => setCrf(Number(e.target.value))} disabled={status.s === "running"} />
              </label>
              <label className="field">
                <span>Encoding speed</span>
                <select value={encSpeed} onChange={(e) => setEncSpeed(e.target.value as any)} disabled={status.s === "running"}>
                  <option value="veryfast">Fast (bigger file)</option>
                  <option value="medium">Balanced</option>
                  <option value="slow">Slow (smaller file)</option>
                </select>
              </label>
              <label className="check">
                <input type="checkbox" checked={fpsMatch} onChange={(e) => setFpsMatch(e.target.checked)} /> Match project frame rate ({(fps.num / fps.den).toFixed(fps.den === 1 ? 0 : 3)} fps)
              </label>
              <label className={"check" + (hasRange ? "" : " dim")}>
                <input type="checkbox" disabled={!hasRange} checked={useRange && hasRange} onChange={(e) => setUseRange(e.target.checked)} />
                In/out range only {hasRange ? `(${formatTimecode(project.inPoint!, fps)} → ${formatTimecode(project.outPoint!, fps)})` : "(set with I and O)"}
              </label>
            </div>
            <div className="exp-summary">
              {preset && `${preset.width}×${preset.height} · ${preset.videoCodec === "libx264" ? "H.264" : preset.videoCodec} / ${preset.audioCodec.toUpperCase()} · ${framesToSeconds(useRange && hasRange ? project.outPoint! - project.inPoint! : total, fps).toFixed(2)} s`}
            </div>

            {status.s === "running" && (
              <div className="progress-block" aria-live="polite">
                <div className="progress"><div style={{ width: `${Math.round(status.fraction * 100)}%` }} /></div>
                <div className="dim small">
                  {status.stage === "preparing" ? "Preparing…" : status.stage === "verifying" ? "Verifying output…" : `Encoding ${Math.round(status.fraction * 100)}%`}
                  {eta !== null && status.stage === "encoding" ? ` · about ${Math.ceil(eta)} s left` : ""}
                </div>
              </div>
            )}
            {status.s === "done" && (
              <div className={"result " + (status.problems.length ? "warn" : "ok")}>
                {status.problems.length ? (
                  <>Exported, but verification found: {status.problems.join("; ")}</>
                ) : (
                  <>Exported and verified in {(status.elapsedMs / 1000).toFixed(1)} s.</>
                )}
                <div className="break small">{status.outputPath}</div>
                <button onClick={() => window.motif.showInFolder(status.outputPath)}>Show in folder</button>
              </div>
            )}
            {status.s === "error" && <div className="result bad" role="alert">Export failed: {status.error}</div>}
            {status.s === "cancelled" && <div className="result">Export cancelled. No partial file was left behind.</div>}
          </>
        )}
        <div className="modal-actions">
          {status.s === "running" ? (
            <button onClick={() => window.motif.cancelRender((status as any).jobId)}>Cancel export</button>
          ) : (
            <>
              <button onClick={close}>Close</button>
              {total > 0 && <button className="primary" disabled={!preset || !available(preset)} onClick={start}>{status.s === "done" ? "Export again…" : "Export…"}</button>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
