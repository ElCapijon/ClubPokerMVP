// ============================================================
// Deck.js - Deck builder, Fisher-Yates shuffle, and deal function
// ============================================================

const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
const RANKS = [
  { name: '2', value: 2 },
  { name: '3', value: 3 },
  { name: '4', value: 4 },
  { name: '5', value: 5 },
  { name: '6', value: 6 },
  { name: '7', value: 7 },
  { name: '8', value: 8 },
  { name: '9', value: 9 },
  { name: '10', value: 10 },
  { name: 'J', value: 11 },
  { name: 'Q', value: 12 },
  { name: 'K', value: 13 },
  { name: 'A', value: 14 },
];

const SUIT_SYMBOLS = {
  hearts: '♥',
  diamonds: '♦',
  clubs: '♣',
  spades: '♠',
};

/**
 * Create a standard 52-card deck.
 * Each card: { suit, suitSymbol, rank, rankName, value }
 */
function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({
        suit,
        suitSymbol: SUIT_SYMBOLS[suit],
        rankName: rank.name,
        value: rank.value,
        // Unique string key for comparison
        key: `${rank.name}${suit[0].toUpperCase()}`,
      });
    }
  }
  return deck;
}

/**
 * Fisher-Yates shuffle (in-place, O(n)).
 */
function shuffle(deck) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

/**
 * Deal hole cards to numPlayers from the deck.
 * Returns { players: [[card1, card2], ...], deck: remainingDeck }
 */
function dealCards(deck, numPlayers) {
  if (numPlayers < 1 || numPlayers > 10) {
    throw new Error('Number of players must be between 1 and 10');
  }
  if (deck.length < numPlayers * 2 + 8) {
    throw new Error('Not enough cards in deck to deal');
  }

  const shuffled = shuffle(deck);
  const players = [];
  let idx = 0;

  // Deal 2 cards to each player
  for (let i = 0; i < numPlayers; i++) {
    players.push([shuffled[idx], shuffled[idx + 1]]);
    idx += 2;
  }

  // Burn 1 card, then 3 community (flop)
  const flopBurn = shuffled[idx++];
  const flop = [shuffled[idx++], shuffled[idx++], shuffled[idx++]];

  // Burn 1 card, then 1 community (turn)
  const turnBurn = shuffled[idx++];
  const turn = shuffled[idx++];

  // Burn 1 card, then 1 community (river)
  const riverBurn = shuffled[idx++];
  const river = shuffled[idx++];

  const community = [...flop, turn, river];
  const remaining = shuffled.slice(idx);

  return {
    players,
    community,
    burns: [flopBurn, turnBurn, riverBurn],
    deck: remaining,
  };
}

/**
 * Get a display string for a card.
 */
function cardToString(card) {
  return `${card.rankName}${card.suitSymbol}`;
}

/**
 * Get a display string for a hand of cards.
 */
function handToString(cards) {
  return cards.map(cardToString).join(' ');
}

module.exports = {
  createDeck,
  shuffle,
  dealCards,
  cardToString,
  handToString,
  SUITS,
  RANKS,
  SUIT_SYMBOLS,
};
