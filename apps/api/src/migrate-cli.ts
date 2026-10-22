import { connect, migrate } from "./db/index.ts";
const { pool } = connect(process.env.DATABASE_URL!);
console.log("applied:", await migrate(pool));
await pool.end();
