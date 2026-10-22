"use client";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api, fmtDate } from "../../../lib/api";
import { useApp } from "../../../components/AppShell";

function History() {
  const id = useSearchParams().get("id") ?? "";
  const { ws } = useApp();
  const [p, setP] = useState<any>(null);
  const [versions, setVersions] = useState<any[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => {
    api(`/v1/projects/${id}`).then(setP).catch((e) => setMsg(e.message));
    api(`/v1/projects/${id}/versions`).then(setVersions).catch(() => {});
  };
  useEffect(load, [id]);
  if (!p) return msg ? <p className="err">{msg}</p> : <span className="spinner" />;
  const clips = (p.manifest?.tracks ?? []).reduce((n: number, t: any) => n + (t.clips?.length ?? 0), 0);
  return (
    <>
      <h1>{p.title}</h1>
      <p className="dim">Head v{p.version} · {clips} clips{p.manifest?.profile ? ` · ${p.manifest.profile.width}×${p.manifest.profile.height}` : ""} · SHA-256 {p.sha256.slice(0, 12)}…</p>
      {msg && <p className="ok">{msg}</p>}
      <div className="glass">
        <table>
          <thead><tr><th>Version</th><th>Message</th><th>Saved</th><th /></tr></thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.version}>
                <td>v{v.version}{v.version === p.version ? " · head" : ""}</td>
                <td>{v.message || <span className="dim">—</span>}</td>
                <td className="dim">{fmtDate(v.createdAt)}</td>
                <td>
                  {v.version !== p.version && ws.role !== "viewer" && (
                    <button onClick={async () => { const r = await api(`/v1/projects/${id}/restore`, { body: { version: v.version } }); setMsg(`Restored v${v.version} as v${r.version}`); load(); }}>Restore</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
export default function Page() {
  return <Suspense><History /></Suspense>;
}
