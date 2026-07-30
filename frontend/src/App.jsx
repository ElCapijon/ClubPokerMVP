import React, { useState, useCallback, useEffect } from 'react';
import Lobby from './Lobby';
import ClubRoom from './ClubRoom';
import QuestPanel from './QuestPanel';
import { connect, disconnect, getSocket } from './socket';
import { saveAuth, loadAuth, clearAuth, getToken, getUser } from './auth';

// Session storage keys
const SESSION_KEY = 'poker_club_session';

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveSession(data) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(data));
  } catch {
    // Storage full or unavailable
  }
}

function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // Ignore
  }
}

const API_BASE = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? '' : 'http://localhost:3000');

export default function App() {
  const [view, setView] = useState('auth');
  const [authView, setAuthView] = useState('login');
  const [gameData, setGameData] = useState(null);
  const [displayName, setDisplayName] = useState('');
  const [reconnectError, setReconnectError] = useState('');

  useEffect(() => {
    // Migration cleanup: clear old-format data from before ring games migration
    try {
      const oldSession = localStorage.getItem('poker_club_session');
      if (oldSession) {
        const parsed = JSON.parse(oldSession);
        // Old format had clubId/inviteCode, new format uses gameId
        if (parsed && parsed.clubId && !parsed.gameId) {
          localStorage.removeItem('poker_club_session');
          localStorage.removeItem('poker_club_auth');
          console.log('[App] Cleared old-format session and auth data (migration)');
        }
      }
    } catch (e) { /* ignore */ }

    const auth = loadAuth();
    if (auth && auth.token && auth.user) {
      setDisplayName(auth.user.displayName || '');

      const session = loadSession();
      if (session && session.gameId && session.userId) {
        attemptReconnect(session);
      } else {
        setView('lobby');
      }
    } else {
      setView('auth');
    }
  }, []);

  const attemptReconnect = useCallback((session) => {
    setView('reconnecting');

    const token = getToken();
    if (!token) {
      setView('auth');
      return;
    }

    const socket = connect();
    if (!socket) {
      setReconnectError('Authentication required');
      clearSession();
      setTimeout(() => setView('auth'), 2000);
      return;
    }

    let connectionTimedOut = false;

    const connectionTimeout = setTimeout(() => {
      connectionTimedOut = true;
      socket.off('connect', onConnect);
      socket.off('connect_error', onError);
      setReconnectError('Could not reach server');
      clearSession();
      disconnect();
    }, 10000);

    const onConnect = () => {
      clearTimeout(connectionTimeout);
      if (connectionTimedOut) return;
      socket.off('connect_error', onError);

      socket.emit('rejoin_ring_game', {
        gameId: session.gameId,
      }, (err, data) => {
        if (err) {
          console.log('[Reconnect] Session expired:', err.error);
          setReconnectError(err.error || 'Session expired');
          clearSession();
          disconnect();
          setTimeout(() => {
            setView('lobby');
            setReconnectError('');
          }, 2000);
          return;
        }
        setGameData(data);
        setDisplayName(getUser()?.displayName || '');
        setView('club');
      });
    };

    const onError = () => {
      if (!connectionTimedOut) {
        clearTimeout(connectionTimeout);
        setReconnectError('Connection failed');
        clearSession();
        disconnect();
        setTimeout(() => {
          setView('auth');
          setReconnectError('');
        }, 2000);
      }
    };

    socket.once('connect', onConnect);
    socket.once('connect_error', onError);
  }, []);

  const handleEnterClub = useCallback((data, name) => {
    saveSession({
      gameId: data.gameId || data.clubId,
      userId: data.userId,
      seatIndex: data.seatIndex,
      displayName: name,
    });
    setGameData(data);
    setDisplayName(name);
    setView('club');
  }, []);

  const handleLeaveClub = useCallback(() => {
    clearSession();
    disconnect();
    setGameData(null);
    setView('lobby');
  }, []);

  // ─── Auth Handlers ──────────────────────────────────────────

  const handleRegister = useCallback(async ({ email, displayName, password }) => {
    const res = await fetch(`${API_BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, displayName, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Registration failed');
    saveAuth(data.user, data.token);
    setDisplayName(data.user.displayName);
    setView('lobby');
  }, []);

  const handleLogin = useCallback(async ({ email, password }) => {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    saveAuth(data.user, data.token);
    setDisplayName(data.user.displayName);
    setView('lobby');
  }, []);

  // =============================================================
  // RENDER
  // =============================================================

  // Reconnecting view
  if (view === 'reconnecting') {
    return (
      <div className="min-h-screen bg-gradient-to-b from-gray-950 via-gray-900 to-gray-950 flex items-center justify-center p-4">
        <div className="text-center animate-fade-in">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-gradient-to-br from-felt to-felt-dark border-2 border-poker-gold/30 shadow-xl shadow-felt/20 mb-6">
            <span className="text-4xl animate-spin">🃏</span>
          </div>
          <h2 className="text-xl font-bold font-display text-white mb-2">
            {reconnectError ? 'Session Expired' : 'Reconnecting...'}
          </h2>
          <p className="text-gray-400 text-sm">
            {reconnectError
              ? reconnectError
              : 'Trying to get you back to the table...'}
          </p>
          {reconnectError && (
            <button
              onClick={() => { clearSession(); setView('lobby'); setReconnectError(''); disconnect(); }}
              className="mt-6 px-6 py-3 bg-gray-800 text-white font-semibold rounded-xl hover:bg-gray-700 transition-all duration-200"
            >
              Back to Lobby
            </button>
          )}
        </div>
      </div>
    );
  }

  // Club view
  if (view === 'club' && gameData) {
    return (
      <>
        <ClubRoom
          clubData={gameData}
          displayName={displayName}
          onLeave={handleLeaveClub}
          onLogout={handleLogout}
        />
        <QuestPanel />
      </>
    );
  }

  // Lobby view
  if (view === 'lobby') {
    return (
      <>
        <Lobby
          onEnterClub={handleEnterClub}
          displayName={displayName}
          userId={getUser()?.id}
          onLogout={handleLogout}
        />
        <QuestPanel />
      </>
    );
  }

  // ─── Auth View (Login / Signup) ──────────────────────────────
  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-950 via-gray-900 to-gray-950 flex items-center justify-center p-4">
      {/* Background decorative elements */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-80 h-80 bg-poker-gold/5 rounded-full blur-3xl" />
        <div className="absolute -bottom-40 -left-40 w-80 h-80 bg-felt/10 rounded-full blur-3xl" />
      </div>

      <div className="relative w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-6 animate-fade-in">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-gradient-to-br from-felt to-felt-dark border-2 border-poker-gold/30 shadow-xl shadow-felt/20 mb-4">
            <span className="text-4xl">🃏</span>
          </div>
          <h1 className="text-4xl font-bold font-display text-white mb-2">
            Poker Club
          </h1>
          <p className="text-gray-400 text-sm">
            {authView === 'login' ? 'Welcome back!' : 'Create your account'}
          </p>
        </div>

        {/* Auth Form */}
        <div className="bg-gray-900/70 backdrop-blur-sm rounded-2xl border border-gray-800 p-6 animate-slide-up">
          {authView === 'login' ? (
            <LoginForm
              onLogin={handleLogin}
              onSwitch={() => setAuthView('signup')}
            />
          ) : (
            <SignupForm
              onRegister={handleRegister}
              onSwitch={() => setAuthView('login')}
            />
          )}
        </div>

        <p className="text-center text-xs text-gray-600 mt-8">
          Club Poker MVP
        </p>
      </div>
    </div>
  );
}

// ─── Login Form ──────────────────────────────────────────────
function LoginForm({ onLogin, onSwitch }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email || !password) {
      setError('Please fill in all fields');
      return;
    }
    setError('');
    setLoading(true);
    try {
      await onLogin({ email, password });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <h2 className="text-xl font-bold text-white text-center mb-2">Sign In</h2>

      <div>
        <label className="block text-sm font-medium text-gray-300 mb-1">Email</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="input-field"
          autoFocus
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-300 mb-1">Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          className="input-field"
        />
      </div>

      {error && (
        <div className="bg-red-900/40 border border-red-800/50 rounded-xl p-3 text-red-300 text-sm">
          <div className="flex items-center gap-2">
            <span>⚠️</span>
            <span>{error}</span>
          </div>
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        className="btn-primary w-full py-3 flex items-center justify-center gap-2"
      >
        {loading ? (
          <span className="inline-block w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
        ) : (
          <>
            <span>🔐</span>
            Sign In
          </>
        )}
      </button>

      <p className="text-center text-sm text-gray-400">
        Don't have an account?{' '}
        <button type="button" onClick={onSwitch}
          className="text-poker-gold hover:text-yellow-400 font-medium transition-colors">
          Sign Up
        </button>
      </p>
    </form>
  );
}

// ─── Signup Form ─────────────────────────────────────────────
function SignupForm({ onRegister, onSwitch }) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email || !displayName || !password) {
      setError('Please fill in all fields');
      return;
    }
    if (displayName.length > 20) {
      setError('Display name must be 20 characters or less');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }
    setError('');
    setLoading(true);
    try {
      await onRegister({ email, displayName: displayName.trim(), password });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <h2 className="text-xl font-bold text-white text-center mb-2">Create Account</h2>

      <div>
        <label className="block text-sm font-medium text-gray-300 mb-1">Email</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="input-field"
          autoFocus
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-300 mb-1">Display Name</label>
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value.slice(0, 20))}
          placeholder="Your poker name"
          maxLength={20}
          className="input-field"
        />
        <p className="text-xs text-gray-500 mt-1">{displayName.length}/20 characters</p>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-300 mb-1">Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="At least 6 characters"
          className="input-field"
        />
      </div>

      {error && (
        <div className="bg-red-900/40 border border-red-800/50 rounded-xl p-3 text-red-300 text-sm">
          <div className="flex items-center gap-2">
            <span>⚠️</span>
            <span>{error}</span>
          </div>
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        className="btn-primary w-full py-3 flex items-center justify-center gap-2"
      >
        {loading ? (
          <span className="inline-block w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
        ) : (
          <>
            <span>🎉</span>
            Create Account
          </>
        )}
      </button>

      <p className="text-center text-sm text-gray-400">
        Already have an account?{' '}
        <button type="button" onClick={onSwitch}
          className="text-poker-gold hover:text-yellow-400 font-medium transition-colors">
          Sign In
        </button>
      </p>
    </form>
  );
}
