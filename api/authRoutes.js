const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { pool } = require("../db");

const JWT_SECRET = process.env.JWT_SECRET || "super_secret_key";

router.post('/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ message: 'Заполните все поля' });

  try {
    const existing = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (existing.rows.length > 0) return res.status(409).json({ message: 'Имя занято' });

    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query('INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username', [username, hash]);

    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });

    res.json({ token, user });
  } catch (err) {
    console.error('Ошибка регистрации:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ message: 'Заполните все поля' });

  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ message: 'Неверное имя или пароль' });

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) return res.status(401).json({ message: 'Неверное имя или пароль' });

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, username: user.username } });
  } catch (err) {
    console.error('Ошибка авторизации:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

router.get('/user/profile', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ message: 'Нет токена' });

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const result = await pool.query('SELECT id, username FROM users WHERE id = $1', [decoded.id]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ message: 'Пользователь не найден' });

    res.json(user);
  } catch (err) {
    console.error('Ошибка получения профиля:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

router.put('/user/update_profile', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ message: 'Нет токена' });

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const userId = decoded.id;

    const { username, password } = req.body;

    if (!username?.trim()) return res.status(400).json({ message: 'Имя не может быть пустым' });

    const existing = await pool.query('SELECT id FROM users WHERE username = $1 AND id <> $2', [username.trim(), userId]);
    if (existing.rows.length > 0) return res.status(409).json({ message: 'Имя уже занято' });

    const updates = [];
    const params = [];
    let idx = 1;

    updates.push(`username = $${idx++}`);
    params.push(username.trim());

    if (password?.trim()) {
      const hash = await bcrypt.hash(password, 10);
      updates.push(`password_hash = $${idx++}`);
      params.push(hash);
    }

    params.push(userId);

    const queryText = `UPDATE users SET ${updates.join(', ')} WHERE id = $${idx} RETURNING id, username`;
    const result = await pool.query(queryText, params);

    const updatedUser = result.rows[0];

    await pool.query('UPDATE messages SET sender_name = $1 WHERE user_id = $2', [updatedUser.username, userId]);

    res.json({ user: updatedUser });
  } catch (err) {
    console.error('Ошибка обновления профиля:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

module.exports = router;
