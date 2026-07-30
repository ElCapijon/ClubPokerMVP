const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { generateInviteCode } = require('./InviteCode');
const { GAME_STATES, createHand, startHand, getPublicState, getPrivateState, getReconnectionSnapshot, isHandComplete, handleAction } = require('./GameHand');
const { getNextBotName, resetBotNames, decideAction } = require('./botPlayer');
const ChallengeTracker = require('./ChallengeTracker');
const pool = require('./db');

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

// Trust proxy headers (required for Render, Heroku, etc. for rate limiting and HTTPS redirect)
app.set('trust proxy', isProduction ? 1 : 0);

// HTTPS redirect in production (Render terminates SSL at the proxy)
if (isProduction) {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https' && req.headers['x-forwarded-proto'] !== undefined) {
      return res.redirect(301, `https://${req.headers.host}${req.url}`);
    }
    next();
  });
}

if (isProduction) {
  // In production, serve the built frontend
  app.use(express.static(path.join(__dirname, '../frontend/dist')));
} else {
  // In development, enable CORS for Vite dev server
  app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:5173' }));
}

app.use(express.json());

const server = http.createServer(app);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Migration trigger — run database migration
const { migrate } = require('./migrate');
app.get('/api/migrate', async (req, res) => {
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
// JWT Auth Middleware for REST endpoints
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
// Challenge Progress API
// ============================================================

// GET /api/challenges — get challenge definitions + user's progress
app.get('/api/challenges', authenticateToken, async (req, res) => {
  try {
    const progress = await ChallengeTracker.getUserProgress(req.user.userId);
    res.json({ challenges: progress });
  } catch (err) {
    console.error('[Challenges API] Error:', err.message);
    res.status(500).json({ error: 'Failed to get challenges' });
  }
});

// Production catch-all: serve index.html for all non-API routes
if (isProduction) {
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
  });
}

// Production startup banner
if (isProduction) {
  console.log('🏁 Production mode');
  console.log('   Serving frontend from dist/');
}

// ============================================================
// Auth Routes (register / login)
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
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (email, display_name, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, email, display_name, avatar_color, created_at`,
      [email, displayName.trim(), hashedPassword]
    );

    const user = result.rows[0];
    const token = jwt.sign(
      { userId: user.id, displayName: user.display_name, email: user.email },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      user: { id: user.id, email: user.email, displayName: user.display_name, avatarColor: user.avatar_color },
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
      'SELECT id, email, display_name, password_hash, avatar_color, total_wins, hands_played FROM users WHERE email = $1',
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
// Every connection must provide a valid JWT in the handshake
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
// Map<clubId, ClubState>
const clubs = new Map();

// Map<socketId, { clubId, userId }> for quick lookups
const socketToPlayer = new Map();

// Map<userId, socketId> for finding connected users (for challenges)
const userIdToSocket = new Map();

// Hand counters for dealer rotation across hands
const handCounters = new Map(); // Map<clubId, number>

// Disconnect timeouts for auto-fold when players disconnect mid-hand
// Map<clubId:userId, timeoutId>
const disconnectTimeouts = new Map();

// Action timers for auto-fold when a player takes too long
// Map<clubId, timeoutId>
const actionTimers = new Map();

// Track last action per club for display (clubId -> { seatIndex, action, amount, timestamp })
const lastActions = new Map();

// ============================================================
// Club State Factory
// ============================================================
function createClubState(hostUserId, hostDisplayName, inviteCode) {
  const seats = Array(MAX_SEATS).fill(null);
  seats[0] = {
    userId: hostUserId,
    userName: hostDisplayName,
    stack: 1500,
    isReady: false,
    isConnected: true,
    isSittingOut: false,
  };

  return {
    id: uuidv4(),
    inviteCode,
    seats,
    hostId: hostUserId,
    tableSettings: {
      sb: 10,
      bb: 20,
      startingStack: 1500,
      timer: 20,
      allowRebuys: true,
    },
    gameState: 'WAITING', // WAITING, PREFLOP, FLOP, TURN, RIVER, SHOWDOWN
    currentHand: null, // Will hold hand state when game starts
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
// Determine socket room name for a club
// ============================================================
function clubRoom(clubId) {
  return `club:${clubId}`;
}

// ============================================================
// Emit club state update to all players in the room
// ============================================================
function broadcastClubState(clubId) {
  const club = clubs.get(clubId);
  if (!club) return;

  // Build a clean player list (no sensitive info)
  const players = club.seats.map((seat, index) => {
    if (!seat) return null;
    return {
      seatIndex: index,
      userName: seat.userName,
      stack: seat.stack,
      isReady: seat.isReady,
      isConnected: seat.isConnected,
      isHost: seat.userId === club.hostId,
      isSittingOut: seat.isSittingOut || false,
      isBot: seat.isBot || false,
    };
  });

  io.to(clubRoom(clubId)).emit('club_state_update', {
    clubId: club.id,
    inviteCode: club.inviteCode,
    players,
    hostId: club.hostId,
    tableSettings: club.tableSettings,
    gameState: club.gameState,
  });
}

// ============================================================
// Emit full game state to the club room
// Sends public state to all, and private hole cards to each player
// ============================================================
function broadcastGameState(clubId) {
  const club = clubs.get(clubId);
  if (!club || !club.currentHand) return;

  const hand = club.currentHand;
  const publicState = getPublicState(hand);
  
  // Broadcast public state to everyone
  io.to(clubRoom(clubId)).emit('game_state_sync', publicState);

  // Send hole cards to each individual player
  for (const player of hand.players) {
    const privateState = getPrivateState(hand, player.seatIndex);
    // Find all sockets for this player
    for (const [socketId, info] of socketToPlayer) {
      if (info.clubId === clubId && info.seatIndex === player.seatIndex) {
        io.to(socketId).emit('your_hole_cards', privateState);
      }
    }
  }
}

// ============================================================
// Action Timer Management
// ============================================================

/** Clear the action timer for a club */
function clearActionTimer(clubId) {
  if (actionTimers.has(clubId)) {
    clearTimeout(actionTimers.get(clubId));
    actionTimers.delete(clubId);
  }
}

/** Process a bot player's turn immediately */
function processBotAction(clubId) {
  const club = clubs.get(clubId);
  if (!club || !club.currentHand) return;

  const hand = club.currentHand;
  if (hand.gameStatus === GAME_STATES.SHOWDOWN || hand.gameStatus === GAME_STATES.HAND_COMPLETE) return;

  const currentPlayer = hand.players[hand.currentPlayerIndex];
  if (!currentPlayer || currentPlayer.isAllIn || currentPlayer.isFolded) return;

  // Check if current player is a bot
  const seat = club.seats[currentPlayer.seatIndex];
  if (!seat || !seat.isBot) return;

  // Bot decides its action
  const decision = decideAction(hand, currentPlayer.seatIndex);
  if (!decision) return;

  console.log(`[Bot] ${seat.userName} decides to ${decision.action}${decision.amount ? ' $' + decision.amount : ''}`);

  const result = handleAction(hand, currentPlayer.seatIndex, decision.action, decision.amount);
  if (result.error) return;

  // Record the action
  recordAction(clubId, currentPlayer.seatIndex, decision.action, decision.amount);

  // Update club state
  club.gameState = hand.gameStatus;
  for (const hp of hand.players) {
    const s = club.seats[hp.seatIndex];
    if (s) s.stack = hp.stack;
  }

  broadcastGameState(clubId);
  clearActionTimer(clubId);

  // If hand is complete, schedule next hand
  if (isHandComplete(hand)) {
    // Challenge tracking (non-blocking, fire-and-forget)
    if (hand.winningUserId && !hand.winningUserId.startsWith('bot_')) {
      ChallengeTracker.trackHandRank(hand.winningUserId, hand.winningRank);
    }
    hand.players.forEach(p => {
      if (p.userId && !p.userId.startsWith('bot_')) {
        ChallengeTracker.trackVolume(p.userId);
      }
    });
    lastActions.delete(clubId);
    io.to(clubRoom(clubId)).emit('hand_complete', {
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
      const c = clubs.get(clubId);
      if (!c) return;
      const nextHandCount = (handCounters.get(clubId) || 0) + 1;
      const nextHand = createHand(c, nextHandCount);
      if (nextHand) {
        startHand(nextHand);
        c.currentHand = nextHand;
        c.gameState = nextHand.gameStatus;
        handCounters.set(clubId, nextHandCount);
        broadcastGameState(clubId);
        setActionTimer(clubId);
      }
    }, 12000);
  } else {
    // Schedule next bot action or set timer for human
    setActionTimer(clubId);
  }
}

/** Set a new action timer for the current player in the hand */
function setActionTimer(clubId) {
  clearActionTimer(clubId);

  const club = clubs.get(clubId);
  if (!club || !club.currentHand) return;

  const hand = club.currentHand;
  if (hand.gameStatus === GAME_STATES.SHOWDOWN || hand.gameStatus === GAME_STATES.HAND_COMPLETE) return;

  const currentPlayer = hand.players[hand.currentPlayerIndex];
  if (!currentPlayer || currentPlayer.isAllIn || currentPlayer.isFolded) return;

  // Check if current player is a bot — process immediately after a short delay
  const seat = club.seats[currentPlayer.seatIndex];
  if (seat && seat.isBot) {
    const botDelay = 800 + Math.random() * 1200; // 0.8-2s delay for visual effect
    const botTimeout = setTimeout(() => processBotAction(clubId), botDelay);
    actionTimers.set(clubId, botTimeout);
    return;
  }

  const timerMs = (hand.actionTimer || 20) * 1000;

  const timeout = setTimeout(() => {
    // Auto-fold the current player
    const clubNow = clubs.get(clubId);
    if (!clubNow || !clubNow.currentHand) return;

    const handNow = clubNow.currentHand;
    if (handNow.gameStatus === GAME_STATES.SHOWDOWN || handNow.gameStatus === GAME_STATES.HAND_COMPLETE) return;

    const playerIdx = handNow.currentPlayerIndex;
    if (playerIdx < 0 || playerIdx >= handNow.players.length) return;

    const player = handNow.players[playerIdx];
    if (player.isFolded || player.isAllIn) return;

    const seatIdx = player.seatIndex;
    console.log(`[Auto-Fold] ${player.userName} auto-folded (timeout)`);

    const result = handleAction(handNow, seatIdx, 'fold');
    if (result.error) return;

    // Record last action
    lastActions.set(clubId, {
      seatIndex: seatIdx,
      userName: player.userName,
      action: 'fold',
      amount: null,
      timestamp: Date.now(),
    });

    // Update club game state and stacks
    clubNow.gameState = handNow.gameStatus;
    for (const hp of handNow.players) {
      const seat = clubNow.seats[hp.seatIndex];
      if (seat) seat.stack = hp.stack;
    }

    broadcastGameState(clubId);

    // If hand is complete, broadcast results and schedule next hand
    if (isHandComplete(handNow)) {
      // Challenge tracking (non-blocking, fire-and-forget)
      if (handNow.winningUserId && !handNow.winningUserId.startsWith('bot_')) {
        ChallengeTracker.trackHandRank(handNow.winningUserId, handNow.winningRank);
      }
      handNow.players.forEach(p => {
        if (p.userId && !p.userId.startsWith('bot_')) {
          ChallengeTracker.trackVolume(p.userId);
        }
      });
      io.to(clubRoom(clubId)).emit('hand_complete', {
        handResult: handNow.handResult,
        communityCards: handNow.communityCards,
        players: handNow.players.map(p => ({
          seatIndex: p.seatIndex,
          userName: p.userName,
          holeCards: p.holeCards,
          stack: p.stack,
        })),
      });

      // Schedule next hand after 5 seconds
      setTimeout(() => {
        const c = clubs.get(clubId);
        if (!c) return;
        const nextHandCount = (handCounters.get(clubId) || 0) + 1;
        const nextHand = createHand(c, nextHandCount);
        if (nextHand) {
          startHand(nextHand);
          c.currentHand = nextHand;
          c.gameState = nextHand.gameStatus;
          handCounters.set(clubId, nextHandCount);
          broadcastGameState(clubId);
          setActionTimer(clubId);
        }
      }, 12000);
    } else {
      // Set timer for the next player
      setActionTimer(clubId);
    }
  }, timerMs);

  actionTimers.set(clubId, timeout);
}

/**
 * Check if all seated players are ready and auto-start if so.
 * Called after player_ready, add_bots, or when all seats fill.
 */
function checkAutoStart(clubId) {
  const club = clubs.get(clubId);
  if (!club || club.gameState !== 'WAITING') return;

  // Need at least 2 active players (connected, not sitting out)
  const seated = club.seats.filter(s => s && s.isConnected && !s.isSittingOut);
  if (seated.length < 2) return;

  // Check if ALL seated players are ready
  const allReady = seated.every(s => s.isReady === true);
  if (!allReady) return;

  console.log(`[Auto-Start] All ${seated.length} players ready in club ${clubId}. Starting game...`);

  // Start the game (same logic as start_game handler)
  let handCount = handCounters.get(clubId) || 0;
  const hand = createHand(club, handCount);
  if (!hand) return;

  startHand(hand);
  club.currentHand = hand;
  club.gameState = hand.gameStatus;
  handCounters.set(clubId, handCount + 1);

  console.log(`[Start Game] Club ${clubId} hand ${handCount} started (auto-start)`);

  broadcastGameState(clubId);
  setActionTimer(clubId);
}

/** Record and broadcast the last action */
function recordAction(clubId, seatIndex, action, amount) {
  const club = clubs.get(clubId);
  if (!club || !club.currentHand) return;

  const player = club.currentHand.players.find(p => p.seatIndex === seatIndex);
  if (!player) return;

  const actionRecord = {
    seatIndex,
    userName: player.userName,
    action,
    amount: amount || null,
    timestamp: Date.now(),
  };

  lastActions.set(clubId, actionRecord);

  // Broadcast last action to the room
  io.to(clubRoom(clubId)).emit('last_action', actionRecord);
}

// ============================================================
// Socket.io Event Handlers
// ============================================================
io.on('connection', (socket) => {      console.log(`[Connect] ${socket.id} (user: ${socket.displayName})`);

  // Track this user's socket for challenge notifications
  userIdToSocket.set(socket.userId, socket.id);

  // ---------- CREATE CLUB ----------
  socket.on('create_club', async (data, callback) => {
    try {
      // userId comes from the authenticated socket, not from the payload
      const userId = socket.userId;
      const displayName = socket.displayName;

      if (!displayName || displayName.trim().length === 0) {
        return callback({ error: 'Display name is required' });
      }
      if (displayName.length > 20) {
        return callback({ error: 'Display name must be 20 characters or less' });
      }

      const trimmedName = displayName.trim();

      // Generate a unique invite code
      let inviteCode;
      let isUnique = false;
      while (!isUnique) {
        inviteCode = generateInviteCode();
        // Check club codes in memory and DB
        const existingInMemory = Array.from(clubs.values()).find(c => c.inviteCode === inviteCode);
        if (!existingInMemory) {
          const dbResult = await pool.query('SELECT id FROM clubs WHERE invite_code = $1', [inviteCode]);
          if (dbResult.rows.length === 0) {
            isUnique = true;
          }
        }
      }

      // Create the club
      const clubState = createClubState(userId, trimmedName, inviteCode);
      clubs.set(clubState.id, clubState);

      // Persist to database
      try {
        await pool.query(
          `INSERT INTO clubs (id, invite_code, host_user_id, small_blind, big_blind, starting_stack, action_timer_seconds, allow_rebuys)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [clubState.id, inviteCode, userId, clubState.tableSettings.sb, clubState.tableSettings.bb,
           clubState.tableSettings.startingStack, clubState.tableSettings.timer, clubState.tableSettings.allowRebuys]
        );
      } catch (dbErr) {
        console.error('[DB] Error persisting club:', dbErr.message);
        // Non-fatal: in-memory state still works
      }

      // Join the socket room
      socket.join(clubRoom(clubState.id));
      socketToPlayer.set(socket.id, { clubId: clubState.id, userId, seatIndex: 0 });

      console.log(`[Create Club] ${trimmedName} created club ${clubState.id} (code: ${inviteCode})`);

      callback(null, {
        clubId: clubState.id,
        inviteCode: clubState.inviteCode,
        userId,
        seatIndex: 0,
      });

      broadcastClubState(clubState.id);
    } catch (err) {
      console.error('[Create Club Error]', err);
      callback({ error: 'Failed to create club' });
    }
  });

  // ---------- JOIN CLUB ----------
  socket.on('join_club', async ({ inviteCode }, callback) => {
    try {
      if (!inviteCode || inviteCode.trim().length === 0) {
        return callback({ error: 'Invite code is required' });
      }

      const code = inviteCode.trim().toUpperCase();
      const userId = socket.userId;
      const displayName = socket.displayName;

      // Find the club
      const club = Array.from(clubs.values()).find(c => c.inviteCode === code);
      if (!club) {
        return callback({ error: 'Club not found. Check your invite code.' });
      }

      // Check if player is already in this club
      const existingSeat = club.seats.findIndex(s => s && s.userId === userId);
      if (existingSeat !== -1) {
        // Player is already in this club — rejoin
        socket.join(clubRoom(club.id));
        socketToPlayer.set(socket.id, { clubId: club.id, userId, seatIndex: existingSeat });
        club.seats[existingSeat].isConnected = true;
        console.log(`[Rejoin] ${displayName} already in club at seat ${existingSeat}`);
        callback(null, {
          clubId: club.id,
          inviteCode: club.inviteCode,
          userId,
          seatIndex: existingSeat,
        });
        broadcastClubState(club.id);
        return;
      }

      // Check if club is full
      const seatIndex = findNextAvailableSeat(club.seats);
      if (seatIndex === -1) {
        return callback({ error: 'Club is full (max 6 players)' });
      }

      // Assign seat
      club.seats[seatIndex] = {
        userId,
        userName: displayName,
        stack: club.tableSettings.startingStack,
        isReady: false,
        isConnected: true,
        isSittingOut: false,
      };

      // Join socket room
      socket.join(clubRoom(club.id));
      socketToPlayer.set(socket.id, { clubId: club.id, userId, seatIndex });

      console.log(`[Join Club] ${displayName} joined club ${club.id} (code: ${code}) at seat ${seatIndex}`);

      callback(null, {
        clubId: club.id,
        inviteCode: club.inviteCode,
        userId,
        seatIndex,
      });

      broadcastClubState(club.id);
    } catch (err) {
      console.error('[Join Club Error]', err);
      callback({ error: 'Failed to join club' });
    }
  });



  // ---------- START GAME ----------
  socket.on('start_game', ({ clubId }, callback) => {
    try {
      const playerInfo = socketToPlayer.get(socket.id);
      if (!playerInfo || playerInfo.clubId !== clubId) {
        return callback && callback({ error: 'Not in this club' });
      }

      const club = clubs.get(clubId);
      if (!club) {
        return callback && callback({ error: 'Club not found' });
      }

      // Only host can start
      if (playerInfo.userId !== club.hostId) {
        return callback && callback({ error: 'Only the host can start the game' });
      }

      // Can't start if game is already in progress
      if (club.gameState !== 'WAITING') {
        return callback && callback({ error: 'Game already in progress' });
      }

      // Need at least 2 players
      const activePlayers = club.seats.filter(s => s && s.isConnected);
      if (activePlayers.length < 2) {
        return callback && callback({ error: 'Need at least 2 connected players' });
      }

      // Get or initialize hand counter
      let handCount = handCounters.get(clubId) || 0;

      // Create and start the hand
      const hand = createHand(club, handCount);
      if (!hand) {
        return callback && callback({ error: 'Not enough active players' });
      }

      startHand(hand);
      club.currentHand = hand;
      club.gameState = hand.gameStatus;

      handCounters.set(clubId, handCount + 1);

      console.log(`[Start Game] Club ${clubId} hand ${handCount} started`);

      // Broadcast game state
      broadcastGameState(clubId);

      // Start the action timer
      setActionTimer(clubId);

      callback && callback(null, { success: true });
    } catch (err) {
      console.error('[Start Game Error]', err);
      callback && callback({ error: 'Failed to start game' });
    }
  });

  // ---------- PLAYER ACTION ----------
  socket.on('player_action', ({ clubId, action, amount }, callback) => {
    try {
      const playerInfo = socketToPlayer.get(socket.id);
      if (!playerInfo || playerInfo.clubId !== clubId) {
        return callback && callback({ error: 'Not in this club' });
      }

      const club = clubs.get(clubId);
      if (!club || !club.currentHand) {
        return callback && callback({ error: 'No game in progress' });
      }

      const result = handleAction(club.currentHand, playerInfo.seatIndex, action, amount);

      if (result.error) {
        return callback && callback({ error: result.error });
      }

      // Record the last action for display
      recordAction(clubId, playerInfo.seatIndex, action, amount);

      // Update club game state
      club.gameState = club.currentHand.gameStatus;

      // Update seat stacks from hand state
      for (const hp of club.currentHand.players) {
        const seat = club.seats[hp.seatIndex];
        if (seat) {
          seat.stack = hp.stack;
        }
      }

      // Broadcast updated state
      broadcastGameState(clubId);

      // Clear the action timer for the old turn
      clearActionTimer(clubId);

      // If hand is complete, broadcast results and schedule next hand
      if (isHandComplete(club.currentHand)) {
        const hand = club.currentHand;

        // Challenge tracking (non-blocking, fire-and-forget)
        if (hand.winningUserId && !hand.winningUserId.startsWith('bot_')) {
          ChallengeTracker.trackHandRank(hand.winningUserId, hand.winningRank);
        }
        hand.players.forEach(p => {
          if (p.userId && !p.userId.startsWith('bot_')) {
            ChallengeTracker.trackVolume(p.userId);
          }
        });

        // Blind Stealer: pre-flop raise that makes everyone fold
        if (hand.gameStatus === 'PREFLOP' && hand.winningRank === 0 && hand.winningUserId) {
          // The last raiser is the one who stole the blinds
          const raiserSeatIndex = hand.lastRaiserIndex >= 0 ? hand.players[hand.lastRaiserIndex]?.seatIndex : -1;
          if (raiserSeatIndex >= 0) {
            const raiser = hand.players.find(p => p.seatIndex === raiserSeatIndex);
            if (raiser && raiser.userId && !raiser.userId.startsWith('bot_')) {
              ChallengeTracker.trackWagering(raiser.userId);
            }
          }
        }

        lastActions.delete(clubId);

        io.to(clubRoom(clubId)).emit('hand_complete', {
          handResult: hand.handResult,
          communityCards: hand.communityCards,
          players: hand.players.map(p => ({
            seatIndex: p.seatIndex,
            userName: p.userName,
            holeCards: p.holeCards,
            stack: p.stack,
          })),
        });

        // Persist hand history to database (non-blocking)
        try {
          pool.query(
            `INSERT INTO hand_histories (club_id, final_board, players_in_hand, pot_splits)
             VALUES ($1, $2, $3, $4)`,
            [
              clubId,
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

        // Schedule next hand after 12 seconds (time for players to see showdown)
        setTimeout(() => {
          const nextHandCount = (handCounters.get(clubId) || 0) + 1;
          const nextHand = createHand(club, nextHandCount);
          if (nextHand) {
            startHand(nextHand);
            club.currentHand = nextHand;
            club.gameState = nextHand.gameStatus;
            handCounters.set(clubId, nextHandCount);
            broadcastGameState(clubId);
            // Start timer for the new hand's first turn
            setActionTimer(clubId);
          }
        }, 12000);
      } else {
        // Set timer for the next player's turn
        setActionTimer(clubId);
      }

      callback && callback(null, { success: true });
    } catch (err) {
      console.error('[Player Action Error]', err);
      callback && callback({ error: 'Failed to process action' });
    }
  });

  // ---------- TOGGLE READY ----------
  socket.on('player_ready', ({ clubId }) => {
    const playerInfo = socketToPlayer.get(socket.id);
    if (!playerInfo || playerInfo.clubId !== clubId) return;

    const club = clubs.get(clubId);
    if (!club) return;

    const seat = club.seats[playerInfo.seatIndex];
    if (!seat) return;

    seat.isReady = !seat.isReady;
    console.log(`[Ready] ${seat.userName} is ${seat.isReady ? 'ready' : 'not ready'}`);

    broadcastClubState(clubId);
    
    // Check if all players are now ready — auto-start!
    checkAutoStart(clubId);
  });

  // ---------- RECONNECT / REJOIN ----------
  socket.on('rejoin_club', ({ clubId }, callback) => {
    const club = clubs.get(clubId);
    if (!club) return callback({ error: 'Club not found' });

    const userId = socket.userId;

    // Find the player's seat
    const seatIndex = club.seats.findIndex(s => s && s.userId === userId);
    if (seatIndex === -1) return callback({ error: 'Player not found in club' });

    const seat = club.seats[seatIndex];
    seat.isConnected = true;

    // Clear any auto-fold timeout for this player (they reconnected!)
    const timeoutKey = `${clubId}:${userId}`;
    if (disconnectTimeouts.has(timeoutKey)) {
      clearTimeout(disconnectTimeouts.get(timeoutKey));
      disconnectTimeouts.delete(timeoutKey);
      console.log(`[Reconnect] ${seat.userName} reconnected, auto-fold timeout cleared`);
    }

    socket.join(clubRoom(clubId));
    socketToPlayer.set(socket.id, { clubId, userId, seatIndex });

    // Send club state
    callback(null, {
      clubId: club.id,
      inviteCode: club.inviteCode,
      userId,
      seatIndex,
    });

    broadcastClubState(clubId);

    // If a game is in progress, send full state snapshot to this socket
    if (club.currentHand) {
      const snapshot = getReconnectionSnapshot(club.currentHand, seatIndex);
      socket.emit('full_state_snapshot', snapshot);
    }
  });

  // ---------- SEND EMOJI ----------
  socket.on('send_emoji', ({ clubId, emoji }) => {
    const playerInfo = socketToPlayer.get(socket.id);
    if (!playerInfo || playerInfo.clubId !== clubId) return;

    const club = clubs.get(clubId);
    if (!club) return;

    const seat = club.seats[playerInfo.seatIndex];
    if (!seat) return;

    // Broadcast emoji to all players in the club room
    io.to(clubRoom(clubId)).emit('emoji_received', {
      seatIndex: playerInfo.seatIndex,
      userName: seat.userName,
      emoji,
      timestamp: Date.now(),
    });
  });

  // ---------- REBUY ----------
  socket.on('player_rebuy', ({ clubId }, callback) => {
    try {
      const playerInfo = socketToPlayer.get(socket.id);
      if (!playerInfo || playerInfo.clubId !== clubId) {
        return callback && callback({ error: 'Not in this club' });
      }

      const club = clubs.get(clubId);
      if (!club) {
        return callback && callback({ error: 'Club not found' });
      }

      const seat = club.seats[playerInfo.seatIndex];
      if (!seat) {
        return callback && callback({ error: 'Not seated' });
      }

      if (!club.tableSettings.allowRebuys) {
        return callback && callback({ error: 'Rebuys not allowed' });
      }

      // Reset stack to starting stack
      seat.stack = club.tableSettings.startingStack;
      seat.isReady = false;
      seat.isConnected = true;

      console.log(`[Rebuy] ${seat.userName} rebought for ${club.tableSettings.startingStack}`);

      broadcastClubState(clubId);
      callback && callback(null, { success: true });
    } catch (err) {
      console.error('[Rebuy Error]', err);
      callback && callback({ error: 'Failed to process rebuy' });
    }
  });

  // ---------- ADD BOTS ----------
  socket.on('add_bots', ({ clubId }, callback) => {
    try {
      const playerInfo = socketToPlayer.get(socket.id);
      if (!playerInfo || playerInfo.clubId !== clubId) {
        return callback && callback({ error: 'Not in this club' });
      }

      const club = clubs.get(clubId);
      if (!club) {
        return callback && callback({ error: 'Club not found' });
      }

      // Only host can add bots
      if (playerInfo.userId !== club.hostId) {
        return callback && callback({ error: 'Only the host can add bots' });
      }

      // Can only add bots when game is waiting
      if (club.gameState !== 'WAITING') {
        return callback && callback({ error: 'Can only add bots before the game starts' });
      }

      // Fill empty seats with bots
      let botsAdded = 0;
      for (let i = 0; i < MAX_SEATS; i++) {
        if (club.seats[i] === null) {
          club.seats[i] = {
            userId: `bot_${uuidv4()}`,
            userName: getNextBotName(),
            stack: club.tableSettings.startingStack,
            isReady: true,
            isConnected: true,
            isSittingOut: false,
            isBot: true,
          };
          botsAdded++;
        }
      }

      console.log(`[Bots] Added ${botsAdded} bots to club ${clubId}`);
      broadcastClubState(clubId);
      
      // Bots are auto-ready — check if game should start
      checkAutoStart(clubId);
      
      callback && callback(null, { botsAdded });
    } catch (err) {
      console.error('[Add Bots Error]', err);
      callback && callback({ error: 'Failed to add bots' });
    }
  });

  // ---------- REMOVE BOTS ----------
  socket.on('remove_bots', ({ clubId }, callback) => {
    try {
      const playerInfo = socketToPlayer.get(socket.id);
      if (!playerInfo || playerInfo.clubId !== clubId) {
        return callback && callback({ error: 'Not in this club' });
      }

      const club = clubs.get(clubId);
      if (!club) {
        return callback && callback({ error: 'Club not found' });
      }

      // Only host can remove bots
      if (playerInfo.userId !== club.hostId) {
        return callback && callback({ error: 'Only the host can remove bots' });
      }

      // Can only remove bots when game is waiting
      if (club.gameState !== 'WAITING') {
        return callback && callback({ error: 'Can only remove bots before the game starts' });
      }

      // Remove all bot seats
      let botsRemoved = 0;
      for (let i = 0; i < MAX_SEATS; i++) {
        if (club.seats[i] && club.seats[i].isBot) {
          club.seats[i] = null;
          botsRemoved++;
        }
      }

      resetBotNames();

      console.log(`[Bots] Removed ${botsRemoved} bots from club ${clubId}`);
      broadcastClubState(clubId);
      callback && callback(null, { botsRemoved });
    } catch (err) {
      console.error('[Remove Bots Error]', err);
      callback && callback({ error: 'Failed to remove bots' });
    }
  });

  // ---------- SIT OUT ----------
  socket.on('player_sit_out', ({ clubId }, callback) => {
    try {
      const playerInfo = socketToPlayer.get(socket.id);
      if (!playerInfo || playerInfo.clubId !== clubId) {
        return callback && callback({ error: 'Not in this club' });
      }

      const club = clubs.get(clubId);
      if (!club) {
        return callback && callback({ error: 'Club not found' });
      }

      const seat = club.seats[playerInfo.seatIndex];
      if (!seat) {
        return callback && callback({ error: 'Not seated' });
      }

      // Toggle sitting out
      seat.isSittingOut = !seat.isSittingOut;
      seat.isReady = false;

      console.log(`[Sit Out] ${seat.userName} ${seat.isSittingOut ? 'sitting out' : 'back in'}`);

      broadcastClubState(clubId);
      callback && callback(null, { success: true });
    } catch (err) {
      console.error('[Sit Out Error]', err);
      callback && callback({ error: 'Failed to process sit out' });
    }
  });

  // ============================================================
  // CHALLENGE SYSTEM
  // ============================================================

  // ---------- FIND USERS ----------
  socket.on('find_users', async ({ query }, callback) => {
    try {
      if (!query || query.trim().length < 2) {
        return callback({ error: 'Search query must be at least 2 characters' });
      }

      const search = `%${query.trim()}%`;
      const result = await pool.query(
        `SELECT id, display_name, avatar_color, total_wins, hands_played
         FROM users
         WHERE (email ILIKE $1 OR display_name ILIKE $1)
          AND id != $2
         LIMIT 10`,
        [search, socket.userId]
      );

      const users = result.rows.map(u => ({
        id: u.id,
        displayName: u.display_name,
        avatarColor: u.avatar_color,
        totalWins: u.total_wins,
        handsPlayed: u.hands_played,
      }));

      callback(null, { users });
    } catch (err) {
      console.error('[Find Users Error]', err);
      callback({ error: 'Failed to search users' });
    }
  });

  // ---------- GET MY CHALLENGES ----------
  socket.on('get_my_challenges', async (data, callback) => {
    try {
      const myId = socket.userId;

      const result = await pool.query(
        `SELECT c.id, c.status, c.buy_in, c.blind_level, c.max_hands, c.created_at,
                chal.id AS challenger_id, chal.display_name AS challenger_name, chal.avatar_color AS challenger_color,
                chale.id AS challengee_id, chale.display_name AS challengee_name, chale.avatar_color AS challengee_color
         FROM challenges c
         JOIN users chal ON c.challenger_id = chal.id
         JOIN users chale ON c.challengee_id = chale.id
         WHERE (c.challenger_id = $1 OR c.challengee_id = $1)
          AND c.status = 'pending'
         ORDER BY c.created_at DESC
         LIMIT 20`,
        [myId]
      );

      const challenges = result.rows.map(row => ({
        id: row.id,
        status: row.status,
        buyIn: row.buy_in,
        blindLevel: row.blind_level,
        maxHands: row.max_hands,
        createdAt: row.created_at,
        isIncoming: row.challengee_id === myId,
        opponent: {
          id: row.challenger_id === myId ? row.challengee_id : row.challenger_id,
          displayName: row.challenger_id === myId ? row.challengee_name : row.challenger_name,
          avatarColor: row.challenger_id === myId ? row.challengee_color : row.challenger_color,
        },
      }));

      callback(null, { challenges });
    } catch (err) {
      console.error('[Get Challenges Error]', err);
      callback({ error: 'Failed to get challenges' });
    }
  });

  // ---------- SEND CHALLENGE ----------
  socket.on('send_challenge', async ({ opponentId, buyIn, blindLevel, maxHands }, callback) => {
    try {
      if (!opponentId) {
        return callback({ error: 'Opponent is required' });
      }

      // Check for existing pending challenge between these two
      const existing = await pool.query(
        `SELECT id FROM challenges
         WHERE ((challenger_id = $1 AND challengee_id = $2) OR (challenger_id = $2 AND challengee_id = $1))
          AND status = 'pending'`,
        [socket.userId, opponentId]
      );

      if (existing.rows.length > 0) {
        return callback({ error: 'You already have a pending challenge with this player' });
      }

      const result = await pool.query(
        `INSERT INTO challenges (challenger_id, challengee_id, buy_in, blind_level, max_hands)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, status, buy_in, blind_level, max_hands, created_at`,
        [socket.userId, opponentId, buyIn || 0, blindLevel || 20, maxHands || 0]
      );

      const challenge = result.rows[0];

      // Get challenger info
      const challengerResult = await pool.query(
        'SELECT id, display_name, avatar_color FROM users WHERE id = $1',
        [socket.userId]
      );
      const challenger = challengerResult.rows[0];

      // Notify the opponent in real-time if connected
      const opponentSocketId = userIdToSocket.get(opponentId);
      if (opponentSocketId) {
        io.to(opponentSocketId).emit('new_challenge', {
          id: challenge.id,
          status: challenge.status,
          buyIn: challenge.buy_in,
          blindLevel: challenge.blind_level,
          maxHands: challenge.max_hands,
          createdAt: challenge.created_at,
          isIncoming: true,
          opponent: {
            id: challenger.id,
            displayName: challenger.display_name,
            avatarColor: challenger.avatar_color,
          },
        });
      }

      callback(null, {
        id: challenge.id,
        status: challenge.status,
        buyIn: challenge.buy_in,
        blindLevel: challenge.blind_level,
        maxHands: challenge.max_hands,
        createdAt: challenge.created_at,
      });
    } catch (err) {
      console.error('[Send Challenge Error]', err);
      callback({ error: 'Failed to send challenge' });
    }
  });

  // ---------- ACCEPT CHALLENGE ----------
  socket.on('accept_challenge', async ({ challengeId }, callback) => {
    try {
      if (!challengeId) {
        return callback({ error: 'Challenge ID is required' });
      }

      const result = await pool.query(
        `SELECT c.*, u.display_name AS challenger_name
         FROM challenges c
         JOIN users u ON c.challenger_id = u.id
         WHERE c.id = $1 AND c.status = 'pending'`,
        [challengeId]
      );

      if (result.rows.length === 0) {
        return callback({ error: 'Challenge not found or already resolved' });
      }

      const challenge = result.rows[0];

      // Only the challengee can accept
      if (challenge.challengee_id !== socket.userId) {
        return callback({ error: 'Only the challenged player can accept' });
      }

      // Update challenge status
      await pool.query(
        'UPDATE challenges SET status = $1 WHERE id = $2',
        ['accepted', challengeId]
      );

      // Create a club room for the two players
      const inviteCode = generateInviteCode();
      const clubId = uuidv4();

      // Create club seats: challenger at seat 0, challengee at seat 1
      const clubState = createClubState(challenge.challenger_id, challenge.challenger_name, inviteCode);
      clubState.id = clubId;

      // Add the challengee to seat 1
      const challengeeResult = await pool.query(
        'SELECT display_name FROM users WHERE id = $1',
        [challenge.challengee_id]
      );
      const challengeeName = challengeeResult.rows[0]?.display_name || 'Player';

      clubState.seats[1] = {
        userId: challenge.challengee_id,
        userName: challengeeName,
        stack: clubState.tableSettings.startingStack,
        isReady: true,
        isConnected: true,
        isSittingOut: false,
      };

      clubs.set(clubId, clubState);

      // Persist club to DB
      try {
        await pool.query(
          `INSERT INTO clubs (id, invite_code, host_user_id, small_blind, big_blind, starting_stack, action_timer_seconds, allow_rebuys)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [clubId, inviteCode, challenge.challenger_id,
           clubState.tableSettings.sb, clubState.tableSettings.bb,
           clubState.tableSettings.startingStack, clubState.tableSettings.timer, clubState.tableSettings.allowRebuys]
        );
      } catch (dbErr) {
        console.error('[DB] Error persisting challenge club:', dbErr.message);
      }

      // Link challenge to club
      await pool.query(
        'UPDATE challenges SET club_id = $1 WHERE id = $2',
        [clubId, challengeId]
      );

      // Join the challenger's socket to the room
      const challengerSocketId = userIdToSocket.get(challenge.challenger_id);
      if (challengerSocketId) {
        const challengerSocket = io.sockets.sockets.get(challengerSocketId);
        if (challengerSocket) {
          challengerSocket.join(clubRoom(clubId));
          socketToPlayer.set(challengerSocketId, { clubId, userId: challenge.challenger_id, seatIndex: 0 });
          // Notify challenger
          io.to(challengerSocketId).emit('challenge_accepted', {
            clubId,
            inviteCode,
            userId: challenge.challenger_id,
            seatIndex: 0,
          });
        }
      }

      // Join the challengee's socket to the room
      socket.join(clubRoom(clubId));
      socketToPlayer.set(socket.id, { clubId, userId: challenge.challengee_id, seatIndex: 1 });

      // Start the game immediately (both are ready)
      let handCount = handCounters.get(clubId) || 0;
      const hand = createHand(clubState, handCount);
      if (hand) {
        startHand(hand);
        clubState.currentHand = hand;
        clubState.gameState = hand.gameStatus;
        handCounters.set(clubId, handCount + 1);
        broadcastGameState(clubId);
        setActionTimer(clubId);
      }

      // Return club data to the challengee
      callback(null, {
        clubId,
        inviteCode,
        userId: challenge.challengee_id,
        seatIndex: 1,
        autoStarted: true,
      });

      console.log(`[Challenge] Accepted! Club ${clubId} created for ${challenge.challenger_name} vs ${challengeeName}`);
    } catch (err) {
      console.error('[Accept Challenge Error]', err);
      callback({ error: 'Failed to accept challenge' });
    }
  });

  // ---------- REJECT CHALLENGE ----------
  socket.on('reject_challenge', async ({ challengeId }, callback) => {
    try {
      if (!challengeId) {
        return callback({ error: 'Challenge ID is required' });
      }

      const result = await pool.query(
        `SELECT c.* FROM challenges c WHERE c.id = $1 AND c.status = 'pending' AND c.challengee_id = $2`,
        [challengeId, socket.userId]
      );

      if (result.rows.length === 0) {
        return callback({ error: 'Challenge not found or already resolved' });
      }

      await pool.query(
        'UPDATE challenges SET status = $1 WHERE id = $2',
        ['rejected', challengeId]
      );

      // Notify the challenger
      const challengerSocketId = userIdToSocket.get(result.rows[0].challenger_id);
      if (challengerSocketId) {
        io.to(challengerSocketId).emit('challenge_rejected', { challengeId });
      }

      callback(null, { success: true });
    } catch (err) {
      console.error('[Reject Challenge Error]', err);
      callback({ error: 'Failed to reject challenge' });
    }
  });

  // ---------- CANCEL CHALLENGE ----------
  socket.on('cancel_challenge', async ({ challengeId }, callback) => {
    try {
      if (!challengeId) {
        return callback({ error: 'Challenge ID is required' });
      }

      const result = await pool.query(
        `SELECT c.* FROM challenges c WHERE c.id = $1 AND c.status = 'pending' AND c.challenger_id = $2`,
        [challengeId, socket.userId]
      );

      if (result.rows.length === 0) {
        return callback({ error: 'Challenge not found or already resolved' });
      }

      await pool.query(
        'UPDATE challenges SET status = $1 WHERE id = $2',
        ['cancelled', challengeId]
      );

      callback(null, { success: true });
    } catch (err) {
      console.error('[Cancel Challenge Error]', err);
      callback({ error: 'Failed to cancel challenge' });
    }
  });

  // ---------- DISCONNECT ----------
  socket.on('disconnect', () => {
    // Clean up user tracking
    userIdToSocket.delete(socket.userId);

    const playerInfo = socketToPlayer.get(socket.id);
    if (playerInfo) {
      const { clubId, userId, seatIndex } = playerInfo;
      const club = clubs.get(clubId);

      if (club) {
        const seat = club.seats[seatIndex];
        if (seat && seat.userId === userId) {
          seat.isConnected = false;
          console.log(`[Disconnect] ${seat.userName} disconnected from club ${clubId}`);

          // If a game is in progress, set a timeout to auto-fold after 60 seconds
          if (club.currentHand && club.gameState !== 'WAITING') {
            const timeoutKey = `${clubId}:${userId}`;
            
            // Clear any existing timeout for this player
            if (disconnectTimeouts.has(timeoutKey)) {
              clearTimeout(disconnectTimeouts.get(timeoutKey));
            }

            const disconnectTimeout = setTimeout(() => {
              const hand = club.currentHand;
              if (hand && hand.gameStatus !== 'WAITING' && hand.gameStatus !== GAME_STATES.SHOWDOWN && hand.gameStatus !== GAME_STATES.HAND_COMPLETE) {
                const playerInHand = hand.players.find(p => p.seatIndex === seatIndex);
                if (playerInHand && !playerInHand.isFolded && !playerInHand.isAllIn) {
                  clearActionTimer(clubId);
                  const result = handleAction(hand, seatIndex, 'fold');
                  if (!result.error) {
                    console.log(`[Auto-Fold] ${seat.userName} folded due to disconnect timeout`);
                    if (seat) seat.isSittingOut = true;
                    club.gameState = hand.gameStatus;
                    for (const hp of hand.players) {
                      const s = club.seats[hp.seatIndex];
                      if (s) s.stack = hp.stack;
                    }
                    broadcastGameState(clubId);
                    if (!isHandComplete(hand)) {
                      setActionTimer(clubId);
                    }
                  }
                }
              }
              disconnectTimeouts.delete(timeoutKey);
            }, 60000);
            
            disconnectTimeouts.set(timeoutKey, disconnectTimeout);
          }

          broadcastClubState(clubId);
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

// Graceful shutdown: flush pending progress
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
