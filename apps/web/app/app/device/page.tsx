"use client";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "../../../lib/api";

function Device() {
  const initial = (useSearchParams().get("code") ?? "").toUpperCase();
  const [code, setCode] = useState(initial);
  const [state, setState] = useState<{ ok: boolean; t: string } | null>(null);
  return (
    <>
      <h1>Connect the desktop app</h1>
      <div className="glass card" style={{ display: "grid", gap: 14, maxWidth: 520 }}>
        <p className="dim">In MOTIF desktop open Cloud and choose Sign in. Check that this code matches the one on your screen, then approve.</p>
        <input className="code" value={code} maxLength={9} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="XXXX-XXXX" aria-label="Device code" />
        <button className="primary" onClick={async () => { try { await api("/v1/auth/device/approve", { body: { userCode: code } }); setState({ ok: true, t: "Approved. You can return to the desktop app." }); } catch (e: any) { setState({ ok: false, t: e.message }); } }}>Approve this device</button>
        {state && <p className={state.ok ? "ok" : "err"}>{state.t}</p>}
      </div>
    </>
  );
}
export default function Page() {
  return <Suspense><Device /></Suspense>;
}
