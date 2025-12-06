const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { User, Message } = require("../models");

const JWT_SECRET = process.env.JWT_SECRET || "super_secret_key";

router.post('/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ message: 'Заполните все поля' });

  try {
    const existing = await User.findOne({ where: { username } });
    if (existing) return res.status(409).json({ message: 'Имя занято' });

    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({
      username: username,
      password_hash: hash
    });

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });

    res.json({ 
      token, 
      user: { id: user.id, username: user.username } 
    });
  } catch (err) {
    console.error('Ошибка регистрации:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ message: 'Заполните все поля' });

  try {
    const user = await User.findOne({ where: { username } });
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
    const user = await User.findOne({
      where: { id: decoded.id },
      attributes: ['id', 'username']
    });
    
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

    const existing = await User.findOne({
      where: {
        username: username.trim(),
        id: { $ne: userId }
      }
    });
    
    if (existing) return res.status(409).json({ message: 'Имя уже занято' });

    const updateData = { username: username.trim() };
    
    if (password?.trim()) {
      updateData.password_hash = await bcrypt.hash(password, 10);
    }

    const [affectedCount] = await User.update(updateData, {
      where: { id: userId }
    });

    if (affectedCount === 0) return res.status(404).json({ message: 'Пользователь не найден' });

    const updatedUser = await User.findByPk(userId, {
      attributes: ['id', 'username']
    });

    await Message.update(
      { sender_name: updatedUser.username },
      { where: { user_id: userId } }
    );

    res.json({ user: updatedUser });
  } catch (err) {
    console.error('Ошибка обновления профиля:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

module.exports = router;