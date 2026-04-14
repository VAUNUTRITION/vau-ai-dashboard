import express from "express";
import cors from "cors";
import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway") || process.env.DATABASE_URL?.includes("sslmode") ? { rejectUnauthorized: false } : undefined,
});

// Write key â set this in Railway Variables. Without a valid key, POST requests fail.
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

// ---- Dashboard HTML served from Railway (fetched from GitHub raw at startup, API_URL injected) ----
const RAW_URL = "https://raw.githubusercontent.com/VAUNUTRITION/vau-ai-dashboard/main/index.html";
let CACHED_HTML = null;
let CACHED_AT = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

async function getDashboardHtml() {
  const now = Date.now();
  if (CACHED_HTML && (now - CACHED_AT) < CACHE_TTL_MS) return CACHED_HTML;
  const r = await fetch(RAW_URL, { cache: "no-store" });
  if (!r.ok) throw new Error("fetch_failed " + r.status);
  let html = await r.text();
  // Inject Railway URL (self)
  html = html.replace(
    'const API_URL = "";',
    'const API_URL = "";\nwindow.__VAU_API_URL = window.location.origin;'
  );
  // Also overwrite the const via a wrapper trick â simplest: replace the empty string line
  html = html.replace(
    'const API_URL = "";\nwindow.__VAU_API_URL = window.location.origin;',
    'const API_URL = window.location.origin;'
  );
  // Auto-inject: write key + API bridge (localStorageâDB sync) + live polling
  const autoKey = process.env.AUTO_WRITE_KEY || process.env.WRITE_KEY;
  const injectedScript = `
<script>
(function(){
  var SK = 'vau_dash_v7';
  var WK = 'vau_dash_write_key';
  var writeKey = ${autoKey ? JSON.stringify(autoKey) : 'null'};

  // 1. Auto-grant write access
  if (writeKey) try { localStorage.setItem(WK, writeKey); } catch(e){}

  // 2. On load: pull DB data into localStorage so React sees it
  (async function(){
    try {
      var r = await fetch('/api/data', { cache: 'no-store' });
      var j = await r.json();
      if (j && j.data && Array.isArray(j.data) && j.data.length > 0) {
        var local = null;
        try { local = JSON.parse(localStorage.getItem(SK)); } catch(e){}
        var localLen = local ? JSON.stringify(local).length : 0;
        var dbLen = JSON.stringify(j.data).length;
        // Use DB data if local is empty OR DB is bigger (more up-to-date)
        if (!local || localLen < 100 || dbLen > localLen) {
          localStorage.setItem(SK, JSON.stringify(j.data));
          window.__vauDbTs = j.updated_at;
          // Only reload if React already rendered stale data
          if (document.querySelector('#root') && document.querySelector('#root').children.length > 0) {
            location.reload();
          }
        }
      }
    } catch(e){ console.warn('[VAU] DB load failed', e); }
  })();

  // 3. Intercept localStorage writes â POST to API (bridge React saves to DB)
  var origSetItem = Storage.prototype.setItem;
  var postTimer = null;
  Storage.prototype.setItem = function(key, value) {
    origSetItem.call(this, key, value);
    if (key === SK && writeKey) {
      clearTimeout(postTimer);
      postTimer = setTimeout(function(){
        try {
          var parsed = JSON.parse(value);
          if (!Array.isArray(parsed) || parsed.length === 0) return;
          fetch('/api/data', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-write-key': writeKey },
            body: JSON.stringify({ data: parsed })
          }).then(function(r){
            if (r.ok) { r.json().then(function(j){ window.__vauDbTs = j.updated_at; }); }
            else { console.warn('[VAU] sync POST', r.status); }
          }).catch(function(e){ console.warn('[VAU] sync failed', e); });
        } catch(e){}
      }, 1500);
    }
  };

  // 4. Poll: reload if someone else saved newer data
  var pollTimer2 = null;
  async function poll() {
    try {
      var r = await fetch('/api/data', { cache: 'no-store' });
      var j = await r.json();
      if (j && j.updated_at && window.__vauDbTs && j.updated_at !== window.__vauDbTs) {
        window.__vauDbTs = j.updated_at;
        localStorage.setItem = origSetItem; // restore to avoid loop
        localStorage.setItem(SK, JSON.stringify(j.data));
        location.reload();
      }
      if (j && j.updated_at) window.__vauDbTs = j.updated_at;
    } catch(e){}
  }
  setTimeout(poll, 5000);
  setInterval(poll, 30000);
  document.addEventListener('visibilitychange', function(){
    if (document.visibilityState === 'visible') poll();
  });
})();
</script>`;
  html = html.replace('</head>', injectedScript + '</head>');
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
