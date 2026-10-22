/**
 * Object storage behind signed, expiring URLs.
 *  - LocalStorage: files on disk, URLs served by this API and authorised with an HMAC signature (dev, tests, self-hosting).
 *  - S3Storage: any S3-compatible store (AWS, R2, MinIO) via SigV4 presigned URLs.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, rename, rm, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable } from "node:stream";
import { hmac, safeEqual } from "./security.ts";

export interface SignedUrl {
  url: string;
  method: "PUT" | "GET";
  expiresAt: string;
  headers: Record<string, string>;
}
export interface StoredObject {
  size: number;
  sha256?: string;
}
export interface Storage {
  kind: "local" | "s3";
  signPut(key: string, opts: { contentType: string; size: number; ttlSec: number }): Promise<SignedUrl>;
  signGet(key: string, opts: { ttlSec: number; filename?: string }): Promise<SignedUrl>;
  head(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
}

export class LocalStorage implements Storage {
  kind = "local" as const;
  constructor(
    private root: string,
    private publicBaseUrl: string,
    private secret: string,
  ) {}
  private file(key: string) {
    const p = resolve(this.root, key);
    if (!p.startsWith(resolve(this.root) + sep)) throw new Error("bad key");
    return p;
  }
  private sign(method: string, key: string, exp: number, extra = "") {
    return hmac(this.secret, `${method}\n${key}\n${exp}\n${extra}`);
  }
  async signPut(key: string, o: { contentType: string; size: number; ttlSec: number }): Promise<SignedUrl> {
    const exp = Math.floor(Date.now() / 1000) + o.ttlSec;
    const u = new URL(`/v1/storage/${key}`, this.publicBaseUrl);
    u.searchParams.set("exp", String(exp));
    u.searchParams.set("size", String(o.size));
    u.searchParams.set("sig", this.sign("PUT", key, exp, String(o.size)));
    return { url: u.toString(), method: "PUT", expiresAt: new Date(exp * 1000).toISOString(), headers: { "content-type": "application/octet-stream" } };
  }
  async signGet(key: string, o: { ttlSec: number; filename?: string }): Promise<SignedUrl> {
    const exp = Math.floor(Date.now() / 1000) + o.ttlSec;
    const u = new URL(`/v1/storage/${key}`, this.publicBaseUrl);
    u.searchParams.set("exp", String(exp));
    u.searchParams.set("sig", this.sign("GET", key, exp));
    return { url: u.toString(), method: "GET", expiresAt: new Date(exp * 1000).toISOString(), headers: {} };
  }
  /** Validate a signed request; returns an error string or null. */
  verify(method: "PUT" | "GET", key: string, q: { exp?: string; sig?: string; size?: string }): string | null {
    const exp = Number(q.exp);
    if (!q.sig || !Number.isFinite(exp)) return "missing signature";
    if (exp < Date.now() / 1000) return "link expired";
    const want = this.sign(method, key, exp, method === "PUT" ? String(q.size ?? "") : "");
    return safeEqual(want, q.sig) ? null : "bad signature";
  }
  /** Stream an upload to disk, enforcing the signed size and computing sha256. */
  async write(key: string, body: Readable | Buffer, maxSize: number): Promise<StoredObject> {
    const dest = this.file(key);
    await mkdir(dirname(dest), { recursive: true });
    const tmp = `${dest}.part`;
    const h = createHash("sha256");
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _e, cb) {
        size += chunk.length;
        if (size > maxSize) return cb(new Error("upload larger than signed size"));
        h.update(chunk);
        cb(null, chunk);
      },
    });
    const src = Buffer.isBuffer(body) ? (await import("node:stream")).Readable.from([body]) : body;
    try {
      await pipeline(src, meter, createWriteStream(tmp));
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
    await rename(tmp, dest);
    const sha = h.digest("hex");
    await writeFile(`${dest}.sha256`, sha);
    return { size, sha256: sha };
  }
  read(key: string) {
    return createReadStream(this.file(key));
  }
  async head(key: string): Promise<StoredObject | null> {
    try {
      const s = await stat(this.file(key));
      const sha = await readFile(`${this.file(key)}.sha256`, "utf8").catch(() => undefined);
      return { size: s.size, ...(sha ? { sha256: sha } : {}) };
    } catch {
      return null;
    }
  }
  async delete(key: string) {
    await rm(this.file(key), { force: true });
    await rm(`${this.file(key)}.sha256`, { force: true });
  }
}

export class S3Storage implements Storage {
  kind = "s3" as const;
  private clientP: Promise<any>;
  constructor(private o: { bucket: string; region: string; endpoint?: string; accessKeyId?: string; secretAccessKey?: string }) {
    this.clientP = import("@aws-sdk/client-s3").then(
      ({ S3Client }) =>
        new S3Client({
          region: o.region,
          ...(o.endpoint ? { endpoint: o.endpoint, forcePathStyle: true } : {}),
          ...(o.accessKeyId && o.secretAccessKey ? { credentials: { accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey } } : {}),
        }),
    );
  }
  async signPut(key: string, x: { contentType: string; size: number; ttlSec: number }): Promise<SignedUrl> {
    const [{ PutObjectCommand }, { getSignedUrl }, c] = await Promise.all([import("@aws-sdk/client-s3"), import("@aws-sdk/s3-request-presigner"), this.clientP]);
    const url = await getSignedUrl(c, new PutObjectCommand({ Bucket: this.o.bucket, Key: key, ContentType: x.contentType, ContentLength: x.size }), { expiresIn: x.ttlSec });
    return { url, method: "PUT", expiresAt: new Date(Date.now() + x.ttlSec * 1000).toISOString(), headers: { "content-type": x.contentType } };
  }
  async signGet(key: string, x: { ttlSec: number; filename?: string }): Promise<SignedUrl> {
    const [{ GetObjectCommand }, { getSignedUrl }, c] = await Promise.all([import("@aws-sdk/client-s3"), import("@aws-sdk/s3-request-presigner"), this.clientP]);
    const url = await getSignedUrl(c, new GetObjectCommand({ Bucket: this.o.bucket, Key: key, ...(x.filename ? { ResponseContentDisposition: `attachment; filename="${x.filename.replace(/"/g, "")}"` } : {}) }), { expiresIn: x.ttlSec });
    return { url, method: "GET", expiresAt: new Date(Date.now() + x.ttlSec * 1000).toISOString(), headers: {} };
  }
  async head(key: string): Promise<StoredObject | null> {
    const [{ HeadObjectCommand }, c] = await Promise.all([import("@aws-sdk/client-s3"), this.clientP]);
    try {
      const r = await c.send(new HeadObjectCommand({ Bucket: this.o.bucket, Key: key }));
      return { size: Number(r.ContentLength ?? 0) };
    } catch {
      return null;
    }
  }
  async delete(key: string) {
    const [{ DeleteObjectCommand }, c] = await Promise.all([import("@aws-sdk/client-s3"), this.clientP]);
    await c.send(new DeleteObjectCommand({ Bucket: this.o.bucket, Key: key }));
  }
}

export const keyFor = (workspaceId: string, assetId: string) => `ws/${workspaceId}/${assetId}`;
