require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function query(text, params) {
  const res = await pool.query(text, params);
  return res;
}

module.exports = {
  query,
  pool
};
