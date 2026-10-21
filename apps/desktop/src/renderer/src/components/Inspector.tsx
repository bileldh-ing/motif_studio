import type { Clip, AnimatableProperty, Project } from "@motif/project-schema";
import { findClip, updateClip, setClipSpeed, setTransitionIn, setKeyframe, removeKeyframe, propertyAt, clipEnd, formatTimecode, framesToSeconds, secondsToFrames } from "@motif/editor-core";
import { EditorSession, useSession } from "../editorStore";

function Num({ label, value, min, max, step, onChange, unit, kf }: { label: string; value: number; min: number; max: number; step: number; unit?: string; onChange: (v: number) => void; kf?: { on: boolean; has: boolean; toggle: () => void } }) {
  return (
    <div className="prop">
      <label>
        <span>{label}</span>
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={Number(value.toFixed(3))}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v)));
          }}
        />
        {unit && <em>{unit}</em>}
      </label>
      {kf && (
        <button className={"kf" + (kf.on ? " on" : kf.has ? " has" : "")} title={kf.on ? "Remove keyframe at playhead" : "Add keyframe at playhead"} onClick={kf.toggle} aria-pressed={kf.on}>◆</button>
      )}
    </div>
  );
}

export function Inspector({ session }: { session: EditorSession }) {
  const { project, ui } = useSession(session);
  const id = ui.selection[0];
  const hit = id ? findClip(project, id) : null;
  if (!hit) return <ProjectInspector project={project} session={session} />;
  const c = hit.clip;
  const fps = project.profile.fps;
  const local = Math.max(0, Math.min(c.duration - 1, ui.playhead - c.start));
  const inClip = ui.playhead >= c.start && ui.playhead < clipEnd(c);
  const set = (label: string, key: string, patch: (c: Clip) => Partial<Clip>) => session.runCoalesced(label, `${c.id}:${key}`, (p) => updateClip(p, c.id, patch(findClip(p, c.id)!.clip)));

  /** Change an animatable property: writes a keyframe if the property is animated, else the static value. */
  const setProp = (prop: AnimatableProperty, v: number) => {
    if (c.keyframes[prop]?.length) {
      if (!inClip) return session.toast("Move the playhead inside the clip to edit an animated value", "error");
      session.runCoalesced("Edit keyframe", `${c.id}:kf:${prop}`, (p) => setKeyframe(p, c.id, prop, local, v));
      return;
    }
    if (prop === "volume") set("Volume", "vol", (x) => ({ audio: { ...x.audio, gainDb: v } }));
    else set("Transform", prop, (x) => ({ transform: { ...x.transform, [prop]: v } }));
  };
  const kf = (prop: AnimatableProperty) => {
    const list = c.keyframes[prop] ?? [];
    const on = list.some((k) => k.frame === local);
    return {
      on: on && inClip,
      has: list.length > 0,
      toggle: () => {
        if (!inClip) return session.toast("Move the playhead inside the clip to set a keyframe", "error");
        session.run(on ? "Remove keyframe" : "Add keyframe", (p) => (on ? removeKeyframe(p, c.id, prop, local) : setKeyframe(p, c.id, prop, local, propertyAt(c, prop, local))));
      },
    };
  };
  const supportsKf = (prop: AnimatableProperty) => c.kind === "media" && ["x", "y", "scale"].includes(prop);
  const asset = c.assetId ? project.assets.find((a) => a.id === c.assetId) : undefined;
  const speed = c.speed.num / c.speed.den;
  const isAudioTrack = hit.track.kind === "audio";

  return (
    <div className="inspector">
      <div className="insp-head">
        <strong>{c.kind === "text" ? (c.text?.role === "caption" ? "Caption" : "Title") : asset?.kind === "image" ? "Image" : isAudioTrack ? "Audio" : "Video"}</strong>
        <span className="dim small">{formatTimecode(c.start, fps)} · {framesToSeconds(c.duration, fps).toFixed(2)} s</span>
      </div>
      <label className="row check">
        <input type="checkbox" checked={c.enabled} onChange={(e) => session.run("Toggle clip", (p) => updateClip(p, c.id, { enabled: e.target.checked }))} /> Enabled
      </label>

      {c.kind === "text" && c.text && (
        <section>
          <h4>Text</h4>
          <textarea
            value={c.text.content}
            rows={3}
            maxLength={2000}
            onChange={(e) => set("Edit text", "text", (x) => ({ text: { ...x.text!, content: e.target.value }, name: e.target.value.slice(0, 32) }))}
          />
          <Num label="Size" value={c.text.fontSize} min={8} max={400} step={1} onChange={(v) => set("Text size", "fs", (x) => ({ text: { ...x.text!, fontSize: Math.round(v) } }))} />
          <div className="prop">
            <label>
              <span>Color</span>
              <input type="color" value={c.text.color} onChange={(e) => set("Text color", "tc", (x) => ({ text: { ...x.text!, color: e.target.value } }))} />
            </label>
            <label className="check">
              <input type="checkbox" checked={!!c.text.boxColor} onChange={(e) => session.run("Text box", (p) => updateClip(p, c.id, { text: { ...c.text!, boxColor: e.target.checked ? "#000000" : undefined } }))} /> Box
            </label>
            {c.text.boxColor && <input type="color" value={c.text.boxColor} onChange={(e) => set("Box color", "bc", (x) => ({ text: { ...x.text!, boxColor: e.target.value } }))} />}
          </div>
          <div className="seg">
            {(["top", "center", "lower-third"] as const).map((a) => (
              <button key={a} className={c.text!.align === a ? "on" : ""} onClick={() => session.run("Text position", (p) => updateClip(p, c.id, { text: { ...c.text!, align: a } }))}>{a === "lower-third" ? "Lower" : a[0]!.toUpperCase() + a.slice(1)}</button>
            ))}
          </div>
          <label className="row check">
            <input type="checkbox" checked={c.text.role === "caption"} onChange={(e) => session.run("Caption flag", (p) => updateClip(p, c.id, { text: { ...c.text!, role: e.target.checked ? "caption" : "title" } }))} /> Include in SRT captions
          </label>
          <Num label="Offset X" value={c.transform.x} min={-project.profile.width} max={project.profile.width} step={1} unit="px" onChange={(v) => set("Text offset", "x", (x) => ({ transform: { ...x.transform, x: v } }))} />
          <Num label="Offset Y" value={c.transform.y} min={-project.profile.height} max={project.profile.height} step={1} unit="px" onChange={(v) => set("Text offset", "y", (x) => ({ transform: { ...x.transform, y: v } }))} />
        </section>
      )}

      {c.kind === "media" && !isAudioTrack && (
        <section>
          <h4>Transform {inClip ? "" : <span className="dim small">(playhead outside clip)</span>}</h4>
          <Num label="Position X" value={propertyAt(c, "x", local)} min={-project.profile.width} max={project.profile.width} step={1} unit="px" onChange={(v) => setProp("x", v)} kf={supportsKf("x") ? kf("x") : undefined} />
          <Num label="Position Y" value={propertyAt(c, "y", local)} min={-project.profile.height} max={project.profile.height} step={1} unit="px" onChange={(v) => setProp("y", v)} kf={supportsKf("y") ? kf("y") : undefined} />
          <Num label="Scale" value={propertyAt(c, "scale", local)} min={0.05} max={5} step={0.01} unit="×" onChange={(v) => setProp("scale", v)} kf={supportsKf("scale") ? kf("scale") : undefined} />
          <Num label="Rotation" value={c.transform.rotation} min={-180} max={180} step={0.5} unit="°" onChange={(v) => setProp("rotation", v)} />
          <Num label="Opacity" value={c.transform.opacity} min={0} max={1} step={0.01} onChange={(v) => setProp("opacity", v)} />
          <button className="link" onClick={() => session.run("Reset transform", (p) => updateClip(p, c.id, { transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, keyframes: {} }))}>Reset transform & keyframes</button>
        </section>
      )}

      {c.kind === "media" && asset?.kind !== "audio" && !isAudioTrack && (
        <section>
          <h4>Color</h4>
          <Num label="Brightness" value={c.color.brightness} min={-1} max={1} step={0.01} onChange={(v) => set("Brightness", "br", (x) => ({ color: { ...x.color, brightness: v } }))} />
          <Num label="Contrast" value={c.color.contrast} min={0} max={3} step={0.01} onChange={(v) => set("Contrast", "ct", (x) => ({ color: { ...x.color, contrast: v } }))} />
          <Num label="Saturation" value={c.color.saturation} min={0} max={3} step={0.01} onChange={(v) => set("Saturation", "sat", (x) => ({ color: { ...x.color, saturation: v } }))} />
        </section>
      )}

      {c.kind === "media" && asset?.kind !== "image" && (
        <section>
          <h4>Speed</h4>
          <div className="seg">
            {[0.25, 0.5, 1, 1.5, 2, 4].map((s) => (
              <button key={s} className={Math.abs(speed - s) < 1e-6 ? "on" : ""} onClick={() => session.run("Change speed", (p) => setClipSpeed(p, c.id, s === 1.5 ? { num: 3, den: 2 } : s < 1 ? { num: 1, den: 1 / s } : { num: s, den: 1 }))}>{s}×</button>
            ))}
          </div>
          <p className="hint">Audio keeps its pitch (time-stretched). Duration scales to keep the same source range.</p>
        </section>
      )}

      {c.kind === "media" && asset?.meta.hasAudio && (
        <section>
          <h4>Audio</h4>
          <Num label="Volume" value={c.audio.gainDb} min={-60} max={24} step={0.5} unit="dB" onChange={(v) => set("Volume", "vol", (x) => ({ audio: { ...x.audio, gainDb: v } }))} />
          <Num label="Pan" value={c.audio.pan} min={-1} max={1} step={0.05} onChange={(v) => set("Pan", "pan", (x) => ({ audio: { ...x.audio, pan: v } }))} />
          <Num label="Fade in" value={framesToSeconds(c.audio.fadeInFrames, fps)} min={0} max={Math.min(10, framesToSeconds(c.duration, fps))} step={0.1} unit="s" onChange={(v) => set("Fade in", "fi", (x) => ({ audio: { ...x.audio, fadeInFrames: secondsToFrames(v, fps, "round") } }))} />
          <Num label="Fade out" value={framesToSeconds(c.audio.fadeOutFrames, fps)} min={0} max={Math.min(10, framesToSeconds(c.duration, fps))} step={0.1} unit="s" onChange={(v) => set("Fade out", "fo", (x) => ({ audio: { ...x.audio, fadeOutFrames: secondsToFrames(v, fps, "round") } }))} />
          <label className="row check">
            <input type="checkbox" checked={c.audio.muted} onChange={(e) => session.run("Mute clip", (p) => updateClip(p, c.id, { audio: { ...c.audio, muted: e.target.checked } }))} /> Mute this clip
          </label>
        </section>
      )}

      {hit.track.kind !== "audio" && (
        <section>
          <h4>Transition in</h4>
          {(() => {
            const prev = hit.track.clips.find((x) => clipEnd(x) === c.start);
            if (!prev) return <p className="hint">Butt this clip against another on the same track to add a crossfade.</p>;
            return (
              <Num
                label="Crossfade"
                value={c.transitionIn ? framesToSeconds(c.transitionIn.frames, fps) : 0}
                min={0}
                max={Math.min(3, framesToSeconds(Math.min(c.duration, prev.duration), fps))}
                step={0.05}
                unit="s"
                onChange={(v) => session.runCoalesced("Crossfade", `${c.id}:xf`, (p) => setTransitionIn(p, c.id, secondsToFrames(v, fps, "round") || null))}
              />
            );
          })()}
        </section>
      )}

      {asset && (
        <section className="asset-info">
          <h4>Source</h4>
          <div className="dim small break">{asset.name}</div>
          <div className="dim small">
            {asset.meta.width ? `${asset.meta.width}×${asset.meta.height} · ` : ""}
            {asset.meta.videoCodec ?? ""} {asset.meta.audioCodec ? `· ${asset.meta.audioCodec}` : ""}
            {asset.meta.variableFrameRate ? " · VFR" : ""}
          </div>
          <div className="dim small">In {formatTimecode(c.sourceIn, fps)}</div>
        </section>
      )}
    </div>
  );
}

function ProjectInspector({ project, session }: { project: Project; session: EditorSession }) {
  const p = project.profile;
  return (
    <div className="inspector">
      <div className="insp-head"><strong>Project</strong></div>
      <section>
        <div className="kv"><span>Canvas</span><span>{p.width}×{p.height}</span></div>
        <div className="kv"><span>Frame rate</span><span>{(p.fps.num / p.fps.den).toFixed(p.fps.den === 1 ? 0 : 3)} fps ({p.fps.num}/{p.fps.den})</span></div>
        <div className="kv"><span>Audio</span><span>{p.sampleRate / 1000} kHz stereo</span></div>
        <div className="prop">
          <label>
            <span>Background</span>
            <input type="color" value={p.background} onChange={(e) => session.runCoalesced("Background", "bg", (x) => ({ ...x, profile: { ...x.profile, background: e.target.value } }))} />
          </label>
        </div>
      </section>
      <p className="hint">Select a clip to edit its transform, color, speed, audio and transitions.</p>
    </div>
  );
}
