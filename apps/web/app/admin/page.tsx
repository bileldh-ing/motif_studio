"use client";
import { useEffect, useState } from "react";
import { api, fmtDate } from "../../lib/api";

export default function Admin() {
  const [s, setS] = useState<any>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [audit, setAudit] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api("/v1/admin/stats").then(setS).catch((e) => setErr(e.message));
    api("/v1/admin/users").then(setUsers).catch(() => {});
    api("/v1/admin/audit").then(setAudit).catch(() => {});
  }, []);
  if (err) return <p className="err">{err}</p>;
  return (
    <>
      <h1>Admin</h1>
      {s && <div className="row">{([["Users", s.users], ["Workspaces", s.workspaces], ["Cloud projects", s.projects]] as [string, number][]).map(([k, v]) => <div key={k} className="glass card"><div className="dim small">{k}</div><div style={{ fontSize: 28, fontWeight: 700 }}>{v}</div></div>)}</div>}
      <div className="glass"><table><thead><tr><th>User</th><th>Joined</th><th>Admin</th></tr></thead><tbody>{users.map((u) => <tr key={u.id}><td>{u.email}</td><td className="dim">{fmtDate(u.createdAt)}</td><td>{u.isAdmin ? "yes" : ""}</td></tr>)}</tbody></table></div>
      <div className="glass"><table><thead><tr><th>When</th><th>Action</th><th>Target</th><th>IP</th></tr></thead><tbody>{audit.slice(0, 50).map((a) => <tr key={a.id}><td className="dim">{fmtDate(a.createdAt)}</td><td>{a.action}</td><td className="small">{a.target}</td><td className="dim small">{a.ip}</td></tr>)}</tbody></table></div>
    </>
  );
}
