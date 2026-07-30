# 🃏 Club Poker MVP — Architecture & Codebase Guide

> **Version:** 1.0.0  
> **Deployed at:** [https://clubpokermvp.onrender.com](https://clubpokermvp.onrender.com)  
> **Source:** [https://github.com/ElCapijon/ClubPokerMVP](https://github.com/ElCapijon/ClubPokerMVP)

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Directory Structure](#2-directory-structure)
3. [Tech Stack](#3-tech-stack)
4. [Backend Architecture](#4-backend-architecture)
   - [4.1 Server Entry Point (index.js)](#41-server-entry-point-indexjs)
   - [4.2 Game Hand Manager (GameHand.js)](#42-game-hand-manager-gamehandjs)
   - [4.3 Hand Evaluator (HandEvaluator.js)](#43-hand-evaluator-handevaluatorjs)
   - [4.4 Pot Splitter (PotSplitter.js)](#44-pot-splitter-potsplitterjs)
   - [4.5 Deck (Deck.js)](#45-deck-deckjs)
   - [4.6 Bot Player AI (botPlayer.js)](#46-bot-player-ai-botplayerjs)
   - [4.7 Invite Code Generator (InviteCode.js)](#47-invite-code-generator-invitecodejs)
   - [4.8 Database (db.js & migrate.js)](#48-database-dbjs--migratejs)
5. [Frontend Architecture](#5-frontend-architecture)
   - [5.1 Application Entry (App.jsx)](#51-application-entry-appjsx)
   - [5.2 Lobby (Lobby.jsx)](#52-lobby-lobbyjsx)
   - [5.3 Club Room (ClubRoom.jsx)](#53-club-room-clubroomjsx)
   - [5.4 Socket Client (socket.js)](#54-socket-client-socketjs)
   - [5.5 Styling (index.css)](#55-styling-indexcss)
6. [Game Loop Flow](#6-game-loop-flow)
7. [Socket Events Reference](#7-socket-events-reference)
8. [Database Schema](#8-database-schema)
9. [Deployment](#9-deployment)
10. [Testing](#10-testing)

---

## 1. Project Overview

Club Poker MVP is a real-time, 6-max Texas Hold'em poker application designed for private play among friends. The server is authoritative — all game logic runs server-side, and clients are "dumb terminals" that display state and send actions.

**Core Principles:**
- ✅ Server is authoritative (all game math on the backend)
- ✅ Real-time via WebSockets (Socket.io)
- ✅ Mobile-first responsive UI
- ❌ No AI bots (just simple test bots)
- ❌ No real-money transactions

---

## 2. Directory Structure

```
club-poker-mvp/
├── backend/                        # Node.js + Express + Socket.io server
│   ├── __tests__/                  # Jest test suites
│   │   ├── BotPlayer.test.js
│   │   ├── Deck.test.js
│   │   ├── GameHand.test.js
│   │   ├── HandEvaluator.test.js
│   │   ├── Phase4Actions.test.js
│   │   ├── Phase5Showdown.test.js
│   │   ├── Phase6Reconnection.test.js
│   │   └── PotSplitter.test.js
│   ├── .env                        # Environment variables (DATABASE_URL)
│   ├── botPlayer.js                # Simple bot AI
│   ├── db.js                       # PostgreSQL connection pool
│   ├── Deck.js                     # Card deck builder & shuffler
│   ├── GameHand.js                 # Single hand lifecycle & state machine
│   ├── HandEvaluator.js            # 7-card hand evaluation engine
│   ├── index.js                    # Main server: Express + Socket.io + game loop
│   ├── InviteCode.js               # 6-character alphanumeric code generator
│   ├── migrate.js                  # Database migration script
│   ├── package.json
│   └── PotSplitter.js              # Side pot & winner determination
├── frontend/                       # Vite + React + Tailwind CSS client
│   ├── dist/                       # Production build output
│   ├── public/
│   ├── src/
│   │   ├── App.jsx                 # Root component with session management
│   │   ├── ClubRoom.jsx            # Main game room (table, seats, controls)
│   │   ├── index.css               # Tailwind base + custom styling + animations
│   │   ├── Lobby.jsx               # Create/join club screen
│   │   ├── main.jsx                # React entry point
│   │   └── socket.js               # Socket.io client singleton
│   ├── index.html
│   ├── package.json
│   ├── postcss.config.js
│   ├── tailwind.config.js
│   └── vite.config.js
├── package.json                    # Root workspace scripts
├── Procfile                        # Render.com process definition
├── render.yaml                     # Render.com infrastructure blueprint
├── DEPLOY.md                       # Deployment instructions
└── ARCHITECTURE.md                 # ← This file
```

---

## 3. Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Runtime** | Node.js 18+ | Server-side JavaScript runtime |
| **Framework** | Express 4 | HTTP server, static file serving, health checks |
| **Real-time** | Socket.io 4 | WebSocket-based bidirectional communication |
| **Database** | PostgreSQL (Neon) | Persist users, clubs, hand histories |
| **Client** | React 18 | UI components and state management |
| **Bundler** | Vite 5 | Fast dev server and production builds |
| **Styling** | Tailwind CSS 3 | Utility-first responsive styling |
| **Testing** | Jest 30 | Backend unit and integration tests |

---

## 4. Backend Architecture

### 4.1 Server Entry Point (`index.js`)

The main server file is a single large module (~600 lines) that handles:

**Express Setup:**
- Static file serving for the production frontend build (`frontend/dist/`)
- CORS configuration for development (Vite dev server at port 5173)
- HTTPS redirect in production (trusts proxy headers from Render)
- Health check endpoint at `/api/health`

**In-Memory State Stores** (all state is in memory — database is for persistence only):

| Store | Type | Purpose |
|-------|------|---------|
| `clubs` | `Map<clubId, ClubState>` | All active clubs with seats, game state |
| `socketToPlayer` | `Map<socketId, {clubId, userId, seatIndex}>` | Maps socket connections to players |
| `handCounters` | `Map<clubId, number>` | Hand number for dealer rotation |
| `disconnectTimeouts` | `Map<"clubId:userId", timeoutId>` | 60s auto-fold timers for disconnected players |
| `actionTimers` | `Map<clubId, timeoutId>` | Per-turn action timers |
| `lastActions` | `Map<clubId, actionRecord>` | Last action for UI display |

**Club State Structure:**
```javascript
{
  id: "uuid",
  inviteCode: "A7X9B2",
  hostId: "user-uuid",
  seats: [
    { userId, userName, stack: 1500, isReady, isConnected, isSittingOut, isBot? },
    null,  // empty seat
    // ... up to 6 seats
  ],
  tableSettings: { sb: 10, bb: 20, startingStack: 1500, timer: 20, allowRebuys: true },
  gameState: "WAITING" | "PREFLOP" | "FLOP" | "TURN" | "RIVER" | "SHOWDOWN",
  currentHand: null | HandObject,
  createdAt: timestamp
}
```

**Socket Event Handlers:**

| Event | Handler |
|-------|---------|
| `create_club` | Generate code, create ClubState, persist to DB, join socket room |
| `join_club` | Find club by code, assign seat, join room |
| `start_game` | Validate host, create & start hand (delegate to GameHand.js) |
| `player_action` | Validate turn/action, delegate to GameHand.handleAction, broadcast |
| `player_ready` | Toggle ready status, check for auto-start |
| `rejoin_club` | Reconnect player to existing club & game |
| `player_rebuy` | Reset busted player's stack |
| `add_bots` | Fill empty seats with bot players (host only) |
| `remove_bots` | Clear bot seats (host only) |
| `player_sit_out` | Toggle sitting out status |
| `send_emoji` | Broadcast emoji to room |
| `disconnect` | Mark disconnected, set 60s auto-fold timeout |

**Key Functions:**

- **`broadcastGameState(clubId)`**: Sends public game state to all players plus private hole cards to each individual player via `your_hole_cards` event. This is the primary state sync mechanism.
- **`setActionTimer(clubId)`**: Sets a timer for the current player. If it's a bot, processes their action after 0.8-2s. If it's a human, auto-folds after the configured timer (default 20s).
- **`checkAutoStart(clubId)`**: Automatically starts the game when all seated players are ready (called after `player_ready`, `add_bots`, or when seats fill).
- **`recordAction(clubId, seatIndex, action, amount)`**: Records and broadcasts the last action for UI display.

**Hand Completion Flow:**
1. Player acts → round completes → showdown or all but one fold
2. `hand_complete` event emitted with winners, hole cards, stacks
3. Hand history persisted to database (non-blocking)
4. After 12-second delay → next hand created → broadcast game state

**Disconnect Handling:**
- Player disconnects mid-hand → 60-second grace period
- If they reconnect within 60s → everything restored
- If not → auto-fold their hand and mark as "Sitting Out"

---

### 4.2 Game Hand Manager (`GameHand.js`)

This module manages a single hand's lifecycle. It is a **pure state machine** — it takes state and returns new state without side effects.

**Game States:**
```
WAITING → PREFLOP → FLOP → TURN → RIVER → SHOWDOWN → HAND_COMPLETE → (next hand) PREFLOP
```

**Functions:**

| Function | Purpose |
|----------|---------|
| `createHand(clubState, handCount)` | Creates a hand from club state. Filters out disconnected, sitting out, and busted players. Assigns dealer based on handCount for rotation. |
| `startHand(hand)` | Shuffles deck, deals 2 hole cards each, posts blinds, sets first turn (UTG). |
| `handleAction(hand, seatIndex, action, amount)` | Core action processor. Validates turn, processes fold/check/call/raise, manages pot, checks for all-in, advances round/street/showdown. |
| `advanceStreet(hand)` | Advances PREFLOP→FLOP→TURN→RIVER→SHOWDOWN. Burns a card before dealing each street. Resets round bets and `hasActed` flags. |
| `goToShowdown(hand)` | Evaluates all active players' hands, calls PotSplitter to determine winners, awards pot to stacks, sets gameStatus to HAND_COMPLETE. |
| `getNextActivePlayerIndex(hand, fromIndex)` | Returns the next player clockwise who hasn't folded or gone all-in. |
| `isRoundComplete(hand)` | Checks: all non-all-in players acted and matched bet, OR only 1 player remains, OR all remaining are all-in. |
| `getPublicState(hand)` | Returns game state without any hole cards (safe for broadcasting). |
| `getPrivateState(hand, seatIndex)` | Returns hole cards for a specific player. |
| `getReconnectionSnapshot(hand, seatIndex)` | Combines public state + private hole cards for reconnecting players. |

**Blind Posting:**
- Small Blind = player left of dealer (min of SB amount and player's stack)
- Big Blind = next player after SB (min of BB amount and player's stack)
- SB posts and `hasActed` is set to true (pre-flop only)
- BB posts and `hasActed` is set to true (pre-flop only)
- First to act pre-flop = player left of BB (UTG)
- First to act post-flop = first active player left of dealer

**Action Validation:**
- Checks it's the player's turn
- Checks player hasn't folded
- Checks player isn't already all-in
- Validates check (no bet to call)
- Validates minimum raise (must be >= currentBet + minRaise)
- Validates bet (can't bet if there's already a bet — must use raise)

---

### 4.3 Hand Evaluator (`HandEvaluator.js`)

A brute-force 7-card hand evaluator that checks all C(7,5) = 21 combinations to find the best 5-card hand.

**Hand Rankings (1-9):**

| Rank | Name | Example |
|------|------|---------|
| 9 | Straight Flush | A♥ K♥ Q♥ J♥ 10♥ |
| 8 | Four of a Kind | A♠ A♥ A♦ A♣ 2♠ |
| 7 | Full House | A♠ A♥ A♦ K♠ K♥ |
| 6 | Flush | A♠ 10♠ 7♠ 4♠ 2♠ |
| 5 | Straight | 9♠ 8♥ 7♦ 6♣ 5♠ |
| 4 | Three of a Kind | A♠ A♥ A♦ K♠ Q♥ |
| 3 | Two Pair | A♠ A♥ K♠ K♥ Q♦ |
| 2 | One Pair | A♠ A♥ K♠ Q♥ J♦ |
| 1 | High Card | A♠ K♥ Q♦ J♣ 9♠ |

**Key Functions:**

| Function | Purpose |
|----------|---------|
| `evaluate5Cards(cards)` | Evaluates a single 5-card hand. Checks straight flush → quads → full house → flush → straight → trips → two pair → pair → high card. Returns `{ rank, rankName, kickers, handCards }`. |
| `evaluateHand(handCards, communityCards)` | Combines 2 hole + 5 community = 7 cards. Generates all 21 combinations, finds the best one. |
| `compareHands(handA, handB)` | Compares two hands: first by rank, then by kicker values lexicographically. |
| `rankHands(playerHands)` | Sorts multiple hands best-first with proper tie handling. |

**Edge Cases Handled:**
- Wheel straight: A-2-3-4-5 (5-high straight)
- Broadway straight: A-K-Q-J-10 (ace-high straight)
- Suit detection across all 7 cards
- Kicker comparison for ties

---

### 4.4 Pot Splitter (`PotSplitter.js`)

Handles main pot + side pot calculations when players are all-in with different bet amounts.

**Key Functions:**

| Function | Purpose |
|----------|---------|
| `calculateSidePots(players)` | Sorts players by bet amount ascending. For each unique bet threshold, creates a pot where eligible players are those who bet ≥ that threshold. Returns `[{ potAmount, eligiblePlayerIndices, level }]`. |
| `determineWinners(players, communityCards)` | Full pipeline: calculate side pots → evaluate each player's hand → rank hands → award each pot to best-ranked eligible player(s). Handles ties by splitting evenly (remainder distributed 1 chip at a time). |

**Side Pot Algorithm:**
1. Sort active players by total bet (ascending)
2. For each unique bet amount threshold:
   a. Each remaining player contributes (currentBet - previousBet)
   b. Eligible players = all who bet ≥ currentBet
   c. Awards: best hand among eligible players wins this pot
3. Main pot = the first (lowest) pot, side pots = subsequent ones

**Winner Algorithm:**
1. Evaluate each active player's best hand from 2 hole + 5 community
2. Sort hands by rank (best first)
3. For each pot: find best-ranked player among eligible players
4. Split pot among tied winners (remainder distributed chip-by-chip)

---

### 4.5 Deck (`Deck.js`)

Standard 52-card deck utilities.

**Card Structure:**
```javascript
{ suit: "hearts", suitSymbol: "♥", rankName: "A", value: 14, key: "AH" }
```

**Functions:**
- `createDeck()` — Generates all 52 cards (4 suits × 13 ranks)
- `shuffle(deck)` — Fisher-Yates shuffle (returns new array, doesn't mutate)
- `dealCards(deck, numPlayers)` — For testing: deals hole cards, flop, turn, river, burns
- `cardToString(card)`, `handToString(cards)` — Display helpers

**Value Mapping:** 2→2, 3→3, ..., 10→10, J→11, Q→12, K→13, A→14

---

### 4.6 Bot Player AI (`botPlayer.js`)

Simple bots for testing the game flow. Bots make decisions based on hand strength and pot odds.

**Bot Names:** Rotates through a pool of 5 names: Alice, Bob, Charlie, Diana, Evan (prefixed with 🤖).

**Hand Strength Heuristic:**
- Pre-flop: evaluates pocket pairs, high cards, suitedness, gaps
- Post-flop: uses the actual `evaluateHand` function, normalized to 0-1
- Random factor (±0.1) adds variety

**Decision Logic:**
- If no bet to call: check (weak) or bet ½-¾ pot (strong)
- If there's a bet: compare hand strength to pot odds
- Very strong hands (strength > 0.85): sometimes raise
- Very weak hands (strength < 0.2): fold
- Borderline: call small bets, fold big ones (with some randomness)

**Important:** These are not genuine AI opponents — they're test tools to fill seats and advance the game flow.

---

### 4.7 Invite Code Generator (`InviteCode.js`)

Generates a **6-character alphanumeric code** using `crypto.randomBytes`.

**Character Set:** `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (excludes I, O, 0, 1 to avoid confusion between similar characters).

Codes are checked for uniqueness against in-memory clubs and the database before assignment.

---

### 4.8 Database (`db.js` & `migrate.js`)

**Connection:** `db.js` creates a PostgreSQL `Pool` using `DATABASE_URL` from environment variables. Uses Neon (serverless PostgreSQL).

**Migration:** `migrate.js` creates three tables (see [Section 8](#8-database-schema) for full schema).

The database is **secondary** to in-memory state. It's used for:
- Persisting club records (so invite codes survive restarts)
- Storing hand histories for future replay features
- User deduplication

Database failures are **non-fatal**: the game continues with in-memory state alone.

---

## 5. Frontend Architecture

### 5.1 Application Entry (`App.jsx`)

The root component manages view routing and session persistence.

**State:**
- `view`: `'lobby'` | `'club'` | `'reconnecting'`
- `clubData`: Session data (clubId, inviteCode, userId, seatIndex)
- `displayName`: Current player's display name

**Session Persistence:**
- Saves session to `localStorage` after creating/joining a club
- On mount: checks for saved session and auto-reconnects
- Clears session on leave

**Reconnection Flow:**
1. Load session from localStorage
2. Show "Reconnecting..." screen with spinning card emoji
3. Call `socket.emit('rejoin_club', ...)` with saved clubId/userId
4. On success → transition to ClubRoom
5. On failure → show "Session Expired" with "Back to Lobby" button
6. 10-second connection timeout as safety net

**Views:**
- `'lobby'` → renders `<Lobby>` component
- `'club'` → renders `<ClubRoom>` component
- `'reconnecting'` → renders inline reconnection UI

---

### 5.2 Lobby (`Lobby.jsx`)

The landing screen with two modes:

**Create Mode:**
- Input for display name
- "Create New Club" button → emits `create_club` → receives invite code + club ID
- Shows generated invite code in large font with copy button
- Provides share link with pre-formatted text

**Join Mode:**
- Input for display name
- Input for 6-character invite code (auto-uppercased)
- "Join Club" button → emits `join_club` → joins game room

**State Management:**
- Uses Socket.io callbacks for create/join (not event listeners)
- On success: calls parent `onEnterClub(data, name)` callback
- Name is persisted across sessions via App.jsx

---

### 5.3 Club Room (`ClubRoom.jsx`)

The main game interface (~600 lines of React). This is the most complex component.

**State (20+ state variables):**

| Category | State | Purpose |
|----------|-------|---------|
| Lobby | `players` | Array of 6 seat objects |
| | `gameState` | WAITING, PREFLOP, FLOP, TURN, RIVER, SHOWDOWN |
| | `isConnected` | Connection status |
| Game | `communityCards` | 5 community card objects |
| | `holeCards` | Your 2 hole cards |
| | `pot`, `currentBet`, `minRaise` | Pot and bet tracking |
| | `currentPlayerSeatIndex` | Whose turn it is |
| | `dealerSeatIndex` | Dealer position |
| | `handCount` | Current hand number |
| | `handResult` | Showdown results overlay |
| Action | `lastAction` | Last action text display |
| | `actionTimeRemaining`, `actionTimerTotal` | Turn timer |
| UI | `emojiTrayOpen`, `floatingEmojis` | Emoji chat |
| | `betSliderValue` | Bet sizing slider |
| | `notifications` | Toast notifications |

**Sub-Components:**

| Component | Purpose |
|-----------|---------|
| `Card` | Renders a playing card (face-up or face-down). Supports 4 sizes (xl=64×90, lg=50×72, md=40×56, sm=32×46). Includes deal animation with staggered delay. |
| `EmojiBubble` | Floating emoji that appears above a player's seat and fades out over 2.5s. |

**Table Layout:**
- Container: `max-w-[800px]` with `aspect-[4/3]`
- Felt oval: `rounded-[50%]` with 12px wooden rail border, radial green gradient, 3D box-shadows
- 6 seat positions calculated with ellipse math: `((x-50)/44)² + ((y-50)/42)² = 1`
- Seats hug the ellipse edge (side seats at x=10% and x=90%)
- Community cards: 5 cards displayed in the upper-center of the felt
- Pot display: pill-shaped badge below community cards

**Seat Positions (6-max, clockwise from bottom-center):**

```
       Seat 3 (8%, 50%)
          ↑ Top

Seat 2 (32%, 10%)     Seat 4 (32%, 90%)
  ↑ Left rail            ↑ Right rail

Seat 1 (68%, 10%)     Seat 5 (68%, 90%)
  ↑ Left rail            ↑ Right rail

       Seat 0 (91%, 50%)
        ↑ Hero (You)
```

**Empty Seats:** Display a face-down card back at 30% opacity with "Seat N" label.

**Your Hole Cards:** Displayed LARGE (64×90) in the bottom controls area, separate from your avatar on the table.

**Action Controls (bottom bar):**
- **Fold** (red), **Check/Call** (yellow/blue), **Raise/Bet** (purple)
- Bet presets: ½ Pot, ¾ Pot, Pot
- Custom bet slider (range input with gold thumb)
- All-In button (orange)
- Buttons disabled when not your turn
- Turn timer countdown (red pulse when ≤5s)

**Watiting State Controls:**
- Toggle Ready / Not Ready
- Sit Out / Back In
- Rebuy (when busted)
- Start Game (host only)
- 🤖 Fill Bots (host only)
- Remove Bots (host only)

**Socket Handlers (inside useEffect):**

| Event | Handler |
|-------|---------|
| `club_state_update` | Update players array, game state |
| `game_state_sync` | Update community cards, pot, current bet, turn, timer, players (public) |
| `your_hole_cards` | Update your hole cards |
| `full_state_snapshot` | Full state on reconnection |
| `hand_complete` | Show showdown results, reveal all hole cards, clear last action |
| `last_action` | Display last action text |
| `emoji_received` | Spawn floating emoji above player's seat |

**Bet Sizing Logic:**
```
minBetValue = if currentBet > 0:
                min(currentBet + minRaise, myStack + currentPlayerBet)
              else:
                minRaise
maxBetValue = myStack + currentPlayerBet
getBetPreset(fraction) = if currentBet > 0:
                           min(floor(pot * fraction) + currentBet, maxBetValue)
                         else:
                           min(floor(pot * fraction) || minRaise, myStack)
```

---

### 5.4 Socket Client (`socket.js`)

Manages a singleton Socket.io connection.

```javascript
let socket = null;

export function connect() { /* Create or return existing socket */ }
export function disconnect() { /* Disconnect and nullify */ }
export function getSocket() { /* Get or create socket */ }
```

**Connection URL Logic:**
```
VITE_SOCKET_URL → if set, use that
else if production (PROD) → use '' (same origin)
else → 'http://localhost:3000'
```

---

### 5.5 Styling (`index.css`)

Built on **Tailwind CSS** with custom component classes and animations.

**Custom Component Classes:**

| Class | Purpose |
|-------|---------|
| `.btn-primary` | Gold gradient button |
| `.btn-secondary` | Gray gradient button |
| `.btn-danger` | Red gradient button |
| `.action-btn-fold/check/call` | In-game action buttons (red/yellow/blue) |
| `.preset-btn` | Small bet preset buttons |
| `.bet-slider` | Styled range input with gold thumb |
| `.card-back` | Blue-gradient card back with diagonal line pattern |
| `.card-front` | White card face with subtle gradient |
| `.felt-table` | Oval table with wooden rail, 3D shadows, green felt |
| `.poker-chip` | Gold chip styling for bet badges |

**Custom Animations:**

| Animation | Duration | Purpose |
|-----------|----------|---------|
| `cardDealt` | 0.35s | Cards sliding in with rotation |
| `cardBackDeal` | 0.25s | Face-down cards appearing |
| `chipStack` | 0.4s | Pot/badge appearing with bounce |
| `emojiFloat` | 2.0s | Emoji floating up and fading |
| `bounceSubtle` | 2.0s | Dealer button bouncing |
| `pulseTurn` | 1.5s | Active player glow pulsing |
| `slideUp / slideDown` | 0.3s | Panels and notifications |

**Responsive Design:**
- Mobile-first breakpoints at 640px
- Touch-friendly hit targets (min 36px height on mobile)
- Larger slider thumb on mobile (18px)
- Scrollbar custom styling

---

## 6. Game Loop Flow

```
1. WAITING STATE
   ↓ Players ready up or host clicks "Start"
   
2. START GAME
   ↓ createHand() → filter active players → rotate dealer
   ↓ startHand() → shuffle deck → deal 2 cards → post blinds
   
3. PREFLOP (UTG acts first)
   ↓ Each player: fold/check/call/raise → next player
   ↓ Round complete? → advance to FLOP   OR   everyone folds → SHOWDOWN
   
4. FLOP (3 community cards dealt)
   ↓ First active player left of dealer acts
   ↓ Round complete? → advance to TURN
   
5. TURN (1 more community card)
   ↓ Same as above → advance to RIVER
   
6. RIVER (5th community card)
   ↓ Same as above → SHOWDOWN
   
7. SHOWDOWN
   ↓ evaluateHand() for each active player
   ↓ calculateSidePots() for all-in scenarios
   ↓ determineWinners() → award pots
   ↓ handResult = HAND_COMPLETE
   
8. HAND COMPLETE
   ↓ Broadcast hand_complete with winners
   ↓ 12-second delay
   ↓ Return to step 2 (next hand, dealer rotates)
```

---

## 7. Socket Events Reference

### Client → Server

| Event | Payload | Response |
|-------|---------|----------|
| `create_club` | `{ displayName }` | callback: `{ clubId, inviteCode, userId, seatIndex }` |
| `join_club` | `{ displayName, inviteCode }` | callback: `{ clubId, inviteCode, userId, seatIndex }` |
| `rejoin_club` | `{ clubId, userId }` | callback: `{ clubId, inviteCode, userId, seatIndex }` |
| `start_game` | `{ clubId }` | callback: `{ success }` or `{ error }` |
| `player_action` | `{ clubId, action, amount? }` | callback: `{ success }` or `{ error }` |
| `player_ready` | `{ clubId }` | (none — broadcast follows) |
| `player_rebuy` | `{ clubId }` | callback: `{ success }` or `{ error }` |
| `add_bots` | `{ clubId }` | callback: `{ botsAdded }` or `{ error }` |
| `remove_bots` | `{ clubId }` | callback: `{ botsRemoved }` or `{ error }` |
| `player_sit_out` | `{ clubId }` | callback: `{ success }` or `{ error }` |
| `send_emoji` | `{ clubId, emoji }` | (none — broadcast follows) |

### Server → Client

| Event | Payload | When |
|-------|---------|------|
| `club_state_update` | `{ clubId, inviteCode, players, hostId, tableSettings, gameState }` | Lobby state changes (player join/leave/ready) |
| `game_state_sync` | Public state: community cards, pot, current bet, turn, timer, player stacks (no hole cards) | Every game state change |
| `your_hole_cards` | `{ holeCards: [card1, card2] }` | Sent to each player individually after game_state_sync |
| `full_state_snapshot` | game_state_sync + holeCards | On reconnection only |
| `hand_complete` | `{ handResult, communityCards, players[] (with holeCards, stacks) }` | When a hand ends |
| `last_action` | `{ seatIndex, userName, action, amount, timestamp }` | After every player action |
| `emoji_received` | `{ seatIndex, userName, emoji, timestamp }` | When any player sends an emoji |
| `connect_error` | (error) | On socket connection failure |

---

## 8. Database Schema

Three tables in a PostgreSQL (Neon) database:

```sql
-- Users (minimal — just enough for names and foreign keys)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name VARCHAR(20) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Clubs / Rooms
CREATE TABLE clubs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invite_code VARCHAR(6) UNIQUE NOT NULL,
    host_user_id UUID REFERENCES users(id),
    small_blind INT DEFAULT 10,
    big_blind INT DEFAULT 20,
    starting_stack INT DEFAULT 1500,
    action_timer_seconds INT DEFAULT 20,
    allow_rebuys BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Hand Histories (for replay and analytics)
CREATE TABLE hand_histories (
    id SERIAL PRIMARY KEY,
    club_id UUID REFERENCES clubs(id),
    final_board JSONB,
    players_in_hand JSONB,
    pot_splits JSONB,
    played_at TIMESTAMP DEFAULT NOW()
);
```

Run the migration: `cd backend && npm run migrate`

---

## 9. Deployment

**Platform:** Render.com

**Backend (Web Service):**
- Start command: `cd backend && npm start`
- Node version: >=18.0.0
- Environment variables: `DATABASE_URL`, `NODE_ENV=production`, `CORS_ORIGIN`

**Frontend:**
- Built as part of the deploy: `cd frontend && npm install && npm run build`
- Served statically by the Express server from `frontend/dist/`
- The root `render.yaml` blueprint defines both services

**Config Files:**
- `Procfile` — Render process type definition
- `render.yaml` — Infrastructure-as-code blueprint
- `package.json` (root) — Contains build/start scripts for Render

**Build Script (from root package.json):**
```json
"scripts": {
  "install:all": "cd backend && npm install && cd ../frontend && npm install",
  "build:frontend": "cd frontend && npm run build",
  "build": "npm run build:frontend",
  "start": "cd backend && npm run start"
}
```

**Environment Variables:**
| Variable | Where | Purpose |
|----------|-------|---------|
| `DATABASE_URL` | Backend | PostgreSQL connection string (Neon) |
| `NODE_ENV` | Backend | `production` to serve static frontend |
| `CORS_ORIGIN` | Backend | For development CORS |
| `PORT` | Backend | Server port (Render sets this automatically) |
| `VITE_SOCKET_URL` | Frontend build | Override WebSocket URL (optional) |

---

## 10. Testing

**Test Framework:** Jest 30

**Test Suites (8 total, 135 tests):**

| Suite | Tests | Coverage |
|-------|-------|----------|
| `Deck.test.js` | 10 | Deck creation, shuffle, deal functions |
| `HandEvaluator.test.js` | 28 | All hand ranks, kicker comparison, edge cases (wheel, broadway) |
| `GameHand.test.js` | 30 | Hand lifecycle, blinds, turn order, street advancement, showdown |
| `PotSplitter.test.js` | 8 | Side pot calculation, winner determination, ties |
| `Phase4Actions.test.js` | 20 | All-in scenarios, min raise, call/fold edges, full hand simulation |
| `Phase5Showdown.test.js` | 7 | Rebuy system, side pot accuracy, full showdown |
| `Phase6Reconnection.test.js` | 9 | Snapshot, public/private state, disconnect |
| `BotPlayer.test.js` | 10 | Bot names, hand strength, decision making |

**Run Tests:**
```bash
cd backend && npm test          # All tests
cd backend && npx jest --verbose  # Verbose output
cd backend && npx jest --coverage  # With coverage report
```

---

## Key Design Decisions

### Why In-Memory State Instead of Database-First?
The game updates state 10-20 times per second during active play. Using PostgreSQL for every state change would introduce unacceptable latency. Instead, all game state lives in Maps in the Node.js process, and the database is only used for:
- Persisting clubs across server restarts
- Storing hand histories for future replay features
- Ensuring invite codes are unique

### Why a 12-Second Showdown Delay?
Previously the delay was 5 seconds, which made showdown results flash by too quickly for players to read. Extended to 12 seconds to give:
- Time to see all revealed hole cards
- Time to read the hand result overlay (winner, amount, hand rank)
- A natural pause before the next hand begins

### Why Socket.io Instead of Raw WebSockets?
Socket.io provides:
- Automatic reconnection with exponential backoff
- Rooms (channel-based broadcasting)
- Fallback to long-polling if WebSockets aren't available
- Emit/callback pattern for request-response flows
- Built-in event multiplexing

### Why Ellipse-Based Seat Positions Instead of Circular?
A 4:3 aspect ratio table with `rounded-[50%]` creates an ellipse, not a circle. Using circular seat positions would leave side seats floating inside the felt. Ellipse-hugging positions (calculated with different rx and ry radii) ensure seats visually hug the rail, matching the look of professional poker clients.

---

*Generated for Club Poker MVP — July 2026*
