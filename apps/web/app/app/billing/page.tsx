"use client";
import { useEffect, useState } from "react";
import { api, fmtBytes } from "../../../lib/api";
import { useApp } from "../../../components/AppShell";

export default function Billing() {
  const { ws } = useApp();
  const [e, setE] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api(`/v1/workspaces/${ws.id}/entitlements`).then(setE).catch((x) => setErr(x.message)); }, [ws.id]);
  if (!e) return err ? <p className="err">{err}</p> : <span className="spinner" />;
  const meter = (label: string, used: number, limit: number, fmt: (n: number) => string) => (
    <div style={{ display: "grid", gap: 6 }}>
      <div className="row" style={{ justifyContent: "space-between" }}><span>{label}</span><span className="dim small">{fmt(used)} / {fmt(limit)}</span></div>
      <div className="bar"><div style={{ width: `${Math.min(100, (used / Math.max(1, limit)) * 100)}%` }} /></div>
    </div>
  );
  const hrs = (s: number) => `${(s / 3600).toFixed(1)} h`;
  const go = async (path: string, body: object) => {
    try { const r = await api<{ url: string }>(path, { body }); window.location.href = r.url; } catch (x: any) { setErr(x.message); }
  };
  return (
    <>
      <h1>Plan & usage</h1>
      <div className="glass card" style={{ display: "grid", gap: 18 }}>
        <div className="row"><b style={{ fontSize: 20 }}>{e.limits.name}</b><span className={`pill ${e.plan}`}>{e.plan}</span>{e.subscription && <span className="dim small">Subscription {e.subscription.status}</span>}</div>
        {meter("Cloud storage", e.usage.storageBytes, e.limits.storageBytes, fmtBytes)}
        {meter("Cloud-reported exports (30 days)", e.usage.exportSeconds30d, e.limits.exportSecondsPerMonth, hrs)}
        {meter("Cloud AI (30 days)", e.usage.aiSeconds30d, e.limits.aiSecondsPerMonth, hrs)}
        <p className="dim small">Local editing, local AI and local exports are always unlimited. These meters cover cloud resources only.</p>
        {ws.role === "owner" && (
          <div className="row">
            {e.plan === "free" && <button className="primary" disabled={!e.billingEnabled} onClick={() => go(`/v1/workspaces/${ws.id}/billing/checkout`, { plan: "pro" })}>Upgrade to Pro · $12/mo</button>}
            {e.plan !== "team" && <button disabled={!e.billingEnabled} onClick={() => go(`/v1/workspaces/${ws.id}/billing/checkout`, { plan: "team" })}>Team · $29/mo</button>}
            {e.plan !== "free" && <button disabled={!e.billingEnabled} onClick={() => go(`/v1/workspaces/${ws.id}/billing/portal`, {})}>Manage billing</button>}
          </div>
        )}
        {!e.billingEnabled && <p className="dim small">Billing is not configured on this server, so upgrades are disabled. Operators set STRIPE_SECRET_KEY and price IDs.</p>}
        {err && <p className="err small">{err}</p>}
      </div>
    </>
  );
}
