const $ = id => document.getElementById(id);
let sessions = [];
let packs = [];
let sockets = new Map();
let pollTimer = null;

$('createBtn').onclick = createSession;
$('refreshBtn').onclick = loadAll;

function api(path, options = {}) {
  return fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  }).then(async res => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  });
}

async function loadAll() {
  packs = await api('/api/truth-packs');
  $('truthPackSelect').innerHTML = packs.map(p => `<option value="${p.id}" ${p.id === 'heresay-homicide-training' ? 'selected' : ''}>${escapeHtml(p.gameTitle || 'Heresay Homicide')} — ${escapeHtml(p.levelLabel || p.difficulty || p.title)}</option>`).join('');
  sessions = await api('/api/sessions');
  sessions.forEach(s => connectSocket(s.sessionCode));
  render();
}

async function createSession() {
  const tableName = $('tableName').value.trim() || 'Table';
  const truthPackId = $('truthPackSelect').value || 'heresay-homicide-training';
  const playerCap = Math.max(1, Math.min(100, Number($('playerCap')?.value || 25)));
  const state = await api('/api/sessions', { method: 'POST', body: { tableName, truthPackId, playerCap } });
  upsertSession(state);
  connectSocket(state.sessionCode);
  render();
}

function connectSocket(code) {
  if (sockets.has(code)) return;
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${protocol}://${location.host}?code=${encodeURIComponent(code)}`);
  sockets.set(code, ws);
  ws.onmessage = evt => {
    const msg = JSON.parse(evt.data);
    if (msg.type === 'state') {
      upsertSession(msg.state);
      render();
    }
  };
  ws.onclose = () => {
    sockets.delete(code);
    setTimeout(() => connectSocket(code), 3000);
  };
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      sessions = await api('/api/sessions');
      sessions.forEach(s => connectSocket(s.sessionCode));
      render();
    } catch (_err) {}
  }, 5000);
}

function upsertSession(state) {
  const i = sessions.findIndex(s => s.sessionCode === state.sessionCode);
  if (i >= 0) sessions[i] = { ...sessions[i], ...state, accessCodes: state.accessCodes || sessions[i].accessCodes || [] };
  else sessions.unshift(state);
}

function fmt(sec) {
  sec = Math.max(0, Number(sec || 0));
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function phaseLabel(phase) {
  return ({ lobby: 'Lobby', investigation: 'Investigation', accusation: 'Accusation Open', accusation_locked: 'Accusation Locked', revealed: 'Revealed' })[phase] || phase;
}
function instagramText(value) {
  return value ? escapeHtml(value) : '<span class="muted">Not provided</span>';
}

function fullPlayerName(item) {
  const first = item.firstName || '';
  const last = item.lastName || '';
  const full = `${first} ${last}`.trim();
  return full || item.fullName || item.playerName || item.name || 'Detective';
}


function render() {
  $('tables').innerHTML = sessions.length ? sessions.map(tableHtml).join('') : '<p class="muted">No table sessions yet.</p>';
}

function resultHtml(results = []) {
  if (!results.length) return '<p class="muted">No graded results yet.</p>';
  return results.slice(0, 6).map(r => `<div class="feedItem"><div class="time">${escapeHtml(r.badge)}</div><h4>${escapeHtml(r.playerName)}</h4><p><b>Score:</b> ${r.score}/${r.total}</p></div>`).join('');
}

function submissionHtml(submissions = [], accusation) {
  const questions = accusation?.questions || [];
  if (!submissions.length) return '<p class="muted">No submissions yet.</p>';
  return submissions.slice(0, 4).map(sub => {
    const lines = questions.map(q => {
      const option = (q.options || []).find(opt => opt.id === sub.answers?.[q.id]);
      return `<b>${escapeHtml(q.prompt)}</b><br>${escapeHtml(option?.label || 'No answer')}`;
    }).join('<br><br>');
    return `<div class="feedItem"><div class="time">${new Date(sub.createdAt).toLocaleTimeString()}</div><h4>${escapeHtml(sub.playerName)}</h4><p>${lines}</p></div>`;
  }).join('');
}



function rsvpHtml(s) {
  const rsvps = s.rsvps || [];
  if (!rsvps.length) return '<p class="muted">No RSVPs yet. Players can RSVP from the public player page without the host dashboard being open.</p>';
  const rows = rsvps.map(item => {
    const code = item.accessCode || '';
    const checked = item.checkedIn ? 'Checked In' : 'Not Checked In';
    const paidText = item.paid ? 'Paid' : 'Unpaid';
    return `<tr>
      <td>${escapeHtml(item.firstName || '—')}</td>
      <td>${escapeHtml(item.lastName || '—')}</td>
      <td>${instagramText(item.instagram || '')}</td>
      <td>${escapeHtml(item.contact || '—')}</td>
      <td>${escapeHtml(checked)}</td>
      <td>${code ? `<button class="secondary codeButton" onclick="copyText('${escapeHtml(code)}')">${escapeHtml(code)}</button>` : '<span class="muted">Not assigned</span>'}</td>
      <td><button class="secondary compact" onclick="toggleRsvpPaid('${s.sessionCode}','${escapeHtml(item.id)}',${item.paid ? 'false' : 'true'})">${paidText}</button></td>
      <td><button class="secondary compact" onclick="assignRsvpCode('${s.sessionCode}','${escapeHtml(item.id)}')">Assign Code</button></td>
    </tr>`;
  }).join('');
  return `<div class="tableScroll"><table class="codeTable"><thead><tr><th>First</th><th>Last</th><th>Instagram</th><th>Contact</th><th>Check-In</th><th>Code</th><th>Paid</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function accessCodeHtml(s) {
  const codes = s.accessCodes || [];
  if (!codes.length) return '<p class="muted">No access codes generated for this session.</p>';
  const rows = codes.map(item => {
    const status = item.claimed ? 'Claimed' : 'Unused';
    const paidText = item.paid ? 'Paid' : 'Unpaid';
    const firstName = item.firstName || '';
    const lastName = item.lastName || '';
    return `<tr>
      <td><button class="secondary codeButton" onclick="copyText('${escapeHtml(item.code)}')">${escapeHtml(item.code)}</button></td>
      <td>${escapeHtml(status)}</td>
      <td>${escapeHtml(firstName || '—')}</td>
      <td>${escapeHtml(lastName || '—')}</td>
      <td>${instagramText(item.instagram || '')}</td>
      <td><button class="secondary compact" onclick="togglePaid('${s.sessionCode}','${escapeHtml(item.code)}',${item.paid ? 'false' : 'true'})">${paidText}</button></td>
    </tr>`;
  }).join('');
  return `<div class="codeTools"><button class="secondary" onclick="copyAllCodes('${s.sessionCode}')">Copy All Codes</button></div><div class="tableScroll"><table class="codeTable"><thead><tr><th>Access Code</th><th>Status</th><th>First</th><th>Last</th><th>Instagram</th><th>Paid</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function tableHtml(s) {
  const playerList = s.players.length ? s.players.map(p => `<span class="pill ${p.connected ? 'good' : ''}">${escapeHtml(fullPlayerName(p))}${p.instagram ? ` · ${escapeHtml(p.instagram)}` : ''} ${p.connected ? '●' : '○'}</span>`).join(' ') : '<span class="muted">No players connected.</span>';
  const help = (s.helpRequests || []).slice(0, 4).map(h => `<div class="feedItem"><div class="time">${new Date(h.createdAt).toLocaleTimeString()}</div><h4>${escapeHtml(h.playerName)}</h4><p>${escapeHtml(h.text)}</p></div>`).join('') || '<p class="muted">No help requests.</p>';
  const messages = (s.hostMessages || []).slice(-3).reverse().map(m => `<div class="feedItem hostMsg"><div class="time">${new Date(m.createdAt).toLocaleTimeString()}</div><h4>${escapeHtml(m.title || 'Host')}</h4><p>${escapeHtml(m.text)}</p></div>`).join('') || '<p class="muted">No host dialogue sent yet.</p>';
  const playerUrl = `${location.origin}/player/`;
  const roundHtml = (s.rounds || []).map(r => {
    const cls = s.currentRound?.id === r.id ? 'roundNode active' : (s.elapsedSec >= r.endSec ? 'roundNode done' : 'roundNode');
    return `<div class="${cls}"><b>${escapeHtml(r.shortTitle || r.title)}</b><small>${fmt(r.startSec)} - ${fmt(r.endSec)}</small></div>`;
  }).join('');
  const currentScript = s.currentRound?.dialogue || 'Start the game to begin the hosted narration flow.';
  const openingScript = s.openingNarration || 'No opening narration loaded.';
  const revealScript = s.revealScript || 'No reveal script loaded.';
  return `
    <article class="tableCard">
      <div class="row">
        <div>
          <h3>${escapeHtml(s.tableName)} · ${escapeHtml(s.sessionCode)}</h3>
          <p class="mini">${escapeHtml(s.truthPackTitle)} · ${escapeHtml(s.difficultyLabel || s.difficulty || '')} · Story Mode · Unified Evidence</p>
        </div>
        <div class="statusPills">
          <span class="pill">${phaseLabel(s.phase)}</span>
          <span class="pill">${s.currentRound ? escapeHtml(s.currentRound.title) : 'No Round Yet'}</span>
          <span class="pill good">Left ${fmt(s.remainingSec)}</span>
          <span class="pill">Elapsed ${fmt(s.elapsedSec)}</span>
          <span class="pill">${s.players.length} Detectives</span>
          <span class="pill">Codes ${s.access?.used || 0}/${s.access?.playerCap || s.playerCap || 25}</span>
          <span class="pill">RSVP ${s.rsvp?.total || 0}</span>
        </div>
      </div>
      <label>Player Join URL</label>
      <input readonly value="${playerUrl}" onclick="this.select();navigator.clipboard?.writeText(this.value)" />
      <div class="actions" style="margin-top:12px">
        <button class="good" onclick="startTable('${s.sessionCode}')">Start</button>
        <button class="secondary" onclick="sendOpeningNarration('${s.sessionCode}')">Opening Popup</button>
        <button class="secondary" onclick="sendRoundDialogue('${s.sessionCode}')">Round Popup</button>
        <button class="secondary" onclick="sendHostMessage('${s.sessionCode}')">Custom Popup</button>
        <button class="danger" onclick="revealCase('${s.sessionCode}')">Reveal Case</button>
        <button class="secondary" onclick="resetTable('${s.sessionCode}')">Reset Session</button>
        <button class="danger" onclick="deleteSession('${s.sessionCode}')">Delete Session</button>
      </div>
      <div class="card" style="box-shadow:none">
        <h3>Testing Controls</h3>
        <div class="actions compactButtons">
          <button class="secondary" onclick="jumpToRound('${s.sessionCode}', 1)">Body</button>
          <button class="secondary" onclick="jumpToRound('${s.sessionCode}', 2)">Timeline</button>
          <button class="secondary" onclick="jumpToRound('${s.sessionCode}', 3)">Digital</button>
          <button class="secondary" onclick="jumpToRound('${s.sessionCode}', 4)">Money</button>
          <button class="secondary" onclick="jumpToRound('${s.sessionCode}', 5)">Cover-Up</button>
          <button class="secondary" onclick="jumpToRound('${s.sessionCode}', 6)">Accuse</button>
          <button class="secondary" onclick="shiftTime('${s.sessionCode}', -60)">-1m</button>
          <button class="secondary" onclick="shiftTime('${s.sessionCode}', 60)">+1m</button>
          <button class="secondary" onclick="shiftTime('${s.sessionCode}', 300)">+5m</button>
        </div>
      </div>
      <div class="card" style="box-shadow:none">
        <h3>Round Structure</h3>
        <p class="mini">Current objective: ${escapeHtml(s.currentRound?.objective || 'Waiting to start the case.')}</p>
        <div class="timeline">${roundHtml}</div>
      </div>
      <div class="grid">
        <div class="card" style="box-shadow:none">
          <h3>Current Host Script</h3>
          <div class="feedItem"><div class="time">Current Round</div><p>${escapeHtml(currentScript)}</p></div>
          <div class="feedItem"><div class="time">Opening</div><p>${escapeHtml(openingScript)}</p></div>
          <div class="feedItem"><div class="time">Reveal</div><p>${escapeHtml(revealScript)}</p></div>
        </div>
        <div class="card" style="box-shadow:none">
          <h3>Connected Detectives</h3>
          <div>${playerList}</div>
          <h3 style="margin-top:14px">Host Dialogue Log</h3>
          ${messages}
        </div>
      </div>
      <div class="card" style="box-shadow:none"><h3>RSVP List</h3><p class="mini">Each RSVP equals one player spot. RSVPs save to the database even when the host dashboard is closed. Mark paid and assign an access code after payment.</p>${rsvpHtml(s)}</div>
      <div class="card" style="box-shadow:none"><h3>Paid Player Access Codes</h3><p class="mini">Give one code to each paid player. Each code can be claimed once.</p>${accessCodeHtml(s)}</div>
      <div class="grid">
        <div class="card" style="box-shadow:none"><h3>Help Requests</h3>${help}</div>
        <div class="card" style="box-shadow:none"><h3>Accusations</h3>${submissionHtml(s.submissions, s.accusation)}</div>
      </div>
      <div class="card" style="box-shadow:none"><h3>Graded Results</h3>${resultHtml(s.results)}</div>
    </article>`;
}

window.startTable = async code => {
  await api(`/api/sessions/${code}/start`, { method: 'POST' });
  const session = sessions.find(s => s.sessionCode === code);
  await api(`/api/sessions/${code}/message`, {
    method: 'POST',
    body: { title: 'Opening Briefing', text: session?.openingNarration || 'Detectives, the case is beginning.', kind: 'opening' }
  });
};
window.resetTable = async code => {
  if (confirm('Reset this table? This will clear players, answers, messages, results, timer state, and activity.')) await api(`/api/sessions/${code}/reset`, { method: 'POST' });
};
window.deleteSession = async code => {
  if (!confirm('Delete this session permanently? This removes the join code, players, messages, answers, results, and all saved activity.')) return;
  await api(`/api/sessions/${code}`, { method: 'DELETE' });
  sessions = sessions.filter(s => s.sessionCode !== code);
  render();
};
window.revealCase = async code => { await api(`/api/sessions/${code}/reveal`, { method: 'POST' }); };
window.sendHostMessage = async code => {
  const text = prompt('Host dialogue popup text:');
  if (!text) return;
  const title = prompt('Popup title:', 'Host Update');
  await api(`/api/sessions/${code}/message`, { method: 'POST', body: { title: title || 'Host Update', text, kind: 'dialog' } });
};
window.sendRoundDialogue = async code => {
  const session = sessions.find(s => s.sessionCode === code);
  if (!session?.currentRound) return alert('No active round is available yet. Start the game first.');
  await api(`/api/sessions/${code}/message`, {
    method: 'POST',
    body: { title: session.currentRound.title, text: session.currentRound.dialogue || session.currentRound.objective || 'Review the newly unlocked evidence.', kind: 'dialog' }
  });
};
window.sendOpeningNarration = async code => {
  const session = sessions.find(s => s.sessionCode === code);
  await api(`/api/sessions/${code}/message`, {
    method: 'POST',
    body: { title: 'Opening Briefing', text: session?.openingNarration || 'Detectives, the case is beginning.', kind: 'opening' }
  });
};
window.jumpToRound = async (code, n) => {
  const session = sessions.find(s => s.sessionCode === code);
  const round = session?.rounds?.[n - 1];
  if (!round) return;
  await api(`/api/sessions/${code}/set-elapsed`, { method: 'POST', body: { elapsedSec: round.startSec, pushRoundPopup: true } });
};
window.shiftTime = async (code, delta) => {
  const session = sessions.find(s => s.sessionCode === code);
  const elapsed = Math.max(0, Math.min(session.totalSec, Number(session.elapsedSec || 0) + Number(delta || 0)));
  await api(`/api/sessions/${code}/set-elapsed`, { method: 'POST', body: { elapsedSec: elapsed } });
};


window.copyText = async text => {
  try { await navigator.clipboard.writeText(text); } catch (_err) {}
};
window.copyAllCodes = async code => {
  const session = sessions.find(s => s.sessionCode === code);
  const lines = (session?.accessCodes || []).map(item => `${item.code}${item.paid ? ' - Paid' : ' - Unpaid'}${item.claimed ? ` - ${fullPlayerName(item)}${item.instagram ? ` - ${item.instagram}` : ''}` : ''}`);
  try { await navigator.clipboard.writeText(lines.join('\n')); alert('Access codes copied.'); } catch (_err) { alert(lines.join('\n')); }
};
window.togglePaid = async (sessionCode, accessCode, paid) => {
  const state = await api(`/api/sessions/${sessionCode}/access-codes/${accessCode}/paid`, { method: 'POST', body: { paid } });
  upsertSession(state);
  render();
};


window.toggleRsvpPaid = async (sessionCode, rsvpId, paid) => {
  const state = await api(`/api/sessions/${sessionCode}/rsvps/${rsvpId}/paid`, { method: 'POST', body: { paid } });
  upsertSession(state);
  render();
};
window.assignRsvpCode = async (sessionCode, rsvpId) => {
  const state = await api(`/api/sessions/${sessionCode}/rsvps/${rsvpId}/assign-code`, { method: 'POST', body: {} });
  upsertSession(state);
  render();
};

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

loadAll();
startPolling();
