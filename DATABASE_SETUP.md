# Database Setup for Heresay Homicide

This build supports persistent sessions.

## Local testing

If `DATABASE_URL` is not set, the app stores session data in:

```text
./data/sessions.json
```

Run locally:

```bash
npm install
npm start
```

## Render production setup

Use Render Postgres for production.

1. In Render, create a new PostgreSQL database.
2. Copy the database Internal Database URL.
3. Open your Heresay Homicide Web Service.
4. Go to Environment.
5. Add:

```text
DATABASE_URL=your_internal_database_url
NODE_VERSION=20.18.1
```

The repo also includes `.node-version`, so Render should use Node 20.18.1 automatically.

## Render build settings

Use:

```text
Build Command: npm install
Start Command: npm start
```
