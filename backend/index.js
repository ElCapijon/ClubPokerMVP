const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { GAME_STATES, createHand, startHand, getPublicState, getPrivateState, getReconnectionSnapshot, isHandComplete, handleAction } = require('./GameHand');
const { getNextBotName, resetBotNames, decideAction } = require('./botPlayer');
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

/** Get a player's bankroll from DB */
async function getBankroll(userId) {
  const result = await pool.query('SELECT bankroll FROM users WHERE id = $1', [userId]);
  return result.rows.length > 0 ? parseInt(result.rows[0].bankroll) : 10000;
}

/** Deduct from bankroll and return new balance */
async function deductBankroll(userId, amount) {
  const result = await pool.query(
    'UPDATE users SET bankroll = bankroll - $1 WHERE id = $2 AND bankroll >= $1 RETURNING bankroll',
    [amount, userId]
  );
  if (result.rows.length === 0) {
    throw new Error('Insufficient bankroll');
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
// Ring Game State Factory
// ============================================================
function createRingGameState(hostUserId, hostDisplayName, tableName, minBuyin, maxBuyin, sb, bb, timer) {
  const seats = Array(MAX_SEATS).fill(null);

  return {
    id: uuidv4(),
    tableName: tableName || 'Poker Table',
    minBuyin,
    maxBuyin,
    hostId: hostUserId,
    seats,
    tableSettings: {
      sb,
      bb,
      timer: timer || 20,
      allowRebuys: true,
    },
    gameState: 'WAITING',
    currentHand: null,
    createdAt: Date.now(),
  };
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
      isBot: seat.isBot || false,
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

function processBotAction(gameId) {
  const game = ringGames.get(gameId);
  if (!game || !game.currentHand) return;

  const hand = game.currentHand;
  if (hand.gameStatus === GAME_STATES.SHOWDOWN || hand.gameStatus === GAME_STATES.HAND_COMPLETE) return;

  const currentPlayer = hand.players[hand.currentPlayerIndex];
  if (!currentPlayer || currentPlayer.isAllIn || currentPlayer.isFolded) return;

  const seat = game.seats[currentPlayer.seatIndex];
  if (!seat || !seat.isBot) return;

  const decision = decideAction(hand, currentPlayer.seatIndex);
  if (!decision) return;

  console.log(`[Bot] ${seat.userName} decides to ${decision.action}${decision.amount ? ' $' + decision.amount : ''}`);

  const result = handleAction(hand, currentPlayer.seatIndex, decision.action, decision.amount);
  if (result.error) return;

  recordAction(gameId, currentPlayer.seatIndex, decision.action, decision.amount);

  game.gameState = hand.gameStatus;
  for (const hp of hand.players) {
    const s = game.seats[hp.seatIndex];
    if (s) s.stack = hp.stack;
  }

  broadcastGameState(gameId);
  clearActionTimer(gameId);

  if (isHandComplete(hand)) {
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
}

function setActionTimer(gameId) {
  clearActionTimer(gameId);

  const game = ringGames.get(gameId);
  if (!game || !game.currentHand) return;

  const hand = game.currentHand;
  if (hand.gameStatus === GAME_STATES.SHOWDOWN || hand.gameStatus === GAME_STATES.HAND_COMPLETE) return;

  const currentPlayer = hand.players[hand.currentPlayerIndex];
  if (!currentPlayer || currentPlayer.isAllIn || currentPlayer.isFolded) return;

  const seat = game.seats[currentPlayer.seatIndex];
  if (seat && seat.isBot) {
    const botDelay = 800 + Math.random() * 1200;
    const botTimeout = setTimeout(() => processBotAction(gameId), botDelay);
    actionTimers.set(gameId, botTimeout);
    return;
  }

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
      callback(null, { bankroll });
    } catch (err) {
      callback({ error: 'Failed to get bankroll' });
    }
  });

  // ---------- GET RING GAMES ----------
  socket.on('get_ring_games', async (data, callback) => {
    try {
      // Return in-memory games plus DB-active games
      const activeGames = [];
      for (const [id, game] of ringGames) {
        if (game.gameState !== undefined) {
          const seatedCount = game.seats.filter(s => s !== null).length;
          activeGames.push({
            id,
            tableName: game.tableName,
            hostId: game.hostId,
            minBuyin: game.minBuyin,
            maxBuyin: game.maxBuyin,
            smallBlind: game.tableSettings.sb,
            bigBlind: game.tableSettings.bb,
            seatedCount,
            maxPlayers: MAX_SEATS,
            gameState: game.gameState,
          });
        }
      }

      // Also fetch from DB for persisted games not in memory (rare)
      if (activeGames.length === 0) {
        try {
          const dbResult = await pool.query(
            `SELECT id, table_name, host_user_id, min_buyin, max_buyin, small_blind, big_blind
             FROM ring_games WHERE is_active = TRUE ORDER BY created_at DESC LIMIT 20`
          );
          for (const row of dbResult.rows) {
            // Don't re-add if already in memory
            if (!ringGames.has(row.id)) {
              activeGames.push({
                id: row.id,
                tableName: row.table_name,
                hostId: row.host_user_id,
                minBuyin: row.min_buyin,
                maxBuyin: row.max_buyin,
                smallBlind: row.small_blind,
                bigBlind: row.big_blind,
                seatedCount: 0,
                maxPlayers: MAX_SEATS,
                gameState: 'WAITING',
              });
            }
          }
        } catch (dbErr) {
          console.error('[DB] Error fetching ring games:', dbErr.message);
        }
      }

      callback(null, { games: activeGames });
    } catch (err) {
      console.error('[Get Ring Games Error]', err);
      callback({ error: 'Failed to get ring games' });
    }
  });

  // ---------- CREATE RING GAME ----------
  socket.on('create_ring_game', async ({ tableName, minBuyin, maxBuyin, smallBlind, bigBlind, actionTimer, buyinAmount }, callback) => {
    try {
      const userId = socket.userId;
      const displayName = socket.displayName;

      // Validation
      if (!tableName || tableName.trim().length === 0) {
        return callback({ error: 'Table name is required' });
      }
      if (!minBuyin || !maxBuyin || minBuyin < 50 || maxBuyin > 50000000) {
        return callback({ error: 'Buy-in range 50 - 50,000,000 chips' });
      }
      if (minBuyin > maxBuyin) {
        return callback({ error: 'Min buy-in cannot exceed max buy-in' });
      }
      if (!smallBlind || !bigBlind || smallBlind < 1 || bigBlind < 2) {
        return callback({ error: 'Invalid blind amounts' });
      }
      if (tableName.trim().length > 30) {
        return callback({ error: 'Table name must be 30 characters or less' });
      }

      // Determine host buy-in amount
      const hostBuyin = buyinAmount ? parseInt(buyinAmount) : parseInt(minBuyin);
      if (hostBuyin < parseInt(minBuyin) || hostBuyin > parseInt(maxBuyin)) {
        return callback({ error: `Host buy-in must be between ${parseInt(minBuyin)} and ${parseInt(maxBuyin)}` });
      }

      // Deduct from bankroll
      let newBankroll;
      try {
        newBankroll = await deductBankroll(userId, hostBuyin);
      } catch (e) {
        return callback({ error: 'Insufficient bankroll to buy in' });
      }

      // Create ring game state
      const gameState = createRingGameState(
        userId,
        displayName,
        tableName.trim(),
        parseInt(minBuyin),
        parseInt(maxBuyin),
        parseInt(smallBlind),
        parseInt(bigBlind),
        parseInt(actionTimer) || 20
      );

      // Seat the host at seat 0
      let sessionId = null;
      try {
        const sessionResult = await pool.query(
          `INSERT INTO player_sessions (user_id, game_id, buyin_amount, current_stack)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [userId, gameState.id, hostBuyin, hostBuyin]
        );
        sessionId = sessionResult.rows[0].id;
      } catch (dbErr) {
        console.error('[DB] Error creating host session:', dbErr.message);
      }

      gameState.seats[0] = {
        userId,
        userName: displayName,
        stack: hostBuyin,
        isReady: true,
        isConnected: true,
        isSittingOut: false,
        sessionId,
      };

      ringGames.set(gameState.id, gameState);

      // Persist game to database
      try {
        await pool.query(
          `INSERT INTO ring_games (id, table_name, host_user_id, min_buyin, max_buyin, small_blind, big_blind, action_timer_seconds)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [gameState.id, gameState.tableName, userId, gameState.minBuyin, gameState.maxBuyin,
           gameState.tableSettings.sb, gameState.tableSettings.bb, gameState.tableSettings.timer]
        );
      } catch (dbErr) {
        console.error('[DB] Error persisting ring game:', dbErr.message);
      }

      socket.join(gameRoom(gameState.id));
      socketToPlayer.set(socket.id, { gameId: gameState.id, userId, seatIndex: 0 });

      notifyBankroll(userId, newBankroll);

      console.log(`[Create Ring Game] ${displayName} created table "${gameState.tableName}" with ${hostBuyin} buy-in`);

      callback(null, {
        gameId: gameState.id,
        tableName: gameState.tableName,
        userId,
        seatIndex: 0,
        buyinAmount: hostBuyin,
        minBuyin: gameState.minBuyin,
        maxBuyin: gameState.maxBuyin,
      });

      broadcastTableState(gameState.id);
    } catch (err) {
      console.error('[Create Ring Game Error]', err);
      callback({ error: 'Failed to create ring game' });
    }
  });

  // ---------- JOIN RING GAME ----------
  socket.on('join_ring_game', async ({ gameId, buyinAmount }, callback) => {
    try {
      const userId = socket.userId;
      const displayName = socket.displayName;

      const game = ringGames.get(gameId);
      if (!game) {
        return callback({ error: 'Table not found' });
      }

      // Check already seated
      const existingSeat = game.seats.findIndex(s => s && s.userId === userId);
      if (existingSeat !== -1) {
        // Already at this table - rejoin
        socket.join(gameRoom(gameId));
        socketToPlayer.set(socket.id, { gameId, userId, seatIndex: existingSeat });
        game.seats[existingSeat].isConnected = true;
        console.log(`[Rejoin] ${displayName} already at table seat ${existingSeat}`);
        callback(null, {
          gameId,
          tableName: game.tableName,
          userId,
          seatIndex: existingSeat,
          buyinAmount: game.seats[existingSeat].stack,
        });
        broadcastTableState(gameId);
        return;
      }

      // Validate buy-in
      const buyin = parseInt(buyinAmount);
      if (!buyin || buyin < game.minBuyin || buyin > game.maxBuyin) {
        return callback({ error: `Buy-in must be between ${game.minBuyin} and ${game.maxBuyin} chips` });
      }

      // Check if table is full
      const seatIndex = findNextAvailableSeat(game.seats);
      if (seatIndex === -1) {
        return callback({ error: 'Table is full (max 6 players)' });
      }

      // Deduct from bankroll
      let newBankroll;
      try {
        newBankroll = await deductBankroll(userId, buyin);
      } catch (e) {
        return callback({ error: 'Insufficient bankroll. You need ' + buyin + ' chips to buy in.' });
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

      console.log(`[Join Ring Game] ${displayName} joined "${game.tableName}" with ${buyin} chips at seat ${seatIndex}`);

      notifyBankroll(userId, newBankroll);

      callback(null, {
        gameId,
        tableName: game.tableName,
        minBuyin: game.minBuyin,
        maxBuyin: game.maxBuyin,
        userId,
        seatIndex,
        buyinAmount: buyin,
      });

      broadcastTableState(gameId);
      
      // Auto-start if enough players are ready (ring games: bought-in = ready)
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
        const nextPlayer = game.seats.find(s => s && !s.isBot);
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

  // ---------- ADD BOTS ----------
  socket.on('add_bots', ({ gameId }, callback) => {
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
        return callback && callback({ error: 'Only the host can add bots' });
      }

      if (game.gameState !== 'WAITING') {
        return callback && callback({ error: 'Can only add bots before the game starts' });
      }

      let botsAdded = 0;
      for (let i = 0; i < MAX_SEATS; i++) {
        if (game.seats[i] === null) {
          // Bots buy in for the average of min/max
          const botBuyin = Math.floor((game.minBuyin + game.maxBuyin) / 2);
          game.seats[i] = {
            userId: `bot_${uuidv4()}`,
            userName: getNextBotName(),
            stack: botBuyin,
            isReady: true,
            isConnected: true,
            isSittingOut: false,
            isBot: true,
          };
          botsAdded++;
        }
      }

      console.log(`[Bots] Added ${botsAdded} bots to game ${gameId}`);
      broadcastTableState(gameId);
      checkAutoStart(gameId);

      callback && callback(null, { botsAdded });
    } catch (err) {
      console.error('[Add Bots Error]', err);
      callback && callback({ error: 'Failed to add bots' });
    }
  });

  // ---------- REMOVE BOTS ----------
  socket.on('remove_bots', ({ gameId }, callback) => {
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
        return callback && callback({ error: 'Only the host can remove bots' });
      }

      if (game.gameState !== 'WAITING') {
        return callback && callback({ error: 'Can only remove bots before the game starts' });
      }

      let botsRemoved = 0;
      for (let i = 0; i < MAX_SEATS; i++) {
        if (game.seats[i] && game.seats[i].isBot) {
          game.seats[i] = null;
          botsRemoved++;
        }
      }

      resetBotNames();

      console.log(`[Bots] Removed ${botsRemoved} bots from game ${gameId}`);
      broadcastTableState(gameId);
      callback && callback(null, { botsRemoved });
    } catch (err) {
      console.error('[Remove Bots Error]', err);
      callback && callback({ error: 'Failed to remove bots' });
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
          console.log(`[Disconnect] ${seat.userName} disconnected from game ${gameId}`);

          if (game.currentHand && game.gameState !== 'WAITING') {
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
