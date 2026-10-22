#!/usr/bin/env node
/**
 * Downloads static FFmpeg/FFprobe release builds (newest nX.Y GPL release from BtbN) for packaging into
 * apps/desktop/resources/ffmpeg/<platform>-<arch>/. MOTIF invokes them as
 * separate programs (no linking); see THIRD_PARTY_NOTICES.md for licensing.
 *
 *   node scripts/fetch-ffmpeg.mjs [platform] [arch]   (defaults: current host)
 */
import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, chmodSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const platform = process.argv[2] ?? process.platform;
const arch = process.argv[3] ?? process.arch;
const dest = join(root, "apps/desktop/resources/ffmpeg", `${platform}-${arch}`);
const BTBN_API = "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest";
async function btbn(plat, ext) {
  const r = await fetch(BTBN_API, { headers: { accept: "application/vnd.github+json", ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) } });
  if (!r.ok) throw new Error(`BtbN release lookup failed: ${r.status}`);
  const assets = (await r.json()).assets.map((a) => a.browser_download_url);
  const re = new RegExp(`/ffmpeg-n(\\d+)\\.(\\d+)-latest-${plat}-gpl-\\d+\\.\\d+\\.${ext.replace(".", "\\.")}$`);
  // newest release line up to the major version MOTIF is tested against (FFMPEG_MAX_MAJOR, default 8)
  const max = Number(process.env.FFMPEG_MAX_MAJOR ?? 8);
  const pick = assets.filter((u) => re.test(u) && Number(u.match(re)[1]) <= max).sort((a, b) => { const [, a1, a2] = a.match(re); const [, b1, b2] = b.match(re); return b1 - a1 || b2 - a2; })[0];
  if (!pick) throw new Error(`no BtbN build for ${plat}`);
  return [pick];
}
async function evermeet() {
  const pinned = process.env.FFMPEG_MAC_VERSION ?? "8.1.1";
  const ok = async (u) => (await fetch(u, { method: "HEAD", redirect: "follow" }).catch(() => null))?.ok;
  const v = (await ok(`https://evermeet.cx/ffmpeg/ffmpeg-${pinned}.zip`)) ? pinned : (await (await fetch("https://evermeet.cx/ffmpeg/info/ffmpeg/release")).json()).version;
  return [`https://evermeet.cx/ffmpeg/ffmpeg-${v}.zip`, `https://evermeet.cx/ffmpeg/ffprobe-${v}.zip`];
}
const SOURCES = {
  "linux-x64": () => btbn("linux64", "tar.xz"),
  "linux-arm64": () => btbn("linuxarm64", "tar.xz"),
  "win32-x64": () => btbn("win64", "zip"),
  "win32-arm64": () => btbn("winarm64", "zip"),
  // evermeet.cx publishes static macOS builds (x86_64; runs on Apple silicon via Rosetta 2)
  "darwin-x64": () => evermeet(),
  "darwin-arm64": () => evermeet(),
};

const src = SOURCES[`${platform}-${arch}`];
mkdirSync(dest, { recursive: true });
if (!src) {
  console.warn(`No bundled FFmpeg for ${platform}-${arch}; the app will use FFmpeg from PATH.`);
  process.exit(0);
}
const exe = platform === "win32" ? ".exe" : "";
if (existsSync(join(dest, `ffmpeg${exe}`)) && existsSync(join(dest, `ffprobe${exe}`))) {
  console.log(`FFmpeg already present in ${dest}`);
  process.exit(0);
}
try {
const urls = await src();
const tmp = join(root, ".ffmpeg-tmp");
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

function find(dir, name) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) {
      const r = find(p, name);
      if (r) return r;
    } else if (f === name) return p;
  }
  return null;
}

for (const [i, url] of urls.entries()) {
  const archive = join(tmp, `a${i}${url.endsWith(".tar.xz") ? ".tar.xz" : ".zip"}`);
  console.log(`↓ ${url}`);
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok || !r.body) throw new Error(`download failed ${r.status} ${url}`);
  await pipeline(Readable.fromWeb(r.body), createWriteStream(archive));
  const out = join(tmp, `x${i}`);
  mkdirSync(out);
  if (archive.endsWith(".tar.xz")) execFileSync("tar", ["-xJf", archive, "-C", out]);
  else if (platform === "win32" && process.platform === "win32") execFileSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -Path '${archive}' -DestinationPath '${out}'`]);
  else execFileSync("unzip", ["-q", archive, "-d", out]);
}
for (const bin of ["ffmpeg", "ffprobe"]) {
  const f = find(tmp, bin + exe);
  if (!f) throw new Error(`${bin}${exe} not found in downloaded archive`);
  copyFileSync(f, join(dest, bin + exe));
  if (!exe) chmodSync(join(dest, bin), 0o755);
}
const lic = find(tmp, "LICENSE.txt");
if (lic) renameSync(lic, join(dest, "FFMPEG_LICENSE.txt"));
rmSync(tmp, { recursive: true, force: true });
console.log(`✓ FFmpeg bundled into ${dest}`);
} catch (e) {
  console.error(`::warning::FFmpeg could not be bundled (${e.message}); the build will use FFmpeg from PATH at runtime.`);
  rmSync(join(root, ".ffmpeg-tmp"), { recursive: true, force: true });
  process.exit(process.env.FFMPEG_STRICT ? 1 : 0);
}
