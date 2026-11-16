// usage.js — process-level daily usage registry for the NVIDIA 模型组.
// Pure logic, zero dependencies, unit-testable. Records one entry per model
// attempt made by the failover engine so the panel can show, per day:
//   • overall calls / success / failure / auto-failover count / tokens
//   • per-model usage (calls, ok, fail, avg first-byte, tokens)
//   • a rolling log of the most recent attempts (with failover provenance)

const DAY_MS = 24 * 60 * 60 * 1000;

/** Format a timestamp as a local-day key `YYYY-MM-DD`. */
export function dayKeyOf(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function emptyDay() {
  return {
    total: { calls: 0, ok: 0, fail: 0, failovers: 0, inputTokens: 0, outputTokens: 0 },
    members: new Map(),
    log: [],
  };
}

function emptyMember() {
  return {
    calls: 0,
    ok: 0,
    fail: 0,
    failovers: 0,
    inputTokens: 0,
    outputTokens: 0,
    lastAt: 0,
    lastError: '',
    sumFirstByteMs: 0,
    firstByteSamples: 0,
  };
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * @param {object} [opts]
 * @param {() => number} [opts.now] clock (defaults to Date.now)
 * @param {number} [opts.retentionDays] how many day buckets to keep (default 7)
 * @param {number} [opts.maxLogPerDay] rolling log cap per day (default 200)
 */
export function createUsageRegistry(opts = {}) {
  const clock = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const retentionDays = Number.isFinite(opts.retentionDays) && opts.retentionDays > 0 ? opts.retentionDays : 7;
  const maxLogPerDay =
    Number.isFinite(opts.maxLogPerDay) && opts.maxLogPerDay > 0 ? Math.floor(opts.maxLogPerDay) : 200;

  /** @type {Map<string, ReturnType<typeof emptyDay>>} */
  const days = new Map();

  function dayFor(at) {
    const key = dayKeyOf(at);
    let day = days.get(key);
    if (!day) {
      day = emptyDay();
      days.set(key, day);
    }
    return day;
  }

  function prune() {
    const cutoff = clock() - retentionDays * DAY_MS;
    for (const key of [...days.keys()]) {
      // Parse the local-day key back to a timestamp; drop buckets older than retention.
      const [y, m, d] = key.split('-').map((x) => Number(x));
      const t = new Date(y, m - 1, d).getTime();
      if (Number.isFinite(t) && t < cutoff) days.delete(key);
    }
  }

  /**
   * Record one attempt (one member tried). Returns the stored log entry.
   * @param {object} entry
   * @param {number} [entry.at] timestamp (defaults to clock())
   * @param {string} [entry.sessionId]
   * @param {string} entry.memberId
   * @param {boolean} entry.ok
   * @param {boolean} [entry.failover] this attempt was reached via failover
   * @param {string|number} [entry.failoverFrom] member we failed over from
   * @param {number} [entry.firstByteMs]
   * @param {number} [entry.elapsedMs]
   * @param {number} [entry.inputTokens]
   * @param {number} [entry.outputTokens]
   * @param {string} [entry.error]
   */
  function record(entry = {}) {
    const at = Number.isFinite(entry.at) ? entry.at : clock();
    const day = dayFor(at);
    const memberId = String(entry.memberId || 'unknown');
    const ok = !!entry.ok;

    let m = day.members.get(memberId);
    if (!m) {
      m = emptyMember();
      day.members.set(memberId, m);
    }

    const inputTokens = num(entry.inputTokens);
    const outputTokens = num(entry.outputTokens);
    const firstByteMs = num(entry.firstByteMs);

    day.total.calls += 1;
    day.total.inputTokens += inputTokens;
    day.total.outputTokens += outputTokens;
    m.calls += 1;
    m.inputTokens += inputTokens;
    m.outputTokens += outputTokens;
    m.lastAt = at;
    if (ok) {
      day.total.ok += 1;
      m.ok += 1;
      if (firstByteMs > 0) {
        m.sumFirstByteMs += firstByteMs;
        m.firstByteSamples += 1;
      }
    } else {
      day.total.fail += 1;
      m.fail += 1;
      m.lastError = String(entry.error || '');
    }
    if (entry.failover) {
      day.total.failovers += 1;
      m.failovers += 1;
    }

    const logEntry = {
      at,
      memberId,
      ok,
      failover: !!entry.failover,
      failoverFrom: entry.failoverFrom != null ? String(entry.failoverFrom) : '',
      firstByteMs,
      elapsedMs: num(entry.elapsedMs),
      inputTokens,
      outputTokens,
      error: String(entry.error || ''),
    };
    day.log.push(logEntry);
    if (day.log.length > maxLogPerDay) {
      day.log.splice(0, day.log.length - maxLogPerDay);
    }
    return logEntry;
  }

  /** Return a plain, serialisable summary of one day (default today). */
  function snapshot(dayKey) {
    const key = dayKey || dayKeyOf(clock());
    const day = days.get(key) || emptyDay();
    const members = [];
    for (const [id, m] of day.members) {
      members.push({
        id,
        calls: m.calls,
        ok: m.ok,
        fail: m.fail,
        failovers: m.failovers,
        avgFirstByteMs: m.firstByteSamples > 0 ? Math.round(m.sumFirstByteMs / m.firstByteSamples) : 0,
        inputTokens: m.inputTokens,
        outputTokens: m.outputTokens,
        lastAt: m.lastAt,
        lastError: m.lastError,
      });
    }
    members.sort((a, b) => b.calls - a.calls);
    const log = day.log.slice().reverse();
    return {
      day: key,
      total: { ...day.total },
      members,
      log,
    };
  }

  /** Wipe one day's stats, or everything when no dayKey is given. */
  function reset(dayKey) {
    if (dayKey) {
      days.delete(dayKey);
    } else {
      days.clear();
    }
  }

  /** List the day keys currently retained (newest last). */
  function days_() {
    return [...days.keys()].sort();
  }

  return { record, snapshot, reset, prune, days: days_ };
}
