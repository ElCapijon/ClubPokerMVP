const {
  GAME_STATES, createHand, startHand, handleAction,
  advanceCompleteRoundStep, applyShowdownDecision, canMuckNow,
  getPublicState, buildShowdownOrder, startShowdown,
} = require('../GameHand');

function createClubState() {
  return {
    id: 'test-club-1',
    seats: [
      { userId: 'u1', userName: 'Alice', stack: 1500, isConnected: true, isSittingOut: false },
      { userId: 'u2', userName: 'Bob', stack: 1500, isConnected: true, isSittingOut: false },
      { userId: 'u3', userName: 'Charlie', stack: 1500, isConnected: true, isSittingOut: false },
      null, null, null,
    ],
    hostId: 'u1',
    tableSettings: { sb: 10, bb: 20, startingStack: 1500, timer: 20, allowRebuys: true },
  };
}

function cc(rank, suit) {
  const values = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13, A: 14 };
  const suitFull = { h: 'hearts', d: 'diamonds', c: 'clubs', s: 'spades' };
  const suitSymbols = { h: '♥', d: '♦', c: '♣', s: '♠' };
  return {
    rankName: rank,
    suit: suitFull[suit],
    value: values[rank],
    suitSymbol: suitSymbols[suit],
    key: `${rank}${suit.toUpperCase()}`,
  };
}

// Board: A♣ K♠ Q♥ 2♦ 3♣ — no pair on board
const BOARD = [cc('A', 'c'), cc('K', 's'), cc('Q', 'h'), cc('2', 'd'), cc('3', 'c')];

// On that board: A♠A♦ → Trips (Aces, best). A♥K♥ → Two Pair (second). 9♠8♠ → High Card (worst).
const TRIPS_ACES = [cc('A', 's'), cc('A', 'd')];
const TWO_PAIR_AK = [cc('A', 'h'), cc('K', 'h')];
const HIGH_CARD = [cc('9', 's'), cc('8', 's')];

/**
 * Drive every live player to the SHOWDOWN phase by calling/checking down.
 */
function checkDownToShowdown(hand) {
  let guard = 0;
  while (hand.gameStatus !== GAME_STATES.SHOWDOWN && hand.gameStatus !== GAME_STATES.HAND_COMPLETE && guard < 20) {
    guard++;
    const seat = hand.players[hand.currentPlayerIndex]?.seatIndex;
    if (seat === undefined) break;
    const r = handleAction(hand, seat, 'check');
    if (r.error) throw new Error(`check failed: ${r.error}`);
  }
  return hand;
}

/** Resolve the reveal queue — every decider shows (or mucks) in order. */
function completeShowdown(hand, show = true) {
  let guard = 0;
  while (hand.gameStatus === GAME_STATES.SHOWDOWN && guard < 10) {
    guard++;
    const seat = hand.showdown.queue[hand.showdown.queuePos];
    const r = applyShowdownDecision(hand, seat, show);
    if (r.error) throw new Error(`decision failed: ${r.error}`);
  }
  return hand;
}

/** Manually stage a finished hand (bets placed, board out) for startShowdown. */
function stageShowdown(hand, { holeCards = {}, allIn = [], folded = [], lastRaiser = -1 } = {}) {
  hand.communityCards = BOARD.map(c => ({ ...c }));
  for (const p of hand.players) {
    p.holeCards = (holeCards[p.seatIndex] || HIGH_CARD).map(c => ({ ...c }));
    p.betAmount = 100;
    p.roundBet = 0;
    p.hasActed = true;
    p.isFolded = folded.includes(p.seatIndex);
    p.isAllIn = allIn.includes(p.seatIndex);
    p.stack = p.isAllIn ? 0 : 1500;
  }
  hand.lastRaiserIndex = lastRaiser;
  hand.pot = 300;
  hand.currentBet = 0;
  return hand;
}

describe('Phase 7 - Interactive Showdown Reveal', () => {
  describe('buildShowdownOrder', () => {
    test('last river aggressor shows first, then clockwise', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);

      const [alice, bob, charlie] = hand.players.map(p => p.seatIndex);
      hand.lastRaiserIndex = 2; // Charlie bet/raised the river
      const order = buildShowdownOrder(hand);
      expect(order).toEqual([charlie, alice, bob]);
    });

    test('no river betting: player left of dealer shows first', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);

      const [alice, bob, charlie] = hand.players.map(p => p.seatIndex);
      hand.lastRaiserIndex = -1; // everyone checked the river
      const order = buildShowdownOrder(hand);
      // Dealer is player 0 (Alice); SB (Bob, seat 1) acts first on the river
      expect(order).toEqual([bob, charlie, alice]);
    });

    test('skips folded and all-in players', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);

      const [alice, bob, charlie] = hand.players.map(p => p.seatIndex);
      hand.players[1].isAllIn = true; // Bob all-in — auto-reveals, not a decider
      hand.players[2].isFolded = true; // Charlie folded
      hand.lastRaiserIndex = 0;
      const order = buildShowdownOrder(hand);
      expect(order).toEqual([alice]);
    });
  });

  describe('startShowdown', () => {
    test('all-in players auto-reveal and are skipped in the queue', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);
      const [alice, bob, charlie] = hand.players.map(p => p.seatIndex);

      stageShowdown(hand, {
        holeCards: { [alice]: TWO_PAIR_AK, [bob]: HIGH_CARD, [charlie]: TRIPS_ACES },
        allIn: [bob],
        lastRaiser: 2,
      });
      startShowdown(hand);

      expect(hand.gameStatus).toBe(GAME_STATES.SHOWDOWN);
      expect(hand.showdown.revealed).toContain(bob); // all-in → auto-revealed
      expect(hand.showdown.queue).not.toContain(bob);
      expect(hand.showdown.queue).toEqual([charlie, alice]); // last aggressor first
    });

    test('everyone all-in completes the hand immediately', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);
      const seats = hand.players.map(p => p.seatIndex);

      stageShowdown(hand, { allIn: seats });
      startShowdown(hand);

      expect(hand.gameStatus).toBe(GAME_STATES.HAND_COMPLETE);
      // All hands exposed — every non-folded player is revealed
      for (const p of hand.players) {
        expect(p.revealed).toBe(true);
        expect(p.mucked).toBe(false);
      }
    });

    test('uncontested win (everyone folded) shows nobody', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);

      // Two folds → one player left → immediate win, cards stay hidden
      handleAction(hand, hand.players[hand.currentPlayerIndex].seatIndex, 'fold');
      handleAction(hand, hand.players[hand.currentPlayerIndex].seatIndex, 'fold');

      expect(hand.gameStatus).toBe(GAME_STATES.HAND_COMPLETE);
      expect(hand.handResult[0].winners[0].handResult.rankName).toBe('Uncontested');
      for (const p of hand.players) {
        expect(p.revealed).toBe(false);
        expect(p.mucked).toBe(false);
      }
    });
  });

  describe('applyShowdownDecision & canMuckNow', () => {
    test('beaten player may muck; the best hand must show', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);
      const [alice, bob, charlie] = hand.players.map(p => p.seatIndex);

      // Alice: two pair; Bob: high card; Charlie: trips (best). Order: Bob → Charlie → Alice
      stageShowdown(hand, {
        holeCards: { [alice]: TWO_PAIR_AK, [bob]: HIGH_CARD, [charlie]: TRIPS_ACES },
        lastRaiser: -1,
      });
      startShowdown(hand);
      expect(hand.showdown.queue[0]).toBe(bob); // left of dealer (SB) first

      // Bob (weak, nothing exposed yet) must show
      expect(canMuckNow(hand, bob)).toBe(false);
      applyShowdownDecision(hand, bob, true);
      expect(hand.showdown.revealed).toContain(bob);

      // Charlie (trips) beats Bob's exposed high card → cannot muck, must show.
      // Attempting to muck the winning hand is rejected.
      expect(canMuckNow(hand, charlie)).toBe(false);
      const muckAttempt = applyShowdownDecision(hand, charlie, false);
      expect(muckAttempt.error).toMatch(/winning hand/i);
      applyShowdownDecision(hand, charlie, true);
      expect(hand.showdown.revealed).toContain(charlie);

      // Alice (two pair) is now beaten by Charlie's exposed trips → may muck
      expect(canMuckNow(hand, alice)).toBe(true);
      applyShowdownDecision(hand, alice, false);
      expect(hand.showdown.mucked).toContain(alice);

      expect(hand.gameStatus).toBe(GAME_STATES.HAND_COMPLETE);

      // Charlie wins and shows; Bob showed (loses); Alice mucked (hidden)
      const a = hand.players.find(p => p.seatIndex === alice);
      const b = hand.players.find(p => p.seatIndex === bob);
      const c = hand.players.find(p => p.seatIndex === charlie);
      expect(c.revealed).toBe(true);
      expect(c.mucked).toBe(false);
      expect(b.revealed).toBe(true);
      expect(b.mucked).toBe(false);
      expect(a.revealed).toBe(false);
      expect(a.mucked).toBe(true);
    });

    test('losing player may muck once beaten by an exposed hand', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);
      const [alice, bob, charlie] = hand.players.map(p => p.seatIndex);

      // Bob: two pair; Charlie: high card; Alice: trips (winner). Order: Bob → Charlie → Alice
      stageShowdown(hand, {
        holeCards: { [alice]: TRIPS_ACES, [bob]: TWO_PAIR_AK, [charlie]: HIGH_CARD },
        lastRaiser: -1,
      });
      startShowdown(hand);

      // Bob (first, nothing exposed) must show
      expect(canMuckNow(hand, bob)).toBe(false);
      applyShowdownDecision(hand, bob, true);

      // Charlie is beaten by Bob's exposed two pair → may muck
      expect(canMuckNow(hand, charlie)).toBe(true);
      applyShowdownDecision(hand, charlie, false);
      expect(hand.showdown.mucked).toContain(charlie);

      // Alice is the pot winner → must show; mucking is rejected
      expect(canMuckNow(hand, alice)).toBe(false);
      const muckAttempt = applyShowdownDecision(hand, alice, false);
      expect(muckAttempt.error).toMatch(/winning hand/i);
      applyShowdownDecision(hand, alice, true);

      expect(hand.gameStatus).toBe(GAME_STATES.HAND_COMPLETE);
      expect(hand.players.find(p => p.seatIndex === alice).revealed).toBe(true);
      expect(hand.players.find(p => p.seatIndex === bob).revealed).toBe(true);
      expect(hand.players.find(p => p.seatIndex === charlie).revealed).toBe(false);
      expect(hand.players.find(p => p.seatIndex === charlie).mucked).toBe(true);
    });

    test('side-pot winner must show even though they lose the main pot', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);
      const [alice, bob, charlieSeat] = hand.players.map(p => p.seatIndex);

      // Bob is all-in short with the BEST hand (trips) → wins the main pot.
      // Alice stays live with two pair and bets more → wins the side pot.
      // Charlie folded. Both pot winners must show.
      stageShowdown(hand, {
        holeCards: { [alice]: TWO_PAIR_AK, [bob]: TRIPS_ACES },
        allIn: [bob],
        folded: [charlieSeat],
        lastRaiser: 0,
      });
      hand.players.find(p => p.seatIndex === bob).betAmount = 50; // short all-in
      hand.pot = 200;
      startShowdown(hand);

      expect(hand.showdown.revealed).toContain(bob); // all-in auto-revealed
      expect(hand.showdown.queue).toEqual([alice]);  // Alice is the only decider

      // Alice wins the side pot → cannot muck, must show
      expect(canMuckNow(hand, alice)).toBe(false);
      const r = applyShowdownDecision(hand, alice, true);
      expect(r.error).toBeNull();
      expect(hand.gameStatus).toBe(GAME_STATES.HAND_COMPLETE);

      expect(hand.players.find(p => p.seatIndex === alice).revealed).toBe(true);
      expect(hand.players.find(p => p.seatIndex === bob).revealed).toBe(true);
      // The winner of the hand (Bob) is correctly awarded the main pot
      const bobWonMain = hand.handResult.some(pot => pot.winners.some(w => w.seatIndex === bob && pot.level === 50));
      expect(bobWonMain).toBe(true);
    });

    test('rejects decisions out of turn or after completion', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);
      const [alice, bob, charlie] = hand.players.map(p => p.seatIndex);

      stageShowdown(hand, { lastRaiser: -1 });
      startShowdown(hand);

      // Bob is first; Alice trying to act is out of turn
      const early = applyShowdownDecision(hand, alice, true);
      expect(early.error).toBe('Not your turn to reveal');

      const r = applyShowdownDecision(hand, bob, true);
      expect(r.error).toBeNull();

      // After the hand completes, decisions are rejected
      completeShowdown(hand, true);
      expect(hand.gameStatus).toBe(GAME_STATES.HAND_COMPLETE);
      const late = applyShowdownDecision(hand, charlie, true);
      expect(late.error).toBe('No showdown in progress');
    });
  });

  describe('Full flow through betting', () => {
    test('everyone checks down; reveal phase runs then hand completes', () => {
      const club = createClubState();
      const hand = createHand(club, 0);
      startHand(hand);

      // Preflop calls
      for (let i = 0; i < 3; i++) {
        const seat = hand.players[hand.currentPlayerIndex].seatIndex;
        const r = handleAction(hand, seat, 'call');
        expect(r.error).toBeNull();
      }
      expect(hand.gameStatus).toBe(GAME_STATES.FLOP);

      // Check down flop → turn → river → SHOWDOWN
      checkDownToShowdown(hand);
      expect(hand.gameStatus).toBe(GAME_STATES.SHOWDOWN);
      expect(hand.showdown.active).toBe(true);
      // All three are live → three deciders
      expect(hand.showdown.queue.length).toBe(3);

      // Public state exposes the phase (no cards for unrevealed players)
      const pub = getPublicState(hand);
      expect(pub.showdown.active).toBe(true);
      expect(pub.showdown.queue.length).toBe(3);
      expect(pub.showdown.revealed).toEqual([]); // nobody revealed yet

      // Everyone shows → hand completes
      completeShowdown(hand, true);
      expect(hand.gameStatus).toBe(GAME_STATES.HAND_COMPLETE);
      expect(hand.handResult).toBeDefined();
      // Winner revealed; no one mucked (all chose to show)
      for (const p of hand.players) {
        expect(p.revealed).toBe(true);
        expect(p.mucked).toBe(false);
      }
      // All chips awarded — nothing vanishes
      const totalAwarded = hand.handResult.reduce((sum, r) => sum + r.potAmount, 0);
      expect(totalAwarded).toBe(hand.pot);
    });

    test('hand completes via advanceCompleteRoundStep from an all-in runout', () => {
      const club = createClubState();
      // Bob and Charlie are short stacks that shove all-in; Alice stays live
      club.seats[1] = { userId: 'u2', userName: 'Bob', stack: 200, isConnected: true, isSittingOut: false };
      club.seats[2] = { userId: 'u3', userName: 'Charlie', stack: 200, isConnected: true, isSittingOut: false };
      const hand = createHand(club, 0);
      startHand(hand);

      const aliceSeat = hand.players[0].seatIndex;
      const bobSeat = hand.players[1].seatIndex;
      const charlieSeat = hand.players[2].seatIndex;

      handleAction(hand, hand.players[hand.currentPlayerIndex].seatIndex, 'call');
      handleAction(hand, bobSeat, 'raise', 200); // Bob shoves
      handleAction(hand, charlieSeat, 'call');   // Charlie calls all-in
      handleAction(hand, aliceSeat, 'call');     // Alice calls, stays live

      expect(hand.players[1].isAllIn).toBe(true);
      expect(hand.players[2].isAllIn).toBe(true);
      expect(hand.gameStatus).toBe(GAME_STATES.FLOP);

      // Drive the all-in runout street by street
      let guard = 0;
      while (hand.gameStatus !== GAME_STATES.SHOWDOWN && hand.gameStatus !== GAME_STATES.HAND_COMPLETE && guard < 6) {
        guard++;
        advanceCompleteRoundStep(hand);
      }

      // The runout lands in the interactive reveal phase: all-in hands exposed,
      // Alice (the lone live player) must decide.
      expect(hand.gameStatus).toBe(GAME_STATES.SHOWDOWN);
      expect(hand.showdown.revealed).toEqual(expect.arrayContaining([bobSeat, charlieSeat]));
      expect(hand.showdown.queue).toEqual([aliceSeat]);

      // Alice decides (show) → hand completes
      const r = applyShowdownDecision(hand, aliceSeat, true);
      expect(r.error).toBeNull();
      expect(hand.gameStatus).toBe(GAME_STATES.HAND_COMPLETE);
      expect(hand.communityCards.length).toBe(5);
      // All-in players stay revealed regardless of result
      expect(hand.players.find(p => p.seatIndex === bobSeat).revealed).toBe(true);
      expect(hand.players.find(p => p.seatIndex === charlieSeat).revealed).toBe(true);
    });
  });
});
