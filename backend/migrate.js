const pool = require('./db');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Drop old tables (clean migration)
    await client.query(`DROP TABLE IF EXISTS user_challenge_progress CASCADE;`);
    await client.query(`DROP TABLE IF EXISTS challenge_definitions CASCADE;`);
    await client.query(`DROP TABLE IF EXISTS challenges CASCADE;`);
    await client.query(`DROP TABLE IF EXISTS hand_histories CASCADE;`);
    await client.query(`DROP TABLE IF EXISTS clubs CASCADE;`);
    await client.query(`DROP TABLE IF EXISTS player_sessions CASCADE;`);
    await client.query(`DROP TABLE IF EXISTS ring_games CASCADE;`);
    await client.query(`DROP TABLE IF EXISTS users CASCADE;`);

    // ─── Users table with bankroll ─────────────────────────
    await client.query(`
      CREATE TABLE users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        display_name VARCHAR(20) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        avatar_color VARCHAR(7) DEFAULT '#FFD700',
        bankroll BIGINT NOT NULL DEFAULT 10000,
        total_wins INT DEFAULT 0,
        hands_played INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // ─── Ring Games (cash game tables) ─────────────────────
    await client.query(`
      CREATE TABLE ring_games (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        table_name VARCHAR(30) NOT NULL,
        host_user_id UUID REFERENCES users(id),
        min_buyin INT NOT NULL DEFAULT 50,
        max_buyin INT NOT NULL DEFAULT 1000,
        small_blind INT NOT NULL DEFAULT 10,
        big_blind INT NOT NULL DEFAULT 20,
        action_timer_seconds INT NOT NULL DEFAULT 20,
        max_players INT NOT NULL DEFAULT 6,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // ─── Player Sessions (tracks active seat at a table) ───
    await client.query(`
      CREATE TABLE player_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        game_id UUID REFERENCES ring_games(id) ON DELETE CASCADE,
        buyin_amount INT NOT NULL,
        current_stack INT NOT NULL,
        joined_at TIMESTAMP DEFAULT NOW(),
        left_at TIMESTAMP
      );
    `);

    // ─── Hand Histories (for replay later) ─────────────────
    await client.query(`
      CREATE TABLE hand_histories (
        id SERIAL PRIMARY KEY,
        game_id UUID REFERENCES ring_games(id),
        final_board JSONB,
        players_in_hand JSONB,
        pot_splits JSONB,
        played_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // ─── Challenge Definitions (achievement milestones) ────
    await client.query(`
      CREATE TABLE challenge_definitions (
        id SERIAL PRIMARY KEY,
        stat VARCHAR(40) NOT NULL,
        name VARCHAR(50) NOT NULL,
        description VARCHAR(100) NOT NULL,
        target_value INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // ─── User Challenge Progress ───────────────────────────
    await client.query(`
      CREATE TABLE user_challenge_progress (
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        challenge_id INTEGER REFERENCES challenge_definitions(id) ON DELETE CASCADE,
        progress INTEGER DEFAULT 0,
        is_completed BOOLEAN DEFAULT FALSE,
        completed_at TIMESTAMP,
        updated_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (user_id, challenge_id)
      );
    `);

    // ═══════════════════════════════════════════════════════════
    // SEED DATA: Milestone Quests
    // ═══════════════════════════════════════════════════════════

    // Hands Played (9 milestones)
    await client.query(`INSERT INTO challenge_definitions (stat, name, description, target_value) VALUES
      ('handsPlayed', 'Beginner', 'Play 10 hands', 10),
      ('handsPlayed', 'Getting Started', 'Play 50 hands', 50),
      ('handsPlayed', 'Regular', 'Play 100 hands', 100),
      ('handsPlayed', 'Dedicated', 'Play 250 hands', 250),
      ('handsPlayed', 'Grinder', 'Play 500 hands', 500),
      ('handsPlayed', 'Veteran', 'Play 1,000 hands', 1000),
      ('handsPlayed', 'Iron Will', 'Play 2,500 hands', 2500),
      ('handsPlayed', 'Legend', 'Play 5,000 hands', 5000),
      ('handsPlayed', 'Immortal', 'Play 10,000 hands', 10000)
    ;`);

    // Hands Won (8 milestones)
    await client.query(`INSERT INTO challenge_definitions (stat, name, description, target_value) VALUES
      ('handsWon', 'First Blood', 'Win your first hand', 1),
      ('handsWon', 'Double Digits', 'Win 10 hands', 10),
      ('handsWon', 'Quarter Century', 'Win 25 hands', 25),
      ('handsWon', 'Fifty Club', 'Win 50 hands', 50),
      ('handsWon', 'Century Mark', 'Win 100 hands', 100),
      ('handsWon', 'Serious Player', 'Win 250 hands', 250),
      ('handsWon', 'Five Hundred', 'Win 500 hands', 500),
      ('handsWon', 'Millennium', 'Win 1,000 hands', 1000)
    ;`);

    // Flops Seen (6 milestones)
    await client.query(`INSERT INTO challenge_definitions (stat, name, description, target_value) VALUES
      ('flopsSeen', 'Flopper I', 'See 10 flops', 10),
      ('flopsSeen', 'Flopper II', 'See 50 flops', 50),
      ('flopsSeen', 'Flopper III', 'See 100 flops', 100),
      ('flopsSeen', 'Flopper IV', 'See 250 flops', 250),
      ('flopsSeen', 'Flopper V', 'See 500 flops', 500),
      ('flopsSeen', 'Flopper VI', 'See 1,000 flops', 1000)
    ;`);

    // Showdowns Reached (5 milestones)
    await client.query(`INSERT INTO challenge_definitions (stat, name, description, target_value) VALUES
      ('showdownsReached', 'Showdown I', 'Reach 10 showdowns', 10),
      ('showdownsReached', 'Showdown II', 'Reach 50 showdowns', 50),
      ('showdownsReached', 'Showdown III', 'Reach 100 showdowns', 100),
      ('showdownsReached', 'Showdown IV', 'Reach 250 showdowns', 250),
      ('showdownsReached', 'Showdown V', 'Reach 500 showdowns', 500)
    ;`);

    // Showdowns Won (5 milestones)
    await client.query(`INSERT INTO challenge_definitions (stat, name, description, target_value) VALUES
      ('showdownsWon', 'Showdown Winner I', 'Win 5 showdowns', 5),
      ('showdownsWon', 'Showdown Winner II', 'Win 25 showdowns', 25),
      ('showdownsWon', 'Showdown Winner III', 'Win 50 showdowns', 50),
      ('showdownsWon', 'Showdown Winner IV', 'Win 100 showdowns', 100),
      ('showdownsWon', 'Showdown Winner V', 'Win 250 showdowns', 250)
    ;`);

    // Folds (5 milestones)
    await client.query(`INSERT INTO challenge_definitions (stat, name, description, target_value) VALUES
      ('foldsMade', 'Disciplined I', 'Fold 10 times', 10),
      ('foldsMade', 'Disciplined II', 'Fold 50 times', 50),
      ('foldsMade', 'Disciplined III', 'Fold 100 times', 100),
      ('foldsMade', 'Disciplined IV', 'Fold 250 times', 250),
      ('foldsMade', 'Disciplined V', 'Fold 500 times', 500)
    ;`);

    // Calls (5 milestones)
    await client.query(`INSERT INTO challenge_definitions (stat, name, description, target_value) VALUES
      ('callsMade', 'Caller I', 'Call 10 times', 10),
      ('callsMade', 'Caller II', 'Call 50 times', 50),
      ('callsMade', 'Caller III', 'Call 100 times', 100),
      ('callsMade', 'Caller IV', 'Call 250 times', 250),
      ('callsMade', 'Caller V', 'Call 500 times', 500)
    ;`);

    // Raises (5 milestones)
    await client.query(`INSERT INTO challenge_definitions (stat, name, description, target_value) VALUES
      ('raisesMade', 'Aggressor I', 'Raise 10 times', 10),
      ('raisesMade', 'Aggressor II', 'Raise 50 times', 50),
      ('raisesMade', 'Aggressor III', 'Raise 100 times', 100),
      ('raisesMade', 'Aggressor IV', 'Raise 250 times', 250),
      ('raisesMade', 'Aggressor V', 'Raise 500 times', 500)
    ;`);

    // All-Ins (5 milestones)
    await client.query(`INSERT INTO challenge_definitions (stat, name, description, target_value) VALUES
      ('allInsMade', 'All-In I', 'Go all-in 5 times', 5),
      ('allInsMade', 'All-In II', 'Go all-in 10 times', 10),
      ('allInsMade', 'All-In III', 'Go all-in 25 times', 25),
      ('allInsMade', 'All-In IV', 'Go all-in 50 times', 50),
      ('allInsMade', 'All-In V', 'Go all-in 100 times', 100)
    ;`);

    // Hand Ranks (progressive milestones)
    await client.query(`INSERT INTO challenge_definitions (stat, name, description, target_value) VALUES
      ('pairMade', 'Pair I', 'Make a pair at showdown 1 time', 1),
      ('pairMade', 'Pair II', 'Make a pair at showdown 10 times', 10),
      ('pairMade', 'Pair III', 'Make a pair at showdown 50 times', 50),
      ('twoPairMade', 'Two Pair I', 'Make two pair 1 time', 1),
      ('twoPairMade', 'Two Pair II', 'Make two pair 10 times', 10),
      ('twoPairMade', 'Two Pair III', 'Make two pair 25 times', 25),
      ('threeOfAKindMade', 'Trips I', 'Make three of a kind 1 time', 1),
      ('threeOfAKindMade', 'Trips II', 'Make three of a kind 5 times', 5),
      ('threeOfAKindMade', 'Trips III', 'Make three of a kind 25 times', 25),
      ('straightMade', 'Straight I', 'Make a straight 1 time', 1),
      ('straightMade', 'Straight II', 'Make a straight 5 times', 5),
      ('straightMade', 'Straight III', 'Make a straight 25 times', 25),
      ('flushMade', 'Flush I', 'Make a flush 1 time', 1),
      ('flushMade', 'Flush II', 'Make a flush 5 times', 5),
      ('flushMade', 'Flush III', 'Make a flush 25 times', 25),
      ('fullHouseMade', 'Full House I', 'Make a full house 1 time', 1),
      ('fullHouseMade', 'Full House II', 'Make a full house 5 times', 5),
      ('fullHouseMade', 'Full House III', 'Make a full house 10 times', 10),
      ('fourOfAKindMade', 'Quads I', 'Make four of a kind 1 time', 1),
      ('fourOfAKindMade', 'Quads II', 'Make four of a kind 3 times', 3),
      ('fourOfAKindMade', 'Quads III', 'Make four of a kind 10 times', 10),
      ('straightFlushMade', 'Straight Flush I', 'Make a straight flush 1 time', 1),
      ('straightFlushMade', 'Straight Flush II', 'Make a straight flush 3 times', 3),
      ('royalFlushMade', 'Royal Flush', 'Make a royal flush 1 time', 1)
    ;`);

    await client.query('COMMIT');
    console.log('Migration completed successfully!');
    console.log('Tables created: users, ring_games, player_sessions, hand_histories, challenge_definitions, user_challenge_progress');
    console.log('Seed data: 77 milestone challenge definitions inserted');
    return {
      tables: ['users', 'ring_games', 'player_sessions', 'hand_histories', 'challenge_definitions', 'user_challenge_progress'],
    };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err);
    throw err;
  } finally {
    client.release();
    if (require.main === module) {
      await pool.end();
    }
  }
}

// Auto-run when called directly
if (require.main === module) {
  migrate().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}

module.exports = { migrate };
