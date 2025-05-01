// config/db.js
const { Pool } = require('pg');
require('dotenv').config(); // Ensure environment variables are loaded

// Check if DATABASE_URL is loaded
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is not set.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Required for Neon, Heroku, etc. Adjust if your provider needs differently.
  }
});

// Optional: Test the connection on startup
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Error connecting to database:', err);
  } else {
    console.log('Successfully connected to database at:', res.rows[0].now);
  }
});

module.exports = {
  query: (text, params) => pool.query(text, params), // Export a query function
  pool // Export the pool itself if needed elsewhere (less common for simple apps)
};