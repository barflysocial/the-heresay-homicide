const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const { createDatabase } = require('./database');

const PORT = process.env.PORT || 3000;
const GAME_TOTAL_SEC = 30 * 60;
const ACCUSATION_OPEN_SEC = 24 * 60;
const ACCUSATION_LOCK_SEC = 28 * 60;

function nanoid(size = 12) {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let id = '';
  for (let i = 0; i < size; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function makeAccessCode(existingCodes = new Set()) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = 'HH-';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (existingCodes.has(code));
  existingCodes.add(code);
  return code;
}

function normalizeAccessCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^HH/, 'HH-');
}
function normalizeInstagram(value) {
  const cleaned = String(value || '').trim().replace(/^@+/, '').replace(/[^A-Za-z0-9._]/g, '').slice(0, 40);
  return cleaned ? `@${cleaned}` : '';
}

function normalizeContact(value) {
  return String(value || '').trim().slice(0, 120);
}
function normalizeGuestCount(value) {
  const n = Number(value || 1);
  return Math.max(1, Math.min(10, Number.isFinite(n) ? Math.floor(n) : 1));
}

function makeDisplayName(firstName, lastName, fallback = 'Detective') {
  const first = String(firstName || '').trim();
  const last = String(lastName || '').trim();
  if (first && last) return `${first} ${last.charAt(0).toUpperCase()}.`;
  if (first) return first;
  const fb = String(fallback || '').trim();
  return fb || 'Detective';
}

function fullName(firstName, lastName, fallback = 'Detective') {
  const name = `${String(firstName || '').trim()} ${String(lastName || '').trim()}`.trim();
  return name || String(fallback || '').trim() || 'Detective';
}


function makeAccessCodes(count = 25) {
  const cap = Math.max(1, Math.min(100, Number(count || 25)));
  const used = new Set();
  return Array.from({ length: cap }, () => ({
    code: makeAccessCode(used),
    paid: false,
    claimed: false,
    playerId: '',
    playerName: '',
    firstName: '',
    lastName: '',
    instagram: '',
    displayName: '',
    claimedAt: null
  }));
}

const APP_BUCKETS = [
  'phone', 'messages', 'maps', 'bank', 'photos', 'social',
  'contacts', 'notes', 'files', 'browser', 'accuse'
];

function makeEmptyApps() {
  return APP_BUCKETS.reduce((obj, key) => {
    obj[key] = [];
    return obj;
  }, {});
}

function normalizeBucket(bucket) {
  const b = String(bucket || 'notes').toLowerCase().trim();
  return APP_BUCKETS.includes(b) ? b : 'notes';
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const database = createDatabase();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const truthPacks = loadTruthPacks();
const sessions = new Map();
const socketsBySession = new Map();

function loadTruthPacks() {
  const dir = path.join(__dirname, 'truth-packs');
  const packs = {};
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const raw = fs.readFileSync(path.join(dir, file), 'utf8');
    const pack = JSON.parse(raw);
    packs[pack.id] = pack;
  }
  return packs;
}

function getPack(sessionOrId) {
  const id = typeof sessionOrId === 'string' ? sessionOrId : sessionOrId?.truthPackId;
  return truthPacks[id] || truthPacks['heresay-homicide-training'] || truthPacks['heresay-homicide'] || truthPacks.demo;
}

function aggregateTruthPack(pack) {
  const publicClues = [];
  const appClues = [];

  if (Array.isArray(pack.publicClues)) {
    for (const clue of pack.publicClues) publicClues.push({ ...clue, bucket: 'public' });
  }

  if (pack.apps && typeof pack.apps === 'object') {
    for (const [bucket, clues] of Object.entries(pack.apps)) {
      if (!Array.isArray(clues)) continue;
      for (const clue of clues) appClues.push({ ...clue, bucket: normalizeBucket(bucket) });
    }
  }

  if (pack.roles && typeof pack.roles === 'object') {
    for (const role of Object.values(pack.roles)) {
      if (!role || !Array.isArray(role.clues)) continue;
      for (const clue of role.clues) {
        appClues.push({ ...clue, bucket: normalizeBucket(clue.bucket || clue.app || 'notes') });
      }
    }
  }

  return { publicClues, appClues };
}

function computeElapsedSec(session) {
  if (!session.startedAt) return session.elapsedAtPause || 0;
  return Math.min(GAME_TOTAL_SEC, Math.max(0, Math.floor((Date.now() - session.startedAt) / 1000)));
}

function computePhase(session) {
  if (session.status === 'lobby') return 'lobby';
  if (session.status === 'revealed') return 'revealed';

  const elapsedSec = computeElapsedSec(session);
  if (elapsedSec >= GAME_TOTAL_SEC || elapsedSec >= ACCUSATION_LOCK_SEC) return 'accusation_locked';
  if (elapsedSec >= ACCUSATION_OPEN_SEC) return 'accusation';
  return 'investigation';
}

function normalizeRounds(pack) {
  const provided = Array.isArray(pack?.rounds) ? pack.rounds : [];
  const fallback = [
    { id: 'r1', title: 'Round 1: The Body', shortTitle: 'Body', startSec: 0, endSec: 5 * 60, objective: 'Review the scene.', dialogue: 'The case begins now.' },
    { id: 'r2', title: 'Round 2: The Timeline', shortTitle: 'Timeline', startSec: 5 * 60, endSec: 10 * 60, objective: 'Rebuild the timeline.', dialogue: 'Track movement.' },
    { id: 'r3', title: 'Round 3: The Digital Trail', shortTitle: 'Digital', startSec: 10 * 60, endSec: 15 * 60, objective: 'Review altered digital records.', dialogue: 'Follow the digital trail.' },
    { id: 'r4', title: 'Round 4: The Money', shortTitle: 'Money', startSec: 15 * 60, endSec: 20 * 60, objective: 'Follow the money.', dialogue: 'The motive sharpens.' },
    { id: 'r5', title: 'Round 5: The Cover-Up', shortTitle: 'Cover-Up', startSec: 20 * 60, endSec: ACCUSATION_OPEN_SEC, objective: 'Connect the cover-up.', dialogue: 'The cover-up breaks.' },
    { id: 'r6', title: 'Final Accusation', shortTitle: 'Accuse', startSec: ACCUSATION_OPEN_SEC, endSec: ACCUSATION_LOCK_SEC, objective: 'Submit your final answers.', dialogue: 'Choose carefully.' }
  ];

  return (provided.length ? provided : fallback)
    .map((r, idx) => ({
      id: r.id || `round-${idx + 1}`,
      title: r.title || `Round ${idx + 1}`,
      shortTitle: r.shortTitle || r.title || `Round ${idx + 1}`,
      startSec: Number(r.startSec || 0),
      endSec: Number(r.endSec || GAME_TOTAL_SEC),
      objective: r.objective || '',
      dialogue: r.dialogue || '',
      countdownReview: r.countdownReview || ''
    }))
    .sort((a, b) => a.startSec - b.startSec);
}

function currentRoundFor(session, pack) {
  const rounds = normalizeRounds(pack);
  const elapsedSec = computeElapsedSec(session);
  const phase = computePhase(session);
  let current = rounds.find(r => elapsedSec >= r.startSec && elapsedSec < r.endSec);

  if (!current) {
    if (phase === 'lobby') current = rounds[0] || null;
    else current = rounds[rounds.length - 1] || null;
  }

  return { rounds, current };
}

function visibleEvidence(session) {
  const pack = getPack(session);
  const aggregated = aggregateTruthPack(pack);
  const elapsedSec = computeElapsedSec(session);
  const publicClues = aggregated.publicClues
    .filter(c => Number(c.unlockSec || 0) <= elapsedSec)
    .sort((a, b) => Number(a.unlockSec || 0) - Number(b.unlockSec || 0));

  const apps = makeEmptyApps();
  for (const clue of aggregated.appClues) {
    if (Number(clue.unlockSec || 0) <= elapsedSec) apps[normalizeBucket(clue.bucket)].push(clue);
  }
  for (const bucket of Object.keys(apps)) {
    apps[bucket].sort((a, b) => Number(a.unlockSec || 0) - Number(b.unlockSec || 0));
  }

  return { publicClues, apps };
}

function publicPlayer(player) {
  return {
    id: player.id,
    name: player.name,
    firstName: player.firstName || '',
    lastName: player.lastName || '',
    instagram: player.instagram || '',
    fullName: player.fullName || fullName(player.firstName, player.lastName, player.name),
    joinedAt: player.joinedAt,
    connected: Boolean(player.connected),
    lastSeen: player.lastSeen
  };
}

function getBadge(score, total) {
  if (score >= total) return 'Senior Detective';
  if (score >= 8) return 'Detective';
  if (score >= 6) return 'Junior Detective';
  if (score >= 4) return 'Rookie Detective';
  return 'Training Detective';
}

function normalizeResults(results) {
  return Array.isArray(results) ? results : [];
}


function normalizeRsvps(session) {
  const rsvps = Array.isArray(session.rsvps) ? session.rsvps : [];
  session.rsvps = rsvps.map(item => ({
    id: item.id || nanoid(8),
    firstName: String(item.firstName || '').trim().slice(0, 30),
    lastName: String(item.lastName || '').trim().slice(0, 30),
    fullName: fullName(item.firstName, item.lastName, item.name),
    displayName: makeDisplayName(item.firstName, item.lastName, item.name),
    instagram: normalizeInstagram(item.instagram || ''),
    contact: normalizeContact(item.contact || ''),
    guestCount: normalizeGuestCount(item.guestCount || item.guests || 1),
    teamName: String(item.teamName || '').trim().slice(0, 50),
    status: item.status || 'rsvped',
    paid: Boolean(item.paid),
    accessCode: item.accessCode ? normalizeAccessCode(item.accessCode) : '',
    checkedIn: Boolean(item.checkedIn),
    playerId: item.playerId || '',
    createdAt: item.createdAt || Date.now(),
    updatedAt: item.updatedAt || item.createdAt || Date.now()
  })).filter(item => item.firstName && item.lastName && item.contact);
  return session.rsvps;
}

function rsvpSummary(session) {
  const rsvps = normalizeRsvps(session);
  return {
    total: rsvps.length,
    paid: rsvps.filter(r => r.paid).length,
    assigned: rsvps.filter(r => r.accessCode).length,
    checkedIn: rsvps.filter(r => r.checkedIn).length,
    reservedSpots: rsvps.length
  };
}

function normalizeAccessCodes(session) {
  const codes = Array.isArray(session.accessCodes) ? session.accessCodes : [];
  session.playerCap = Math.max(1, Math.min(100, Number(session.playerCap || codes.length || 25)));
  session.accessCodes = codes.map(item => ({
    code: normalizeAccessCode(item.code),
    paid: Boolean(item.paid),
    claimed: Boolean(item.claimed || item.playerId),
    playerId: item.playerId || '',
    firstName: item.firstName || '',
    lastName: item.lastName || '',
    instagram: normalizeInstagram(item.instagram || ''),
    displayName: item.displayName || makeDisplayName(item.firstName, item.lastName, item.playerName),
    playerName: item.playerName || makeDisplayName(item.firstName, item.lastName, item.playerName),
    claimedAt: item.claimedAt || null
  })).filter(item => item.code);
  if (!session.accessCodes.length) session.accessCodes = makeAccessCodes(session.playerCap);
  session.playerCap = session.accessCodes.length;
  return session.accessCodes;
}

function findSessionByAccessCode(accessCode) {
  const normalized = normalizeAccessCode(accessCode);
  for (const session of sessions.values()) {
    const found = normalizeAccessCodes(session).find(item => item.code === normalized);
    if (found) return { session, access: found };
  }
  return { session: null, access: null };
}

function accessSummary(session) {
  const codes = normalizeAccessCodes(session);
  const used = codes.filter(c => c.claimed || c.playerId).length;
  const paid = codes.filter(c => c.paid).length;
  return {
    playerCap: codes.length,
    used,
    available: Math.max(0, codes.length - used),
    paid,
    unpaid: Math.max(0, codes.length - paid)
  };
}

function sanitizeAccusation(accusation) {
  if (!accusation) return null;
  return {
    ...accusation,
    questions: (accusation.questions || []).map(q => {
      const { correctOptionId, ...safeQuestion } = q;
      return safeQuestion;
    })
  };
}

function clientState(session) {
  const evidence = visibleEvidence(session);
  const elapsedSec = computeElapsedSec(session);
  const phase = computePhase(session);
  const pack = getPack(session);
  const { rounds, current } = currentRoundFor(session, pack);
  const remainingSec = Math.max(0, GAME_TOTAL_SEC - elapsedSec);
  const remainingToAccusationSec = Math.max(0, ACCUSATION_OPEN_SEC - elapsedSec);

  return {
    sessionCode: session.code,
    tableName: session.tableName,
    truthPackId: session.truthPackId,
    truthPackTitle: pack.title,
    difficulty: pack.difficulty || 'Rookie Detective',
    difficultyLabel: pack.difficultyLabel || 'CHAPTER 1: LAST CALL AT HERESAY',
    openingNarration: pack.openingNarration || '',
    revealScript: pack.revealScript || '',
    accusation: sanitizeAccusation(pack.accusation),
    mode: 'Detective Mode',
    evidenceModel: 'Unified Evidence',
    phase,
    status: session.status,
    elapsedSec,
    remainingSec,
    remainingToAccusationSec,
    totalSec: GAME_TOTAL_SEC,
    accusationOpenSec: ACCUSATION_OPEN_SEC,
    accusationLockSec: ACCUSATION_LOCK_SEC,
    rounds,
    currentRound: current,
    players: Array.from(session.players.values()).map(publicPlayer),
    access: accessSummary(session),
    rsvp: rsvpSummary(session),
    hostMessages: session.hostMessages || [],
    helpRequests: session.helpRequests || [],
    submissions: session.submissions || [],
    results: normalizeResults(session.results),
    revealed: session.revealed,
    answerKey: session.revealed ? pack.answerKey : null,
    publicClues: evidence.publicClues,
    apps: evidence.apps,
    serverTime: Date.now()
  };
}

function hostState(session) {
  return {
    ...clientState(session),
    accessCodes: normalizeAccessCodes(session),
    rsvps: normalizeRsvps(session)
  };
}

function createSession({ tableName = 'Table 1', truthPackId = 'heresay-homicide-training', playerCap = 25 } = {}) {
  let code = makeCode();
  while (sessions.has(code)) code = makeCode();
  const session = {
    id: nanoid(10),
    code,
    tableName,
    truthPackId: truthPacks[truthPackId] ? truthPackId : 'heresay-homicide-training',
    playerCap: Math.max(1, Math.min(100, Number(playerCap || 25))),
    accessCodes: makeAccessCodes(playerCap || 25),
    status: 'lobby',
    startedAt: null,
    elapsedAtPause: 0,
    createdAt: Date.now(),
    players: new Map(),
    hostMessages: [],
    helpRequests: [],
    rsvps: [],
    submissions: [],
    results: [],
    revealed: false
  };
  sessions.set(code, session);
  return session;
}

async function saveSession(session) {
  try {
    await database.saveSession(session);
  } catch (err) {
    console.error('Database save failed:', err);
  }
}

async function loadSessionsFromDatabase() {
  const savedSessions = await database.listSessions();
  for (const session of savedSessions) {
    if (!Array.isArray(session.hostMessages)) session.hostMessages = [];
    if (!Array.isArray(session.helpRequests)) session.helpRequests = [];
    if (!Array.isArray(session.submissions)) session.submissions = [];
    if (!Array.isArray(session.results)) session.results = [];
    normalizeAccessCodes(session);
    normalizeRsvps(session);
    sessions.set(session.code, session);
  }
  return savedSessions.length;
}

function getSessionOr404(code, res) {
  const session = sessions.get(String(code || '').toUpperCase());
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return null;
  }
  return session;
}

function broadcast(code) {
  const session = sessions.get(code);
  if (!session) return;
  const payload = JSON.stringify({ type: 'state', state: clientState(session) });
  const set = socketsBySession.get(code);
  if (!set) return;
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

function broadcastAll() {
  for (const code of sessions.keys()) broadcast(code);
}

function upsertSubmission(session, submission) {
  session.submissions = session.submissions || [];
  return mergeSubmission(session, submission);
}

function findQuestion(pack, id) {
  return (pack?.accusation?.questions || []).find(q => q.id === id);
}

function getQuestionUnlockSec(question) {
  return Number(question.unlockSec || 0);
}

function mergeSubmission(session, submission) {
  const existing = (session.submissions || []).find(s => s.playerId === submission.playerId);
  if (existing) {
    existing.answers = { ...(existing.answers || {}), ...(submission.answers || {}) };
    existing.updatedAt = Date.now();
    existing.playerName = submission.playerName || existing.playerName;
    existing.createdAt = existing.createdAt || Date.now();
    return existing;
  }
  session.submissions.unshift(submission);
  return submission;
}

function gradeSubmission(pack, player, submission) {
  const questions = pack?.accusation?.questions || [];
  const answers = submission?.answers || {};
  const breakdown = questions.map(q => {
    const selectedId = answers[q.id] || '';
    const selectedOption = (q.options || []).find(o => o.id === selectedId);
    const correctOption = (q.options || []).find(o => o.id === q.correctOptionId);
    const correct = selectedId === q.correctOptionId;
    return {
      id: q.id,
      prompt: q.prompt,
      selectedOptionId: selectedId,
      selectedLabel: selectedOption?.label || 'No answer submitted',
      correctOptionId: q.correctOptionId,
      correctLabel: correctOption?.label || '',
      correct
    };
  });
  const score = breakdown.filter(item => item.correct).length;
  const total = questions.length || 10;
  return {
    id: nanoid(8),
    playerId: player.id,
    playerName: player.name,
    firstName: player.firstName || '',
    lastName: player.lastName || '',
    instagram: player.instagram || '',
    fullName: player.fullName || fullName(player.firstName, player.lastName, player.name),
    score,
    total,
    badge: getBadge(score, total),
    breakdown,
    updatedAt: Date.now(),
    submitted: Boolean(submission),
    submittedAt: submission?.createdAt || null
  };
}

function gradeAllPlayers(session) {
  const pack = getPack(session);
  const submissionByPlayer = new Map((session.submissions || []).map(s => [s.playerId, s]));
  const results = [];
  for (const player of session.players.values()) {
    const submission = submissionByPlayer.get(player.id) || null;
    results.push(gradeSubmission(pack, player, submission));
  }
  return results.sort((a, b) => b.score - a.score || a.playerName.localeCompare(b.playerName));
}

function addHostMessage(session, { title, text, kind = 'dialog' }) {
  session.hostMessages = session.hostMessages || [];
  session.hostMessages.push({ id: nanoid(8), title, text, kind, createdAt: Date.now(), from: 'Host' });
}

setInterval(() => {
  for (const session of sessions.values()) {
    if (session.status === 'started' && computeElapsedSec(session) >= GAME_TOTAL_SEC) {
      session.status = 'locked';
      saveSession(session);
    }
  }
  broadcastAll();
}, 1000);

app.get('/', (_req, res) => res.redirect('/player/'));
app.get('/host', (_req, res) => res.redirect('/host/'));
app.get('/api/health', (_req, res) => res.json({ ok: true, sessions: sessions.size, time: Date.now() }));
app.get('/api/truth-packs', (_req, res) => {
  const order = ['training', 'rookie', 'junior', 'detective', 'senior'];
  const packs = Object.values(truthPacks)
    .filter(p => p.gameId === 'heresay-homicide' && p.id !== 'heresay-homicide')
    .sort((a, b) => order.indexOf(a.levelId) - order.indexOf(b.levelId));
  res.json(packs.map(p => ({
    id: p.id,
    gameId: p.gameId || 'heresay-homicide',
    gameTitle: p.gameTitle || 'Heresay Homicide',
    levelId: p.levelId || '',
    levelName: p.levelName || '',
    levelLabel: p.levelLabel || p.difficulty || '',
    difficulty: p.difficulty || '',
    difficultyLabel: p.difficultyLabel || '',
    title: p.title,
    venue: p.venue || '',
    description: p.description || ''
  })));
});

app.post('/api/sessions', async (req, res) => {
  const session = createSession(req.body || {});
  await saveSession(session);
  res.json(hostState(session));
  broadcast(session.code);
});

app.get('/api/sessions', (_req, res) => {
  res.json(Array.from(sessions.values()).map(hostState));
});



app.get('/api/rsvp-sessions', (_req, res) => {
  const items = Array.from(sessions.values()).map(session => {
    const pack = getPack(session);
    const access = accessSummary(session);
    const rsvp = rsvpSummary(session);
    return {
      sessionCode: session.code,
      tableName: session.tableName,
      truthPackTitle: pack.title,
      difficulty: pack.difficulty || '',
      difficultyLabel: pack.difficultyLabel || '',
      playerCap: access.playerCap,
      spotsClaimed: access.used,
      spotsAvailable: access.available,
      rsvpTotal: rsvp.total,
      rsvpGuests: rsvp.guests,
      status: session.status,
      createdAt: session.createdAt || Date.now()
    };
  }).sort((a,b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  res.json(items);
});

app.post('/api/rsvps', async (req, res) => {
  const session = getSessionOr404(req.body.sessionCode, res);
  if (!session) return;
  const firstName = String(req.body.firstName || '').trim().slice(0, 30);
  const lastName = String(req.body.lastName || '').trim().slice(0, 30);
  const contact = normalizeContact(req.body.contact || '');
  const instagram = normalizeInstagram(req.body.instagram || '');
  const guestCount = 1;
  const teamName = String(req.body.teamName || '').trim().slice(0, 50);
  if (!firstName || !lastName || !contact) return res.status(400).json({ error: 'First name, last name, and phone or email are required. Instagram is optional.' });
  const rsvps = normalizeRsvps(session);
  const existing = rsvps.find(r => r.contact.toLowerCase() === contact.toLowerCase() && r.firstName.toLowerCase() === firstName.toLowerCase() && r.lastName.toLowerCase() === lastName.toLowerCase());
  const data = {
    firstName,
    lastName,
    fullName: fullName(firstName, lastName),
    displayName: makeDisplayName(firstName, lastName),
    instagram,
    contact,
    guestCount,
    teamName,
    updatedAt: Date.now()
  };
  let rsvp;
  if (existing) {
    Object.assign(existing, data);
    rsvp = existing;
  } else {
    rsvp = { id: nanoid(8), ...data, status: 'rsvped', paid: false, accessCode: '', checkedIn: false, playerId: '', createdAt: Date.now() };
    session.rsvps.unshift(rsvp);
  }
  await saveSession(session);
  res.json({ ok: true, message: 'RSVP saved. You still need a personal access code from the host to enter the live game.', rsvp, state: clientState(session) });
  broadcast(session.code);
});

app.post('/api/sessions/:code/rsvps/:id/paid', async (req, res) => {
  const session = getSessionOr404(req.params.code, res);
  if (!session) return;
  const rsvp = normalizeRsvps(session).find(item => item.id === req.params.id);
  if (!rsvp) return res.status(404).json({ error: 'RSVP not found' });
  rsvp.paid = Boolean(req.body.paid);
  rsvp.updatedAt = Date.now();
  if (rsvp.accessCode) {
    const access = normalizeAccessCodes(session).find(item => item.code === rsvp.accessCode);
    if (access) access.paid = rsvp.paid;
  }
  await saveSession(session);
  res.json(hostState(session));
  broadcast(session.code);
});

app.post('/api/sessions/:code/rsvps/:id/assign-code', async (req, res) => {
  const session = getSessionOr404(req.params.code, res);
  if (!session) return;
  const rsvps = normalizeRsvps(session);
  const rsvp = rsvps.find(item => item.id === req.params.id);
  if (!rsvp) return res.status(404).json({ error: 'RSVP not found' });
  const codes = normalizeAccessCodes(session);
  let access = rsvp.accessCode ? codes.find(item => item.code === rsvp.accessCode) : null;
  if (!access) access = codes.find(item => !item.claimed && !rsvps.some(r => r.accessCode === item.code));
  if (!access) return res.status(409).json({ error: 'No unassigned access codes are available.' });
  access.paid = true;
  rsvp.paid = true;
  rsvp.accessCode = access.code;
  rsvp.updatedAt = Date.now();
  await saveSession(session);
  res.json(hostState(session));
  broadcast(session.code);
});

app.get('/api/access/:accessCode/preview', (req, res) => {
  const { session } = findSessionByAccessCode(req.params.accessCode);
  if (!session) return res.status(404).json({ error: 'Invalid access code' });
  res.json(clientState(session));
});

app.post('/api/access/join', async (req, res) => {
  const accessCode = normalizeAccessCode(req.body.accessCode);
  const { session, access } = findSessionByAccessCode(accessCode);
  if (!session || !access) return res.status(404).json({ error: 'Invalid access code.' });
  const firstName = String(req.body.firstName || '').trim().slice(0, 30);
  const lastName = String(req.body.lastName || '').trim().slice(0, 30);
  const instagram = normalizeInstagram(req.body.instagram || '');
  const legacyName = String(req.body.name || '').trim().slice(0, 40);
  if (!firstName || !lastName) return res.status(400).json({ error: 'First name and last name are required. Instagram is optional.' });
  const displayName = makeDisplayName(firstName, lastName, legacyName);
  const legalName = fullName(firstName, lastName, legacyName);
  const incomingPlayerId = req.body.playerId && String(req.body.playerId).length > 5 ? String(req.body.playerId) : '';

  if (access.claimed && access.playerId && access.playerId !== incomingPlayerId) {
    return res.status(409).json({ error: 'This access code has already been claimed. See the host for help.' });
  }

  const playerId = access.playerId || incomingPlayerId || nanoid(12);
  access.claimed = true;
  access.playerId = playerId;
  access.firstName = firstName;
  access.lastName = lastName;
  access.instagram = instagram;
  access.displayName = displayName;
  access.playerName = displayName;
  access.claimedAt = access.claimedAt || Date.now();

  const matchingRsvp = normalizeRsvps(session).find(r => r.accessCode === accessCode || (r.contact && r.contact.toLowerCase() === normalizeContact(req.body.contact || '').toLowerCase()));
  if (matchingRsvp) {
    matchingRsvp.checkedIn = true;
    matchingRsvp.playerId = playerId;
    matchingRsvp.accessCode = matchingRsvp.accessCode || accessCode;
    matchingRsvp.updatedAt = Date.now();
  }

  session.players.set(playerId, {
    id: playerId,
    name: displayName,
    firstName,
    lastName,
    fullName: legalName,
    instagram,
    accessCode,
    joinedAt: Date.now(),
    lastSeen: Date.now(),
    connected: true
  });
  await saveSession(session);
  const state = clientState(session);
  res.json({ playerId, sessionCode: session.code, accessCode, state });
  broadcast(session.code);
});

app.post('/api/sessions/:code/access-codes/:accessCode/paid', async (req, res) => {
  const session = getSessionOr404(req.params.code, res);
  if (!session) return;
  const code = normalizeAccessCode(req.params.accessCode);
  const access = normalizeAccessCodes(session).find(item => item.code === code);
  if (!access) return res.status(404).json({ error: 'Access code not found' });
  access.paid = Boolean(req.body.paid);
  await saveSession(session);
  res.json(hostState(session));
  broadcast(session.code);
});

app.get('/api/sessions/:code', (req, res) => {
  const session = getSessionOr404(req.params.code, res);
  if (!session) return;
  res.json(clientState(session));
});

app.post('/api/sessions/:code/join', async (req, res) => {
  res.status(410).json({ error: 'Shared session-code joining is disabled. Use your personal paid access code.' });
});

app.post('/api/sessions/:code/start', async (req, res) => {
  const session = getSessionOr404(req.params.code, res);
  if (!session) return;
  if (req.body.truthPackId && truthPacks[req.body.truthPackId]) session.truthPackId = req.body.truthPackId;
  session.status = 'started';
  session.revealed = false;
  session.results = [];
  session.startedAt = Date.now();
  session.elapsedAtPause = 0;
  await saveSession(session);
  res.json(clientState(session));
  broadcast(session.code);
});

app.post('/api/sessions/:code/set-elapsed', async (req, res) => {
  const session = getSessionOr404(req.params.code, res);
  if (!session) return;
  const nextElapsed = Math.max(0, Math.min(GAME_TOTAL_SEC, Number(req.body.elapsedSec || 0)));
  session.status = 'started';
  session.revealed = false;
  session.results = [];
  session.elapsedAtPause = nextElapsed;
  session.startedAt = Date.now() - (nextElapsed * 1000);

  const pushRoundPopup = Boolean(req.body.pushRoundPopup);
  if (pushRoundPopup) {
    const pack = getPack(session);
    const { current } = currentRoundFor(session, pack);
    if (current) addHostMessage(session, { title: current.title, text: current.dialogue || current.objective || 'Review the newly unlocked evidence.', kind: 'dialog' });
  }

  await saveSession(session);
  res.json(clientState(session));
  broadcast(session.code);
});

app.post('/api/sessions/:code/reveal', async (req, res) => {
  const session = getSessionOr404(req.params.code, res);
  if (!session) return;
  const pack = getPack(session);
  session.results = gradeAllPlayers(session);
  session.status = 'revealed';
  session.revealed = true;
  session.elapsedAtPause = computeElapsedSec(session);
  session.startedAt = null;
  addHostMessage(session, { title: 'Case Closed', text: pack.revealScript || 'Detectives, the case is closed.', kind: 'reveal' });
  await saveSession(session);
  res.json(clientState(session));
  broadcast(session.code);
});

app.post('/api/sessions/:code/reset', async (req, res) => {
  const session = getSessionOr404(req.params.code, res);
  if (!session) return;
  session.status = 'lobby';
  session.startedAt = null;
  session.elapsedAtPause = 0;
  session.players = new Map();
  normalizeAccessCodes(session).forEach(access => { access.claimed = false; access.playerId = ''; access.playerName = ''; access.firstName = ''; access.lastName = ''; access.instagram = ''; access.displayName = ''; access.claimedAt = null; });
  normalizeRsvps(session).forEach(rsvp => { rsvp.checkedIn = false; rsvp.playerId = ''; rsvp.updatedAt = Date.now(); });
  session.hostMessages = [];
  session.helpRequests = [];
  session.submissions = [];
  session.results = [];
  session.revealed = false;
  await saveSession(session);
  res.json(clientState(session));
  broadcast(session.code);
});

app.delete('/api/sessions/:code', async (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  sessions.delete(code);
  socketsBySession.get(code)?.forEach(ws => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'deleted', code }));
    try { ws.close(); } catch (_err) {}
  });
  socketsBySession.delete(code);
  try { await database.deleteSession(code); } catch (err) { console.error('Database delete failed:', err); }
  res.json({ ok: true, deleted: code });
});

app.post('/api/sessions/:code/message', async (req, res) => {
  const session = getSessionOr404(req.params.code, res);
  if (!session) return;
  const text = String(req.body.text || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'Message is required' });
  const title = String(req.body.title || 'Host Update').trim().slice(0, 120);
  const kind = String(req.body.kind || 'dialog').trim().slice(0, 40);
  addHostMessage(session, { title, text, kind });
  await saveSession(session);
  res.json(clientState(session));
  broadcast(session.code);
});

app.post('/api/sessions/:code/help', async (req, res) => {
  const session = getSessionOr404(req.params.code, res);
  if (!session) return;
  const playerId = String(req.body.playerId || '');
  const player = session.players.get(playerId);
  const text = String(req.body.text || 'Team needs help').trim().slice(0, 300);
  const help = { id: nanoid(8), playerId, playerName: player?.name || 'Unknown Detective', text, createdAt: Date.now(), status: 'open' };
  session.helpRequests.unshift(help);
  await saveSession(session);
  res.json({ ok: true, helpRequest: help, state: clientState(session) });
  broadcast(session.code);
});


app.post('/api/sessions/:code/answer', async (req, res) => {
  const session = getSessionOr404(req.params.code, res);
  if (!session) return;
  const phase = computePhase(session);
  if (phase === 'lobby' || phase === 'revealed') return res.status(409).json({ error: 'Answers are not open right now.' });
  const playerId = String(req.body.playerId || '');
  const player = session.players.get(playerId);
  if (!player) return res.status(404).json({ error: 'Player not found in this session.' });
  const pack = getPack(session);
  const elapsedSec = computeElapsedSec(session);
  const rawAnswers = req.body.answers || {};
  const answers = {};
  for (const q of (pack?.accusation?.questions || [])) {
    const selected = String(rawAnswers[q.id] || '').trim();
    const optionIds = new Set((q.options || []).map(o => o.id));
    const unlocked = elapsedSec >= getQuestionUnlockSec(q) || phase === 'accusation' || phase === 'accusation_locked';
    if (selected && optionIds.has(selected) && unlocked) answers[q.id] = selected;
  }
  if (!Object.keys(answers).length) return res.status(400).json({ error: 'No valid unlocked answer was submitted.' });
  const submission = upsertSubmission(session, {
    id: nanoid(8),
    playerId,
    playerName: player.name,
    answers,
    createdAt: Date.now(),
    updatedAt: Date.now()
  });
  await saveSession(session);
  res.json({ ok: true, submission, state: clientState(session) });
  broadcast(session.code);
});

app.post('/api/sessions/:code/accuse', async (req, res) => {
  const session = getSessionOr404(req.params.code, res);
  if (!session) return;
  const phase = computePhase(session);
  if (phase !== 'accusation') return res.status(409).json({ error: 'Final accusation is not open right now.' });
  const playerId = String(req.body.playerId || '');
  const player = session.players.get(playerId);
  if (!player) return res.status(404).json({ error: 'Player not found in this session.' });
  const pack = getPack(session);
  const questions = pack?.accusation?.questions || [];
  const existing = (session.submissions || []).find(s => s.playerId === playerId);
  const rawAnswers = { ...(existing?.answers || {}), ...(req.body.answers || {}) };
  const answers = {};
  const missing = [];
  for (const q of questions) {
    const selected = String(rawAnswers[q.id] || '').trim();
    const optionIds = new Set((q.options || []).map(o => o.id));
    if (selected && optionIds.has(selected)) answers[q.id] = selected;
    else missing.push(q.id);
  }
  if (questions.length && missing.length) {
    return res.status(400).json({ error: `Please answer all ${questions.length} mystery questions before submitting.` });
  }
  const submission = upsertSubmission(session, {
    id: nanoid(8),
    playerId,
    playerName: player.name,
    answers,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    finalSubmittedAt: Date.now()
  });
  submission.finalSubmittedAt = Date.now();
  await saveSession(session);
  res.json({ ok: true, submission, state: clientState(session) });
  broadcast(session.code);
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const code = String(url.searchParams.get('code') || '').toUpperCase();
  const playerId = String(url.searchParams.get('playerId') || '');
  if (!code || !sessions.has(code)) {
    ws.send(JSON.stringify({ type: 'error', error: 'Session not found' }));
    ws.close();
    return;
  }

  if (!socketsBySession.has(code)) socketsBySession.set(code, new Set());
  socketsBySession.get(code).add(ws);

  const session = sessions.get(code);
  if (playerId && session.players.has(playerId)) {
    const p = session.players.get(playerId);
    p.connected = true;
    p.lastSeen = Date.now();
    saveSession(session);
  }

  ws.send(JSON.stringify({ type: 'state', state: clientState(session) }));
  broadcast(code);

  ws.on('close', () => {
    socketsBySession.get(code)?.delete(ws);
    if (playerId && session.players.has(playerId)) {
      const p = session.players.get(playerId);
      p.connected = false;
      p.lastSeen = Date.now();
      saveSession(session);
      broadcast(code);
    }
  });
});

async function startServer() {
  await database.init();
  const loaded = await loadSessionsFromDatabase();

  server.listen(PORT, () => {
    console.log(`Detective Mode Mystery App running on port ${PORT}`);
    console.log(process.env.DATABASE_URL ? 'Database: PostgreSQL' : 'Database: local JSON file');
  });
}

process.on('SIGTERM', async () => {
  await database.close();
  process.exit(0);
});

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
