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

// ---------- Segurança: limites e identificação do cliente ----------
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS || 2000); // participantes cadastrados
const MAX_CONN = Number(process.env.MAX_CONN || 2500);       // conexões simultâneas no total
const MAX_POR_IP = Number(process.env.MAX_POR_IP || 700);    // por IP (no evento, todos no mesmo Wi-Fi saem pelo mesmo IP)
const MAX_ESPECTADORES = 30;                                  // telas assistindo ao telão sem PIN
// IP real do cliente. No Render, o X-Forwarded-For pode ser falsificado (o Render só acrescenta ao fim);
// o IP confiável vem do Cloudflare, que fica na frente do Render: True-Client-IP / CF-Connecting-IP.
const IP_HEADER = String(process.env.IP_HEADER || (process.env.RENDER ? 'true-client-ip' : '')).toLowerCase();
function ipReal(headers, addr) {
  if (IP_HEADER) {
    const v = headers[IP_HEADER] || headers['cf-connecting-ip'];
    if (v) return String(v).split(',')[0].trim();
  }
  return String(addr || '').replace(/^::ffff:/, '');
}
const conexoesPorIp = new Map();
let espectadores = 0;

const app = express();
app.set('trust proxy', true); // usado só para saber se o acesso é https (link do QR Code)
app.disable('x-powered-by');
app.use((req, res, next) => {
  const host = String(req.headers.host || '').replace(/[^\w.:-]/g, '');
  res.set({
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
      `img-src 'self' data:; connect-src 'self' wss://${host} ws://${host}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
  });
  next();
});
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 10000, pingTimeout: 20000,
  maxHttpBufferSize: 16 * 1024, // nenhuma mensagem legítima passa de poucos KB
  allowRequest: (req, cb) => {
    // recusa conexões abertas por páginas de outros sites (impede usar visitantes de um site como "robôs")
    const origin = req.headers.origin;
    if (origin) {
      let h = ''; try { h = new URL(origin).host; } catch (e) { /* origem inválida */ }
      if (![req.headers.host, req.headers['x-forwarded-host']].filter(Boolean).includes(h)) return cb(null, false);
    }
    if (io.engine.clientsCount >= MAX_CONN) return cb(null, false);
    if ((conexoesPorIp.get(ipReal(req.headers, req.socket.remoteAddress)) || 0) >= MAX_POR_IP) return cb(null, false);
    cb(null, true);
  },
});

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
  entradaAberta: true,
};

// Qualquer cliente pode mandar mensagens malformadas: nunca deixar isso derrubar o servidor
const ack = (cb, v) => { if (typeof cb === 'function') cb(v); };
process.on('uncaughtException', (e) => console.error('Erro não tratado (servidor segue no ar):', e));
process.on('unhandledRejection', (e) => console.error('Promessa rejeitada (servidor segue no ar):', e));

// PIN: após 5 erros seguidos, o IP fica bloqueado por 60 s
const iguais = (a, b) => crypto.timingSafeEqual(
  crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());
const tentativas = new Map(); // ip -> {erros, ate}
function pinOk(ip, pin) {
  const t = tentativas.get(ip) || { erros: 0, ate: 0 };
  if (Date.now() < t.ate) return false;
  if (iguais(pin, HOST_PIN)) { tentativas.delete(ip); return true; }
  t.erros++;
  if (t.erros >= 5) { t.erros = 0; t.ate = Date.now() + 60000; }
  tentativas.set(ip, t);
  return false;
}
setInterval(() => { const agora = Date.now(); for (const [k, t] of tentativas) if (t.ate < agora && t.erros === 0) tentativas.delete(k); }, 600000).unref();
const PIN_FRACO = HOST_PIN.length < 6 || /^(.)\1+$/.test(HOST_PIN) ||
  ['123456', '654321', '12345678', '123123', 'senha', 'admin', 'ourosafra'].includes(HOST_PIN.toLowerCase());
if (PIN_FRACO) console.warn('ATENÇÃO: HOST_PIN fraco. Use 6 ou mais caracteres, sem sequências óbvias.');
// Link dos resultados: código aleatório entregue só ao apresentador (o PIN não aparece na URL)
const CSV_TOKEN = crypto.randomBytes(16).toString('hex');

// Nomes: remove caracteres invisíveis e de controle, inversão de texto (RTL) e acentos empilhados ("zalgo")
function limparTexto(v, max) {
  const t = String(v ?? '').slice(0, 500).normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu, '')
    .replace(/(\p{M}{2})\p{M}+/gu, '$1')
    .replace(/\s+/g, ' ').trim();
  return Array.from(t).slice(0, max).join('').trim();
}
const letras = (t) => (t.match(/[\p{L}\p{N}]/gu) || []).length;
// Filtro básico de palavrões (o apresentador também pode remover nomes pelo telão)
const PROIBIDAS = ['porra', 'caralho', 'buceta', 'boceta', 'puta', 'puto', 'putinha', 'merda', 'foda', 'foder', 'fodase',
  'fdp', 'pqp', 'vsf', 'tnc', 'kct', 'cacete', 'viado', 'cuzao', 'arrombado', 'arrombada', 'otario', 'otaria',
  'vagabundo', 'vagabunda', 'desgraca', 'desgracado', 'piroca', 'xoxota', 'bosta', 'corno', 'babaca', 'retardado',
  'imbecil', 'idiota', 'nazista', 'hitler', 'safado', 'safada', 'piranha', 'rapariga'];
function ofensivo(t) {
  const n = t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/0/g, 'o').replace(/[1!|]/g, 'i').replace(/3/g, 'e').replace(/[4@]/g, 'a').replace(/[5$]/g, 's').replace(/7/g, 't');
  const palavras = n.split(/[^a-z]+/);
  const junto = n.replace(/[^a-z]/g, ''); // pega "p.o.r.r.a" e "p o r r a"
  return PROIBIDAS.some((w) => palavras.includes(w) || (w.length >= 5 && junto.includes(w)));
}

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
      const antes = game.phase === 'question' ? null : p.posAnterior || null;
      return { ...publicPlayer(p), pos: i + 1, rodada: a ? a.points : 0, respondeu: !!a, antes };
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
  const todos = [...game.players.values()];
  return {
    phase: game.phase,
    question: currentQuestionPublic(),
    correta: game.phase === 'question' ? null : QUESTIONS[game.qIndex]?.correta ?? null,
    distribution: game.phase === 'question' ? null : distribution(),
    answered: game.answers.size,
    playersCount: game.players.size,
    onlineCount: todos.filter((p) => p.online).length,
    // só o que a tela usa: os 150 últimos que entraram (abertura) e o Top 15 (ranking). Antes ia a lista
    // inteira, e um atacante pedindo o estado em sequência fazia o servidor estourar a memória.
    players: todos.slice(-150).map(publicPlayer),
    ranking: ranking().slice(0, 15),
    totalQuestions: QUESTIONS.length,
    entradaAberta: game.entradaAberta,
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
  // guarda a posição de cada um antes da pergunta, para o ranking mostrar quem subiu ou caiu
  ranking();
  for (const p of game.players.values()) p.posAnterior = game.qIndex >= 0 ? rankCache.pos.get(p.id) || null : null;
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
  if (keepPlayers) for (const p of game.players.values()) { p.score = 0; p.streak = 0; p.totalMs = 0; p.history = []; p.posAnterior = null; }
  else {
    game.entradaAberta = true;
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
  if (game.answers.size >= Math.max(1, online)) {
    const qi = game.qIndex;
    setTimeout(() => { if (game.qIndex === qi) endQuestion(); }, 800);
  }
  return { ok: true };
}

// ---------- Socket.io ----------
io.on('connection', (socket) => {
  const ip = ipReal(socket.handshake.headers, socket.handshake.address);
  conexoesPorIp.set(ip, (conexoesPorIp.get(ip) || 0) + 1);

  // Um erro em um evento nunca derruba o servidor
  const on = socket.on.bind(socket);
  socket.on = (ev, fn) => on(ev, (...a) => { try { fn(...a); } catch (e) { console.error(`Erro em ${ev}:`, e.message); } });

  // Limite de mensagens por conexão: 10 por segundo em média, rajadas de até 20.
  // O excedente é descartado, e quem insiste é desconectado.
  let fichas = 20, ultimo = Date.now(), excessos = 0;
  socket.use((packet, next) => {
    const agora = Date.now();
    fichas = Math.min(20, fichas + (agora - ultimo) / 100); ultimo = agora;
    if (fichas >= 1) { fichas -= 1; return next(); }
    if (++excessos > 50) socket.disconnect(true);
  });

  // ---- Telão: qualquer um pode assistir (QR Code, perguntas, ranking); comandos exigem PIN
  socket.on('host:watch', () => {
    if (socket.data.watch) return; // um pedido por conexão
    if (!socket.data.host) { if (espectadores >= MAX_ESPECTADORES) return; espectadores++; }
    socket.data.watch = true;
    socket.join('hosts');
    socket.emit('host:state', hostState());
  });
  // ---- Apresentador
  socket.on('host:auth', (pin, cb) => {
    if (!pinOk(ip, pin)) return ack(cb, { ok: false });
    if (socket.data.watch && !socket.data.host) espectadores--;
    socket.data.host = true; socket.data.watch = true;
    socket.join('hosts');
    ack(cb, { ok: true, csv: CSV_TOKEN, pinFraco: PIN_FRACO });
    socket.emit('host:state', hostState());
  });
  const hostOnly = (fn) => (...args) => { if (socket.data.host) fn(...args); };
  socket.on('host:next', hostOnly(() => next()));
  socket.on('host:end', hostOnly(() => endQuestion()));
  socket.on('host:finish', hostOnly(() => finish()));
  socket.on('host:reset', hostOnly((keep) => reset(!!keep)));
  socket.on('host:entrada', hostOnly((aberta) => { game.entradaAberta = !!aberta; broadcastHost(); }));
  socket.on('host:kick', hostOnly((id) => {
    for (const [t, p] of game.players) if (p.id === id) {
      if (p.socketId) io.to(p.socketId).emit('player:reset');
      game.players.delete(t);
      game.answers.delete(t);
    }
    invalidarRanking();
    broadcastHost();
  }));

  // ---- Participante
  socket.on('player:resume', (token, cb) => {
    const p = game.players.get(String(token || '').slice(0, 64));
    if (!p) return ack(cb, { ok: false });
    p.socketId = socket.id; p.online = true; socket.data.token = p.token;
    ack(cb, { ok: true });
    sendPlayer(p);
    agendarHost();
  });

  socket.on('player:join', (data, cb) => {
    if (socket.data.token && game.players.has(socket.data.token)) return ack(cb, { ok: false, msg: 'Você já está participando.' });
    const nome = limparTexto(data && data.nome, 40);
    const empresa = limparTexto(data && data.empresa, 60);
    if (letras(nome) < 2) return ack(cb, { ok: false, msg: 'Informe seu nome.' });
    if (letras(empresa) < 2) return ack(cb, { ok: false, msg: 'Informe sua empresa / filial.' });
    if (ofensivo(nome) || ofensivo(empresa)) return ack(cb, { ok: false, msg: 'Esse nome não é permitido. Use seu nome real.' });
    if (!game.entradaAberta) return ack(cb, { ok: false, msg: 'A entrada no quiz foi encerrada.' });
    if (game.phase === 'final') return ack(cb, { ok: false, msg: 'O quiz já terminou.' });
    if (game.players.size >= MAX_PLAYERS) return ack(cb, { ok: false, msg: 'Limite de participantes atingido.' });
    const token = crypto.randomBytes(16).toString('hex');
    const p = {
      token, id: crypto.randomBytes(6).toString('hex'), nome, empresa, score: 0, streak: 0, totalMs: 0,
      history: [], joinedAt: Date.now(), socketId: socket.id, online: true, posAnterior: null,
    };
    game.players.set(token, p);
    invalidarRanking();
    socket.data.token = token;
    ack(cb, { ok: true, token });
    sendPlayer(p);
    agendarHost();
  });

  socket.on('player:answer', (choice, cb) => {
    const res = answer(socket.data.token, choice);
    ack(cb, res);
    const p = game.players.get(socket.data.token);
    if (p && res.ok) sendPlayer(p);
  });

  socket.on('disconnect', () => {
    const n = (conexoesPorIp.get(ip) || 1) - 1;
    if (n > 0) conexoesPorIp.set(ip, n); else conexoesPorIp.delete(ip);
    if (socket.data.watch && !socket.data.host) espectadores--;
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

// Resultados em CSV (abre no Excel). O link com o código só aparece no telão depois do PIN.
app.get('/resultados.csv', (req, res) => {
  if (!iguais(req.query.t || '', CSV_TOKEN)) return res.status(403).send('Acesso negado');
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const txt = (v) => (/^[=+\-@\t\r]/.test(String(v)) ? "'" + v : v); // evita injeção de fórmula no Excel
  const head = ['Posição', 'Nome', 'Empresa/Filial', 'Pontuação', 'Acertos'];
  QUESTIONS.forEach((_, i) => head.push(`P${i + 1} resposta`, `P${i + 1} acertou`, `P${i + 1} pontos`, `P${i + 1} tempo (s)`));
  const rows = [head.map(esc).join(';')];
  const r = ranking();
  for (const item of r) {
    const p = [...game.players.values()].find((x) => x.id === item.id);
    const acertos = p.history.filter((h) => h && h.correct).length;
    const row = [item.pos, txt(p.nome), txt(p.empresa), p.score, acertos];
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
