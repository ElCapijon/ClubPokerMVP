import React, { useState } from 'react';
import { connect } from './socket';

export default function Lobby({ onEnterClub, displayName, setDisplayName }) {
  const [mode, setMode] = useState(null); // null | 'create' | 'join'
  const [inviteCode, setInviteCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleCreateClub = async () => {
    if (!displayName.trim()) {
      setError('Please enter a display name');
      return;
    }
    setError('');
    setLoading(true);

    const socket = connect();
    socket.emit('create_club', { displayName: displayName.trim() }, (err, data) => {
      setLoading(false);
      if (err) {
        setError(err.error || 'Failed to create club');
        return;
      }
      onEnterClub(data, displayName.trim());
    });
  };

  const handleJoinClub = async () => {
    if (!displayName.trim()) {
      setError('Please enter a display name');
      return;
    }
    if (!inviteCode.trim()) {
      setError('Please enter an invite code');
      return;
    }
    setError('');
    setLoading(true);

    const socket = connect();
    socket.emit('join_club', { displayName: displayName.trim(), inviteCode: inviteCode.trim() }, (err, data) => {
      setLoading(false);
      if (err) {
        setError(err.error || 'Failed to join club');
        return;
      }
      onEnterClub(data, displayName.trim());
    });
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-950 via-gray-900 to-gray-950 flex items-center justify-center p-4">
      {/* Background decorative elements */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-80 h-80 bg-poker-gold/5 rounded-full blur-3xl" />
        <div className="absolute -bottom-40 -left-40 w-80 h-80 bg-felt/10 rounded-full blur-3xl" />
      </div>

      <div className="relative w-full max-w-md">
        {/* Logo / Header */}
        <div className="text-center mb-8 animate-fade-in">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-gradient-to-br from-felt to-felt-dark border-2 border-poker-gold/30 shadow-xl shadow-felt/20 mb-4">
            <span className="text-4xl">🃏</span>
          </div>
          <h1 className="text-4xl font-bold font-display text-white mb-2">
            Poker Club
          </h1>
          <p className="text-gray-400 text-sm">
            Private tables for you and your friends
          </p>
        </div>

        {/* Display Name Input */}
        <div className="bg-gray-900/70 backdrop-blur-sm rounded-2xl border border-gray-800 p-6 mb-4 animate-slide-up">
          <label className="block text-sm font-medium text-gray-300 mb-2">
            Your Display Name
          </label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value.slice(0, 20));
              setError('');
            }}
            onKeyDown={(e) => e.key === 'Enter' && mode === 'join' && handleJoinClub()}
            placeholder="Enter your name..."
            maxLength={20}
            className="input-field text-lg"
            autoFocus
          />
          <p className="text-xs text-gray-500 mt-1">
            {displayName.length}/20 characters
          </p>
        </div>

        {/* Mode Selection */}
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
                <>
                  <span>🃏</span>
                  Deal Me In!
                </>
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
                <>
                  <span>🚪</span>
                  Enter Club
                </>
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
