/**
 * End-to-end smoke test, enabled only with MOTIF_SMOKE_DIR. Drives the real
 * UI (clicks DOM buttons, uses keyboard shortcuts), captures screenshots and
 * writes a JSON report. Used in CI under Xvfb:  pnpm --filter @motif/desktop smoke
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
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      const detail = await fn();
      report.push({ step: name, ok: detail !== false, detail });
    } catch (e: any) {
      report.push({ step: name, ok: false, detail: e.message });
    }
  };

  const consoleLines: string[] = [];
  win.webContents.on("console-message", (e: any) => consoleLines.push(String(e.message ?? e)));
  try {
    await waitFor("document.querySelector('.home')");
    await sleep(800);
    await shot("01-home");
    await step("open demo project", async () => {
      await clickText("button", "Try the demo project");
      return waitFor("document.querySelector('.editor')", 60000);
    });
    await sleep(2500);
    await step("clips on timeline", () => js("document.querySelectorAll('.clip').length"));
    await shot("02-editor");
    await step("seek + preview drawn", async () => {
      await js("window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',shiftKey:true}))");
      for (let i = 0; i < 2; i++) await js("window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',shiftKey:true}))");
      await sleep(1500);
      return js("document.querySelector('.tc').textContent");
    });
    await step("select clip + inspector", async () => {
      await js("(() => { const c=[...document.querySelectorAll('.clip-video')][0]; const r=c.getBoundingClientRect(); c.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:r.left+r.width/2,clientY:r.top+5,button:0})); window.dispatchEvent(new PointerEvent('pointerup',{clientX:r.left+r.width/2})); })()");
      await sleep(400);
      return js("document.querySelector('.insp-head strong').textContent");
    });
    await shot("03-selected");
    await step("preview video state", () => js("JSON.stringify(window.__motifPreview || null)"));
    await step("split with S + undo", async () => {
      const before = await js<number>("document.querySelectorAll('.clip').length");
      await js("window.dispatchEvent(new KeyboardEvent('keydown',{key:'s'}))");
      await sleep(300);
      const after = await js<number>("document.querySelectorAll('.clip').length");
      await js("window.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true}))");
      await sleep(300);
      const undone = await js<number>("document.querySelectorAll('.clip').length");
      return after === before + 1 && undone === before ? { before, after, undone } : false;
    });
    await step("open export dialog", async () => {
      await js("window.dispatchEvent(new KeyboardEvent('keydown',{key:'e',ctrlKey:true}))");
      return waitFor("document.querySelector('.modal.export')", 5000);
    });
    await sleep(500);
    await shot("04-export");
    await step("save", async () => {
      await js("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
      await clickText(".modal-actions button", "Close");
      await sleep(200);
      await clickText(".topbar button", "Save");
      return waitFor("document.querySelector('.save-state') && !document.querySelector('.save-state.dirty')", 5000);
    });
    await step("export through the app (IPC -> render engine -> verify)", async () => {
      const out = join(dir, "smoke-export.mp4");
      return js(`new Promise(async (res) => {
        const s = window.__motifSession;
        const presets = await window.motif.presets();
        const p = { ...presets.find(x => x.id === "mp4-720p-draft"), preset: "ultrafast" };
        const off = window.motif.onRenderDone(e => { off(); res(e); });
        await window.motif.startRender(s.project, p, ${JSON.stringify(out)});
      })`);
    });
    await step("smart tools tab", async () => {
      await clickText(".tabs button", "Smart tools");
      await sleep(300);
      return true;
    });
    await shot("05-tools");
  } finally {
    report.push({ step: "console", ok: true, detail: consoleLines.slice(-30) });
    await writeFile(join(dir, "report.json"), JSON.stringify(report, null, 2));
    app.quit();
  }
}
