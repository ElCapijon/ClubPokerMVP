import React, { useState, useCallback, useEffect } from 'react';
import Lobby from './Lobby';
import ClubRoom from './ClubRoom';
import { connect, disconnect, getSocket } from './socket';

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

export default function App() {
  const [view, setView] = useState('lobby'); // 'lobby' | 'club' | 'reconnecting'
  const [clubData, setClubData] = useState(null);
  const [displayName, setDisplayName] = useState('');
  const [reconnectError, setReconnectError] = useState('');

  // On mount: check for saved session and auto-reconnect
  useEffect(() => {
    const session = loadSession();
    if (session && session.clubId && session.userId) {
      setDisplayName(session.displayName || '');
      attemptReconnect(session);
    }
  }, []);

  const attemptReconnect = useCallback((session) => {
    setView('reconnecting');

    const socket = connect();
    let connectionTimedOut = false;

    // If connection takes too long, show expired state
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

      // Clean up error listener so it doesn't fire mid-game
      socket.off('connect_error', onError);

      socket.emit('rejoin_club', {
        clubId: session.clubId,
        userId: session.userId,
      }, (err, data) => {
        if (err) {
          // Club or player not found — session is stale
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
        // Successfully reconnected
        setClubData(data);
        setDisplayName(session.displayName || '');
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
          setView('lobby');
          setReconnectError('');
        }, 2000);
      }
    };

    socket.once('connect', onConnect);
    socket.once('connect_error', onError);
    socket.connect();
  }, []);

  const handleEnterClub = useCallback((data, name) => {
    // Save session to localStorage for reconnection
    saveSession({
      clubId: data.clubId,
      inviteCode: data.inviteCode,
      userId: data.userId,
      seatIndex: data.seatIndex,
      displayName: name,
    });
    setClubData(data);
    setDisplayName(name);
    setView('club');
  }, []);

  const handleLeaveClub = useCallback(() => {
    clearSession();
    disconnect();
    setClubData(null);
    setDisplayName('');
    setView('lobby');
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      // Don't disconnect on unmount — we want to persist the connection
    };
  }, []);

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

  if (view === 'club' && clubData) {
    return (
      <ClubRoom
        clubData={clubData}
        displayName={displayName}
        onLeave={handleLeaveClub}
      />
    );
  }

  return (
    <Lobby
      onEnterClub={handleEnterClub}
      displayName={displayName}
      setDisplayName={setDisplayName}
    />
  );
}
