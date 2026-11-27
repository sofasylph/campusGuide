// Campus Guide server. Run: node server.js  (Node 18+, no npm install needed)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
try { fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').forEach(function (l) {
  var m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}); } catch (e) {}
const PORT = process.env.PORT || 3000, KEY = process.env.ANTHROPIC_API_KEY, MODEL = process.env.MODEL || 'claude-sonnet-5-5';
const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8'); // re-read each request: edit the JSON/prompt without restarting
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.pdf': 'application/pdf' };
const send = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };

// ---- storage: only student-approved notes and safety flags. Never chats. ----
const STORE = path.join(__dirname, 'data', 'store.json'), CKEY = process.env.COUNSELLOR_KEY;
const load = () => { try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch (e) { return []; } };
const save = rows => { fs.mkdirSync(path.dirname(STORE), { recursive: true }); fs.writeFileSync(STORE, JSON.stringify(rows, null, 1)); };
const clip = (v, n) => String(v || '').slice(0, n);
async function readBody(req) { let raw = ''; for await (const ch of req) { raw += ch; if (raw.length > 40000) throw new Error('too_large'); } return JSON.parse(raw || '{}'); }

const Scoring = require('./public/scoring.js');
const scales = () => JSON.parse(read('scales.json'));
const LN = { hi: 'Hindi', mr: 'Marathi' };
const glossLine = () => { try { return JSON.parse(read('lang-glossary.json')).phrases.map(p => p.concept + ' = ' + p.hi + ' (Hindi) / ' + p.mr + ' (Marathi)').join('; '); } catch (e) { return ''; } };
const langNote = l => LN[l] ? '\n\nThe student chose ' + LN[l] + '. Reply in ' + LN[l] + ' (Devanagari script) with everyday expressions, not clinical words. Students may describe feelings in expressions like these (given in Roman letters, write them in Devanagari): ' + glossLine() + '.' : '';

// Only complete, in-range answers are kept; missing answers are never treated as zero.
function cleanResults(list) {
  const C = scales();
  return (Array.isArray(list) ? list : []).slice(0, 4).map(x => {
    const d = x.kind === 'survey' ? C.survey : C.scales.find(s => s.id === x.id), a = Array.isArray(x.answers) ? x.answers : [];
    if (!d || !d.items.length || a.length !== d.items.length || a.some((v, i) => !Number.isInteger(v) || v < 0 || v >= (d.items[i].o || d.o).length)) return null;
    return { kind: x.kind === 'survey' ? 'survey' : 'scale', id: d.id, version: d.version, answers: a, date: Date.now() };
  }).filter(Boolean);
}
// Scores and colours are worked out when the counsellor opens the list, so updated thresholds apply and the browser cannot dictate a flag.
function enrich(r) {
  if (!r.results) return r;
  const C = scales();
  return Object.assign({}, r, { results: r.results.map(x => {
    if (x.kind === 'survey') return { kind: 'survey', name: C.survey.name, date: x.date, lines: C.survey.items.map((it, i) => [it.q, it.o[x.answers[i]]]) };
    const d = C.scales.find(s => s.id === x.id), sc = d && Scoring.score(d, x.answers), b = sc && Scoring.band(d, sc);
    if (!sc) return { kind: 'scale', name: x.id, date: x.date };
    return { kind: 'scale', name: d.name, version: x.version, method: d.method === 'mean' ? 'mean of items' : d.method === 'sum4' ? 'sum x 4' : 'sum of items', date: x.date, score: sc.score, raw: sc.raw, max: d.max, flag: b && b.flag, label: b && b.label, descriptive: !!(b && b.descriptive), thresholdsApproved: !!d.approved, wordingVerified: !!d.wordingVerified };
  }) });
}
// The API's own error message (e.g. an unsupported parameter) - never anything a student typed.
async function apiWhy(r) { try { const j = await r.json(); return ': ' + String((j.error && j.error.message) || '').slice(0, 160); } catch (e) { return ''; } }
async function translate(body, req) {
  const L = LN[body.lang], strs = (Array.isArray(body.strings) ? body.strings : []).slice(0, 40).map(s => clip(s, 300)).filter(Boolean);
  if (!L || !strs.length) return { code: 400, out: { error: 'bad_request' } };
  let cache = {}; const f = path.join(__dirname, 'data', 'translations.json'); try { cache = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {}
  const key = s => body.lang + '|' + s, miss = strs.filter(s => !(key(s) in cache));
  if (miss.length) {
    if (!KEY) return { code: 503, out: { error: 'no_key' } };
    if (!allowed(req, 'translate')) return { code: 429, out: { error: 'busy' } }; // only calls that reach the model count; cached phrases are free
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 16000, output_config: { effort: 'low' }, system: 'Translate short interface texts of a student wellbeing app from English into ' + L + ' (Devanagari). Use simple, warm, everyday wording a student would actually say, not clinical or word-for-word. Keep numbers, punctuation and line breaks. Prefer these expressions when the concept appears (given in Roman letters, write them in Devanagari): ' + glossLine() + '. Reply with a JSON array of strings, same order and same length, and nothing else.', messages: [{ role: 'user', content: JSON.stringify(miss) }] }) });
    if (!r.ok) throw new Error('anthropic ' + r.status + await apiWhy(r));
    const t = ((await r.json()).content || []).map(b => b.text || '').join(''); let out;
    try { out = JSON.parse(t.match(/\[[\s\S]*\]/)[0]); } catch (e) { out = null; }
    if (!Array.isArray(out) || out.length !== miss.length) return { code: 502, out: { error: 'bad_translation' } };
    miss.forEach((s, i) => { cache[key(s)] = String(out[i]); });
    fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(cache));
  }
  return { code: 200, out: { map: Object.fromEntries(strs.filter(s => key(s) in cache).map(s => [s, cache[key(s)]])) } };
}

// Second look at ambiguous words (e.g. "kill") so "this assignment is killing me" doesn't raise an alarm. Fails closed: anything but a clear "idiom" escalates.
async function vet(text) {
  if (!KEY) return 'unsure';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      // The model thinks before answering and that counts toward max_tokens, so a tiny limit leaves no room for the one-word answer.
      body: JSON.stringify({ model: MODEL, max_tokens: 1024, output_config: { effort: 'low' }, system: 'You check one message from a student for a safety app. The message may be in English, Hindi, Marathi or a mix, including Roman letters. Decide whether it could be a real expression of suicidal thoughts or of wanting to harm oneself or someone else. Everyday idioms such as "this assignment is killing me" or "kill time" are idioms. If you are not sure, say unsure. Reply with exactly one word: genuine, idiom or unsure.', messages: [{ role: 'user', content: text }] })
    });
    if (!r.ok) return 'unsure';
    const t = ((await r.json()).content || []).map(b => b.text || '').join('').toLowerCase();
    return t.indexOf('genuine') > -1 ? 'genuine' : (t.indexOf('idiom') > -1 && t.indexOf('unsure') < 0 ? 'idiom' : 'unsure');
  } catch (e) { return 'unsure'; }
}

// Cost guard: limits only the paid model call. Crisis phrases are checked first and are never rate limited.
const hits = new Map(); let day = '', dayCount = 0, trDayCount = 0;
const DAILY_CAP = +process.env.DAILY_CAP || 300, IP_LIMIT = +process.env.IP_LIMIT || 20; // chat messages per IP per 10 minutes
const TR_DAILY_CAP = +process.env.TR_DAILY_CAP || 1500, TR_IP_LIMIT = +process.env.TR_IP_LIMIT || 60; // translation calls that reach the model (kept apart from chat)
function allowed(req, kind) {
  const tr = kind === 'translate', ip = ((req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || '').trim(), now = Date.now(), today = new Date().toDateString();
  if (day !== today) { day = today; dayCount = 0; trDayCount = 0; }
  const key = (tr ? 'tr|' : '') + ip, recent = (hits.get(key) || []).filter(t => now - t < 600000);
  if (recent.length >= (tr ? TR_IP_LIMIT : IP_LIMIT) || (tr ? trDayCount >= TR_DAILY_CAP : dayCount >= DAILY_CAP)) return false;
  recent.push(now); hits.set(key, recent); if (tr) trDayCount++; else dayCount++; return true;
}

// The model answers through a tool call, so its reply arrives as clean structured data instead of text that has to be parsed.
const RESPOND = { name: 'respond', description: 'Send your reply to the student.', input_schema: { type: 'object', properties: { reply: { type: 'string' }, resource_ids: { type: 'array', items: { type: 'string' } }, suggest_urgent: { type: 'boolean' } }, required: ['reply'] } };
// Fallback if the model ever answers in plain text. Raw JSON must never reach a student.
function looseParse(t) {
  try { return JSON.parse(t.match(/\{[\s\S]*\}/)[0]); } catch (e) {}
  const m = t.match(/"reply"\s*:\s*"((?:[^"\\]|\\[\s\S])*)/);
  let reply = '';
  if (m) { try { reply = JSON.parse('"' + m[1] + '"'); } catch (e) { reply = m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"'); } }
  else if (!/^\s*[\{\[]/.test(t)) reply = t.trim();
  const ids = (t.match(/"resource_ids"\s*:\s*\[([^\]]*)\]/) || [null, ''])[1];
  return { reply, resource_ids: [...ids.matchAll(/"([^"]+)"/g)].map(x => x[1]), suggest_urgent: /"suggest_urgent"\s*:\s*true/.test(t) };
}

async function chat(body, req) {
  const resources = JSON.parse(read('resources.json')).resources;
  const rules = JSON.parse(read('safety-rules.json'));
  let msgs = (body.messages || [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-20).map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  const last = msgs[msgs.length - 1];
  if (!last || last.role !== 'user') return { code: 400, out: { error: 'bad_request' } };

  const hit = list => list.some(p => new RegExp(p, 'i').test(last.content));
  if (hit(rules.escalate)) return { code: 200, out: { escalate: true } }; // never waits on the model
  if (hit(rules.vet || []) && (await vet(last.content)) !== 'idiom') return { code: 200, out: { escalate: true } };
  // Hindi/Marathi: the phrase list is English only, so every message gets the AI check. Only a clear 'genuine' escalates; 'unsure' adds a gentle follow-up question.
  let unsure = false;
  if (body.lang === 'hi' || body.lang === 'mr' || /[\u0900-\u097F]/.test(last.content)) { const v = await vet(last.content); if (v === 'genuine') return { code: 200, out: { escalate: true } }; unsure = v !== 'idiom'; }
  if (!KEY) return { code: 503, out: { error: 'no_key' } };
  if (!allowed(req)) return { code: 429, out: { error: 'busy' } };

  const c = body.context || {};
  const system = read('prompt.md')
    .replace('{{RESOURCES}}', () => resources.filter(r => r.ai !== false).map(r => '- ' + r.id + ': ' + r.title + ' [' + (r.tags || []).join(', ') + '] ' + (r.blurb || '')).join('\n'))
    .replace('{{CONTEXT}}', () => 'Feelings: ' + ((c.feelings || []).join(', ') || 'none') + '. On their plate: ' + ((c.plate || []).join(', ') || 'none') + '.')
    + ((hit(rules.clarify) || unsure) ? '\n\nThe latest message may be ambiguous or very low. Ask one gentle, neutral question about what they mean. Do not label it.' : '') + langNote(body.lang);

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 4000, system, messages: msgs, tools: [RESPOND], tool_choice: { type: 'auto' } }) // thinking counts toward max_tokens
  });
  if (!r.ok) throw new Error('anthropic ' + r.status + await apiWhy(r));
  const j = await r.json(), blocks = j.content || [], text = blocks.map(b => b.text || '').join('');

  const tu = blocks.find(b => b.type === 'tool_use');
  let o = tu ? tu.input : looseParse(text);
  if (j.stop_reason === 'max_tokens') { console.error('chat: reply cut off at max_tokens'); o = { suggest_urgent: o.suggest_urgent }; } // a half sentence is worse than the fallback
  if (o.suggest_urgent) return { code: 200, out: { escalate: true } };
  const ids = Array.isArray(o.resource_ids) ? o.resource_ids : [];
  return { code: 200, out: {
    reply: String(o.reply || 'I’m here. Tell me a little more about what’s going on.'),
    resources: resources.filter(x => x.ai !== false && ids.indexOf(x.id) > -1) // only approved-list items ever reach the student
  } };
}

http.createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0];
    if (url === '/api/health') return send(res, 200, { ai: !!KEY });
    if (url === '/api/resources') return send(res, 200, read('resources.json'));
    if (url === '/api/chat' && req.method === 'POST') {
      let raw = '';
      for await (const ch of req) { raw += ch; if (raw.length > 40000) return send(res, 413, { error: 'too_large' }); }
      const { code, out } = await chat(JSON.parse(raw || '{}'), req);
      return send(res, code, out);
    }
        const q = new URL(req.url, 'http://x');
    if (url === '/api/scales') return send(res, 200, read('scales.json'));
    if (url === '/api/translate' && req.method === 'POST') {
      const { code, out } = await translate(await readBody(req), req); return send(res, code, out);
    }
    if (url === '/api/handoff' && req.method === 'POST') {
      const b = await readBody(req), s = b.summary || {}, rows = load(), id = crypto.randomBytes(4).toString('hex');
      rows.push({ id, kind: 'note', ts: Date.now(), status: 'new', results: cleanResults(b.results), summary: { concern: clip(s.concern, 600), duration: clip(s.duration, 60), tried: clip(s.tried, 300) }, contact: b.contact ? clip(b.contact, 80) : null });
      save(rows); return send(res, 200, { id });
    }
    if (url.startsWith('/api/handoff/') && req.method === 'DELETE') { // the code is the student's key; safety flags are not deletable here
      const id = decodeURIComponent(url.slice(13)), rows = load(), keep = rows.filter(r => !(r.id === id && r.kind === 'note'));
      if (keep.length === rows.length) return send(res, 404, { error: 'not_found' });
      save(keep); return send(res, 200, { ok: true });
    }
    if (url === '/api/flag' && req.method === 'POST') {
      const b = await readBody(req), rows = load();
      rows.push({ id: crypto.randomBytes(4).toString('hex'), kind: 'flag', ts: Date.now(), status: 'new', contact: b.contact ? clip(b.contact, 80) : null });
      save(rows); return send(res, 200, { ok: true });
    }
    if (url.startsWith('/api/counsellor/')) { // demo-grade: one shared key from .env
      if (!CKEY || req.headers['x-counsellor-key'] !== CKEY) return send(res, 403, { error: 'forbidden' });
      if (url === '/api/counsellor/list') { const full = q.searchParams.get('summaries') === '1'; return send(res, 200, load().slice().reverse().map(r => full ? enrich(r) : Object.assign({}, r, { summary: undefined, results: undefined }))); }
      if (url === '/api/counsellor/status' && req.method === 'POST') {
        const b = await readBody(req), rows = load(), r = rows.find(x => x.id === b.id);
        if (r && ['new', 'in_progress', 'resolved'].indexOf(b.status) > -1) { r.status = b.status; save(rows); }
        return send(res, 200, { ok: true });
      }
    }
    const pub = path.join(__dirname, 'public');
    const file = path.normalize(path.join(pub, url === '/' ? 'index.html' : url));
    if (!file.startsWith(pub)) return send(res, 403, { error: 'forbidden' });
    fs.readFile(file, (e, data) => {
      if (e) return send(res, 404, { error: 'not_found' });
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }); res.end(data);
    });
  } catch (e) { console.error('error:', e.message); send(res, 500, { error: 'server' }); } // never log what students type
}).listen(PORT, () => console.log('Campus Guide on http://localhost:' + PORT + (KEY ? '' : '  (no API key: typing box disabled)')));
