import React, { useEffect, useState, useCallback, useRef } from 'react';
import { getSocket } from './socket';

const MAX_SEATS = 6;

// Preset emojis for the chat tray
const PRESET_EMOJIS = ['😎', '🤡', '😱', '🔥', '💪', '🃏', '🍀', '😤'];

// Seat positions for the oval table layout (clockwise from bottom-center)
const SEAT_POSITIONS = [
  { top: 82, left: 50, translateY: 0, label: 'bottom' },      // You (bottom center)
  { top: 72, left: 10, translateY: 0, label: 'bottom-left' }, // Bottom left
  { top: 30, left: 8,  translateY: 0, label: 'top-left' },    // Top left
  { top: 12, left: 50, translateY: 0, label: 'top' },         // Top center
  { top: 30, left: 92, translateY: 0, label: 'top-right' },   // Top right
  { top: 72, left: 90, translateY: 0, label: 'bottom-right' },// Bottom right
];

function Card({ card, faceDown, small, dealDelay, dealFrom }) {
  const [dealt, setDealt] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDealt(true), (dealDelay || 0) * 100);
    return () => clearTimeout(timer);
  }, [dealDelay]);

  if (faceDown || !card) {
    return (
      <div
        className={`card-back ${small ? 'w-7 h-10 sm:w-8 sm:h-12' : 'w-10 h-14 sm:w-12 sm:h-16'} rounded-lg shadow-lg transition-all duration-300 ${
          dealt ? 'opacity-100 scale-100' : 'opacity-0 scale-50'
        }`}
        style={{
          animation: dealt ? 'none' : undefined,
          transitionDelay: `${(dealDelay || 0) * 100}ms`,
        }}
      >
        <div className="w-full h-full flex items-center justify-center">
          <span className="text-[8px] sm:text-[10px] text-white/30 font-bold">♠</span>
        </div>
      </div>
    );
  }

  const isRed = card.suit === 'hearts' || card.suit === 'diamonds';
  const suitSymbol = card.suitSymbol;

  return (
    <div
      className={`card-front ${small ? 'w-7 h-10 sm:w-8 sm:h-12' : 'w-10 h-14 sm:w-12 sm:h-16'} rounded-lg shadow-lg border border-gray-200 flex flex-col items-center justify-center relative overflow-hidden ${
        dealt ? 'animate-card-dealt' : 'opacity-0 scale-50'
      }`}
      style={{
        animationDelay: `${(dealDelay || 0) * 100}ms`,
        transitionDelay: `${(dealDelay || 0) * 100}ms`,
      }}
    >
      <div className={`absolute top-0.5 left-1 flex flex-col items-center ${small ? 'scale-[0.6] origin-top-left' : ''}`}>
        <span className={`text-[10px] sm:text-xs leading-none font-bold ${isRed ? 'text-red-600' : 'text-gray-900'}`}>
          {card.rankName}
        </span>
        <span className={`text-[8px] sm:text-[10px] leading-none ${isRed ? 'text-red-600' : 'text-gray-900'}`}>
          {suitSymbol}
        </span>
      </div>
      <span className={`text-sm sm:text-lg ${isRed ? 'text-red-600' : 'text-gray-900'}`}>
        {suitSymbol}
      </span>
      <div className={`absolute bottom-0.5 right-1 flex flex-col items-center ${small ? 'scale-[0.6] origin-bottom-right' : ''}`}>
        <span className={`text-[8px] sm:text-[10px] leading-none ${isRed ? 'text-red-600' : 'text-gray-900'}`}>
          {suitSymbol}
        </span>
        <span className={`text-[10px] sm:text-xs leading-none font-bold ${isRed ? 'text-red-600' : 'text-gray-900'}`}>
          {card.rankName}
        </span>
      </div>
    </div>
  );
}

function EmojiBubble({ emoji, userName, index }) {
  return (
    <div
      className="absolute z-50 animate-emoji-float pointer-events-none"
      style={{
        bottom: '100%',
        left: '50%',
        transform: 'translateX(-50%)',
        animationDelay: '0s',
        animationDuration: '2s',
      }}
    >
      <div className="bg-black/60 backdrop-blur-sm rounded-full px-2 py-1 flex items-center gap-1 shadow-lg">
        <span className="text-lg">{emoji}</span>
        <span className="text-[10px] text-white/70">{userName}</span>
      </div>
    </div>
  );
}

export default function ClubRoom({ clubData, displayName, onLeave }) {
  const { clubId, inviteCode, userId, seatIndex: mySeatIndex } = clubData;
  const [players, setPlayers] = useState(Array(6).fill(null));
  const [gameState, setGameState] = useState('WAITING');
  const [isConnected, setIsConnected] = useState(true);
  const [copiedInvite, setCopiedInvite] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
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

  // Reset bet slider on new hand
  useEffect(() => {
    setBetSliderValue(0);
  }, [handCount]);

  // Refs
  const emojiTrayRef = useRef(null);
  const emojiIdCounter = useRef(0);

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

  useEffect(() => {
    const socket = getSocket();

    const onConnect = () => {
      setIsConnected(true);
      socket.emit('rejoin_club', { clubId, userId }, (err) => {
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
      setCurrentPlayerSeatIndex(data.currentPlayerSeatIndex || -1);
      setDealerSeatIndex(data.dealerSeatIndex || -1);
      setHandCount(data.handCount || 0);
      setActionTimeRemaining(data.actionTimeRemaining || 0);
      setActionTimerTotal(data.actionTimerTotal || 20);

      // Update players from game state
      if (data.players) {
        setPlayers(prev => {
          const updated = [...prev];
          for (const p of data.players) {
            updated[p.seatIndex] = {
              ...updated[p.seatIndex],
              ...p,
              isPlaying: true,
            };
          }
          return updated;
        });
      }
    };

    const onYourHoleCards = (data) => {
      setHoleCards(data.holeCards || []);
    };

    const onFullStateSnapshot = (data) => {
      setCommunityCards(data.communityCards || []);
      setPot(data.pot || 0);
      setCurrentBet(data.currentBet || 0);
      setMinRaise(data.minRaise || 20);
      setCurrentPlayerSeatIndex(data.currentPlayerSeatIndex || -1);
      setDealerSeatIndex(data.dealerSeatIndex || -1);
      setHandCount(data.handCount || 0);
      setHoleCards(data.holeCards || []);
      
      if (data.players) {
        setPlayers(prev => {
          const updated = [...prev];
          for (const p of data.players) {
            updated[p.seatIndex] = {
              ...updated[p.seatIndex],
              ...p,
              isPlaying: true,
            };
          }
          return updated;
        });
      }
    };

    const onHandComplete = (data) => {
      setHandResult(data);
      setLastAction(null);
      
      // Show winner notification
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

      setTimeout(() => {
        setHandResult(null);
      }, 5000);
    };

    const onLastAction = (data) => {
      setLastAction(data);
    };

    const onEmojiReceived = (data) => {
      const id = ++emojiIdCounter.current;
      setFloatingEmojis(prev => [...prev, { ...data, id }]);
      setTimeout(() => {
        setFloatingEmojis(prev => prev.filter(e => e.id !== id));
      }, 2500);
    };

    const onConnectError = () => {
      setIsConnected(false);
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('club_state_update', onStateUpdate);
    socket.on('game_state_sync', onGameStateSync);
    socket.on('your_hole_cards', onYourHoleCards);
    socket.on('full_state_snapshot', onFullStateSnapshot);
    socket.on('hand_complete', onHandComplete);
    socket.on('last_action', onLastAction);
    socket.on('emoji_received', onEmojiReceived);
    socket.on('connect_error', onConnectError);

    if (socket.connected) {
      onConnect();
    } else {
      socket.connect();
    }

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('club_state_update', onStateUpdate);
      socket.off('game_state_sync', onGameStateSync);
      socket.off('your_hole_cards', onYourHoleCards);
      socket.off('full_state_snapshot', onFullStateSnapshot);
      socket.off('hand_complete', onHandComplete);
      socket.off('last_action', onLastAction);
      socket.off('emoji_received', onEmojiReceived);
      socket.off('connect_error', onConnectError);
    };
  }, [clubId, userId]);

  const addNotification = useCallback((message, type = 'info') => {
    const id = Date.now();
    setNotifications(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setNotifications(prev => prev.filter(n => n.id !== id));
    }, 4000);
  }, []);

  const handleCopyInvite = useCallback(() => {
    navigator.clipboard.writeText(inviteCode).then(() => {
      setCopiedInvite(true);
      setTimeout(() => setCopiedInvite(false), 2000);
    });
  }, [inviteCode]);

  const handleCopyShareLink = useCallback(() => {
    const shareText = `♠️ Join my Poker Club! Code: ${inviteCode} — ${window.location.origin}`;
    navigator.clipboard.writeText(shareText).then(() => {
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    });
  }, [inviteCode]);

  const handleReadyToggle = useCallback(() => {
    getSocket().emit('player_ready', { clubId });
  }, [clubId]);

  const handleStartGame = useCallback(() => {
    getSocket().emit('start_game', { clubId }, (err) => {
      if (err) addNotification(err.error || 'Failed to start game', 'error');
    });
  }, [clubId, addNotification]);

  const handleAction = useCallback((action, amount) => {
    getSocket().emit('player_action', { clubId, action, amount }, (err) => {
      if (err) addNotification(err.error || 'Action failed', 'error');
    });
  }, [clubId, addNotification]);

  const handleSendEmoji = useCallback((emoji) => {
    getSocket().emit('send_emoji', { clubId, emoji });
    setEmojiTrayOpen(false);
  }, [clubId]);

  const handleRebuy = useCallback(() => {
    getSocket().emit('player_rebuy', { clubId }, (err) => {
      if (err) addNotification(err.error || 'Rebuy failed', 'error');
      else addNotification('Rebought! Back in the game.', 'success');
    });
  }, [clubId, addNotification]);

  const handleSitOutToggle = useCallback(() => {
    getSocket().emit('player_sit_out', { clubId }, (err) => {
      if (err) addNotification(err.error || 'Failed', 'error');
    });
  }, [clubId, addNotification]);

  const isMyTurn = currentPlayerSeatIndex === mySeatIndex && gameState !== 'WAITING' && gameState !== 'SHOWDOWN' && gameState !== 'HAND_COMPLETE';
  const myPlayerData = players[mySeatIndex];
  const isMeFolded = myPlayerData?.isFolded;
  const isMeAllIn = myPlayerData?.isAllIn;
  const connectedPlayers = players.filter(p => p !== null);
  const isHost = players[mySeatIndex]?.isHost;

  const canAct = isMyTurn && !isMeFolded && !isMeAllIn;

  // Countdown timer effect
  const [displayTimer, setDisplayTimer] = useState(0);
  useEffect(() => {
    if (gameState === 'WAITING' || gameState === 'SHOWDOWN' || gameState === 'HAND_COMPLETE') {
      setDisplayTimer(0);
      return;
    }
    
    setDisplayTimer(actionTimeRemaining);
    
    const interval = setInterval(() => {
      setDisplayTimer(prev => Math.max(0, prev - 1));
    }, 1000);
    
    return () => clearInterval(interval);
  }, [actionTimeRemaining, gameState, handCount]);

  // Bet sizing
  const potSize = pot || 0;
  const currentPlayerBet = myPlayerData?.betAmount || 0;
  const myStack = myPlayerData?.stack || 0;
  
  // Min and max bet values
  const minBetValue = currentBet > 0 
    ? Math.min(currentBet + minRaise, myStack + currentPlayerBet)
    : minRaise;
  const maxBetValue = myStack + currentPlayerBet;

  // Get bet preset amount
  const getBetPreset = (fraction) => {
    if (currentBet > 0) {
      const raiseTo = Math.min(
        Math.floor(potSize * fraction) + currentBet,
        maxBetValue
      );
      return Math.max(raiseTo, minBetValue);
    } else {
      return Math.min(Math.floor(potSize * fraction) || minRaise, myStack);
    }
  };

  // Calculate bet amount for slider
  const getSliderBet = (value) => {
    const ratio = value / 100;
    return Math.round(minBetValue + (maxBetValue - minBetValue) * ratio);
  };
  const sliderBet = getSliderBet(betSliderValue);

  // Determine action mode based on currentBet
  const isRaiseContext = currentBet > 0;

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-950 via-gray-900 to-gray-950 flex flex-col overflow-hidden">
      {/* Connection Status Banner */}
      {!isConnected && (
        <div className="bg-red-900/60 backdrop-blur-sm px-4 py-2 text-center text-sm text-red-200 animate-slide-down">
          <span className="inline-block w-2 h-2 bg-red-400 rounded-full animate-pulse mr-2" />
          Connection lost. Attempting to reconnect...
        </div>
      )}

      {/* Notifications */}
      {notifications.length > 0 && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 w-full max-w-sm space-y-2 px-4 pointer-events-none">
          {notifications.map(n => (
            <div
              key={n.id}
              className={`px-4 py-3 rounded-xl shadow-lg text-sm font-medium animate-slide-up backdrop-blur-sm pointer-events-auto ${
                n.type === 'error' ? 'bg-red-900/90 text-red-200' :
                n.type === 'warning' ? 'bg-yellow-900/90 text-yellow-200' :
                n.type === 'success' ? 'bg-green-900/90 text-green-200' :
                'bg-gray-800/90 text-white'
              }`}
            >
              {n.message}
            </div>
          ))}
        </div>
      )}

      {/* Hand Result Overlay */}
      {handResult && handResult.handResult && (
        <div className="fixed inset-0 z-40 pointer-events-none flex items-center justify-center" style={{ animation: 'fadeIn 0.3s ease-out' }}>
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

      {/* Header Bar */}
      <header className="bg-gray-900/80 backdrop-blur-sm border-b border-gray-800 px-3 sm:px-4 py-2 sm:py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <button
            onClick={onLeave}
            className="text-gray-400 hover:text-white transition-colors p-1.5 -ml-1.5 shrink-0"
            title="Leave Club"
          >
            <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
          </button>
          <div className="min-w-0">
            <h2 className="text-xs sm:text-sm font-semibold text-white truncate">Poker Club</h2>
            <p className="text-[10px] sm:text-xs text-gray-500 truncate">
              {connectedPlayers.length}/{MAX_SEATS} players
              {handCount > 0 && <span className="ml-1 sm:ml-2">· Hand #{handCount}</span>}
            </p>
          </div>
        </div>

        {/* Invite Code */}
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          <div className="bg-gray-800 rounded-lg px-2 sm:px-3 py-1 sm:py-1.5 flex items-center gap-1.5">
            <span className="text-[10px] sm:text-xs text-gray-400 hidden sm:inline">Code:</span>
            <span className="text-sm sm:text-lg font-mono font-bold text-poker-gold tracking-wider">
              {inviteCode}
            </span>
            <button
              onClick={handleCopyInvite}
              className={`p-1 rounded transition-colors ${
                copiedInvite ? 'text-green-400' : 'text-gray-500 hover:text-white'
              }`}
              title="Copy code"
            >
              {copiedInvite ? (
                <svg className="w-3.5 h-3.5 sm:w-4 sm:h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                <svg className="w-3.5 h-3.5 sm:w-4 sm:h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </header>

      {/* Main Table Area */}
      <div className="flex-1 flex items-center justify-center p-2 sm:p-4 min-h-0">
        <div className="relative w-full max-w-3xl lg:max-w-4xl aspect-[4/3]">
          {/* The Felt Table */}
          <div className="felt-table w-full h-full flex flex-col items-center justify-center relative overflow-hidden">
            {/* Decorative felt pattern overlay */}
            <div className="absolute inset-0 opacity-[0.03] pointer-events-none"
              style={{
                backgroundImage: `radial-gradient(circle at 20% 50%, transparent 0%, transparent 2%, rgba(255,255,255,0.1) 2%, transparent 3%),
                                radial-gradient(circle at 80% 30%, transparent 0%, transparent 2%, rgba(255,255,255,0.1) 2%, transparent 3%)`,
                backgroundSize: '60px 60px',
              }}
            />

            {/* Community Cards */}
            <div className="flex items-center gap-1.5 sm:gap-2 mb-2 sm:mb-3 relative z-10">
              {[0, 1, 2, 3, 4].map(i => (
                <Card
                  key={i}
                  card={communityCards[i]}
                  faceDown={!communityCards[i]}
                  dealDelay={i}
                />
              ))}
            </div>

            {/* Pot */}
            {pot > 0 && (
              <div className="bg-black/40 rounded-full px-3 sm:px-5 py-1 sm:py-1.5 backdrop-blur-sm relative z-10 animate-chip-stack">
                <span className="text-xs sm:text-sm font-bold text-poker-gold flex items-center gap-1.5">
                  <span className="text-[10px] sm:text-xs text-yellow-400/60">💰</span>
                  Pot: ${pot.toLocaleString()}
                </span>
              </div>
            )}

            {/* Game Status */}
            {gameState !== 'WAITING' && gameState !== 'SHOWDOWN' && gameState !== 'HAND_COMPLETE' && (
              <div className="mt-1.5 sm:mt-2 px-2 sm:px-3 py-0.5 sm:py-1 bg-white/5 rounded-full text-[10px] sm:text-xs text-gray-400 relative z-10">
                {/* Street indicator with colored dot */}
                <span className={`inline-block w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full mr-1.5 ${
                  gameState === 'PREFLOP' ? 'bg-blue-400' :
                  gameState === 'FLOP' ? 'bg-green-400' :
                  gameState === 'TURN' ? 'bg-yellow-400' :
                  gameState === 'RIVER' ? 'bg-red-400' : 'bg-gray-400'
                }`} />
                {gameState}
                {currentBet > 0 && <span className="ml-1.5 sm:ml-2">· Bet: ${currentBet}</span>}
              </div>
            )}

            {/* Waiting state */}
            {gameState === 'WAITING' && (
              <div className="mt-1.5 sm:mt-2 text-[10px] sm:text-xs text-gray-500 animate-pulse relative z-10">
                Waiting for players...
              </div>
            )}
          </div>

          {/* Seats */}
          {players.map((player, index) => {
            const pos = SEAT_POSITIONS[index];
            if (!pos) return null;

            const isMe = index === mySeatIndex;

            if (!player) {
              return (
                <div
                  key={index}
                  className="absolute -translate-x-1/2 -translate-y-1/2 transition-all duration-500"
                  style={{ top: `${pos.top}%`, left: `${pos.left}%` }}
                >
                  <div className="seat-empty w-20 h-20 sm:w-24 sm:h-24 rounded-full flex items-center justify-center">
                    <span className="text-[10px] sm:text-xs opacity-50">Seat {index + 1}</span>
                  </div>
                </div>
              );
            }

            const isActiveTurn = index === currentPlayerSeatIndex;
            const isDealer = index === dealerSeatIndex;

            return (
              <div
                key={player.userId}
                className={`absolute -translate-x-1/2 -translate-y-1/2 transition-all duration-500 ${
                  isMe ? 'z-10' : 'z-0'
                }`}
                style={{ top: `${pos.top}%`, left: `${pos.left}%` }}
              >
                {/* Floating emojis */}
                {floatingEmojis
                  .filter(e => e.seatIndex === index)
                  .map(e => (
                    <EmojiBubble key={e.id} emoji={e.emoji} userName={e.userName} index={e.id} />
                  ))
                }

                <div className={`
                  seat-occupied w-24 sm:w-28 p-1.5 sm:p-2 text-center relative
                  ${isMe ? 'ring-2 ring-poker-gold/50 shadow-lg shadow-poker-gold/10' : ''}
                  ${!player.isConnected ? 'opacity-50' : ''}
                  ${isActiveTurn ? 'ring-2 ring-green-400/60 shadow-lg shadow-green-500/15 animate-pulse-turn' : ''}
                  ${player.isFolded ? 'opacity-40 grayscale' : ''}
                  transition-all duration-300
                `}>
                  {/* Dealer Button */}
                  {isDealer && (
                    <div className="absolute -top-1.5 -right-1.5 w-5 h-5 sm:w-6 sm:h-6 rounded-full bg-white text-black flex items-center justify-center text-[8px] sm:text-[10px] font-bold shadow-lg z-10 animate-bounce-subtle">
                      D
                    </div>
                  )}

                  {/* Avatar */}
                  <div className={`
                    w-8 h-8 sm:w-10 sm:h-10 mx-auto rounded-full flex items-center justify-center text-xs sm:text-sm font-bold relative transition-all duration-300
                    ${isMe
                      ? 'bg-gradient-to-br from-poker-gold to-yellow-600 text-black'
                      : player.isConnected
                        ? 'bg-gradient-to-br from-blue-500 to-blue-700 text-white'
                        : 'bg-gradient-to-br from-gray-500 to-gray-700 text-gray-300'
                    }
                  `}>
                    {player.userName?.charAt(0).toUpperCase() || '?'}

                    {/* Bet amount badge */}
                    {player.betAmount > 0 && (
                      <div className="absolute -bottom-1 -right-1 bg-poker-chip text-white text-[7px] sm:text-[8px] font-bold rounded-full w-4 h-4 sm:w-5 sm:h-5 flex items-center justify-center border border-white/20 animate-chip-stack shadow-lg">
                        ${player.betAmount}
                      </div>
                    )}

                    {/* Connected indicator */}
                    {player.isConnected && (
                      <div className="absolute top-0 right-0 w-2 h-2 sm:w-2.5 sm:h-2.5 rounded-full bg-green-400 border border-gray-900" />
                    )}
                  </div>

                  {/* Name */}
                  <p className="text-[10px] sm:text-xs font-semibold text-white mt-0.5 sm:mt-1 truncate flex items-center justify-center gap-0.5">
                    {player.userName}
                    {isMe && <span className="text-poker-gold"> (You)</span>}
                    {player.isHost && !isMe && <span className="text-yellow-400">★</span>}
                  </p>

                  {/* Stack */}
                  <p className="text-[9px] sm:text-[11px] text-gray-400 font-mono">
                    ${player.stack?.toLocaleString() || 0}
                  </p>

                  {/* Hole Cards (show during hand complete or for yourself) */}
                  {(player.showHoleCards || isMe) && player.holeCards && player.holeCards.length > 0 && (
                    <div className="flex justify-center gap-0.5 mt-0.5">
                      {player.holeCards.map((card, i) => (
                        <Card key={i} card={card} faceDown={false} small dealDelay={i} />
                      ))}
                    </div>
                  )}

                  {/* Status badges */}
                  <div className="flex flex-wrap justify-center gap-0.5 mt-0.5">
                    {player.isReady && gameState === 'WAITING' && (
                      <span className="px-1.5 py-0.5 bg-green-500/20 text-green-400 text-[8px] sm:text-[9px] rounded-full">
                        Ready ✓
                      </span>
                    )}
                    {player.isFolded && (
                      <span className="px-1.5 py-0.5 bg-gray-500/30 text-gray-400 text-[8px] sm:text-[9px] rounded-full">
                        Folded
                      </span>
                    )}
                    {player.isAllIn && !player.isFolded && (
                      <span className="px-1.5 py-0.5 bg-yellow-500/20 text-yellow-400 text-[8px] sm:text-[9px] rounded-full animate-pulse">
                        All-In
                      </span>
                    )}
                    {player.isSittingOut && (
                      <span className="px-1.5 py-0.5 bg-gray-500/30 text-gray-400 text-[8px] sm:text-[9px] rounded-full">
                        Out
                      </span>
                    )}
                    {!player.isConnected && (
                      <span className="px-1.5 py-0.5 bg-yellow-500/20 text-yellow-400 text-[8px] sm:text-[9px] rounded-full">
                        Away
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Bottom Controls */}
      <div className="bg-gray-900/90 backdrop-blur-sm border-t border-gray-800 px-3 sm:px-4 py-2 sm:py-3 shrink-0 relative">
        <div className="max-w-4xl mx-auto">
          {/* Last Action Bar */}
          {lastAction && gameState !== 'WAITING' && (
            <div className="text-center mb-1.5 sm:mb-2 animate-fade-in">
              <span className="text-[10px] sm:text-xs text-gray-400">
                <span className="font-medium text-white">{lastAction.userName}</span>{' '}
                {lastAction.action === 'fold' && <span className="text-red-400 font-medium">folded</span>}
                {lastAction.action === 'check' && <span className="text-yellow-400 font-medium">checked</span>}
                {lastAction.action === 'call' && <span className="text-blue-400 font-medium">called <span className="text-white">${lastAction.amount}</span></span>}
                {lastAction.action === 'raise' && <span className="text-purple-400 font-medium">raised to <span className="text-white">${lastAction.amount}</span></span>}
                {lastAction.action === 'bet' && <span className="text-purple-400 font-medium">bet <span className="text-white">${lastAction.amount}</span></span>}
              </span>
            </div>
          )}

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2">
            {/* Left: Player info + Timer */}
            <div className="flex items-center gap-2 sm:gap-3">
              <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-full bg-gradient-to-br from-poker-gold to-yellow-600 flex items-center justify-center text-xs sm:text-sm font-bold text-black shrink-0">
                {displayName.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0">
                <p className="text-xs sm:text-sm font-semibold text-white truncate">{displayName}</p>
                <p className="text-[10px] sm:text-xs text-gray-400 truncate">
                  Seat {mySeatIndex + 1}
                  {myPlayerData && <span className="ml-1 sm:ml-2">Stack: <span className="text-poker-gold font-mono">${myPlayerData.stack?.toLocaleString() || 0}</span></span>}
                </p>
              </div>

              {/* Action Timer */}
              {displayTimer > 0 && isMyTurn && (
                <div className={`ml-1 sm:ml-2 flex items-center gap-1 px-2 sm:px-3 py-1 sm:py-1.5 rounded-full text-xs sm:text-sm font-bold ${
                  displayTimer <= 5 ? 'bg-red-900/70 text-red-300 animate-pulse' : 'bg-gray-800 text-gray-200'
                }`}>
                  <svg className="w-3 h-3 sm:w-3.5 sm:h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  {displayTimer}s
                </div>
              )}
            </div>

            {/* Right: Action controls */}
            <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
              {/* WAITING state controls */}
              {gameState === 'WAITING' && (
                <>
                  {/* Busted — Show Rebuy / Sit Out */}
                  {(myPlayerData?.stack === 0 || myPlayerData?.stack === undefined) && (
                    <>
                      <button
                        onClick={handleRebuy}
                        className="px-3 sm:px-4 py-1.5 sm:py-2 bg-gradient-to-r from-poker-gold to-yellow-500 text-black font-bold rounded-xl
                                 hover:from-yellow-400 hover:to-yellow-300 transition-all duration-200 active:scale-95
                                 shadow-lg shadow-yellow-600/20 text-[10px] sm:text-xs"
                      >
                        💰 Rebuy (${clubData?.startingStack || 1500})
                      </button>
                      <button
                        onClick={handleSitOutToggle}
                        className={`px-3 sm:px-4 py-1.5 sm:py-2 rounded-xl font-semibold text-[10px] sm:text-xs transition-all duration-200 active:scale-95 ${
                          myPlayerData?.isSittingOut
                            ? 'bg-green-600 text-white'
                            : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                        }`}
                      >
                        {myPlayerData?.isSittingOut ? 'Sit Back In' : 'Sit Out'}
                      </button>
                    </>
                  )}

                  {/* Normal ready state */}
                  {(myPlayerData?.stack > 0) && (
                    <>
                      <button
                        onClick={handleReadyToggle}
                        className={`px-3 sm:px-4 py-1.5 sm:py-2 rounded-xl font-semibold text-[10px] sm:text-xs transition-all duration-200 active:scale-95 ${
                          players[mySeatIndex]?.isReady
                            ? 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                            : 'bg-gradient-to-r from-green-600 to-green-500 text-white shadow-lg shadow-green-600/20'
                        }`}
                      >
                        {players[mySeatIndex]?.isReady ? 'Not Ready' : 'Ready'}
                      </button>
                      <button
                        onClick={handleSitOutToggle}
                        className={`px-3 sm:px-4 py-1.5 sm:py-2 rounded-xl font-semibold text-[10px] sm:text-xs transition-all duration-200 active:scale-95 ${
                          myPlayerData?.isSittingOut
                            ? 'bg-green-600 text-white'
                            : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                        }`}
                      >
                        {myPlayerData?.isSittingOut ? 'Sit Back In' : 'Sit Out'}
                      </button>
                    </>
                  )}

                  {isHost && (
                    <button
                      onClick={handleStartGame}
                      disabled={connectedPlayers.length < 2}
                      className="btn-primary px-3 sm:px-4 py-1.5 sm:py-2 text-[10px] sm:text-xs"
                    >
                      Start Game
                    </button>
                  )}
                </>
              )}

              {/* IN-GAME action controls */}
              {gameState !== 'WAITING' && gameState !== 'SHOWDOWN' && gameState !== 'HAND_COMPLETE' && (
                <>
                  {/* Main action buttons row */}
                  <div className="flex items-center gap-1 sm:gap-1.5 flex-wrap">
                    {/* Fold */}
                    <button
                      onClick={() => handleAction('fold')}
                      disabled={!canAct}
                      className="action-btn-fold px-3 sm:px-4 py-1.5 sm:py-2 text-[10px] sm:text-xs"
                    >
                      Fold
                    </button>

                    {/* Check */}
                    {currentBet <= (myPlayerData?.betAmount || 0) && (
                      <button
                        onClick={() => handleAction('check')}
                        disabled={!canAct}
                        className="action-btn-check px-3 sm:px-4 py-1.5 sm:py-2 text-[10px] sm:text-xs"
                      >
                        Check
                      </button>
                    )}

                    {/* Call */}
                    {currentBet > (myPlayerData?.betAmount || 0) && (
                      <button
                        onClick={() => handleAction('call')}
                        disabled={!canAct}
                        className="action-btn-call px-3 sm:px-4 py-1.5 sm:py-2 text-[10px] sm:text-xs"
                      >
                        Call ${(currentBet - (myPlayerData?.betAmount || 0)).toLocaleString()}
                      </button>
                    )}
                  </div>

                  {/* Bet Slider + Controls (only when can act and has stack) */}
                  {canAct && myStack > 0 && (
                    <div className="flex items-center gap-1 sm:gap-2 flex-wrap">
                      {/* Bet Presets */}
                      <div className="flex items-center gap-0.5 sm:gap-1">
                        <button
                          onClick={() => handleAction(isRaiseContext ? 'raise' : 'bet', getBetPreset(0.5))}
                          className="preset-btn"
                        >
                          ½ Pot
                        </button>
                        <button
                          onClick={() => handleAction(isRaiseContext ? 'raise' : 'bet', getBetPreset(0.75))}
                          className="preset-btn"
                        >
                          ¾ Pot
                        </button>
                        <button
                          onClick={() => handleAction(isRaiseContext ? 'raise' : 'bet', getBetPreset(1))}
                          className="preset-btn"
                        >
                          Pot
                        </button>
                      </div>

                      {/* Bet Slider */}
                      <div className="flex items-center gap-1 sm:gap-2">
                        <div className="relative flex items-center">
                          <input
                            type="range"
                            min={0}
                            max={100}
                            value={betSliderValue}
                            onChange={(e) => setBetSliderValue(parseInt(e.target.value))}
                            className="bet-slider w-16 sm:w-20 h-1.5"
                          />
                        </div>
                        <span className="text-white font-mono text-[10px] sm:text-xs font-bold min-w-[4rem] text-right">
                          ${sliderBet.toLocaleString()}
                        </span>
                      </div>

                      {/* Action button for slider bet */}
                      <button
                        onClick={() => handleAction(isRaiseContext ? 'raise' : 'bet', sliderBet)}
                        className="bg-gradient-to-r from-purple-600 to-purple-500 text-white font-bold rounded-xl px-3 sm:px-4 py-1.5 sm:py-2
                                 hover:from-purple-500 hover:to-purple-400 transition-all duration-200 active:scale-95
                                 shadow-lg shadow-purple-600/20 text-[10px] sm:text-xs"
                      >
                        {isRaiseContext ? 'Raise' : 'Bet'}
                      </button>

                      {/* All-In */}
                      <button
                        onClick={() => handleAction(isRaiseContext ? 'raise' : 'bet', maxBetValue)}
                        className="bg-gradient-to-r from-orange-600 to-orange-500 text-white font-bold rounded-xl px-3 sm:px-4 py-1.5 sm:py-2
                                 hover:from-orange-500 hover:to-orange-400 transition-all duration-200 active:scale-95
                                 shadow-lg shadow-orange-600/20 text-[10px] sm:text-xs"
                      >
                        All-In ${maxBetValue.toLocaleString()}
                      </button>
                    </div>
                  )}

                  {/* Not your turn */}
                  {!isMyTurn && (
                    <div className="flex items-center gap-1.5 sm:gap-2">
                      {displayTimer > 0 && (
                        <div className="flex items-center gap-1 text-[10px] sm:text-xs text-gray-500">
                          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                          {displayTimer}s
                        </div>
                      )}
                      <span className="text-[10px] sm:text-xs text-gray-500">
                        {currentPlayerSeatIndex >= 0 ? `Waiting for ${players[currentPlayerSeatIndex]?.userName || 'player'}...` : ''}
                      </span>
                    </div>
                  )}
                </>
              )}

              {/* Emoji Tray + Share buttons */}
              <div className="flex items-center gap-1 sm:gap-1.5">
                {/* Emoji Tray */}
                <div className="relative" ref={emojiTrayRef}>
                  <button
                    onClick={() => setEmojiTrayOpen(!emojiTrayOpen)}
                    className="px-2 sm:px-3 py-1.5 sm:py-2 rounded-xl text-xs font-medium transition-all duration-200 bg-gray-800 text-gray-300 hover:bg-gray-700 active:scale-95"
                    title="Send Emoji"
                  >
                    😊
                  </button>
                  
                  {emojiTrayOpen && (
                    <div className="absolute bottom-full left-0 mb-2 bg-gray-800 rounded-xl border border-gray-700 shadow-2xl p-2 animate-slide-up z-50">
                      <div className="flex gap-1.5">
                        {PRESET_EMOJIS.map((emoji, i) => (
                          <button
                            key={i}
                            onClick={() => handleSendEmoji(emoji)}
                            className="w-7 h-7 sm:w-8 sm:h-8 flex items-center justify-center text-base sm:text-lg rounded-lg hover:bg-gray-700 transition-colors active:scale-90"
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Share */}
                <button
                  onClick={handleCopyShareLink}
                  className={`px-2 sm:px-3 py-1.5 sm:py-2 rounded-xl text-[10px] sm:text-xs font-medium transition-all duration-200 ${
                    copiedCode ? 'bg-green-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                  }`}
                >
                  {copiedCode ? 'Copied!' : 'Share'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
