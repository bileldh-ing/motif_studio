import Link from "next/link";
import { Logo } from "../../components/Logo";

const REL = "https://github.com/bileldh-ing/motif_studio/releases/latest";
const OS: [string, string, string][] = [
  ["Windows", "Windows 10/11 · x64", "NSIS installer (.exe) and MSIX package for the Microsoft Store"],
  ["macOS", "macOS 12+ · Apple silicon & Intel", "DMG and ZIP (signed & notarized when certificates are configured)"],
  ["Linux", "x64 & arm64", "AppImage, .deb and Snap"],
];

export default function Download() {
  return (
    <>
      <header className="top glass">
        <Logo />
        <nav>
          <Link href="/login/">Sign in</Link>
        </nav>
      </header>
      <section className="section">
        <h2>Download MOTIF Studio</h2>
        <p className="dim">Installers are built by CI for every tagged release. Unsigned builds are labelled as unsigned on the release page.</p>
        <div className="grid3">
          {OS.map(([os, req, fmt]) => (
            <div key={os} className="glass feature">
              <h3>{os}</h3>
              <p>{req}</p>
              <p className="small">{fmt}</p>
              <p style={{ marginTop: 14 }}>
                <a className="btn primary" href={REL}>Get the latest release</a>
              </p>
            </div>
          ))}
        </div>
        <p className="dim small" style={{ marginTop: 24 }}>FFmpeg is bundled in release builds. Auto captions need Python 3 with faster-whisper; the app's diagnostics explain anything missing.</p>
      </section>
    </>
  );
}
