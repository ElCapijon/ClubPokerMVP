import React, { useState, useEffect, useCallback, useRef } from 'react';
import { getSocket } from './socket';
import { getToken } from './auth';

const API_BASE = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? '' : 'http://localhost:3000');

// ─── Completion Toast ───────────────────────────────────────
function CompletionToast({ challenge, onDismiss }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 5000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[60] w-full max-w-sm px-4 animate-slide-up pointer-events-auto">
      <div className="bg-gradient-to-r from-yellow-900/95 via-amber-900/95 to-yellow-900/95 backdrop-blur-md
                      rounded-2xl border border-poker-gold/40 p-4 shadow-2xl shadow-poker-gold/10 text-center">
        <div className="flex flex-col items-center gap-1">
          <span className="text-3xl animate-bounce">{challenge.badge || '⭐'}</span>
          <h3 className="text-base font-bold text-poker-gold">Challenge Complete!</h3>
          <p className="text-sm text-white/90">{challenge.name}</p>
          {challenge.description && (
            <p className="text-xs text-gray-400 mt-0.5">{challenge.description}</p>
          )}
          <button
            onClick={onDismiss}
            className="mt-2 px-4 py-1 bg-white/10 hover:bg-white/20 text-white text-xs rounded-full transition-all"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Quest Card ─────────────────────────────────────────────
function QuestCard({ quest }) {
  const { name, description, targetValue, progress, isCompleted, rewardBadge, category } = quest;
  const pct = Math.min(100, Math.round((progress / targetValue) * 100));
  const progressLabel = isCompleted ? '✓' : `${progress}/${targetValue}`;

  // Color coding by category
  const categoryColor =
    category === 'hand_rank' ? 'from-blue-600 to-blue-500' :
    category === 'volume'    ? 'from-green-600 to-green-500' :
    category === 'wagering'  ? 'from-purple-600 to-purple-500' :
                               'from-gray-600 to-gray-500';

  return (
    <div className={`relative overflow-hidden rounded-xl border transition-all duration-300 ${
      isCompleted
        ? 'border-poker-gold/40 bg-gradient-to-br from-yellow-900/20 to-amber-900/10'
        : 'border-gray-800 bg-gray-800/30 hover:bg-gray-800/50'
    }`}>
      <div className="p-3">
        <div className="flex items-start justify-between gap-2 mb-1.5">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-lg shrink-0">{rewardBadge || '⭐'}</span>
            <div className="min-w-0">
              <p className={`text-sm font-semibold truncate ${isCompleted ? 'text-poker-gold' : 'text-white'}`}>
                {name}
              </p>
              <p className="text-[10px] text-gray-500 truncate">{description}</p>
            </div>
          </div>
          <span className={`shrink-0 text-xs font-mono font-bold px-2 py-0.5 rounded-full ${
            isCompleted
              ? 'bg-poker-gold/20 text-poker-gold'
              : 'bg-gray-700/50 text-gray-300'
          }`}>
            {progressLabel}
          </span>
        </div>

        {/* Progress Bar */}
        <div className="w-full h-2 bg-gray-700/50 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-700 ease-out bg-gradient-to-r ${categoryColor} ${
              isCompleted ? 'animate-pulse' : ''
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>

        {/* Sparkle overlay on completion */}
        {isCompleted && (
          <div className="absolute inset-0 pointer-events-none">
            <div className="absolute top-1 left-3 text-[8px] opacity-60 animate-ping">✨</div>
            <div className="absolute bottom-1 right-3 text-[8px] opacity-60 animate-ping delay-150">✨</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Quest Panel ────────────────────────────────────────────
export default function QuestPanel() {
  const [quests, setQuests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [toastChallenge, setToastChallenge] = useState(null);

  // Fetch quest progress via REST API
  const fetchQuests = useCallback(async () => {
    const token = getToken();
    if (!token) {
      setLoading(false);
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/api/challenges`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      setQuests(data.challenges || []);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    fetchQuests();
  }, [fetchQuests]);

  // Listen for real-time completion events
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const onChallengeCompleted = (data) => {
      setToastChallenge(data);
      // Refetch to update progress
      fetchQuests();
    };

    const onGameStateSync = (() => {
      // Debounce: only refetch at most once every 30 seconds
      let lastFetch = 0;
      return () => {
        const now = Date.now();
        if (now - lastFetch > 30000) {
          lastFetch = now;
          fetchQuests();
        }
      };
    })();

    socket.on('challenge_completed', onChallengeCompleted);
    socket.on('game_state_sync', onGameStateSync);

    return () => {
      socket.off('challenge_completed', onChallengeCompleted);
      socket.off('game_state_sync', onGameStateSync);
    };
  }, [fetchQuests]);

  const dismissToast = useCallback(() => setToastChallenge(null), []);

  // Stats
  const totalQuests = quests.length;
  const completedQuests = quests.filter(q => q.isCompleted).length;

  // Categorize
  const byCategory = (cat) => quests.filter(q => q.category === cat);
  const handRankQuests = byCategory('hand_rank');
  const volumeQuests = byCategory('volume');
  const wageringQuests = byCategory('wagering');

  const categoryIcon = (cat) => {
    if (cat === 'hand_rank') return '♠️';
    if (cat === 'volume') return '🔄';
    if (cat === 'wagering') return '💰';
    return '📋';
  };

  const categoryLabel = (cat) => {
    if (cat === 'hand_rank') return 'Hand Ranks';
    if (cat === 'volume') return 'Volume';
    if (cat === 'wagering') return 'Wagering';
    return cat;
  };

  return (
    <>
      {/* Toast notification for challenge completion */}
      {toastChallenge && (
        <CompletionToast challenge={toastChallenge} onDismiss={dismissToast} />
      )}

      {/* Toggle Button (mini floating badge) */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="fixed bottom-4 right-4 z-50 flex items-center gap-2 px-4 py-2.5
                   bg-gradient-to-r from-yellow-700 to-amber-700 text-white
                   rounded-full shadow-xl shadow-black/30 hover:from-yellow-600 hover:to-amber-600
                   transition-all duration-200 active:scale-95"
        title={`${completedQuests}/${totalQuests} quests completed`}
      >
        <span className="text-base">🏆</span>
        <span className="text-xs font-bold">{completedQuests}/{totalQuests}</span>
      </button>

      {/* Panel Overlay */}
      {expanded && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center pointer-events-none">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm pointer-events-auto"
            onClick={() => setExpanded(false)}
          />

          {/* Panel */}
          <div className="relative pointer-events-auto w-full sm:max-w-lg max-h-[80vh] sm:max-h-[70vh]
                          bg-gray-900/95 backdrop-blur-md border-t sm:border border-gray-800
                          rounded-t-2xl sm:rounded-2xl shadow-2xl shadow-black/40
                          overflow-hidden flex flex-col">
            {/* Header */}
            <div className="shrink-0 px-4 py-3 border-b border-gray-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xl">🏆</span>
                <h2 className="text-base font-bold text-white">Quests</h2>
                <span className="text-xs text-gray-500">
                  ({completedQuests}/{totalQuests} complete)
                </span>
              </div>
              <button
                onClick={() => setExpanded(false)}
                className="text-gray-500 hover:text-white transition-colors p-1"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {loading && (
                <div className="flex items-center justify-center py-8">
                  <div className="w-6 h-6 border-2 border-poker-gold/30 border-t-poker-gold rounded-full animate-spin" />
                </div>
              )}

              {error && (
                <div className="bg-red-900/30 border border-red-800/50 rounded-xl p-3 text-red-300 text-xs">
                  ⚠️ {error}
                </div>
              )}

              {!loading && quests.length === 0 && (
                <div className="text-center py-6">
                  <p className="text-gray-500 text-sm">No quests available yet.</p>
                  <p className="text-gray-600 text-xs mt-1">Run the database migration to seed quest definitions.</p>
                </div>
              )}

              {!loading && (
                <>
                  {/* Hand Ranks */}
                  {handRankQuests.length > 0 && (
                    <div>
                      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                        <span>{categoryIcon('hand_rank')}</span> {categoryLabel('hand_rank')}
                      </h3>
                      <div className="space-y-2">
                        {handRankQuests.map(q => (
                          <QuestCard key={q.id} quest={q} />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Volume */}
                  {volumeQuests.length > 0 && (
                    <div>
                      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                        <span>{categoryIcon('volume')}</span> {categoryLabel('volume')}
                      </h3>
                      <div className="space-y-2">
                        {volumeQuests.map(q => (
                          <QuestCard key={q.id} quest={q} />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Wagering */}
                  {wageringQuests.length > 0 && (
                    <div>
                      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                        <span>{categoryIcon('wagering')}</span> {categoryLabel('wagering')}
                      </h3>
                      <div className="space-y-2">
                        {wageringQuests.map(q => (
                          <QuestCard key={q.id} quest={q} />
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
