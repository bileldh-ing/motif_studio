"use client";
/** Tiny typed client for the MOTIF API. The token lives in localStorage (web sessions expire after 30 days). */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const token = {
  get: () => (typeof window === "undefined" ? null : localStorage.getItem("motif.token")),
  set: (t: string) => localStorage.setItem("motif.token", t),
  clear: () => localStorage.removeItem("motif.token"),
};

export async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const t = token.get();
  let r: Response;
  try {
    r = await fetch(`${API_URL}${path}`, {
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
      headers: { ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...(t ? { authorization: `Bearer ${t}` } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiError(0, "offline", `Can't reach the MOTIF API at ${API_URL}`);
  }
  const data = r.status === 204 ? null : await r.json().catch(() => null);
  if (!r.ok) {
    if (r.status === 401) token.clear();
    throw new ApiError(r.status, data?.error ?? "error", data?.message ?? `Request failed (${r.status})`);
  }
  return data as T;
}

export interface Me {
  user: { id: string; email: string; name: string; isAdmin: boolean };
  workspaces: { id: string; name: string; plan: "free" | "pro" | "team"; role: "owner" | "editor" | "viewer" }[];
}

export const fmtBytes = (n: number) => (n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`);
export const fmtDate = (s: string) => new Date(s).toLocaleString();
