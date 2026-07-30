import React, { useState, useEffect, useCallback, useRef } from 'react';
import { connect, getSocket } from './socket';

// ─── Stake Level Card ─────────────────────────────────────────
function StakeCard({ level, bankroll, onJoin }) {
  const blindText = `${level.sb}/${level.bb}`;
  const buyinText = `${level.minBuyin.toLocaleString()} - ${level.maxBuyin.toLocaleString()}`;
  const canAfford = level.minBuyin <= bankroll;

  // Generate consistent color per stake level
  const colors = {
    micro: { bg: 'from-emerald-600 to-emerald-800', badge: 'bg-emerald-500/20 text-emerald-400' },
    low: { bg: 'from-blue-600 to-blue-800', badge: 'bg-blue-500/20 text-blue-400' },
    medium: { bg: 'from-purple-600 to-purple-800', badge: 'bg-purple-500/20 text-purple-400' },
    high: { bg: 'from-rose-600 to-rose-800', badge: 'bg-rose-500/20 text-rose-400' },
    ultra: { bg: 'from-orange-600 to-orange-800', badge: 'bg-orange-500/20 text-orange-400' },
    superHigh: { bg: 'from-red-700 to-red-900', badge: 'bg-red-500/20 text-red-400' },
  };
  const c = colors[level.key] || colors.micro;

  return (
    <div className={`relative bg-gray-900 rounded-2xl border border-gray-800 overflow-hidden transition-all duration-200
      hover:border-gray-700 hover:shadow-lg hover:shadow-black/20 group cursor-pointer
      ${!canAfford ? 'opacity-60' : ''}`}
      onClick={() => canAfford && onJoin(level)}
    >
      {/* Top gradient bar */}
      <div className={`h-2 bg-gradient-to-r ${c.bg}`} />

      <div className="p-4">
        {/* Name & badge */}
        <div className="flex items-start justify-between mb-3">
          <h3 className="text-sm font-bold text-white truncate">{level.name}</h3>
          <span className={`shrink-0 px-2 py-0.5 text-[10px] rounded-full font-medium ${c.badge}`}>
            {blindText}
          </span>
        </div>

        {/* Buy-in range */}
        <div className="space-y-2">
          <div className="flex justify-between text-xs">
            <span className="text-gray-500">Buy-in</span>
            <span className="text-gray-300 font-mono">{buyinText}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-gray-500">Blinds</span>
            <span className="text-gray-300 font-mono">{blindText}</span>
          </div>
        </div>

        {/* Join overlay */}
        {canAfford && (
          <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-200 rounded-2xl">
            <span className="px-4 py-2 bg-gradient-to-r from-green-600 to-green-500 text-white rounded-xl text-sm font-bold shadow-lg">
              Join Game
            </span>
          </div>
        )}

        {!canAfford && (
          <div className="mt-2 text-[10px] text-red-400/70">
            Need {level.minBuyin.toLocaleString()} chips to sit
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Join Modal ──────────────────────────────────────────────
function JoinModal({ level, bankroll, onClose, onJoin }) {
  const [buyinAmount, setBuyinAmount] = useState(level?.minBuyin || 50);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (level) {
      const suggested = Math.min(Math.max(bankroll, level.minBuyin), level.maxBuyin);
      setBuyinAmount(suggested);
    }
  }, [level, bankroll]);

  if (!level) return null;

  const handleJoin = async () => {
    setError('');
    if (buyinAmount < level.minBuyin || buyinAmount > level.maxBuyin) {
      setError(`Buy-in must be between ${level.minBuyin.toLocaleString()} and ${level.maxBuyin.toLocaleString()}`);
      return;
    }
    if (buyinAmount > bankroll) {
      setError('Insufficient bankroll');
      return;
    }

    setLoading(true);
    const socket = getSocket();
    if (!socket) {
      setError('Not connected');
      setLoading(false);
      return;
    }

    socket.emit('join_ring_game', {
      stakeLevel: level.key,
      buyinAmount,
    }, (err, data) => {
      setLoading(false);
      if (err) { setError(err.error || 'Failed to join'); return; }
      onJoin(data);
    });
  };

  const canAfford = buyinAmount <= bankroll;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bg-gray-900 rounded-2xl border border-gray-800 p-6 w-full max-w-sm animate-slide-up shadow-2xl">
        <h2 className="text-lg font-bold text-white mb-1">{level.name}</h2>
        <p className="text-sm text-gray-400 mb-4">Blinds {level.sb}/{level.bb}</p>

        <div className="bg-gray-800/50 rounded-xl p-3 mb-4 space-y-1.5">
          <div className="flex justify-between text-sm">
            <span className="text-gray-400">Buy-in Range</span>
            <span className="text-white font-mono">{level.minBuyin.toLocaleString()} - {level.maxBuyin.toLocaleString()}</span>
          </div>
          <div className="flex justify-between text-sm border-t border-gray-700 pt-1.5 mt-1.5">
            <span className="text-gray-400">Your Bankroll</span>
            <span className={`font-mono font-bold ${canAfford ? 'text-poker-gold' : 'text-red-400'}`}>
              {bankroll.toLocaleString()} chips
            </span>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">Buy-in Amount</label>
          <input type="number" value={buyinAmount}
            onChange={(e) => setBuyinAmount(Math.min(Math.max(parseInt(e.target.value) || level.minBuyin, level.minBuyin), level.maxBuyin))}
            min={level.minBuyin} max={Math.min(level.maxBuyin, bankroll)}
            className="input-field text-sm w-full" />
          <div className="flex gap-1.5 mt-2">
            {[level.minBuyin, Math.floor((level.minBuyin + level.maxBuyin) / 2), level.maxBuyin]
              .filter((v, i, a) => a.indexOf(v) === i)
              .filter(v => v <= bankroll)
              .map(amount => (
              <button key={amount}
                onClick={() => setBuyinAmount(amount)}
                className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all ${
                  buyinAmount === amount
                    ? 'bg-poker-gold text-black'
                    : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                }`}>
                {amount.toLocaleString()}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="mt-3 bg-red-900/40 border border-red-800/50 rounded-xl p-3 text-red-300 text-sm">
            <span>⚠️ {error}</span>
          </div>
        )}

        <div className="flex gap-2 mt-5">
          <button onClick={onClose}
            className="flex-1 py-2.5 bg-gray-800 text-gray-300 rounded-xl text-sm font-semibold hover:bg-gray-700 transition-all active:scale-95">
            Cancel
          </button>
          <button onClick={handleJoin} disabled={loading || !canAfford}
            className="flex-1 py-2.5 bg-gradient-to-r from-green-600 to-green-500 text-white rounded-xl text-sm font-bold
                       hover:from-green-500 hover:to-green-400 transition-all active:scale-95
                       disabled:opacity-50 disabled:cursor-not-allowed">
            {loading ? (
              <span className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : 'Buy In & Sit'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ====================================================================
// MAIN LOBBY COMPONENT
// ====================================================================
export default function Lobby({ onEnterClub, displayName, userId, onLogout }) {
  const [levels, setLevels] = useState([]);
  const [bankroll, setBankroll] = useState(0);
  const [loading, setLoading] = useState(true);
  const [joinTarget, setJoinTarget] = useState(null);
  const pollRef = useRef(null);

  const fetchData = useCallback(() => {
    const socket = getSocket();
    if (!socket) return;

    socket.emit('get_bankroll', {}, (err, data) => {
      if (!err && data) setBankroll(data.bankroll);
    });

    socket.emit('get_stake_levels', {}, (err, data) => {
      setLoading(false);
      if (!err && data) setLevels(data.levels || []);
    });
  }, []);

  useEffect(() => {
    const socket = connect();
    if (!socket) return;

    fetchData();
    pollRef.current = setInterval(fetchData, 5000);

    const onBankrollUpdate = (data) => {
      if (data.bankroll !== undefined) setBankroll(data.bankroll);
    };

    socket.on('bankroll_updated', onBankrollUpdate);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      socket.off('bankroll_updated', onBankrollUpdate);
    };
  }, [fetchData]);

  const handleJoinTable = useCallback((data) => {
    setJoinTarget(null);
    onEnterClub({
      gameId: data.gameId,
      tableName: data.tableName,
      userId: data.userId,
      seatIndex: data.seatIndex,
      buyinAmount: data.buyinAmount,
    }, displayName);
  }, [onEnterClub, displayName]);

  const formatBankroll = (amount) => {
    if (amount >= 1000000) return (amount / 1000000).toFixed(1) + 'M';
    if (amount >= 1000) return (amount / 1000).toFixed(1) + 'K';
    return amount.toLocaleString();
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-950 via-gray-900 to-gray-950 overflow-hidden">
      {/* Background decorative elements */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-80 h-80 bg-poker-gold/5 rounded-full blur-3xl" />
        <div className="absolute -bottom-40 -left-40 w-80 h-80 bg-felt/10 rounded-full blur-3xl" />
      </div>

      {/* ── Header Bar ── */}
      <header className="relative bg-gray-900/80 backdrop-blur-sm border-b border-gray-800 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-gradient-to-br from-felt to-felt-dark border border-poker-gold/30 flex items-center justify-center">
            <span className="text-lg">🃏</span>
          </div>
          <div>
            <h1 className="text-sm font-bold text-white">Ring Games</h1>
            <p className="text-[10px] text-gray-500">
              Welcome, <span className="text-poker-gold">{displayName}</span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Bankroll */}
          <div className="bg-gray-800/70 rounded-xl px-3 py-1.5 flex items-center gap-2">
            <span className="text-yellow-400 text-xs">💰</span>
            <div className="text-right">
              <p className="text-xs font-bold text-poker-gold font-mono">{formatBankroll(bankroll)}</p>
              <p className="text-[8px] text-gray-500 leading-none">chips</p>
            </div>
          </div>

          <button onClick={onLogout}
            className="text-gray-500 hover:text-gray-300 transition-colors p-1.5"
            title="Logout">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
          </button>
        </div>
      </header>

      {/* ── Main Content ── */}
      <div className="relative max-w-4xl mx-auto px-4 py-6">
        <div className="mb-6 animate-fade-in">
          <h2 className="text-xl font-bold text-white">Choose Your Stakes</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Pick a stake level and buy in — we'll find you a seat
            {loading && <span className="ml-2 text-gray-600 animate-pulse">Loading...</span>}
          </p>
        </div>

        {/* Stake Level Grid */}
        {!loading && levels.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 animate-fade-in">
            {levels.map(level => (
              <StakeCard key={level.key} level={level} bankroll={bankroll} onJoin={setJoinTarget} />
            ))}
          </div>
        ) : !loading ? (
          <div className="text-center py-20 animate-fade-in">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-gray-800/50 mb-4">
              <span className="text-3xl opacity-50">🪑</span>
            </div>
            <h3 className="text-lg font-semibold text-gray-400 mb-1">No stake data available</h3>
            <p className="text-sm text-gray-600">Try refreshing the page</p>
          </div>
        ) : null}
      </div>

      {/* Join Modal */}
      {joinTarget && (
        <JoinModal
          level={joinTarget}
          bankroll={bankroll}
          onClose={() => setJoinTarget(null)}
          onJoin={handleJoinTable}
        />
      )}
    </div>
  );
}
