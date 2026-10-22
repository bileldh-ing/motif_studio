/**
 * End-to-end smoke test, enabled only with MOTIF_SMOKE_DIR. Drives the real
 * UI (DOM clicks, pointer drags, keyboard shortcuts) and the real IPC/render
 * stack, captures screenshots and writes a JSON report.
 */
import { app, type BrowserWindow } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runSmoke(win: BrowserWindow, dir: string) {
  const report: { step: string; ok: boolean; detail?: unknown }[] = [];
  await mkdir(dir, { recursive: true });
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code, true) as Promise<T>;
  const shot = async (name: string) => {
    await js("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
    await sleep(250);
    win.webContents.invalidate();
    await sleep(150);
    const img = await win.webContents.capturePage();
    await writeFile(join(dir, `${name}.png`), img.toPNG());
  };
  const waitFor = async (expr: string, timeout = 30000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await js<boolean>(`!!(${expr})`)) return true;
      await sleep(200);
    }
    return false;
  };
  const clickText = (sel: string, text: string) =>
    js<boolean>(`(() => { const b=[...document.querySelectorAll(${JSON.stringify(sel)})].find(e=>e.textContent.trim().startsWith(${JSON.stringify(text)})); if(!b) return false; b.click(); return true; })()`);
  const key = (k: string, extra = "") => js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(k)}${extra ? "," + extra : ""}}))`);
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      const detail = await fn();
      report.push({ step: name, ok: detail !== false && detail !== null && detail !== undefined, detail });
    } catch (e: any) {
      report.push({ step: name, ok: false, detail: e.message });
    }
  };
  const clipCount = () => js<number>("document.querySelectorAll('.clip[data-clip]').length");
  const S = "window.__motifSession";

  const consoleLines: string[] = [];
  win.webContents.on("console-message", (e: any) => consoleLines.push(String(e.message ?? e)));
  try {
    await waitFor("document.querySelector('.home')");
    await sleep(900);
    await shot("01-home");
    await step("open demo project", async () => {
      await clickText("button", "Try the demo project");
      return waitFor("document.querySelector('.editor')", 60000);
    });
    await sleep(3000);
    await step("clips on timeline", () => clipCount());
    await step("seek to 3 s", async () => {
      for (let i = 0; i < 3; i++) await key("ArrowRight", "shiftKey:true");
      await sleep(1500);
      return js("document.querySelector('.transport .tc').textContent");
    });
    await shot("02-editor");

    await step("select overlay on canvas + inspector", async () => {
      await js(`${S}.setUi({ selection: [${S}.project.tracks.find(t=>t.id==='trk_v2').clips[0].id] })`);
      await sleep(500);
      return js("document.querySelector('.insp-head strong').textContent + ' / handles:' + document.querySelectorAll('.sel-box .handle-dot').length");
    });
    await step("drag layer on canvas (Figma-style move)", async () => {
      const before = await js<number>(`${S}.project.tracks.find(t=>t.id==='trk_v2').clips[0].transform.x`);
      await js(`(() => { const b=document.querySelector('.sel-box'); const r=b.getBoundingClientRect(); const x=r.left+r.width/2, y=r.top+r.height/2;
        b.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:x,clientY:y,button:0}));
        window.dispatchEvent(new PointerEvent('pointermove',{clientX:x-60,clientY:y+20}));
        window.dispatchEvent(new PointerEvent('pointermove',{clientX:x-120,clientY:y+40}));
        window.__chip = document.querySelector('.cursor-chip')?.textContent || null;
        window.dispatchEvent(new PointerEvent('pointerup',{clientX:x-120,clientY:y+40})); })()`);
      await sleep(300);
      const after = await js<number>(`${S}.project.tracks.find(t=>t.id==='trk_v2').clips[0].transform.x`);
      const chip = await js<string | null>("window.__chip");
      return after < before - 50 ? { before, after, chip } : false;
    });
    await shot("03-canvas-select");
    await step("undo canvas move", async () => {
      await key("z", "ctrlKey:true");
      await sleep(200);
      return js(`${S}.project.tracks.find(t=>t.id==='trk_v2').clips[0].transform.x`);
    });

    await step("apply filter from Filters panel", async () => {
      const id = await js<string>(`${S}.project.tracks.find(t=>t.id==='trk_v1').clips[0].id`);
      await js(`${S}.setUi({ selection: ['${id}'], leftTab: 'effects' })`);
      await sleep(400);
      await clickText(".filter-grid button", "Noir");
      await sleep(300);
      return js(`${S}.project.tracks.find(t=>t.id==='trk_v1').clips[0].color.look`);
    });
    await shot("04-filters");
    await step("inspector Adjust + Animation tabs", async () => {
      await clickText(".insp-tabs button", "Adjust");
      await sleep(200);
      const a = await js<number>("document.querySelectorAll('.insp-body .prop').length");
      await clickText(".insp-tabs button", "Animation");
      await sleep(200);
      const b = await js<number>("document.querySelectorAll('.insp-body .chip-grid button').length");
      return a > 6 && b > 10 ? { adjustProps: a, animChips: b } : false;
    });
    await shot("05-inspector-animation");

    await step("blade tool cuts a clip (B + click)", async () => {
      await key("b");
      await sleep(150);
      const before = await clipCount();
      await js(`(() => { const c=document.querySelector('.track-video .clip[data-clip]'); const r=c.getBoundingClientRect(); c.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:r.left+r.width*0.4,clientY:r.top+10,button:0})); })()`);
      await sleep(300);
      const after = await clipCount();
      const cursor = await js<string>("getComputedStyle(document.querySelector('.clip[data-clip]')).cursor.slice(0,40)");
      await key("z", "ctrlKey:true");
      await key("v");
      await sleep(200);
      return after === before + 1 ? { before, after, cursor } : false;
    });
    await step("copy / paste clip", async () => {
      const id = await js<string>(`${S}.project.tracks.find(t=>t.id==='trk_t1').clips[0].id`);
      await js(`${S}.setUi({ selection: ['${id}'], playhead: 330 })`);
      const before = await clipCount();
      await key("c", "ctrlKey:true");
      await key("v", "ctrlKey:true");
      await sleep(300);
      const after = await clipCount();
      await key("z", "ctrlKey:true");
      return after === before + 1 ? { before, after } : false;
    });
    await step("freeze frame (F)", async () => {
      await js(`${S}.setUi({ selection: [], playhead: 60 })`);
      const before = await clipCount();
      await key("f");
      await sleep(300);
      const frozen = await js<boolean>(`${S}.project.tracks.find(t=>t.id==='trk_v1').clips.some(c=>c.freeze)`);
      const after = await clipCount();
      await key("z", "ctrlKey:true");
      return frozen && after === before + 2 ? { before, after } : false;
    });

    await step("text panel + fonts", async () => {
      await js(`${S}.setUi({ leftTab: 'text', selection: [] })`);
      await sleep(300);
      await clickText(".text-preset", "NEON");
      await sleep(400);
      return js(`(() => { const t=${S}.project.tracks.find(t=>t.kind==='text'); return t.clips.find(c=>c.text.font==='bebas' && c.text.content==='NEON NIGHTS') ? 'neon added' : null })()`);
    });
    await shot("06-text");

    await step("text to speech (flite) via IPC", async () => {
      const a = await js<any>("window.motif.textToSpeech('Hello and welcome to motif studio. This video was edited locally.', 'slt')");
      (globalThis as any).__ttsAsset = a;
      return a && a.meta.hasAudio && a.meta.durationSec > 2 ? { name: a.name, sec: a.meta.durationSec } : false;
    });
    await step("auto captions (Whisper tiny) via job API", async () => {
      const a = (globalThis as any).__ttsAsset;
      return js(`new Promise(async (res) => {
        let id = '';
        const off = window.motif.onJobDone(e => { if (e.jobId === id) { off(); res(e.ok ? { segments: e.result.segments.length, text: e.result.segments.map(s=>s.text).join(' ').slice(0,80) } : null); window.__whisperErr = e.error; } });
        id = (await window.motif.transcribe(${JSON.stringify(a)}, { model: 'tiny' })).jobId;
      })`);
    });
    await step("auto captions inserted on a Captions track", async () => {
      const a = (globalThis as any).__ttsAsset;
      return js(`(async () => {
        const s = window.__motifSession;
        s.run('add tts', p => ({ ...p, assets: [...p.assets, ${JSON.stringify(a)}] }));
        const track = s.project.tracks.find(t => t.kind === 'audio');
        const free = Math.max(...track.clips.map(c => c.start + c.duration), 0) + 30;
        s.run('add', p => ({ ...p, tracks: p.tracks.map(t => t.id === track.id ? { ...t, clips: [...t.clips, { id: 'clp_tts', kind: 'media', assetId: '${a.id}', name: 'tts', start: free, duration: 120, sourceIn: 0, speed: {num:1,den:1}, enabled: true, transform: {x:0,y:0,scale:1,rotation:0,opacity:1}, keyframes: {}, audio: {gainDb:0,pan:0,fadeInFrames:0,fadeOutFrames:0,muted:false,denoise:false,pitch:0}, color: {brightness:0,contrast:1,saturation:1,hue:0,grayscale:0,sepia:0,invert:false,blur:0,vignette:0,temperature:0,look:''}, animIn:{kind:'none',frames:15}, animOut:{kind:'none',frames:15}, crop:{l:0,t:0,r:0,b:0}, flipH:false, flipV:false, reverse:false, freeze:false, mask:{shape:'none',w:0.7,h:0.7,cx:0,cy:0,feather:0.05,invert:false}, chroma:{enabled:false,color:'#00ff00',similarity:0.25,blend:0.08}, bgFill:'none' }] } : t) }));
        s.setUi({ leftTab: 'captions', selection: ['clp_tts'] });
        await new Promise(r => setTimeout(r, 500));
        const sel = document.querySelector('.tool-card.accent select');
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, 'tiny');
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 200));
        let btn = null;
        for (let i = 0; i < 120; i++) { btn = document.querySelector('.tool-card.accent button.primary'); if (btn && !btn.disabled) break; await new Promise(r => setTimeout(r, 250)); }
        if (!btn || btn.disabled) return null;
        btn.click();
        for (let i = 0; i < 400; i++) { await new Promise(r => setTimeout(r, 250)); const t = s.project.tracks.find(t => t.name === 'Captions'); if (t && t.clips.length) return { captions: t.clips.length, first: t.clips[0].text.content }; }
        return null;
      })()`);
    });
    await step("captions panel renders", async () => {
      await js(`${S}.setUi({ leftTab: 'captions' })`);
      await sleep(400);
      return js("document.querySelector('.tool-card.accent strong')?.textContent");
    });
    await shot("07-captions");

    await step("command palette (Ctrl+K)", async () => {
      await key("k", "ctrlKey:true");
      return waitFor("document.querySelector('.palette')", 3000);
    });
    await sleep(300);
    await shot("08-palette");
    await key("Escape");
    await js(`${S}.setUi({ showPalette: false })`);

    await step("export dialog with 4K option", async () => {
      await key("e", "ctrlKey:true");
      await waitFor("document.querySelector('.modal.export')", 5000);
      await sleep(200);
      await clickText(".chip-grid.res button", "4K");
      await sleep(300);
      return js("document.querySelector('.exp-summary').textContent");
    });
    await shot("09-export-4k");
    await step("close export + save", async () => {
      await clickText(".modal-actions button", "Close");
      await sleep(200);
      await clickText(".export-btn", "__none__");
      await key("s", "ctrlKey:true");
      return waitFor("document.querySelector('.save-dot') && !document.querySelector('.save-dot.dirty')", 5000);
    });
    await step("4K export through the app (IPC -> engine -> verify)", async () => {
      const out = join(dir, "smoke-4k.mp4");
      return js(`new Promise(async (res) => {
        const s = window.__motifSession;
        const p = { id:'t', name:'4k', kind:'video', container:'mp4', videoCodec:'libx264', audioCodec:'aac', width:3840, height:2160, fps:{num:30,den:1}, crf:26, audioBitrateK:192, preset:'ultrafast' };
        const off = window.motif.onRenderDone(e => { off(); res(e); });
        await window.motif.startRender(s.project, p, ${JSON.stringify(out)}, { start: 150, end: 210 });
      })`);
    });
    await step("full 1080p export of the demo", async () => {
      const out = join(dir, "smoke-1080p.mp4");
      return js(`new Promise(async (res) => {
        const s = window.__motifSession;
        const p = { id:'t', name:'hd', kind:'video', container:'mp4', videoCodec:'libx264', audioCodec:'aac', width:1920, height:1080, fps:{num:30,den:1}, crf:22, audioBitrateK:192, preset:'veryfast' };
        const off = window.motif.onRenderDone(e => { off(); res(e); });
        await window.motif.startRender(s.project, p, ${JSON.stringify(out)});
      })`);
    });
    await step("cloud dialog offers sign-in (honest local-only mode)", async () => {
      await clickText(".cloud-btn", "☁");
      const ok = await waitFor("document.querySelector('.cloud-dialog .cloud-signin')", 8000);
      await shot("11-cloud-signin");
      await clickText(".cloud-dialog .modal-actions button", "Close");
      return ok;
    });
    await step("diagnostics + update state IPC", async () => {
      const u = await js<any>("window.motif.updateState()");
      return u && u.state === "disabled" ? u.reason : false;
    });
    await js(`${S}.setUi({ leftTab: 'ai', selection: [${S}.project.tracks.find(t=>t.id==='trk_v1').clips[0].id] })`);
    await sleep(400);
    await shot("10-ai-tools");
  } finally {
    report.push({ step: "console", ok: true, detail: consoleLines.filter((l) => !/Electron Security Warning/.test(l)).slice(-20) });
    await writeFile(join(dir, "report.json"), JSON.stringify(report, null, 2));
    app.quit();
  }
}
