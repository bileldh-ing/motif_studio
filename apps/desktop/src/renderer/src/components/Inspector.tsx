import type { Clip, AnimatableProperty, Project } from "@motif/project-schema";
import { FONTS, LOOKS, TRANSITION_KINDS, ANIM_KINDS } from "@motif/project-schema";
import {
  findClip,
  updateClip,
  setClipSpeed,
  setTransition,
  setKeyframe,
  removeKeyframe,
  propertyAt,
  clipEnd,
  formatTimecode,
  framesToSeconds,
  secondsToFrames,
  applyLook,
  freezeFrame,
  NEUTRAL_COLOR,
} from "@motif/editor-core";
import { EditorSession, useSession, type InspectorTab } from "../editorStore";
import { Icon } from "../icons";

export function Num({ label, value, min, max, step, onChange, unit, kf }: { label: string; value: number; min: number; max: number; step: number; unit?: string; onChange: (v: number) => void; kf?: { on: boolean; has: boolean; toggle: () => void } }) {
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
        <em>{unit ?? ""}</em>
      </label>
      {kf ? (
        <button className={"kf" + (kf.on ? " on" : kf.has ? " has" : "")} title={kf.on ? "Remove keyframe at playhead" : "Add keyframe at playhead"} onClick={kf.toggle} aria-pressed={kf.on}>◆</button>
      ) : (
        <span className="kf-spacer" />
      )}
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle">
      <span>{label}</span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <i />
    </label>
  );
}

const pretty = (s: string) => s.replace(/-/g, " ").replace(/^\w/, (m) => m.toUpperCase());

export function Inspector({ session }: { session: EditorSession }) {
  const { project, ui } = useSession(session);
  const id = ui.selection[0];
  const hit = id ? findClip(project, id) : null;
  if (!hit) return <ProjectInspector project={project} session={session} />;
  const c = hit.clip;
  const fps = project.profile.fps;
  const local = Math.max(0, Math.min(c.duration - 1, ui.playhead - c.start));
  const inClip = ui.playhead >= c.start && ui.playhead < clipEnd(c);
  const asset = c.assetId ? project.assets.find((a) => a.id === c.assetId) : undefined;
  const isAudio = hit.track.kind === "audio" || asset?.kind === "audio";
  const isVisualMedia = c.kind === "media" && !isAudio;
  const set = (label: string, key: string, patch: (c: Clip) => Partial<Clip>) => session.runCoalesced(label, `${c.id}:${key}`, (p) => updateClip(p, c.id, patch(findClip(p, c.id)!.clip)));
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
  const speed = c.speed.num / c.speed.den;

  const tabs: [InspectorTab, string][] =
    c.kind === "text"
      ? [["text", "Text"], ["video", "Position"], ["animation", "Animation"]]
      : c.kind === "shape"
        ? [["shape", "Shape"], ["video", "Position"], ["animation", "Animation"]]
        : isAudio
          ? [["audio", "Audio"], ["speed", "Speed"]]
          : [["video", "Video"], ["adjust", "Adjust"], ["animation", "Animation"], ["speed", "Speed"], ...(asset?.meta.hasAudio ? ([["audio", "Audio"]] as [InspectorTab, string][]) : [])];
  const tab = tabs.some(([k]) => k === ui.inspectorTab) ? ui.inspectorTab : tabs[0]![0];
  const W = project.profile.width;
  const H = project.profile.height;

  return (
    <div className="inspector glass-panel">
      <div className="insp-head">
        <div>
          <strong>{c.kind === "text" ? (c.text?.role === "caption" ? "Caption" : "Title") : c.kind === "shape" ? "Shape" : asset?.kind === "image" ? "Image" : isAudio ? "Audio" : "Video"}</strong>
          <div className="dim small ellipsis">{c.name}</div>
        </div>
        <Toggle label="" checked={c.enabled} onChange={(v) => session.run("Toggle clip", (p) => updateClip(p, c.id, { enabled: v }))} />
      </div>
      <div className="insp-tabs" role="tablist">
        {tabs.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => session.setUi({ inspectorTab: k })}>{label}</button>
        ))}
      </div>
      <div className="insp-body">
        {tab === "video" && (
          <>
            <section>
              <h4>Transform {inClip ? "" : <span className="dim small">· playhead outside clip</span>}</h4>
              <Num label="Position X" value={propertyAt(c, "x", local)} min={-W} max={W} step={1} unit="px" onChange={(v) => setProp("x", v)} kf={c.kind === "text" ? undefined : kf("x")} />
              <Num label="Position Y" value={propertyAt(c, "y", local)} min={-H} max={H} step={1} unit="px" onChange={(v) => setProp("y", v)} kf={c.kind === "text" ? undefined : kf("y")} />
              <Num label="Scale" value={propertyAt(c, "scale", local)} min={0.05} max={5} step={0.01} unit="×" onChange={(v) => setProp("scale", v)} kf={c.kind === "text" ? undefined : kf("scale")} />
              {c.kind !== "text" && <Num label="Rotation" value={propertyAt(c, "rotation", local)} min={-180} max={180} step={0.5} unit="°" onChange={(v) => setProp("rotation", v)} kf={kf("rotation")} />}
              <Num label="Opacity" value={c.transform.opacity} min={0} max={1} step={0.01} onChange={(v) => set("Opacity", "op", (x) => ({ transform: { ...x.transform, opacity: v } }))} />
              <button className="link" onClick={() => session.run("Reset transform", (p) => updateClip(p, c.id, { transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, keyframes: {} }))}>Reset transform & keyframes</button>
            </section>
            {isVisualMedia && (
              <>
                <section>
                  <h4>Crop & flip</h4>
                  <Num label="Left" value={c.crop.l} min={0} max={0.9} step={0.01} onChange={(v) => set("Crop", "cl", (x) => ({ crop: { ...x.crop, l: Math.min(v, 0.95 - x.crop.r) } }))} />
                  <Num label="Right" value={c.crop.r} min={0} max={0.9} step={0.01} onChange={(v) => set("Crop", "cr", (x) => ({ crop: { ...x.crop, r: Math.min(v, 0.95 - x.crop.l) } }))} />
                  <Num label="Top" value={c.crop.t} min={0} max={0.9} step={0.01} onChange={(v) => set("Crop", "ct", (x) => ({ crop: { ...x.crop, t: Math.min(v, 0.95 - x.crop.b) } }))} />
                  <Num label="Bottom" value={c.crop.b} min={0} max={0.9} step={0.01} onChange={(v) => set("Crop", "cb", (x) => ({ crop: { ...x.crop, b: Math.min(v, 0.95 - x.crop.t) } }))} />
                  <div className="seg">
                    <button className={c.flipH ? "on" : ""} onClick={() => session.run("Flip horizontal", (p) => updateClip(p, c.id, { flipH: !c.flipH }))}><Icon name="flip" size={13} /> Mirror</button>
                    <button className={c.flipV ? "on" : ""} onClick={() => session.run("Flip vertical", (p) => updateClip(p, c.id, { flipV: !c.flipV }))}><Icon name="flip" size={13} style={{ transform: "rotate(90deg)" }} /> Flip</button>
                    <button onClick={() => session.run("Reset crop", (p) => updateClip(p, c.id, { crop: { l: 0, t: 0, r: 0, b: 0 }, flipH: false, flipV: false }))}>Reset</button>
                  </div>
                </section>
                <section>
                  <h4>Canvas background</h4>
                  <div className="seg">
                    <button className={c.bgFill === "none" ? "on" : ""} onClick={() => session.run("Background", (p) => updateClip(p, c.id, { bgFill: "none" }))}>None</button>
                    <button className={c.bgFill === "blur" ? "on" : ""} onClick={() => session.run("Background blur", (p) => updateClip(p, c.id, { bgFill: "blur" }))}>Blur fill</button>
                  </div>
                </section>
                <section>
                  <h4>Mask</h4>
                  <div className="seg">
                    {(["none", "ellipse", "rect"] as const).map((m) => (
                      <button key={m} className={c.mask.shape === m ? "on" : ""} onClick={() => session.run("Mask", (p) => updateClip(p, c.id, { mask: { ...c.mask, shape: m } }))}>{m === "rect" ? "Rectangle" : pretty(m)}</button>
                    ))}
                  </div>
                  {c.mask.shape !== "none" && (
                    <>
                      <Num label="Width" value={c.mask.w} min={0.02} max={1} step={0.01} onChange={(v) => set("Mask", "mw", (x) => ({ mask: { ...x.mask, w: v } }))} />
                      <Num label="Height" value={c.mask.h} min={0.02} max={1} step={0.01} onChange={(v) => set("Mask", "mh", (x) => ({ mask: { ...x.mask, h: v } }))} />
                      <Num label="Centre X" value={c.mask.cx} min={-0.5} max={0.5} step={0.01} onChange={(v) => set("Mask", "mx", (x) => ({ mask: { ...x.mask, cx: v } }))} />
                      <Num label="Centre Y" value={c.mask.cy} min={-0.5} max={0.5} step={0.01} onChange={(v) => set("Mask", "my", (x) => ({ mask: { ...x.mask, cy: v } }))} />
                      <Num label="Feather" value={c.mask.feather} min={0} max={0.5} step={0.01} onChange={(v) => set("Mask", "mf", (x) => ({ mask: { ...x.mask, feather: v } }))} />
                      <Toggle label="Invert" checked={c.mask.invert} onChange={(v) => session.run("Invert mask", (p) => updateClip(p, c.id, { mask: { ...c.mask, invert: v } }))} />
                    </>
                  )}
                </section>
                <section>
                  <h4>Chroma key</h4>
                  <Toggle label="Remove a colour" checked={c.chroma.enabled} onChange={(v) => session.run("Chroma key", (p) => updateClip(p, c.id, { chroma: { ...c.chroma, enabled: v } }))} />
                  {c.chroma.enabled && (
                    <>
                      <div className="prop">
                        <label>
                          <span>Key colour</span>
                          <input type="color" value={c.chroma.color} onChange={(e) => set("Key colour", "kc", (x) => ({ chroma: { ...x.chroma, color: e.target.value } }))} />
                          <span className="dim small">{c.chroma.color}</span>
                        </label>
                      </div>
                      <Num label="Strength" value={c.chroma.similarity} min={0.01} max={1} step={0.01} onChange={(v) => set("Chroma", "ks", (x) => ({ chroma: { ...x.chroma, similarity: v } }))} />
                      <Num label="Edge" value={c.chroma.blend} min={0} max={1} step={0.01} onChange={(v) => set("Chroma", "kb", (x) => ({ chroma: { ...x.chroma, blend: v } }))} />
                    </>
                  )}
                </section>
              </>
            )}
          </>
        )}

        {tab === "adjust" && (
          <>
            <section>
              <h4>Filters</h4>
              <div className="look-grid">
                <button className={!c.color.look ? "on" : ""} onClick={() => session.run("Remove filter", (p) => applyLook(p, c.id, null))}>None</button>
                {LOOKS.map((l) => (
                  <button key={l.id} className={c.color.look === l.id ? "on" : ""} onClick={() => session.run(`Filter ${l.label}`, (p) => applyLook(p, c.id, l.id))}>
                    <span className={`look-swatch look-${l.id}`} />
                    {l.label}
                  </button>
                ))}
              </div>
            </section>
            <section>
              <h4>Adjust</h4>
              <Num label="Brightness" value={c.color.brightness} min={-1} max={1} step={0.01} onChange={(v) => set("Brightness", "br", (x) => ({ color: { ...x.color, brightness: v } }))} />
              <Num label="Contrast" value={c.color.contrast} min={0} max={3} step={0.01} onChange={(v) => set("Contrast", "ct", (x) => ({ color: { ...x.color, contrast: v } }))} />
              <Num label="Saturation" value={c.color.saturation} min={0} max={3} step={0.01} onChange={(v) => set("Saturation", "sat", (x) => ({ color: { ...x.color, saturation: v } }))} />
              <Num label="Temperature" value={c.color.temperature} min={-1} max={1} step={0.01} onChange={(v) => set("Temperature", "tmp", (x) => ({ color: { ...x.color, temperature: v } }))} />
              <Num label="Hue" value={c.color.hue} min={-180} max={180} step={1} unit="°" onChange={(v) => set("Hue", "hue", (x) => ({ color: { ...x.color, hue: v } }))} />
              <Num label="Sepia" value={c.color.sepia} min={0} max={1} step={0.01} onChange={(v) => set("Sepia", "sep", (x) => ({ color: { ...x.color, sepia: v } }))} />
              <Num label="Black & white" value={c.color.grayscale} min={0} max={1} step={0.01} onChange={(v) => set("Grayscale", "gr", (x) => ({ color: { ...x.color, grayscale: v } }))} />
              <Num label="Blur" value={c.color.blur} min={0} max={60} step={0.5} unit="px" onChange={(v) => set("Blur", "bl", (x) => ({ color: { ...x.color, blur: v } }))} />
              <Num label="Vignette" value={c.color.vignette} min={0} max={1} step={0.01} onChange={(v) => set("Vignette", "vg", (x) => ({ color: { ...x.color, vignette: v } }))} />
              <Toggle label="Invert colours" checked={c.color.invert} onChange={(v) => session.run("Invert", (p) => updateClip(p, c.id, { color: { ...c.color, invert: v } }))} />
              <button className="link" onClick={() => session.run("Reset colour", (p) => updateClip(p, c.id, { color: NEUTRAL_COLOR }))}>Reset adjustments</button>
            </section>
          </>
        )}

        {tab === "animation" && (
          <>
            <section>
              <h4>Transition in</h4>
              {(() => {
                const prev = hit.track.clips.find((x) => clipEnd(x) === c.start);
                if (!prev) return <p className="hint">Butt this clip against another on the same track to add a transition.</p>;
                return (
                  <>
                    <div className="chip-grid">
                      <button className={!c.transitionIn ? "on" : ""} onClick={() => session.run("Remove transition", (p) => setTransition(p, c.id, null, 0))}>None</button>
                      {TRANSITION_KINDS.map((k) => (
                        <button key={k} className={c.transitionIn?.kind === k ? "on" : ""} onClick={() => session.run("Transition", (p) => setTransition(p, c.id, k, c.transitionIn?.frames ?? secondsToFrames(0.5, fps)))}>{pretty(k)}</button>
                      ))}
                    </div>
                    {c.transitionIn && (
                      <Num label="Duration" value={framesToSeconds(c.transitionIn.frames, fps)} min={0.05} max={Math.min(3, framesToSeconds(Math.min(c.duration, prev.duration), fps))} step={0.05} unit="s" onChange={(v) => session.runCoalesced("Transition length", `${c.id}:xf`, (p) => setTransition(p, c.id, c.transitionIn!.kind, Math.max(1, secondsToFrames(v, fps, "round"))))} />
                    )}
                  </>
                );
              })()}
            </section>
            {(["animIn", "animOut"] as const).map((key) => (
              <section key={key}>
                <h4>{key === "animIn" ? "Animation in" : "Animation out"}</h4>
                <div className="chip-grid">
                  {ANIM_KINDS.map((k) => (
                    <button key={k} className={c[key].kind === k ? "on" : ""} onClick={() => session.run("Animation", (p) => updateClip(p, c.id, { [key]: { ...c[key], kind: k } } as Partial<Clip>))}>{pretty(k)}</button>
                  ))}
                </div>
                {c[key].kind !== "none" && (
                  <Num label="Duration" value={framesToSeconds(c[key].frames, fps)} min={0.1} max={Math.max(0.1, Math.min(5, framesToSeconds(c.duration, fps)))} step={0.05} unit="s" onChange={(v) => set("Animation length", key, (x) => ({ [key]: { ...x[key], frames: Math.max(1, Math.min(x.duration, secondsToFrames(v, fps, "round"))) } }) as Partial<Clip>)} />
                )}
              </section>
            ))}
          </>
        )}

        {tab === "speed" && (
          <section>
            <h4>Speed</h4>
            <div className="seg">
              {[0.25, 0.5, 1, 1.5, 2, 3, 4].map((s) => (
                <button key={s} className={Math.abs(speed - s) < 1e-6 ? "on" : ""} disabled={c.freeze} onClick={() => session.run("Change speed", (p) => setClipSpeed(p, c.id, s === 1.5 ? { num: 3, den: 2 } : s < 1 ? { num: 1, den: 1 / s } : { num: s, den: 1 }))}>{s}×</button>
              ))}
            </div>
            <p className="hint">Audio keeps its pitch. Duration scales to keep the same source range.</p>
            {asset?.kind === "video" || isAudio ? <Toggle label="Reverse" checked={c.reverse} onChange={(v) => session.run("Reverse", (p) => updateClip(p, c.id, { reverse: v }))} /> : null}
            {asset?.kind === "video" && !c.freeze && (
              <button className="wide" disabled={!inClip} onClick={() => session.run("Freeze frame", (p) => freezeFrame(p, c.id, ui.playhead, secondsToFrames(2, fps)).project)}>
                <Icon name="freeze" size={14} /> Freeze frame at playhead (2 s)
              </button>
            )}
            {c.freeze && <p className="hint">This clip holds a single frame.</p>}
          </section>
        )}

        {tab === "audio" && (
          <section>
            <h4>Audio</h4>
            <Num label="Volume" value={c.audio.gainDb} min={-60} max={24} step={0.5} unit="dB" onChange={(v) => set("Volume", "vol", (x) => ({ audio: { ...x.audio, gainDb: v } }))} />
            <Num label="Pan" value={c.audio.pan} min={-1} max={1} step={0.05} onChange={(v) => set("Pan", "pan", (x) => ({ audio: { ...x.audio, pan: v } }))} />
            <Num label="Fade in" value={framesToSeconds(c.audio.fadeInFrames, fps)} min={0} max={Math.min(10, framesToSeconds(c.duration, fps))} step={0.1} unit="s" onChange={(v) => set("Fade in", "fi", (x) => ({ audio: { ...x.audio, fadeInFrames: secondsToFrames(v, fps, "round") } }))} />
            <Num label="Fade out" value={framesToSeconds(c.audio.fadeOutFrames, fps)} min={0} max={Math.min(10, framesToSeconds(c.duration, fps))} step={0.1} unit="s" onChange={(v) => set("Fade out", "fo", (x) => ({ audio: { ...x.audio, fadeOutFrames: secondsToFrames(v, fps, "round") } }))} />
            <Toggle label="Reduce noise" checked={c.audio.denoise} onChange={(v) => session.run("Reduce noise", (p) => updateClip(p, c.id, { audio: { ...c.audio, denoise: v } }))} />
            <h4>Voice changer</h4>
            <div className="chip-grid">
              {[["Normal", 0], ["Chipmunk", 7], ["High", 4], ["Low", -4], ["Deep", -7]].map(([l, v]) => (
                <button key={l as string} className={c.audio.pitch === v ? "on" : ""} onClick={() => session.run("Voice", (p) => updateClip(p, c.id, { audio: { ...c.audio, pitch: v as number } }))}>{l}</button>
              ))}
            </div>
            <Num label="Pitch" value={c.audio.pitch} min={-12} max={12} step={1} unit="st" onChange={(v) => set("Pitch", "pitch", (x) => ({ audio: { ...x.audio, pitch: v } }))} />
            {(c.audio.denoise || c.audio.pitch !== 0) && <p className="hint">Noise reduction and pitch are rendered on export; the live preview plays the original sound.</p>}
            <Toggle label="Mute this clip" checked={c.audio.muted} onChange={(v) => session.run("Mute clip", (p) => updateClip(p, c.id, { audio: { ...c.audio, muted: v } }))} />
          </section>
        )}

        {tab === "text" && c.text && (
          <section>
            <h4>Text</h4>
            <textarea value={c.text.content} rows={3} maxLength={2000} onChange={(e) => set("Edit text", "text", (x) => ({ text: { ...x.text!, content: e.target.value }, name: e.target.value.slice(0, 32) }))} />
            <div className="font-grid">
              {FONTS.map((f) => (
                <button key={f.id} className={c.text!.font === f.id ? "on" : ""} style={{ fontFamily: f.css }} onClick={() => session.run("Font", (p) => updateClip(p, c.id, { text: { ...c.text!, font: f.id } }))}>{f.label}</button>
              ))}
            </div>
            <Num label="Size" value={c.text.fontSize} min={8} max={400} step={1} onChange={(v) => set("Text size", "fs", (x) => ({ text: { ...x.text!, fontSize: Math.round(v) } }))} />
            <div className="prop">
              <label>
                <span>Colour</span>
                <input type="color" value={c.text.color} onChange={(e) => set("Text colour", "tc", (x) => ({ text: { ...x.text!, color: e.target.value } }))} />
                <span />
              </label>
            </div>
            <Toggle label="Bold" checked={c.text.bold} onChange={(v) => session.run("Bold", (p) => updateClip(p, c.id, { text: { ...c.text!, bold: v } }))} />
            <Num label="Stroke" value={c.text.strokeWidth} min={0} max={30} step={0.5} unit="px" onChange={(v) => set("Stroke", "sw", (x) => ({ text: { ...x.text!, strokeWidth: v } }))} />
            {c.text.strokeWidth > 0 && (
              <div className="prop">
                <label>
                  <span>Stroke colour</span>
                  <input type="color" value={c.text.strokeColor} onChange={(e) => set("Stroke colour", "sc", (x) => ({ text: { ...x.text!, strokeColor: e.target.value } }))} />
                  <span />
                </label>
              </div>
            )}
            <Toggle label="Shadow" checked={c.text.shadow} onChange={(v) => session.run("Shadow", (p) => updateClip(p, c.id, { text: { ...c.text!, shadow: v } }))} />
            <Toggle label="Background box" checked={!!c.text.boxColor} onChange={(v) => session.run("Text box", (p) => updateClip(p, c.id, { text: { ...c.text!, boxColor: v ? "#000000" : undefined } }))} />
            {c.text.boxColor && (
              <>
                <div className="prop">
                  <label>
                    <span>Box colour</span>
                    <input type="color" value={c.text.boxColor} onChange={(e) => set("Box colour", "bc", (x) => ({ text: { ...x.text!, boxColor: e.target.value } }))} />
                    <span />
                  </label>
                </div>
                <Num label="Box opacity" value={c.text.boxOpacity} min={0} max={1} step={0.01} onChange={(v) => set("Box opacity", "bo", (x) => ({ text: { ...x.text!, boxOpacity: v } }))} />
              </>
            )}
            <div className="seg">
              {(["top", "center", "lower-third"] as const).map((a) => (
                <button key={a} className={c.text!.align === a ? "on" : ""} onClick={() => session.run("Text position", (p) => updateClip(p, c.id, { text: { ...c.text!, align: a } }))}>{a === "lower-third" ? "Bottom" : pretty(a)}</button>
              ))}
            </div>
            <Toggle label="Include in SRT captions" checked={c.text.role === "caption"} onChange={(v) => session.run("Caption flag", (p) => updateClip(p, c.id, { text: { ...c.text!, role: v ? "caption" : "title" } }))} />
          </section>
        )}

        {tab === "shape" && c.shape && (
          <section>
            <h4>Shape</h4>
            <div className="seg">
              {(["rect", "ellipse"] as const).map((t) => (
                <button key={t} className={c.shape!.type === t ? "on" : ""} onClick={() => session.run("Shape type", (p) => updateClip(p, c.id, { shape: { ...c.shape!, type: t } }))}>{t === "rect" ? "Rectangle" : "Ellipse"}</button>
              ))}
            </div>
            <div className="prop">
              <label>
                <span>Fill</span>
                <input type="color" value={c.shape.fill} onChange={(e) => set("Fill", "fill", (x) => ({ shape: { ...x.shape!, fill: e.target.value } }))} />
                <span />
              </label>
            </div>
            <Num label="Width" value={c.shape.w} min={2} max={W * 2} step={1} unit="px" onChange={(v) => set("Shape width", "sw", (x) => ({ shape: { ...x.shape!, w: Math.round(v) } }))} />
            <Num label="Height" value={c.shape.h} min={2} max={H * 2} step={1} unit="px" onChange={(v) => set("Shape height", "sh", (x) => ({ shape: { ...x.shape!, h: Math.round(v) } }))} />
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
            <div className="dim small">In {formatTimecode(c.sourceIn, fps)} · {framesToSeconds(c.duration, fps).toFixed(2)} s</div>
          </section>
        )}
      </div>
    </div>
  );
}

function ProjectInspector({ project, session }: { project: Project; session: EditorSession }) {
  const p = project.profile;
  return (
    <div className="inspector glass-panel">
      <div className="insp-head"><strong>Project</strong></div>
      <div className="insp-body">
        <section>
          <div className="kv"><span>Canvas</span><span>{p.width}×{p.height}</span></div>
          <div className="kv"><span>Frame rate</span><span>{(p.fps.num / p.fps.den).toFixed(p.fps.den === 1 ? 0 : 3)} fps</span></div>
          <div className="kv"><span>Audio</span><span>{p.sampleRate / 1000} kHz stereo</span></div>
          <div className="kv"><span>Clips</span><span>{project.tracks.reduce((n, t) => n + t.clips.length, 0)}</span></div>
          <div className="prop">
            <label>
              <span>Background</span>
              <input type="color" value={p.background} onChange={(e) => session.runCoalesced("Background", "bg", (x) => ({ ...x, profile: { ...x.profile, background: e.target.value } }))} />
              <span />
            </label>
          </div>
        </section>
        <p className="hint">Select a clip in the timeline or on the canvas to edit it. Press Ctrl+K for every command.</p>
      </div>
    </div>
  );
}
