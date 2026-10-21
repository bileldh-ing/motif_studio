import { useEffect, useMemo, useState } from "react";
import { CODECS, RESOLUTIONS, sizeForResolution, type RenderPreset } from "@motif/project-schema";
import { projectDuration, framesToSeconds, formatTimecode } from "@motif/editor-core";
import { EditorSession, useSession } from "../editorStore";
import { Icon } from "../icons";

type Status =
  | { s: "idle" }
  | { s: "running"; jobId: string; fraction: number; stage: string; startedAt: number }
  | { s: "done"; outputPath: string; elapsedMs: number; problems: string[] }
  | { s: "error"; error: string }
  | { s: "cancelled" };

type Kind = RenderPreset["kind"];
const FPS_CHOICES = ["project", "24", "25", "30", "50", "60"] as const;

/** Rough recommended bitrate (Mbps) for H.264 at a resolution/frame rate (YouTube-like guidance). */
function recommendedMbps(short: number, fps: number) {
  const base = short >= 2160 ? 40 : short >= 1440 ? 16 : short >= 1080 ? 8 : short >= 720 ? 5 : 2.5;
  return fps > 30 ? Math.round(base * 1.5) : base;
}

export function ExportDialog({ session }: { session: EditorSession }) {
  const { project } = useSession(session);
  const pf = project.profile;
  const [kind, setKind] = useState<Kind>("video");
  const [res, setRes] = useState<string>(pf.width >= pf.height ? (pf.height >= 2160 ? "2160p" : "1080p") : "1080p");
  const [custom, setCustom] = useState({ w: pf.width, h: pf.height });
  const [fpsSel, setFpsSel] = useState<(typeof FPS_CHOICES)[number]>("project");
  const [codec, setCodec] = useState<RenderPreset["videoCodec"]>("libx264");
  const [container, setContainer] = useState<RenderPreset["container"]>("mp4");
  const [mode, setMode] = useState<"crf" | "bitrate">("crf");
  const [crf, setCrf] = useState(20);
  const [mbps, setMbps] = useState(8);
  const [encSpeed, setEncSpeed] = useState<RenderPreset["preset"]>("medium");
  const [audioCodec, setAudioCodec] = useState<RenderPreset["audioCodec"]>("aac");
  const [audioK, setAudioK] = useState(192);
  const [audioFmt, setAudioFmt] = useState<"mp3" | "wav" | "m4a">("mp3");
  const [useRange, setUseRange] = useState(false);
  const [status, setStatus] = useState<Status>({ s: "idle" });
  const [encoders, setEncoders] = useState<string[]>([]);
  const fps = pf.fps;
  const total = projectDuration(project);
  const close = () => status.s !== "running" && session.setUi({ showExport: false });

  useEffect(() => {
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

  const has = (enc: string) => encoders.length === 0 || encoders.includes(enc);
  const codecDef = CODECS.find((c) => c.id === codec)!;
  useEffect(() => {
    if (!(codecDef.containers as readonly string[]).includes(container)) setContainer(codecDef.containers[0] as RenderPreset["container"]);
    if (!(codecDef.audio as readonly string[]).includes(audioCodec)) setAudioCodec(codecDef.audio[0] as RenderPreset["audioCodec"]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codec]);

  const size = res === "custom" ? { width: Math.max(16, Math.round(custom.w / 2) * 2), height: Math.max(16, Math.round(custom.h / 2) * 2) } : sizeForResolution(pf.width, pf.height, RESOLUTIONS.find((r) => r.id === res)!.short);
  const outFps = fpsSel === "project" ? fps : { num: Number(fpsSel), den: 1 };
  const outFpsN = outFps.num / outFps.den;
  const hasRange = project.inPoint !== undefined && project.outPoint !== undefined && project.outPoint > project.inPoint;
  const durFrames = useRange && hasRange ? project.outPoint! - project.inPoint! : total;
  const durSec = framesToSeconds(durFrames, fps);
  const shortSide = Math.min(size.width, size.height);
  const recMbps = recommendedMbps(shortSide, outFpsN);
  useEffect(() => setMbps(recMbps), [recMbps]);

  const preset: RenderPreset = useMemo(() => {
    if (kind === "audio") {
      const ac = audioFmt === "mp3" ? "libmp3lame" : audioFmt === "wav" ? "pcm_s16le" : "aac";
      return { id: "custom-audio", name: "Audio", kind, container: audioFmt, videoCodec: "none", audioCodec: ac, width: pf.width, height: pf.height, fps, crf: 20, audioBitrateK: audioK, preset: "medium" };
    }
    if (kind === "gif") return { id: "custom-gif", name: "GIF", kind, container: "gif", videoCodec: "gif", audioCodec: "none", width: size.width, height: size.height, fps: { num: Math.min(30, Math.round(outFpsN)), den: 1 }, crf: 20, audioBitrateK: 128, preset: "medium" };
    if (kind === "frame") return { id: "custom-frame", name: "Frame", kind, container: "png", videoCodec: "png", audioCodec: "none", width: size.width, height: size.height, fps, crf: 20, audioBitrateK: 128, preset: "medium" };
    return {
      id: "custom",
      name: "Custom",
      kind,
      container,
      videoCodec: codec,
      audioCodec,
      width: size.width,
      height: size.height,
      fps: outFps,
      crf,
      audioBitrateK: audioK,
      preset: encSpeed,
      ...(mode === "bitrate" && codec !== "prores_ks" ? { bitrateMbps: mbps } : {}),
    };
  }, [kind, audioFmt, audioK, size.width, size.height, outFpsN, container, codec, audioCodec, crf, encSpeed, mode, mbps, pf.width, pf.height, fps, outFps]);

  const estMB = (() => {
    if (kind === "frame") return null;
    if (kind === "audio") return audioFmt === "wav" ? (48000 * 2 * 2 * durSec) / 1e6 : (audioK * 1000 * durSec) / 8e6;
    if (kind === "gif") return null;
    if (codec === "prores_ks") return (shortSide >= 2160 ? 700 : shortSide >= 1080 ? 147 : 60) * durSec / 8;
    const v = mode === "bitrate" ? mbps : recMbps * Math.pow(2, (20 - crf) / 6) * (codec === "libx265" ? 0.6 : codec === "libsvtav1" ? 0.5 : codec === "libvpx-vp9" ? 0.65 : 1);
    return ((v * 1e6 + audioK * 1000) * durSec) / 8e6;
  })();

  const start = async () => {
    const out = await window.motif.chooseExportPath(project.title, preset.container);
    if (!out) return;
    const range = kind === "frame" ? { start: session.ui.playhead, end: session.ui.playhead + 1 } : useRange && hasRange ? { start: project.inPoint!, end: project.outPoint! } : undefined;
    try {
      const { jobId } = await window.motif.startRender(session.project, preset, out, range);
      setStatus({ s: "running", jobId, fraction: 0, stage: "preparing", startedAt: Date.now() });
    } catch (e: any) {
      setStatus({ s: "error", error: e.message });
    }
  };

  const elapsed = status.s === "running" ? (Date.now() - status.startedAt) / 1000 : 0;
  const eta = status.s === "running" && status.fraction > 0.03 ? elapsed / status.fraction - elapsed : null;
  const running = status.s === "running";

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal export glass-strong" role="dialog" aria-modal="true" aria-labelledby="exp-h">
        <div className="exp-top">
          <h3 id="exp-h"><Icon name="export" size={18} /> Export</h3>
          <div className="seg-pill">
            {([["video", "Video"], ["audio", "Audio only"], ["gif", "GIF"], ["frame", "Still frame"]] as const).map(([k, l]) => (
              <button key={k} className={kind === k ? "on" : ""} disabled={running} onClick={() => setKind(k)}>{l}</button>
            ))}
          </div>
        </div>
        {total === 0 ? (
          <p>The timeline is empty. Add a clip before exporting.</p>
        ) : (
          <div className="exp-body">
            {kind !== "audio" && (
              <div className="exp-section">
                <h4>Resolution</h4>
                <div className="chip-grid res">
                  {RESOLUTIONS.map((r) => {
                    const s = sizeForResolution(pf.width, pf.height, r.short);
                    return (
                      <button key={r.id} className={res === r.id ? "on" : ""} disabled={running} onClick={() => setRes(r.id)}>
                        <b>{r.label}</b>
                        <small>{s.width}×{s.height}</small>
                      </button>
                    );
                  })}
                  <button className={res === "custom" ? "on" : ""} disabled={running} onClick={() => setRes("custom")}><b>Custom</b><small>any size</small></button>
                </div>
                {res === "custom" && (
                  <div className="row-2">
                    <label className="field"><span>Width</span><input type="number" min={16} max={7680} value={custom.w} onChange={(e) => setCustom({ ...custom, w: Number(e.target.value) })} /></label>
                    <label className="field"><span>Height</span><input type="number" min={16} max={4320} value={custom.h} onChange={(e) => setCustom({ ...custom, h: Number(e.target.value) })} /></label>
                  </div>
                )}
              </div>
            )}
            {kind === "video" && (
              <>
                <div className="exp-section grid3">
                  <label className="field"><span>Frame rate</span>
                    <select value={fpsSel} disabled={running} onChange={(e) => setFpsSel(e.target.value as any)}>
                      {FPS_CHOICES.map((f) => <option key={f} value={f}>{f === "project" ? `Project (${(fps.num / fps.den).toFixed(fps.den === 1 ? 0 : 2)})` : `${f} fps`}</option>)}
                    </select>
                  </label>
                  <label className="field"><span>Codec</span>
                    <select value={codec} disabled={running} onChange={(e) => setCodec(e.target.value as any)}>
                      {CODECS.map((c) => <option key={c.id} value={c.id} disabled={!has(c.id)}>{c.label}{has(c.id) ? "" : " (missing)"}</option>)}
                    </select>
                  </label>
                  <label className="field"><span>Format</span>
                    <select value={container} disabled={running} onChange={(e) => setContainer(e.target.value as any)}>
                      {codecDef.containers.map((c) => <option key={c} value={c}>.{c}</option>)}
                    </select>
                  </label>
                </div>
                {codec !== "prores_ks" && (
                  <div className="exp-section">
                    <div className="exp-row">
                      <h4>Quality</h4>
                      <div className="seg-pill small">
                        <button className={mode === "crf" ? "on" : ""} onClick={() => setMode("crf")}>Constant quality</button>
                        <button className={mode === "bitrate" ? "on" : ""} onClick={() => setMode("bitrate")}>Bitrate</button>
                      </div>
                    </div>
                    {mode === "crf" ? (
                      <label className="field"><span>CRF {crf} · {crf <= 17 ? "visually lossless" : crf <= 21 ? "high" : crf <= 26 ? "good" : "small file"}</span><input type="range" min={12} max={36} value={crf} disabled={running} onChange={(e) => setCrf(Number(e.target.value))} /></label>
                    ) : (
                      <label className="field"><span>{mbps} Mbps · recommended {recMbps}</span><input type="range" min={1} max={120} value={mbps} disabled={running} onChange={(e) => setMbps(Number(e.target.value))} /></label>
                    )}
                    <label className="field"><span>Encoding speed</span>
                      <select value={encSpeed} disabled={running} onChange={(e) => setEncSpeed(e.target.value as any)}>
                        <option value="ultrafast">Fastest</option>
                        <option value="veryfast">Fast</option>
                        <option value="medium">Balanced</option>
                        <option value="slow">Best compression</option>
                      </select>
                    </label>
                  </div>
                )}
                <div className="exp-section grid3">
                  <label className="field"><span>Audio</span>
                    <select value={audioCodec} disabled={running} onChange={(e) => setAudioCodec(e.target.value as any)}>
                      {codecDef.audio.map((a) => <option key={a} value={a}>{a === "aac" ? "AAC" : a === "libopus" ? "Opus" : a === "libmp3lame" ? "MP3" : "PCM (lossless)"}</option>)}
                    </select>
                  </label>
                  {audioCodec !== "pcm_s16le" && (
                    <label className="field"><span>Audio bitrate</span>
                      <select value={audioK} disabled={running} onChange={(e) => setAudioK(Number(e.target.value))}>
                        {[96, 128, 192, 256, 320].map((k) => <option key={k} value={k}>{k} kbps</option>)}
                      </select>
                    </label>
                  )}
                </div>
              </>
            )}
            {kind === "audio" && (
              <div className="exp-section grid3">
                <label className="field"><span>Format</span>
                  <select value={audioFmt} onChange={(e) => setAudioFmt(e.target.value as any)}>
                    <option value="mp3">MP3</option>
                    <option value="m4a">AAC (.m4a)</option>
                    <option value="wav">WAV (lossless)</option>
                  </select>
                </label>
                {audioFmt !== "wav" && (
                  <label className="field"><span>Bitrate</span>
                    <select value={audioK} onChange={(e) => setAudioK(Number(e.target.value))}>
                      {[96, 128, 192, 256, 320].map((k) => <option key={k} value={k}>{k} kbps</option>)}
                    </select>
                  </label>
                )}
              </div>
            )}
            {kind === "frame" && <p className="hint">Exports the frame under the playhead ({formatTimecode(session.ui.playhead, fps)}) as a PNG.</p>}
            {kind === "gif" && <p className="hint">Animated GIF with an optimised palette, up to 30 fps. GIFs have no sound.</p>}
            {kind !== "frame" && (
              <label className={"check" + (hasRange ? "" : " dim")}>
                <input type="checkbox" disabled={!hasRange || running} checked={useRange && hasRange} onChange={(e) => setUseRange(e.target.checked)} />
                In/out range only {hasRange ? `(${formatTimecode(project.inPoint!, fps)} → ${formatTimecode(project.outPoint!, fps)})` : "(set with I and O)"}
              </label>
            )}
            <div className="exp-summary glass">
              <span>{kind === "audio" ? audioFmt.toUpperCase() : `${preset.width}×${preset.height}`}</span>
              {kind === "video" && <span>{CODECS.find((c) => c.id === codec)!.label} · {outFpsN.toFixed(outFps.den === 1 ? 0 : 2)} fps</span>}
              {kind !== "frame" && <span>{durSec.toFixed(2)} s</span>}
              {estMB !== null && <span>≈ {estMB < 1 ? `${(estMB * 1000).toFixed(0)} KB` : `${estMB.toFixed(estMB < 10 ? 1 : 0)} MB`}</span>}
              {shortSide >= 2160 && kind === "video" && <span className="badge-4k">4K</span>}
            </div>

            {running && (
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
                {status.problems.length ? <>Exported, but verification found: {status.problems.join("; ")}</> : <><Icon name="check" size={14} /> Exported and verified in {(status.elapsedMs / 1000).toFixed(1)} s.</>}
                <div className="break small">{status.outputPath}</div>
                <button onClick={() => window.motif.showInFolder(status.outputPath)}>Show in folder</button>
              </div>
            )}
            {status.s === "error" && <div className="result bad" role="alert">Export failed: {status.error}</div>}
            {status.s === "cancelled" && <div className="result">Export cancelled. No partial file was left behind.</div>}
          </div>
        )}
        <div className="modal-actions">
          {running ? (
            <button onClick={() => window.motif.cancelRender((status as any).jobId)}>Cancel export</button>
          ) : (
            <>
              <button onClick={close}>Close</button>
              {total > 0 && <button className="primary" disabled={kind === "video" && !has(codec)} onClick={start}>{status.s === "done" ? "Export again…" : "Export…"}</button>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
