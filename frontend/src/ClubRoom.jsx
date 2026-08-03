import React, { useEffect, useState, useCallback, useRef } from 'react';
import { getSocket } from './socket';
import { getToken } from './auth';

const API_BASE = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? '' : 'http://localhost:3000');

const MAX_SEATS = 6;

// Seat positions for the racetrack (stadium) table layout, clockwise from
// bottom-center. The table is a stadium shape: straight sides with
// semicircular ends. Each seat hugs the rail.
const SEAT_POSITIONS = [
  { top: 91, left: 50 },  // Seat 0: Hero — bottom center, on the straight edge
  { top: 68, left: 10 },  // Seat 1: Lower-left, on the left end cap
  { top: 32, left: 10 },  // Seat 2: Upper-left, on the left end cap
  { top: 8,  left: 50 },  // Seat 3: Top center, on the straight edge
  { top: 32, left: 90 },  // Seat 4: Upper-right, on the right end cap
  { top: 68, left: 90 },  // Seat 5: Lower-right, on the right end cap
];

// Bet chips are rendered on the felt directly in front of each seat, pushed
// toward the table center (50,50) so they read like a real bet on the table.
// Center seats (0 & 3) are pushed further so the chip clears the tall seat
// column (dealer button + avatar + name); side seats only need a small nudge.
const BET_CHIP_FRACTIONS = [0.30, 0.20, 0.20, 0.30, 0.20, 0.20];
const BET_CHIP_POSITIONS = SEAT_POSITIONS.map((pos, i) => ({
  top: pos.top + (50 - pos.top) * BET_CHIP_FRACTIONS[i],
  left: pos.left + (50 - pos.left) * BET_CHIP_FRACTIONS[i],
}));

// Where flying bet chips land — the pot area at the center of the felt
const POT_POSITION = { top: 50, left: 50 };

// Format a chip amount for display (e.g. $1.2K, $2.5M).
function formatBetLabel(amt) {
  if (!amt) return '';
  // Round to 1 decimal first, then promote K→M if rounding pushed
  // the value up to 1000 (e.g. 999,999 must read $1M, not $1000.0K).
  const fmt = (val, suffix) => '$' + (val % 1 === 0 ? val.toFixed(0) : val.toFixed(1)) + suffix;
  if (amt >= 1000000) return fmt(amt / 1000000, 'M');
  if (amt >= 1000) {
    const k = Math.round((amt / 1000) * 10) / 10;
    return k >= 1000 ? fmt(k / 1000, 'M') : fmt(k, 'K');
  }
  return '$' + amt.toLocaleString();
}

// ─── Card Sizes ──────────────────────────────────────────────
// We use fixed pixel values for precision. The component accepts a `size` prop.
//   'xl'  → your hole cards     (64×90)
//   'lg'  → community cards     (50×72)
//   'md'  → showdown reveal     (40×56)
//   'sm'  → card backs (others) (32×46)
const CARD_DIMENSIONS = {
  xl:  { w: 64, h: 90,  rank: 'text-lg',   suit: 'text-xl',  corner: 'text-[11px]' },
  lg:  { w: 50, h: 72,  rank: 'text-base',  suit: 'text-lg',  corner: 'text-[10px]' },
  md:  { w: 40, h: 56,  rank: 'text-sm',    suit: 'text-base',corner: 'text-[9px]'  },
  sm:  { w: 32, h: 46,  rank: 'text-xs',    suit: 'text-sm',  corner: 'text-[8px]'  },
};

const SUIT_COLORS = {
  hearts:    'text-red-600',
  diamonds:  'text-red-600',
  clubs:     'text-gray-900',
  spades:    'text-gray-900',
};

// ─── Card Component ──────────────────────────────────────────
function Card({ card, faceDown, size, dealDelay }) {
  const [dealt, setDealt] = useState(false);
  const dim = CARD_DIMENSIONS[size] || CARD_DIMENSIONS.lg;

  useEffect(() => {
    const t = setTimeout(() => setDealt(true), (dealDelay || 0) * 120);
    return () => clearTimeout(t);
  }, [dealDelay]);

  const visible = dealt ? 'opacity-100 scale-100' : 'opacity-0 scale-50';

  // ── Face-down card (back) ──
  if (faceDown || !card) {
    return (
      <div
        className={`card-back rounded-lg shadow-lg border-2 border-white/15 select-none ${visible}`}
        style={{
          width: dim.w, height: dim.h,
          transition: `all 0.35s cubic-bezier(0.34,1.56,0.64,1) ${(dealDelay||0)*120}ms`,
        }}
      >
        <div className="w-full h-full flex items-center justify-center">
          <span className="text-white/20 font-bold select-none" style={{ fontSize: dim.h * 0.28 }}>
            ♠
          </span>
        </div>
      </div>
    );
  }

  // ── Face-up card ──
  const isRed = card.suit === 'hearts' || card.suit === 'diamonds';
  const suitSymbol = card.suitSymbol || (card.suit ? { hearts:'♥',diamonds:'♦',clubs:'♣',spades:'♠' }[card.suit] : '?');
  const color = isRed ? 'text-red-600' : 'text-gray-900';
  const rankDisplay = card.rankName === '10' ? '10' : card.rankName;

  return (              <div className={`card-front rounded-lg shadow-lg border border-gray-200/80 select-none ${visible}`}
      style={{
        width: dim.w, height: dim.h,
        transition: `all 0.35s cubic-bezier(0.34,1.56,0.64,1) ${(dealDelay||0)*120}ms`,
      }}
    >
      {/* Center suit - absolutely centered via flexbox on parent */}
      <span className={`${dim.suit} ${color} absolute inset-0 flex items-center justify-center pointer-events-none`}>
        {suitSymbol}
      </span>

      {/* Top-left corner */}
      <div className="absolute top-0.5 left-1 flex flex-col items-center leading-none pointer-events-none">
        <span className={`${dim.corner} font-bold ${color}`}>{rankDisplay}</span>
        <span className={`${dim.corner} ${color}`}>{suitSymbol}</span>
      </div>

      {/* Bottom-right corner (flipped) */}
      <div className="absolute bottom-0.5 right-1 flex flex-col items-center leading-none rotate-180 pointer-events-none">
        <span className={`${dim.corner} font-bold ${color}`}>{rankDisplay}</span>
        <span className={`${dim.corner} ${color}`}>{suitSymbol}</span>
      </div>
    </div>
  );
}

// True on phones/small tablets (<640px). Drives smaller card sizes so the
// whole table + controls fit on screen without scrolling.
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 640px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)');
    const onChange = (e) => setIsMobile(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return isMobile;
}

// ====================================================================
// MAIN COMPONENT
// ====================================================================
export default function ClubRoom({ clubData, displayName, onLeave, onLogout }) {
  const { gameId = clubData.clubId, tableName = 'Poker Table', userId, seatIndex: mySeatIndex, buyinAmount, initialPlayers } = clubData;
  const clubId = gameId;
  const isMobile = useIsMobile();
  const [players, setPlayers] = useState(initialPlayers || Array(6).fill(null));
  const [gameState, setGameState] = useState(clubData.gameState || 'WAITING');
  const [isConnected, setIsConnected] = useState(true);
  const [showCashOut, setShowCashOut] = useState(false);
  const [cashingOut, setCashingOut] = useState(false);
  const [notifications, setNotifications] = useState([]);
  // Whether the server has bots enabled (hides the Add/Remove Bot buttons)
  const [botsEnabled, setBotsEnabled] = useState(clubData.botsEnabled === true);

  // Game state
  const [communityCards, setCommunityCards] = useState([]);
  const [holeCards, setHoleCards] = useState([]);
  const [pot, setPot] = useState(0);
  const [currentBet, setCurrentBet] = useState(0);
  const [minRaise, setMinRaise] = useState(20);
  const [currentPlayerSeatIndex, setCurrentPlayerSeatIndex] = useState(-1);
  const [dealerSeatIndex, setDealerSeatIndex] = useState(-1);
  const [handCount, setHandCount] = useState(0);
  const [handResult, setHandResult] = useState(null);
  // Interactive showdown phase: who must reveal, whose cards are shown, who mucked
  const [showdown, setShowdown] = useState(null);

  // Action state
  const [lastAction, setLastAction] = useState(null);
  const [actionTimeRemaining, setActionTimeRemaining] = useState(0);
  const [actionTimerTotal, setActionTimerTotal] = useState(20);

  // Bet slider
  const [betSliderValue, setBetSliderValue] = useState(0);



  // Chip flight animation state
  const [chipFlights, setChipFlights] = useState([]);
  const prevBetsRef = useRef({});
  const chipFlightId = useRef(0);
  const chipFlightTimers = useRef([]);
  // Live ref to the latest players array so socket handlers (which are
  // registered once) can read current roundBet values when a hand completes.
  const playersRef = useRef(players);

  useEffect(() => { playersRef.current = players; }, [players]);
  // Last hand number this client has observed. Null on mount, which matters:
  // a fresh join into an already-running game sees handCount jump 0 → N on
  // its first sync, but that is NOT a new hand — so we must not treat it as
  // one (doing so would wipe the mid-game baseline guard and burst flights).
  const lastHandCountRef = useRef(null);
  // True when this client mounted into an already-running game (not via
  // rejoin — that path sets a baseline in onFullStateSnapshot). Used to
  // record existing bets as baseline instead of bursting flights on join.
  const mountedMidGameRef = useRef(
    typeof clubData.gameState === 'string' && clubData.gameState !== 'WAITING'
  );

  // Clear any pending flight timers on unmount
  useEffect(() => {
    return () => {
      chipFlightTimers.current.forEach(t => clearTimeout(t));
      chipFlightTimers.current = [];
    };
  }, []);

  // Reset bet slider + chip flight tracking when a NEW hand genuinely starts
  // (handCount advances forward). Mount-time jumps (0 → N on a fresh join or
  // rejoin) are NOT new hands and must be ignored, or the mid-game baseline
  // guard gets wiped before the bet-diff effect can scan existing bets.
  useEffect(() => {
    const isNewHand = lastHandCountRef.current !== null && handCount > lastHandCountRef.current;
    lastHandCountRef.current = handCount;
    if (!isNewHand) return;
    setBetSliderValue(0);
    prevBetsRef.current = {};
    setChipFlights([]);
    // New hand always starts fresh — drop any lingering mid-game baseline
    // guard so blind posts on this hand can animate normally.
    mountedMidGameRef.current = false;
  }, [handCount]);

  // ─── Socket handlers ──────────────────────────────────────
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const onConnect = () => {
      setIsConnected(true);
      socket.emit('rejoin_ring_game', { gameId: clubId }, (err) => {
        if (err) {
          if (err.refunded) {
            // Table was lost to a server restart — backend refunded the chips
            addNotification(`Table closed — ${err.refunded.toLocaleString()} chips returned to your bankroll`, 'success');
            onLeave();
          } else {
            addNotification('Failed to reconnect', 'error');
          }
        }
      });
    };

    const onDisconnect = () => {
      setIsConnected(false);
      addNotification('Connection lost. Reconnecting...', 'warning');
    };

    const onStateUpdate = (data) => {
      setPlayers(data.players || Array(6).fill(null));
      setGameState(data.gameState || 'WAITING');
      if (data.botsEnabled !== undefined) setBotsEnabled(data.botsEnabled === true);
    };

    const onGameStateSync = (data) => {
      setCommunityCards(data.communityCards || []);
      setPot(data.pot || 0);
      setCurrentBet(data.currentBet || 0);
      setMinRaise(data.minRaise || 20);
      setCurrentPlayerSeatIndex(data.currentPlayerSeatIndex ?? -1);
      setDealerSeatIndex(data.dealerSeatIndex ?? -1);
      setHandCount(data.handCount ?? 0);
      setActionTimeRemaining(data.actionTimeRemaining ?? 0);
      setActionTimerTotal(data.actionTimerTotal ?? 20);
      if (data.gameStatus) {
        // Clear hand result when a new hand starts
        if (data.gameStatus === 'PREFLOP') {
          setHandResult(null);
          setShowdown(null);
        }
        setGameState(data.gameStatus);
      }
      // Track the interactive showdown phase (reveal order, exposed cards, mucks)
      setShowdown(data.showdown && data.showdown.active ? data.showdown : null);

      if (data.players) {
        // A genuine new hand (handCount advances forward; mount-time jumps
        // 0 → N on a fresh join/rejoin are NOT new hands) clears transient
        // hand flags for seats that are not dealt into this hand. Otherwise a
        // player who went all-in last hand and busted would carry a stale
        // isAllIn=true into the next hand, making the game treat them as an
        // all-in participant (hiding Rebuy) when they are really a busted
        // spectator. Players dealt into this hand get correct flags
        // re-applied from data.players below.
        const isNewHand = lastHandCountRef.current !== null
          && (data.handCount ?? 0) > lastHandCountRef.current;
        setPlayers(prev => {
          const updated = isNewHand
            ? prev.map(existing => existing
                ? { ...existing, isAllIn: false, isFolded: false, roundBet: 0, mucked: false, showHoleCards: false }
                : existing)
            : [...prev];
          for (const p of data.players) {
            const existing = updated[p.seatIndex];
            updated[p.seatIndex] = {
              ...existing,
              ...p,
              isPlaying: true,
              // Game state sync is public — never includes hole cards
              showHoleCards: false,
              holeCards: existing?.holeCards || undefined,
            };
          }
          // During the interactive showdown the public state carries the
          // exposed cards and muck decisions — apply them to the seats.
          if (data.showdown && data.showdown.active) {
            for (const seat of data.showdown.mucked || []) {
              if (updated[seat]) {
                updated[seat] = { ...updated[seat], mucked: true, showHoleCards: false };
              }
            }
            for (const r of data.showdown.revealed || []) {
              if (updated[r.seatIndex]) {
                updated[r.seatIndex] = {
                  ...updated[r.seatIndex],
                  mucked: false,
                  showHoleCards: true,
                  holeCards: r.holeCards,
                };
              }
            }
          }
          return updated;
        });
      }
    };

    const onYourHoleCards = (data) => {
      setHoleCards(data.holeCards || []);
      if (data.holeCards) {
        setPlayers(prev => {
          const updated = [...prev];
          if (updated[mySeatIndex]) {
            updated[mySeatIndex] = { ...updated[mySeatIndex], holeCards: data.holeCards };
          }
          return updated;
        });
      }
    };

    const onFullStateSnapshot = (data) => {
      // Suppress chip flights on reconnect — just baseline current bets
      if (data.players) {
        const baseline = {};
        for (const p of data.players) {
          if (p && typeof p.roundBet === 'number') baseline[p.seatIndex] = p.roundBet;
        }
        prevBetsRef.current = baseline;
        setChipFlights([]);
        // Drain any pending flight timers so they don't fire as no-ops
        chipFlightTimers.current.forEach(t => clearTimeout(t));
        chipFlightTimers.current = [];
      }
      setCommunityCards(data.communityCards || []);
      setPot(data.pot || 0);
      setCurrentBet(data.currentBet || 0);
      setMinRaise(data.minRaise || 20);
      setCurrentPlayerSeatIndex(data.currentPlayerSeatIndex ?? -1);
      setDealerSeatIndex(data.dealerSeatIndex ?? -1);
      setHandCount(data.handCount || 0);
      setHoleCards(data.holeCards || []);
      if (data.gameStatus) {
        if (data.gameStatus === 'PREFLOP') setShowdown(null);
        setGameState(data.gameStatus);
      }
      setShowdown(data.showdown && data.showdown.active ? data.showdown : null);

      if (data.players) {
        // Same new-hand reset as onGameStateSync: a rejoin snapshot arrives
        // for the CURRENT hand. If that hand is newer than what this client
        // last saw (e.g. the player was all-in, disconnected, busted, and the
        // table dealt a new hand without them), clear stale transient flags
        // so the game doesn't treat them as an all-in participant (hiding
        // Rebuy) when they are really a busted spectator.
        const isNewHand = lastHandCountRef.current !== null
          && (data.handCount || 0) > lastHandCountRef.current;
        setPlayers(prev => {
          const updated = isNewHand
            ? prev.map(existing => existing
                ? { ...existing, isAllIn: false, isFolded: false, roundBet: 0, mucked: false, showHoleCards: false }
                : existing)
            : [...prev];
          for (const p of data.players) {
            const existing = updated[p.seatIndex];
            updated[p.seatIndex] = {
              ...existing,
              ...p,
              isPlaying: true,
              showHoleCards: false,
              holeCards: existing?.holeCards || data.holeCards || undefined,
            };
          }
          // Reconnecting mid-showdown: replay the exposed cards + mucks so the
          // reconnected client sees the reveal state so far.
          if (data.showdown && data.showdown.active) {
            for (const seat of data.showdown.mucked || []) {
              if (updated[seat]) {
                updated[seat] = { ...updated[seat], mucked: true, showHoleCards: false };
              }
            }
            for (const r of data.showdown.revealed || []) {
              if (updated[r.seatIndex]) {
                updated[r.seatIndex] = {
                  ...updated[r.seatIndex],
                  mucked: false,
                  showHoleCards: true,
                  holeCards: r.holeCards,
                };
              }
            }
          }
          return updated;
        });
      }
    };

    const onHandComplete = (data) => {
      setHandResult(data);
      setShowdown(null); // reveal phase is over — final state lives on the players
      setLastAction(null);

      if (data.handResult) {
        // Collect unique winner seat indices and each winner's total payout
        // across all (side) pots so split pots pay out to every winner.
        const winnerSeats = [];
        const winnerTotals = {};
        for (const pot of data.handResult) {
          for (const winner of pot.winners) {
            if (winner.seatIndex >= 0) {
              if (!winnerSeats.includes(winner.seatIndex)) winnerSeats.push(winner.seatIndex);
              winnerTotals[winner.seatIndex] = (winnerTotals[winner.seatIndex] || 0) + (winner.amountWon || 0);
            }
            const winnerName = data.players?.find(p => p.seatIndex === winner.seatIndex)?.userName || 'Player';
            addNotification(`${winnerName} wins $${winner.amountWon}!`, 'success');
          }
        }

        // Stage 1: sweep any chips still on the felt (e.g. blinds left when
        // everyone folds) into the middle pot.
        const current = playersRef.current;
        let swept = 0;
        current.forEach((p, seatIndex) => {
          if (p && (p.roundBet || 0) > 0) {
            spawnChipFlight(seatIndex, BET_CHIP_POSITIONS[seatIndex], POT_POSITION, formatBetLabel(p.roundBet));
            swept++;
          }
        });

        // Stage 2: push the pot out to the winner(s). Delayed until the
        // sweep lands in the middle so it reads: bets collect → pot pays.
        if (winnerSeats.length > 0) {
          const delay = swept > 0 ? 700 : 250;
          const stage2Timer = setTimeout(() => {
            chipFlightTimers.current = chipFlightTimers.current.filter(t => t !== stage2Timer);
            winnerSeats.forEach(seat => {
              spawnChipFlight(seat, POT_POSITION, SEAT_POSITIONS[seat], formatBetLabel(winnerTotals[seat]));
            });
          }, delay);
          chipFlightTimers.current.push(stage2Timer);
        }
      }

      if (data.players) {
        setPlayers(prev => {
          const updated = [...prev];
          for (const p of data.players) {
            const existing = updated[p.seatIndex];
            updated[p.seatIndex] = {
              ...existing,
              stack: p.stack,
              roundBet: 0, // chips were flown to the winner
              // Reveal policy from the server: winners + all-in show, mucked
              // losers and uncontested winners stay hidden.
              mucked: !!p.mucked,
              showHoleCards: !!p.revealed,
              // Own cards are preserved even when mucked — you always know
              // your own hand.
              holeCards: p.holeCards || existing?.holeCards,
            };
          }
          return updated;
        });
      }
    };

    const onLastAction = (data) => {
      setLastAction(data);
    };

    const onConnectError = () => setIsConnected(false);

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('table_state_update', onStateUpdate);
    // Legacy support for old event name
    socket.on('club_state_update', onStateUpdate);
    socket.on('game_state_sync', onGameStateSync);
    socket.on('your_hole_cards', onYourHoleCards);
    socket.on('full_state_snapshot', onFullStateSnapshot);
    socket.on('hand_complete', onHandComplete);
    socket.on('last_action', onLastAction);
    socket.on('connect_error', onConnectError);

    if (socket.connected) {
      onConnect();
    } else {
      socket.connect();
    }

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('table_state_update', onStateUpdate);
      socket.off('club_state_update', onStateUpdate);
      socket.off('game_state_sync', onGameStateSync);
      socket.off('your_hole_cards', onYourHoleCards);
      socket.off('full_state_snapshot', onFullStateSnapshot);
      socket.off('hand_complete', onHandComplete);
      socket.off('last_action', onLastAction);
      socket.off('connect_error', onConnectError);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clubId, userId]);

  // ─── Spawn a chip that flies between two felt positions ───
  // On a new bet: seat → bet spot. When a betting round ends:
  // bet spot → pot center (sweep). On hand completion: bet spot → winner.
  const spawnChipFlight = useCallback((seatIndex, fromPos, toPos, label) => {
    const from = fromPos || SEAT_POSITIONS[seatIndex];
    const to = toPos || POT_POSITION;
    if (!from || !to) return;
    const id = ++chipFlightId.current;
    const flight = {
      key: `flight-${id}`,
      label: label || '',
      fromTop: from.top,
      fromLeft: from.left,
      midTop: (from.top + to.top) / 2 - 12,
      midLeft: (from.left + to.left) / 2,
      toTop: to.top,
      toLeft: to.left,
    };
    setChipFlights(prev => [...prev, flight]);
    const timer = setTimeout(() => {
      chipFlightTimers.current = chipFlightTimers.current.filter(t => t !== timer);
      setChipFlights(prev => prev.filter(f => f.key !== flight.key));
    }, 800);
    chipFlightTimers.current.push(timer);
  }, []);

  // ─── Track betting-round chip movement ───
  // When a player's roundBet increases (call/bet/raise), a chip flies from
  // their seat to their bet spot. When the betting round ends (roundBet
  // resets to 0 on street advance), the bet chips sweep into the pot.
  useEffect(() => {
    if (gameState === 'WAITING' || gameState === 'SHOWDOWN' || gameState === 'HAND_COMPLETE') return;

    // Fresh join into an already-running game: record existing bets as a
    // baseline on the first sync that actually carries bet amounts, so we
    // don't burst a flight for every seated player at once.
    if (mountedMidGameRef.current) {
      let recorded = 0;
      for (const p of players) {
        if (p && typeof p.roundBet === 'number') {
          prevBetsRef.current[p.seatIndex] = p.roundBet;
          recorded++;
        }
      }
      if (recorded > 0) mountedMidGameRef.current = false;
      return;
    }

    players.forEach((p, seatIndex) => {
      if (!p || typeof p.roundBet !== 'number') return;
      const prev = prevBetsRef.current[seatIndex] || 0;
      const cur = p.roundBet;
      if (cur > prev) {
        // New bet placed — chip flies from the seat to the bet spot
        spawnChipFlight(seatIndex, SEAT_POSITIONS[seatIndex], BET_CHIP_POSITIONS[seatIndex], formatBetLabel(cur));
      } else if (cur < prev && prev > 0) {
        // Betting round ended — the bet chips sweep into the pot
        spawnChipFlight(seatIndex, BET_CHIP_POSITIONS[seatIndex], POT_POSITION, formatBetLabel(prev));
      }
      prevBetsRef.current[seatIndex] = cur;
    });
  }, [players, gameState, spawnChipFlight]);

  const addNotification = useCallback((message, type = 'info') => {
    const id = Date.now();
    setNotifications(prev => [...prev, { id, message, type }]);
    setTimeout(() => setNotifications(prev => prev.filter(n => n.id !== id)), 4000);
  }, []);

  const handleReadyToggle = useCallback(() => {
    getSocket().emit('player_ready', { gameId: clubId });
  }, [clubId]);

  const handleStartGame = useCallback(() => {
    getSocket().emit('start_game', { gameId: clubId }, (err) => {
      if (err) addNotification(err.error || 'Failed to start game', 'error');
    });
  }, [clubId, addNotification]);

  const handleAddBots = useCallback(() => {
    getSocket().emit('add_bots', { gameId: clubId }, (err) => {
      if (err) addNotification(err.error || 'Failed to add bots', 'error');
    });
  }, [clubId, addNotification]);

  const handleRemoveBots = useCallback(() => {
    getSocket().emit('remove_bots', { gameId: clubId }, (err) => {
      if (err) addNotification(err.error || 'Failed to remove bots', 'error');
    });
  }, [clubId, addNotification]);

  const handleAction = useCallback((action, amount) => {
    getSocket().emit('player_action', { gameId: clubId, action, amount }, (err) => {
      if (err) addNotification(err.error || 'Action failed', 'error');
    });
  }, [clubId, addNotification]);

  const handleShowdownDecision = useCallback((show) => {
    getSocket().emit('showdown_decision', { gameId: clubId, show }, (err) => {
      if (err) addNotification(err.error || 'Action failed', 'error');
    });
  }, [clubId, addNotification]);

  const handleRebuy = useCallback(() => {
    const buyin = Math.max(50, clubData?.minBuyin || 50);
    getSocket().emit('player_rebuy', { gameId: clubId, buyinAmount: buyin }, (err) => {
      if (err) addNotification(err.error || 'Rebuy failed', 'error');
      else addNotification(`Rebought ${buyin} chips!`, 'success');
    });
  }, [clubId, clubData?.minBuyin, addNotification]);

  const handleCashOut = useCallback(() => {
    setCashingOut(true);
    getSocket().emit('leave_ring_game', { gameId: clubId }, (err, data) => {
      setCashingOut(false);
      setShowCashOut(false);
      if (err) {
        addNotification(err.error || 'Failed to cash out', 'error');
        return;
      }
      addNotification(`Cashed out ${data.cashOutAmount} chips!`, 'success');
      // Navigate back to lobby
      setTimeout(() => onLeave(), 1500);
    });
  }, [clubId, addNotification, onLeave]);

  const handleSitOutToggle = useCallback(() => {
    getSocket().emit('player_sit_out', { gameId: clubId }, (err) => {
      if (err) addNotification(err.error || 'Failed', 'error');
    });
  }, [clubId, addNotification]);

  const handleLeaveTable = useCallback(() => {
    // Use HTTP endpoint (not socket) to avoid race conditions.
    // This is a simple POST that refunds the buy-in and clears the seat.
    // We navigate to lobby regardless of the result (don't trap the user).
    fetch(`${API_BASE}/api/games/leave`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getToken()}`,
      },
    }).then(r => r.json()).then(data => {
      if (data.success) {
        console.log(`[Leave] Refunded ${data.refundAmount} chips`);
      } else {
        console.warn('[Leave] Failed:', data.error);
      }
    }).catch(err => {
      console.error('[Leave] Error:', err);
    }).finally(() => {
      onLeave();
    });
  }, [onLeave]);

  // ─── Derived state ────────────────────────────────────────
  const isMyTurn = currentPlayerSeatIndex === mySeatIndex
    && gameState !== 'WAITING'
    && gameState !== 'SHOWDOWN'
    && gameState !== 'HAND_COMPLETE';
  const myPlayerData = players[mySeatIndex];
  const isMeFolded = myPlayerData?.isFolded;
  const isMeAllIn = myPlayerData?.isAllIn;
  // A stack-0 player mid-hand is ALL-IN (still in the hand), not busted.
  // E.g. posting a blind that empties their stack — the game must keep
  // showing them as an all-in participant, not a busted spectator.
  const inLiveHand = gameState === 'PREFLOP' || gameState === 'FLOP'
    || gameState === 'TURN' || gameState === 'RIVER' || gameState === 'SHOWDOWN';
  const isAllInMidHand = !!isMeAllIn && inLiveHand;
  const connectedPlayers = players.filter(p => p !== null);
  const isHost = players[mySeatIndex]?.isHost;
  const canAct = isMyTurn && !isMeFolded && !isMeAllIn;

  // Betting requires a live opponent to bet against. If every other player
  // is all-in (or folded), the board runs out instead of offering betting
  // options — standard poker (heads-up vs an all-in opponent deals the rest
  // of the board out). The lone live player still gets call/fold if they owe
  // the current bet (e.g. an all-in raise they haven't matched yet).
  const hasLiveOpponent = connectedPlayers.some(p =>
    p && !p.isFolded && !p.isAllIn && p.seatIndex !== mySeatIndex
  );
  const oweCurrentBet = (currentBet || 0) > (myPlayerData?.roundBet || 0);
  // Main action buttons (fold/check/call) — only when you can actually act.
  const showMainActions = canAct && (hasLiveOpponent || oweCurrentBet);
  // Bet sizing controls (raise/bet/all-in) — always need a live opponent.
  const showBetting = canAct && (myPlayerData?.stack || 0) > 0 && hasLiveOpponent;

  // ─── Timer countdown ──────────────────────────────────────
  const [displayTimer, setDisplayTimer] = useState(0);
  useEffect(() => {
    if (gameState === 'WAITING' || gameState === 'HAND_COMPLETE') {
      setDisplayTimer(0);
      return;
    }
    setDisplayTimer(actionTimeRemaining);
    const interval = setInterval(() => setDisplayTimer(prev => Math.max(0, prev - 1)), 1000);
    return () => clearInterval(interval);
  }, [actionTimeRemaining, gameState, handCount]);

  // ─── Bet sizing ───────────────────────────────────────────
  const potSize = pot || 0;
  // Use the CURRENT STREET bet (roundBet), not the cumulative hand total
  const currentPlayerBet = myPlayerData?.roundBet || 0;
  const myStack = myPlayerData?.stack || 0;
  const minBetValue = currentBet > 0
    ? Math.min(currentBet + minRaise, myStack + currentPlayerBet)
    : minRaise;
  const maxBetValue = myStack + currentPlayerBet;

  const getBetPreset = (fraction) => {
    if (currentBet > 0) {
      const raiseTo = Math.min(Math.floor(potSize * fraction) + currentBet, maxBetValue);
      return Math.max(raiseTo, minBetValue);
    } else {
      return Math.min(Math.floor(potSize * fraction) || minRaise, myStack);
    }
  };

  const getSliderBet = (value) => {
    const ratio = value / 100;
    return Math.round(minBetValue + (maxBetValue - minBetValue) * ratio);
  };
  const sliderBet = getSliderBet(betSliderValue);
  const isRaiseContext = currentBet > 0;

  // ─── Determine game phase color ───────────────────────────
  const phaseColor =
    gameState === 'PREFLOP' ? 'bg-blue-500' :
    gameState === 'FLOP'    ? 'bg-green-500' :
    gameState === 'TURN'    ? 'bg-yellow-500' :
    gameState === 'RIVER'   ? 'bg-red-500' : 'bg-gray-500';

  // =============================================================
  // RENDER
  // =============================================================
  return (
    <div className="min-h-screen-mobile bg-gradient-to-b from-gray-950 via-gray-900 to-gray-950 flex flex-col overflow-hidden select-none">

      {/* ── Connection Banner ── */}
      {!isConnected && (
        <div className="bg-red-900/60 backdrop-blur-sm px-4 py-2 text-center text-sm text-red-200 animate-slide-down">
          <span className="inline-block w-2 h-2 bg-red-400 rounded-full animate-pulse mr-2" />
          Connection lost. Attempting to reconnect...
        </div>
      )}

      {/* ── Notifications ── */}
      {notifications.length > 0 && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 w-full max-w-sm space-y-2 px-4 pointer-events-none">
          {notifications.map(n => (
            <div key={n.id}
              className={`px-4 py-3 rounded-xl shadow-lg text-sm font-medium animate-slide-up backdrop-blur-sm pointer-events-auto ${
                n.type === 'error'   ? 'bg-red-900/90 text-red-200' :
                n.type === 'warning' ? 'bg-yellow-900/90 text-yellow-200' :
                n.type === 'success' ? 'bg-green-900/90 text-green-200' :
                'bg-gray-800/90 text-white'
              }`}
            >{n.message}</div>
          ))}
        </div>
      )}

      {/* ── Cash Out Modal ── */}
      {showCashOut && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-gray-900 rounded-2xl border border-gray-800 p-6 w-full max-w-xs animate-slide-up shadow-2xl">
            <div className="text-center">
              <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-emerald-500/20 mb-3">
                <svg className="w-7 h-7 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <circle cx="12" cy="12" r="9" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 7v10M9.5 9.5h3.5a1.5 1.5 0 010 3h-2a1.5 1.5 0 000 3h3.5" />
                </svg>
              </div>
              <h3 className="text-lg font-bold text-white mb-1">Cash Out?</h3>
              <p className="text-sm text-gray-400 mb-1">
                Your stack: <span className="text-poker-gold font-bold font-mono">${myPlayerData?.stack?.toLocaleString() || 0}</span>
              </p>
              <p className="text-xs text-gray-500 mb-4">
                This amount will be added to your bankroll.
              </p>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setShowCashOut(false)} disabled={cashingOut}
                className="flex-1 py-2.5 bg-gray-800 text-gray-300 rounded-xl text-sm font-semibold hover:bg-gray-700 transition-all active:scale-95">
                Stay
              </button>
              <button onClick={handleCashOut} disabled={cashingOut}
                className="flex-1 py-2.5 bg-gradient-to-r from-emerald-600 to-emerald-500 text-white rounded-xl text-sm font-bold
                           hover:from-emerald-500 hover:to-emerald-400 transition-all active:scale-95 disabled:opacity-50">
                {cashingOut ? (
                  <span className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : 'Cash Out'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Hand Result Overlay ── */}
      {handResult && handResult.handResult && (
        <div className="fixed inset-0 z-40 pointer-events-none flex items-center justify-center"
          style={{ animation: 'fadeIn 0.3s ease-out' }}>
          <div className="bg-gray-900/85 backdrop-blur-md rounded-2xl border border-poker-gold/30 p-4 sm:p-6 max-w-sm mx-4 text-center shadow-2xl animate-slide-up">
            <h3 className="text-base sm:text-lg font-bold text-poker-gold mb-3">Hand Complete</h3>
            <div className="space-y-2">
              {handResult.handResult.map((pot, i) => (
                <div key={i} className="text-sm">
                  {pot.winners.map((w, j) => {
                    const winnerName = handResult.players?.find(p => p.seatIndex === w.seatIndex)?.userName || 'Player';
                    return (
                      <p key={j} className="text-white flex items-center justify-center gap-2">
                        {i > 0 && <span className="text-gray-400 text-xs">Side:</span>}
                        <span className="font-bold">{winnerName}</span>
                        won <span className="text-poker-gold font-bold">${w.amountWon}</span>
                        {w.handResult?.rankName && w.handResult?.rankName !== 'Uncontested' && (
                          <span className="text-gray-400 text-xs">({w.handResult.rankName})</span>
                        )}
                      </p>
                    );
                  })}
                </div>
              ))}
              {/* Losers who mucked — their cards are never shown */}
              {handResult.players?.some(p => p.mucked) && (
                <div className="pt-2 mt-1 border-t border-gray-700/60 space-y-0.5">
                  {handResult.players.filter(p => p.mucked).map(p => (
                    <p key={p.seatIndex} className="text-xs text-gray-400">
                      <span className="font-medium text-gray-300">{p.userName}</span> mucks
                    </p>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Header Bar ── */}
      <header className="bg-gray-900/80 backdrop-blur-sm border-b border-gray-800 px-2 sm:px-4 py-1.5 sm:py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <button onClick={handleLeaveTable}
            className="text-gray-400 hover:text-white transition-colors p-1.5 -ml-1.5 shrink-0"
            title="Leave Table">
            <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
          </button>
          <div className="min-w-0">
            <h2 className="text-xs sm:text-sm font-semibold text-white truncate">{tableName}</h2>
            <p className="text-[10px] sm:text-xs text-gray-500 truncate">
              {connectedPlayers.length}/{MAX_SEATS} players
              {handCount > 0 && <span className="ml-1 sm:ml-2">· Hand #{handCount}</span>}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          {/* Cash Out button when game is not waiting */}
          {gameState !== 'WAITING' && myPlayerData && myPlayerData.stack > 0 && (
            <button onClick={() => setShowCashOut(true)}
              className="px-2 sm:px-3 py-1 sm:py-1.5 bg-gradient-to-r from-emerald-600 to-emerald-500 text-white rounded-lg text-[10px] sm:text-xs font-bold
                         hover:from-emerald-500 hover:to-emerald-400 transition-all active:scale-95 shadow-lg shadow-emerald-600/20">
              Cash Out
            </button>
          )}
          <button onClick={onLogout}
            className="text-gray-500 hover:text-gray-300 transition-colors p-1.5 shrink-0"
            title="Logout">
            <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
          </button>
        </div>
      </header>

      {/* ==============================================================
          MAIN GAME AREA — Two-row layout: Table on top, Cards + Controls below
          In landscape mode (orientation:landscape + max-height:500px), switches
          to a horizontal layout: table on left, controls on right.
          ============================================================== */}
      <div className="flex-1 flex flex-col min-h-0 landscape-row">

        {/* ── TOP ROW: Table + Players ── */}
        <div className="flex-1 flex items-center justify-center p-0.5 sm:p-2 min-h-0 landscape-table">
          {/* On mobile (<640px), use a flatter 2:1 oval so the whole game
              fits the screen height without scrolling.
              On desktop (>=640px), use the classic 4:3 ratio. */}
          <div className="relative w-full max-h-full sm:aspect-[4/3] aspect-[2/1] felt-wrap" style={{ maxWidth: '800px', maxHeight: '100%' }}>

            {/* The Felt Table */}
            <div className="felt-table w-full h-full flex flex-col items-center justify-center relative overflow-hidden">

              {/* Decorative felt pattern */}
              <div className="absolute inset-0 opacity-[0.03] pointer-events-none"
                style={{
                  backgroundImage: `radial-gradient(circle at 20% 50%, transparent 0%, transparent 2%, rgba(255,255,255,0.1) 2%, transparent 3%),
                                    radial-gradient(circle at 80% 30%, transparent 0%, transparent 2%, rgba(255,255,255,0.1) 2%, transparent 3%)`,
                  backgroundSize: '60px 60px',
                }}
              />

              {/* ── Community Cards (positioned in the upper-center of the felt) ── */}
              <div className="flex items-center gap-1.5 sm:gap-3 mb-1.5 z-10 community-row">
                {[0, 1, 2, 3, 4].map(i => (
                  <Card key={i} card={communityCards[i]} faceDown={!communityCards[i]} size={isMobile ? 'md' : 'lg'} dealDelay={i} />
                ))}
              </div>

              {/* ── Pot + Street — one compact row so they never stack up over
                   the seats on small screens ── */}
              {(pot > 0 || (gameState !== 'WAITING' && gameState !== 'HAND_COMPLETE')) && (
                <div className="flex items-center justify-center gap-1.5 sm:gap-3 flex-wrap z-10 pot-street-row">
                  {pot > 0 && (
                    <div key={pot} className="bg-black/50 rounded-full px-3 sm:px-6 py-1 sm:py-1.5 backdrop-blur-sm animate-pot-grow pot-pill">
                      <span className="text-[11px] sm:text-base font-bold text-poker-gold whitespace-nowrap">
                        Pot: ${pot.toLocaleString()}
                      </span>
                    </div>
                  )}
                  {gameState !== 'WAITING' && gameState !== 'HAND_COMPLETE' && (
                    <div className="px-2.5 sm:px-3 py-0.5 sm:py-1 bg-white/5 rounded-full text-[10px] sm:text-xs text-gray-400 street-pill whitespace-nowrap">
                      <span className={`inline-block w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full mr-1.5 ${phaseColor}`} />
                      {gameState}
                      {currentBet > 0 && <span className="ml-1.5 sm:ml-2">· Bet: ${currentBet}</span>}
                    </div>
                  )}
                </div>
              )}

              {/* ── Waiting indicator ── */}
              {gameState === 'WAITING' && (
                <div className="mt-2 text-xs text-gray-500 animate-pulse z-10">Waiting for players...</div>
              )}
            </div> {/* end felt-table */}

            {/* ── Player Seats (overlaid on the felt) ── */}
            {players.map((player, index) => {
              const pos = SEAT_POSITIONS[index];
              if (!pos) return null;
              const isMe = index === mySeatIndex;

              // Empty seat — show card back as placeholder
              if (!player) {
                return (
                  <div key={index}
                    className="absolute -translate-x-1/2 -translate-y-1/2 transition-all duration-300 pointer-events-none"
                    style={{ top: `${pos.top}%`, left: `${pos.left}%` }}
                  >
                    <div className="flex flex-col items-center gap-1 opacity-30">
                      <Card card={null} faceDown={true} size="sm" dealDelay={0} />
                      <span className="text-[8px] text-gray-500/40">Seat {index + 1}</span>
                    </div>
                  </div>
                );
              }

              const isActiveTurn = index === currentPlayerSeatIndex;
              const isDealer = index === dealerSeatIndex;
              const chipPos = BET_CHIP_POSITIONS[index];
              // Readable, adaptive bet chip: abbreviate large amounts (e.g. $1.2K,
              // $2.5M) and only scale the font down slightly, so big bets stay
              // crisp and legible instead of being clipped inside a fixed circle.
              // Show the CURRENT STREET bet (roundBet) so chips in front of
              // players reset every betting round and get swept to the pot.
              const betLabel = formatBetLabel(player.roundBet);
              const betFont =
                betLabel.length >= 8 ? 'text-[8px] sm:text-[10px]' :
                betLabel.length >= 5 ? 'text-[9px] sm:text-[11px]' :
                'text-[10px] sm:text-xs';

              return (
                <React.Fragment key={player.userId || `seat-${index}`}>
                  {/* Bet chip — on the felt in front of the seat */}
                  {player.roundBet > 0 && (
                    <div className="absolute -translate-x-1/2 -translate-y-1/2 z-20 pointer-events-none transition-all duration-500"
                      style={{ top: `${chipPos.top}%`, left: `${chipPos.left}%` }}
                    >
                      <div className="relative flex items-center justify-center animate-chip-stack">
                        {/* Stack depth below the top chip */}
                        <div className="absolute inset-0 poker-chip opacity-50 translate-y-[2px]" />
                        <div className="absolute inset-0 poker-chip opacity-75 translate-y-[1px]" />
                        <div className={`relative poker-chip text-white ${betFont} font-bold tabular-nums
                                        rounded-full h-7 sm:h-8 min-w-7 sm:min-w-8 px-2 sm:px-2.5
                                        flex items-center justify-center whitespace-nowrap
                                        border border-white/30 border-solid shadow-lg`}
                          style={{ textShadow: '0 1px 2px rgba(0,0,0,0.45)' }}
                        >
                          {betLabel}
                        </div>
                      </div>
                    </div>
                  )}
                  <div className="absolute -translate-x-1/2 -translate-y-1/2 transition-all duration-500"
                    style={{ top: `${pos.top}%`, left: `${pos.left}%` }}
                  >
                  <div className={`
                    flex flex-col items-center gap-0.5
                    ${!player.isConnected ? 'opacity-50' : ''}
                    ${player.isFolded ? 'opacity-40 grayscale' : ''}
                    transition-all duration-300
                  `}>
                    {/* Dealer Button */}
                    {isDealer && (
                      <div className="w-5 h-5 sm:w-6 sm:h-6 rounded-full bg-white text-black flex items-center justify-center
                                      text-[9px] sm:text-[11px] font-bold shadow-lg z-10 animate-bounce-subtle">
                        D
                      </div>
                    )}

                    {/* Avatar ring — pulsing green if active turn (bright so it
                        clearly reads at a glance; the isMe gold ring only shows
                        when it is NOT your turn, so it never dims the turn glow) */}
                    <div className={`
                      rounded-full p-1 transition-all duration-300
                      ${isActiveTurn
                        ? 'bg-green-400/90 animate-pulse-turn shadow-lg shadow-green-400/60'
                        : isMe ? 'bg-poker-gold/30' : 'bg-transparent'}
                    `}>
                      <div className={`
                        w-9 h-9 sm:w-11 sm:h-11 rounded-full relative overflow-hidden
                        ${isMe
                          ? 'bg-gradient-to-br from-poker-gold to-yellow-600 shadow-md'
                          : player.isConnected
                            ? 'bg-gradient-to-br from-blue-500 to-blue-700 shadow-md'
                            : 'bg-gradient-to-br from-gray-500 to-gray-700'
                        }
                      `}>
                        {/* Profile silhouette avatar (transparent bg, so the
                            seat's color gradient shows through around it) */}
                        <img src="/profile-circle.svg" alt={`${player.userName} avatar`}
                          className="w-full h-full object-cover select-none pointer-events-none"
                          draggable={false} />

                        {/* Connected dot */}
                        {player.isConnected && (
                          <div className="absolute top-0 right-0 w-2 h-2 rounded-full bg-green-400 border border-gray-900" />
                        )}
                      </div>
                    </div>

                    {/* Name */}
                    <p className="text-[10px] sm:text-xs font-semibold text-white truncate max-w-[90px] sm:max-w-[110px] flex items-center justify-center gap-0.5">
                      {player.userName}
                      {/* ── BOTS ── badge on bot seats so humans can tell
                           who they're playing against */}
                      {player.isBot && <span className="text-[8px] font-bold text-cyan-400 bg-cyan-500/10 border border-cyan-500/30 rounded px-1 py-0.5">BOT</span>}
                      {/* ── /BOTS ── */}
                      {player.isHost && !isMe && <span className="text-yellow-400 text-[10px]">★</span>}
                    </p>

                    {/* Stack */}
                    <p className="text-[10px] sm:text-[11px] text-gray-400 font-mono">
                      ${player.stack?.toLocaleString() || 0}
                    </p>

                    {/* Other players' hole cards (only at showdown) */}
                    {!isMe && (gameState === 'SHOWDOWN' || gameState === 'HAND_COMPLETE') && player.showHoleCards && player.holeCards && player.holeCards.length > 0 && (
                      <div className="flex justify-center gap-0.5 mt-0.5">
                        {player.holeCards.map((card, i) => (
                          <Card key={i} card={card} faceDown={false} size="sm" dealDelay={i} />
                        ))}
                      </div>
                    )}
                    {/* Mucked loser — cards stay face down, never exposed */}
                    {!isMe && (gameState === 'SHOWDOWN' || gameState === 'HAND_COMPLETE') && player.mucked && (
                      <div className="mt-0.5 px-1.5 py-0.5 bg-gray-700/60 text-gray-300 text-[8px] sm:text-[9px] rounded-full font-semibold">
                        Mucked
                      </div>
                    )}

                    {/* Status badges */}
                    <div className="flex flex-wrap justify-center gap-0.5">
                      {player.isReady && gameState === 'WAITING' && (
                        <span className="px-1.5 py-0.5 bg-green-500/20 text-green-400 text-[8px] rounded-full">✓</span>
                      )}
                      {player.isFolded && (
                        <span className="px-1.5 py-0.5 bg-gray-500/30 text-gray-400 text-[8px] rounded-full">Folded</span>
                      )}
                      {player.isAllIn && !player.isFolded && (
                        <span className="px-1.5 py-0.5 bg-yellow-500/20 text-yellow-400 text-[8px] rounded-full animate-pulse">All-In</span>
                      )}
                      {player.isSittingOut && (
                        <span className="px-1.5 py-0.5 bg-gray-500/30 text-gray-400 text-[8px] rounded-full">Out</span>
                      )}
                      {!player.isConnected && (
                        <span className="px-1.5 py-0.5 bg-yellow-500/20 text-yellow-400 text-[8px] rounded-full">Away</span>
                      )}
                    </div>
                  </div>
                </div>
              </React.Fragment>
            );
            })}              {/* ── Flying bet chips (seat → pot / winner) ── */}
            {chipFlights.map(f => (
              <div key={f.key}
                className="absolute z-30 pointer-events-none animate-chip-fly"
                style={{
                  // Inline start position so the chip degrades gracefully
                  // (no stray top-left flash) if animations are disabled.
                  top: `${f.fromTop}%`,
                  left: `${f.fromLeft}%`,
                  transform: 'translate(-50%, -50%)',
                  '--fly-from-top': `${f.fromTop}%`,
                  '--fly-from-left': `${f.fromLeft}%`,
                  '--fly-mid-top': `${f.midTop}%`,
                  '--fly-mid-left': `${f.midLeft}%`,
                  '--fly-to-top': `${f.toTop}%`,
                  '--fly-to-left': `${f.toLeft}%`,
                }}
              >
                <div className={`poker-chip text-white font-bold tabular-nums rounded-full
                                flex items-center justify-center whitespace-nowrap
                                border border-white/40 border-solid shadow-lg
                                ${f.label
                                  ? 'h-5 sm:h-6 min-w-5 sm:min-w-6 px-1 text-[8px] sm:text-[9px]'
                                  : 'w-5 h-5 sm:w-6 sm:h-6 text-[9px] sm:text-[10px]'}`}
                  style={{ textShadow: '0 1px 2px rgba(0,0,0,0.45)' }}
                >
                  {f.label || '$'}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── BOTTOM ROW: Your Hole Cards + Pot Info + Controls ──
            NEVER shrinks or scrolls: the action buttons are always fully
            visible. When space is tight the table row above absorbs the
            squeeze (its felt flattens via max-h-full) instead. */}
        <div className="shrink-0 bg-gray-900/95 backdrop-blur-sm border-t border-gray-800 px-1.5 sm:px-4 py-1 sm:py-3 landscape-controls">
          <div className="max-w-4xl mx-auto flex flex-col gap-0.5 sm:gap-1.5">

            {/* Last Action Bar */}
            {lastAction && gameState !== 'WAITING' && (
              <div className="text-center animate-fade-in last-action-bar">
                <span className="text-[9px] sm:text-xs text-gray-400">
                  <span className="font-medium text-white">{lastAction.userName}</span>{' '}
                  {lastAction.action === 'fold'  && <span className="text-red-400 font-medium">folded</span>}
                  {lastAction.action === 'check' && <span className="text-yellow-400 font-medium">checked</span>}
                  {lastAction.action === 'call'  && <span className="text-blue-400 font-medium">called <span className="text-white">${lastAction.amount}</span></span>}
                  {lastAction.action === 'raise' && <span className="text-purple-400 font-medium">raised to <span className="text-white">${lastAction.amount}</span></span>}
                  {lastAction.action === 'bet'   && <span className="text-purple-400 font-medium">bet <span className="text-white">${lastAction.amount}</span></span>}
                </span>
              </div>
            )}

            {/* ── Your Hole Cards (BIG — separate from seat) ── */}
            {gameState !== 'WAITING' && holeCards && holeCards.length > 0 && (
              <div className="flex items-center justify-center gap-1.5 sm:gap-3 py-0.5 sm:py-1 landscape-hole-cards">
                {holeCards.map((card, i) => (
                  <Card key={i} card={card} faceDown={false} size={isMobile ? 'lg' : 'xl'} dealDelay={i} />
                ))}
                {myPlayerData && (
                  <div className="flex items-center gap-1.5 sm:gap-3 ml-1 sm:ml-3 text-[10px] sm:text-sm">
                    <span className="text-gray-400 hidden sm:inline">Stack:</span>
                    <span className="text-poker-gold font-bold font-mono">${myPlayerData.stack?.toLocaleString() || 0}</span>
                  </div>
                )}
                {displayTimer > 0 && isMyTurn && (
                  <div className={`flex items-center gap-1 px-1.5 sm:px-3 py-0.5 sm:py-1 rounded-full text-[10px] sm:text-sm font-bold ${
                    displayTimer <= 5 ? 'bg-red-900/70 text-red-300 animate-pulse' : 'bg-gray-800 text-gray-200'
                  }`}>
                    <svg className="w-2.5 h-2.5 sm:w-3.5 sm:h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    {displayTimer}s
                  </div>
                )}
              </div>
            )}

            {/* ── Controls Row ── */}
            <div className="flex flex-wrap items-center justify-center gap-1.5 sm:gap-2">

              {/* ===================== BUSTED / REBUY ===================== */}
              {/* Show rebuy whenever the player is truly busted (stack=0 AND
                  not all-in in a live hand). A player who is merely all-in
                  (e.g. posted a blind that emptied their stack) is still IN
                  the hand — offering a Rebuy mid-hand would make the game
                  look like it never registered the all-in. After the hand
                  resolves (HAND_COMPLETE) an all-in loser's stack stays 0 and
                  the Rebuy button appears. */}
              {!isAllInMidHand && (myPlayerData?.stack === 0 || myPlayerData?.stack === undefined) && (
                <>
                  <button onClick={handleRebuy}
                    className="px-4 py-2 bg-gradient-to-r from-poker-gold to-yellow-500 text-black font-bold rounded-xl
                               hover:from-yellow-400 hover:to-yellow-300 transition-all duration-200 active:scale-95
                               shadow-lg shadow-yellow-600/20 text-xs">
                    Rebuy (${clubData?.minBuyin || 50} chips)
                  </button>
                  <button onClick={handleSitOutToggle}
                    className={`px-4 py-2 rounded-xl font-semibold text-xs transition-all duration-200 active:scale-95 ${
                      myPlayerData?.isSittingOut
                        ? 'bg-green-600 text-white'
                        : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                    }`}>
                    {myPlayerData?.isSittingOut ? 'Sit Back In' : 'Sit Out'}
                  </button>
                </>
              )}

              {/* ===================== WAITING STATE ===================== */}
              {gameState === 'WAITING' && (myPlayerData?.stack > 0) && (
                <>
                  {/* Normal ready */}
                  <button onClick={handleReadyToggle}
                    className={`px-4 py-2 rounded-xl font-semibold text-xs transition-all duration-200 active:scale-95 ${
                      players[mySeatIndex]?.isReady
                        ? 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                        : 'bg-gradient-to-r from-green-600 to-green-500 text-white shadow-lg shadow-green-600/20'
                    }`}>
                    {players[mySeatIndex]?.isReady ? 'Not Ready' : 'Ready'}
                  </button>
                  <button onClick={handleSitOutToggle}
                    className="px-4 py-2 bg-gray-700 text-gray-300 hover:bg-gray-600 rounded-xl font-semibold text-xs transition-all active:scale-95">
                    {myPlayerData?.isSittingOut ? 'Back In' : 'Sit Out'}
                  </button>

                  {isHost && (
                    <button onClick={handleStartGame} disabled={connectedPlayers.length < 2}
                      className="btn-primary px-4 py-2 text-xs">
                      Start Game
                    </button>
                  )}

                  {/* ── BOTS ── Host controls: fill empty seats with bots so
                       a solo player can practice. Hidden entirely when the
                       server has bots disabled. */}
                  {isHost && botsEnabled && (
                    <>
                      <button onClick={handleAddBots} disabled={connectedPlayers.length >= 6}
                        className="px-4 py-2 bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-white rounded-xl font-semibold text-xs transition-all active:scale-95 border border-gray-600 disabled:opacity-40">
                        + Add Bots
                      </button>
                      {connectedPlayers.some(p => p && p.isBot) && (
                        <button onClick={handleRemoveBots}
                          className="px-4 py-2 bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-white rounded-xl font-semibold text-xs transition-all active:scale-95 border border-gray-600">
                          Remove Bots
                        </button>
                      )}
                    </>
                  )}
                  {/* ── /BOTS ── */}

                </>
              )}

              {/* ===================== SHOWDOWN REVEAL ===================== */}
              {gameState === 'SHOWDOWN' && showdown && showdown.active && (
                <div className="flex flex-col items-center gap-1">
                  {showdown.currentSeatIndex === mySeatIndex ? (
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] sm:text-xs text-gray-400">Your turn to reveal:</span>
                      <button onClick={() => handleShowdownDecision(true)}
                        className="bg-gradient-to-r from-emerald-600 to-emerald-500 text-white font-bold rounded-xl px-4 py-2 text-xs
                                   hover:from-emerald-500 hover:to-emerald-400 transition-all active:scale-95
                                   shadow-lg shadow-emerald-600/20">
                        Show Cards
                      </button>
                      {showdown.currentCanMuck ? (
                        <button onClick={() => handleShowdownDecision(false)}
                          title="Muck your hand — throw it away face down"
                          className="bg-gray-700 text-gray-300 font-bold rounded-xl px-4 py-2 text-xs
                                     hover:bg-gray-600 transition-all active:scale-95">
                          Muck
                        </button>
                      ) : (
                        /* Pot winners never get a muck option — their cards
                           must be shown. The winning hand always tables. */
                        <span className="text-[10px] sm:text-xs text-emerald-400/90 font-semibold">
                          Winning hand — must show
                        </span>
                      )}
                      {displayTimer > 0 && (
                        <span className="text-xs text-gray-500 font-mono">{displayTimer}s</span>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-xs text-gray-400">
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
                      <span>
                        Waiting for{' '}
                        <span className="font-medium text-white">
                          {showdown.queue[showdown.queuePos]?.userName || 'player'}
                        </span>{' '}
                        to reveal...
                      </span>
                      {displayTimer > 0 && <span className="text-gray-500 font-mono">{displayTimer}s</span>}
                    </div>
                  )}
                </div>
              )}

              {/* ===================== IN-GAME CONTROLS ===================== */}
              {gameState !== 'WAITING' && gameState !== 'SHOWDOWN' && gameState !== 'HAND_COMPLETE' && (
                <>
                  {/* ── Main action buttons — hidden while the board is
                       running out (no live opponent) or you are all-in/folded ── */}
                  {showMainActions && (
                  <div className="flex items-center gap-1.5 sm:gap-2">
                    <button onClick={() => handleAction('fold')} disabled={!canAct}
                      className="action-btn-fold px-4 py-2 text-xs">
                      Fold
                    </button>

                    {currentBet <= (myPlayerData?.roundBet || 0) ? (
                      <button onClick={() => handleAction('check')} disabled={!canAct}
                        className="action-btn-check px-4 py-2 text-xs">
                        Check
                      </button>
                    ) : (
                      <button onClick={() => handleAction('call')} disabled={!canAct}
                        className="action-btn-call px-4 py-2 text-xs">
                        Call ${(currentBet - (myPlayerData?.roundBet || 0)).toLocaleString()}
                      </button>
                    )}
                  </div>
                  )}

                  {/* ── Bet slider + presets (only with a live opponent) ── */}
                  {showBetting && (
                    <div className="flex items-center gap-1 sm:gap-2 flex-wrap justify-center bet-slider-container">
                      <div className="flex items-center gap-0.5 sm:gap-1">
                        <button onClick={() => handleAction(isRaiseContext ? 'raise' : 'bet', getBetPreset(0.5))}
                          className="preset-btn">½ Pot</button>
                        <button onClick={() => handleAction(isRaiseContext ? 'raise' : 'bet', getBetPreset(0.75))}
                          className="preset-btn">¾ Pot</button>
                        <button onClick={() => handleAction(isRaiseContext ? 'raise' : 'bet', getBetPreset(1))}
                          className="preset-btn">Pot</button>
                      </div>
                      <div className="flex items-center gap-1 sm:gap-2">
                        <input type="range" min={0} max={100} value={betSliderValue}
                          onChange={(e) => setBetSliderValue(parseInt(e.target.value))}
                          className="bet-slider w-20 sm:w-24 h-1.5" />
                        <span className="text-white font-mono text-xs font-bold min-w-[3rem] text-right">
                          ${sliderBet.toLocaleString()}
                        </span>
                      </div>
                      <button onClick={() => handleAction(isRaiseContext ? 'raise' : 'bet', sliderBet)}
                        className="btn-raise bg-gradient-to-r from-purple-600 to-purple-500 text-white font-bold rounded-xl px-4 py-2
                                   hover:from-purple-500 hover:to-purple-400 transition-all active:scale-95
                                   shadow-lg shadow-purple-600/20 text-xs">
                        {isRaiseContext ? 'Raise' : 'Bet'}
                      </button>
                      <button onClick={() => handleAction(isRaiseContext ? 'raise' : 'bet', maxBetValue)}
                        className="btn-allin bg-gradient-to-r from-orange-600 to-orange-500 text-white font-bold rounded-xl px-4 py-2
                                   hover:from-orange-500 hover:to-orange-400 transition-all active:scale-95
                                   shadow-lg shadow-orange-600/20 text-xs">
                        All-In ${maxBetValue.toLocaleString()}
                      </button>
                    </div>
                  )}

                  {/* ── "Not your turn" indicator ── */}
                  {!isMyTurn && (
                    <div className="flex items-center gap-2">
                      {displayTimer > 0 && (
                        <span className="text-xs text-gray-500 flex items-center gap-1">
                          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                          {displayTimer}s
                        </span>
                      )}
                      <span className="text-xs text-gray-500">
                        {currentPlayerSeatIndex >= 0
                          ? `Waiting for ${players[currentPlayerSeatIndex]?.userName || 'player'}...`
                          : ''}
                      </span>
                    </div>
                  )}
                </>
              )}

            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
