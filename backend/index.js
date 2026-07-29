const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { generateInviteCode } = require('./InviteCode');
const { GAME_STATES, createHand, startHand, getPublicState, getPrivateState, getReconnectionSnapshot, isHandComplete, handleAction } = require('./GameHand');
const pool = require('./db');

// ============================================================
// Configuration
// ============================================================
const PORT = process.env.PORT || 3000;
const MAX_SEATS = 6;
const isProduction = process.env.NODE_ENV === 'production';

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
// Socket.io Setup
// ============================================================
const io = new Server(server, {
  cors: {
    origin: isProduction ? false : (process.env.CORS_ORIGIN || 'http://localhost:5173'),
    methods: ['GET', 'POST'],
  },
});

// ============================================================
// In-Memory State
// ============================================================
// Map<clubId, ClubState>
const clubs = new Map();

// Map<socketId, { clubId, userId }> for quick lookups
const socketToPlayer = new Map();

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

/** Set a new action timer for the current player in the hand */
function setActionTimer(clubId) {
  clearActionTimer(clubId);

  const club = clubs.get(clubId);
  if (!club || !club.currentHand) return;

  const hand = club.currentHand;
  if (hand.gameStatus === GAME_STATES.SHOWDOWN || hand.gameStatus === GAME_STATES.HAND_COMPLETE) return;

  const currentPlayer = hand.players[hand.currentPlayerIndex];
  if (!currentPlayer || currentPlayer.isAllIn || currentPlayer.isFolded) return;

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
      }, 5000);
    } else {
      // Set timer for the next player
      setActionTimer(clubId);
    }
  }, timerMs);

  actionTimers.set(clubId, timeout);
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
io.on('connection', (socket) => {
  console.log(`[Connect] ${socket.id}`);

  // ---------- CREATE CLUB ----------
  socket.on('create_club', async ({ displayName }, callback) => {
    try {
      if (!displayName || displayName.trim().length === 0) {
        return callback({ error: 'Display name is required' });
      }
      if (displayName.length > 20) {
        return callback({ error: 'Display name must be 20 characters or less' });
      }

      const trimmedName = displayName.trim();
      const userId = uuidv4();

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
        await pool.query(
          'INSERT INTO users (id, display_name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
          [userId, trimmedName]
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
  socket.on('join_club', async ({ displayName, inviteCode }, callback) => {
    try {
      if (!displayName || displayName.trim().length === 0) {
        return callback({ error: 'Display name is required' });
      }
      if (!inviteCode || inviteCode.trim().length === 0) {
        return callback({ error: 'Invite code is required' });
      }

      const trimmedName = displayName.trim();
      const code = inviteCode.trim().toUpperCase();

      // Find the club
      const club = Array.from(clubs.values()).find(c => c.inviteCode === code);
      if (!club) {
        return callback({ error: 'Club not found. Check your invite code.' });
      }

      // Check if club is full
      const seatIndex = findNextAvailableSeat(club.seats);
      if (seatIndex === -1) {
        return callback({ error: 'Club is full (max 6 players)' });
      }

      const userId = uuidv4();

      // Assign seat
      club.seats[seatIndex] = {
        userId,
        userName: trimmedName,
        stack: club.tableSettings.startingStack,
        isReady: false,
        isConnected: true,
        isSittingOut: false,
      };

      // Join socket room
      socket.join(clubRoom(club.id));
      socketToPlayer.set(socket.id, { clubId: club.id, userId, seatIndex });

      console.log(`[Join Club] ${trimmedName} joined club ${club.id} (code: ${code}) at seat ${seatIndex}`);

      // Persist user to DB
      try {
        await pool.query(
          'INSERT INTO users (id, display_name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
          [userId, trimmedName]
        );
      } catch (dbErr) {
        console.error('[DB] Error persisting user:', dbErr.message);
      }

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

        // Schedule next hand after 5 seconds
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
        }, 5000);
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
  });

  // ---------- RECONNECT / REJOIN ----------
  socket.on('rejoin_club', ({ clubId, userId }, callback) => {
    const club = clubs.get(clubId);
    if (!club) return callback({ error: 'Club not found' });

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

  // ---------- DISCONNECT ----------
  socket.on('disconnect', () => {
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
                  // Use handleAction to properly process the fold and advance the game
                  clearActionTimer(clubId);
                  const result = handleAction(hand, seatIndex, 'fold');
                  if (!result.error) {
                    console.log(`[Auto-Fold] ${seat.userName} folded due to disconnect timeout`);
                    // Mark as sitting out after disconnect timeout
                    if (seat) seat.isSittingOut = true;
                    // Update club game state and stacks
                    club.gameState = hand.gameStatus;
                    for (const hp of hand.players) {
                      const s = club.seats[hp.seatIndex];
                      if (s) s.stack = hp.stack;
                    }
                    broadcastGameState(clubId);
                    // If hand isn't complete, set timer for next player
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
// Start Server
// ============================================================
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🃏 Poker Club Server running on port ${PORT}`);
  console.log(`   CORS Origin: ${process.env.CORS_ORIGIN || 'http://localhost:5173'}`);
  console.log(`   WebSocket ready for connections`);
});
