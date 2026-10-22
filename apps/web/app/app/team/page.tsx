"use client";
import { useEffect, useState } from "react";
import { api } from "../../../lib/api";
import { useApp } from "../../../components/AppShell";

export default function Team() {
  const { ws } = useApp();
  const [members, setMembers] = useState<any[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("editor");
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const load = () => api(`/v1/workspaces/${ws.id}/members`).then(setMembers).catch(() => {});
  useEffect(() => { load(); }, [ws.id]);
  return (
    <>
      <h1>Team</h1>
      <div className="glass">
        <table>
          <thead><tr><th>Member</th><th>Role</th></tr></thead>
          <tbody>{members.map((m) => <tr key={m.userId}><td>{m.name} <span className="dim small">{m.email}</span></td><td><span className="pill">{m.role}</span></td></tr>)}</tbody>
        </table>
      </div>
      {ws.role === "owner" && (
        <form className="glass card row" onSubmit={async (e) => { e.preventDefault(); try { await api(`/v1/workspaces/${ws.id}/members`, { body: { email, role } }); setMsg({ ok: true, t: `Added ${email}` }); setEmail(""); load(); } catch (x: any) { setMsg({ ok: false, t: x.message }); } }}>
          <label className="field" style={{ flex: 1 }}><span>Invite by email</span><input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label className="field"><span>Role</span><select value={role} onChange={(e) => setRole(e.target.value)}><option value="editor">Editor</option><option value="viewer">Viewer</option></select></label>
          <button className="primary" style={{ alignSelf: "flex-end" }}>Add</button>
          {msg && <div className={msg.ok ? "ok small" : "err small"} style={{ width: "100%" }}>{msg.t}</div>}
        </form>
      )}
    </>
  );
}
