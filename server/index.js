import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Nexconn } from './nexconn.js';
import { readForward, normaliseGroup, translateText } from './forward.js';
import { CITIES, BLOOD_GROUPS, CARD_TYPE, MONEY_RE, roomId, liveStatus, publicView } from './shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'web', 'dist');

const nx = new Nexconn({
  appKey: process.env.NEXCONN_APP_KEY,
  appSecret: process.env.NEXCONN_APP_SECRET,
  region: process.env.NEXCONN_REGION || 'SG',
});
const SESSION_KEY = crypto
  .createHash('sha256')
  .update((process.env.NEXCONN_APP_SECRET || 'dev') + ':redsure-session')
  .digest();

const sign = (userId) => crypto.createHmac('sha256', SESSION_KEY).update(userId).digest('hex').slice(0, 32);
const app = express();
app.use(express.json({ limit: '64kb' }));

function auth(req, res, next) {
  const { userId, sig } = req.body || {};
  if (!userId || !sig || sign(userId) !== sig) return res.status(401).json({ error: 'Session expired. Reload the app.' });
  req.userId = userId;
  next();
}

const ensuredRooms = new Set();
async function ensureRoom(city, userId) {
  const id = roomId(city);
  const name = `Redsure · ${city}`;
  if (!ensuredRooms.has(id)) {
    // Create is idempotent for our purposes: if the room exists the API returns an error code and we just join.
    await nx.createGroup(id, name, userId, `Live blood requests in ${city}. Requests update themselves. Never pay anyone for blood.`).catch(() => null);
    ensuredRooms.add(id);
  }
  const r = await nx.joinGroup(id, [userId]);
  return { id, name, code: r.code };
}

app.get('/api/config', (_req, res) => {
  res.json({ appKey: process.env.NEXCONN_APP_KEY || null, region: process.env.NEXCONN_REGION || 'SG', ai: Boolean(process.env.GROQ_API_KEY), cities: CITIES });
});

app.post('/api/session', async (req, res) => {
  try {
    if (!nx.configured) return res.status(503).json({ error: 'Server is missing NEXCONN_APP_KEY / NEXCONN_APP_SECRET.' });
    let { userId, sig, name, city, bloodGroup } = req.body || {};
    name = String(name || '').trim().slice(0, 40);
    if (!name) return res.status(400).json({ error: 'Please enter your first name.' });
    if (!CITIES.includes(city)) return res.status(400).json({ error: 'Pick a city.' });
    if (!userId || sign(userId) !== sig) userId = 'u' + crypto.randomBytes(9).toString('hex');
    const t = await nx.issueToken(userId, name);
    if (t.code !== 0) return res.status(502).json({ error: 'Nexconn token error', detail: t });
    const room = await ensureRoom(city, userId);
    res.json({ userId, sig: sign(userId), token: t.result.accessToken, name, city, bloodGroup: normaliseGroup(bloodGroup), room });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.post('/api/rooms/join', auth, async (req, res) => {
  try {
    const { city } = req.body;
    if (!CITIES.includes(city)) return res.status(400).json({ error: 'Unknown city' });
    res.json(await ensureRoom(city, req.userId));
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

/* ---- Room index ----
   Nexconn group members only receive messages sent after they join. So each room keeps a list of
   its request-card message IDs in the group's extended profile (10 keys × 256 chars ≈ 120 cards),
   and each card's live state is read from its message metadata. Nexconn stays the only database. */
const roomIndex = new Map(); // roomId -> [messageId] oldest..newest
const IDX_KEYS = Array.from({ length: 10 }, (_, i) => `ext_i${i}`);

async function getRoomIndex(room) {
  if (roomIndex.has(room)) return roomIndex.get(room);
  const ext = (await nx.getGroupExt(room).catch(() => null)) || {};
  const ids = IDX_KEYS.flatMap((k) => (ext[k] ? String(ext[k]).split(',') : [])).filter(Boolean);
  roomIndex.set(room, ids);
  return ids;
}

async function saveIndex(room, ids) {
  const keep = [];
  const chunks = IDX_KEYS.map(() => []);
  // Newest first, packed until every key is full.
  let k = 0;
  for (const id of [...ids].reverse()) {
    while (k < chunks.length && (chunks[k].join(',').length + id.length + 1) > 250) k++;
    if (k >= chunks.length) break;
    chunks[k].push(id);
    keep.unshift(id);
  }
  roomIndex.set(room, keep);
  const ext = Object.fromEntries(IDX_KEYS.map((key, i) => [key, chunks[i].join(',')]));
  return nx.updateGroupExt(room, ext);
}

const metaCache = new Map(); // messageId -> { at, m }
async function cachedCard(messageId) {
  const c = metaCache.get(messageId);
  if (c && Date.now() - c.at < 2500) return c.m;
  const m = await loadCard(messageId).catch(() => null);
  metaCache.set(messageId, { at: Date.now(), m });
  return m;
}

// The family posts a request. The server validates it, sends the card into the city room through the
// Platform Chat API (custom message + metadata) and adds it to the room index. The owner is set here, so it can't be forged.
app.post('/api/requests/create', auth, async (req, res) => {
  try {
    const { city, bg, units, hospital, hours, note, name } = req.body;
    if (!CITIES.includes(city)) return res.status(400).json({ error: 'Unknown city' });
    if (!BLOOD_GROUPS.includes(bg)) return res.status(400).json({ error: 'Pick the blood group.' });
    const u = Math.max(1, Math.min(10, Number(units) || 1));
    const hosp = String(hospital || '').trim().slice(0, 80);
    if (hosp.length < 3) return res.status(400).json({ error: 'Enter the hospital name.' });
    const nt = String(note || '').trim().slice(0, 140);
    if (/(\d[\s-]?){10}/.test(nt)) return res.status(400).json({ error: 'Please remove the phone number. Donors will message you here.' });
    if (MONEY_RE.test(nt)) return res.status(400).json({ error: 'Please don’t mention money. Paid donation is illegal.' });
    const hrs = [3, 6, 12, 24, 48].includes(Number(hours)) ? Number(hours) : 12;
    const owner = req.userId;
    const ownerName = String(name || 'Family').trim().slice(0, 40);
    const room = roomId(city);
    await ensureRoom(city, owner);
    const now = Date.now();
    const metadata = {
      v: '1', bg, units: String(u), hospital: hosp, city, note: nt,
      neededBy: String(now + hrs * 3600000), createdAt: String(now), updatedAt: String(now),
      owner, ownerName, status: 'open', arranged: '0', pledged: '0',
    };
    const r = await nx.sendGroupCard({
      fromUserId: owner,
      channelId: room,
      messageType: CARD_TYPE,
      content: { bg, units: u, hospital: hosp, city, note: nt, senderUserInfo: { userId: owner, name: ownerName } },
      metadata,
      pushContent: `${bg} blood needed at ${hosp}`,
    });
    const messageId = r.result?.messageIds?.[0]?.messageId;
    if (r.code !== 0 || !messageId) return res.status(502).json({ error: 'Nexconn send error', detail: r });
    const ids = await getRoomIndex(room);
    await saveIndex(room, [...ids, messageId]).catch(() => null);
    res.json({ messageId, channelId: room, metadata });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.post('/api/requests/register', auth, async (req, res) => {
  try {
    const { channelId, messageId } = req.body;
    if (!/^rs_[a-z]+$/.test(channelId || '')) return res.status(400).json({ error: 'Unknown room' });
    const m = await loadCard(messageId);
    if (!m || m.owner !== req.userId) return res.status(403).json({ error: 'Not your request' });
    const ids = await getRoomIndex(channelId);
    if (!ids.includes(messageId)) {
      const r = await saveIndex(channelId, [...ids, messageId]);
      if (r.code !== 0) return res.status(502).json({ error: 'Nexconn group profile error', detail: r });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get('/api/rooms/:roomId/cards', async (req, res) => {
  try {
    const room = req.params.roomId;
    if (!/^rs_[a-z]+$/.test(room)) return res.status(400).json({ error: 'Unknown room' });
    const ids = (await getRoomIndex(room)).slice(-40);
    const cards = await Promise.all(ids.map(async (id) => ({ messageId: id, channelId: room, metadata: await cachedCard(id) })));
    res.set('Cache-Control', 'no-store').json({ cards: cards.filter((c) => c.metadata) });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

let lastMetaError = null;
async function loadCard(messageId) {
  const r = await nx.getMetadata(messageId);
  if (r.code !== 0) lastMetaError = { code: r.code, raw: r.raw };
  if (r.code !== 0 || !r.metadata || !r.metadata.bg) return null;
  return r.metadata;
}

// A donor offers to give. The server is the single writer of counts, so two donors tapping at once can't overwrite each other.
app.post('/api/requests/pledge', auth, async (req, res) => {
  try {
    const { channelId, messageId, name } = req.body;
    const m = await loadCard(messageId);
    if (!m) return res.status(404).json({ error: 'Request not found' });
    const st = liveStatus(m);
    if (st.state !== 'open') return res.status(409).json({ error: `This request is ${st.label.toLowerCase()}.`, metadata: m });
    if (m.owner === req.userId) return res.status(400).json({ error: 'This is your own request.' });
    const key = 'p_' + req.userId.slice(0, 30);
    const already = Boolean(m[key]);
    const patch = { [key]: `${String(name || 'Donor').slice(0, 30)}|${Date.now()}` };
    if (!already) patch.pledged = String(Number(m.pledged || 0) + 1);
    patch.updatedAt = String(Date.now());
    const r = await nx.setMetadata({ messageId, userId: req.userId, channelId, metadata: patch });
    if (r.code !== 0) return res.status(502).json({ error: 'Nexconn metadata error', detail: r });
    metaCache.delete(messageId);
    res.json({ metadata: { ...m, ...patch }, already });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// The family updates progress. Only the person who posted the request can do this.
app.post('/api/requests/update', auth, async (req, res) => {
  try {
    const { channelId, messageId, action } = req.body;
    const m = await loadCard(messageId);
    if (!m) return res.status(404).json({ error: 'Request not found' });
    if (m.owner !== req.userId) return res.status(403).json({ error: 'Only the family who posted this can update it.' });
    const units = Number(m.units || 1);
    const arranged = Number(m.arranged || 0);
    const patch = { updatedAt: String(Date.now()) };
    if (action === 'arranged') {
      patch.arranged = String(Math.min(units, arranged + 1));
      if (Number(patch.arranged) >= units) {
        patch.status = 'fulfilled';
        patch.closedAt = String(Date.now());
      }
    } else if (action === 'unarranged') {
      patch.arranged = String(Math.max(0, arranged - 1));
      patch.status = 'open';
    } else if (action === 'fulfilled') {
      patch.status = 'fulfilled';
      patch.arranged = String(units);
      patch.closedAt = String(Date.now());
    } else if (action === 'cancel') {
      patch.status = 'cancelled';
      patch.closedAt = String(Date.now());
    } else if (action === 'extend') {
      patch.status = 'open';
      patch.neededBy = String(Math.max(Date.now(), Number(m.neededBy || 0)) + 6 * 3600 * 1000);
    } else return res.status(400).json({ error: 'Unknown action' });
    const r = await nx.setMetadata({ messageId, userId: req.userId, channelId, metadata: patch });
    if (r.code !== 0) return res.status(502).json({ error: 'Nexconn metadata error', detail: r });
    metaCache.delete(messageId);
    res.json({ metadata: { ...m, ...patch } });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// Public, read-only view for share links. Nexconn message metadata is the only database.
app.get('/api/public/:channelId/:messageId', async (req, res) => {
  try {
    const m = await loadCard(req.params.messageId);
    if (!m) return res.status(404).json({ error: 'This request link is not valid.', nexconn: lastMetaError });
    res.set('Cache-Control', 'no-store');
    res.json(publicView(m));
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.post('/api/check', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (text.length < 10) return res.status(400).json({ error: 'Paste the full forwarded message.' });
  res.json(await readForward(text));
});

app.post('/api/translate', auth, async (req, res) => {
  const { text, lang } = req.body;
  if (!/^[a-z]{2}$/.test(lang || '') || !text) return res.status(400).json({ error: 'Bad request' });
  const out = await translateText(text, lang);
  if (!out) return res.status(503).json({ error: 'Translation unavailable' });
  res.json({ text: out });
});

app.get('/healthz', (_req, res) => res.json({ ok: true, nexconn: nx.configured }));

// Share links get live link-preview tags, so a WhatsApp preview already says "2 of 3 arranged" or "Fulfilled".
let indexHtml = null;
function getIndex() {
  if (indexHtml === null) indexHtml = fs.existsSync(path.join(DIST, 'index.html')) ? fs.readFileSync(path.join(DIST, 'index.html'), 'utf8') : '';
  return indexHtml;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

app.get('/r/:channelId/:messageId', async (req, res) => {
  let html = getIndex();
  try {
    const m = await loadCard(req.params.messageId);
    if (m) {
      const v = publicView(m);
      const title = `${v.bg} blood · ${v.statusLine}`;
      const desc = `${v.hospital}, ${v.city}. Live status from Redsure. Never pay anyone for blood.`;
      html = html
        .replace(/<title>.*?<\/title>/, `<title>${esc(title)}</title>`)
        .replace('<!--OG-->', `<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta name="description" content="${esc(desc)}">`);
    }
  } catch {}
  res.set('Cache-Control', 'no-store').type('html').send(html);
});

app.use(express.static(DIST, { index: 'index.html', maxAge: '1h' }));
app.get('*', (_req, res) => res.type('html').send(getIndex()));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Redsure on :${port} (Nexconn configured: ${nx.configured}, AI: ${Boolean(process.env.GROQ_API_KEY)})`));
