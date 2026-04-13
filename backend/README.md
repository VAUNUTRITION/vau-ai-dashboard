# VAU Dashboard API

Tiny Node backend that stores dashboard state in Postgres.

## Deploy on Railway

1. Create a new Railway project → "Deploy from GitHub repo" → select this repo.
2. Set **Root Directory** to `backend` in service settings.
3. Add a **Postgres** plugin to the project. Railway auto-injects `DATABASE_URL`.
4. Add a variable `WRITE_KEY` with a long random string (this is the password to save edits).
5. Click **Generate Domain** in the service's Networking tab — you'll get a URL like `vau-dashboard-api-production.up.railway.app`.
6. Paste that URL into the `index.html` frontend (API_URL constant).

## Endpoints

- `GET /api/data` — returns `{ data, updated_at }`. Public read.
- `POST /api/data` — body `{ data }`, header `x-write-key: <WRITE_KEY>`. Protected write.

## Local dev

```bash
cd backend
npm install
DATABASE_URL=postgres://... WRITE_KEY=test npm start
```

