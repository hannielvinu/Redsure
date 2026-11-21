import './style.css';
import {
  NCEngine,
  AreaCode,
  LogLevel,
  ChannelType,
  BaseChannel,
  GroupChannel,
  DirectChannel,
  GroupChannelIdentifier,
  DirectChannelIdentifier,
  SendMessageParams,
  SendTextMessageParams,
  MessageHandler,
  ConnectionStatusHandler,
  ChannelHandler,
  TranslateHandler,
  TranslateMessageParam,
} from '@nexconn/chat';
import { CITIES, BLOOD_GROUPS, CARD_TYPE, roomId, liveStatus, publicView, canGive, timeLeft, ago, MONEY_RE } from '../../server/shared.js';

/* ---------------- tiny helpers ---------------- */
const $app = document.getElementById('app');
const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get(k, d = null) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const api = async (path, body) => {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `Error ${r.status}`), { data: j });
  return j;
};
const authBody = (extra = {}) => ({ userId: S.session.userId, sig: S.session.sig, ...extra });
let toastT;
function toast(msg) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  clearTimeout(toastT);
  toastT = setTimeout(() => el.remove(), 2600);
}
const DROP = `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 4C22 20 12 31 12 42a20 20 0 0 0 40 0C52 31 42 20 32 4z" fill="#c8102e"/><path d="M23 41l6 6 12-13" stroke="#fff" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const mapToObj = (m) => (m instanceof Map ? Object.fromEntries(m) : { ...(m || {}) });
const LANGS = [['en', 'English'], ['hi', 'Hindi'], ['ta', 'Tamil'], ['te', 'Telugu'], ['kn', 'Kannada'], ['ml', 'Malayalam'], ['bn', 'Bengali'], ['mr', 'Marathi']];

/* ---------------- state ---------------- */
const S = {
  config: null,
  session: store.get('rs_session'),
  connected: false,
  tab: 'room',
  room: null, // { id, name, city }
  feed: new Map(), // messageId -> item
  cards: new Map(), // messageId -> { id, channelId, content, meta, sentTime, sender }
  dms: new Map(), // peerId -> { peerId, name, messages: [], unread }
  openPeer: null,
  typing: new Map(), // peerId -> until
  translations: new Map(), // messageId -> text
  names: store.get('rs_names', {}),
  lang: store.get('rs_lang', (navigator.language || 'en').slice(0, 2)),
  flash: new Set(),
};
const nameOf = (uid) => (uid === S.session?.userId ? 'You' : S.names[uid] || 'Redsure user');
function rememberName(uid, name) {
  if (uid && name && S.names[uid] !== name) {
    S.names[uid] = name;
    store.set('rs_names', S.names);
  }
}

/* ---------------- routing ---------------- */
const pub = location.pathname.match(/^\/r\/([\w-]+)\/([\w-]+)/);
if (pub) renderPublic(pub[1], pub[2]);
else boot();

/* ================= PUBLIC SHARE PAGE (no login) ================= */
async function renderPublic(channelId, messageId) {
  let timer;
  const draw = async () => {
    try {
      const v = await api(`/api/public/${channelId}/${messageId}`);
      const done = v.state === 'fulfilled';
      const dead = v.state === 'expired' || v.state === 'closed';
      const segs = Array.from({ length: v.units }, (_, i) => `<i class="${i < v.arranged ? 'on' : ''}"></i>`).join('');
      $app.innerHTML = `
        <div class="pub ${done ? 'done' : ''}">
          <div class="brand" style="margin-bottom:18px">${DROP} Redsure</div>
          <div class="pub-box">
            <div class="muted small">Blood request · ${h(v.city)}</div>
            <div class="big">${h(v.bg)}</div>
            <div class="state">${done ? 'Fulfilled. Thank you. Please don’t call.' : dead ? (v.state === 'expired' ? 'This request has expired.' : 'Closed by the family.') : `Still needed: ${v.units - v.arranged} of ${v.units} unit${v.units > 1 ? 's' : ''}`}</div>
            <div class="bar" style="${done ? '' : ''}">${segs}</div>
            <div class="meta"><span>🏥 ${h(v.hospital)}</span>${v.state === 'open' ? `<span>⏱ ${timeLeft(v.neededBy)}</span>` : ''}<span>${v.pledged} donor${v.pledged === 1 ? '' : 's'} offered</span></div>
            <p class="small muted" style="margin:14px 0 0"><span class="status ${v.state}">${v.state === 'open' ? '<i class="live"></i>' : ''}Live status</span> · updated ${ago(v.updatedAt)} · posted ${ago(v.createdAt)} by ${h(v.ownerName || 'the family')}</p>
            ${v.state === 'open' ? `<a class="btn red block" style="margin-top:16px;text-decoration:none" href="/?room=${encodeURIComponent(v.city)}&focus=${encodeURIComponent(messageId)}">I can donate: open Redsure</a><p class="hint center">Donors message the family inside Redsure. Their phone number is never shown.</p>` : `<p class="donebanner">${done ? 'This link updates itself. If you forwarded it, everyone you sent it to now sees “Fulfilled”.' : 'This request is no longer active. Please don’t forward it.'}</p>`}
            <div class="safety">⚠️ Paid blood donation is illegal in India. Never pay anyone a “fee” to donate or to “arrange” blood.</div>
          </div>
          <p class="center small muted" style="margin-top:18px">This page is live: it checks for changes every few seconds.<br><a href="/">What is Redsure?</a></p>
        </div>`;
      document.title = `${v.bg} blood · ${v.statusLine}`;
    } catch (e) {
      $app.innerHTML = `<div class="pub"><div class="brand">${DROP} Redsure</div><div class="pub-box" style="margin-top:18px"><b>${h(e.message)}</b><p class="muted">The link may be wrong or the request was removed.</p><a class="btn ghost" href="/">Open Redsure</a></div></div>`;
      clearInterval(timer);
    }
  };
  await draw();
  timer = setInterval(draw, 4000);
}

/* ================= APP ================= */
async function boot() {
  try {
    S.config = await api('/api/config');
  } catch {
    S.config = { appKey: null, cities: CITIES };
  }
  if (!S.config.appKey) {
    $app.innerHTML = `<div class="hero"><div class="brand">${DROP} Redsure</div><h1>Setup needed</h1><p>The server has no Nexconn App Key. Set NEXCONN_APP_KEY and NEXCONN_APP_SECRET.</p></div>`;
    return;
  }
  const params = new URLSearchParams(location.search);
  const wantCity = params.get('room');
  S.focus = params.get('focus');
  if (S.session && wantCity && CITIES.includes(wantCity) && wantCity !== S.session.city) {
    S.session.city = wantCity;
  }
  if (!S.session) return renderOnboarding(wantCity);
  await startSession();
}

function renderOnboarding(city) {
  $app.innerHTML = `
    <div style="padding:0 16px 40px">
      <div class="hero">
        <div class="brand">${DROP} Redsure</div>
        <h1>The blood request that <em>knows when it’s done.</em></h1>
        <p>Post a blood request once. Everyone who has it, even on an old WhatsApp forward, sees the moment it is fulfilled.</p>
      </div>
      <div class="promise">
        <div><span>🔴</span><div><b>One live card.</b> “2 of 3 units arranged” updates for everyone, instantly.</div></div>
        <div><span>🔒</span><div><b>Your number stays private.</b> Donors message you inside Redsure.</div></div>
        <div><span>🔍</span><div><b>Got a forward?</b> Paste it and see if it’s still needed.</div></div>
      </div>
      <form id="ob" class="card" style="padding:16px">
        <label for="nm">Your first name</label>
        <input id="nm" class="field" maxlength="40" autocomplete="given-name" placeholder="e.g. Priya" required>
        <label>Your city</label>
        <div class="chips" id="cities">${CITIES.map((c) => `<button type="button" class="chip ${c === (city || 'Chennai') ? 'on' : ''}" data-c="${c}">${c}</button>`).join('')}</div>
        <label>Your blood group <span class="muted">(optional: we highlight requests you can help)</span></label>
        <div class="chips" id="bgs">${BLOOD_GROUPS.map((g) => `<button type="button" class="chip" data-g="${g}">${g}</button>`).join('')}<button type="button" class="chip" data-g="">Don’t know</button></div>
        <button class="btn red block" style="margin-top:18px" id="go">Continue</button>
        <div class="err" id="err"></div>
        <p class="hint">No phone number, no password. We only use your first name inside chats.</p>
      </form>
    </div>`;
  let pickedCity = city && CITIES.includes(city) ? city : 'Chennai';
  let pickedBg = '';
  $app.querySelector('#cities').onclick = (e) => {
    const b = e.target.closest('[data-c]');
    if (!b) return;
    pickedCity = b.dataset.c;
    $app.querySelectorAll('#cities .chip').forEach((x) => x.classList.toggle('on', x === b));
  };
  $app.querySelector('#bgs').onclick = (e) => {
    const b = e.target.closest('[data-g]');
    if (!b) return;
    pickedBg = b.dataset.g;
    $app.querySelectorAll('#bgs .chip').forEach((x) => x.classList.toggle('on', x === b));
  };
  $app.querySelector('#ob').onsubmit = async (e) => {
    e.preventDefault();
    const btn = $app.querySelector('#go');
    btn.disabled = true;
    btn.textContent = 'Connecting…';
    try {
      const s = await api('/api/session', { name: $app.querySelector('#nm').value, city: pickedCity, bloodGroup: pickedBg });
      S.session = s;
      store.set('rs_session', s);
      await startSession();
    } catch (err) {
      $app.querySelector('#err').textContent = err.message;
      btn.disabled = false;
      btn.textContent = 'Continue';
    }
  };
}

let engineReady = false;
function initEngine() {
  if (engineReady) return;
  engineReady = true;
  const area = { SG: AreaCode.SG, NA: AreaCode.NA, SA: AreaCode.SA }[S.config.region] ?? AreaCode.SG;
  NCEngine.initialize({ appKey: S.config.appKey, areaCode: area, logLevel: LogLevel.ERROR });
  // The live request card is a custom message type, persisted in history.
  NCEngine.registerCustomMessages([{ messageType: CARD_TYPE, isPersited: true, isCounted: true }]);

  NCEngine.addConnectionStatusHandler('rs', new ConnectionStatusHandler({
    onConnectionStatusChanged({ status }) {
      S.connected = status === 0;
      document.querySelector('.dot')?.classList.toggle('on', S.connected);
    },
  }));

  NCEngine.addMessageHandler('rs', new MessageHandler({
    onMessageReceived({ messages }) {
      for (const m of messages) ingest(m, true);
      render();
    },
    // Someone pledged or the family updated progress: the card changes in place for everyone.
    onMessageMetadataUpdated({ messageId, metadata }) {
      const c = S.cards.get(messageId);
      if (c) {
        Object.assign(c.meta, metadata);
        S.flash.add(messageId);
        render();
      }
    },
  }));

  NCEngine.addChannelHandler('rs', new ChannelHandler({
    onTypingStatusChanged({ channelIdentifier, userTypingStatus }) {
      if (channelIdentifier.channelType !== ChannelType.DIRECT) return;
      const peer = channelIdentifier.channelId;
      if (userTypingStatus?.length) S.typing.set(peer, Date.now() + 6000);
      else S.typing.delete(peer);
      const el = document.getElementById('typing');
      if (el && S.openPeer === peer) el.textContent = S.typing.has(peer) ? `${nameOf(peer)} is typing…` : '';
    },
  }));

  NCEngine.addTranslateHandler('rs', new TranslateHandler({
    onTranslationCompleted({ results }) {
      for (const r of results || []) {
        if (r.code === 0 && r.translateInfo?.translatedText) S.translations.set(r.identifier, r.translateInfo.translatedText);
        else S.translations.set(r.identifier, '(translation unavailable)');
      }
      render();
    },
  }));
}

async function startSession() {
  initEngine();
  $app.innerHTML = `<div class="empty"><b>Connecting to your city room…</b>Redsure · ${h(S.session.city)}</div>`;
  let r = await NCEngine.connect({ token: S.session.token });
  if (r.code !== 0) {
    // Token expired or app secret rotated: get a fresh one for the same user.
    try {
      const s = await api('/api/session', { userId: S.session.userId, sig: S.session.sig, name: S.session.name, city: S.session.city, bloodGroup: S.session.bloodGroup });
      S.session = s;
      store.set('rs_session', s);
      r = await NCEngine.connect({ token: s.token });
    } catch {}
  }
  if (r.code !== 0) {
    $app.innerHTML = `<div class="empty"><b>Could not connect (code ${r.code}).</b><button class="btn ghost" onclick="localStorage.clear();location.reload()">Start again</button></div>`;
    return;
  }
  S.connected = true;
  rememberName(S.session.userId, S.session.name);
  await joinRoom(S.session.city);
  loadDms();
  render();
  setInterval(() => { if (S.tab === 'room') renderFeedOnly(); }, 30000); // countdowns
}

async function joinRoom(city) {
  if (S.room?.city !== city) {
    await api('/api/rooms/join', authBody({ city })).catch(() => null);
  }
  S.session.city = city;
  store.set('rs_session', S.session);
  S.room = { id: roomId(city), city, name: `Redsure · ${city}` };
  S.feed.clear();
  S.cards.clear();
  const q = BaseChannel.createMessagesQuery({ channelIdentifier: new GroupChannelIdentifier(S.room.id), pageSize: 60, isAscending: false, startTime: Date.now() });
  const res = await q.loadNextPage();
  if (res.code === 0) for (const m of res.data?.data || res.data || []) ingest(m, false);
  // Requests posted before this user joined: the room index lists them; their live state is message metadata.
  try {
    const { cards } = await api(`/api/rooms/${S.room.id}/cards`);
    for (const c of cards) {
      if (S.cards.has(c.messageId)) continue;
      const t = Number(c.metadata.createdAt || 0);
      rememberName(c.metadata.owner, c.metadata.ownerName);
      S.cards.set(c.messageId, { id: c.messageId, channelId: c.channelId, content: {}, meta: c.metadata, time: t, sender: c.metadata.owner });
      S.feed.set(c.messageId, { id: c.messageId, type: CARD_TYPE, sender: c.metadata.owner, time: t, content: {} });
    }
  } catch {}
}

function ingest(m, live) {
  const ci = m.channelIdentifier;
  const content = m.content || {};
  if (content.senderUserInfo?.userId) rememberName(content.senderUserInfo.userId, content.senderUserInfo.name);
  if (ci.channelType === ChannelType.GROUP) {
    if (!S.room || ci.channelId !== S.room.id) return;
    const item = { id: m.messageId, type: m.messageType, sender: m.senderUserId, time: m.sentTime, content };
    if (m.messageType === CARD_TYPE) {
      const meta = mapToObj(m.metadata);
      rememberName(meta.owner, meta.ownerName);
      const prev = S.cards.get(m.messageId);
      if (prev) Object.assign(prev.meta, meta);
      else S.cards.set(m.messageId, { id: m.messageId, channelId: ci.channelId, content, meta, time: m.sentTime, sender: m.senderUserId });
      if (!S.cards.get(m.messageId).meta.bg) return; // not a readable card
      if (live) S.flash.add(m.messageId);
    }
    if (m.messageType === CARD_TYPE || m.messageType === 'RC:TxtMsg') S.feed.set(m.messageId, item);
  } else if (ci.channelType === ChannelType.DIRECT) {
    const peer = ci.channelId;
    const d = dm(peer);
    if (!d.messages.some((x) => x.id === m.messageId)) {
      d.messages.push({ id: m.messageId, mine: m.senderUserId === S.session.userId, text: content.text ?? '', time: m.sentTime });
      d.messages.sort((a, b) => a.time - b.time);
    }
    if (live && m.senderUserId !== S.session.userId && S.openPeer !== peer) {
      d.unread++;
      toast(`New message from ${nameOf(peer)}`);
    }
    S.typing.delete(peer);
  }
}

function dm(peer) {
  if (!S.dms.has(peer)) S.dms.set(peer, { peerId: peer, messages: [], unread: 0, loaded: false });
  return S.dms.get(peer);
}

async function loadDms() {
  const q = BaseChannel.createChannelsQuery({ pageSize: 50, channelTypes: [ChannelType.DIRECT] });
  const r = await q.loadNextPage();
  if (r.code !== 0) return;
  for (const ch of r.data?.data || r.data || []) {
    const d = dm(ch.channelId);
    d.unread = ch.unreadCount || 0;
    if (ch.latestMessage) ingest(ch.latestMessage, false);
  }
  render();
}

async function loadThread(peer) {
  const d = dm(peer);
  const q = BaseChannel.createMessagesQuery({ channelIdentifier: new DirectChannelIdentifier(peer), pageSize: 50, isAscending: false, startTime: Date.now() });
  const r = await q.loadNextPage();
  if (r.code === 0) for (const m of r.data?.data || r.data || []) ingest(m, false);
  d.loaded = true;
  d.unread = 0;
  // Clear the unread badge on the server too, so other devices agree.
  new DirectChannel(peer).clearUnreadCount?.().catch?.(() => null);
}

/* ---------------- render ---------------- */
function render() {
  if (!S.session || !S.room) return;
  const unread = [...S.dms.values()].reduce((a, d) => a + d.unread, 0);
  $app.innerHTML = `
    <header class="top">
      <div class="top-row">
        <div class="brand">${DROP} Redsure</div>
        <div class="spacer"></div>
        <button class="pill" id="city" title="Change city"><span class="dot ${S.connected ? 'on' : ''}"></span>${h(S.room.city)} ▾</button>
      </div>
      <nav class="tabs">
        <button class="tab ${S.tab === 'room' ? 'active' : ''}" data-tab="room">City room</button>
        <button class="tab ${S.tab === 'chats' ? 'active' : ''}" data-tab="chats">Chats${unread ? `<span class="badge">${unread}</span>` : ''}</button>
        <button class="tab ${S.tab === 'check' ? 'active' : ''}" data-tab="check">Check a forward</button>
      </nav>
    </header>
    <main id="main"></main>`;
  $app.querySelector('.tabs').onclick = (e) => {
    const t = e.target.closest('[data-tab]');
    if (!t) return;
    S.tab = t.dataset.tab;
    if (S.tab !== 'chats') S.openPeer = null;
    render();
  };
  $app.querySelector('#city').onclick = pickCity;
  if (S.tab === 'room') renderRoom();
  else if (S.tab === 'chats') renderChats();
  else renderCheck();
}

function renderFeedOnly() {
  const el = document.getElementById('feed');
  if (el) el.innerHTML = feedHtml();
}

function feedHtml() {
  const items = [...S.feed.values()].sort((a, b) => a.time - b.time);
  if (!items.length)
    return `<div class="empty"><b>No requests in ${h(S.room.city)} right now.</b>When someone posts, it appears here live. Tap <b>Request blood</b> to post one.</div>`;
  const openCount = [...S.cards.values()].filter((c) => liveStatus(c.meta).state === 'open').length;
  return `<div class="sys">${openCount} open request${openCount === 1 ? '' : 's'} in ${h(S.room.city)} · cards update themselves</div>` +
    items.map((it) => (it.type === CARD_TYPE ? cardHtml(S.cards.get(it.id)) : lineHtml(it))).join('');
}

function lineHtml(it) {
  const mine = it.sender === S.session.userId;
  return `<div class="line ${mine ? 'me' : ''}"><div class="bubble">${mine ? '' : `<div class="who">${h(nameOf(it.sender))}</div>`}${h(it.content.text)}</div></div>`;
}

function cardHtml(c) {
  if (!c) return '';
  const m = c.meta;
  const st = liveStatus(m);
  const mine = m.owner === S.session.userId;
  const pledgedByMe = Boolean(m['p_' + S.session.userId.slice(0, 30)]);
  const cls = st.state === 'fulfilled' ? 'done' : st.state === 'open' ? '' : 'dead';
  const segs = Array.from({ length: st.units }, (_, i) => `<i class="${i < st.arranged ? 'on' : ''}"></i>`).join('');
  const compatible = st.state === 'open' && !mine && canGive(S.session.bloodGroup, m.bg);
  const flash = S.flash.has(c.id) ? 'flash' : '';
  S.flash.delete(c.id);
  let actions = '';
  if (st.state === 'open' && mine) {
    actions = `<button class="btn green sm" data-act="arranged" data-id="${c.id}">+1 unit arranged</button>
      <button class="btn sm" data-act="fulfilled" data-id="${c.id}">Mark fulfilled</button>
      <button class="btn ghost sm" data-act="more" data-id="${c.id}">More</button>`;
  } else if (st.state === 'open') {
    actions = pledgedByMe
      ? `<button class="btn ghost sm" data-act="chat" data-id="${c.id}">💬 Message ${h(m.ownerName || 'family')}</button>`
      : `<button class="btn red sm" data-act="pledge" data-id="${c.id}">I can donate</button>`;
  } else if (mine && st.state === 'expired') {
    actions = `<button class="btn sm" data-act="extend" data-id="${c.id}">Still needed: extend 6 h</button>`;
  }
  actions += `<button class="btn ghost sm" data-act="share" data-id="${c.id}">Share live link</button>`;
  return `
    <article class="card ${cls} ${flash}" id="c-${h(c.id)}">
      <div class="card-head">
        <div class="bg">${h(m.bg)}</div>
        <div style="flex:1;min-width:0">
          <span class="status ${st.state}">${st.state === 'open' ? '<i class="live"></i>' : ''}${h(st.label)}</span>
          <div class="card-title ellipsis">${h(st.units)} unit${st.units > 1 ? 's' : ''} · ${h(m.hospital)}</div>
          <div class="meta"><span>by ${mine ? 'you' : h(m.ownerName || 'family')}</span><span>${ago(Number(m.createdAt || c.time))}</span>${st.state === 'open' ? `<span>⏱ ${timeLeft(Number(m.neededBy))}</span>` : ''}</div>
        </div>
      </div>
      <div class="bar">${segs}</div>
      <div class="meta"><b style="color:var(--ink)">${h(st.line)}</b><span>${st.pledged} donor${st.pledged === 1 ? '' : 's'} offered</span>${compatible ? '<span class="compat">✓ Your blood group can give</span>' : ''}</div>
      ${m.note ? `<div class="note">${h(m.note)}</div>` : ''}
      ${st.state === 'fulfilled' ? `<div class="donebanner">✓ Fulfilled ${m.closedAt ? ago(Number(m.closedAt)) : ''}. Every shared link now says “please don’t call”.</div>` : ''}
      <div class="actions">${actions}</div>
    </article>`;
}

function renderRoom() {
  const main = document.getElementById('main');
  main.innerHTML = `<div id="feed">${feedHtml()}</div>
    <button class="btn red fab" id="new">＋ Request blood</button>
    <form class="composer" id="cmp"><div class="composer-in"><input id="txt" maxlength="500" placeholder="Message the ${h(S.room.city)} room…" autocomplete="off"><button class="btn red">Send</button></div></form>`;
  main.querySelector('#new').onclick = openRequestForm;
  main.querySelector('#feed').onclick = onCardAction;
  main.querySelector('#cmp').onsubmit = async (e) => {
    e.preventDefault();
    const inp = main.querySelector('#txt');
    const text = inp.value.trim();
    if (!text) return;
    if (MONEY_RE.test(text) && !confirm('This message mentions money. Paid blood donation is illegal in India. Send anyway?')) return;
    inp.value = '';
    const p = new SendTextMessageParams({ text, senderUserInfo: { userId: S.session.userId, name: S.session.name } });
    const r = await new GroupChannel(S.room.id).sendMessage(p);
    if (r.code === 0) { ingest(r.data, false); renderFeedOnly(); scrollEnd(); } else toast(`Send failed (${r.code})`);
  };
  if (S.focus) {
    const id = S.focus;
    S.focus = null;
    setTimeout(() => document.getElementById('c-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 200);
  } else scrollEnd();
}
const scrollEnd = () => setTimeout(() => window.scrollTo({ top: document.body.scrollHeight }), 30);

async function onCardAction(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const c = S.cards.get(b.dataset.id);
  if (!c) return;
  const act = b.dataset.act;
  if (act === 'share') return share(c);
  if (act === 'chat') return openChat(c.meta.owner, c.meta.ownerName);
  if (act === 'more') return moreSheet(c);
  b.disabled = true;
  try {
    if (act === 'pledge') {
      const r = await api('/api/requests/pledge', authBody({ channelId: c.channelId, messageId: c.id, name: S.session.name }));
      Object.assign(c.meta, r.metadata);
      // Open a private chat with the family. No phone numbers are exchanged.
      const intro = `Hi ${c.meta.ownerName || ''}, I’m ${S.session.name}${S.session.bloodGroup ? ` (${S.session.bloodGroup})` : ''}. I can donate for your ${c.meta.bg} request at ${c.meta.hospital}. When and where should I come?`;
      await sendDm(c.meta.owner, intro);
      rememberName(c.meta.owner, c.meta.ownerName);
      toast('Thank you. The family has your message.');
      openChat(c.meta.owner, c.meta.ownerName);
      return;
    }
    const r = await api('/api/requests/update', authBody({ channelId: c.channelId, messageId: c.id, action: act }));
    Object.assign(c.meta, r.metadata);
    S.flash.add(c.id);
    if (r.metadata.status === 'fulfilled') toast('Marked fulfilled. Every shared link now says so.');
    renderFeedOnly();
  } catch (err) {
    toast(err.message);
    if (err.data?.metadata) Object.assign(c.meta, err.data.metadata);
    renderFeedOnly();
  }
}

function shareUrl(c) {
  return `${location.origin}/r/${c.channelId}/${c.id}`;
}
async function share(c) {
  const url = shareUrl(c);
  const m = c.meta;
  const text = `🩸 ${m.bg} blood needed · ${m.units} unit${Number(m.units) > 1 ? 's' : ''} · ${m.hospital}, ${m.city}.\nLive status (updates itself, shows when fulfilled): ${url}\nNever pay anyone for blood.`;
  sheet(`<h2>Share the live link</h2>
    <p class="muted small">Forward this instead of a plain message. Whoever opens it, even days later, sees the current status.</p>
    <div class="field small" style="word-break:break-all;margin:10px 0">${h(url)}</div>
    <div class="actions">
      <a class="btn green" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(text)}">WhatsApp</a>
      <button class="btn" id="cp">Copy link</button>
      ${navigator.share ? '<button class="btn" id="ns">More…</button>' : ''}
      <a class="btn ghost" target="_blank" rel="noopener" href="${h(url)}">Open live page</a>
    </div>`, (el) => {
    el.querySelector('#cp').onclick = async () => { try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { toast(url); } };
    const ns = el.querySelector('#ns');
    if (ns) ns.onclick = () => navigator.share({ title: 'Redsure blood request', text, url }).catch(() => null);
  });
}

function moreSheet(c) {
  sheet(`<h2>Update your request</h2>
    <div class="actions" style="flex-direction:column">
      <button class="btn" data-a="unarranged">Undo one arranged unit</button>
      <button class="btn" data-a="extend">Still needed: extend by 6 hours</button>
      <button class="btn ghost" data-a="cancel" style="color:var(--red)">Close request (no longer needed)</button>
    </div>`, (el, close) => {
    el.querySelectorAll('[data-a]').forEach((b) => (b.onclick = async () => {
      close();
      try {
        const r = await api('/api/requests/update', authBody({ channelId: c.channelId, messageId: c.id, action: b.dataset.a }));
        Object.assign(c.meta, r.metadata);
        S.flash.add(c.id);
        renderFeedOnly();
      } catch (e) { toast(e.message); }
    }));
  });
}

function openRequestForm(prefill = {}) {
  let bg = prefill.bloodGroup || '';
  let units = Math.max(1, Math.min(10, Number(prefill.units) || 1));
  let hours = 12;
  sheet(`<h2>Request blood</h2>
    <p class="muted small">Posts one live card to the ${h(S.room.city)} room. Your phone number is never shown.</p>
    <label>Blood group needed</label>
    <div class="chips" id="fbg">${BLOOD_GROUPS.map((g) => `<button type="button" class="chip ${g === bg ? 'on' : ''}" data-g="${g}">${g}</button>`).join('')}</div>
    <label>Units</label>
    <div class="stepper"><button type="button" id="dn">−</button><b id="un">${units}</b><button type="button" id="up">+</button></div>
    <label for="hs">Hospital</label>
    <input id="hs" class="field" maxlength="80" placeholder="e.g. Government General Hospital, ward 4" value="${h(prefill.hospital || '')}">
    <label>Needed within</label>
    <div class="chips" id="hrs">${[3, 6, 12, 24, 48].map((x) => `<button type="button" class="chip ${x === hours ? 'on' : ''}" data-h="${x}">${x} h</button>`).join('')}</div>
    <label for="nt">Note for donors <span class="muted">(optional, no phone numbers)</span></label>
    <input id="nt" class="field" maxlength="140" placeholder="e.g. Ask for Ravi at the blood bank counter">
    <div class="err" id="ferr"></div>
    <button class="btn red block" id="post" style="margin-top:12px">Post live request</button>`, (el, close) => {
    el.querySelector('#fbg').onclick = (e) => { const b = e.target.closest('[data-g]'); if (!b) return; bg = b.dataset.g; el.querySelectorAll('#fbg .chip').forEach((x) => x.classList.toggle('on', x === b)); };
    el.querySelector('#hrs').onclick = (e) => { const b = e.target.closest('[data-h]'); if (!b) return; hours = Number(b.dataset.h); el.querySelectorAll('#hrs .chip').forEach((x) => x.classList.toggle('on', x === b)); };
    el.querySelector('#dn').onclick = () => { units = Math.max(1, units - 1); el.querySelector('#un').textContent = units; };
    el.querySelector('#up').onclick = () => { units = Math.min(10, units + 1); el.querySelector('#un').textContent = units; };
    el.querySelector('#post').onclick = async () => {
      const hospital = el.querySelector('#hs').value.trim();
      let note = el.querySelector('#nt').value.trim();
      const err = el.querySelector('#ferr');
      if (!bg) return (err.textContent = 'Pick the blood group.');
      if (hospital.length < 3) return (err.textContent = 'Enter the hospital name.');
      if (/(\d[\s-]?){10}/.test(note)) return (err.textContent = 'Please remove the phone number. Donors will message you here.');
      if (MONEY_RE.test(note)) return (err.textContent = 'Please don’t mention money. Paid donation is illegal.');
      const btn = el.querySelector('#post');
      btn.disabled = true;
      btn.textContent = 'Posting…';
      let r;
      try {
        // Our server sends the card through the Nexconn Platform Chat API (custom message + metadata).
        r = await api('/api/requests/create', authBody({ city: S.room.city, bg, units, hospital, hours, note, name: S.session.name }));
      } catch (x) {
        btn.disabled = false; btn.textContent = 'Post live request';
        return (err.textContent = x.message);
      }
      const t = Number(r.metadata.createdAt);
      const existing = S.cards.get(r.messageId);
      if (existing) Object.assign(existing.meta, r.metadata);
      else {
        S.cards.set(r.messageId, { id: r.messageId, channelId: r.channelId, content: {}, meta: { ...r.metadata }, time: t, sender: S.session.userId });
        S.feed.set(r.messageId, { id: r.messageId, type: CARD_TYPE, sender: S.session.userId, time: t, content: {} });
      }
      const c = S.cards.get(r.messageId);
      close();
      S.tab = 'room';
      render();
      if (c) share(c);
    };
  });
}

function pickCity() {
  sheet(`<h2>Choose your city room</h2><div class="chips" style="margin-top:12px">${CITIES.map((c) => `<button class="chip ${c === S.room.city ? 'on' : ''}" data-c="${c}">${c}</button>`).join('')}</div>`, (el, close) => {
    el.onclick = async (e) => {
      const b = e.target.closest('[data-c]');
      if (!b) return;
      close();
      await joinRoom(b.dataset.c);
      S.tab = 'room';
      render();
    };
  });
}

/* ---------------- chats ---------------- */
async function sendDm(peer, text) {
  const p = new SendTextMessageParams({ text, senderUserInfo: { userId: S.session.userId, name: S.session.name } });
  const r = await new DirectChannel(peer).sendMessage(p);
  if (r.code === 0) ingest(r.data, false);
  else toast(`Send failed (${r.code})`);
  return r;
}

async function openChat(peer, name) {
  if (name) rememberName(peer, name);
  S.tab = 'chats';
  S.openPeer = peer;
  render();
  await loadThread(peer);
  render();
}

function renderChats() {
  const main = document.getElementById('main');
  if (S.openPeer) return renderThread(main, S.openPeer);
  const list = [...S.dms.values()].filter((d) => d.messages.length).sort((a, b) => (b.messages.at(-1)?.time || 0) - (a.messages.at(-1)?.time || 0));
  main.innerHTML = list.length
    ? `<p class="muted small">Private chats between families and donors. Phone numbers are never shared.</p>` +
      list.map((d) => {
        const last = d.messages.at(-1);
        return `<button class="row" data-peer="${h(d.peerId)}"><div class="avatar">${h(nameOf(d.peerId)[0] || '?')}</div><div class="grow"><b>${h(nameOf(d.peerId))}</b><div class="muted small ellipsis">${last ? (last.mine ? 'You: ' : '') + h(last.text) : ''}</div></div>${d.unread ? `<span class="badge">${d.unread}</span>` : ''}</button>`;
      }).join('')
    : `<div class="empty"><b>No chats yet.</b>When you tap “I can donate”, or a donor offers to help you, a private chat opens here.</div>`;
  main.onclick = (e) => {
    const r = e.target.closest('[data-peer]');
    if (r) openChat(r.dataset.peer);
  };
}

function renderThread(main, peer) {
  const d = dm(peer);
  d.unread = 0;
  const msgs = d.messages
    .map((m) => {
      const risky = MONEY_RE.test(m.text);
      const tr = S.translations.get(m.id);
      return `<div class="line ${m.mine ? 'me' : ''}"><div class="bubble">${h(m.text)}${tr ? `<div class="tr">${h(tr)}</div>` : ''}${!m.mine && !tr ? `<div><button class="linkbtn" data-tr="${h(m.id)}">Translate</button></div>` : ''}</div></div>${risky ? `<div class="guard">⚠️ <b>This message mentions money.</b> Paid blood donation is illegal in India. Never pay a donor, a “fee” or anyone who says they can arrange blood. Report it to 1930 (cyber crime helpline).</div>` : ''}`;
    })
    .join('');
  main.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px"><button class="back" id="bk">‹ Chats</button><div class="spacer"></div>
      <select id="lang" class="pill" title="Translate to">${LANGS.map(([c, n]) => `<option value="${c}" ${c === S.lang ? 'selected' : ''}>Translate to ${n}</option>`).join('')}</select></div>
    <h3 style="margin:6px 0 0">${h(nameOf(peer))}</h3>
    <div class="typing" id="typing">${S.typing.has(peer) ? `${h(nameOf(peer))} is typing…` : ''}</div>
    <div class="guard" style="background:#f1f1f3;border-color:#e5e5e5;color:#374151">🔒 Private chat. Your phone number is not shared. Meet only at the hospital blood bank.</div>
    <div id="msgs">${msgs || '<p class="muted center small">Say hello.</p>'}</div>
    <form class="composer" id="dmc"><div class="composer-in"><input id="dmt" maxlength="1000" placeholder="Message ${h(nameOf(peer))}…" autocomplete="off"><button class="btn red">Send</button></div></form>`;
  main.querySelector('#bk').onclick = () => { S.openPeer = null; render(); };
  main.querySelector('#lang').onchange = (e) => { S.lang = e.target.value; store.set('rs_lang', S.lang); };
  main.querySelector('#msgs').onclick = async (e) => {
    const b = e.target.closest('[data-tr]');
    if (!b) return;
    b.textContent = 'Translating…';
    // Nexconn built-in translation; the result arrives in onTranslationCompleted.
    const r = await NCEngine.translateModule.translateMessages({ list: [new TranslateMessageParam(b.dataset.tr, 'auto', S.lang)] }).catch((x) => ({ code: -1, x }));
    if (r.code !== 0) { S.translations.set(b.dataset.tr, `(translation not enabled for this app: code ${r.code})`); render(); }
  };
  const input = main.querySelector('#dmt');
  let lastTyping = 0;
  input.oninput = () => {
    if (Date.now() - lastTyping > 3000) {
      lastTyping = Date.now();
      new DirectChannel(peer).sendTypingStatus('RC:TxtMsg').catch(() => null);
    }
    main.querySelector('.composer-in').style.outline = MONEY_RE.test(input.value) ? '2px solid #f5d9a8' : '';
  };
  main.querySelector('#dmc').onsubmit = async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    if (MONEY_RE.test(text) && !confirm('Your message mentions money. Paid blood donation is illegal in India. Send anyway?')) return;
    input.value = '';
    await sendDm(peer, text);
    render();
    scrollEnd();
  };
  scrollEnd();
}

/* ---------------- check a forward ---------------- */
function renderCheck() {
  const main = document.getElementById('main');
  main.innerHTML = `
    <h2 style="margin:6px 0 4px">Got a blood request forward?</h2>
    <p class="muted" style="margin:0">Paste it here before you forward it or call. We read it and check it against live Redsure requests.</p>
    <textarea id="fw" class="field" style="margin-top:12px" placeholder="Paste the WhatsApp message here…"></textarea>
    <button class="btn red block" id="chk" style="margin-top:10px">Check it</button>
    <div id="res"></div>
    <p class="hint">We never label a request “fake”. We tell you what we can and can’t confirm.</p>`;
  main.querySelector('#chk').onclick = async () => {
    const text = main.querySelector('#fw').value;
    const btn = main.querySelector('#chk');
    const res = main.querySelector('#res');
    btn.disabled = true;
    btn.textContent = 'Reading…';
    try {
      const r = await api('/api/check', { text });
      res.innerHTML = checkHtml(r);
      res.onclick = (e) => {
        const f = e.target.closest('[data-focus]');
        if (f) { S.tab = 'room'; S.focus = f.dataset.focus; render(); }
        if (e.target.closest('#postit')) openRequestForm(r.fields);
      };
    } catch (e) {
      res.innerHTML = `<div class="err">${h(e.message)}</div>`;
    }
    btn.disabled = false;
    btn.textContent = 'Check it';
  };
}

function words(s) {
  return new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !['hospital', 'hospitals', 'the', 'and', 'medical', 'govt', 'government'].includes(w)));
}
function findMatch(f) {
  let best = null;
  for (const c of S.cards.values()) {
    if (!f.bloodGroup || c.meta.bg !== f.bloodGroup) continue;
    const a = words(f.hospital), b = words(c.meta.hospital);
    const overlap = [...a].filter((w) => b.has(w)).length;
    const score = overlap + (f.units && Number(c.meta.units) === Number(f.units) ? 0.5 : 0);
    if (overlap > 0 && (!best || score > best.score)) best = { c, score };
  }
  return best?.c || null;
}

function checkHtml(r) {
  const f = r.fields;
  const match = findMatch(f);
  let verdict;
  if (match) {
    const st = liveStatus(match.meta);
    verdict = st.state === 'open'
      ? `<div class="verdict live">● Live on Redsure: ${h(st.line)}</div><p>This matches an open request in ${h(match.meta.city)}. Offer to donate inside Redsure instead of calling the number.</p><button class="btn red" data-focus="${h(match.id)}">Open the live request</button>`
      : `<div class="verdict ok">✓ ${h(st.label)} on Redsure</div><p>${st.state === 'fulfilled' ? 'The family marked this fulfilled. Please don’t call or forward it.' : 'This request is no longer active. Please don’t forward it.'}</p><button class="btn ghost" data-focus="${h(match.id)}">See the request</button>`;
  } else {
    verdict = `<div class="verdict warn">No live record for this request</div><p>We can’t confirm it is still needed. Before you forward it, ask the person who sent it to you whether it is current${f.date ? '' : ' (it has no date)'}.</p>`;
  }
  const rows = [['Blood group', f.bloodGroup], ['Units', f.units], ['Hospital', f.hospital], ['City', f.city], ['Date in message', f.date], ['Phone in message', f.phone ? `ends in ${String(f.phone).slice(-4)}` : null]]
    .map(([k, v]) => `<dt>${k}</dt><dd>${v ? h(v) : '<span class="muted">not in message</span>'}</dd>`).join('');
  return `<div class="result">${verdict}
    <dl class="kv">${rows}</dl>
    ${r.flags.length ? `<b class="small">Things to check</b><ul class="flags">${r.flags.map((x) => `<li>${h(x)}</li>`).join('')}</ul>` : ''}
    <p class="small muted">Read by ${r.reader === 'ai+rules' ? 'AI + rules (AI values are kept only if they appear in the text)' : 'rules'}.</p>
    ${!match ? `<button class="btn ghost sm" id="postit">This is my family’s request: post it live</button>` : ''}
    <div class="safety">⚠️ Never pay anyone for blood. Paid donation is illegal in India.</div></div>`;
}

/* ---------------- bottom sheet ---------------- */
function sheet(inner, wire) {
  const bg = document.createElement('div');
  bg.className = 'sheet-bg';
  bg.innerHTML = `<div class="sheet" role="dialog">${inner}<button class="btn ghost block" style="margin-top:14px" data-close>Cancel</button></div>`;
  const close = () => bg.remove();
  bg.onclick = (e) => { if (e.target === bg || e.target.closest('[data-close]')) close(); };
  document.body.appendChild(bg);
  wire?.(bg.querySelector('.sheet'), close);
}
