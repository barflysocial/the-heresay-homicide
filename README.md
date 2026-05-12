# Heresay Homicide

Mobile-friendly live hosted detective mystery game for Heresay Speakeasy at Circa 1857 Antique Store in Baton Rouge.

## Run locally

```bash
npm install
npm start
```

Open:

```text
http://localhost:3000/host/
http://localhost:3000/player/
```

## Database

- If `DATABASE_URL` exists, the app uses PostgreSQL.
- If `DATABASE_URL` does not exist, the app uses `./data/sessions.json`.

## Render settings

```text
Runtime: Node
Build Command: npm install
Start Command: npm start
NODE_VERSION: 20.18.1
```

## Game notes

- Game title: Heresay Homicide
- Venue: Heresay Speakeasy at Circa 1857 Antique Store, Baton Rouge
- Code prefix: `HH-`
- Default level: Level 2 Rookie Detective
- Levels included: Training, Rookie, Junior, Detective, Senior

See `DATABASE_SETUP.md`.
