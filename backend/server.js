import express from "express";
import cors from "cors";
import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway") || process.env.DATABASE_URL?.includes("sslmode") ? { rejectUnauthorized: false } : undefined,
});

const WRITE_KEY = process.env.WRITE_KEY || "CHANGE_ME_IN_RAILWAY";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "5mb" }));

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

const RAW_URL = "https://raw.githubusercontent.com/VAUNUTRITION/vau-ai-dashboard/main/index.html";
let CACHED_HTML = null;
let CACHED_AT = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function getDashboardHtml() {
  const now = Date.now();
  if (CACHED_HTML && (now - CACHED_AT) < CACHE_TTL_MS) return CACHED_HTML;
  const r = await fetch(RAW_URL, { cache: "no-store" });
  if (!r.ok) throw new Error("fetch_failed " + r.status);
  let html = await r.text();
  html = html.replace('const API_URL = "";', 'const API_URL = window.location.origin;');
  CACHED_HTML = html;
  CACHED_AT = now;
  return html;
}

app.get("/", async (_req, res) => {
  try {
    const html = await getDashboardHtml();
    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading dashboard: " + String(err));
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, api: "VAU Dashboard" });
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
