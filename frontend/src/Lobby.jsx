import React, { useState, useEffect, useCallback, useRef } from 'react';
import { connect, getSocket } from './socket';

// ─── Create Table Modal ─────────────────────────────────────
function CreateTableModal({ onClose, onCreate }) {
  const [tableName, setTableName] = useState('');
  const [minBuyin, setMinBuyin] = useState(50);
  const [maxBuyin, setMaxBuyin] = useState(1000);
  const [smallBlind, setSmallBlind] = useState(10);
  const [bigBlind, setBigBlind] = useState(20);
  const [actionTimer, setActionTimer] = useState(20);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleCreate = async () => {
    setError('');
    if (!tableName.trim()) { setError('Table name is required'); return; }
    if (minBuyin < 50) { setError('Minimum buy-in is 50 chips'); return; }
    if (maxBuyin > 50000000) { setError('Maximum buy-in is 50,000,000 chips'); return; }
    if (minBuyin > maxBuyin) { setError('Min buy-in cannot exceed max buy-in'); return; }
    if (smallBlind < 1 || bigBlind < 2) { setError('Invalid blind amounts'); return; }
    if (tableName.trim().length > 30) { setError('Table name must be 30 characters or less'); return; }

    setLoading(true);
    const socket = getSocket();
    if (!socket) {
      setError('Not connected');
      setLoading(false);
      return;
    }

    socket.emit('create_ring_game', {
      tableName: tableName.trim(),
      minBuyin,
      maxBuyin,
      smallBlind,
      bigBlind,
      actionTimer,
    }, (err, data) => {
      setLoading(false);
      if (err) { setError(err.error || 'Failed to create table'); return; }
      onCreate(data);
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bg-gray-900 rounded-2xl border border-gray-800 p-6 w-full max-w-md animate-slide-up shadow-2xl">
        <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
          <span>🎲</span> Create Table
        </h2>

        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Table Name</label>
            <input type="text" value={tableName}
              onChange={(e) => setTableName(e.target.value.slice(0, 30))}
              placeholder="e.g. High Rollers" maxLength={30}
              className="input-field text-sm" autoFocus />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Min Buy-in</label>
              <input type="number" value={minBuyin}
                onChange={(e) => setMinBuyin(Math.max(50, parseInt(e.target.value) || 50))}
                min={50} max={50000000}
                className="input-field text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Max Buy-in</label>
              <input type="number" value={maxBuyin}
                onChange={(e) => setMaxBuyin(Math.min(50000000, parseInt(e.target.value) || 1000))}
                min={50} max={50000000}
                className="input-field text-sm" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Small Blind</label>
              <input type="number" value={smallBlind}
                onChange={(e) => setSmallBlind(Math.max(1, parseInt(e.target.value) || 1))}
                min={1} className="input-field text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Big Blind</label>
              <input type="number" value={bigBlind}
                onChange={(e) => setBigBlind(Math.max(2, parseInt(e.target.value) || 2))}
                min={2} className="input-field text-sm" />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Action Timer: {actionTimer}s
            </label>
            <input type="range" value={actionTimer}
              onChange={(e) => setActionTimer(parseInt(e.target.value))}
              min={10} max={60} step={5}
              className="bet-slider w-full" />
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
          <button onClick={handleCreate} disabled={loading}
            className="flex-1 py-2.5 bg-gradient-to-r from-poker-gold to-yellow-500 text-black rounded-xl text-sm font-bold hover:from-yellow-400 hover:to-yellow-300 transition-all active:scale-95 disabled:opacity-50">
            {loading ? (
              <span className="inline-block w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin" />
            ) : 'Create Table'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Join Table Modal ───────────────────────────────────────
function JoinTableModal({ game, bankroll, onClose, onJoin }) {
  const [buyinAmount, setBuyinAmount] = useState(game?.minBuyin || 50);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (game) {
      setBuyinAmount(Math.min(Math.max(bankroll, game.minBuyin), game.maxBuyin));
    }
  }, [game, bankroll]);

  const handleJoin = async () => {
    setError('');
    if (buyinAmount < game.minBuyin || buyinAmount > game.maxBuyin) {
      setError(`Buy-in must be between ${game.minBuyin.toLocaleString()} and ${game.maxBuyin.toLocaleString()} chips`);
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
      gameId: game.id,
      buyinAmount,
    }, (err, data) => {
      setLoading(false);
      if (err) { setError(err.error || 'Failed to join'); return; }
      onJoin(data);
    });
  };

  if (!game) return null;

  const canAfford = buyinAmount <= bankroll;
  const buyinRange = `${game.minBuyin.toLocaleString()} - ${game.maxBuyin.toLocaleString()}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bg-gray-900 rounded-2xl border border-gray-800 p-6 w-full max-w-sm animate-slide-up shadow-2xl">
        <h2 className="text-lg font-bold text-white mb-1">Join Table</h2>
        <p className="text-sm text-gray-400 mb-4">{game.tableName}</p>

        <div className="bg-gray-800/50 rounded-xl p-3 mb-4 space-y-1.5">
          <div className="flex justify-between text-sm">
            <span className="text-gray-400">Blinds</span>
            <span className="text-white font-mono">{game.smallBlind}/{game.bigBlind}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-400">Buy-in Range</span>
            <span className="text-white font-mono">{buyinRange}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-400">Players</span>
            <span className="text-white">{game.seatedCount}/6</span>
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
          <div className="flex gap-2">
            <input type="number" value={buyinAmount}
              onChange={(e) => setBuyinAmount(Math.min(Math.max(parseInt(e.target.value) || game.minBuyin, game.minBuyin), game.maxBuyin))}
              min={game.minBuyin} max={Math.min(game.maxBuyin, bankroll)}
              className="input-field text-sm flex-1" />
          </div>
          <div className="flex gap-1.5 mt-2">
            {[game.minBuyin, Math.floor((game.minBuyin + game.maxBuyin) / 2), game.maxBuyin].filter((v, i, a) => a.indexOf(v) === i).map(amount => (
              <button key={amount}
                onClick={() => setBuyinAmount(Math.min(amount, bankroll))}
                className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all ${
                  buyinAmount === amount
                    ? 'bg-poker-gold text-black'
                    : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                }`}>
                {amount.toLocaleString()}
              </button>
            ))}
            {bankroll > game.maxBuyin && (
              <button onClick={() => setBuyinAmount(game.maxBuyin)}
                className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all ${
                  buyinAmount === game.maxBuyin
                    ? 'bg-poker-gold text-black'
                    : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                }`}>
                Max
              </button>
            )}
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

// ─── Table Card ──────────────────────────────────────────────
function TableCard({ game, bankroll, onJoin }) {
  const blindText = `${game.smallBlind}/${game.bigBlind}`;
  const buyinText = `${game.minBuyin.toLocaleString()} - ${game.maxBuyin.toLocaleString()}`;
  const fillPercent = (game.seatedCount / 6) * 100;
  const canAfford = game.minBuyin <= bankroll;
  const isInProgress = game.gameState !== 'WAITING';

  // Generate a consistent color based on table name
  const colors = ['from-blue-600 to-blue-800', 'from-purple-600 to-purple-800', 'from-emerald-600 to-emerald-800',
    'from-rose-600 to-rose-800', 'from-amber-600 to-amber-800', 'from-cyan-600 to-cyan-800'];
  const colorIdx = game.tableName.length % colors.length;

  return (
    <div className={`relative bg-gray-900 rounded-2xl border border-gray-800 overflow-hidden transition-all duration-200
      hover:border-gray-700 hover:shadow-lg hover:shadow-black/20 group cursor-pointer
      ${!canAfford ? 'opacity-60' : ''}`}
      onClick={() => canAfford && onJoin(game)}
    >
      {/* Top gradient bar */}
      <div className={`h-2 bg-gradient-to-r ${colors[colorIdx]}`} />

      <div className="p-4">
        {/* Table name & status */}
        <div className="flex items-start justify-between mb-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-bold text-white truncate">{game.tableName}</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              {blindText} blinds
            </p>
          </div>
          {isInProgress && (
            <span className="shrink-0 px-2 py-0.5 bg-green-500/20 text-green-400 text-[10px] rounded-full font-medium">
              Live
            </span>
          )}
        </div>

        {/* Player count bar */}
        <div className="mb-3">
          <div className="flex justify-between text-xs mb-1">
            <span className="text-gray-400">Players</span>
            <span className={`font-medium ${game.seatedCount >= 6 ? 'text-red-400' : 'text-white'}`}>
              {game.seatedCount}/6
            </span>
          </div>
          <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all duration-500 ${colors[colorIdx].replace('from-', 'bg-').split(' ')[0].replace('from-', 'bg-')}`}
              style={{ width: `${fillPercent}%` }} />
          </div>
        </div>

        {/* Buy-in range */}
        <div className="flex justify-between items-center text-xs">
          <span className="text-gray-500">Buy-in</span>
          <span className="text-gray-300 font-mono">{buyinText}</span>
        </div>

        {/* Join overlay on hover */}
        {canAfford && (
          <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-200 rounded-2xl">
            <span className="px-4 py-2 bg-gradient-to-r from-green-600 to-green-500 text-white rounded-xl text-sm font-bold shadow-lg">
              {isInProgress ? 'Sit In' : 'Join Table'}
            </span>
          </div>
        )}

        {!canAfford && (
          <div className="mt-2 text-[10px] text-red-400/70">
            Bankroll too low for this table
          </div>
        )}
      </div>
    </div>
  );
}

// ====================================================================
// MAIN LOBBY COMPONENT
// ====================================================================
export default function Lobby({ onEnterClub, displayName, userId, onLogout }) {
  const [tables, setTables] = useState([]);
  const [bankroll, setBankroll] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [joinTarget, setJoinTarget] = useState(null);
  const [error, setError] = useState('');
  const pollRef = useRef(null);

  // Fetch bankroll & tables on mount
  const fetchBankrollAndTables = useCallback(() => {
    const socket = getSocket();
    if (!socket) return;

    socket.emit('get_bankroll', {}, (err, data) => {
      if (!err && data) setBankroll(data.bankroll);
    });

    socket.emit('get_ring_games', {}, (err, data) => {
      setLoading(false);
      if (!err && data) setTables(data.games || []);
    });
  }, []);

  useEffect(() => {
    const socket = connect();
    if (!socket) return;

    // Initial fetch
    fetchBankrollAndTables();

    // Poll every 5 seconds for new tables
    pollRef.current = setInterval(fetchBankrollAndTables, 5000);

    // Listen for bankroll updates
    const onBankrollUpdate = (data) => {
      if (data.bankroll !== undefined) setBankroll(data.bankroll);
    };

    socket.on('bankroll_updated', onBankrollUpdate);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      socket.off('bankroll_updated', onBankrollUpdate);
    };
  }, [fetchBankrollAndTables]);

  const handleCreateTable = useCallback((data) => {
    setShowCreate(false);
    // Navigate to club room with ring game data
    onEnterClub({
      gameId: data.gameId,
      tableName: data.tableName,
      userId,
      seatIndex: -1, // Host hasn't bought in yet
      minBuyin: data.minBuyin,
      maxBuyin: data.maxBuyin,
    }, displayName);
  }, [onEnterClub, userId, displayName]);

  const handleJoinTable = useCallback((game) => {
    setJoinTarget(game);
  }, []);

  const handleConfirmJoin = useCallback((data) => {
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
        {/* Action Bar */}
        <div className="flex items-center justify-between mb-6 animate-fade-in">
          <div>
            <h2 className="text-xl font-bold text-white">Active Tables</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {tables.length} table{tables.length !== 1 ? 's' : ''} available
              {loading && <span className="ml-2 text-gray-600 animate-pulse">Loading...</span>}
            </p>
          </div>
          <button onClick={() => setShowCreate(true)}
            className="px-4 py-2.5 bg-gradient-to-r from-poker-gold to-yellow-500 text-black rounded-xl text-sm font-bold
                       hover:from-yellow-400 hover:to-yellow-300 transition-all active:scale-95 shadow-lg shadow-yellow-600/20
                       flex items-center gap-2">
            <span>+</span>
            Create Table
          </button>
        </div>

        {/* Table Grid */}
        {!loading && tables.length === 0 ? (
          <div className="text-center py-20 animate-fade-in">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-gray-800/50 mb-4">
              <span className="text-3xl opacity-50">🪑</span>
            </div>
            <h3 className="text-lg font-semibold text-gray-400 mb-1">No Active Tables</h3>
            <p className="text-sm text-gray-600 mb-6">Be the first to create one!</p>
            <button onClick={() => setShowCreate(true)}
              className="px-6 py-3 bg-gradient-to-r from-poker-gold to-yellow-500 text-black rounded-xl font-bold
                         hover:from-yellow-400 hover:to-yellow-300 transition-all active:scale-95">
              Create First Table
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 animate-fade-in">
            {tables.map(game => (
              <TableCard key={game.id} game={game} bankroll={bankroll} onJoin={handleJoinTable} />
            ))}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="mt-4 bg-red-900/40 border border-red-800/50 rounded-xl p-4 text-red-300 text-sm animate-fade-in">
            <span>⚠️ {error}</span>
          </div>
        )}
      </div>

      {/* Modals */}
      {showCreate && (
        <CreateTableModal
          onClose={() => setShowCreate(false)}
          onCreate={handleCreateTable}
        />
      )}

      {joinTarget && (
        <JoinTableModal
          game={joinTarget}
          bankroll={bankroll}
          onClose={() => setJoinTarget(null)}
          onJoin={handleConfirmJoin}
        />
      )}
    </div>
  );
}
