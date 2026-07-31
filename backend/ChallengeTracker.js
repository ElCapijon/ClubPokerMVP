// ============================================================
// ChallengeTracker.js - Stat-driven challenge/quest tracking
//
// Single trackStat(userId, statName, amount) function replaces
// all custom hooks. Quests are milestone targets on stat names.
// In-memory cache with async DB flush — never blocks game loop.
// ============================================================

const db = require('./db');

// ─── In-Memory Cache ──────────────────────────────────────
// Structure: Map<userId, Map<challengeId, { progress, dirty }>>
const progressCache = new Map();

// Cached challenge definitions (loaded once at server start)
// Array of { id, stat, name, description, target_value }
let definitionsCache = [];

// Index definitions by stat name for O(1) lookup
// Map<statName, Array<definition>>
let definitionsByStat = new Map();

// io instance for real-time socket notifications
let ioInstance = null;

// Map<userId, socketId> for looking up connected sockets by userId
let userIdToSocket = null;

// Batch flush interval handle
let flushIntervalHandle = null;

// ─── Initialization ───────────────────────────────────────

/**
 * Initialize the tracker: load challenge definitions and start batch flush timer.
 * @param {Object} io - Socket.io server instance
 * @param {Map<string, string>} userSocketMap - Map<userId, socketId>
 */
async function init(io, userSocketMap) {
  ioInstance = io;
  userIdToSocket = userSocketMap || new Map();

  try {
    const result = await db.query('SELECT * FROM challenge_definitions ORDER BY id');
    definitionsCache = result.rows;
    // Build index by stat name
    definitionsByStat = new Map();
    for (const def of definitionsCache) {
      const stat = def.stat;
      if (!definitionsByStat.has(stat)) {
        definitionsByStat.set(stat, []);
      }
      definitionsByStat.get(stat).push(def);
    }
    console.log(`[Challenges] Loaded ${definitionsCache.length} definitions across ${definitionsByStat.size} stats`);
  } catch (err) {
    console.error('[Challenges] Failed to load definitions:', err.message);
    definitionsCache = [];
    definitionsByStat = new Map();
  }

  // Flush dirty progress to DB every 15 seconds
  flushIntervalHandle = setInterval(() => flushAll(), 15000);
  console.log('[Challenges] Tracker initialized with 15s batch flush interval');
}

/**
 * Shutdown the tracker (clear interval, flush remaining).
 */
function shutdown() {
  if (flushIntervalHandle) {
    clearInterval(flushIntervalHandle);
    flushIntervalHandle = null;
  }
  flushAll();
}

// ─── Core Stat Tracking ───────────────────────────────────

/**
 * Increment a stat counter for a user. Looks up all challenge
 * definitions matching this stat name and advances progress.
 *
 * @param {string} userId
 * @param {string} statName - e.g., 'handsPlayed', 'handsWon', 'flushMade'
 * @param {number} [amount=1] - How much to increment by
 */
function trackStat(userId, statName, amount = 1) {
  if (!userId || !statName) return;
  if (amount <= 0) return;

  const applicable = definitionsByStat.get(statName);
  if (!applicable || applicable.length === 0) return;

  for (const def of applicable) {
    if (!progressCache.has(userId)) {
      progressCache.set(userId, new Map());
    }

    const userMap = progressCache.get(userId);
    const current = userMap.get(def.id)?.progress || 0;

    // Don't increment past target
    const newProgress = Math.min(current + amount, def.target_value);
    const wasCompleted = current >= def.target_value;
    const nowCompleted = newProgress >= def.target_value;

    userMap.set(def.id, {
      progress: newProgress,
      isCompleted: nowCompleted,
      dirty: true,
    });

    // Emit real-time notification on first completion
    if (nowCompleted && !wasCompleted && ioInstance && userIdToSocket) {
      const completionData = {
        challengeId: def.id,
        name: def.name,
        description: def.description,
        stat: def.stat,
      };

      const socketId = userIdToSocket.get(userId);
      if (socketId) {
        ioInstance.to(socketId).emit('challenge_completed', completionData);
        console.log(`[Challenges] User ${userId} completed: ${def.name} (${statName})`);
      }
    }
  }
}

// ─── Progress Queries ─────────────────────────────────────

/**
 * Get aggregated progress for a user (definitions + progress).
 * Returns an array sorted by stat/name.
 */
async function getUserProgress(userId) {
  const result = await db.query(
    `SELECT cd.*, ucp.progress, ucp.is_completed, ucp.completed_at
     FROM challenge_definitions cd
     LEFT JOIN user_challenge_progress ucp ON cd.id = ucp.challenge_id AND ucp.user_id = $1
     ORDER BY cd.id`,
    [userId]
  );

  return result.rows.map(row => ({
    id: row.id,
    stat: row.stat,
    name: row.name,
    description: row.description,
    targetValue: row.target_value,
    progress: row.progress || 0,
    isCompleted: row.is_completed || false,
    completedAt: row.completed_at,
  }));
}

// ─── Batch Database Flush ─────────────────────────────────

async function flushUser(userId) {
  const userProgress = progressCache.get(userId);
  if (!userProgress) return;

  for (const [challengeId, data] of userProgress) {
    if (!data.dirty) continue;

    try {
      await db.query(
        `INSERT INTO user_challenge_progress (user_id, challenge_id, progress, is_completed, completed_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (user_id, challenge_id)
         DO UPDATE SET
           progress = CASE WHEN user_challenge_progress.progress < EXCLUDED.progress OR user_challenge_progress.is_completed = FALSE THEN EXCLUDED.progress ELSE user_challenge_progress.progress END,
           is_completed = CASE WHEN EXCLUDED.is_completed OR user_challenge_progress.is_completed THEN TRUE ELSE FALSE END,
           completed_at = CASE WHEN EXCLUDED.is_completed AND user_challenge_progress.completed_at IS NULL THEN NOW() ELSE user_challenge_progress.completed_at END,
           updated_at = NOW()`,
        [userId, challengeId, data.progress, data.isCompleted,
         data.isCompleted ? new Date().toISOString() : null]
      );
      data.dirty = false;
    } catch (err) {
      console.error(`[Challenges] DB flush error for user ${userId}, challenge ${challengeId}:`, err.message);
    }
  }
}

async function flushAll() {
  const dirtyUsers = [];
  for (const [userId, userMap] of progressCache) {
    let hasDirty = false;
    for (const [, data] of userMap) {
      if (data.dirty) { hasDirty = true; break; }
    }
    if (hasDirty) dirtyUsers.push(userId);
  }

  if (dirtyUsers.length === 0) return;

  for (const userId of dirtyUsers) {
    await flushUser(userId);
  }
}

module.exports = {
  init,
  shutdown,
  trackStat,
  getUserProgress,
};
