const fs = require('fs/promises');
const path = require('path');

function serializeSession(session) {
  return {
    ...session,
    players: Array.from(session.players?.values?.() || [])
  };
}

function hydrateSession(raw) {
  const session = {
    ...raw,
    players: new Map()
  };
  const players = Array.isArray(raw.players)
    ? raw.players
    : raw.players && typeof raw.players === 'object'
      ? Object.values(raw.players)
      : [];

  for (const player of players) {
    if (!player || !player.id) continue;
    session.players.set(player.id, {
      ...player,
      connected: false
    });
  }

  return session;
}

class JsonFileDatabase {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { sessions: {} };
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      this.data = JSON.parse(raw || '{"sessions":{}}');
      if (!this.data.sessions) this.data.sessions = {};
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      await this.flush();
    }
  }

  async flush() {
    const payload = JSON.stringify(this.data, null, 2);
    this.writeQueue = this.writeQueue.then(() => fs.writeFile(this.filePath, payload));
    return this.writeQueue;
  }

  async listSessions() {
    return Object.values(this.data.sessions || {}).map(hydrateSession);
  }

  async saveSession(session) {
    this.data.sessions[session.code] = serializeSession(session);
    await this.flush();
  }

  async deleteSession(code) {
    delete this.data.sessions[String(code || '').toUpperCase()];
    await this.flush();
  }

  async close() {}
}

class PostgresDatabase {
  constructor(connectionString) {
    const { Pool } = require('pg');
    this.pool = new Pool({
      connectionString,
      ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }
    });
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS mystery_sessions (
        code TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  }

  async listSessions() {
    const result = await this.pool.query('SELECT data FROM mystery_sessions ORDER BY updated_at DESC');
    return result.rows.map(row => hydrateSession(row.data));
  }

  async saveSession(session) {
    await this.pool.query(
      `INSERT INTO mystery_sessions (code, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (code)
       DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [session.code, JSON.stringify(serializeSession(session))]
    );
  }

  async deleteSession(code) {
    await this.pool.query('DELETE FROM mystery_sessions WHERE code = $1', [String(code || '').toUpperCase()]);
  }

  async close() {
    await this.pool.end();
  }
}

function createDatabase() {
  if (process.env.DATABASE_URL) {
    return new PostgresDatabase(process.env.DATABASE_URL);
  }

  const filePath = process.env.SESSION_DB_FILE || path.join(__dirname, 'data', 'sessions.json');
  return new JsonFileDatabase(filePath);
}

module.exports = {
  createDatabase,
  serializeSession,
  hydrateSession
};
