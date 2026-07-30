// ============================================================
// ChallengeTracker.js - Non-blocking challenge/quest tracking
//
// Maintains an in-memory progress cache and asynchronously
// flushes updates to the database. Never blocks the game loop.
// ============================================================

const db = require('./db');

// ─── In-Memory Cache ──────────────────────────────────────
// Structure: Map<userId, Map<challengeId, { progress, dirty }>>
const progressCache = new Map();

// Cached challenge definitions (loaded once at server start)
// Array of { id, category, name, description, target_value, target_rank, reward_badge }
let definitionsCache = [];

// io instance for real-time socket notifications
let ioInstance = null;

// Map<userId, socketId> for looking up connected sockets by userId
// (passed from index.js where it's maintained)
let userIdToSocket = null;

// Batch flush interval handle
let flushIntervalHandle = null;

// ─── Initialization ───────────────────────────────────────

/**
 * Initialize the tracker: load challenge definitions and start batch flush timer.
 * Must be called once at server start with the Socket.io instance.
 * @param {Object} io - Socket.io server instance
 * @param {Map<string, string>} userSocketMap - Map<userId, socketId> for real-time notifications
 */
async function init(io, userSocketMap) {
  ioInstance = io;
  userIdToSocket = userSocketMap || new Map();

  try {
    const result = await db.query('SELECT * FROM challenge_definitions ORDER BY id');
    definitionsCache = result.rows;
    console.log(`[Challenges] Loaded ${definitionsCache.length} challenge definitions`);
  } catch (err) {
    console.error('[Challenges] Failed to load definitions:', err.message);
    definitionsCache = [];
  }

  // Flush dirty progress to DB every 15 seconds
  flushIntervalHandle = setInterval(() => flushAll(), 15000);

  console.log('[Challenges] Tracker initialized with 15s batch flush interval');
}

/**
 * Shutdown the tracker (clear interval).
 */
function shutdown() {
  if (flushIntervalHandle) {
    clearInterval(flushIntervalHandle);
    flushIntervalHandle = null;
  }
  // One final flush
  flushAll();
}

// ─── Hook Handlers ────────────────────────────────────────

/**
 * Track that a player made a hand of a given rank at showdown.
 * @param {string} userId
 * @param {number} rank - Hand rank (1-9, see HandEvaluator)
 */
function trackHandRank(userId, rank) {
  if (!userId || !rank) return;

  const applicable = definitionsCache.filter(
    d => d.category === 'hand_rank' && d.target_rank === rank
  );

  for (const def of applicable) {
    incrementProgress(userId, def);
  }
}

/**
 * Track that a player was dealt into a hand (volume).
 * @param {string} userId
 */
function trackVolume(userId) {
  if (!userId) return;

  const applicable = definitionsCache.filter(d => d.category === 'volume');

  for (const def of applicable) {
    incrementProgress(userId, def);
  }
}

/**
 * Track a wagering event (e.g., blind steal).
 * @param {string} userId
 */
function trackWagering(userId) {
  if (!userId) return;

  const applicable = definitionsCache.filter(d => d.category === 'wagering');

  for (const def of applicable) {
    incrementProgress(userId, def);
  }
}

// ─── Core Increment Logic ─────────────────────────────────

function incrementProgress(userId, definition) {
  if (!progressCache.has(userId)) {
    progressCache.set(userId, new Map());
  }

  const userMap = progressCache.get(userId);
  const current = userMap.get(definition.id)?.progress || 0;

  // Don't increment past target
  const newProgress = Math.min(current + 1, definition.target_value);
  const wasCompleted = current >= definition.target_value;
  const nowCompleted = newProgress >= definition.target_value;

  userMap.set(definition.id, {
    progress: newProgress,
    isCompleted: nowCompleted,
    dirty: true,
  });

  // Emit real-time notification on first completion
  if (nowCompleted && !wasCompleted && ioInstance && userIdToSocket) {
    const completionData = {
      challengeId: definition.id,
      name: definition.name,
      description: definition.description,
      category: definition.category,
      badge: definition.reward_badge || '⭐',
    };

    // Look up the user's socket by userId (not room name!)
    const socketId = userIdToSocket.get(userId);
    if (socketId) {
      ioInstance.to(socketId).emit('challenge_completed', completionData);
      console.log(`[Challenges] User ${userId} completed: ${definition.name}`);
    }
  }
}

// ─── Progress Queries ─────────────────────────────────────

/**
 * Get aggregated progress for a user (definitions + progress).
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
    category: row.category,
    name: row.name,
    description: row.description,
    targetValue: row.target_value,
    targetRank: row.target_rank,
    rewardBadge: row.reward_badge || '⭐',
    progress: row.progress || 0,
    isCompleted: row.is_completed || false,
    completedAt: row.completed_at,
  }));
}

// ─── Batch Database Flush ─────────────────────────────────

/**
 * Flush all dirty progress for a specific user to the database.
 */
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

/**
 * Flush all dirty progress for all users.
 */
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
  trackHandRank,
  trackVolume,
  trackWagering,
  getUserProgress,
};
