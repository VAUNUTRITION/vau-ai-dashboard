import express from "express";
import cors from "cors";
import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway") || process.env.DATABASE_URL?.includes("sslmode") ? { rejectUnauthorized: false } : undefined,
});

// Write key — set this in Railway Variables. Without a valid key, POST requests fail.
const WRITE_KEY = process.env.WRITE_KEY || "CHANGE_ME_IN_RAILWAY";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "5mb" }));

// Init DB
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dashboard_state (
      id INT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log("DB ready");
}
init().catch(err => { console.error("DB init error:", err); });

app.get("/", (_req, res) => {
  res.send("VAU Dashboard API — OK. Endpoints: GET /api/data, POST /api/data");
});

app.get("/api/data", async (_req, res) => {
  try {
    const { rows } = await pool.query("SELECT data, updated_at FROM dashboard_state WHERE id = 1");
    if (rows.length === 0) return res.json({ data: null, updated_at: null });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "db_error", detail: String(err) });
  }
});

app.post("/api/data", async (req, res) => {
  const key = req.headers["x-write-key"] || req.body?.writeKey;
  if (key !== WRITE_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const data = req.body?.data;
  if (!data) return res.status(400).json({ error: "missing_data" });
  try {
    await pool.query(
      `INSERT INTO dashboard_state (id, data, updated_at)
       VALUES (1, $1, NOW())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [JSON.stringify(data)]
    );
    res.json({ ok: true, updated_at: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "db_error", detail: String(err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`VAU API listening on ${PORT}`));

