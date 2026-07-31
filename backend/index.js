const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { GAME_STATES, createHand, startHand, getPublicState, getPrivateState, getReconnectionSnapshot, isHandComplete, handleAction } = require('./GameHand');
const ChallengeTracker = require('./ChallengeTracker');
const pool = require('./db');

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
  console.log('🏁 Production mode');
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

// ============================================================
// Pre-defined Stake Levels (auto-table creation)
// ============================================================
const STAKE_LEVELS = {
  micro: {
    key: 'micro',
    name: 'Micro Stakes',
    sb: 10,
    bb: 20,
    minBuyin: 50,
    maxBuyin: 500,
    timer: 20,
  },
  low: {
    key: 'low',
    name: 'Low Stakes',
    sb: 50,
    bb: 100,
    minBuyin: 500,
    maxBuyin: 5000,
    timer: 20,
  },
  medium: {
    key: 'medium',
    name: 'Medium Stakes',
    sb: 500,
    bb: 1000,
    minBuyin: 5000,
    maxBuyin: 50000,
    timer: 20,
  },
  high: {
    key: 'high',
    name: 'High Stakes',
    sb: 5000,
    bb: 10000,
    minBuyin: 50000,
    maxBuyin: 500000,
    timer: 20,
  },
  ultra: {
    key: 'ultra',
    name: 'Ultra Stakes',
    sb: 50000,
    bb: 100000,
    minBuyin: 500000,
    maxBuyin: 5000000,
    timer: 20,
  },
  superHigh: {
    key: 'superHigh',
    name: 'Super High Roller',
    sb: 500000,
    bb: 1000000,
    minBuyin: 5000000,
    maxBuyin: 50000000,
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

function setActionTimer(gameId) {
  clearActionTimer(gameId);

  const game = ringGames.get(gameId);
  if (!game || !game.currentHand) return;

  const hand = game.currentHand;
  if (hand.gameStatus === GAME_STATES.SHOWDOWN || hand.gameStatus === GAME_STATES.HAND_COMPLETE) return;

  const currentPlayer = hand.players[hand.currentPlayerIndex];
  if (!currentPlayer || currentPlayer.isAllIn || currentPlayer.isFolded) return;

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

    const result = handleAction(handNow, seatIdx, 'fold');
    if (result.error) return;

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
      trackHandComplete(handNow);
      io.to(gameRoom(gameId)).emit('hand_complete', {
        handResult: handNow.handResult,
        communityCards: handNow.communityCards,
        players: handNow.players.map(p => ({
          seatIndex: p.seatIndex,
          userName: p.userName,
          holeCards: p.holeCards,
          stack: p.stack,
        })),
      });

      setTimeout(() => {
        const g = ringGames.get(gameId);
        if (!g) return;
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
      }, 12000);
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

  hand.players.forEach(p => {
    if (p.userId && !p.userId.startsWith('bot_')) {
      ChallengeTracker.trackStat(p.userId, 'handsPlayed', 1);
    }
  });

  if (hand.winningUserId && !hand.winningUserId.startsWith('bot_')) {
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
      if (p.userId && !p.userId.startsWith('bot_')) {
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

  // If host left, reassign or deactivate
  if (seat.userId === game.hostId) {
    const nextPlayer = game.seats.find(s => s);
    if (nextPlayer) {
      game.hostId = nextPlayer.userId;
      console.log(`[Host] New host for ${gameId}: ${nextPlayer.userName}`);
    } else {
      // No players left — deactivate
      ringGames.delete(gameId);
      pool.query('UPDATE ring_games SET is_active = FALSE WHERE id = $1', [gameId])
        .catch(err => console.error('[DB] Error deactivating game:', err.message));
      console.log(`[Game] ${gameId} deactivated (no players)`);
    }
  }
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
  });

  // ---------- JOIN RING GAME (by stake level) ----------
  socket.on('join_ring_game', async ({ stakeLevel, buyinAmount }, callback) => {
    try {
      const userId = socket.userId;
      const displayName = socket.displayName;

      // Validate stake level
      const config = STAKE_LEVELS[stakeLevel];
      if (!config) {
        return callback({ error: 'Invalid stake level' });
      }

      // Validate buy-in
      const buyin = parseInt(buyinAmount);
      if (!buyin || buyin < config.minBuyin || buyin > config.maxBuyin) {
        return callback({ error: `Buy-in must be between ${config.minBuyin} and ${config.maxBuyin} chips` });
      }

      // Check bankroll
      let newBankroll;
      try {
        newBankroll = await deductBankroll(userId, buyin);
      } catch (e) {
        if (e.message === 'USER_NOT_FOUND') {
          return callback({ error: 'SESSION_EXPIRED', redirect: 'auth' });
        }
        return callback({ error: `Insufficient bankroll. You have less than ${buyin} chips.` });
      }

      // Find or create a table at this stake level
      const result = findOrCreateTable(stakeLevel);
      if (!result) {
        return callback({ error: 'Failed to find or create a table' });
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
        };
      });

      callback(null, {
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
      });

      broadcastTableState(gameId);

      // Auto-start if enough players are ready
      checkAutoStart(gameId);
    } catch (err) {
      console.error('[Join Ring Game Error]', err);
      callback({ error: 'Failed to join ring game' });
    }
  });

  // ---------- LEAVE RING GAME (Cash Out) ----------
  socket.on('leave_ring_game', async ({ gameId }, callback) => {
    try {
      const playerInfo = socketToPlayer.get(socket.id);
      if (!playerInfo || playerInfo.gameId !== gameId) {
        return callback({ error: 'Not at this table' });
      }

      const game = ringGames.get(gameId);
      if (!game) {
        socketToPlayer.delete(socket.id);
        return callback({ error: 'Table not found' });
      }

      const seat = game.seats[playerInfo.seatIndex];
      if (!seat || seat.userId !== socket.userId) {
        return callback({ error: 'Not seated at this table' });
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
        const nextPlayer = game.seats.find(s => s);
        if (nextPlayer) {
          game.hostId = nextPlayer.userId;
          console.log(`[Host] New host for ${gameId}: ${nextPlayer.userName}`);
        } else {
          // No human players left — deactivate
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

      callback(null, { cashOutAmount, bankroll: newBankroll });
      broadcastTableState(gameId);
    } catch (err) {
      console.error('[Leave Ring Game Error]', err);
      callback({ error: 'Failed to cash out' });
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

      const result = handleAction(game.currentHand, playerInfo.seatIndex, action, amount);

      if (result.error) {
        return callback && callback({ error: result.error });
      }

      recordAction(gameId, playerInfo.seatIndex, action, amount);

      const actingUserId = game.currentHand.players.find(p => p.seatIndex === playerInfo.seatIndex)?.userId;
      if (actingUserId && !actingUserId.startsWith('bot_')) {
        const actionStatMap = { fold: 'foldsMade', call: 'callsMade', raise: 'raisesMade', bet: 'betsMade' };
        const statName = actionStatMap[action];
        if (statName) {
          ChallengeTracker.trackStat(actingUserId, statName, 1);
        }
        const player = game.currentHand.players.find(p => p.seatIndex === playerInfo.seatIndex);
        if (player && player.isAllIn) {
          ChallengeTracker.trackStat(actingUserId, 'allInsMade', 1);
        }
      }

      if (game.currentHand && (game.currentHand.gameStatus === 'FLOP' || game.currentHand.gameStatus === 'TURN' || game.currentHand.gameStatus === 'RIVER')) {
        const prevStatus = game.gameState;
        const newStatus = game.currentHand.gameStatus;
        const streetStat = {
          'FLOP': 'flopsSeen',
          'TURN': 'turnsSeen',
          'RIVER': 'riversSeen',
        }[newStatus];
        if (streetStat && prevStatus !== newStatus) {
          const activePlayers = game.currentHand.players.filter(p => !p.isFolded && !p.isAllIn);
          activePlayers.forEach(p => {
            if (p.userId && !p.userId.startsWith('bot_')) {
              ChallengeTracker.trackStat(p.userId, streetStat, 1);
            }
          });
        }
      }

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
        trackHandComplete(hand);
        lastActions.delete(gameId);

        io.to(gameRoom(gameId)).emit('hand_complete', {
          handResult: hand.handResult,
          communityCards: hand.communityCards,
          players: hand.players.map(p => ({
            seatIndex: p.seatIndex,
            userName: p.userName,
            holeCards: p.holeCards,
            stack: p.stack,
          })),
        });

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

        setTimeout(() => {
          const nextHandCount = (handCounters.get(gameId) || 0) + 1;
          const nextHand = createHand(game, nextHandCount);
          if (nextHand) {
            startHand(nextHand);
            game.currentHand = nextHand;
            game.gameState = nextHand.gameStatus;
            handCounters.set(gameId, nextHandCount);
            broadcastGameState(gameId);
            setActionTimer(gameId);
          }
        }, 12000);
      } else {
        setActionTimer(gameId);
      }

      callback && callback(null, { success: true });
    } catch (err) {
      console.error('[Player Action Error]', err);
      callback && callback({ error: 'Failed to process action' });
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
  socket.on('rejoin_ring_game', ({ gameId }, callback) => {
    const game = ringGames.get(gameId);
    if (!game) return callback({ error: 'Table not found' });

    const userId = socket.userId;

    const seatIndex = game.seats.findIndex(s => s && s.userId === userId);
    if (seatIndex === -1) return callback({ error: 'Player not found at this table' });

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

    callback(null, {
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

  // ---------- SEND EMOJI ----------
  socket.on('send_emoji', ({ gameId, emoji }) => {
    const playerInfo = socketToPlayer.get(socket.id);
    if (!playerInfo || playerInfo.gameId !== gameId) return;

    const game = ringGames.get(gameId);
    if (!game) return;

    const seat = game.seats[playerInfo.seatIndex];
    if (!seat) return;

    io.to(gameRoom(gameId)).emit('emoji_received', {
      seatIndex: playerInfo.seatIndex,
      userName: seat.userName,
      emoji,
      timestamp: Date.now(),
    });
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
            if (refundAmount > 0 && !userId.startsWith('bot_')) {
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
                    const result = handleAction(hand, seatIndex, 'fold');
                    if (!result.error) {
                      console.log(`[Auto-Fold] ${seat.userName} folded due to disconnect timeout`);
                      if (seat) seat.isSittingOut = true;
                      game.gameState = hand.gameStatus;
                      for (const hp of hand.players) {
                        const s = game.seats[hp.seatIndex];
                        if (s) s.stack = hp.stack;
                      }
                      broadcastGameState(gameId);
                      if (!isHandComplete(hand)) {
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
// Initialize Challenge Tracker
// ============================================================
ChallengeTracker.init(io, userIdToSocket).catch(err => {
  console.error('[Challenges] Failed to initialize tracker:', err.message);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Server] Shutting down...');
  ChallengeTracker.shutdown();
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('[Server] Shutting down...');
  ChallengeTracker.shutdown();
  process.exit(0);
});

// ============================================================
// Start Server
// ============================================================
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🃏 Poker Club Server running on port ${PORT}`);
  console.log(`   CORS Origin: ${process.env.CORS_ORIGIN || 'http://localhost:5173'}`);
  console.log(`   WebSocket ready for connections`);
});
