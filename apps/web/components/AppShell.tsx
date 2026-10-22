"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, token, type Me } from "../lib/api";
import { Logo } from "./Logo";

interface Ctx {
  me: Me;
  ws: Me["workspaces"][number];
  reload: () => void;
}
const C = createContext<Ctx | null>(null);
export const useApp = () => useContext(C)!;

export function AppShell({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [wsId, setWsId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const router = useRouter();
  const path = usePathname();
  useEffect(() => {
    if (!token.get()) {
      router.replace(`/login/?next=${encodeURIComponent(path + window.location.search)}`);
      return;
    }
    api<Me>("/v1/me")
      .then((m) => {
        setMe(m);
        setWsId((cur) => cur ?? localStorage.getItem("motif.ws") ?? m.workspaces[0]?.id ?? null);
      })
      .catch((e) => (e.status === 401 ? router.replace("/login/") : setErr(e.message)));
  }, [n, router, path]);
  if (err) return <div className="center"><div className="glass card">⚠ {err}</div></div>;
  if (!me) return <div className="center"><div className="spinner" /></div>;
  const ws = me.workspaces.find((w) => w.id === wsId) ?? me.workspaces[0]!;
  const nav: [string, string][] = [
    ["/app/", "Projects"],
    ["/app/billing/", "Plan & usage"],
    ["/app/team/", "Team"],
    ["/app/device/", "Connect desktop"],
    ...(me.user.isAdmin ? ([["/admin/", "Admin"]] as [string, string][]) : []),
  ];
  return (
    <C.Provider value={{ me, ws, reload: () => setN((x) => x + 1) }}>
      <div className="shell">
        <aside className="glass side">
          <Logo />
          <label className="field">
            <span>Workspace</span>
            <select value={ws.id} onChange={(e) => (localStorage.setItem("motif.ws", e.target.value), setWsId(e.target.value))}>
              {me.workspaces.map((w) => (
                <option key={w.id} value={w.id}>{w.name} · {w.plan}</option>
              ))}
            </select>
          </label>
          <nav>
            {nav.map(([href, label]) => (
              <Link key={href} href={href} className={path === href ? "on" : ""}>{label}</Link>
            ))}
          </nav>
          <div className="side-foot">
            <div className="dim small">{me.user.email}</div>
            <button
              onClick={async () => {
                await api("/v1/auth/logout", { body: {} }).catch(() => {});
                token.clear();
                router.replace("/");
              }}
            >Sign out</button>
          </div>
        </aside>
        <main className="main">{children}</main>
      </div>
    </C.Provider>
  );
}
