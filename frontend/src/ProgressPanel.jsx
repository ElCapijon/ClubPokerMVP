import React, { useState, useEffect, useCallback } from 'react';
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
  const { name, description, targetValue, progress, isCompleted, stat } = quest;
  const pct = Math.min(100, Math.round((progress / targetValue) * 100));
  const progressLabel = isCompleted ? '✓' : `${progress}/${targetValue}`;

  // Color coding by stat group (case-sensitive — stat names are camelCase)
  const statColor =
    stat === 'handsPlayed' ? 'from-blue-600 to-blue-500' :
    stat === 'handsWon' || stat.startsWith('showdown') ? 'from-green-600 to-green-500' :
    stat.endsWith('Seen') ? 'from-cyan-600 to-cyan-500' :
    stat === 'foldsMade' || stat === 'callsMade' ? 'from-gray-600 to-gray-500' :
    stat === 'raisesMade' || stat === 'betsMade' || stat === 'allInsMade' ? 'from-purple-600 to-purple-500' :
    stat.endsWith('Made') ? 'from-amber-600 to-amber-500' :
    'from-gray-600 to-gray-500';

  return (
    <div className={`relative overflow-hidden rounded-xl border transition-all duration-300 ${
      isCompleted
        ? 'border-poker-gold/40 bg-gradient-to-br from-yellow-900/20 to-amber-900/10'
        : 'border-gray-800 bg-gray-800/30 hover:bg-gray-800/50'
    }`}>
      <div className="p-3">
        <div className="flex items-start justify-between gap-2 mb-1.5">
          <div className="min-w-0">
            <p className={`text-sm font-semibold truncate ${isCompleted ? 'text-poker-gold' : 'text-white'}`}>
              {name}
            </p>
            <p className="text-[10px] text-gray-500 truncate">{description}</p>
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
            className={`h-full rounded-full transition-all duration-700 ease-out bg-gradient-to-r ${statColor} ${
              isCompleted ? 'animate-pulse' : ''
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </div>
  );
}

// ─── Formatting helpers ─────────────────────────────────────
function fmtChips(n) {
  const num = Number(n) || 0;
  if (Math.abs(num) >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (Math.abs(num) >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toLocaleString();
}

function fmtSigned(n) {
  const num = Number(n) || 0;
  const s = fmtChips(Math.abs(num));
  return num > 0 ? `+${s}` : num < 0 ? `-${s}` : s;
}

// ─── Progression Table ──────────────────────────────────────
// A clean row in the all-time totals table.
function StatRow({ icon, label, value, accent, sub }) {
  const color =
    accent === 'green' ? 'text-green-400' :
    accent === 'red' ? 'text-red-400' :
    accent === 'gold' ? 'text-poker-gold' :
    accent === 'blue' ? 'text-blue-400' :
    accent === 'purple' ? 'text-purple-400' :
    'text-white';

  return (
    <div className="flex items-center justify-between px-3 py-2 bg-gray-800/30 border border-gray-800/60 rounded-lg
                    hover:bg-gray-800/60 transition-colors duration-200">
      <div className="flex items-center gap-2.5 min-w-0">
        <span className="text-sm shrink-0">{icon}</span>
        <div className="min-w-0">
          <p className="text-[10px] text-gray-400 uppercase tracking-wider truncate">{label}</p>
          {sub && <p className="text-[9px] text-gray-600 leading-none mt-0.5 truncate">{sub}</p>}
        </div>
      </div>
      <p className={`text-sm font-bold font-mono tabular-nums shrink-0 ${color}`}>{value}</p>
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <h3 className="text-[10px] font-bold text-gray-500 uppercase tracking-widest px-1 mt-1 mb-1.5">
      {children}
    </h3>
  );
}

function ProgressionTable({ s }) {
  const handsPlayed = s.handsPlayed || 0;
  const handsWon = s.handsWon || 0;
  const winRate = handsPlayed > 0 ? Math.round((handsWon / handsPlayed) * 100) : 0;
  const showdownWinsPct = s.showdownsReached > 0
    ? Math.round(((s.showdownsWon || 0) / s.showdownsReached) * 100)
    : 0;
  const vpip = handsPlayed > 0
    ? Math.round((((s.calls || 0) + (s.raises || 0)) / handsPlayed) * 100)
    : 0;

  return (
    <div className="space-y-1">
      {/* Net Profit banner */}
      <div className={`rounded-xl border p-3 flex items-center justify-between mb-3 ${
        (s.netProfit || 0) >= 0
          ? 'border-green-700/40 bg-gradient-to-r from-green-900/30 to-emerald-900/10'
          : 'border-red-800/40 bg-gradient-to-r from-red-900/30 to-rose-900/10'
      }`}>
        <div>
          <p className="text-[10px] text-gray-400 uppercase tracking-wider">Net Profit / Loss</p>
          <p className={`text-2xl font-bold font-mono ${(s.netProfit || 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {fmtSigned(s.netProfit)}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[10px] text-gray-400 uppercase tracking-wider">Win Rate</p>
          <p className="text-xl font-bold text-poker-gold">{winRate}%</p>
          <p className="text-[9px] text-gray-500">{handsWon} won / {handsPlayed} played</p>
        </div>
      </div>

      {/* Hands */}
      <SectionLabel>🎮 Hands</SectionLabel>
      <StatRow icon="🃏" label="Hands Played" value={fmtChips(handsPlayed)} accent="blue" />
      <StatRow icon="🏆" label="Hands Won" value={fmtChips(handsWon)} accent="gold" sub={`${winRate}% win rate`} />
      <StatRow icon="🌸" label="Flops Seen" value={fmtChips(s.flopsSeen)} accent="blue" sub={handsPlayed > 0 ? `${Math.round(((s.flopsSeen || 0) / handsPlayed) * 100)}% of hands` : undefined} />

      {/* Actions — the big progression table */}
      <SectionLabel>🎯 Actions</SectionLabel>
      <StatRow icon="🙈" label="Folded" value={fmtChips(s.folds)} />
      <StatRow icon="📞" label="Called" value={fmtChips(s.calls)} />
      <StatRow icon="📈" label="Raised" value={fmtChips(s.raises)} />
      <StatRow icon="🤝" label="Checked" value={fmtChips(s.checks)} />
      <StatRow icon="🔥" label="All-Ins" value={fmtChips(s.allIns)} accent="red" />
      <StatRow icon="🎚️" label="Voluntary Put In Pot" value={`${vpip}%`} accent="purple" sub="calls + raises per hand" />

      {/* Chips */}
      <SectionLabel>💸 Chips</SectionLabel>
      <StatRow icon="💵" label="Blinds Paid" value={fmtChips(s.blindsPaid)} accent="red" />
      <StatRow icon="💰" label="Total Wagered" value={fmtChips(s.totalWagered)} accent="gold" />
      <StatRow icon="🛡️" label="Biggest Pot Won" value={fmtChips(s.biggestPotWon)} accent="green" />

      {/* Showdowns */}
      <SectionLabel>⚔️ Showdowns</SectionLabel>
      <StatRow icon="🎭" label="Showdowns Reached" value={fmtChips(s.showdownsReached)} />
      <StatRow icon="🥇" label="Showdowns Won" value={fmtChips(s.showdownsWon)} accent="gold" />
      <StatRow icon="📐" label="Showdown Win Rate" value={`${showdownWinsPct}%`} accent="green" />
      <StatRow icon="✨" label="Best Hand Made" value={s.bestHandName || 'High Card'} accent="purple" sub={s.bestHandRank ? `rank ${s.bestHandRank}` : undefined} />
    </div>
  );
}

// ─── Main Panel ─────────────────────────────────────────────
export default function ProgressPanel() {
  const [tab, setTab] = useState('quests'); // 'quests' | 'progression'
  const [quests, setQuests] = useState([]);
  const [stats, setStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [questError, setQuestError] = useState('');
  const [statsError, setStatsError] = useState('');
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
      setQuestError('');
    } catch (err) {
      setQuestError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch all-time stats
  const fetchStats = useCallback(async () => {
    const token = getToken();
    if (!token) {
      setStatsLoading(false);
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/stats`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      setStats(data.stats);
      setStatsError('');
    } catch (err) {
      // Non-critical — keep quests view usable
      setStatsError(err.message);
    } finally {
      setStatsLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    fetchQuests();
    fetchStats();
  }, [fetchQuests, fetchStats]);

  // Live socket updates
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const onChallengeCompleted = (data) => {
      setToastChallenge(data);
      fetchQuests();
    };

    const onHandComplete = () => {
      fetchStats();
      fetchQuests();
    };

    // Debounce game_state_sync: only refetch quests at most once every 30s
    const onGameStateSync = (() => {
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
    socket.on('hand_complete', onHandComplete);
    socket.on('game_state_sync', onGameStateSync);

    return () => {
      socket.off('challenge_completed', onChallengeCompleted);
      socket.off('hand_complete', onHandComplete);
      socket.off('game_state_sync', onGameStateSync);
    };
  }, [fetchQuests, fetchStats]);

  const dismissToast = useCallback(() => setToastChallenge(null), []);

  // Stats
  const totalQuests = quests.length;
  const completedQuests = quests.filter(q => q.isCompleted).length;
  const handsPlayed = (stats && stats.handsPlayed) || 0;

  // Categorize quests by stat name, sort by group size (largest first)
  const byStat = {};
  for (const q of quests) {
    if (!byStat[q.stat]) byStat[q.stat] = [];
    byStat[q.stat].push(q);
  }
  const sortedStats = Object.keys(byStat).sort((a, b) => byStat[b].length - byStat[a].length);

  const statLabel = (stat) => {
    return stat.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
  };

  return (
    <>
      {/* Toast notification for challenge completion */}
      {toastChallenge && (
        <CompletionToast challenge={toastChallenge} onDismiss={dismissToast} />
      )}

      {/* Toggle Button (single floating icon) */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="fixed bottom-4 right-4 z-50 flex items-center gap-2 px-4 py-2.5
                   bg-gradient-to-r from-yellow-700 to-amber-700 text-white
                   rounded-full shadow-xl shadow-black/30 hover:from-yellow-600 hover:to-amber-600
                   transition-all duration-200 active:scale-95"
        title={`${completedQuests}/${totalQuests} quests completed · ${handsPlayed} hands played`}
      >
        <span className="text-sm leading-none">🎯</span>
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
                          overflow-hidden flex flex-col animate-slide-up">
            {/* Header with tabs */}
            <div className="shrink-0 px-4 pt-3 pb-0 border-b border-gray-800">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-base">🎯</span>
                  <h2 className="text-base font-bold text-white">Progress</h2>
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

              {/* Tabs */}
              <div className="flex gap-1">
                <button
                  onClick={() => setTab('quests')}
                  className={`flex-1 py-2 rounded-t-lg text-sm font-semibold transition-all duration-200 ${
                    tab === 'quests'
                      ? 'bg-gray-800/80 text-poker-gold border-b-2 border-poker-gold'
                      : 'text-gray-500 hover:text-gray-300'
                  }`}
                >
                  Quests {totalQuests > 0 && <span className="text-[10px] opacity-70">({completedQuests}/{totalQuests})</span>}
                </button>
                <button
                  onClick={() => setTab('progression')}
                  className={`flex-1 py-2 rounded-t-lg text-sm font-semibold transition-all duration-200 ${
                    tab === 'progression'
                      ? 'bg-gray-800/80 text-poker-gold border-b-2 border-poker-gold'
                      : 'text-gray-500 hover:text-gray-300'
                  }`}
                >
                  All-Time Totals
                </button>
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-4">
              {loading && tab === 'quests' && (
                <div className="flex items-center justify-center py-8">
                  <div className="w-6 h-6 border-2 border-poker-gold/30 border-t-poker-gold rounded-full animate-spin" />
                </div>
              )}

              {tab === 'quests' && questError && (
                <div className="bg-red-900/30 border border-red-800/50 rounded-xl p-3 text-red-300 text-xs mb-3">
                  {questError}
                </div>
              )}
              {tab === 'progression' && statsError && (
                <div className="bg-red-900/30 border border-red-800/50 rounded-xl p-3 text-red-300 text-xs mb-3">
                  {statsError}
                </div>
              )}

              {tab === 'quests' && (
                <div className="space-y-4">
                  {!loading && quests.length === 0 && (
                    <div className="text-center py-6">
                      <p className="text-gray-500 text-sm">No quests available yet.</p>
                      <p className="text-gray-600 text-xs mt-1">Run the database migration to seed quest definitions.</p>
                    </div>
                  )}

                  {!loading && sortedStats.map(stat => (
                    <div key={stat}>
                      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                        {statLabel(stat)}
                      </h3>
                      <div className="space-y-2">
                        {byStat[stat].map(q => (
                          <QuestCard key={q.id} quest={q} />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {tab === 'progression' && (
                <div className="space-y-4">
                  {statsLoading ? (
                    <div className="flex items-center justify-center py-8">
                      <div className="w-6 h-6 border-2 border-poker-gold/30 border-t-poker-gold rounded-full animate-spin" />
                    </div>
                  ) : !stats ? (
                    <div className="text-center py-6">
                      <p className="text-gray-500 text-sm">No hands tracked yet.</p>
                      <p className="text-gray-600 text-xs mt-1">Play a few hands and your all-time totals will show up here.</p>
                    </div>
                  ) : (
                    <>
                      <ProgressionTable s={stats} />
                      <p className="text-[10px] text-gray-600 text-center pt-1">
                        Lifetime totals — updates after every completed hand.
                      </p>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
