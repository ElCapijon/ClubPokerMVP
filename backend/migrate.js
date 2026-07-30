const pool = require('./db');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Drop old tables if they exist (for clean migration)
    await client.query(`DROP TABLE IF EXISTS challenges CASCADE;`);
    await client.query(`DROP TABLE IF EXISTS hand_histories CASCADE;`);
    await client.query(`DROP TABLE IF EXISTS clubs CASCADE;`);
    await client.query(`DROP TABLE IF EXISTS users CASCADE;`);

    // Users table with credentials
    await client.query(`
      CREATE TABLE users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        display_name VARCHAR(20) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        avatar_color VARCHAR(7) DEFAULT '#FFD700',
        total_wins INT DEFAULT 0,
        hands_played INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Clubs / Rooms
    await client.query(`
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
    `);

    // Hand Histories (for replay later)
    await client.query(`
      CREATE TABLE hand_histories (
        id SERIAL PRIMARY KEY,
        club_id UUID REFERENCES clubs(id),
        final_board JSONB,
        players_in_hand JSONB,
        pot_splits JSONB,
        played_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Challenge Requests Table
    await client.query(`
      CREATE TABLE challenges (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        challenger_id UUID REFERENCES users(id) ON DELETE CASCADE,
        challengee_id UUID REFERENCES users(id) ON DELETE CASCADE,
        status VARCHAR(20) DEFAULT 'pending',
        buy_in INT DEFAULT 0,
        blind_level INT DEFAULT 20,
        max_hands INT DEFAULT 0,
        winner_id UUID REFERENCES users(id),
        club_id UUID REFERENCES clubs(id),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Challenge Definitions (static quest catalog)
    await client.query(`
      CREATE TABLE challenge_definitions (
        id SERIAL PRIMARY KEY,
        category VARCHAR(20) NOT NULL,
        name VARCHAR(50) NOT NULL,
        description VARCHAR(100) NOT NULL,
        target_value INTEGER NOT NULL,
        target_rank INTEGER,
        reward_badge VARCHAR(30),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // User Challenge Progress
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

    // Seed challenge definitions
    await client.query(`
      INSERT INTO challenge_definitions (category, name, description, target_value, target_rank, reward_badge) VALUES
        ('hand_rank', 'Three of a Kind', 'Make a Three of a Kind at showdown', 1, 4, '🎲'),
        ('hand_rank', 'Flush Master', 'Win a hand with a Flush or better', 3, 6, '🌊'),
        ('hand_rank', 'Full House', 'Make a Full House at showdown', 1, 7, '🏠'),
        ('hand_rank', 'Four of a Kind', 'Hit Four of a Kind at showdown', 1, 8, '💎'),
        ('hand_rank', 'Straight Flush', 'Hit a Straight Flush', 1, 9, '🔥'),
        ('hand_rank', 'Royal Dream', 'Hit a Royal Flush', 1, 9, '👑'),
        ('wagering', 'Blind Stealer', 'Successfully steal the blinds pre-flop', 10, NULL, '🦊'),
        ('volume', 'Grinder', 'Play 50 hands', 50, NULL, '⛏️'),
        ('volume', 'High Roller', 'Play 200 hands', 200, NULL, '💰'),
        ('volume', 'First Win', 'Win your first hand', 1, NULL, '🏆');
    `);

    await client.query('COMMIT');
    console.log('Migration completed successfully!');
    console.log('Tables created: users, clubs, hand_histories, challenges, challenge_definitions, user_challenge_progress');
    console.log('Seed data: 10 challenge definitions inserted');
    return { tables: ['users', 'clubs', 'hand_histories', 'challenges', 'challenge_definitions', 'user_challenge_progress'] };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err);
    throw err;
  } finally {
    client.release();
    // Only close the pool when running as a standalone script
    // When called from the API endpoint, the server needs the pool to stay open!
    if (require.main === module) {
      await pool.end();
    }
  }
}

// Auto-run when called directly via `node migrate.js`
if (require.main === module) {
  migrate().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}

module.exports = { migrate };
