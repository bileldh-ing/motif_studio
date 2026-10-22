/** Production entrypoint. Configure with environment variables (see docs/OPERATIONS.md). */
import { buildApp } from "./app.ts";
import { connect, migrate } from "./db/index.ts";
import { LocalStorage, S3Storage, type Storage } from "./storage.ts";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`Missing env ${k}`);
  return v;
};

const port = Number(env("PORT", "8787"));
const publicUrl = env("PUBLIC_URL", `http://localhost:${port}`);
const { db, pool } = connect(env("DATABASE_URL"));
await migrate(pool);

let storage: Storage;
if (process.env.S3_BUCKET) {
  storage = new S3Storage({ bucket: env("S3_BUCKET"), region: env("S3_REGION", "auto"), endpoint: process.env.S3_ENDPOINT, accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY });
} else {
  storage = new LocalStorage(env("STORAGE_DIR", "./data/objects"), publicUrl, env("STORAGE_SIGNING_SECRET"));
}

const app = await buildApp({
  db,
  storage,
  publicUrl,
  webUrl: env("WEB_URL", "http://localhost:3000"),
  logger: true,
  corsOrigins: env("CORS_ORIGINS", env("WEB_URL", "http://localhost:3000")).split(","),
  stripe: { secretKey: process.env.STRIPE_SECRET_KEY, webhookSecret: process.env.STRIPE_WEBHOOK_SECRET, prices: { pro: process.env.STRIPE_PRICE_PRO, team: process.env.STRIPE_PRICE_TEAM } },
});
await app.listen({ port, host: "0.0.0.0" });
const stop = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
