import { randomBytes, scrypt as _scrypt, timingSafeEqual, createHash, createHmac } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(_scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** scrypt password hash: scrypt$N$r$p$salt$hash (base64url). */
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const h = await scrypt(pw, salt, 32, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString("base64url")}$${h.toString("base64url")}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, N, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "base64url");
  const got = await scrypt(pw, Buffer.from(salt, "base64url"), want.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: PARAMS.maxmem });
  return got.length === want.length && timingSafeEqual(got, want);
}

export const newToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
export const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString("base64url").replace(/[-_]/g, "x")}`;

/** Human-friendly device code like "QXRT-7KMN" (no ambiguous characters). */
export function userCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const b = randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += alphabet[b[i]! % alphabet.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export function hmac(secret: string, msg: string): string {
  return createHmac("sha256", secret).update(msg).digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
