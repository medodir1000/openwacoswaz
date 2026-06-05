/**
 * leadecombot bridge — multi-account Baileys + Express HTTP.
 *
 * Differences from MediaHubAccess single-tenant bridge:
 *   - One Baileys WASocket per seller (Map<seller_id, sock>).
 *   - Per-seller auth folders: auth_info/seller_<id>/.
 *   - /api/{pair,unpair,status,send} all take seller_id.
 *   - Per-seller daily counter + last-reply timestamps.
 *   - Inbound messages.upsert handler POSTs to brain with seller_id baked in.
 *
 * Anti-ban guardrails are the same as MediaHubAccess (3-stage human timing,
 * quiet hours, per-user rate limit) but bookkept per seller.
 */

import express from 'express';
import axios from 'axios';
import { existsSync, rmSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import qrcode from 'qrcode';

// Baileys 6.x exports makeWASocket as a *named* export; 7.x switched it
// to the default export. We import it both ways so this file works on
// either version.
import baileys, {
  makeWASocket as makeWASocketNamed,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys';

const makeWASocket =
  typeof makeWASocketNamed === 'function' ? makeWASocketNamed :
  typeof baileys === 'function' ? baileys :
  baileys?.default;

// ── Config ──────────────────────────────────────────────────────────────
const PORT          = Number(process.env.HTTP_PORT || 3002);
const AUTH_ROOT     = process.env.AUTH_DIR || 'auth_info';
const PY_WEBHOOK    = process.env.PY_WEBHOOK_URL || 'http://localhost:5001/webhook';
const ADMIN_ORIGINS = (process.env.ADMIN_ORIGINS || 'http://localhost:5181').split(',').map(s => s.trim());

// Pre-read humanization: random delay BEFORE the blue ticks fire, so the
// customer's chat shows "delivered" for a beat before "read" — same
// rhythm a real human gives when they're not glued to the phone.
const PRE_READ_DELAY_MS         = Number(process.env.PRE_READ_DELAY_MS || 1000);
const PRE_READ_DELAY_JITTER_MS  = Number(process.env.PRE_READ_DELAY_JITTER_MS || 2000);

// Post-read jitter: time between "read" and "online" presence. Keeps the
// existing env knobs working for any operator who already tuned them.
const READ_DELAY_MS         = Number(process.env.READ_DELAY_MS || 4000);
const READ_DELAY_JITTER_MS  = Number(process.env.READ_DELAY_JITTER_MS || 4000);
const ONLINE_DELAY_MS       = Number(process.env.ONLINE_DELAY_MS || 1500);
const ONLINE_DELAY_JITTER_MS = Number(process.env.ONLINE_DELAY_JITTER_MS || 1500);

// Typing delay model: clamp(thinking + chars*per_char, MIN, MAX), then
// ±jitter. Defaults: ~25ms/char with a hard 3-8s window — matches a
// realistic human typing speed (≈ 1.25s per 50 chars) without ever
// looking instant or unreasonably slow.
const TYPING_MIN_MS         = Number(process.env.TYPING_MIN_MS || 3000);
const TYPING_MAX_MS         = Number(process.env.TYPING_MAX_MS || 8000);
const TYPING_PER_CHAR_MS    = Number(process.env.TYPING_PER_CHAR_MS || 25);
const TYPING_THINK_MS       = Number(process.env.TYPING_THINK_MS || 800);
const TYPING_JITTER_MS      = Number(process.env.TYPING_JITTER_MS || 500);

// Legacy aliases kept for backward compat with .env files in the wild.
const REPLY_DELAY_MS        = Number(process.env.REPLY_DELAY_MS || 3000);
const REPLY_DELAY_JITTER_MS = Number(process.env.REPLY_DELAY_JITTER_MS || 3000);

// Global outbound throttle. A token-bucket smooths peak-hour bursts so
// 50 leads from a Facebook ad don't all reply at once. RATE_PER_MINUTE
// is the steady-state cap (default 8/min — one reply every 7.5s on
// average); RATE_BUCKET_SIZE allows short bursts above that before the
// bucket drains. The whole node process shares this budget across every
// seller socket; per-seller fairness is FIFO.
const RATE_PER_MINUTE       = Number(process.env.RATE_PER_MINUTE || 8);
const RATE_BUCKET_SIZE      = Number(process.env.RATE_BUCKET_SIZE || 6);

const QUIET_START   = process.env.QUIET_START_HHMM || '01:00';
const QUIET_END     = process.env.QUIET_END_HHMM   || '07:00';
const QUIET_TZ      = process.env.QUIET_TIMEZONE   || 'Africa/Casablanca';
const DAILY_CAP_DEFAULT = Number(process.env.DAILY_MSG_CAP_DEFAULT || 200);
const PER_USER_RATE_MS  = Number(process.env.PER_USER_RATE_MS || 8000);

// ── In-memory multi-tenant state ────────────────────────────────────────
/** Map<seller_id, WASocket> */
const sockets = new Map();
/** Map<seller_id, { status, jid, phone, qrDataUrl, pairingCode, lastError, connectedAt, lastSeenAt }> */
const stateBySeller = new Map();
/** Map<seller_id, { dayKey, count }> */
const dailyCounter = new Map();
/** Map<`${seller_id}|${jid}`, lastReplyTimestamp> for per-user rate limiting */
const lastReplyAt = new Map();
/** Map<seller_id, { startedAt: number, attempts: number }> — tracks how
 * long we've been retrying passive login for a seller in pair-pending
 * state, so the disconnect handler can keep the retry loop alive for the
 * full ~3 min pair window without spamming forever. */
const pairingState = new Map();

// ── Helpers ─────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = (base, jit) => base + Math.floor(Math.random() * Math.max(0, jit));

// Baileys schedules saveCreds() through its event bus and those writes may
// land AFTER we've torn the socket down and wiped the auth_info directory.
// The straggling fs.open() then ENOENT-crashes the whole process. Swallow
// those — the connection is already gone, so a missing creds file is fine.
process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || String(reason);
  const ignorable =
    /ENOENT.*auth_info/.test(msg) ||
    /Connection Closed/.test(msg) ||
    /Stream Errored/.test(msg) ||
    /Intentional Logout/.test(msg);
  if (ignorable) {
    console.warn(`[bridge ${ts()}] swallowed unhandledRejection: ${msg.slice(0, 200)}`);
    return;
  }
  console.error(`[bridge ${ts()}] FATAL unhandledRejection:`, reason);
});
process.on('uncaughtException', (err) => {
  const msg = err?.message || String(err);
  if (/ENOENT.*auth_info/.test(msg)) {
    console.warn(`[bridge ${ts()}] swallowed uncaughtException: ${msg.slice(0, 200)}`);
    return;
  }
  console.error(`[bridge ${ts()}] FATAL uncaughtException:`, err);
  process.exit(1);
});

function ts() {
  return new Date().toISOString().slice(11, 19);
}

function localDayKey() {
  // Day key in the configured quiet-hour timezone so the daily counter
  // rolls over at the right moment for the bot's geography.
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: QUIET_TZ });
  return fmt.format(new Date());
}

function isQuietHour() {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: QUIET_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const hhmm = fmt.format(new Date());            // "HH:mm"
  // Quiet window may span midnight (e.g. 01:00–07:00).
  if (QUIET_START <= QUIET_END) {
    return hhmm >= QUIET_START && hhmm < QUIET_END;
  }
  return hhmm >= QUIET_START || hhmm < QUIET_END;
}

function bumpDailyCounter(sellerId) {
  const day = localDayKey();
  const c = dailyCounter.get(sellerId) || { dayKey: day, count: 0 };
  if (c.dayKey !== day) { c.dayKey = day; c.count = 0; }
  c.count += 1;
  dailyCounter.set(sellerId, c);
  return c.count;
}

function isCapHit(sellerId, capOverride) {
  const day = localDayKey();
  const c = dailyCounter.get(sellerId);
  if (!c || c.dayKey !== day) return false;
  const cap = capOverride ?? DAILY_CAP_DEFAULT;
  return c.count >= cap;
}

function authDirFor(sellerId) {
  return resolve(AUTH_ROOT, `seller_${sellerId}`);
}

// ── Anti-ban: typing delay model ────────────────────────────────────────
/**
 * Compute a realistic typing duration for a given reply. Combines a base
 * "thinking" pause + per-char typing time, clamps to the 3-8s human-paced
 * window, then jitters slightly so consecutive replies aren't identical.
 *
 * Defensive: any non-finite result (NaN/Infinity from bad env values)
 * collapses to TYPING_MIN_MS so we still send the message instead of
 * sleeping forever.
 */
function computeTypingMs(text) {
  const len = (text || '').length;
  const base = TYPING_THINK_MS + len * TYPING_PER_CHAR_MS;
  const jittered = base + (Math.random() * 2 - 1) * TYPING_JITTER_MS;
  const clamped = Math.max(TYPING_MIN_MS, Math.min(TYPING_MAX_MS, jittered));
  return Number.isFinite(clamped) ? clamped : TYPING_MIN_MS;
}

// ── Anti-ban: token-bucket rate limiter (global) ────────────────────────
// RATE_PER_MINUTE tokens drip in continuously; up to RATE_BUCKET_SIZE
// tokens may accumulate to absorb a burst. Each outbound message
// consumes one token. Sharing the bucket across every seller socket is
// intentional — WhatsApp's spam heuristics watch the network as a whole,
// not per-account, especially when several sellers run on one VM.
let bucketTokens = RATE_BUCKET_SIZE;
let bucketLastRefillAt = Date.now();

function refillBucket() {
  const now = Date.now();
  const elapsedMs = now - bucketLastRefillAt;
  if (elapsedMs <= 0) return;
  const refill = (elapsedMs / 60_000) * RATE_PER_MINUTE;
  bucketTokens = Math.min(RATE_BUCKET_SIZE, bucketTokens + refill);
  bucketLastRefillAt = now;
}

function tryConsumeToken() {
  refillBucket();
  if (bucketTokens >= 1) {
    bucketTokens -= 1;
    return true;
  }
  return false;
}

async function waitForToken(label = '') {
  // Defensive ceiling: never block the queue forever even if a clock skew
  // or misconfiguration drives the math sideways. 5 minutes is far longer
  // than any legitimate burst-smoothing wait and still lets the process
  // recover gracefully if something is wrong.
  const deadline = Date.now() + 5 * 60_000;
  while (!tryConsumeToken()) {
    if (Date.now() > deadline) {
      console.warn(`[throttle ${ts()}] waitForToken giving up after 5min (${label}) — sending anyway`);
      return;
    }
    refillBucket();
    const msPerToken = 60_000 / Math.max(1, RATE_PER_MINUTE);
    const remaining  = (1 - bucketTokens) * msPerToken;
    // Add 0-400ms of jitter so multiple waiters don't wake in lockstep.
    await sleep(Math.max(100, remaining) + Math.floor(Math.random() * 400));
  }
}

// ── Anti-ban: inbound FIFO queue ────────────────────────────────────────
// Every incoming WhatsApp message becomes a job. A single async worker
// pulls jobs one at a time, applies human-paced timing, and consumes a
// rate-bucket token before sending. This means 50 simultaneous inbound
// messages are processed sequentially over several minutes instead of
// bursting 50 robotic replies in the same second.
const inboundQueue = [];
let queueWorkerRunning = false;

function enqueueInbound(job) {
  inboundQueue.push(job);
  startQueueWorker();
}

function startQueueWorker() {
  if (queueWorkerRunning) return;
  queueWorkerRunning = true;
  (async () => {
    try {
      while (inboundQueue.length > 0) {
        const job = inboundQueue.shift();
        try {
          await processInboundJob(job);
        } catch (err) {
          console.error(`[queue ${ts()}] job for ${job?.sellerId}/${job?.from} crashed: ${err.message}`);
        }
      }
    } finally {
      queueWorkerRunning = false;
      // Race-safe restart: a new job may have landed between the empty
      // check and this finally block. Re-arm if so.
      if (inboundQueue.length > 0) startQueueWorker();
    }
  })();
}

/**
 * Process one inbound message end-to-end: pre-read jitter → read receipt
 * → online presence → call brain → typing presence → typed delay → send.
 * Every WhatsApp-visible side effect (presence updates, read receipts,
 * sendMessage) is independently try/catch'd so a hiccup in any single
 * step never drops the reply on the floor.
 */
async function processInboundJob(job) {
  const { sellerId, sock, msg, from, text } = job;

  // Guardrails are re-checked here because the job may have sat in the
  // queue long enough for quiet hours / daily cap to engage.
  if (isQuietHour()) {
    console.log(`[bridge ${ts()}] quiet hours active when dequeuing ${from} — dropping`);
    return;
  }
  if (isCapHit(sellerId)) {
    console.log(`[bridge ${ts()}] seller ${sellerId} daily cap hit on dequeue (${from})`);
    return;
  }

  // Per-user rate limit: never reply twice within PER_USER_RATE_MS to the
  // same contact (whether the second one is a fresh inbound or the queue
  // catching up).
  const rateKey = `${sellerId}|${from}`;
  const last = lastReplyAt.get(rateKey) || 0;
  if (Date.now() - last < PER_USER_RATE_MS) {
    console.log(`[bridge ${ts()}] per-user rate hit on dequeue (${from}) — dropping`);
    return;
  }

  // 1. Pre-read jitter — let "delivered" sit for a beat before turning
  //    blue. Then mark as read. Both steps are wrapped so a failure
  //    never stops us from replying.
  await sleep(jitter(PRE_READ_DELAY_MS, PRE_READ_DELAY_JITTER_MS));
  try { await sock.readMessages([msg.key]); } catch (e) {
    console.warn(`[bridge ${ts()}] readMessages failed (${from}): ${e.message} — continuing`);
  }
  await sleep(jitter(READ_DELAY_MS, READ_DELAY_JITTER_MS));
  try { await sock.sendPresenceUpdate('available', from); } catch (_) {}
  await sleep(jitter(ONLINE_DELAY_MS, ONLINE_DELAY_JITTER_MS));

  // 2. Resolve the REAL phone number from the message envelope, the LID
  //    mapping cache, and senderPn — whichever has it. Empty string if
  //    none of those sources have a real phone JID.
  const phoneDigits = await resolvePhoneFromMessage(sock, msg);
  if (phoneDigits) {
    console.log(`[bridge ${ts()}] resolved phone ${phoneDigits} for ${from}`);
  } else if (from.endsWith('@lid')) {
    console.log(`[bridge ${ts()}] no real phone resolvable yet for ${from} (LID-only contact)`);
  }

  let reply = '';
  try {
    const r = await axios.post(PY_WEBHOOK, {
      seller_id: sellerId,
      from,
      text,
      push_name: msg.pushName || null,
      message_id: msg.key?.id || null,
      sender_pn: phoneDigits || null,
    }, { timeout: 60_000 });
    reply = (r.data?.reply || '').trim();
  } catch (err) {
    console.error(`[bridge ${ts()}] brain call failed: ${err.message}`);
  }
  if (!reply) return;

  // 3. Optional micro-variation on the reply (kept very conservative —
  //    the brain already produces varied LLM output; this just nudges
  //    trailing punctuation occasionally to break exact-string repetition
  //    in WhatsApp's spam fingerprints).
  reply = maybeMutatePunctuation(reply);

  // 4. Wait for a global rate-bucket token. This is where bursts get
  //    smoothed: if 50 jobs queued up, only ~RATE_PER_MINUTE of them
  //    will progress past this line each minute.
  await waitForToken(`reply→${from}`);

  // 5. Composing presence + length-aware typing delay (3-8s window).
  try { await sock.sendPresenceUpdate('composing', from); } catch (_) {}
  await sleep(computeTypingMs(reply));
  try { await sock.sendPresenceUpdate('paused', from); } catch (_) {}

  // 6. Send. This is the only step that absolutely must run — everything
  //    above is humanization theater. If the actual send fails we log
  //    and bail; the customer will retry organically.
  try {
    await sock.sendMessage(from, { text: reply });
    lastReplyAt.set(rateKey, Date.now());
    const count = bumpDailyCounter(sellerId);
    console.log(`→ [${sellerId}] ${from}: ${reply.slice(0, 80)} (daily ${count}/${DAILY_CAP_DEFAULT}, bucket≈${bucketTokens.toFixed(1)}/${RATE_BUCKET_SIZE}, q=${inboundQueue.length})`);
  } catch (err) {
    console.error(`[bridge ${ts()}] send failed for ${from}: ${err.message}`);
  }
}

// ── LID → real phone number resolution ──────────────────────────────────
/**
 * WhatsApp's privacy migration replaces real phone JIDs with opaque "@lid"
 * identifiers for many contacts. The real phone number is hidden unless
 * the contact is in our address book, OR WhatsApp explicitly attached it
 * to the message envelope.
 *
 * Baileys exposes the phone counterpart in three places, in this priority
 * order:
 *
 *   1. `msg.key.remoteJidAlt` / `msg.key.participantAlt` — the "alternate"
 *      JID. When a message arrives on @lid, the @s.whatsapp.net version
 *      (real phone) is attached here if WhatsApp shared it.
 *   2. `signalRepository.lidMapping.getPNForLID(lid)` — Baileys' local
 *      cache of LID↔PN mappings, built up automatically from prior
 *      received messages and sync events.
 *   3. `msg.key.senderPn` — legacy field; sometimes echoes the LID itself
 *      back when no real phone is known, so we treat it as last-resort and
 *      reject same-as-LID echoes.
 *
 * Returns the bare phone digits (no @suffix, no +) or "" if no real phone
 * could be resolved. The brain prepends "+" when it builds the order row.
 */
async function resolvePhoneFromMessage(sock, msg) {
  const from = msg.key?.remoteJid || '';
  const lidIsLid = from.endsWith('@lid');

  // (1) The alternate-JID is the cleanest, free source — WhatsApp itself
  //     attaches it on the message envelope when willing to reveal the
  //     phone. No async/network call required.
  const alt = msg.key?.remoteJidAlt || msg.key?.participantAlt || '';
  if (alt && alt.includes('@s.whatsapp.net')) {
    return alt.split('@', 1)[0].split(':', 1)[0];
  }

  // (2) Cached LID mapping — Baileys auto-populates this when both the
  //     phone and LID for a contact have been seen in any message.
  if (lidIsLid && sock?.signalRepository?.lidMapping?.getPNForLID) {
    try {
      const pn = await sock.signalRepository.lidMapping.getPNForLID(from);
      if (pn && pn.includes('@s.whatsapp.net')) {
        return pn.split('@', 1)[0].split(':', 1)[0];
      }
    } catch (e) {
      console.warn(`[bridge ${ts()}] lidMapping.getPNForLID failed for ${from}: ${e.message}`);
    }
  }

  // (3) Legacy senderPn — only trust it if it's a real phone JID, NOT
  //     the LID dressed up as one.
  const senderPn = msg.key?.senderPn || msg.senderPn || msg.key?.participantPn || '';
  if (senderPn && senderPn.includes('@s.whatsapp.net')) {
    const senderDigits = senderPn.split('@', 1)[0].split(':', 1)[0];
    const lidDigits = lidIsLid ? from.split('@', 1)[0].split(':', 1)[0] : '';
    if (senderDigits && senderDigits !== lidDigits) {
      return senderDigits;
    }
  }

  // (4) Non-LID JID — the digits ARE the phone number.
  if (!lidIsLid && from) {
    return from.split('@', 1)[0].split(':', 1)[0];
  }

  return '';
}

// ── Anti-ban: gentle text mutation (optional) ───────────────────────────
// VERY conservative — we only nudge trailing punctuation ~20% of the
// time. The bot's voice should come from the LLM's varied output; this
// is just insurance against an identical greeting being blasted to 200
// numbers in an hour and being flagged as a templated spam pattern.
function maybeMutatePunctuation(text) {
  if (!text || text.length < 8) return text;
  if (Math.random() > 0.2) return text;
  // Trim a single trailing space if any, then swap final punctuation.
  const trimmed = text.replace(/\s+$/, '');
  const last = trimmed.slice(-1);
  if (last === '!') return trimmed.slice(0, -1) + (Math.random() < 0.5 ? '.' : ' 🙂');
  if (last === '.') return trimmed.slice(0, -1) + (Math.random() < 0.5 ? '!' : '…');
  if (last === '?') return trimmed + (Math.random() < 0.5 ? '' : ' 🙂');
  return trimmed;
}

// ── Baileys socket lifecycle (per seller) ───────────────────────────────
async function bootSellerSocket(sellerId) {
  if (sockets.has(sellerId)) {
    console.log(`[bridge ${ts()}] seller ${sellerId} already has a live socket — skip`);
    return sockets.get(sellerId);
  }
  const authDir = authDirFor(sellerId);
  if (!existsSync(authDir)) mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  // The default browser triple Baileys emits — ['Mac OS','Chrome','14.4.1']
  // — is a well-known anti-bot signature. WhatsApp's pairing flow has
  // started silently rejecting connections that advertise it (user enters
  // the code, server logs them in, then server immediately bounces with
  // 401 → "Couldn't link device" on the phone). Claiming WhatsApp Desktop
  // on Windows instead gets through.
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    auth: state,
    browser: Browsers.windows('Desktop'),
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    // Recent Baileys versions expect a logger; passing the noop pino logger
    // from Baileys' Defaults silences harmless info chatter without breaking
    // error visibility.
  });

  // Track state per seller.
  if (!stateBySeller.has(sellerId)) {
    stateBySeller.set(sellerId, {
      status: 'pending', jid: null, phone: null,
      qrDataUrl: null, pairingCode: null, lastError: null,
      connectedAt: null, lastSeenAt: null,
    });
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const st = stateBySeller.get(sellerId);
    if (qr) {
      try { st.qrDataUrl = await qrcode.toDataURL(qr); } catch (_) {}
    }
    if (connection === 'open') {
      st.status = 'connected';
      st.jid = sock?.user?.id || null;
      st.connectedAt = new Date().toISOString();
      st.qrDataUrl = null; st.pairingCode = null; st.lastError = null;
      console.log(`[bridge ${ts()}] seller ${sellerId} CONNECTED · ${st.jid}`);
    } else if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      st.status = 'disconnected';
      st.lastError = lastDisconnect?.error?.message || '';
      console.log(`[bridge ${ts()}] seller ${sellerId} disconnected (code=${code})`);
      sockets.delete(sellerId);

      // Reconnect strategy depends on what state we're in:
      //
      //  (A) Pair-in-progress (creds.me.id set but registered=false): the
      //      server issued a pairing code and closed the socket, expecting
      //      the user to enter the code on their phone. We must KEEP
      //      reconnecting (every ~10s, for up to PAIR_WAIT_MS) so that
      //      once the user enters the code, our next passive login
      //      succeeds. Without this loop, the pair window closes after
      //      one 401 and the seller hits "Couldn't link device".
      //
      //  (B) Transient network issue on a fully paired socket: reconnect
      //      quickly (2s) so customer messages don't get dropped.
      //
      //  (C) Anything else (401 loggedOut on a normal session, 403, …):
      //      give up — operator must re-pair.
      const meId = sock?.authState?.creds?.me?.id || '';
      const isRegistered = !!sock?.authState?.creds?.registered;
      const isPairing = !!meId && !isRegistered;

      const NORMAL_TRANSIENT = new Set([408, 428, DisconnectReason.restartRequired]);

      // SPECIAL CASE — 515 (restartRequired) immediately AFTER successful
      // pair: Baileys logs "pairing configured successfully" then deliber-
      // ately disconnects so we can reconnect with the freshly-saved creds
      // to enter the authenticated session. ALWAYS reconnect on 515,
      // regardless of isPairing — otherwise the pair never completes.
      if (code === DisconnectReason.restartRequired) {
        console.log(`[bridge ${ts()}] post-pair restart for ${sellerId} — reconnecting with new creds`);
        setTimeout(() => bootSellerSocket(sellerId).catch(e => console.error(e)), 2000);
      } else if (isPairing) {
        // DURING PAIRING (anything other than 515): don't auto-reconnect.
        // Rapid 401 reconnects look bot-like and trigger soft-bans.
        console.log(`[bridge ${ts()}] pair attempt for ${sellerId} ended with code=${code}; NOT auto-reconnecting (anti-ban). User can click Generate to retry.`);
        pairingState.delete(sellerId);
      } else if (NORMAL_TRANSIENT.has(code)) {
        // Fully paired session lost a network blip — safe to reconnect fast.
        setTimeout(() => bootSellerSocket(sellerId).catch(e => console.error(e)), 2000);
      } else {
        pairingState.delete(sellerId);
      }
    } else if (connection === 'open') {
      // Successful (re)connection — clear any pair-wait tracking for this
      // seller so a future pair-attempt starts from a clean window.
      pairingState.delete(sellerId);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key?.fromMe) continue;
      const from = msg.key?.remoteJid;
      if (!from || from.endsWith('@g.us')) continue; // skip group chats for now

      const text =
        msg.message.conversation
        || msg.message.extendedTextMessage?.text
        || msg.message.imageMessage?.caption
        || '';
      if (!text) continue;

      const st = stateBySeller.get(sellerId);
      if (st) st.lastSeenAt = new Date().toISOString();

      // Early guardrails — drop before queuing so the queue never fills
      // with messages we're going to ignore anyway.
      if (isQuietHour()) {
        console.log(`[bridge ${ts()}] quiet hours active — not queuing ${from}`);
        continue;
      }
      if (isCapHit(sellerId)) {
        console.log(`[bridge ${ts()}] seller ${sellerId} daily cap reached — not queuing ${from}`);
        continue;
      }
      const rateKey = `${sellerId}|${from}`;
      const last = lastReplyAt.get(rateKey) || 0;
      if (Date.now() - last < PER_USER_RATE_MS) {
        console.log(`[bridge ${ts()}] per-user rate hit (${from}) — not queuing`);
        continue;
      }

      // Hand off to the FIFO queue. The worker (see processInboundJob)
      // applies pre-read jitter, calls brain, paces typing, and consumes
      // a global rate-bucket token before each send.
      enqueueInbound({ sellerId, sock, msg, from, text });
      if (inboundQueue.length > 3) {
        console.log(`[bridge ${ts()}] queue depth=${inboundQueue.length} (burst smoothing engaged)`);
      }
    }
  });

  sockets.set(sellerId, sock);
  return sock;
}

async function tearDownSellerSocket(sellerId, wipeAuth = false) {
  const sock = sockets.get(sellerId);
  if (sock) {
    try { await sock.logout(); } catch (_) {}
    try { sock.end(); } catch (_) {}
    sockets.delete(sellerId);
  }
  if (wipeAuth) {
    const dir = authDirFor(sellerId);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  const st = stateBySeller.get(sellerId);
  if (st) { st.status = 'disconnected'; st.jid = null; st.qrDataUrl = null; st.pairingCode = null; }
}

// ── Express HTTP ────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '1mb' }));

// CORS — only allow the admin origins.
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (ADMIN_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Localhost-only gate for endpoints that mutate WhatsApp state.
function requireLocalhost(req, res, next) {
  const remote = req.ip || req.socket?.remoteAddress || '';
  if (!remote.includes('127.0.0.1') && remote !== '::1' && !remote.endsWith('::ffff:127.0.0.1')) {
    return res.status(403).json({ ok: false, error: 'forbidden — localhost only' });
  }
  next();
}

app.get('/api/status', (req, res) => {
  const sellerId = (req.query.seller_id || '').toString();
  if (!sellerId) {
    return res.json({
      ok: true,
      sellers: Array.from(stateBySeller.entries()).map(([id, st]) => ({ seller_id: id, ...st })),
    });
  }
  const st = stateBySeller.get(sellerId) || { status: 'never_paired' };
  res.json({ ok: true, seller_id: sellerId, ...st });
});

app.post('/api/pair', requireLocalhost, async (req, res) => {
  const { seller_id, phone } = req.body || {};
  if (!seller_id) return res.status(400).json({ ok: false, error: 'seller_id required' });
  try {
    // If the seller already has a connected socket, surface that — no need
    // to re-pair an active session.
    const existingSt = stateBySeller.get(seller_id);
    if (existingSt?.status === 'connected') {
      return res.json({ ok: true, alreadyConnected: true, jid: existingSt.jid });
    }

    // Decide whether to wipe auth_info or keep it.
    //
    //  • If the user provided a phone number → they're starting a fresh
    //    pairing flow. Persisted creds (from an old paired account or a
    //    half-finished previous attempt) will collide with the new
    //    registration and trigger a 401 → reconnect → 401 loop. Wipe.
    //  • If no phone provided → caller is just refreshing the QR/state of
    //    an existing pairing. Keep auth_info so a paired seller can come
    //    back online.
    const shouldWipeAuth = !!String(phone || '').trim();

    // Fresh attempt — reset the pair-wait counter so the new disconnect-
    // retry loop gets the full 3-minute window.
    pairingState.delete(seller_id);

    if (sockets.has(seller_id)) {
      console.log(`[bridge ${ts()}] tearing down stale socket for ${seller_id} before re-pair (wipeAuth=${shouldWipeAuth})`);
      await tearDownSellerSocket(seller_id, shouldWipeAuth);
    } else if (shouldWipeAuth) {
      // No live socket but persisted creds may belong to a different
      // number or be from a failed half-attempt — wipe before
      // bootSellerSocket reads them.
      const dir = authDirFor(seller_id);
      if (existsSync(dir)) {
        console.log(`[bridge ${ts()}] wiping stale auth_info for ${seller_id} before pairing (phone=${phone})`);
        rmSync(dir, { recursive: true, force: true });
      }
    }

    let sock = await bootSellerSocket(seller_id);
    let pairingCode = null;

    if (phone && !sock.authState.creds.registered) {
      const digits = String(phone).replace(/[^\d]/g, '');

      // Two failure modes we need to defend against:
      //
      //  (a) requestPairingCode called too early — Baileys' WebSocket
      //      noise handshake hasn't completed, request is dropped with
      //      "Connection Closed". Wait long enough for the handshake.
      //
      //  (b) Pairing partially completes server-side, the socket then
      //      dies before the server confirms registration. Baileys has
      //      already written creds.me.id = "<digits>@s.whatsapp.net" to
      //      disk (it does this BEFORE sending the request — see Baileys
      //      socket.js → requestPairingCode), but creds.registered is
      //      still false. Every subsequent boot reads that half-state
      //      and tries a passive login as the half-registered phone,
      //      hitting 401 every time. The cure: when requestPairingCode
      //      throws, wipe auth_info + re-boot before retrying / giving
      //      up, so the next attempt starts from a clean slate.
      const MAX_ATTEMPTS = 2;
      let lastErr = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        await sleep(attempt === 1 ? 3000 : 4500);
        try {
          pairingCode = await sock.requestPairingCode(digits);
          console.log(`[bridge ${ts()}] pairing code for ${seller_id} (${digits}): ${pairingCode}`);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          console.warn(`[bridge ${ts()}] requestPairingCode attempt ${attempt}/${MAX_ATTEMPTS} failed: ${e.message}`);
          // Half-state recovery: tear down, wipe, re-boot before next try.
          try { await tearDownSellerSocket(seller_id, true); } catch (_) {}
          if (attempt < MAX_ATTEMPTS) {
            sock = await bootSellerSocket(seller_id);
          }
        }
      }
      if (lastErr && !pairingCode) {
        return res.status(502).json({
          ok: false,
          error: `Pairing code request failed: ${lastErr.message}. Wait 10-15s and click Generate again.`,
        });
      }
    } else if (sock.authState.creds.registered) {
      // Already paired — just waiting for connection.update 'open' to fire.
      console.log(`[bridge ${ts()}] seller ${seller_id} already has creds — waiting for reconnect`);
    }

    const st = stateBySeller.get(seller_id);
    if (st && pairingCode) st.pairingCode = pairingCode;
    res.json({ ok: true, pairingCode, qrDataUrl: st?.qrDataUrl || null });
  } catch (err) {
    console.error(`[bridge ${ts()}] /api/pair error:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/unpair', requireLocalhost, async (req, res) => {
  const { seller_id } = req.body || {};
  if (!seller_id) return res.status(400).json({ ok: false, error: 'seller_id required' });
  await tearDownSellerSocket(seller_id, true);
  res.json({ ok: true });
});

// Debug endpoint — query the Baileys lidMapping cache to see whether
// Baileys has a real-phone mapping for a given @lid. Useful for
// troubleshooting "why isn't the customer phone showing up?".
//   GET /api/lookup-phone?seller_id=...&lid=59305176883288@lid
app.get('/api/lookup-phone', requireLocalhost, async (req, res) => {
  const sellerId = (req.query.seller_id || '').toString();
  const lid      = (req.query.lid || '').toString();
  if (!sellerId || !lid) {
    return res.status(400).json({ ok: false, error: 'seller_id and lid required' });
  }
  const sock = sockets.get(sellerId);
  if (!sock) return res.status(404).json({ ok: false, error: 'no live socket for seller' });
  try {
    const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(lid);
    res.json({ ok: true, lid, pn: pn || null, hint: pn ? 'real phone known' : 'no mapping cached — contact may not have been resolved yet' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/send', requireLocalhost, async (req, res) => {
  const { seller_id, jid, text } = req.body || {};
  if (!seller_id || !jid || !text) {
    return res.status(400).json({ ok: false, error: 'seller_id, jid, text all required' });
  }
  const sock = sockets.get(seller_id);
  const st = stateBySeller.get(seller_id);
  if (!sock || st?.status !== 'connected') {
    return res.status(503).json({ ok: false, error: `seller socket not connected (status=${st?.status})` });
  }
  if (isQuietHour()) return res.status(429).json({ ok: false, reason: 'quiet_hours' });
  if (isCapHit(seller_id)) return res.status(429).json({ ok: false, reason: 'daily_cap' });

  // Outbound (proactive) sends share the global rate-bucket so admin-
  // initiated messages can't bypass the throttle and trip WhatsApp's
  // spam fingerprint detection.
  await waitForToken(`outbound→${jid}`);
  try {
    try { await sock.sendPresenceUpdate('available', jid); } catch (_) {}
    await sleep(jitter(ONLINE_DELAY_MS, ONLINE_DELAY_JITTER_MS));
    try { await sock.sendPresenceUpdate('composing', jid); } catch (_) {}
    await sleep(computeTypingMs(String(text)));
    try { await sock.sendPresenceUpdate('paused', jid); } catch (_) {}
    await sock.sendMessage(jid, { text: maybeMutatePunctuation(String(text)) });
    lastReplyAt.set(`${seller_id}|${jid}`, Date.now());
    const count = bumpDailyCounter(seller_id);
    console.log(`→ [outbound ${seller_id}] ${jid}: ${String(text).slice(0, 80)} (daily ${count}/${DAILY_CAP_DEFAULT}, bucket≈${bucketTokens.toFixed(1)}/${RATE_BUCKET_SIZE})`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[outbound] send failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * Inspect a persisted creds.json and classify the state. Returns one of:
 *   'paired'      — registered=true; safe to auto-reconnect.
 *   'half-baked'  — registered=false but me.id is set (a previous pairing
 *                   attempt died mid-flight). Auto-reconnect would just
 *                   loop 401 forever; wipe is the only recovery.
 *   'empty'       — no creds yet or unreadable; nothing to do.
 */
function classifySellerAuth(sellerId) {
  const credsPath = resolve(authDirFor(sellerId), 'creds.json');
  if (!existsSync(credsPath)) return 'empty';
  try {
    const raw = JSON.parse(readFileSync(credsPath, 'utf8'));
    if (raw?.registered === true) return 'paired';
    if (raw?.me?.id) return 'half-baked';
    return 'empty';
  } catch (_) {
    return 'empty';
  }
}

/**
 * On startup, scan the auth_info root for any persisted seller sessions
 * and reconnect them automatically. Without this step, restarting the
 * bridge would knock every paired seller offline until someone clicks
 * "Pair" again from the admin UI — an unacceptable user experience for
 * a multi-tenant SaaS. Baileys uses the saved creds in auth_info/seller_*
 * to skip the QR/pairing-code step entirely; the socket comes back
 * within 5-10s as if it had never gone away.
 *
 * Half-baked auth folders (registered=false but me.id set, left over
 * from a failed pairing attempt) are wiped here instead of reconnected —
 * Baileys would just loop 401 forever otherwise.
 */
async function autoReconnectKnownSellers() {
  if (!existsSync(AUTH_ROOT)) return;
  let entries;
  try {
    entries = readdirSync(AUTH_ROOT, { withFileTypes: true });
  } catch (err) {
    console.warn(`[bridge ${ts()}] could not scan ${AUTH_ROOT}: ${err.message}`);
    return;
  }
  const sellerIds = entries
    .filter(e => e.isDirectory() && e.name.startsWith('seller_'))
    .map(e => e.name.replace(/^seller_/, ''));
  if (!sellerIds.length) {
    console.log(`[bridge ${ts()}] no persisted seller sessions to auto-reconnect`);
    return;
  }

  const toReconnect = [];
  for (const sellerId of sellerIds) {
    const state = classifySellerAuth(sellerId);
    if (state === 'paired') {
      toReconnect.push(sellerId);
    } else if (state === 'half-baked') {
      console.log(`[bridge ${ts()}] wiping half-baked auth_info for ${sellerId} (failed prior pair attempt — will not auto-reconnect)`);
      try { rmSync(authDirFor(sellerId), { recursive: true, force: true }); } catch (_) {}
      // Mark the seller's state so the admin UI shows "never paired"
      // instead of looking eternally "disconnected".
      stateBySeller.set(sellerId, {
        status: 'disconnected', jid: null, phone: null,
        qrDataUrl: null, pairingCode: null,
        lastError: 'previous pairing attempt was incomplete — please pair again',
        connectedAt: null, lastSeenAt: null,
      });
    }
  }
  if (!toReconnect.length) {
    console.log(`[bridge ${ts()}] no fully-paired sellers to auto-reconnect`);
    return;
  }
  console.log(`[bridge ${ts()}] auto-reconnecting ${toReconnect.length} seller(s) from ${AUTH_ROOT}`);
  for (const sellerId of toReconnect) {
    bootSellerSocket(sellerId).catch(err => {
      console.error(`[bridge ${ts()}] auto-reconnect for ${sellerId} failed: ${err.message}`);
    });
  }
}

app.listen(PORT, () => {
  console.log(`[bridge ${ts()}] listening on :${PORT}`);
  console.log(`[bridge ${ts()}] brain webhook → ${PY_WEBHOOK}`);
  console.log(`[bridge ${ts()}] admin origins → ${ADMIN_ORIGINS.join(', ')}`);
  console.log(`[bridge ${ts()}] auth root → ${AUTH_ROOT}/seller_<id>/`);
  console.log(`[bridge ${ts()}] anti-ban: quiet ${QUIET_START}-${QUIET_END} ${QUIET_TZ}, daily cap ${DAILY_CAP_DEFAULT}/seller, per-user rate ${PER_USER_RATE_MS}ms`);
  console.log(`[bridge ${ts()}] throttle: ${RATE_PER_MINUTE} msgs/min (burst ${RATE_BUCKET_SIZE}), typing ${TYPING_MIN_MS}-${TYPING_MAX_MS}ms @ ${TYPING_PER_CHAR_MS}ms/char, pre-read ${PRE_READ_DELAY_MS}-${PRE_READ_DELAY_MS + PRE_READ_DELAY_JITTER_MS}ms`);
  autoReconnectKnownSellers();
  // TODO Phase 3: read seller_whatsapp_sessions where status='connected'
  // from Supabase and call bootSellerSocket for each, so the bridge
  // automatically restores all paired accounts on restart.
});
