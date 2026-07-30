import React, { useState, useEffect, useCallback, useRef } from 'react';
import { connect, getSocket } from './socket';

// ─── Challenge Panel Component ──────────────────────────────
function ChallengePanel({ onEnterChallengeClub }) {
  const [incomingChallenges, setIncomingChallenges] = useState([]);
  const [outgoingChallenges, setOutgoingChallenges] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const searchTimeout = useRef(null);

  // Load pending challenges on mount
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    socket.emit('get_my_challenges', {}, (err, data) => {
      if (err) return;
      const incoming = data.challenges.filter(c => c.isIncoming);
      const outgoing = data.challenges.filter(c => !c.isIncoming);
      setIncomingChallenges(incoming);
      setOutgoingChallenges(outgoing);
    });

    // Listen for real-time challenge events
    const onNewChallenge = (challenge) => {
      setIncomingChallenges(prev => {
        if (prev.some(c => c.id === challenge.id)) return prev;
        return [challenge, ...prev];
      });
    };

    const onChallengeAccepted = (data) => {
      onEnterChallengeClub(data);
    };

    const onChallengeRejected = ({ challengeId }) => {
      setOutgoingChallenges(prev =>
        prev.filter(c => c.id !== challengeId)
      );
    };

    socket.on('new_challenge', onNewChallenge);
    socket.on('challenge_accepted', onChallengeAccepted);
    socket.on('challenge_rejected', onChallengeRejected);

    return () => {
      socket.off('new_challenge', onNewChallenge);
      socket.off('challenge_accepted', onChallengeAccepted);
      socket.off('challenge_rejected', onChallengeRejected);
    };
  }, [onEnterChallengeClub]);

  // Debounced user search
  const handleSearch = useCallback((query) => {
    setSearchQuery(query);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);

    if (query.trim().length < 2) {
      setSearchResults([]);
      return;
    }

    searchTimeout.current = setTimeout(() => {
      setSearching(true);
      const socket = getSocket();
      if (!socket) return;
      socket.emit('find_users', { query: query.trim() }, (err, data) => {
        setSearching(false);
        if (err) return;
        setSearchResults(data.users || []);
      });
    }, 400);
  }, []);

  const handleSendChallenge = useCallback((opponentId) => {
    const socket = getSocket();
    if (!socket) return;
    socket.emit('send_challenge', {
      opponentId,
      buyIn: 0,
      blindLevel: 20,
      maxHands: 0,
    }, (err, data) => {
      if (err) {
        setError(err.error || 'Failed to send challenge');
        return;
      }
      setOutgoingChallenges(prev => {
        if (prev.some(c => c.id === data.id)) return prev;
        const opponent = searchResults.find(u => u.id === opponentId);
        return [{
          id: data.id,
          status: data.status,
          buyIn: data.buyIn,
          blindLevel: data.blindLevel,
          maxHands: data.maxHands,
          createdAt: data.createdAt,
          isIncoming: false,
          opponent: opponent || { id: opponentId, displayName: 'User' },
        }, ...prev];
      });
      setSearchQuery('');
      setSearchResults([]);
    });
  }, [searchResults]);

  const handleAcceptChallenge = useCallback((challengeId) => {
    const socket = getSocket();
    if (!socket) return;
    socket.emit('accept_challenge', { challengeId }, (err, data) => {
      if (err) {
        setError(err.error || 'Failed to accept challenge');
        return;
      }
      setIncomingChallenges(prev => prev.filter(c => c.id !== challengeId));
      onEnterChallengeClub(data);
    });
  }, [onEnterChallengeClub]);

  const handleRejectChallenge = useCallback((challengeId) => {
    const socket = getSocket();
    if (!socket) return;
    socket.emit('reject_challenge', { challengeId }, (err) => {
      if (err) return;
      setIncomingChallenges(prev => prev.filter(c => c.id !== challengeId));
    });
  }, []);

  const handleCancelChallenge = useCallback((challengeId) => {
    const socket = getSocket();
    if (!socket) return;
    socket.emit('cancel_challenge', { challengeId }, (err) => {
      if (err) return;
      setOutgoingChallenges(prev => prev.filter(c => c.id !== challengeId));
    });
  }, []);

  return (
    <div className="space-y-4 animate-slide-up">
      {/* ── Find Players ── */}
      <div className="bg-gray-900/70 backdrop-blur-sm rounded-2xl border border-gray-800 p-4">
        <h3 className="text-sm font-semibold text-white mb-2 flex items-center gap-2">
          <span>🔍</span> Find Players
        </h3>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder="Search by email or display name..."
          className="input-field text-sm"
        />
        {searching && (
          <p className="text-xs text-gray-500 mt-1">Searching...</p>
        )}
        {searchResults.length > 0 && (
          <div className="mt-2 space-y-1 max-h-40 overflow-y-auto">
            {searchResults.map(user => (
              <div key={user.id}
                className="flex items-center justify-between bg-gray-800/50 rounded-xl px-3 py-2 hover:bg-gray-800 transition-colors"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0"
                    style={{ backgroundColor: user.avatarColor || '#FFD700' }}
                  >
                    {user.displayName.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-white truncate">{user.displayName}</p>
                    <p className="text-[10px] text-gray-500">
                      {user.totalWins || 0} wins · {user.handsPlayed || 0} hands
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => handleSendChallenge(user.id)}
                  className="shrink-0 px-3 py-1.5 bg-gradient-to-r from-poker-gold to-yellow-500 text-black text-xs font-bold rounded-lg hover:from-yellow-400 hover:to-yellow-300 transition-all active:scale-95"
                >
                  Challenge
                </button>
              </div>
            ))}
          </div>
        )}
        {searchQuery.length >= 2 && searchResults.length === 0 && !searching && (
          <p className="text-xs text-gray-500 mt-1">No users found</p>
        )}
      </div>

      {/* ── Incoming Challenges ── */}
      {incomingChallenges.length > 0 && (
        <div className="bg-gray-900/70 backdrop-blur-sm rounded-2xl border border-poker-gold/20 p-4">
          <h3 className="text-sm font-semibold text-poker-gold mb-3 flex items-center gap-2">
            <span className="w-2 h-2 bg-poker-gold rounded-full animate-pulse" />
            Incoming Challenges ({incomingChallenges.length})
          </h3>
          <div className="space-y-2">
            {incomingChallenges.map(challenge => (
              <div key={challenge.id}
                className="flex items-center justify-between bg-gray-800/50 rounded-xl px-3 py-2.5"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0"
                    style={{ backgroundColor: challenge.opponent?.avatarColor || '#6366f1' }}
                  >
                    {challenge.opponent?.displayName?.charAt(0).toUpperCase() || '?'}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-white truncate">
                      {challenge.opponent?.displayName || 'Unknown'}
                    </p>
                    <p className="text-[10px] text-gray-500">
                      {challenge.blindLevel ? `BB ${challenge.blindLevel}` : 'Default stakes'}
                      {challenge.maxHands > 0 ? ` · Best of ${challenge.maxHands}` : ''}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => handleAcceptChallenge(challenge.id)}
                    className="px-3 py-1.5 bg-gradient-to-r from-green-600 to-green-500 text-white text-xs font-bold rounded-lg hover:from-green-500 hover:to-green-400 transition-all active:scale-95"
                  >
                    Accept
                  </button>
                  <button
                    onClick={() => handleRejectChallenge(challenge.id)}
                    className="px-3 py-1.5 bg-gray-700 text-gray-300 text-xs rounded-lg hover:bg-gray-600 transition-all active:scale-95"
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Outgoing Challenges ── */}
      {outgoingChallenges.length > 0 && (
        <div className="bg-gray-900/70 backdrop-blur-sm rounded-2xl border border-gray-800 p-4">
          <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
            <span>📤</span> Sent Challenges ({outgoingChallenges.length})
          </h3>
          <div className="space-y-2">
            {outgoingChallenges.map(challenge => (
              <div key={challenge.id}
                className="flex items-center justify-between bg-gray-800/50 rounded-xl px-3 py-2.5"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0"
                    style={{ backgroundColor: challenge.opponent?.avatarColor || '#6366f1' }}
                  >
                    {challenge.opponent?.displayName?.charAt(0).toUpperCase() || '?'}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-white truncate">
                      {challenge.opponent?.displayName || 'Unknown'}
                    </p>
                    <p className="text-[10px] text-gray-400">
                      <span className="text-yellow-400">Pending</span>
                      {challenge.blindLevel ? ` · BB ${challenge.blindLevel}` : ''}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => handleCancelChallenge(challenge.id)}
                  className="px-3 py-1.5 bg-gray-700 text-gray-300 text-xs rounded-lg hover:bg-gray-600 transition-all active:scale-95"
                >
                  Cancel
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Error display */}
      {error && (
        <div className="bg-red-900/40 border border-red-800/50 rounded-xl p-3 text-red-300 text-sm">
          <span>⚠️ {error}</span>
        </div>
      )}
    </div>
  );
}

// ─── Main Lobby Component ──────────────────────────────────
export default function Lobby({ onEnterClub, displayName, userId, onLogout }) {
  const [mode, setMode] = useState(null); // null | 'create' | 'join' | 'challenges'
  const [inviteCode, setInviteCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleEnterChallengeClub = useCallback((data) => {
    // Called when a challenge is accepted - navigates to club room
    if (data.clubId && data.userId && data.seatIndex !== undefined) {
      onEnterClub(data, displayName);
    }
  }, [onEnterClub, displayName]);

  const handleCreateClub = async () => {
    setError('');
    setLoading(true);

    const socket = connect();
    if (!socket) {
      setError('Not authenticated. Please log in again.');
      setLoading(false);
      return;
    }

    socket.emit('create_club', {}, (err, data) => {
      setLoading(false);
      if (err) {
        setError(err.error || 'Failed to create club');
        return;
      }
      onEnterClub(data, displayName);
    });
  };

  const handleJoinClub = async () => {
    if (!inviteCode.trim()) {
      setError('Please enter an invite code');
      return;
    }
    setError('');
    setLoading(true);

    const socket = connect();
    if (!socket) {
      setError('Not authenticated. Please log in again.');
      setLoading(false);
      return;
    }

    socket.emit('join_club', { inviteCode: inviteCode.trim() }, (err, data) => {
      setLoading(false);
      if (err) {
        setError(err.error || 'Failed to join club');
        return;
      }
      onEnterClub(data, displayName);
    });
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-950 via-gray-900 to-gray-950 flex items-start justify-center p-4 pt-8">
      {/* Background decorative elements */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-80 h-80 bg-poker-gold/5 rounded-full blur-3xl" />
        <div className="absolute -bottom-40 -left-40 w-80 h-80 bg-felt/10 rounded-full blur-3xl" />
      </div>

      {/* Logout button */}
      <button
        onClick={onLogout}
        className="absolute top-4 right-4 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs rounded-lg transition-all active:scale-95"
      >
        Logout
      </button>

      <div className="relative w-full max-w-md">
        {/* Logo / Header */}
        <div className="text-center mb-6 animate-fade-in">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-gradient-to-br from-felt to-felt-dark border-2 border-poker-gold/30 shadow-xl shadow-felt/20 mb-4">
            <span className="text-4xl">🃏</span>
          </div>
          <h1 className="text-4xl font-bold font-display text-white mb-2">
            Poker Club
          </h1>
          <p className="text-gray-400 text-sm">
            Welcome back, <span className="text-poker-gold font-semibold">{displayName}</span>
          </p>
        </div>

        {/* Menu / Tab bar */}
        {!mode && (
          <div className="space-y-3 animate-slide-up">
            <button
              onClick={() => setMode('create')}
              className="btn-primary w-full text-lg py-4 flex items-center justify-center gap-3"
            >
              <span>🎲</span>
              Create New Club
            </button>
            <button
              onClick={() => setMode('join')}
              className="btn-secondary w-full text-lg py-4 flex items-center justify-center gap-3"
            >
              <span>🔑</span>
              Join with Code
            </button>
            <button
              onClick={() => { setMode('challenges'); setError(''); }}
              className="w-full py-3 bg-gray-800 hover:bg-gray-700 text-white rounded-xl font-semibold transition-all active:scale-95 flex items-center justify-center gap-2"
            >
              <span>⚔️</span>
              Challenges
            </button>
          </div>
        )}

        {/* Create Club Mode */}
        {mode === 'create' && (
          <div className="animate-slide-up">
            <button
              onClick={handleCreateClub}
              disabled={loading}
              className="btn-primary w-full text-lg py-4 flex items-center justify-center gap-3"
            >
              {loading ? (
                <span className="inline-block w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <><span>🃏</span> Deal Me In!</>
              )}
            </button>
            <button
              onClick={() => { setMode(null); setError(''); }}
              className="w-full mt-3 text-gray-400 hover:text-white text-sm transition-colors py-2"
            >
              ← Back
            </button>
          </div>
        )}

        {/* Join Club Mode */}
        {mode === 'join' && (
          <div className="space-y-3 animate-slide-up">
            <div className="bg-gray-900/70 backdrop-blur-sm rounded-2xl border border-gray-800 p-6">
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Enter Club Code
              </label>
              <input
                type="text"
                value={inviteCode}
                onChange={(e) => {
                  setInviteCode(e.target.value.toUpperCase().slice(0, 6));
                  setError('');
                }}
                onKeyDown={(e) => e.key === 'Enter' && handleJoinClub()}
                placeholder="e.g. ABC123"
                maxLength={6}
                className="input-field text-center text-2xl font-mono tracking-[0.3em]"
                autoFocus
              />
              <p className="text-xs text-gray-500 mt-1 text-center">
                6-character code
              </p>
            </div>

            <button
              onClick={handleJoinClub}
              disabled={loading}
              className="btn-primary w-full text-lg py-4 flex items-center justify-center gap-3"
            >
              {loading ? (
                <span className="inline-block w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <><span>🚪</span> Enter Club</>
              )}
            </button>

            <button
              onClick={() => { setMode(null); setInviteCode(''); setError(''); }}
              className="w-full mt-1 text-gray-400 hover:text-white text-sm transition-colors py-2"
            >
              ← Back
            </button>
          </div>
        )}

        {/* Challenges Mode */}
        {mode === 'challenges' && (
          <div className="animate-slide-up">
            <ChallengePanel onEnterChallengeClub={handleEnterChallengeClub} />
            <button
              onClick={() => { setMode(null); setError(''); }}
              className="w-full mt-3 text-gray-400 hover:text-white text-sm transition-colors py-2"
            >
              ← Back
            </button>
          </div>
        )}

        {/* Error Display */}
        {error && (
          <div className="mt-4 bg-red-900/40 border border-red-800/50 rounded-xl p-4 text-red-300 text-sm animate-fade-in">
            <div className="flex items-center gap-2">
              <span>⚠️</span>
              <span>{error}</span>
            </div>
          </div>
        )}

        {/* Footer */}
        <p className="text-center text-xs text-gray-600 mt-8">
          Private • No real money • Just friends
        </p>
      </div>
    </div>
  );
}
