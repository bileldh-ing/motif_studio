"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, fmtDate } from "../../lib/api";
import { useApp } from "../../components/AppShell";

export default function Projects() {
  const { ws } = useApp();
  const [rows, setRows] = useState<{ id: string; title: string; headVersion: number; updatedAt: string }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setRows(null);
    api(`/v1/workspaces/${ws.id}/projects`).then(setRows).catch((e) => setErr(e.message));
  }, [ws.id]);
  return (
    <>
      <h1>Cloud projects</h1>
      <p className="dim">Projects you upload from the MOTIF desktop app appear here with their full version history.</p>
      <div className="glass">
        {err && <p className="err" style={{ padding: 16 }}>{err}</p>}
        {!rows && !err && <p style={{ padding: 16 }}><span className="spinner" /></p>}
        {rows && rows.length === 0 && <p className="dim" style={{ padding: 20 }}>No cloud projects yet. In the desktop app, open a project and choose Cloud, then Upload.</p>}
        {rows && rows.length > 0 && (
          <table>
            <thead><tr><th>Title</th><th>Version</th><th>Updated</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.title}</td>
                  <td>v{r.headVersion}</td>
                  <td className="dim">{fmtDate(r.updatedAt)}</td>
                  <td><Link href={`/app/project/?id=${r.id}`}>History →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
