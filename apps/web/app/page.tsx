import Link from "next/link";
import { Logo } from "../components/Logo";

const FEATURES = [
  ["✂️", "Pro timeline", "Multitrack editing with blade, ripple, snapping, copy/paste, freeze frame, reverse and speed from 0.25× to 4×."],
  ["✨", "Effects that export exactly", "Filters, masks, chroma key, blur fill, 7 transitions and in/out animations. Preview and export share one composition model."],
  ["💬", "Local AI captions", "Whisper runs on your CPU. Word-timed captions in seconds, editable and exportable as SRT. Your media never leaves your machine."],
  ["🎙️", "Voice & audio", "Offline text-to-speech, noise reduction, voice changer, extract audio and silence removal."],
  ["🎬", "True 4K export", "480p to 2160p or any size, 24–60 fps, H.264, HEVC, AV1, VP9 and ProRes, plus GIF, audio-only and PNG stills."],
  ["☁️", "Cloud projects", "Version history, restore, conflict detection and signed media transfer. Share a workspace with your team."],
];

const PLANS: [string, string, string[], boolean][] = [
  ["Free", "$0", ["Unlimited local editing & 4K export", "3 cloud projects", "2 GB cloud storage", "1 seat"], false],
  ["Pro", "$12/mo", ["100 cloud projects", "100 GB cloud storage", "Full version history", "Priority support"], true],
  ["Team", "$29/mo", ["10 seats with roles", "1 TB cloud storage", "Audit log", "Shared workspaces"], false],
];

export default function Home() {
  return (
    <>
      <header className="top glass">
        <Logo />
        <nav>
          <a href="#features">Features</a>
          <a href="#pricing">Pricing</a>
          <Link href="/download/">Download</Link>
          <Link href="/login/">Sign in</Link>
          <Link href="/signup/" className="btn primary">Get started</Link>
        </nav>
      </header>
      <section className="hero">
        <h1>
          Edit like a studio.
          <br />
          <span className="grad">Stay on your machine.</span>
        </h1>
        <p>MOTIF is a local-first desktop video editor with CapCut-class tools, on-device AI captions and verified 4K export. The cloud is there when you want it.</p>
        <div className="cta">
          <Link href="/download/" className="btn primary">Download for free</Link>
          <a href="https://github.com/bileldh-ing/motif_studio" className="btn">View on GitHub</a>
        </div>
      </section>
      <div className="shot glass">
        <img src="/editor.png" alt="The MOTIF editor with timeline, preview and inspector" />
      </div>
      <section className="section" id="features">
        <h2>Everything you need to ship a video</h2>
        <p className="dim">Every tool listed here is implemented and covered by automated pixel-level export tests.</p>
        <div className="grid3">
          {FEATURES.map(([i, t, d]) => (
            <div key={t} className="glass feature">
              <div className="ico">{i}</div>
              <h3>{t}</h3>
              <p>{d}</p>
            </div>
          ))}
        </div>
      </section>
      <section className="section" id="pricing">
        <h2>Simple pricing</h2>
        <p className="dim">Editing, local AI and exports are free and unlimited forever. Plans only meter cloud storage, cloud projects and seats.</p>
        <div className="grid3">
          {PLANS.map(([name, amt, items, hot]) => (
            <div key={name} className={"glass price" + (hot ? " hot" : "")}>
              <b>{name}</b>
              <div className="amt">{amt}</div>
              <ul>{items.map((x) => <li key={x}>{x}</li>)}</ul>
              <Link href="/signup/" className={"btn" + (hot ? " primary" : "")}>Choose {name}</Link>
            </div>
          ))}
        </div>
      </section>
      <div className="foot">MOTIF Studio · Original software, not affiliated with CapCut or ByteDance.</div>
    </>
  );
}
