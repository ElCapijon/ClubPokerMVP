const pool = require('./db');

const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Users table (minimalistic)
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        display_name VARCHAR(20) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Clubs / Rooms
    await client.query(`
      CREATE TABLE IF NOT EXISTS clubs (
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
      CREATE TABLE IF NOT EXISTS hand_histories (
        id SERIAL PRIMARY KEY,
        club_id UUID REFERENCES clubs(id),
        final_board JSONB,
        players_in_hand JSONB,
        pot_splits JSONB,
        played_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query('COMMIT');
    console.log('Migration completed successfully!');
    console.log('Tables created: users, clubs, hand_histories');
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
