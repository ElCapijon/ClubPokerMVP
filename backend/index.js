const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { GAME_STATES, SHOWDOWN_DECISION_SECONDS, createHand, startHand, getPublicState, getPrivateState, getReconnectionSnapshot, isHandComplete, isRoundComplete, handleAction, advanceCompleteRoundStep, getNextActivePlayerIndex, applyShowdownDecision, canMuckNow } = require('./GameHand');
const ChallengeTracker = require('./ChallengeTracker');
const HandStats = require('./HandStats');
const pool = require('./db');
const { sendWelcomeEmail, sendPasswordResetEmail } = require('./email');
// ── BOTS ────────────────────────────────────────────────────
// Bots fill empty seats so a table can run with fewer humans. Everything bot
// related lives behind this flag: set BOTS_ENABLED = false to disable bots
// entirely (the add_bots/remove_bots handlers refuse and the host buttons are
// hidden). To REMOVE bots for good: delete backend/BotPlayer.js, the flag, and
// every `// ── BOTS ──` section below + the bot UI in ClubRoom.jsx.
const BOTS_ENABLED = true;
const BotPlayer = require('./BotPlayer');
// ────────────────────────────────────────────────────────────
// Map rank number to stat name for hand rank tracking
const RANK_STATS = {
  2: 'pairMade',
  3: 'twoPairMade',
  4: 'threeOfAKindMade',
  5: 'straightMade',
  6: 'flushMade',
  7: 'fullHouseMade',
  8: 'fourOfAKindMade',
  9: 'straightFlushMade',
};

// ============================================================
// Configuration
// ============================================================
const PORT = process.env.PORT || 3000;
const MAX_SEATS = 6;
const isProduction = process.env.NODE_ENV === 'production';
const JWT_SECRET = process.env.JWT_SECRET || 'poker_club_jwt_secret_change_in_prod';
const RESEND_API_KEY = process.env.RESEND_API_KEY;

// ============================================================
// Password Reset Token Helpers
// ============================================================
const crypto = require('crypto');

function generateResetToken() {
  return crypto.randomBytes(32).toString('hex');
}

function getResetTokenExpiry() {
  return new Date(Date.now() + 60 * 60 * 1000); // 1 hour
}
// ============================================================
// Express Setup
// ============================================================
const app = express();

app.set('trust proxy', isProduction ? 1 : 0);

if (isProduction) {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https' && req.headers['x-forwarded-proto'] !== undefined) {
      return res.redirect(301, `https://${req.headers.host}${req.url}`);
    }
    next();
  });
}

if (isProduction) {
  app.use(express.static(path.join(__dirname, '../frontend/dist')));
} else {
  app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:5173' }));
}

app.use(express.json());

const server = http.createServer(app);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Migration trigger
const { migrate } = require('./migrate');
app.get('/api/migrate', async (req, res) => {
  if (isProduction) {
    const migrateSecret = process.env.MIGRATE_SECRET;
    if (migrateSecret && req.query.secret !== migrateSecret) {
      return res.status(403).json({ error: 'Forbidden. Set MIGRATE_SECRET on Render and pass ?secret=your_secret' });
    }
  }
  try {
    console.log('[Migrate] Starting database migration...');
    const result = await migrate();
    res.json({ success: true, message: 'Migration completed successfully', result });
  } catch (err) {
    console.error('[Migrate] Failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// JWT Auth Middleware
// ============================================================
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

// ============================================================
// Challenges / Achievements API
// ============================================================
app.get('/api/challenges', authenticateToken, async (req, res) => {
  try {
    const progress = await ChallengeTracker.getUserProgress(req.user.userId);
    res.json({ challenges: progress });
  } catch (err) {
    console.error('[Challenges API] Error:', err.message);
    res.status(500).json({ error: 'Failed to get challenges' });
  }
});

// ============================================================
// Hand Tracker API — Lifetime stats for a logged-in player
// ============================================================
app.get('/api/stats', authenticateToken, async (req, res) => {
  try {
    const stats = await HandStats.getUserStats(req.user.userId);
    res.json({ stats });
  } catch (err) {
    console.error('[Stats API] Error:', err.message);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// ============================================================
// Admin — Credit chips to a player
// ============================================================
const CREDIT_SECRET = process.env.CREDIT_SECRET || 'poker_admin_credit';
app.post('/api/admin/credit', async (req, res) => {
  try {
    const { secret, displayName, amount } = req.body;

    if (secret !== CREDIT_SECRET) {
      return res.status(403).json({ error: 'Invalid secret' });
    }

    if (!displayName || !amount || amount <= 0) {
      return res.status(400).json({ error: 'displayName and positive amount required' });
    }

    const userResult = await pool.query('SELECT id, display_name, bankroll FROM users WHERE display_name = $1', [displayName]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: `User "${displayName}" not found` });
    }

    const user = userResult.rows[0];
    const result = await pool.query(
      'UPDATE users SET bankroll = bankroll + $1 WHERE id = $2 RETURNING bankroll',
      [amount, user.id]
    );

    const newBankroll = parseInt(result.rows[0].bankroll);
    console.log(`[Admin] Credited ${amount} chips to ${displayName}. New bankroll: ${newBankroll}`);

    res.json({ success: true, displayName, credited: amount, newBankroll });
  } catch (err) {
    console.error('[Admin Credit Error]', err);
    res.status(500).json({ error: 'Failed to credit chips' });
  }
});

// ============================================================
// HTTP Game Leave — Reliable refund via HTTP (no socket race)
// ============================================================
app.post('/api/games/leave', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Find the player in any active ring game
    let foundGame = null;
    let foundSeatIndex = -1;
    let foundSeat = null;

    for (const [gameId, game] of ringGames) {
      const idx = game.seats.findIndex(s => s && s.userId === userId);
      if (idx !== -1) {
        foundGame = game;
        foundSeatIndex = idx;
        foundSeat = game.seats[idx];
        break;
      }
    }

    if (!foundGame || !foundSeat) {
      // Not at any live in-memory table — likely the server restarted and the
      // table's state is gone. Refund any orphaned DB session for this user so
      // they never lose chips that were sitting on a dead table.
      try {
        const refunded = await recoverOrphanedSessions(userId);
        if (refunded > 0) {
          const bankroll = await getBankroll(userId);
          notifyBankroll(userId, bankroll);
          return res.json({ success: true, refundAmount: refunded, bankroll, recovered: true });
        }
      } catch (err) {
        console.error('[Leave-HTTP] Recovery refund failed:', err.message);
      }
      return res.status(404).json({ error: 'Not seated at any table' });
    }

    const refundAmount = foundSeat.stack || 0;

    // Refund to bankroll — ONLY clear seat if refund succeeds
    try {
      const newBankroll = await addToBankroll(userId, refundAmount);
      console.log(`[Leave-HTTP] ${foundSeat.userName} refunded ${refundAmount} chips. New bankroll: ${newBankroll}`);

      // Remove the player from socketToPlayer and have their socket leave the game room.
      // This prevents stale mappings and stops the disconnect handler from racing.
      const sockId = userIdToSocket.get(userId);
      if (sockId) {
        const sock = io.sockets.sockets.get(sockId);
        if (sock) sock.leave(gameRoom(foundGame.id));
        socketToPlayer.delete(sockId);
      }

      // Only clear seat after successful refund
      cleanupSeat(foundGame, foundSeatIndex, foundSeat, userId, foundGame.id);
      broadcastTableState(foundGame.id);
      notifyBankroll(userId, newBankroll);

      return res.json({ success: true, refundAmount, bankroll: newBankroll });
    } catch (e) {
      console.error('[Leave-HTTP] Refund failed:', e.message);
      // Seat stays — player can retry or disconnect handler will catch
      return res.status(500).json({ error: 'Failed to refund, seat preserved' });
    }
  } catch (err) {
    console.error('[Leave-HTTP Error]', err);
    res.status(500).json({ error: 'Failed to leave game' });
  }
});

// Production catch-all: serve index.html
if (isProduction) {
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
  });
}

if (isProduction) {
  console.log('[Server] Production mode');
  console.log('   Serving frontend from dist/');
}

// ============================================================
// Auth Routes
// ============================================================

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, displayName, password } = req.body;

    if (!email || !displayName || !password) {
      return res.status(400).json({ error: 'Email, display name, and password are required' });
    }
    if (displayName.trim().length > 20) {
      return res.status(400).json({ error: 'Display name must be 20 characters or less' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Check if email already exists
    const existingEmail = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existingEmail.rows.length > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    // Check if display name already exists
    const existingName = await pool.query('SELECT id FROM users WHERE display_name = $1', [displayName.trim()]);
    if (existingName.rows.length > 0) {
      return res.status(409).json({ error: 'Display name already taken. Please choose another.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (email, display_name, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, email, display_name, avatar_color, bankroll, created_at`,
      [email, displayName.trim(), hashedPassword]
    );

    const user = result.rows[0];
    const token = jwt.sign(
      { userId: user.id, displayName: user.display_name, email: user.email },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Send welcome email (non-blocking — don't fail registration if email fails)
    sendWelcomeEmail(user.email, user.display_name).catch(err => {
      console.error('[Register] Welcome email failed:', err.message);
    });

    res.status(201).json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        avatarColor: user.avatar_color,
        bankroll: parseInt(user.bankroll) || 10000,
      },
      token,
    });
  } catch (err) {
    console.error('[Register Error]', err);
    res.status(500).json({ error: 'Failed to register' });
  }
});

// ============================================================
// Password Reset Routes
// ============================================================

// POST /api/auth/forgot-password — Request a password reset email
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Check if user exists
    const result = await pool.query('SELECT id, email, display_name FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      // Don't reveal whether the email exists — return success either way
      return res.json({ success: true, message: 'If that email is registered, a reset link has been sent.' });
    }

    const user = result.rows[0];
    const resetToken = generateResetToken();
    const expiresAt = getResetTokenExpiry();

    // Save the token and expiry in the database
    await pool.query(
      'UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3',
      [resetToken, expiresAt, user.id]
    );

    // Send the email (non-blocking)
    sendPasswordResetEmail(user.email, resetToken).catch(err => {
      console.error('[ForgotPassword] Email send failed:', err.message);
    });

    res.json({ success: true, message: 'If that email is registered, a reset link has been sent.' });
  } catch (err) {
    console.error('[ForgotPassword Error]', err);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// POST /api/auth/reset-password — Confirm the reset and set a new password
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({ error: 'Token and new password are required' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Find user with this token that hasn't expired
    const result = await pool.query(
      'SELECT id, email, display_name FROM users WHERE reset_token = $1 AND reset_token_expires > NOW()',
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const user = result.rows[0];
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update password and clear the reset token
    await pool.query(
      'UPDATE users SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL WHERE id = $2',
      [hashedPassword, user.id]
    );

    console.log(`[ResetPassword] Password reset for ${user.email}`);

    res.json({ success: true, message: 'Password has been reset successfully. You can now sign in.' });
  } catch (err) {
    console.error('[ResetPassword Error]', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const result = await pool.query(
      'SELECT id, email, display_name, password_hash, avatar_color, bankroll, total_wins, hands_played FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { userId: user.id, displayName: user.display_name, email: user.email },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        avatarColor: user.avatar_color,
        bankroll: parseInt(user.bankroll) || 10000,
        totalWins: user.total_wins,
        handsPlayed: user.hands_played,
      },
      token,
    });
  } catch (err) {
    console.error('[Login Error]', err);
    res.status(500).json({ error: 'Failed to login' });
  }
});

// ============================================================
// Socket.io Setup
// ============================================================
const io = new Server(server, {
  cors: {
    origin: isProduction ? false : (process.env.CORS_ORIGIN || 'http://localhost:5173'),
    methods: ['GET', 'POST'],
  },
});

// ============================================================
// Socket.io Auth Middleware
// ============================================================
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication required'));
    }
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.userId = decoded.userId;
    socket.displayName = decoded.displayName;
    next();
  } catch (err) {
    console.error('[Socket Auth Error]', err.message);
    next(new Error('Invalid or expired token'));
  }
});

// ============================================================
// In-Memory State
// ============================================================
// Map<gameId, RingGameState>
const ringGames = new Map();

// Map<socketId, { gameId, userId, seatIndex }>
const socketToPlayer = new Map();

// Map<userId, socketId> for finding connected users (challenges)
const userIdToSocket = new Map();

// Hand counters for dealer rotation
const handCounters = new Map(); // Map<gameId, number>

// Disconnect timeouts
// Map<gameId:userId, timeoutId>
const disconnectTimeouts = new Map();

// Action timers
// Map<gameId, timeoutId>
const actionTimers = new Map();

// All-in runout street timers (one pending timeout per game while the board
// is running out). Map<gameId, timeoutId>
const runoutTimers = new Map();

// Interactive showdown reveal timers (one pending timeout per game while the
// current player decides Show Cards / Muck). Map<gameId, timeoutId>
const showdownTimers = new Map();

// Last action per game
// Map<gameId, { seatIndex, action, amount, timestamp }>
const lastActions = new Map();

// ============================================================
// Bankroll Helpers
// ============================================================

/** Check if a user exists in the DB */
async function userExists(userId) {
  const result = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
  return result.rows.length > 0;
}

/** Get a player's bankroll from DB. Returns 0 if user not found. */
async function getBankroll(userId) {
  const result = await pool.query('SELECT bankroll FROM users WHERE id = $1', [userId]);
  return result.rows.length > 0 ? parseInt(result.rows[0].bankroll) : 0;
}

/** Deduct from bankroll and return new balance. Throws with descriptive message. */
async function deductBankroll(userId, amount) {
  // First check if user exists
  const exists = await userExists(userId);
  if (!exists) {
    throw new Error('USER_NOT_FOUND');
  }
  const result = await pool.query(
    'UPDATE users SET bankroll = bankroll - $1 WHERE id = $2 AND bankroll >= $1 RETURNING bankroll',
    [amount, userId]
  );
  if (result.rows.length === 0) {
    throw new Error('INSUFFICIENT_BANKROLL');
  }
  return parseInt(result.rows[0].bankroll);
}

/** Add to bankroll and return new balance */
async function addToBankroll(userId, amount) {
  const result = await pool.query(
    'UPDATE users SET bankroll = bankroll + $1 WHERE id = $2 RETURNING bankroll',
    [amount, userId]
  );
  return parseInt(result.rows[0].bankroll);
}

/** Notify a player's socket about bankroll change */
function notifyBankroll(userId, bankroll) {
  const socketId = userIdToSocket.get(userId);
  if (socketId) {
    io.to(socketId).emit('bankroll_updated', { bankroll });
  }
}

/**
 * Refund any orphaned player sessions (left_at IS NULL) back to the player's
 * bankroll and mark them as left. This is the crash/restart safety net:
 * ring-game seats are in-memory only, so when the server restarts (deploy,
 * crash, OOM) every seated stack vanishes. The player_sessions row is the
 * only durable record that the chips existed, and without this recovery the
 * buy-in would be lost forever.
 *
 * Idempotent: sessions already marked left_at are skipped, so it is safe to
 * run at startup AND on-demand when a player tries to rejoin/leave a table
 * that no longer exists in memory.
 *
 * @param {string|null} userId - If given, only that user's orphaned sessions are refunded.
 * @returns {Promise<number>} total chips refunded
 */
async function recoverOrphanedSessions(userId = null) {
  // Run the claim + refund + close in ONE transaction so recovery is
  // exactly-once: concurrent runs (startup sweep vs. a player's rejoin/leave)
  // serialize on the locked rows, and a crash mid-recovery rolls back instead
  // of double-refunding or stranding chips.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Claim every still-open session for this user (or all users). FOR UPDATE
    // locks the rows so a second concurrent recovery can't pick them up again.
    const result = await client.query(
      `SELECT ps.id, ps.user_id, ps.current_stack, u.display_name
       FROM player_sessions ps
       JOIN users u ON u.id = ps.user_id
       WHERE ps.left_at IS NULL
         AND ($1::uuid IS NULL OR ps.user_id = $1)
       FOR UPDATE OF ps`,
      [userId]
    );

    let totalRefunded = 0;
    for (const row of result.rows) {
      const amount = parseInt(row.current_stack) || 0;
      if (amount > 0) {
        // Refund inside the same transaction so a failure rolls everything back
        await client.query(
          'UPDATE users SET bankroll = bankroll + $1 WHERE id = $2',
          [amount, row.user_id]
        );
        totalRefunded += amount;
        console.log(`[Recovery] Refunded ${amount} chips to ${row.display_name} (orphaned session ${row.id})`);
      }
      // Close the session in the same transaction as the refund
      await client.query('UPDATE player_sessions SET left_at = NOW() WHERE id = $1', [row.id]);
    }

    await client.query('COMMIT');
    if (result.rows.length > 0) {
      console.log(`[Recovery] Recovered ${result.rows.length} orphaned session(s), ${totalRefunded} chips refunded`);
    }
    return totalRefunded;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Recovery] Failed to recover orphaned sessions:', err.message);
    return 0;
  } finally {
    client.release();
  }
}

// ============================================================
// Pre-defined Stake Levels (auto-table creation)
// ============================================================
const STAKE_LEVELS = {
  micro: {
    key: 'micro',
    name: 'Micro Stakes',
    sb: 10,
    bb: 20,
    minBuyin: 2000,
    maxBuyin: 4000,
    timer: 20,
  },
  low: {
    key: 'low',
    name: 'Low Stakes',
    sb: 25,
    bb: 50,
    minBuyin: 5000,
    maxBuyin: 10000,
    timer: 20,
  },
  medium: {
    key: 'medium',
    name: 'Medium Stakes',
    sb: 50,
    bb: 100,
    minBuyin: 10000,
    maxBuyin: 20000,
    timer: 20,
  },
  high: {
    key: 'high',
    name: 'High Stakes',
    sb: 100,
    bb: 200,
    minBuyin: 20000,
    maxBuyin: 40000,
    timer: 20,
  },
  expert: {
    key: 'expert',
    name: 'Expert Stakes',
    sb: 250,
    bb: 500,
    minBuyin: 50000,
    maxBuyin: 100000,
    timer: 20,
  },
  elite: {
    key: 'elite',
    name: 'Elite Stakes',
    sb: 500,
    bb: 1000,
    minBuyin: 100000,
    maxBuyin: 200000,
    timer: 20,
  },
  master: {
    key: 'master',
    name: 'Master Stakes',
    sb: 1000,
    bb: 2000,
    minBuyin: 200000,
    maxBuyin: 400000,
    timer: 20,
  },
  legend: {
    key: 'legend',
    name: 'Legend Stakes',
    sb: 2500,
    bb: 5000,
    minBuyin: 500000,
    maxBuyin: 1000000,
    timer: 20,
  },
  millionaire: {
    key: 'millionaire',
    name: 'Millionaire Stakes',
    sb: 5000,
    bb: 10000,
    minBuyin: 1000000,
    maxBuyin: 2000000,
    timer: 20,
  },
  titan: {
    key: 'titan',
    name: 'Titan Stakes',
    sb: 10000,
    bb: 20000,
    minBuyin: 2000000,
    maxBuyin: 4000000,
    timer: 20,
  },
  superHigh: {
    key: 'superHigh',
    name: 'Super High Roller',
    sb: 25000,
    bb: 50000,
    minBuyin: 5000000,
    maxBuyin: 10000000,
    timer: 20,
  },
};

// Counter for auto-naming tables (e.g. "Micro Stakes #1")
// Map<stakeLevel, number>
const stakeCounters = new Map();

// ============================================================
// Ring Game State Factory
// ============================================================
function createRingGameState(tableName, stakeConfig) {
  const seats = Array(MAX_SEATS).fill(null);

  return {
    id: uuidv4(),
    stakeLevel: stakeConfig.key,
    tableName,
    minBuyin: stakeConfig.minBuyin,
    maxBuyin: stakeConfig.maxBuyin,
    hostId: null,
    seats,
    tableSettings: {
      sb: stakeConfig.sb,
      bb: stakeConfig.bb,
      timer: stakeConfig.timer || 20,
      allowRebuys: true,
    },
    gameState: 'WAITING',
    currentHand: null,
    createdAt: Date.now(),
  };
}

/** Find existing table at stake level with open seat, or create a new one */
function findOrCreateTable(stakeLevel) {
  // Look for an existing table at this stake level with an open seat
  for (const [id, game] of ringGames) {
    if (game.stakeLevel === stakeLevel) {
      const seatIndex = findNextAvailableSeat(game.seats);
      if (seatIndex !== -1) {
        return { game, seatIndex, isNew: false };
      }
    }
  }

  // All tables full (or none exist) — create a new one
  const config = STAKE_LEVELS[stakeLevel];
  if (!config) return null;

  const counter = (stakeCounters.get(stakeLevel) || 0) + 1;
  stakeCounters.set(stakeLevel, counter);

  const tableName = `${config.name} #${counter}`;
  const game = createRingGameState(tableName, config);
  ringGames.set(game.id, game);

  // Persist to database
  try {
    pool.query(
      `INSERT INTO ring_games (id, table_name, host_user_id, min_buyin, max_buyin, small_blind, big_blind, action_timer_seconds)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [game.id, game.tableName, null, game.minBuyin, game.maxBuyin,
       game.tableSettings.sb, game.tableSettings.bb, game.tableSettings.timer]
    ).catch(err => console.error('[DB] Error persisting table:', err.message));
  } catch (dbErr) {
    console.error('[DB] Error persisting table:', dbErr.message);
  }

  return { game, seatIndex: 0, isNew: true };
}

// ============================================================
// Find next available seat
// ============================================================
function findNextAvailableSeat(seats) {
  for (let i = 0; i < MAX_SEATS; i++) {
    if (seats[i] === null) return i;
  }
  return -1;
}

// ============================================================
// Socket room name
// ============================================================
function gameRoom(gameId) {
  return `game:${gameId}`;
}

// ============================================================
// Broadcast table state to all players
// ============================================================
function broadcastTableState(gameId) {
  const game = ringGames.get(gameId);
  if (!game) return;

  const players = game.seats.map((seat, index) => {
    if (!seat) return null;
    return {
      seatIndex: index,
      userName: seat.userName,
      stack: seat.stack,
      isReady: seat.isReady,
      isConnected: seat.isConnected,
      isHost: seat.userId === game.hostId,
      isSittingOut: seat.isSittingOut || false,
      isBot: !!seat.isBot,
      userId: seat.userId,
    };
  });

  io.to(gameRoom(gameId)).emit('table_state_update', {
    gameId: game.id,
    tableName: game.tableName,
    minBuyin: game.minBuyin,
    maxBuyin: game.maxBuyin,
    players,
    hostId: game.hostId,
    tableSettings: game.tableSettings,
    gameState: game.gameState,
    // ── BOTS ── lets the client hide the add/remove-bot buttons when disabled
    botsEnabled: BOTS_ENABLED,
  });
}

// ============================================================
// Broadcast game state (same as before)
// ============================================================
function broadcastGameState(gameId) {
  const game = ringGames.get(gameId);
  if (!game || !game.currentHand) return;

  const hand = game.currentHand;
  const publicState = getPublicState(hand);

  io.to(gameRoom(gameId)).emit('game_state_sync', publicState);

  for (const player of hand.players) {
    const privateState = getPrivateState(hand, player.seatIndex);
    for (const [socketId, info] of socketToPlayer) {
      if (info.gameId === gameId && info.seatIndex === player.seatIndex) {
        io.to(socketId).emit('your_hole_cards', privateState);
      }
    }
  }
}

// ============================================================
// Action Timer Management
// ============================================================

function clearActionTimer(gameId) {
  if (actionTimers.has(gameId)) {
    clearTimeout(actionTimers.get(gameId));
    actionTimers.delete(gameId);
  }
}

function clearRunoutTimer(gameId) {
  if (runoutTimers.has(gameId)) {
    clearTimeout(runoutTimers.get(gameId));
    runoutTimers.delete(gameId);
  }
}

function clearShowdownTimer(gameId) {
  if (showdownTimers.has(gameId)) {
    clearTimeout(showdownTimers.get(gameId));
    showdownTimers.delete(gameId);
  }
}

/** Copy each player's stack from the hand back to the ring-game seat. */
function syncSeatStacks(game, hand) {
  for (const hp of hand.players) {
    const s = game.seats[hp.seatIndex];
    if (s) s.stack = hp.stack;
  }
}

// Pause between streets while an all-in runout is being dealt. Gives players
// time to see each card hit the board instead of all five at once.
const RUNOUT_STREET_DELAY_MS = 1800;

// Short beat after a betting round completes (e.g. a heads-up call) before the
// next street is dealt, so the settled bets visibly land in front of the seats.
// The street advance resets every roundBet to 0, so without this delay the
// client would never see the round-completing chips (every call in heads-up
// completes the round).
const ROUND_SETTLE_DELAY_MS = 1000;

/**
 * Broadcast the final state of a runout and complete the hand.
 * Returns true if the hand was completed (and thus handled).
 */
function finalizeRunoutHand(gameId, hand) {
  const g = ringGames.get(gameId);
  if (!g || g.currentHand !== hand) return false;
  syncSeatStacks(g, hand);
  g.gameState = hand.gameStatus;
  broadcastGameState(gameId);
  if (isHandComplete(hand)) {
    handleHandComplete(gameId, hand);
    return true;
  }
  return false;
}

/**
 * Deal out the remaining streets of an all-in runout one at a time, with a
 * short pause between each, broadcasting every intermediate board so players
 * see the flop → turn → river run out instead of all cards appearing at once.
 *
 * Called when a betting round completes but every remaining player is all-in
 * (nobody left to act). Each street is dealt, shown, then the next one is
 * scheduled until the hand reaches showdown. Timers are tracked in
 * runoutTimers so they can be cancelled if the hand/table goes away.
 */
function scheduleRunout(gameId, hand, firstDelayMs = RUNOUT_STREET_DELAY_MS) {
  clearRunoutTimer(gameId);
  clearActionTimer(gameId);

  // If the runout already finished before the first timer could fire,
  // finalize immediately rather than waiting. If it landed in the interactive
  // showdown phase, hand over to the reveal timer.
  if (isHandComplete(hand)) {
    finalizeRunoutHand(gameId, hand);
    return;
  }
  if (hand.gameStatus === GAME_STATES.SHOWDOWN) {
    startShowdownTimer(gameId);
    return;
  }

  const dealNextStreet = () => {
    const g = ringGames.get(gameId);
    if (!g || g.currentHand !== hand) return; // hand replaced / table gone
    clearRunoutTimer(gameId);

    if (isHandComplete(hand)) {
      finalizeRunoutHand(gameId, hand);
      return;
    }
    if (hand.gameStatus === GAME_STATES.SHOWDOWN) {
      startShowdownTimer(gameId);
      return;
    }

    const prevStatus = g.gameState;
    // Deal the next street and broadcast it so the board visibly runs out.
    advanceCompleteRoundStep(hand);
    syncSeatStacks(g, hand);
    g.gameState = hand.gameStatus;
    broadcastGameState(gameId);

    // Street-seen stats (flopsSeen / turnsSeen / riversSeen). The street
    // transition happens HERE now: actions that complete a round defer their
    // advance (see handleAction deferAdvance) so the settled bets stay visible
    // for the settle delay, so the old player_action status check never fires.
    const streetStat = {
      'FLOP': 'flopsSeen',
      'TURN': 'turnsSeen',
      'RIVER': 'riversSeen',
    }[hand.gameStatus];
    if (streetStat && prevStatus !== hand.gameStatus) {
      const activePlayers = hand.players.filter(p => !p.isFolded && !p.isAllIn);
      activePlayers.forEach(p => {
        if (p.userId) ChallengeTracker.trackStat(p.userId, streetStat, 1);
      });
    }

    if (isHandComplete(hand)) {
      handleHandComplete(gameId, hand);
    } else if (hand.gameStatus === GAME_STATES.SHOWDOWN) {
      // Runout reached showdown with a live player — start the reveal phase.
      startShowdownTimer(gameId);
    } else if (isRoundComplete(hand)) {
      // Everyone still all-in (or a lone live player vs all-in opponents) —
      // deal the next street after a beat.
      runoutTimers.set(gameId, setTimeout(dealNextStreet, RUNOUT_STREET_DELAY_MS));
    } else {
      // The new street is open — live players can act again (e.g. a normal
      // heads-up call that deferred its advance). Arm the action timer.
      setActionTimer(gameId);
    }
  };

  runoutTimers.set(gameId, setTimeout(dealNextStreet, firstDelayMs));
}

/**
 * Start (or restart) the interactive showdown reveal timer for the current
 * decider. Broadcasts the phase state so everyone sees whose turn it is, then
 * arms a timeout. On timeout a player who can still win (not beaten by an
 * exposed hand) is auto-shown; everyone else is auto-mucked — the reveal phase
 * can never stall.
 */
function startShowdownTimer(gameId) {
  clearShowdownTimer(gameId);
  clearActionTimer(gameId);

  const game = ringGames.get(gameId);
  if (!game || !game.currentHand) return;
  const hand = game.currentHand;
  const sd = hand.showdown;
  if (hand.gameStatus !== GAME_STATES.SHOWDOWN || !sd || !sd.active) return;

  const currentSeat = sd.queue[sd.queuePos];
  if (currentSeat === undefined) {
    // Defensive: queue exhausted without completing — nothing to prompt.
    return;
  }

  hand.actionStartTime = Date.now();
  broadcastGameState(gameId);

  // Guard against stale timers: a timeout callback that was already queued
  // when the player acted must not auto-decide a NEWER turn (or double-finish
  // the hand). Capture the position we armed for and verify it still holds.
  const armedPos = sd.queuePos;
  const armedSeat = currentSeat;

  // ── BOTS ── Bots reveal on their own after a short delay instead of
  // burning the full human decision timer. ──
  const deciderIsBot = BOTS_ENABLED && !!(game.seats[currentSeat] && game.seats[currentSeat].isBot);
  const decisionMs = deciderIsBot
    ? 900 + Math.random() * 800 // ~0.9–1.7s
    : (sd.decisionSeconds || SHOWDOWN_DECISION_SECONDS) * 1000;
  // ── /BOTS ──

  showdownTimers.set(gameId, setTimeout(() => {
    clearShowdownTimer(gameId);
    const g = ringGames.get(gameId);
    if (!g || g.currentHand !== hand) return;
    if (hand.gameStatus !== GAME_STATES.SHOWDOWN || !hand.showdown || !hand.showdown.active) return;
    if (hand.showdown.queuePos !== armedPos) return; // a newer turn is active

    const curSeat = hand.showdown.queue[hand.showdown.queuePos];
    if (curSeat === undefined || curSeat !== armedSeat) return;

    const player = hand.players.find(p => p.seatIndex === curSeat);
    const canMuck = canMuckNow(hand, curSeat);

    // ── BOTS ── bots pick show/muck themselves (winner always shows) ──
    let show;
    let log;
    if (BOTS_ENABLED && game.seats[curSeat] && game.seats[curSeat].isBot) {
      show = BotPlayer.decideShowdown(hand, curSeat, canMuck);
      log = `[Bot] ${player ? player.userName : '?'} ${show ? 'shows' : 'mucks'} at showdown`;
    } else {
      // Winners must show; a player beaten by an exposed hand is auto-mucked.
      show = !canMuck;
      log = `[Showdown] ${player ? player.userName : '?'} timed out - ${show ? 'auto-shows' : 'mucks'}`;
    }
    console.log(log);
    // ── /BOTS ──

    // Defensive: the decision should never fail here (the turn is validated by
    // the guards above). If it somehow does, bail instead of looping.
    const decision = applyShowdownDecision(hand, curSeat, show);
    if (decision.error) {
      console.error('[Showdown] Auto-decision failed:', decision.error);
      return;
    }

    g.gameState = hand.gameStatus;
    for (const hp of hand.players) {
      const s = g.seats[hp.seatIndex];
      if (s) s.stack = hp.stack;
    }
    broadcastGameState(gameId);

    if (isHandComplete(hand)) {
      handleHandComplete(gameId, hand);
    } else {
      startShowdownTimer(gameId);
    }
  }, decisionMs));
}

function setActionTimer(gameId) {
  clearActionTimer(gameId);

  const game = ringGames.get(gameId);
  if (!game || !game.currentHand) return;

  const hand = game.currentHand;
  if (hand.gameStatus === GAME_STATES.SHOWDOWN || hand.gameStatus === GAME_STATES.HAND_COMPLETE) return;

  // If the betting round is already complete with nobody left to act — e.g.
  // every remaining opponent is all-in and the lone live player has matched,
  // or the hand started with everyone all-in from short blinds — run out the
  // board instead of arming a phantom action timer that would prompt the lone
  // player to act (and auto-fold them).
  if (isRoundComplete(hand)) {
    game.gameState = hand.gameStatus;
    scheduleRunout(gameId, hand);
    return;
  }

  const currentPlayer = hand.players[hand.currentPlayerIndex];
  if (!currentPlayer || currentPlayer.isAllIn || currentPlayer.isFolded) {
    // Defensive: nobody can act at the current index. If a betting round is
    // already complete — e.g. everyone remaining is all-in (possibly from
    // short-stack blinds) — deal out the remaining streets one at a time so
    // the game never stalls on a phantom turn. Otherwise advance to the next
    // player who can actually act.
    if (isRoundComplete(hand)) {
      game.gameState = hand.gameStatus; // keep ring-game state in sync
      scheduleRunout(gameId, hand);
      return;
    }
    hand.currentPlayerIndex = getNextActivePlayerIndex(hand, hand.currentPlayerIndex);
    hand.actionStartTime = Date.now();
    if (hand.currentPlayerIndex >= 0) {
      broadcastGameState(gameId);
      setActionTimer(gameId);
    }
    return;
  }

  // ── BOTS ── BOT TURN: bots play themselves after a short, human-feeling delay ──
  if (BOTS_ENABLED) {
    const seat = game.seats[currentPlayer.seatIndex];
    if (seat && seat.isBot) {
      const botDelay = 800 + Math.random() * 1200; // 0.8–2s
      const timeout = setTimeout(() => {
        const g = ringGames.get(gameId);
        if (!g || !g.currentHand) return;

        const h = g.currentHand;
        if (h.gameStatus === GAME_STATES.SHOWDOWN || h.gameStatus === GAME_STATES.HAND_COMPLETE) return;

        const pIdx = h.currentPlayerIndex;
        if (pIdx < 0 || pIdx >= h.players.length) return;

        const p = h.players[pIdx];
        if (p.isFolded || p.isAllIn) return;

        // Bot decides what to do
        const decision = BotPlayer.decideAction(h, p.seatIndex, g);
        console.log(`[Bot] ${p.userName} decides to ${decision.action}${decision.amount ? ' ' + decision.amount : ''}`);

        const result = handleAction(h, p.seatIndex, decision.action, decision.amount, { deferAdvance: true });
        if (result.error) {
          console.error(`[Bot] Action error: ${result.error}`);
          // Fallback: fold
          const fallback = handleAction(h, p.seatIndex, 'fold', { deferAdvance: true });
          if (fallback.error) return;
        }

        // Broadcast the bot's action so the client action feed shows it
        // (recordAction sets lastActions AND emits last_action to the room).
        recordAction(gameId, p.seatIndex, decision.action, decision.amount);

        g.gameState = h.gameStatus;
        for (const hp of h.players) {
          const s = g.seats[hp.seatIndex];
          if (s) s.stack = hp.stack;
        }

        broadcastGameState(gameId);

        if (isHandComplete(h)) {
          handleHandComplete(gameId, h);
        } else if (h.gameStatus === GAME_STATES.SHOWDOWN) {
          startShowdownTimer(gameId);
        } else if (isRoundComplete(h)) {
          scheduleRunout(gameId, h, ROUND_SETTLE_DELAY_MS);
        } else {
          setActionTimer(gameId);
        }
      }, botDelay);

      actionTimers.set(gameId, timeout);
      return;
    }
  }
  // ── /BOTS ──

  // ── HUMAN TURN: Standard auto-fold timer ──
  const timerMs = (hand.actionTimer || 20) * 1000;

  const timeout = setTimeout(() => {
    const gameNow = ringGames.get(gameId);
    if (!gameNow || !gameNow.currentHand) return;

    const handNow = gameNow.currentHand;
    if (handNow.gameStatus === GAME_STATES.SHOWDOWN || handNow.gameStatus === GAME_STATES.HAND_COMPLETE) return;

    const playerIdx = handNow.currentPlayerIndex;
    if (playerIdx < 0 || playerIdx >= handNow.players.length) return;

    const player = handNow.players[playerIdx];
    if (player.isFolded || player.isAllIn) return;

    const seatIdx = player.seatIndex;
    console.log(`[Auto-Fold] ${player.userName} auto-folded (timeout)`);

    const result = handleAction(handNow, seatIdx, 'fold', { deferAdvance: true });
    if (result.error) return;

    // Count the auto-fold in the hand tracker (only after a successful action)
    if (player.userId) {
      HandStats.trackStat(player.userId, 'folds', 1);
    }

    lastActions.set(gameId, {
      seatIndex: seatIdx,
      userName: player.userName,
      action: 'fold',
      amount: null,
      timestamp: Date.now(),
    });

    gameNow.gameState = handNow.gameStatus;
    for (const hp of handNow.players) {
      const seat = gameNow.seats[hp.seatIndex];
      if (seat) seat.stack = hp.stack;
    }

    broadcastGameState(gameId);

    if (isHandComplete(handNow)) {
      handleHandComplete(gameId, handNow);
    } else if (handNow.gameStatus === GAME_STATES.SHOWDOWN) {
      startShowdownTimer(gameId);
    } else if (isRoundComplete(handNow)) {
      scheduleRunout(gameId, handNow, ROUND_SETTLE_DELAY_MS);
    } else {
      setActionTimer(gameId);
    }
  }, timerMs);

  actionTimers.set(gameId, timeout);
}

function checkAutoStart(gameId) {
  const game = ringGames.get(gameId);
  if (!game || game.gameState !== 'WAITING') return;

  const seated = game.seats.filter(s => s && s.isConnected && !s.isSittingOut);
  if (seated.length < 2) return;

  const allReady = seated.every(s => s.isReady === true);
  if (!allReady) return;

  console.log(`[Auto-Start] All ${seated.length} players ready in game ${gameId}. Starting game...`);

  let handCount = handCounters.get(gameId) || 0;
  const hand = createHand(game, handCount);
  if (!hand) return;

  startHand(hand);
  game.currentHand = hand;
  game.gameState = hand.gameStatus;
  handCounters.set(gameId, handCount + 1);

  console.log(`[Start Game] Game ${gameId} hand ${handCount} started (auto-start)`);

  broadcastGameState(gameId);
  setActionTimer(gameId);
}

function trackHandComplete(hand) {
  if (!hand) return;

  // Per-seat winnings & best winning hand from the pot splits
  const wonBySeat = {};   // seatIndex -> total chips won
  const bestBySeat = {};  // seatIndex -> { rank, name }
  const biggestBySeat = {}; // seatIndex -> biggest single pot won
  if (Array.isArray(hand.handResult)) {
    for (const pot of hand.handResult) {
      for (const w of (pot.winners || [])) {
        const seat = w.seatIndex;
        const amt = w.amountWon || 0;
        wonBySeat[seat] = (wonBySeat[seat] || 0) + amt;
        biggestBySeat[seat] = Math.max(biggestBySeat[seat] || 0, amt);
        if (w.handResult && w.handResult.rank > 0) {
          const existing = bestBySeat[seat];
          if (!existing || w.handResult.rank > existing.rank) {
            bestBySeat[seat] = { rank: w.handResult.rank, name: w.handResult.rankName };
          }
        }
      }
    }
  }

  hand.players.forEach(p => {
    // ── BOTS ── bots are not DB users — never track stats for them
    if (p.userId && !BotPlayer.isBotUserId(p.userId)) {
      ChallengeTracker.trackStat(p.userId, 'handsPlayed', 1);

      HandStats.trackHand(p.userId, {
        won: wonBySeat[p.seatIndex] || 0,
        wagered: p.betAmount || 0,
        blindsPaid: p.postedBlind || 0,
        bestRank: bestBySeat[p.seatIndex]?.rank || 0,
        bestName: bestBySeat[p.seatIndex]?.name || null,
        biggestPot: biggestBySeat[p.seatIndex] || 0,
        flopsSeen: !!p.sawFlop,
        showdown: !p.isFolded && hand.winningRank > 0,
        wonShowdown: (wonBySeat[p.seatIndex] || 0) > 0 && hand.winningRank > 0,
      });
    }
  });

  if (hand.winningUserId && !BotPlayer.isBotUserId(hand.winningUserId)) {
    ChallengeTracker.trackStat(hand.winningUserId, 'handsWon', 1);

    if (hand.winningRank > 0) {
      ChallengeTracker.trackStat(hand.winningUserId, 'showdownsWon', 1);
    }

    if (hand.winningRank >= 2 && hand.winningRank <= 9) {
      const statName = RANK_STATS[hand.winningRank];
      if (statName) {
        ChallengeTracker.trackStat(hand.winningUserId, statName, 1);
      }
      if (hand.winningRank === 9) {
        ChallengeTracker.trackStat(hand.winningUserId, 'royalFlushMade', 1);
      }
    }
  }

  if (hand.gameStatus === 'SHOWDOWN' || hand.gameStatus === 'HAND_COMPLETE') {
    const activePlayers = hand.players.filter(p => !p.isFolded);
    activePlayers.forEach(p => {
      if (p.userId && !BotPlayer.isBotUserId(p.userId)) {
        ChallengeTracker.trackStat(p.userId, 'showdownsReached', 1);
      }
    });
  }
}

/**
 * Clean up a player's seat after successful refund/cash-out.
 * Updates session, clears seat, handles host reassignment.
 */
function cleanupSeat(game, seatIndex, seat, userId, gameId) {
  // Update player session
  if (seat.sessionId) {
    pool.query(
      'UPDATE player_sessions SET current_stack = $1, left_at = NOW() WHERE id = $2',
      [0, seat.sessionId]
    ).catch(err => console.error('[DB] Error updating session:', err.message));
  }

  // Clear the seat
  game.seats[seatIndex] = null;
  console.log(`[Cleanup] Seat ${seatIndex} cleared for ${seat.userName}`);

  // If host left, reassign to another HUMAN player or deactivate the table
  // (bots can't host — they have no controls and no socket).
  if (seat.userId === game.hostId) {
    const nextPlayer = game.seats.find(s => s && s.userId && !BotPlayer.isBotUserId(s.userId));
    if (nextPlayer) {
      game.hostId = nextPlayer.userId;
      console.log(`[Host] New host for ${gameId}: ${nextPlayer.userName}`);
    } else {
      // No human players left — deactivate
      deactivateGame(gameId);
      console.log(`[Game] ${gameId} deactivated (no players)`);
    }
  }
}

// ============================================================
// Hand Completion Helpers
// ============================================================

/** Check if any HUMAN player is seated at the table (bots can't run a table alone). */
function hasHumanPlayer(game) {
  return game.seats.some(s => s && s.userId && !BotPlayer.isBotUserId(s.userId));
}

/**
 * ── BOTS ── Remove busted bots (stack <= 0) from the table after a hand
 * completes, so they actually leave the table when knocked out and their
 * seats free up for humans. Returns the number of bots removed.
 */
function removeBustedBots(gameId) {
  if (!BOTS_ENABLED) return 0;
  const game = ringGames.get(gameId);
  if (!game) return 0;

  let removed = 0;
  for (let i = 0; i < MAX_SEATS; i++) {
    const seat = game.seats[i];
    if (seat && BotPlayer.isBotUserId(seat.userId) && seat.stack <= 0) {
      // Defensive: if the busted bot was somehow the host, hand it to a human
      if (seat.userId === game.hostId) {
        const nextHuman = game.seats.find(s => s && s.userId && !BotPlayer.isBotUserId(s.userId));
        if (nextHuman) {
          game.hostId = nextHuman.userId;
          console.log(`[Host] New host for ${gameId}: ${nextHuman.userName}`);
        }
      }
      game.seats[i] = null;
      removed++;
      console.log(`[Bots] "${seat.userName}" busted and left the table (seat ${i}) in game ${gameId}`);
    }
  }

  if (removed > 0) {
    broadcastTableState(gameId);
  }
  return removed;
}
// ── /BOTS ──

/**
 * Deactivate a ring game: clear its timer, remove from memory,
 * and mark it inactive in the database.
 */
function deactivateGame(gameId) {
  const g = ringGames.get(gameId);
  if (!g) return;
  clearActionTimer(gameId);
  clearRunoutTimer(gameId);
  clearShowdownTimer(gameId);
  ringGames.delete(gameId);
  pool.query('UPDATE ring_games SET is_active = FALSE WHERE id = $1', [gameId])
    .catch(err => console.error('[DB] Error deactivating game:', err.message));
  console.log(`[Game] ${gameId} deactivated`);
}

/**
 * Handle a completed hand: track stats, notify clients, then deal the next
 * hand. If fewer than 2 playable players remain, the game returns to the
 * WAITING lobby. If no players remain, the table closes.
 */
function handleHandComplete(gameId, hand) {
  // No reveal timer should survive a completed hand.
  clearShowdownTimer(gameId);

  trackHandComplete(hand);

  // Persist each player's current stack into their player_sessions row so
  // that recoverOrphanedSessions() can refund the ACTUAL stack (not just the
  // buy-in) if the server restarts mid-game. The hand players' stacks are
  // authoritative after goToShowdown has awarded winnings.
  const gForStack = ringGames.get(gameId);
  if (gForStack) {
    for (const hp of hand.players) {
      const seat = gForStack.seats[hp.seatIndex];
      if (seat && seat.sessionId && hp.userId) {
        pool.query(
          'UPDATE player_sessions SET current_stack = $1 WHERE id = $2',
          [hp.stack, seat.sessionId]
        ).catch(err => console.error('[DB] Error persisting session stack:', err.message));
      }
    }
  }

  // Persist hand history. Done here so every completion path records it —
  // human action, bot action, auto-fold, disconnect fold and all-in runouts.
  try {
    pool.query(
      `INSERT INTO hand_histories (game_id, final_board, players_in_hand, pot_splits)
       VALUES ($1, $2, $3, $4)`,
      [
        gameId,
        JSON.stringify(hand.communityCards),
        JSON.stringify(hand.players.map(p => ({
          seatIndex: p.seatIndex,
          userName: p.userName,
          holeCards: p.holeCards,
          stack: p.stack,
          betAmount: p.betAmount,
          isFolded: p.isFolded,
          isAllIn: p.isAllIn,
        }))),
        JSON.stringify(hand.handResult),
      ]
    ).catch(err => console.error('[DB] Hand history error:', err.message));
  } catch (dbErr) {
    console.error('[DB] Hand history error:', dbErr.message);
  }

  io.to(gameRoom(gameId)).emit('hand_complete', {
    handResult: hand.handResult,
    communityCards: hand.communityCards,
    players: hand.players.map(p => ({
      seatIndex: p.seatIndex,
      userName: p.userName,
      // Reveal policy: only the players whose cards are shown get their hole
      // cards sent. Mucked losers and uncontested winners stay hidden — every
      // client already knows its own cards from the private hole-card events.
      holeCards: p.revealed ? p.holeCards : undefined,
      mucked: p.mucked || false,
      revealed: p.revealed || false,
      stack: p.stack,
    })),
  });

  setTimeout(() => {
    const g = ringGames.get(gameId);
    if (!g) return;

    // No runout should still be pending once the hand is complete.
    clearRunoutTimer(gameId);

    // ── BOTS ── Busted bots leave the table now that the hand is over so
    // their seats free up for humans. Their stacks were synced to the seats
    // before this ran, so stack <= 0 means truly eliminated.
    removeBustedBots(gameId);
    // ── /BOTS ──

    // If no human players remain, close the table entirely
    if (!hasHumanPlayer(g)) {
      deactivateGame(gameId);
      return;
    }

    // If fewer than 2 players can actually play, return to WAITING lobby
    const playableCount = g.seats.filter(s =>
      s && s.isConnected && !s.isSittingOut && s.stack > 0
    ).length;
    if (playableCount < 2) {
      clearActionTimer(gameId);
      g.currentHand = null;
      g.gameState = 'WAITING';
      broadcastTableState(gameId);
      console.log(`[Game] ${gameId} returned to WAITING (not enough players)`);
      return;
    }

    const nextHandCount = (handCounters.get(gameId) || 0) + 1;
    const nextHand = createHand(g, nextHandCount);
    if (nextHand) {
      startHand(nextHand);
      g.currentHand = nextHand;
      g.gameState = nextHand.gameStatus;
      handCounters.set(gameId, nextHandCount);
      broadcastGameState(gameId);
      setActionTimer(gameId);
    }
  }, 6000);
}

function recordAction(gameId, seatIndex, action, amount) {
  const game = ringGames.get(gameId);
  if (!game || !game.currentHand) return;

  const player = game.currentHand.players.find(p => p.seatIndex === seatIndex);
  if (!player) return;

  const actionRecord = {
    seatIndex,
    userName: player.userName,
    action,
    amount: amount || null,
    timestamp: Date.now(),
  };

  lastActions.set(gameId, actionRecord);
  io.to(gameRoom(gameId)).emit('last_action', actionRecord);
}

// ============================================================
// Socket.io Event Handlers
// ============================================================
io.on('connection', (socket) => {
  console.log(`[Connect] ${socket.id} (user: ${socket.displayName})`);

  userIdToSocket.set(socket.userId, socket.id);

  // ---------- GET BANKROLL ----------
  socket.on('get_bankroll', async (data, callback) => {
    try {
      const bankroll = await getBankroll(socket.userId);
      // If bankroll is 0 and user doesn't exist, session is invalid
      if (bankroll === 0) {
        const exists = await userExists(socket.userId);
        if (!exists) {
          return callback({ error: 'SESSION_EXPIRED', redirect: 'auth' });
        }
      }
      callback(null, { bankroll });
    } catch (err) {
      callback({ error: 'Failed to get bankroll' });
    }
  });

  // ---------- GET STAKE LEVELS ----------
  socket.on('get_stake_levels', async (data, callback) => {
    try {
      const levels = Object.values(STAKE_LEVELS).map(config => ({
        key: config.key,
        name: config.name,
        sb: config.sb,
        bb: config.bb,
        minBuyin: config.minBuyin,
        maxBuyin: config.maxBuyin,
      }));
      callback(null, { levels });
    } catch (err) {
      callback({ error: 'Failed to get stake levels' });
    }
  });      // ---------- JOIN RING GAME (by stake level) ----------
  socket.on('join_ring_game', async ({ stakeLevel, buyinAmount }, callback) => {
    try {
      const userId = socket.userId;
      const displayName = socket.displayName;

      // Validate stake level
      const config = STAKE_LEVELS[stakeLevel];
      if (!config) {
        return callback && callback({ error: 'Invalid stake level' });
      }

      // Validate buy-in
      const buyin = parseInt(buyinAmount);
      if (!buyin || buyin < config.minBuyin || buyin > config.maxBuyin) {
        return callback && callback({ error: `Buy-in must be between ${config.minBuyin} and ${config.maxBuyin} chips` });
      }

      // Check bankroll
      let newBankroll;
      try {
        newBankroll = await deductBankroll(userId, buyin);
      } catch (e) {
        if (e.message === 'USER_NOT_FOUND') {
          return callback && callback({ error: 'SESSION_EXPIRED', redirect: 'auth' });
        }
        return callback && callback({ error: `Insufficient bankroll. You have less than ${buyin} chips.` });
      }

      // Find or create a table at this stake level
      const result = findOrCreateTable(stakeLevel);
      if (!result) {
        return callback && callback({ error: 'Failed to find or create a table' });
      }

      const { game, seatIndex, isNew } = result;
      const gameId = game.id;

      // If newly created, set the first joiner as host
      if (isNew) {
        game.hostId = userId;
      }

      // Create player session
      let sessionId = null;
      try {
        const sessionResult = await pool.query(
          `INSERT INTO player_sessions (user_id, game_id, buyin_amount, current_stack)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [userId, gameId, buyin, buyin]
        );
        sessionId = sessionResult.rows[0].id;
      } catch (dbErr) {
        console.error('[DB] Error creating player session:', dbErr.message);
      }

      // Assign seat
      game.seats[seatIndex] = {
        userId,
        userName: displayName,
        stack: buyin,
        isReady: true,
        isConnected: true,
        isSittingOut: false,
        sessionId,
      };

      socket.join(gameRoom(gameId));
      socketToPlayer.set(socket.id, { gameId, userId, seatIndex });

      console.log(`[Join] ${displayName} joined "${game.tableName}" with ${buyin} chips (stakes: ${config.name})`);

      notifyBankroll(userId, newBankroll);

      // Build the initial players array for the response
      const initialPlayers = game.seats.map((seat, index) => {
        if (!seat) return null;
        return {
          seatIndex: index,
          userName: seat.userName,
          stack: seat.stack,
          isReady: seat.isReady,
          isConnected: seat.isConnected,
          isHost: seat.userId === game.hostId,
          isSittingOut: seat.isSittingOut || false,
          isBot: !!seat.isBot,
          userId: seat.userId,
        };
      });

      callback && callback(null, {
        gameId,
        tableName: game.tableName,
        stakeLevel,
        smallBlind: game.tableSettings.sb,
        bigBlind: game.tableSettings.bb,
        userId,
        seatIndex,
        buyinAmount: buyin,
        minBuyin: game.minBuyin,
        maxBuyin: game.maxBuyin,
        initialPlayers,
        gameState: game.gameState,
        hostId: game.hostId,
        // ── BOTS ──
        botsEnabled: BOTS_ENABLED,
      });

      broadcastTableState(gameId);

      // Auto-start if enough players are ready
      checkAutoStart(gameId);
    } catch (err) {
      console.error('[Join Ring Game Error]', err);
      callback && callback({ error: 'Failed to join ring game' });
    }
  });

  // ---------- LEAVE RING GAME (Cash Out) ----------
  socket.on('leave_ring_game', async ({ gameId }, callback) => {
    try {
      const userId = socket.userId;

      // The socket→seat mapping can be lost after a reconnect blip (new
      // socket id not yet re-registered by rejoin). Fall back to finding the
      // seat by userId so cash-out still works instead of erroring out.
      let playerInfo = socketToPlayer.get(socket.id);
      if (!playerInfo || playerInfo.gameId !== gameId) {
        const gameByUser = ringGames.get(gameId);
        if (gameByUser) {
          const seatIdx = gameByUser.seats.findIndex(s => s && s.userId === userId);
          if (seatIdx !== -1) {
            playerInfo = { gameId, userId, seatIndex: seatIdx };
            socketToPlayer.set(socket.id, playerInfo);
          }
        }
      }

      const game = ringGames.get(gameId);
      if (!game) {
        socketToPlayer.delete(socket.id);
        // Server restarted and the in-memory table is gone. Refund any orphaned
        // DB session for this player so they never lose their buy-in.
        try {
          const refunded = await recoverOrphanedSessions(userId);
          if (refunded > 0) {
            const bankroll = await getBankroll(userId);
            notifyBankroll(userId, bankroll);
            return callback && callback({
              error: 'Table closed — chips returned to your bankroll',
              refunded,
              bankroll,
            });
          }
        } catch (err) {
          console.error('[Leave] Recovery refund failed:', err.message);
        }
        return callback && callback({ error: 'Table not found' });
      }

      if (!playerInfo || playerInfo.seatIndex < 0 || playerInfo.gameId !== gameId) {
        return callback && callback({ error: 'Not at this table' });
      }

      const seat = game.seats[playerInfo.seatIndex];
      if (!seat || seat.userId !== socket.userId) {
        return callback && callback({ error: 'Not seated at this table' });
      }

      const cashOutAmount = seat.stack || 0;

      // Add stack back to bankroll
      let newBankroll;
      try {
        newBankroll = await addToBankroll(socket.userId, cashOutAmount);
      } catch (e) {
        console.error('[DB] Error adding to bankroll:', e.message);
        newBankroll = await getBankroll(socket.userId);
      }

      // Update player session
      if (seat.sessionId) {
        try {
          await pool.query(
            'UPDATE player_sessions SET current_stack = $1, left_at = NOW() WHERE id = $2',
            [cashOutAmount, seat.sessionId]
          );
        } catch (dbErr) {
          console.error('[DB] Error updating player session:', dbErr.message);
        }
      }

      // Remove from seat
      game.seats[playerInfo.seatIndex] = null;
      socket.leave(gameRoom(gameId));
      socketToPlayer.delete(socket.id);

      // If host left, assign new host or mark inactive
      if (seat.userId === game.hostId) {
        const nextPlayer = game.seats.find(s => s && s.userId);
        if (nextPlayer) {
          game.hostId = nextPlayer.userId;
          console.log(`[Host] New host for ${gameId}: ${nextPlayer.userName}`);
        } else {
          // No players left — deactivate
          try {
            await pool.query('UPDATE ring_games SET is_active = FALSE WHERE id = $1', [gameId]);
          } catch (dbErr) {
            console.error('[DB] Error deactivating game:', dbErr.message);
          }
          ringGames.delete(gameId);
          console.log(`[Game] ${gameId} deactivated (no players)`);
        }
      }

      notifyBankroll(socket.userId, newBankroll);

      console.log(`[Cash Out] ${seat.userName} cashed out ${cashOutAmount} chips from "${game.tableName}"`);

      callback && callback(null, { cashOutAmount, bankroll: newBankroll });
      broadcastTableState(gameId);
    } catch (err) {
      console.error('[Leave Ring Game Error]', err);
      callback && callback({ error: 'Failed to cash out' });
    }
  });

  // ---------- START GAME ----------
  socket.on('start_game', ({ gameId }, callback) => {
    try {
      const playerInfo = socketToPlayer.get(socket.id);
      if (!playerInfo || playerInfo.gameId !== gameId) {
        return callback && callback({ error: 'Not at this table' });
      }

      const game = ringGames.get(gameId);
      if (!game) {
        return callback && callback({ error: 'Table not found' });
      }

      if (playerInfo.userId !== game.hostId) {
        return callback && callback({ error: 'Only the host can start the game' });
      }

      if (game.gameState !== 'WAITING') {
        return callback && callback({ error: 'Game already in progress' });
      }

      const activePlayers = game.seats.filter(s => s && s.isConnected);
      if (activePlayers.length < 2) {
        return callback && callback({ error: 'Need at least 2 connected players' });
      }

      let handCount = handCounters.get(gameId) || 0;
      const hand = createHand(game, handCount);
      if (!hand) {
        return callback && callback({ error: 'Not enough active players' });
      }

      startHand(hand);
      game.currentHand = hand;
      game.gameState = hand.gameStatus;
      handCounters.set(gameId, handCount + 1);

      console.log(`[Start Game] Game ${gameId} hand ${handCount} started`);

      broadcastGameState(gameId);
      setActionTimer(gameId);

      callback && callback(null, { success: true });
    } catch (err) {
      console.error('[Start Game Error]', err);
      callback && callback({ error: 'Failed to start game' });
    }
  });

  // ---------- PLAYER ACTION ----------
  socket.on('player_action', ({ gameId, action, amount }, callback) => {
    try {
      const playerInfo = socketToPlayer.get(socket.id);
      if (!playerInfo || playerInfo.gameId !== gameId) {
        return callback && callback({ error: 'Not at this table' });
      }

      const game = ringGames.get(gameId);
      if (!game || !game.currentHand) {
        return callback && callback({ error: 'No game in progress' });
      }

      const result = handleAction(game.currentHand, playerInfo.seatIndex, action, amount, { deferAdvance: true });

      if (result.error) {
        return callback && callback({ error: result.error });
      }

      recordAction(gameId, playerInfo.seatIndex, action, amount);

      const actingUserId = game.currentHand.players.find(p => p.seatIndex === playerInfo.seatIndex)?.userId;
      if (actingUserId) {
        const actionStatMap = { fold: 'foldsMade', call: 'callsMade', raise: 'raisesMade', bet: 'betsMade' };
        const statName = actionStatMap[action];
        if (statName) {
          ChallengeTracker.trackStat(actingUserId, statName, 1);
        }
        const player = game.currentHand.players.find(p => p.seatIndex === playerInfo.seatIndex);
        if (player && player.isAllIn) {
          ChallengeTracker.trackStat(actingUserId, 'allInsMade', 1);
        }
        // Hand tracker action counts
        const handStatsMap = { fold: 'folds', call: 'calls', raise: 'raises', bet: 'raises', check: 'checks' };
        const hStat = handStatsMap[action];
        if (hStat) HandStats.trackStat(actingUserId, hStat, 1);
        if (player && player.isAllIn) HandStats.trackStat(actingUserId, 'all_ins', 1);
      }

      // NOTE: street-seen stats (flopsSeen etc.) are tracked in
      // scheduleRunout's dealNextStreet — the street transition happens there
      // now, because round-completing actions defer their advance so the
      // settled bets stay visible before the next street is dealt.

      game.gameState = game.currentHand.gameStatus;

      for (const hp of game.currentHand.players) {
        const seat = game.seats[hp.seatIndex];
        if (seat) {
          seat.stack = hp.stack;
        }
      }

      broadcastGameState(gameId);
      clearActionTimer(gameId);

      if (isHandComplete(game.currentHand)) {
        const hand = game.currentHand;
        lastActions.delete(gameId);

        handleHandComplete(gameId, hand);
      } else if (game.currentHand.gameStatus === GAME_STATES.SHOWDOWN) {
        // River betting is done — run the interactive showdown reveal phase.
        startShowdownTimer(gameId);
      } else if (isRoundComplete(game.currentHand)) {
        // The betting round settled — let the chips visibly land in front of
        // the seats for a beat, then deal the next street (or run out the
        // board if everyone remaining is all-in).
        scheduleRunout(gameId, game.currentHand, ROUND_SETTLE_DELAY_MS);
      } else {
        setActionTimer(gameId);
      }

      callback && callback(null, { success: true });
    } catch (err) {
      console.error('[Player Action Error]', err);
      callback && callback({ error: 'Failed to process action' });
    }
  });

  // ---------- SHOWDOWN DECISION (Show Cards / Muck) ----------
  socket.on('showdown_decision', ({ gameId, show }, callback) => {
    try {
      const playerInfo = socketToPlayer.get(socket.id);
      if (!playerInfo || playerInfo.gameId !== gameId) {
        return callback && callback({ error: 'Not at this table' });
      }

      const game = ringGames.get(gameId);
      if (!game || !game.currentHand) {
        return callback && callback({ error: 'No game in progress' });
      }

      const hand = game.currentHand;
      if (hand.gameStatus !== GAME_STATES.SHOWDOWN || !hand.showdown || !hand.showdown.active) {
        return callback && callback({ error: 'Not in showdown' });
      }

      const curSeat = hand.showdown.queue[hand.showdown.queuePos];
      if (curSeat !== playerInfo.seatIndex) {
        return callback && callback({ error: 'Not your turn to reveal' });
      }

      const result = applyShowdownDecision(hand, playerInfo.seatIndex, show !== false);
      if (result.error) {
        return callback && callback({ error: result.error });
      }

      const actingPlayer = hand.players.find(p => p.seatIndex === playerInfo.seatIndex);
      console.log(`[Showdown] ${actingPlayer ? actingPlayer.userName : '?'} ${show !== false ? 'shows' : 'mucks'}`);

      clearShowdownTimer(gameId);
      game.gameState = hand.gameStatus;
      for (const hp of hand.players) {
        const seat = game.seats[hp.seatIndex];
        if (seat) seat.stack = hp.stack;
      }
      broadcastGameState(gameId);

      if (isHandComplete(hand)) {
        handleHandComplete(gameId, hand);
      } else {
        startShowdownTimer(gameId);
      }

      callback && callback(null, { success: true });
    } catch (err) {
      console.error('[Showdown Decision Error]', err);
      callback && callback({ error: 'Failed to process decision' });
    }
  });

  // ---------- TOGGLE READY ----------
  socket.on('player_ready', ({ gameId }) => {
    const playerInfo = socketToPlayer.get(socket.id);
    if (!playerInfo || playerInfo.gameId !== gameId) return;

    const game = ringGames.get(gameId);
    if (!game) return;

    const seat = game.seats[playerInfo.seatIndex];
    if (!seat) return;

    seat.isReady = !seat.isReady;
    console.log(`[Ready] ${seat.userName} is ${seat.isReady ? 'ready' : 'not ready'}`);

    broadcastTableState(gameId);
    checkAutoStart(gameId);
  });

  // ---------- REJOIN RING GAME ----------
  socket.on('rejoin_ring_game', async ({ gameId }, callback) => {
    const game = ringGames.get(gameId);
    if (!game) {
      // Server restarted and the table's in-memory state is gone. Refund the
      // player's orphaned session so they don't lose their buy-in, then report
      // the table is gone so the client can return them to the lobby.
      try {
        const refunded = await recoverOrphanedSessions(socket.userId);
        if (refunded > 0) {
          const bankroll = await getBankroll(socket.userId);
          notifyBankroll(socket.userId, bankroll);
          return callback && callback({ error: 'Table not found', refunded, bankroll });
        }
      } catch (err) {
        console.error('[Rejoin] Recovery refund failed:', err.message);
      }
      return callback && callback({ error: 'Table not found' });
    }

    const userId = socket.userId;

    const seatIndex = game.seats.findIndex(s => s && s.userId === userId);
    if (seatIndex === -1) return callback && callback({ error: 'Player not found at this table' });

    const seat = game.seats[seatIndex];
    seat.isConnected = true;

    const timeoutKey = `${gameId}:${userId}`;
    if (disconnectTimeouts.has(timeoutKey)) {
      clearTimeout(disconnectTimeouts.get(timeoutKey));
      disconnectTimeouts.delete(timeoutKey);
      console.log(`[Reconnect] ${seat.userName} reconnected, auto-fold timeout cleared`);
    }

    socket.join(gameRoom(gameId));
    socketToPlayer.set(socket.id, { gameId, userId, seatIndex });

    callback && callback(null, {
      gameId: game.id,
      tableName: game.tableName,
      userId,
      seatIndex,
      minBuyin: game.minBuyin,
      maxBuyin: game.maxBuyin,
    });

    broadcastTableState(gameId);

    if (game.currentHand) {
      const snapshot = getReconnectionSnapshot(game.currentHand, seatIndex);
      socket.emit('full_state_snapshot', snapshot);
    }
  });

  // ---------- REBUY ----------
  socket.on('player_rebuy', async ({ gameId, buyinAmount }, callback) => {
    try {
      const playerInfo = socketToPlayer.get(socket.id);
      if (!playerInfo || playerInfo.gameId !== gameId) {
        return callback && callback({ error: 'Not at this table' });
      }

      const game = ringGames.get(gameId);
      if (!game) {
        return callback && callback({ error: 'Table not found' });
      }

      const seat = game.seats[playerInfo.seatIndex];
      if (!seat) {
        return callback && callback({ error: 'Not seated' });
      }

      if (!game.tableSettings.allowRebuys) {
        return callback && callback({ error: 'Rebuys not allowed' });
      }

      // Player can rebuy any amount between min and max buyin
      const buyin = buyinAmount ? parseInt(buyinAmount) : game.minBuyin;
      if (buyin < game.minBuyin || buyin > game.maxBuyin) {
        return callback && callback({ error: `Rebuy must be between ${game.minBuyin} and ${game.maxBuyin}` });
      }

      // Deduct from bankroll
      let newBankroll;
      try {
        newBankroll = await deductBankroll(socket.userId, buyin);
      } catch (e) {
        if (e.message === 'USER_NOT_FOUND') {
          return callback && callback({ error: 'SESSION_EXPIRED', redirect: 'auth' });
        }
        return callback && callback({ error: 'Insufficient bankroll for rebuy' });
      }

      seat.stack = buyin;
      seat.isReady = true;
      seat.isConnected = true;

      // Update player session
      if (seat.sessionId) {
        try {
          await pool.query(
            'UPDATE player_sessions SET current_stack = $1 WHERE id = $2',
            [buyin, seat.sessionId]
          );
        } catch (dbErr) {
          console.error('[DB] Error updating session stack:', dbErr.message);
        }
      }

      notifyBankroll(socket.userId, newBankroll);

      console.log(`[Rebuy] ${seat.userName} rebought for ${buyin}`);

      broadcastTableState(gameId);
      callback && callback(null, { success: true, bankroll: newBankroll });
    } catch (err) {
      console.error('[Rebuy Error]', err);
      callback && callback({ error: 'Failed to process rebuy' });
    }
  });

  // ---------- REFUND BUY-IN (manual recovery) ----------
  socket.on('refund_buyin', async ({ gameId }, callback) => {
    try {
      const playerInfo = socketToPlayer.get(socket.id);
      if (!playerInfo) {
        return callback && callback({ error: 'Not at a table' });
      }

      const game = ringGames.get(gameId || playerInfo.gameId);
      if (!game) {
        return callback && callback({ error: 'Table not found' });
      }

      const seat = game.seats[playerInfo.seatIndex];
      if (!seat || seat.userId !== socket.userId) {
        return callback && callback({ error: 'Not seated at this table' });
      }

      if (game.gameState !== 'WAITING') {
        return callback && callback({ error: 'Game already started, use Cash Out instead' });
      }

      const refundAmount = seat.stack || 0;
      if (refundAmount <= 0) {
        return callback && callback({ error: 'Nothing to refund' });
      }

      const newBankroll = await addToBankroll(socket.userId, refundAmount);

      // Update session
      if (seat.sessionId) {
        pool.query(
          'UPDATE player_sessions SET current_stack = $1, left_at = NOW() WHERE id = $2',
          [0, seat.sessionId]
        ).catch(err => console.error('[DB] Error:', err.message));
      }

      // Clear seat
      game.seats[playerInfo.seatIndex] = null;
      socket.leave(gameRoom(game.id));
      socketToPlayer.delete(socket.id);

      console.log(`[Refund-Manual] ${seat.userName} manually refunded ${refundAmount} chips`);

      notifyBankroll(socket.userId, newBankroll);
      broadcastTableState(game.id);

      callback && callback(null, { refundAmount, bankroll: newBankroll });
    } catch (err) {
      console.error('[Refund Error]', err);
      callback && callback({ error: 'Refund failed' });
    }
  });

  // ---------- SIT OUT ----------
  socket.on('player_sit_out', ({ gameId }, callback) => {
    try {
      const playerInfo = socketToPlayer.get(socket.id);
      if (!playerInfo || playerInfo.gameId !== gameId) {
        return callback && callback({ error: 'Not at this table' });
      }

      const game = ringGames.get(gameId);
      if (!game) {
        return callback && callback({ error: 'Table not found' });
      }

      const seat = game.seats[playerInfo.seatIndex];
      if (!seat) {
        return callback && callback({ error: 'Not seated' });
      }

      seat.isSittingOut = !seat.isSittingOut;
      seat.isReady = false;

      console.log(`[Sit Out] ${seat.userName} ${seat.isSittingOut ? 'sitting out' : 'back in'}`);

      broadcastTableState(gameId);
      callback && callback(null, { success: true });
    } catch (err) {
      console.error('[Sit Out Error]', err);
      callback && callback({ error: 'Failed to process sit out' });
    }
  });

  // ---------- ADD BOTS (host only, between hands) ----------
  // ── BOTS ── Bots fill empty seats so a solo player can practice against
  // the table while waiting for friends to join. Host-only and only allowed
  // in the WAITING lobby (adding mid-hand would desync the dealt hand).
  socket.on('add_bots', ({ gameId, count = 2 }, callback) => {
    try {
      if (!BOTS_ENABLED) {
        return callback && callback({ error: 'Bots are disabled' });
      }

      const playerInfo = socketToPlayer.get(socket.id);
      if (!playerInfo || playerInfo.gameId !== gameId) {
        return callback && callback({ error: 'Not at this table' });
      }

      const game = ringGames.get(gameId);
      if (!game) {
        return callback && callback({ error: 'Table not found' });
      }

      if (socket.userId !== game.hostId) {
        return callback && callback({ error: 'Only the host can add bots' });
      }

      if (game.gameState !== 'WAITING') {
        return callback && callback({ error: 'Bots can only be added between hands' });
      }

      const countToAdd = Math.min(Math.max(parseInt(count) || 2, 1), MAX_SEATS);
      const usedNames = game.seats.filter(Boolean).map(s => s.userName);
      // Buy in for the MINIMUM so bot chips don't flood the table economy —
      // a human grinding chips off bots shouldn't be able to mint max buy-ins.
      const buyin = game.minBuyin;

      let added = 0;
      for (let i = 0; i < MAX_SEATS && added < countToAdd; i++) {
        if (game.seats[i]) continue;
        const botId = BotPlayer.generateBotId();
        const botName = BotPlayer.getBotName(usedNames);
        usedNames.push(botName);
        game.seats[i] = {
          userId: botId,
          userName: botName,
          stack: buyin,
          isReady: true,
          isConnected: true,
          isSittingOut: false,
          isBot: true,
          sessionId: null,
        };
        added++;
        console.log(`[Bots] "${botName}" joined ${game.tableName} (seat ${i}) with ${buyin} chips`);
      }

      if (added === 0) {
        return callback && callback({ error: 'Table is full' });
      }

      broadcastTableState(gameId);
      checkAutoStart(gameId);
      callback && callback(null, { success: true, added });
    } catch (err) {
      console.error('[Add Bots Error]', err);
      callback && callback({ error: 'Failed to add bots' });
    }
  });

  // ---------- REMOVE BOTS (host only, between hands) ----------
  socket.on('remove_bots', ({ gameId }, callback) => {
    try {
      if (!BOTS_ENABLED) {
        return callback && callback({ error: 'Bots are disabled' });
      }

      const playerInfo = socketToPlayer.get(socket.id);
      if (!playerInfo || playerInfo.gameId !== gameId) {
        return callback && callback({ error: 'Not at this table' });
      }

      const game = ringGames.get(gameId);
      if (!game) {
        return callback && callback({ error: 'Table not found' });
      }

      if (socket.userId !== game.hostId) {
        return callback && callback({ error: 'Only the host can remove bots' });
      }

      if (game.gameState !== 'WAITING') {
        return callback && callback({ error: 'Bots can only be removed between hands' });
      }

      let removed = 0;
      for (let i = 0; i < MAX_SEATS; i++) {
        const seat = game.seats[i];
        if (seat && BotPlayer.isBotUserId(seat.userId)) {
          game.seats[i] = null;
          removed++;
          console.log(`[Bots] "${seat.userName}" removed from ${game.tableName} (seat ${i})`);
        }
      }

      broadcastTableState(gameId);
      callback && callback(null, { success: true, removed });
    } catch (err) {
      console.error('[Remove Bots Error]', err);
      callback && callback({ error: 'Failed to remove bots' });
    }
  });
  // ── /BOTS ──

  // ---------- DISCONNECT ----------
  socket.on('disconnect', () => {
    userIdToSocket.delete(socket.userId);

    const playerInfo = socketToPlayer.get(socket.id);
    if (playerInfo) {
      const { gameId, userId, seatIndex } = playerInfo;
      const game = ringGames.get(gameId);

      if (game) {
        const seat = game.seats[seatIndex];
        if (seat && seat.userId === userId) {
          seat.isConnected = false;
          console.log(`[Disconnect] ${seat.userName} disconnected from game ${gameId} (state: ${game.gameState})`);

          // ── REFUND SAFETY NET ──────────────────────────────────
          // If the game NEVER started (WAITING), refund the player's buy-in
          // and free their seat. Prevents lost chips from crashes.
          // IMPORTANT: The refund MUST complete BEFORE we clear the seat,
          // otherwise a failed DB query silently eats the player's chips.
          if (game.gameState === 'WAITING') {
            const refundAmount = seat.stack || 0;
            if (refundAmount > 0) {
              // Await the refund before touching the seat
              addToBankroll(userId, refundAmount)
                .then(newBankroll => {
                  console.log(`[Refund] ${seat.userName} refunded ${refundAmount} chips (game never started). New bankroll: ${newBankroll}`);
                  notifyBankroll(userId, newBankroll);

                  // ── Only clear seat AFTER successful refund ──
                  cleanupSeat(game, seatIndex, seat, userId, gameId);
                  broadcastTableState(gameId);
                })
                .catch(refundErr => {
                  console.error(`[Refund] FAILED for ${seat.userName} (${refundAmount} chips): ${refundErr.message}`);
                  // Seat stays — player can reconnect and retry
                });
            } else {
              // No refund needed (0 stack or bot) — just clean up
              cleanupSeat(game, seatIndex, seat, userId, gameId);
              broadcastTableState(gameId);
            }
          } else {
            // ── Game was in progress — set auto-fold timeout ──
            if (game.currentHand) {
              const timeoutKey = `${gameId}:${userId}`;

              if (disconnectTimeouts.has(timeoutKey)) {
                clearTimeout(disconnectTimeouts.get(timeoutKey));
              }

              const disconnectTimeout = setTimeout(() => {
                const hand = game.currentHand;
                if (hand && hand.gameStatus !== 'WAITING' && hand.gameStatus !== GAME_STATES.SHOWDOWN && hand.gameStatus !== GAME_STATES.HAND_COMPLETE) {
                  const playerInHand = hand.players.find(p => p.seatIndex === seatIndex);
                  if (playerInHand && !playerInHand.isFolded && !playerInHand.isAllIn) {
                    clearActionTimer(gameId);
                    const result = handleAction(hand, seatIndex, 'fold', { deferAdvance: true });
                    if (!result.error) {
                      console.log(`[Auto-Fold] ${seat.userName} folded due to disconnect timeout`);
                      if (seat) seat.isSittingOut = true;
                      game.gameState = hand.gameStatus;
                      for (const hp of hand.players) {
                        const s = game.seats[hp.seatIndex];
                        if (s) s.stack = hp.stack;
                      }
                      broadcastGameState(gameId);
                      if (isHandComplete(hand)) {
                        handleHandComplete(gameId, hand);
                      } else if (hand.gameStatus === GAME_STATES.SHOWDOWN) {
                        startShowdownTimer(gameId);
                      } else if (isRoundComplete(hand)) {
                        scheduleRunout(gameId, hand, ROUND_SETTLE_DELAY_MS);
                      } else {
                        setActionTimer(gameId);
                      }
                    }
                  }
                }
                disconnectTimeouts.delete(timeoutKey);
              }, 60000);

              disconnectTimeouts.set(timeoutKey, disconnectTimeout);
            }

            broadcastTableState(gameId);
          }
        }
      }

      socketToPlayer.delete(socket.id);
    }
    console.log(`[Disconnect] ${socket.id}`);
  });
});

// ============================================================
// Initialize Trackers
// ============================================================
ChallengeTracker.init(io, userIdToSocket).catch(err => {
  console.error('[Challenges] Failed to initialize tracker:', err.message);
});

HandStats.init();

// ============================================================
// Crash Recovery — refund orphaned sessions from a previous run
// ============================================================
// Ring-game seats are in-memory only, so after a server restart (deploy,
// crash, OOM) every seated stack would be lost. player_sessions rows with
// left_at IS NULL are the only record that the chips existed — refund them to
// their owners' bankrolls on boot so nobody loses their buy-in to a restart.
recoverOrphanedSessions()
  .then(total => {
    if (total > 0) {
      console.log(`[Startup] Refunded ${total} chips from orphaned player sessions`);
    }
  })
  .catch(err => console.error('[Startup] Orphaned session recovery failed:', err.message));

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Server] Shutting down...');
  ChallengeTracker.shutdown();
  HandStats.shutdown();
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('[Server] Shutting down...');
  ChallengeTracker.shutdown();
  HandStats.shutdown();
  process.exit(0);
});

// ============================================================
// Start Server
// ============================================================
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Poker Club running on port ${PORT}`);
  console.log(`   CORS Origin: ${process.env.CORS_ORIGIN || 'http://localhost:5173'}`);
  console.log(`   WebSocket ready for connections`);
});
