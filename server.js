// Quiz ao vivo – Ouro Safra
// Servidor em tempo real: Express + Socket.io. Todo o estado fica em memória.
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const HOST_PIN = String(process.env.HOST_PIN || '1234');
const QUESTIONS_FILE = process.env.QUESTIONS_FILE || path.join(__dirname, 'perguntas.json');
const MAX_POINTS = 1000;
const LIVE_BATCH_MS = 150; // agrupa respostas para o telão não engasgar com centenas simultâneas

const app = express();
app.set('trust proxy', true);
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 20000 });

// ---------- Perguntas ----------
function loadQuestions() {
  const raw = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.perguntas;
  return list.map((q, i) => {
    if (!q.pergunta || !Array.isArray(q.alternativas) || q.alternativas.length < 2 || q.alternativas.length > 4)
      throw new Error(`Pergunta ${i + 1}: precisa de "pergunta" e de 2 a 4 "alternativas".`);
    const correta = Number(q.correta);
    if (!(correta >= 0 && correta < q.alternativas.length))
      throw new Error(`Pergunta ${i + 1}: "correta" deve ser o índice (0 a ${q.alternativas.length - 1}).`);
    return { pergunta: String(q.pergunta), alternativas: q.alternativas.map(String), correta, tempo: Number(q.tempo) || 20 };
  });
}
let QUESTIONS = loadQuestions();
console.log(`${QUESTIONS.length} perguntas carregadas de ${path.basename(QUESTIONS_FILE)}`);

// ---------- Estado do jogo ----------
// fases: lobby → question → reveal → ranking → (question ...) → final
const game = {
  phase: 'lobby',
  qIndex: -1,
  qStartedAt: 0,
  qEndsAt: 0,
  timer: null,
  players: new Map(), // token -> {token,id,nome,empresa,score,streak,answers:[], socketId, online}
  answers: new Map(), // token -> {choice, points, correct, ms}
};

const clean = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
// Enquanto a pergunta está aberta, ninguém vê os pontos da rodada (nem no telão nem no celular):
// a pontuação exibida é a de antes da pergunta, até o tempo acabar.
function rodada(p) { const a = game.answers.get(p.token); return a ? a : null; }
function visivel(p) {
  const a = game.phase === 'question' ? rodada(p) : null;
  return { score: p.score - (a ? a.points : 0), ms: p.totalMs - (a ? a.ms : 0) };
}
const publicPlayer = (p) => ({ id: p.id, nome: p.nome, empresa: p.empresa, score: visivel(p).score });

// O ranking é calculado uma vez e reaproveitado (antes era recalculado para cada jogador,
// o que pesava com centenas de pessoas). É invalidado quando algo que o altera muda.
let rankCache = null;
function invalidarRanking() { rankCache = null; }
function calcRanking() {
  const list = [...game.players.values()]
    .map((p) => ({ p, v: visivel(p) }))
    .sort((a, b) => b.v.score - a.v.score || a.v.ms - b.v.ms || a.p.joinedAt - b.p.joinedAt)
    .map(({ p }, i) => {
      const a = game.phase === 'question' ? null : rodada(p);
      return { ...publicPlayer(p), pos: i + 1, rodada: a ? a.points : 0, respondeu: !!a };
    });
  return { list, pos: new Map(list.map((x) => [x.id, x.pos])) };
}
function ranking() { if (!rankCache) rankCache = calcRanking(); return rankCache.list; }

function positionOf(token) {
  const p = game.players.get(token);
  if (!p) return 0;
  ranking();
  return rankCache.pos.get(p.id) || 0;
}

function currentQuestionPublic() {
  const q = QUESTIONS[game.qIndex];
  if (!q) return null;
  return {
    index: game.qIndex, total: QUESTIONS.length, pergunta: q.pergunta,
    alternativas: q.alternativas, tempo: q.tempo, endsAt: game.qEndsAt, serverNow: Date.now(),
  };
}

function distribution() {
  const q = QUESTIONS[game.qIndex];
  const d = q ? q.alternativas.map(() => 0) : [];
  for (const a of game.answers.values()) if (d[a.choice] !== undefined) d[a.choice]++;
  return d;
}

function hostState() {
  return {
    phase: game.phase,
    question: currentQuestionPublic(),
    correta: game.phase === 'question' ? null : QUESTIONS[game.qIndex]?.correta ?? null,
    distribution: game.phase === 'question' ? null : distribution(),
    answered: game.answers.size,
    playersCount: game.players.size,
    onlineCount: [...game.players.values()].filter((p) => p.online).length,
    players: [...game.players.values()].map(publicPlayer),
    ranking: ranking(),
    totalQuestions: QUESTIONS.length,
  };
}

function playerState(token) {
  const p = game.players.get(token);
  if (!p) return { phase: 'register' };
  const a = game.answers.get(token);
  const base = {
    phase: game.phase, me: publicPlayer(p), pos: positionOf(token), totalPlayers: game.players.size,
    totalQuestions: QUESTIONS.length,
  };
  if (game.phase === 'question') {
    const q = currentQuestionPublic();
    return { ...base, question: q, answered: !!a, choice: a ? a.choice : null };
  }
  if (game.phase === 'reveal' || game.phase === 'ranking') {
    return {
      ...base, question: currentQuestionPublic(), answered: !!a,
      choice: a ? a.choice : null, correct: a ? a.correct : false, points: a ? a.points : 0,
      correta: QUESTIONS[game.qIndex].correta, streak: p.streak,
    };
  }
  return base;
}

function broadcastHost() { clearTimeout(hostTimer); hostTimer = null; io.to('hosts').emit('host:state', hostState()); }
// Entradas/saídas de jogadores são agrupadas: no máximo uma atualização do telão a cada 300 ms
let hostTimer = null;
function agendarHost() { if (!hostTimer) hostTimer = setTimeout(broadcastHost, 300); }
function sendPlayer(p) { if (p.socketId) io.to(p.socketId).emit('player:state', playerState(p.token)); }
function broadcastPlayers() { for (const p of game.players.values()) sendPlayer(p); }
function broadcastAll() { invalidarRanking(); broadcastHost(); broadcastPlayers(); }

// Fila de respostas ao vivo para o telão (batch)
let liveQueue = [];
let liveTimer = null;
function pushLive(evt) {
  liveQueue.push(evt);
  if (!liveTimer) liveTimer = setTimeout(flushLive, LIVE_BATCH_MS);
}
function flushLive() {
  liveTimer = null;
  if (!liveQueue.length) return;
  const events = liveQueue; liveQueue = [];
  io.to('hosts').emit('host:live', {
    events, answered: game.answers.size, playersCount: game.players.size,
  });
}

// ---------- Fluxo ----------
function startQuestion(index) {
  clearTimeout(game.timer);
  if (index >= QUESTIONS.length) return finish();
  game.qIndex = index;
  game.phase = 'question';
  game.answers = new Map();
  const q = QUESTIONS[index];
  game.qStartedAt = Date.now() + 600; // pequena margem para a pergunta aparecer em todas as telas
  game.qEndsAt = game.qStartedAt + q.tempo * 1000;
  game.timer = setTimeout(endQuestion, game.qEndsAt - Date.now() + 300);
  broadcastAll();
}

function endQuestion() {
  if (game.phase !== 'question') return;
  clearTimeout(game.timer);
  flushLive();
  // quem não respondeu perde a sequência
  for (const p of game.players.values()) if (!game.answers.has(p.token)) p.streak = 0;
  game.phase = 'reveal';
  broadcastAll();
}

function showRanking() { game.phase = 'ranking'; broadcastAll(); }
function finish() { clearTimeout(game.timer); game.phase = 'final'; broadcastAll(); }

function next() {
  if (game.phase === 'lobby') return startQuestion(0);
  if (game.phase === 'question') return endQuestion();
  if (game.phase === 'reveal') return showRanking();
  if (game.phase === 'ranking') return game.qIndex + 1 >= QUESTIONS.length ? finish() : startQuestion(game.qIndex + 1);
}

function reset(keepPlayers) {
  clearTimeout(game.timer);
  try { QUESTIONS = loadQuestions(); } catch (e) { console.error(e.message); }
  game.phase = 'lobby'; game.qIndex = -1; game.answers = new Map();
  if (keepPlayers) for (const p of game.players.values()) { p.score = 0; p.streak = 0; p.totalMs = 0; p.history = []; }
  else {
    for (const p of game.players.values()) if (p.socketId) io.to(p.socketId).emit('player:reset');
    game.players.clear();
  }
  broadcastAll();
}

function answer(token, choice) {
  if (game.phase !== 'question') return { ok: false, msg: 'Tempo encerrado' };
  const p = game.players.get(token);
  if (!p) return { ok: false, msg: 'Participante não encontrado' };
  if (game.answers.has(token)) return { ok: false, msg: 'Você já respondeu' };
  const q = QUESTIONS[game.qIndex];
  choice = Number(choice);
  if (!(choice >= 0 && choice < q.alternativas.length)) return { ok: false, msg: 'Alternativa inválida' };
  const now = Date.now();
  if (now > game.qEndsAt + 250) return { ok: false, msg: 'Tempo encerrado' };
  const ms = Math.max(0, now - game.qStartedAt);
  const correct = choice === q.correta;
  // Estilo Kahoot: acerto instantâneo = 1000, no último segundo ≈ 500. Erro = 0.
  const frac = Math.min(1, ms / (q.tempo * 1000));
  const points = correct ? Math.round(MAX_POINTS * (1 - frac / 2)) : 0;
  game.answers.set(token, { choice, points, correct, ms });
  p.score += points;
  p.totalMs += ms;
  p.streak = correct ? p.streak + 1 : 0;
  p.history[game.qIndex] = { choice, correct, points, ms };
  pushLive({ id: p.id, nome: p.nome, empresa: p.empresa, ms }); // sem pontos nem acerto: só revela no fim do tempo
  // todos responderam? encerra antes do tempo
  const online = [...game.players.values()].filter((x) => x.online).length;
  if (game.answers.size >= Math.max(1, online)) setTimeout(endQuestion, 800);
  return { ok: true };
}

// ---------- Socket.io ----------
io.on('connection', (socket) => {
  // ---- Telão: qualquer um pode assistir (QR Code, perguntas, ranking); comandos exigem PIN
  socket.on('host:watch', () => { socket.join('hosts'); socket.emit('host:state', hostState()); });
  // ---- Apresentador (telão)
  socket.on('host:auth', (pin, cb) => {
    if (String(pin) !== HOST_PIN) return cb && cb({ ok: false });
    socket.data.host = true;
    socket.join('hosts');
    cb && cb({ ok: true });
    socket.emit('host:state', hostState());
  });
  const hostOnly = (fn) => (...args) => { if (socket.data.host) fn(...args); };
  socket.on('host:next', hostOnly(() => next()));
  socket.on('host:end', hostOnly(() => endQuestion()));
  socket.on('host:finish', hostOnly(() => finish()));
  socket.on('host:reset', hostOnly((keep) => reset(!!keep)));
  socket.on('host:kick', hostOnly((id) => {
    for (const [t, p] of game.players) if (p.id === id) {
      if (p.socketId) io.to(p.socketId).emit('player:reset');
      game.players.delete(t);
    }
    invalidarRanking();
    broadcastHost();
  }));

  // ---- Participante
  socket.on('player:resume', (token, cb) => {
    const p = game.players.get(String(token || ''));
    if (!p) return cb && cb({ ok: false });
    p.socketId = socket.id; p.online = true; socket.data.token = p.token;
    cb && cb({ ok: true });
    sendPlayer(p);
    agendarHost();
  });

  socket.on('player:join', (data, cb) => {
    const nome = clean(data && data.nome, 40);
    const empresa = clean(data && data.empresa, 60);
    if (nome.length < 2) return cb && cb({ ok: false, msg: 'Informe seu nome.' });
    if (empresa.length < 2) return cb && cb({ ok: false, msg: 'Informe sua empresa / filial.' });
    if (game.phase === 'final') return cb && cb({ ok: false, msg: 'O quiz já terminou.' });
    const token = crypto.randomBytes(16).toString('hex');
    const p = {
      token, id: crypto.randomBytes(6).toString('hex'), nome, empresa, score: 0, streak: 0, totalMs: 0,
      history: [], joinedAt: Date.now(), socketId: socket.id, online: true,
    };
    game.players.set(token, p);
    invalidarRanking();
    socket.data.token = token;
    cb && cb({ ok: true, token });
    sendPlayer(p);
    agendarHost();
  });

  socket.on('player:answer', (choice, cb) => {
    const res = answer(socket.data.token, choice);
    cb && cb(res);
    const p = game.players.get(socket.data.token);
    if (p && res.ok) sendPlayer(p);
  });

  socket.on('disconnect', () => {
    const p = game.players.get(socket.data.token);
    if (p && p.socketId === socket.id) { p.online = false; p.socketId = null; agendarHost(); }
  });
});

// ---------- HTTP ----------
// Endereço principal = telão com o QR Code. O QR Code leva o celular para /jogar.
app.get(['/', '/telao'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'telao.html')));
app.get('/jogar', (req, res) => res.sendFile(path.join(__dirname, 'public', 'jogar.html')));
function joinUrl(req) {
  const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  return base + '/jogar';
}

app.get('/qr.svg', async (req, res) => {
  const url = joinUrl(req);
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#2B2118', light: '#FFFFFF' } });
  res.type('image/svg+xml').send(svg);
});
app.get('/join-url', (req, res) => res.json({ url: joinUrl(req) }));

// Logo: coloque public/logo.png (ou .svg) para usar o logo oficial
app.get('/logo', (req, res) => {
  for (const f of ['logo.svg', 'logo.png', 'logo.jpg', 'logo.webp']) {
    const p = path.join(__dirname, 'public', f);
    if (fs.existsSync(p)) return res.sendFile(p);
  }
  res.status(404).end();
});

// Resultados em CSV (abre no Excel). Ex.: /resultados.csv?pin=1234
app.get('/resultados.csv', (req, res) => {
  if (String(req.query.pin) !== HOST_PIN) return res.status(403).send('PIN inválido');
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Posição', 'Nome', 'Empresa/Filial', 'Pontuação', 'Acertos'];
  QUESTIONS.forEach((_, i) => head.push(`P${i + 1} resposta`, `P${i + 1} acertou`, `P${i + 1} pontos`, `P${i + 1} tempo (s)`));
  const rows = [head.map(esc).join(';')];
  const r = ranking();
  for (const item of r) {
    const p = [...game.players.values()].find((x) => x.id === item.id);
    const acertos = p.history.filter((h) => h && h.correct).length;
    const row = [item.pos, p.nome, p.empresa, p.score, acertos];
    QUESTIONS.forEach((q, i) => {
      const h = p.history[i];
      row.push(h ? String.fromCharCode(65 + h.choice) : '', h ? (h.correct ? 'Sim' : 'Não') : '', h ? h.points : 0, h ? (h.ms / 1000).toFixed(1).replace('.', ',') : '');
    });
    rows.push(row.map(esc).join(';'));
  }
  res.setHeader('Content-Disposition', 'attachment; filename="resultados-quiz.csv"');
  res.type('text/csv; charset=utf-8').send('﻿' + rows.join('\r\n'));
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.get('/healthz', (req, res) => res.send('ok'));

server.listen(PORT, () => {
  console.log(`Quiz rodando na porta ${PORT}`);
  console.log(`  Telão (QR Code): http://localhost:${PORT}/   (PIN ${HOST_PIN === '1234' ? '1234 — troque com HOST_PIN' : 'definido'})`);
  console.log(`  Participantes:   http://localhost:${PORT}/jogar`);
});
