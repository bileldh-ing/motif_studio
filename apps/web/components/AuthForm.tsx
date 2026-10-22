"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { api, token } from "../lib/api";
import { Logo } from "./Logo";

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ token: string }>(`/v1/auth/${mode}`, { body: { email, password, ...(mode === "signup" ? { name } : {}) } });
      token.set(r.token);
      const next = new URLSearchParams(window.location.search).get("next");
      router.replace(next && next.startsWith("/") ? next : "/app/");
    } catch (x: any) {
      setErr(x.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="center">
      <form className="glass auth" onSubmit={submit}>
        <Logo />
        <h2 style={{ margin: "8px 0 0" }}>{mode === "login" ? "Welcome back" : "Create your account"}</h2>
        {mode === "signup" && (
          <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></label>
        )}
        <label className="field"><span>Email</span><input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></label>
        <label className="field">
          <span>Password {mode === "signup" && "(10+ characters)"}</span>
          <input type="password" required minLength={mode === "signup" ? 10 : 1} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} />
        </label>
        {err && <div className="err small" role="alert">{err}</div>}
        <button className="primary" disabled={busy}>{busy ? "…" : mode === "login" ? "Sign in" : "Create account"}</button>
        <div className="small dim">
          {mode === "login" ? <>New here? <Link href="/signup/">Create an account</Link></> : <>Have an account? <Link href="/login/">Sign in</Link></>}
        </div>
      </form>
    </div>
  );
}
