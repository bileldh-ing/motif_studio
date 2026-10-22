/**
 * Tutorial-video director. Enabled with MOTIF_DEMO_DIR (and DISPLAY from Xvfb).
 * Records the real app with FFmpeg x11grab while it drives the real UI with
 * an animated presenter cursor, and writes chapters.json (chapter starts and
 * spotlight rectangles) for the post-production step (scripts/demo-video/compose.ts).
 */
import { app, type BrowserWindow } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getToolPaths } from "@motif/render-engine";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
interface Rect { x: number; y: number; w: number; h: number }
interface ChapterMark { id: string; start: number; end: number; spots: { t: number; rect: Rect; zoom: number }[] }

const CURSOR_JS = `(() => {
  if (window.__dc) return;
  const s = document.createElement('style');
  s.textContent = \`
    #__dc{position:fixed;left:0;top:0;width:34px;height:34px;z-index:2147483647;pointer-events:none;transform:translate(960px,540px);transition:transform var(--d,700ms) cubic-bezier(.65,0,.35,1);filter:drop-shadow(0 6px 14px rgba(0,0,0,.55))}
    #__dc svg{width:34px;height:34px}
    .__rip{position:fixed;z-index:2147483646;pointer-events:none;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;border:3px solid rgba(167,139,250,.95);animation:__r .55s ease-out forwards}
    @keyframes __r{to{transform:scale(4.2);opacity:0}}
    .__hl{position:fixed;z-index:2147483645;pointer-events:none;border-radius:16px;box-shadow:0 0 0 3px rgba(167,139,250,.9),0 0 40px 6px rgba(139,92,246,.45);transition:all .35s ease;opacity:0}
    .__key{position:fixed;left:50%;bottom:40px;transform:translateX(-50%);z-index:2147483647;pointer-events:none;font:600 26px/1 Poppins,sans-serif;color:#fff;padding:12px 20px;border-radius:14px;background:rgba(20,18,30,.82);border:1px solid rgba(255,255,255,.18);backdrop-filter:blur(18px);box-shadow:0 18px 50px rgba(0,0,0,.5);transition:opacity .25s}
    * { cursor: none !important }\`;
  document.head.appendChild(s);
  const c = document.createElement('div'); c.id='__dc';
  c.innerHTML='<svg viewBox="0 0 24 24"><path d="M4 2.5l15.5 9.2-6.9 1.3-3.4 6.5z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  document.body.appendChild(c);
  const hl = document.createElement('div'); hl.className='__hl'; document.body.appendChild(hl);
  window.__dc = { x: 960, y: 540,
    move(x, y) { const d = Math.min(1100, Math.max(350, Math.hypot(x - this.x, y - this.y) * 0.9)); c.style.setProperty('--d', d + 'ms'); c.style.transform = 'translate(' + (x - 4) + 'px,' + (y - 3) + 'px)'; this.x = x; this.y = y; return d; },
    ripple() { const r = document.createElement('div'); r.className='__rip'; r.style.left=this.x+'px'; r.style.top=this.y+'px'; document.body.appendChild(r); setTimeout(()=>r.remove(),600); },
    hl(rect) { if (!rect) { hl.style.opacity=0; return; } Object.assign(hl.style,{left:rect.x-6+'px',top:rect.y-6+'px',width:rect.w+12+'px',height:rect.h+12+'px',opacity:1}); },
    key(text) { let k=document.querySelector('.__key'); if(!k){k=document.createElement('div');k.className='__key';document.body.appendChild(k);} k.textContent=text; k.style.opacity=1; clearTimeout(this._kt); this._kt=setTimeout(()=>k.style.opacity=0,1400); }
  };
})()`;

export async function runDemo(win: BrowserWindow, dir: string) {
  await mkdir(dir, { recursive: true });
  const durations: Record<string, number> = JSON.parse(await readFile(join(dir, "narration", "durations.json"), "utf8").catch(() => "{}"));
  const js = <T = unknown>(code: string) => win.webContents.executeJavaScript(code, true).catch(() => null) as Promise<T>;
  const S = "window.__motifSession";
  const marks: ChapterMark[] = [];
  let t0 = 0;
  const now = () => (Date.now() - t0) / 1000;
  const rectOf = (sel: string, text?: string) =>
    js<Rect | null>(`(() => { const els=[...document.querySelectorAll(${JSON.stringify(sel)})]; const e=${text ? `els.find(x=>x.textContent.trim().startsWith(${JSON.stringify(text)}))` : "els[0]"}; if(!e) return null; e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect(); return {x:r.left,y:r.top,w:r.width,h:r.height}; })()`);
  const cur = () => marks[marks.length - 1]!;
  /** Ask post-production to zoom on a region. */
  const spot = async (sel: string, zoom = 1.6, text?: string) => {
    const r = await rectOf(sel, text);
    if (r) cur().spots.push({ t: now(), rect: r, zoom });
    return r;
  };
  const moveTo = async (sel: string, text?: string, fx = 0.5, fy = 0.5) => {
    await js(CURSOR_JS);
    const r = await rectOf(sel, text);
    if (!r) return null;
    const x = r.x + r.w * fx, y = r.y + r.h * fy;
    const d = (await js<number>(`window.__dc.move(${x},${y})`)) ?? 600;
    await sleep(d + 120);
    return { x, y, r };
  };
  const click = async (sel: string, text?: string) => {
    const p = await moveTo(sel, text);
    if (!p) return false;
    await js("window.__dc.ripple()");
    await sleep(120);
    await js(`(() => { const els=[...document.querySelectorAll(${JSON.stringify(sel)})]; const e=${text ? `els.find(x=>x.textContent.trim().startsWith(${JSON.stringify(text)}))` : "els[0]"}; e && e.click(); })()`);
    await sleep(450);
    return true;
  };
  const key = async (k: string, label: string, extra = "") => {
    await js(`window.__dc && window.__dc.key(${JSON.stringify(label)})`);
    await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(k)}${extra ? "," + extra : ""}}))`);
    await sleep(650);
  };
  const highlight = async (sel: string, ms = 1400, zoom = 1.45) => {
    const r = await spot(sel, zoom);
    if (r) await js(`window.__dc.hl(${JSON.stringify(r)})`);
    await sleep(ms);
    await js("window.__dc.hl(null)");
  };
  const drag = async (sel: string, dx: number, dy: number, steps = 24) => {
    const p = await moveTo(sel);
    if (!p) return;
    await js(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:${p.x},clientY:${p.y},button:0}))`);
    for (let i = 1; i <= steps; i++) {
      const x = p.x + (dx * i) / steps, y = p.y + (dy * i) / steps;
      await js(`(window.__dc.move(${x},${y}), document.getElementById('__dc').style.setProperty('--d','40ms'), window.dispatchEvent(new PointerEvent('pointermove',{clientX:${x},clientY:${y}})))`);
      await sleep(40);
    }
    await sleep(500);
    await js(`window.dispatchEvent(new PointerEvent('pointerup',{clientX:${p.x + dx},clientY:${p.y + dy}}))`);
    await sleep(400);
  };
  const chapter = async (id: string, body: () => Promise<void>) => {
    const start = now();
    marks.push({ id, start, end: start, spots: [] });
    try {
      await body();
    } catch (e) {
      console.error("[demo] chapter", id, e);
    }
    // hold until the narration for this chapter has finished
    const need = (durations[id] ?? 8) + 0.8;
    const left = need - (now() - start);
    if (left > 0) await sleep(left * 1000);
    cur().end = now();
    await writeFile(join(dir, "chapters.json"), JSON.stringify({ chapters: marks }, null, 2));
  };

  // ------------------------------------------------------------------ recording
  win.setMenuBarVisibility(false);
  win.setBounds({ x: 0, y: 0, width: 1920, height: 1080 });
  await sleep(1500);
  const rec: ChildProcess = spawn(getToolPaths().ffmpeg, ["-y", "-f", "x11grab", "-draw_mouse", "0", "-framerate", "30", "-video_size", "1920x1080", "-i", process.env.DISPLAY ?? ":99", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "16", "-pix_fmt", "yuv420p", join(dir, "screen.mp4")], { stdio: ["pipe", "ignore", "pipe"] });
  await new Promise<void>((res) => {
    const on = (b: Buffer) => /frame=\s*\d+/.test(b.toString()) && (rec.stderr!.off("data", on), res());
    rec.stderr!.on("data", on);
    setTimeout(res, 8000);
  });
  t0 = Date.now() - 1000 / 30;
  try {
    await js(CURSOR_JS);
    await chapter("home", async () => {
      await sleep(800);
      await moveTo(".new-card input");
      await highlight(".aspect-grid", 1600, 1.5);
      await click(".aspect", "9:16");
      await sleep(500);
      await click(".aspect", "16:9");
      await moveTo(".new-actions button", "Try the demo project");
      await spot(".new-actions", 1.6);
      await click(".new-actions button", "Try the demo project");
      for (let i = 0; i < 120 && !(await js("!!document.querySelector('.editor')")); i++) await sleep(250);
      await sleep(1500);
      await js(CURSOR_JS);
    });
    await chapter("tour", async () => {
      await highlight(".left", 1700, 1.4);
      await highlight(".viewer", 1700, 1.25);
      await highlight(".inspector", 1700, 1.4);
      await highlight(".timeline", 1900, 1.3);
    });
    await chapter("timeline", async () => {
      await moveTo(".icon-btn.play");
      await key(" ", "Space");
      await js(`${S}.setUi({ playing: true })`);
      await sleep(2600);
      await js(`${S}.setUi({ playing: false })`);
      await key("b", "B · Blade");
      await spot(".timeline", 1.5);
      const clip = await moveTo(".track-video .clip[data-clip]", undefined, 0.45, 0.4);
      if (clip) {
        await js("window.__dc.ripple()");
        await js(`(() => { const c=document.querySelector('.track-video .clip[data-clip]'); const r=c.getBoundingClientRect(); c.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:r.left+r.width*0.45,clientY:r.top+10,button:0})); })()`);
        await sleep(900);
      }
      await key("z", "Ctrl + Z · Undo", "ctrlKey:true");
      await key("v", "V · Select");
      await click(".track-text .clip[data-clip], .clip[data-clip]");
      await key("c", "Ctrl + C", "ctrlKey:true");
      await js(`${S}.setUi({ playhead: 330 })`);
      await key("v", "Ctrl + V", "ctrlKey:true");
      await sleep(600);
      await key("z", "Ctrl + Z", "ctrlKey:true");
      await js(`${S}.setUi({ selection: [], playhead: 60 })`);
      await key("f", "F · Freeze frame");
      await sleep(1200);
      await key("z", "Ctrl + Z", "ctrlKey:true");
    });
    await chapter("canvas", async () => {
      await js(`${S}.setUi({ playhead: 90, selection: [${S}.project.tracks.find(t=>t.id==='trk_v2').clips[0].id] })`);
      await sleep(600);
      await spot(".viewer", 1.3);
      await drag(".sel-box", -220, 90);
      await sleep(500);
      await drag(".sel-box", 160, -60);
      await sleep(400);
      await moveTo(".sel-box .handle-dot");
      await sleep(900);
      await key("z", "Ctrl + Z", "ctrlKey:true");
    });
    await chapter("filters", async () => {
      await js(`${S}.setUi({ playhead: 165, selection: [${S}.project.tracks.find(t=>t.id==='trk_v1').clips[1]?.id ?? ${S}.project.tracks.find(t=>t.id==='trk_v1').clips[0].id] })`);
      await click(".rail-btn[aria-label='Filters']");
      await spot(".filter-grid", 1.5);
      await click(".filter-grid button", "Noir");
      await sleep(900);
      await click(".filter-grid button", "Vivid");
      await sleep(700);
      await click(".insp-tabs button", "Adjust");
      await highlight(".insp-body", 2200, 1.45);
    });
    await chapter("effects", async () => {
      await click(".insp-tabs button", "Video");
      await js(`document.querySelector('.insp-body h4:nth-of-type(4)')?.scrollIntoView({block:'center'})`);
      await sleep(400);
      await spot(".inspector", 1.4);
      await moveTo(".insp-body h4", "Mask");
      await sleep(1400);
      await moveTo(".insp-body h4", "Chroma key");
      await sleep(1400);
      await moveTo(".insp-body h4", "Canvas background");
      await sleep(1200);
    });
    await chapter("motion", async () => {
      await click(".insp-tabs button", "Animation");
      await spot(".inspector", 1.4);
      await click(".insp-body .chip-grid button", "Zoom");
      await sleep(900);
      await click(".rail-btn[aria-label='Transitions']");
      await highlight(".trans-grid", 1800, 1.5);
      await js(`${S}.setUi({ playhead: 140 })`);
      await js(`${S}.setUi({ playing: true })`);
      await sleep(2200);
      await js(`${S}.setUi({ playing: false })`);
    });
    await chapter("text", async () => {
      await js(`${S}.setUi({ selection: [], playhead: 30 })`);
      await click(".rail-btn[aria-label='Text']");
      await spot(".left", 1.4);
      await click(".text-preset", "NEON");
      await sleep(900);
      await click(".insp-tabs button", "Text");
      await highlight(".insp-body", 1800, 1.45);
      await click(".rail-btn[aria-label='Shapes']");
      await click(".shape-grid button");
      await sleep(800);
    });
    await chapter("ai", async () => {
      await click(".rail-btn[aria-label='Audio']");
      await spot(".left", 1.45);
      await moveTo(".tool-card textarea");
      await js(`(() => { const t=document.querySelector('.tool-card textarea'); const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; set.call(t,''); t.dispatchEvent(new Event('input',{bubbles:true})); })()`);
      const line = "Welcome to MOTIF Studio. Everything you see runs on this computer.";
      for (let i = 1; i <= line.length; i += 2) {
        await js(`(() => { const t=document.querySelector('.tool-card textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t, ${JSON.stringify(line)}.slice(0, ${i})); t.dispatchEvent(new Event('input',{bubbles:true})); })()`);
        await sleep(35);
      }
      await click(".tool-card button.primary");
      for (let i = 0; i < 80 && !(await js(`${S}.project.assets.some(a=>a.name.startsWith('Voice'))`)); i++) await sleep(250);
      await sleep(800);
      await click(".rail-btn[aria-label='Captions']");
      await spot(".tool-card.accent", 1.5);
      await js(`(() => { const s=${S}; const a=s.project.assets.find(x=>x.name.startsWith('Voice')); const t=s.project.tracks.flatMap(t=>t.clips).find(c=>c.assetId===a?.id); if(t) s.setUi({ selection:[t.id] }); })()`);
      await sleep(600);
      await js(`(() => { const sel=document.querySelector('.tool-card.accent select'); if(!sel) return; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(sel,'tiny'); sel.dispatchEvent(new Event('change',{bubbles:true})); })()`);
      await click(".tool-card.accent button.primary");
      for (let i = 0; i < 240 && !(await js(`!!${S}.project.tracks.find(t=>t.name==='Captions')?.clips.length`)); i++) await sleep(250);
      await sleep(600);
      await highlight(".timeline", 1600, 1.3);
    });
    await chapter("audio", async () => {
      await js(`(() => { const s=${S}; const c=s.project.tracks.find(t=>t.kind==='audio')?.clips[0]; if(c) s.setUi({ selection:[c.id] }); })()`);
      await sleep(500);
      await spot(".inspector", 1.4);
      await moveTo(".insp-body h4", "Voice changer");
      await sleep(1200);
      await click(".rail-btn[aria-label='AI tools']");
      await highlight(".left", 2200, 1.4);
    });
    await chapter("palette", async () => {
      await key("k", "Ctrl + K", "ctrlKey:true");
      await sleep(500);
      const text = "export";
      for (let i = 1; i <= text.length; i++) {
        await js(`(() => { const i=document.querySelector('.palette input'); if(!i) return; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i, ${JSON.stringify(text)}.slice(0, ${i})); i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
        await sleep(140);
      }
      await spot(".palette", 1.35);
      await sleep(1600);
      await key("Escape", "Esc");
      await js(`${S}.setUi({ showPalette: false })`);
    });
    await chapter("export", async () => {
      await key("e", "Ctrl + E", "ctrlKey:true");
      await sleep(600);
      await spot(".modal.export", 1.25);
      await click(".chip-grid.res button", "4K");
      await sleep(800);
      await moveTo(".exp-summary");
      await sleep(1500);
      await click(".chip-grid.res button", "1080p");
      await sleep(600);
      await click(".modal-actions button", "Close");
    });
    await chapter("cloud", async () => {
      await click(".cloud-btn");
      await sleep(700);
      await spot(".cloud-dialog", 1.3);
      const email = process.env.MOTIF_DEMO_EMAIL;
      if (email) {
        const fill = (sel: string, v: string) => js(`(() => { const i=document.querySelector(${JSON.stringify(sel)}); if(!i) return; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i, ${JSON.stringify(v)}); i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
        await moveTo(".cloud-form input[type=email]");
        await fill(".cloud-form input[type=email]", email);
        await sleep(400);
        await moveTo(".cloud-form input[type=password]");
        await fill(".cloud-form input[type=password]", process.env.MOTIF_DEMO_PASSWORD ?? "");
        await sleep(300);
        await click(".cloud-form button");
        for (let i = 0; i < 40 && !(await js("!!document.querySelector('.cloud-dialog select')")); i++) await sleep(250);
        await js(`(() => { const i=document.querySelector('.cloud-dialog input[placeholder]'); if(!i) return; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'First cut'); i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
        await click(".cloud-dialog .modal-actions button.primary");
        for (let i = 0; i < 120 && (await js("!!document.querySelector('.cloud-dialog')")); i++) await sleep(250);
        await sleep(700);
        await click(".cloud-btn");
        await sleep(800);
        await spot(".cloud-dialog", 1.3);
        await sleep(1200);
        await click(".cloud-dialog .modal-actions button", "Close");
      } else {
        await sleep(2500);
        await click(".cloud-dialog .modal-actions button", "Close");
      }
    });
  } finally {
    rec.stdin!.write("q");
    await new Promise((r) => rec.on("close", r));
    await writeFile(join(dir, "chapters.json"), JSON.stringify({ chapters: marks, total: now() }, null, 2));
    app.quit();
  }
}
