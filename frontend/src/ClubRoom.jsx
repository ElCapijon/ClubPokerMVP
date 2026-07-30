import React, { useEffect, useState, useCallback, useRef } from 'react';
import { getSocket } from './socket';
import { getToken } from './auth';

const API_BASE = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? '' : 'http://localhost:3000');

const MAX_SEATS = 6;

// Preset emojis for the chat tray
const PRESET_EMOJIS = ['😎', '🤡', '😱', '🔥', '💪', '🃏', '🍀', '😤'];

// Seat positions for the oval table layout (clockwise from bottom-center)
// Pushed up slightly to leave room for big hole cards + community cards below
const SEAT_POSITIONS = [
  // Ellipse-hugging layout for 4:3 racetrack oval.
  // The table is rounded-[50%] with center (50,50), rx≈44, ry≈42.
  // Each seat sits on the ellipse edge, hugging the rail.
  // Side seats (1,2,4,5) are at the widest part of the ellipse.
  { top: 91, left: 50 },  // Seat 0: Hero — bottom center, on curve
  { top: 68, left: 10 },  // Seat 1: Lower-left, hugging the rail
  { top: 32, left: 10 },  // Seat 2: Upper-left, hugging the rail
  { top: 8,  left: 50 },  // Seat 3: Top center, on curve
  { top: 32, left: 90 },  // Seat 4: Upper-right, hugging the rail
  { top: 68, left: 90 },  // Seat 5: Lower-right, hugging the rail
];

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

// ─── Emoji Bubble ────────────────────────────────────────────
function EmojiBubble({ emoji, userName }) {
  return (
    <div className="absolute z-50 animate-emoji-float pointer-events-none"
      style={{ bottom: '100%', left: '50%', transform: 'translateX(-50%)' }}
    >
      <div className="bg-black/60 backdrop-blur-sm rounded-full px-2 py-1 flex items-center gap-1 shadow-lg whitespace-nowrap">
        <span className="text-lg">{emoji}</span>
        <span className="text-[10px] text-white/70">{userName}</span>
      </div>
    </div>
  );
}

// ====================================================================
// MAIN COMPONENT
// ====================================================================
export default function ClubRoom({ clubData, displayName, onLeave, onLogout }) {
  const { gameId = clubData.clubId, tableName = 'Poker Table', userId, seatIndex: mySeatIndex, buyinAmount, initialPlayers } = clubData;
  const clubId = gameId;
  const [players, setPlayers] = useState(initialPlayers || Array(6).fill(null));
  const [gameState, setGameState] = useState(clubData.gameState || 'WAITING');
  const [isConnected, setIsConnected] = useState(true);
  const [showCashOut, setShowCashOut] = useState(false);
  const [cashingOut, setCashingOut] = useState(false);
  const [notifications, setNotifications] = useState([]);

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

  // Action state
  const [lastAction, setLastAction] = useState(null);
  const [actionTimeRemaining, setActionTimeRemaining] = useState(0);
  const [actionTimerTotal, setActionTimerTotal] = useState(20);

  // Emoji state
  const [emojiTrayOpen, setEmojiTrayOpen] = useState(false);
  const [floatingEmojis, setFloatingEmojis] = useState([]);

  // Bet slider
  const [betSliderValue, setBetSliderValue] = useState(0);



  const emojiTrayRef = useRef(null);
  const emojiIdCounter = useRef(0);

  // Reset bet slider on new hand
  useEffect(() => { setBetSliderValue(0); }, [handCount]);

  // Close emoji tray on outside click
  useEffect(() => {
    function handleClick(e) {
      if (emojiTrayRef.current && !emojiTrayRef.current.contains(e.target)) {
        setEmojiTrayOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // ─── Socket handlers ──────────────────────────────────────
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const onConnect = () => {
      setIsConnected(true);
      socket.emit('rejoin_ring_game', { gameId: clubId }, (err) => {
        if (err) addNotification('Failed to reconnect', 'error');
      });
    };

    const onDisconnect = () => {
      setIsConnected(false);
      addNotification('Connection lost. Reconnecting...', 'warning');
    };

    const onStateUpdate = (data) => {
      setPlayers(data.players || Array(6).fill(null));
      setGameState(data.gameState || 'WAITING');
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
        }
        setGameState(data.gameStatus);
      }

      if (data.players) {
        setPlayers(prev => {
          const updated = [...prev];
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
      setCommunityCards(data.communityCards || []);
      setPot(data.pot || 0);
      setCurrentBet(data.currentBet || 0);
      setMinRaise(data.minRaise || 20);
      setCurrentPlayerSeatIndex(data.currentPlayerSeatIndex ?? -1);
      setDealerSeatIndex(data.dealerSeatIndex ?? -1);
      setHandCount(data.handCount || 0);
      setHoleCards(data.holeCards || []);
      if (data.gameStatus) {
        setGameState(data.gameStatus);
      }

      if (data.players) {
        setPlayers(prev => {
          const updated = [...prev];
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
          return updated;
        });
      }
    };

    const onHandComplete = (data) => {
      setHandResult(data);
      setLastAction(null);

      if (data.handResult) {
        for (const pot of data.handResult) {
          for (const winner of pot.winners) {
            const winnerName = data.players?.find(p => p.seatIndex === winner.seatIndex)?.userName || 'Player';
            addNotification(`🏆 ${winnerName} wins $${winner.amountWon}!`, 'success');
          }
        }
      }

      if (data.players) {
        setPlayers(prev => {
          const updated = [...prev];
          for (const p of data.players) {
            updated[p.seatIndex] = {
              ...updated[p.seatIndex],
              stack: p.stack,
              showHoleCards: true,
              holeCards: p.holeCards,
            };
          }
          return updated;
        });
      }
    };

    const onLastAction = (data) => {
      setLastAction(data);
    };

    const onEmojiReceived = (data) => {
      const id = ++emojiIdCounter.current;
      setFloatingEmojis(prev => [...prev, { ...data, id }]);
      setTimeout(() => setFloatingEmojis(prev => prev.filter(e => e.id !== id)), 2500);
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
    socket.on('emoji_received', onEmojiReceived);
    socket.on('connect_error', onConnectError);

    if (socket.connected) {
      // Request full state update on reconnection to this room
      setTimeout(() => socket.emit('rejoin_ring_game', { gameId: clubId }), 100);
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
      socket.off('emoji_received', onEmojiReceived);
      socket.off('connect_error', onConnectError);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clubId, userId]);

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

  const handleAction = useCallback((action, amount) => {
    getSocket().emit('player_action', { gameId: clubId, action, amount }, (err) => {
      if (err) addNotification(err.error || 'Action failed', 'error');
    });
  }, [clubId, addNotification]);

  const handleSendEmoji = useCallback((emoji) => {
    getSocket().emit('send_emoji', { gameId: clubId, emoji });
    setEmojiTrayOpen(false);
  }, [clubId]);

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
      addNotification(`💰 Cashed out ${data.cashOutAmount} chips!`, 'success');
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
  const connectedPlayers = players.filter(p => p !== null);
  const isHost = players[mySeatIndex]?.isHost;
  const canAct = isMyTurn && !isMeFolded && !isMeAllIn;

  // ─── Timer countdown ──────────────────────────────────────
  const [displayTimer, setDisplayTimer] = useState(0);
  useEffect(() => {
    if (gameState === 'WAITING' || gameState === 'SHOWDOWN' || gameState === 'HAND_COMPLETE') {
      setDisplayTimer(0);
      return;
    }
    setDisplayTimer(actionTimeRemaining);
    const interval = setInterval(() => setDisplayTimer(prev => Math.max(0, prev - 1)), 1000);
    return () => clearInterval(interval);
  }, [actionTimeRemaining, gameState, handCount]);

  // ─── Bet sizing ───────────────────────────────────────────
  const potSize = pot || 0;
  const currentPlayerBet = myPlayerData?.betAmount || 0;
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
    <div className="min-h-screen bg-gradient-to-b from-gray-950 via-gray-900 to-gray-950 flex flex-col overflow-hidden select-none">

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
                <span className="text-2xl">💰</span>
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
            <h3 className="text-base sm:text-lg font-bold text-poker-gold mb-3">🃏 Hand Complete</h3>
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
            </div>
          </div>
        </div>
      )}

      {/* ── Header Bar ── */}
      <header className="bg-gray-900/80 backdrop-blur-sm border-b border-gray-800 px-3 sm:px-4 py-2 sm:py-3 flex items-center justify-between shrink-0">
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
              💰 Cash Out
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
          ============================================================== */}
      <div className="flex-1 flex flex-col min-h-0">

        {/* ── TOP ROW: Table + Players ── */}
        <div className="flex-1 flex items-center justify-center p-1 sm:p-2 min-h-0">
          <div className="relative w-full max-h-full" style={{ maxWidth: '800px', aspectRatio: '4/3' }}>

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

              {/* ── Community Cards (positioned in the lower half of the felt) ── */}
              <div className="flex items-center gap-2 sm:gap-3 mb-2 z-10">
                {[0, 1, 2, 3, 4].map(i => (
                  <Card key={i} card={communityCards[i]} faceDown={!communityCards[i]} size="lg" dealDelay={i} />
                ))}
              </div>

              {/* ── Pot ── */}
              {pot > 0 && (
                <div className="bg-black/50 rounded-full px-4 sm:px-6 py-1.5 sm:py-2 backdrop-blur-sm z-10 animate-chip-stack">
                  <span className="text-sm sm:text-base font-bold text-poker-gold flex items-center gap-2">
                    <span className="text-yellow-400/60 text-xs">💰</span>
                    Pot: ${pot.toLocaleString()}
                  </span>
                </div>
              )}

              {/* ── Game Status / Street ── */}
              {gameState !== 'WAITING' && gameState !== 'HAND_COMPLETE' && (
                <div className="mt-1.5 px-3 py-0.5 sm:py-1 bg-white/5 rounded-full text-[11px] sm:text-xs text-gray-400 z-10">
                  <span className={`inline-block w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full mr-1.5 ${phaseColor}`} />
                  {gameState}
                  {currentBet > 0 && <span className="ml-1.5 sm:ml-2">· Bet: ${currentBet}</span>}
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

              return (
                <div key={player.userId}
                  className="absolute -translate-x-1/2 -translate-y-1/2 transition-all duration-500"
                  style={{ top: `${pos.top}%`, left: `${pos.left}%` }}
                >
                  {/* Floating emojis */}
                  {floatingEmojis.filter(e => e.seatIndex === index).map(e => (
                    <EmojiBubble key={e.id} emoji={e.emoji} userName={e.userName} />
                  ))}

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

                    {/* Avatar ring — pulsing green if active turn */}
                    <div className={`
                      rounded-full p-0.5 transition-all duration-300
                      ${isActiveTurn ? 'bg-green-400/40 animate-pulse-turn shadow-lg shadow-green-400/30' : 'bg-transparent'}
                      ${isMe     ? 'bg-poker-gold/30' : ''}
                    `}>
                      <div className={`
                        w-9 h-9 sm:w-11 sm:h-11 rounded-full flex items-center justify-center text-xs sm:text-sm font-bold relative
                        ${isMe
                          ? 'bg-gradient-to-br from-poker-gold to-yellow-600 text-black shadow-md'
                          : player.isConnected
                            ? 'bg-gradient-to-br from-blue-500 to-blue-700 text-white shadow-md'
                            : 'bg-gradient-to-br from-gray-500 to-gray-700 text-gray-300'
                        }
                      `}>
                        {player.userName?.charAt(0).toUpperCase() || '?'}

                        {/* Bet amount badge */}
                        {player.betAmount > 0 && (
                          <div className="absolute -bottom-0.5 -right-0.5 bg-poker-chip text-white text-[8px] font-bold
                                          rounded-full w-[18px] h-[18px] sm:w-5 sm:h-5 flex items-center justify-center
                                          border border-white/20 shadow-lg animate-chip-stack">
                            ${player.betAmount}
                          </div>
                        )}

                        {/* Connected dot */}
                        {player.isConnected && (
                          <div className="absolute top-0 right-0 w-2 h-2 rounded-full bg-green-400 border border-gray-900" />
                        )}
                      </div>
                    </div>

                    {/* Name */}
                    <p className="text-[10px] sm:text-xs font-semibold text-white truncate max-w-[90px] sm:max-w-[110px] flex items-center justify-center gap-0.5">
                      {player.userName}
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
              );
            })}
          </div>
        </div>

        {/* ── BOTTOM ROW: Your Hole Cards + Pot Info + Controls ── */}
        <div className="shrink-0 bg-gray-900/95 backdrop-blur-sm border-t border-gray-800 px-3 sm:px-4 py-2 sm:py-3">
          <div className="max-w-4xl mx-auto flex flex-col gap-1.5">

            {/* Last Action Bar */}
            {lastAction && gameState !== 'WAITING' && (
              <div className="text-center animate-fade-in">
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
              <div className="flex items-center justify-center gap-2 sm:gap-3 py-1">
                {holeCards.map((card, i) => (
                  <Card key={i} card={card} faceDown={false} size="xl" dealDelay={i} />
                ))}
                {myPlayerData && (
                  <div className="flex items-center gap-3 ml-2 sm:ml-3 text-xs sm:text-sm">
                    <span className="text-gray-400">Stack:</span>
                    <span className="text-poker-gold font-bold font-mono">${myPlayerData.stack?.toLocaleString() || 0}</span>
                  </div>
                )}
                {displayTimer > 0 && isMyTurn && (
                  <div className={`flex items-center gap-1 px-2 sm:px-3 py-1 rounded-full text-xs sm:text-sm font-bold ${
                    displayTimer <= 5 ? 'bg-red-900/70 text-red-300 animate-pulse' : 'bg-gray-800 text-gray-200'
                  }`}>
                    <svg className="w-3 h-3 sm:w-3.5 sm:h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    {displayTimer}s
                  </div>
                )}
              </div>
            )}

            {/* ── Controls Row ── */}
            <div className="flex flex-wrap items-center justify-center gap-1.5 sm:gap-2">

              {/* ===================== WAITING STATE ===================== */}
              {gameState === 'WAITING' && (
                <>
                  {/* Busted */}
                  {(myPlayerData?.stack === 0 || myPlayerData?.stack === undefined) && (
                    <>
                      <button onClick={handleRebuy}
                        className="px-4 py-2 bg-gradient-to-r from-poker-gold to-yellow-500 text-black font-bold rounded-xl
                                   hover:from-yellow-400 hover:to-yellow-300 transition-all duration-200 active:scale-95
                                   shadow-lg shadow-yellow-600/20 text-xs">
                        💰 Rebuy (${clubData?.minBuyin || 50} chips)
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

                  {/* Normal ready */}
                  {(myPlayerData?.stack > 0) && (
                    <>
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
                    </>
                  )}

                  {isHost && (
                    <>
                      <button onClick={handleStartGame} disabled={connectedPlayers.length < 2}
                        className="btn-primary px-4 py-2 text-xs">
                        Start Game
                      </button>
                    </>
                  )}
                </>
              )}

              {/* ===================== IN-GAME CONTROLS ===================== */}
              {gameState !== 'WAITING' && gameState !== 'SHOWDOWN' && gameState !== 'HAND_COMPLETE' && (
                <>
                  {/* ── Main action buttons ── */}
                  <div className="flex items-center gap-1.5 sm:gap-2">
                    <button onClick={() => handleAction('fold')} disabled={!canAct}
                      className="action-btn-fold px-4 py-2 text-xs">
                      Fold
                    </button>

                    {currentBet <= (myPlayerData?.betAmount || 0) ? (
                      <button onClick={() => handleAction('check')} disabled={!canAct}
                        className="action-btn-check px-4 py-2 text-xs">
                        Check
                      </button>
                    ) : (
                      <button onClick={() => handleAction('call')} disabled={!canAct}
                        className="action-btn-call px-4 py-2 text-xs">
                        Call ${(currentBet - (myPlayerData?.betAmount || 0)).toLocaleString()}
                      </button>
                    )}
                  </div>

                  {/* ── Bet slider + presets ── */}
                  {canAct && myStack > 0 && (
                    <div className="flex items-center gap-1 sm:gap-2 flex-wrap justify-center">
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
                        className="bg-gradient-to-r from-purple-600 to-purple-500 text-white font-bold rounded-xl px-4 py-2
                                   hover:from-purple-500 hover:to-purple-400 transition-all active:scale-95
                                   shadow-lg shadow-purple-600/20 text-xs">
                        {isRaiseContext ? 'Raise' : 'Bet'}
                      </button>
                      <button onClick={() => handleAction(isRaiseContext ? 'raise' : 'bet', maxBetValue)}
                        className="bg-gradient-to-r from-orange-600 to-orange-500 text-white font-bold rounded-xl px-4 py-2
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

              {/* ── Emoji + Share (always available) ── */}
              <div className="flex items-center gap-1 sm:gap-1.5">
                <div className="relative" ref={emojiTrayRef}>
                  <button onClick={() => setEmojiTrayOpen(!emojiTrayOpen)}
                    className="px-3 py-2 rounded-xl text-xs transition-all bg-gray-800 text-gray-300 hover:bg-gray-700 active:scale-95">
                    😊
                  </button>
                  {emojiTrayOpen && (
                    <div className="absolute bottom-full left-0 mb-2 bg-gray-800 rounded-xl border border-gray-700 shadow-2xl p-2 animate-slide-up z-50">
                      <div className="flex gap-1.5">
                        {PRESET_EMOJIS.map((emoji, i) => (
                          <button key={i} onClick={() => handleSendEmoji(emoji)}
                            className="w-7 h-7 sm:w-8 sm:h-8 flex items-center justify-center text-base sm:text-lg rounded-lg hover:bg-gray-700 transition-colors active:scale-90">
                            {emoji}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                <button onClick={() => handleSendEmoji('🃏')}
                  className="px-3 py-2 rounded-xl text-xs font-medium transition-all bg-gray-800 text-gray-300 hover:bg-gray-700">
                  🀄
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
