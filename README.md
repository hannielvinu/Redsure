# Redsure

**The blood request that knows when it's done.**

Live app: **https://redsure.onrender.com** · Nexconn App Key: `8brlm7uf89223` · Write-up: [docs/Redsure_Writeup.pdf](docs/Redsure_Writeup.pdf) · Demo video: [docs/Redsure_demo.mp4](docs/Redsure_demo.mp4)

When a family needs blood, they post "URGENT, B-ve needed" in every WhatsApp group. That message is a frozen copy. It can never say "done". So it keeps circulating for days or years, the family's phone keeps ringing, fake "donors" ask for money, and people learn to ignore every request, including the real one tonight.

Redsure turns the request into **one live card** built on the Nexconn Chat SDK:

- **Live status everywhere.** "1 of 3 units arranged" → "Fulfilled, please don't call" updates instantly for everyone in the city room *and* on every forwarded link.
- **Private donor chat.** A donor taps **I can donate** and a 1-to-1 chat with the family opens. No phone numbers are shown.
- **Check a forward.** Paste any forward you received. Redsure reads it (AI + rules) and tells you whether it matches a live request, a fulfilled one, or nothing it can confirm.
- **Never-pay guard.** Any message that mentions money, UPI or a "fee" gets a warning: paid blood donation is illegal in India.
- **Read it in your language.** Nexconn built-in message translation in donor chats (our server's AI translates if the app's translation service is not switched on).

Track: **Humanitarian & Social Good** (volunteer dispatch rooms).

## How it uses Nexconn

| Feature in the app | Nexconn capability | Where in code |
|---|---|---|
| Live request card | **Custom message type** `RS:Request` registered on the client (`NCEngine.registerCustomMessages`); sent by our server with metadata via Platform Chat API `/v4/group-channel/message/send` (`hasMetadata`, `isEchoToSender`) | `server/index.js` → `/api/requests/create` |
| Card status, units, pledges | **Message metadata** set at send, updated through the **Platform Chat API** `/v4/channel-type/message/metadata/set` with `isEchoToSender` | `server/index.js` → `/api/requests/*` |
| Card changes in place for everyone | `MessageHandler.onMessageMetadataUpdated` | `web/src/main.js` → `initEngine` |
| Public share page / link preview | Platform Chat API `/v4/channel-type/message/metadata/list` (Nexconn metadata is the only database) | `server/index.js` → `/api/public`, `/r/:ch/:id` |
| City rooms | **Group channels**: `/v4/group-channel/create`, `/v4/group-channel/join`, `GroupChannel.sendMessage` | `server/index.js` → `ensureRoom` |
| Requests visible to people who join later | Room index of card IDs in the group's **extended profile** (`/v4/group-channel/profile/update`, `/profile/list`) | `server/index.js` → `getRoomIndex`, `/api/rooms/:id/cards` |
| Room history on open | `BaseChannel.createMessagesQuery` (message history) | `joinRoom` |
| Donor ↔ family chat | **Direct channels** `DirectChannel.sendMessage`, channel list `createChannelsQuery`, unread counts | `sendDm`, `loadDms` |
| "… is typing" | `DirectChannel.sendTypingStatus` + `ChannelHandler.onTypingStatusChanged` | `renderThread` |
| Translate a message | **Built-in translation** `NCEngine.translateModule.translateMessages` + `TranslateHandler` (AI fallback via `/api/translate`) | `renderThread` |
| Secure login | Server-issued **access tokens** `/v4/auth/access-token/issue`, SHA1-signed requests; App Secret never reaches the browser | `server/nexconn.js` |
| Reliability | Primary/backup API domain failover, connection status handler, auto token refresh | `server/nexconn.js`, `startSession` |

## Architecture

```
Browser (Vite, vanilla JS)  ── Nexconn Chat SDK (WebSocket) ──►  Nexconn Chat cloud
      │  token, pledge, update, check                                 ▲
      ▼                                                               │ signed Platform Chat API
Node/Express server  ─────────────────────────────────────────────────┘
      └─ Groq LLM (optional) for reading pasted forwards
Public link /r/<room>/<message>  →  server reads the card's metadata from Nexconn, renders live status + link-preview tags
```

Nexconn group members only receive messages sent after they join, so each room keeps an index of its request cards in the group's extended profile. Nexconn is the only database: there is no other datastore.

The server is the single writer of counts (pledges, arranged units), so two donors tapping at the same moment can't overwrite each other. Only the person who posted a request can change its progress.

## Run it

```bash
npm install
cp .env.example .env   # add your Nexconn App Key + App Secret
npm run build
node --env-file=.env server/index.js   # http://localhost:3000
```

Deploy: the repo includes `render.yaml` (Render → New → Blueprint). Set `NEXCONN_APP_KEY`, `NEXCONN_APP_SECRET`, optional `GROQ_API_KEY`.

Tests: `npm test`.

## Safety and privacy

- No phone numbers: the request form rejects them in notes; donors and families talk in in-app chats.
- Redsure never calls a request "fake". The forward checker says what it can and can't confirm, and keeps AI-extracted values only if they appear in the pasted text.
- Requests expire at their "needed by" time unless the family extends them.
- Paid blood donation has been banned in India since 1998; the app warns on any money mention.

## Prior work

Built from scratch for the Nexconn Build Challenge 2026.



## License

MIT
