// sseHub.mjs
//
// 07-applier/04-multi-step/m9 — In-process SSE broadcast hub.
//
// One subscriber set per jobId. The /events route adds the Express
// Response as a subscriber; the live state machine (and Phase 2/m6
// observer once wired) calls broadcast(jobId, event, payload) to fan
// out an event to all listeners.
//
// Memory shape: jobId → Set<Response>. Sets are dropped when empty.
// Each Response also gets a heartbeat ping every 15s so reverse
// proxies don't kill the connection.
//
// Cross-process: NONE — this is a single-process module. If we add
// horizontal scaling later we'd need a pub/sub backend (Redis), but
// the applier runs single-instance today and there's no plan to
// change that. Documented constraint.

const _subscribersByJob = new Map();  // jobId → Set<res>

/** Default heartbeat interval — small enough to keep nginx / Vercel
 *  from killing idle SSE connections (their defaults are ~60s). */
const HEARTBEAT_MS = 15_000;

/** Last few events PER jobId so a reconnecting client can catch up
 *  without missing edge cases (e.g. user typed during reconnect).
 *  Cap small — events are also persisted in the session envelope
 *  via the higher-level adapter; this is a tail buffer, not history. */
const REPLAY_BUFFER_SIZE = 20;
const _replayByJob = new Map();  // jobId → [{ event, payload, ts }]

/**
 * Add an Express Response as a subscriber. Returns an unsubscribe
 * function. Writes the SSE headers immediately so curl sees them.
 *
 * @param {string} jobId
 * @param {import('express').Response} res
 * @param {{ heartbeatMs?: number, replay?: boolean }} [opts]
 * @returns {() => void}
 */
export function subscribe(jobId, res, opts = {}) {
  if (!jobId || typeof jobId !== 'string') {
    throw new Error('sseHub.subscribe: jobId required');
  }
  if (!res || typeof res.write !== 'function') {
    throw new Error('sseHub.subscribe: response object required');
  }
  // SSE headers. CORS isn't an issue because the dashboard + applier
  // share an origin; CSP-friendly Content-Type.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');  // nginx — disable buffering
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  // Initial hello so the EventSource onopen fires immediately.
  res.write(': hello\n\n');

  let set = _subscribersByJob.get(jobId);
  if (!set) {
    set = new Set();
    _subscribersByJob.set(jobId, set);
  }
  set.add(res);

  // Replay buffered events (the catch-up tail). Default ON because
  // most callers reconnect via EventSource's automatic retry and want
  // to not miss events typed during the brief outage.
  if (opts.replay !== false) {
    const buf = _replayByJob.get(jobId);
    if (buf && buf.length > 0) {
      for (const item of buf) {
        writeSseEvent(res, item.event, item.payload, item.ts);
      }
    }
  }

  // Heartbeat — every HEARTBEAT_MS, send a comment line (`:ping`).
  // SSE clients ignore comment lines but proxies see traffic and
  // keep the connection alive.
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const ping = setInterval(() => {
    try { res.write(`: ping ${Date.now()}\n\n`); }
    catch { /* socket closed — close will fire and clean up */ }
  }, heartbeatMs);
  // Don't keep the process alive just for heartbeats (smoke/CI).
  if (typeof ping.unref === 'function') ping.unref();

  const cleanup = () => {
    clearInterval(ping);
    const s = _subscribersByJob.get(jobId);
    if (s) {
      s.delete(res);
      if (s.size === 0) _subscribersByJob.delete(jobId);
    }
  };

  // Auto-clean on socket close (browser nav away, EventSource.close()).
  res.on('close', cleanup);
  // Some servers emit 'aborted' instead of 'close'.
  res.on('aborted', cleanup);

  return cleanup;
}

/**
 * Broadcast an event to all subscribers for a jobId. Records the event
 * in the per-job replay buffer (capped). Returns the number of live
 * subscribers reached.
 *
 * @param {string} jobId
 * @param {string} event — SSE event name (e.g., 'field_input')
 * @param {object} payload — JSON-serializable payload
 * @returns {number} reached
 */
export function broadcast(jobId, event, payload) {
  if (!jobId || typeof jobId !== 'string') return 0;
  if (!event || typeof event !== 'string') return 0;
  const ts = Date.now();

  // Tail buffer for reconnect replay.
  let buf = _replayByJob.get(jobId);
  if (!buf) {
    buf = [];
    _replayByJob.set(jobId, buf);
  }
  buf.push({ event, payload, ts });
  while (buf.length > REPLAY_BUFFER_SIZE) buf.shift();

  const set = _subscribersByJob.get(jobId);
  if (!set || set.size === 0) return 0;

  let reached = 0;
  // Snapshot to a list — handlers may call subscribe()/cleanup()
  // synchronously through `res.on('close')` which would mutate the
  // Set during iteration.
  const snapshot = [...set];
  for (const res of snapshot) {
    try {
      writeSseEvent(res, event, payload, ts);
      reached++;
    } catch {
      // Write failed (probably closed socket) — remove from set so
      // we don't keep retrying.
      set.delete(res);
    }
  }
  return reached;
}

/** Write one SSE event frame. Caller catches throws. */
function writeSseEvent(res, event, payload, ts) {
  let json;
  try { json = JSON.stringify({ ...payload, ts }); }
  catch { json = JSON.stringify({ _error: 'unserializable payload', ts }); }
  // event + data lines, terminated by blank line.
  res.write(`event: ${event}\n`);
  res.write(`data: ${json}\n\n`);
}

/** Subscriber count — useful for smoke + a /status debug hit. */
export function subscriberCount(jobId) {
  const set = _subscribersByJob.get(jobId);
  return set ? set.size : 0;
}

/** Test hook — drop everything (subscriber sets + replay buffers).
 *  Mostly for smoke isolation. Doesn't close sockets — caller handles
 *  that explicitly via the unsubscribe fn or socket close. */
export function _resetForTests() {
  _subscribersByJob.clear();
  _replayByJob.clear();
}
