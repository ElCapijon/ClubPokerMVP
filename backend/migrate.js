const pool = require('./db');

const migrate = async () => {
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

    await client.query('COMMIT');
    console.log('Migration completed successfully!');
    console.log('Tables created: users, clubs, hand_histories, challenges');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
};

migrate();
