const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const { query } = require("../db");
const { activeRooms } = require("../utils/roomUtils");

const sessionToRoom = {};

router.post('/rooms', async (req, res) => {
  const { creatorUserId, sessionId } = req.body;
  if (!creatorUserId || !sessionId) return res.status(400).json({ error: 'Отсутствуют обязательные данные' });

  try {
    if (sessionToRoom.has(sessionId)) return res.status(400).json({ error: 'Вы уже состоите в другой комнате' });

    const roomId = uuidv4();
    await query('INSERT INTO rooms (id, creator_user_id) VALUES ($1, $2)', [roomId, creatorUserId]);
    await query('INSERT INTO room_users (room_id, user_id, session_id) VALUES ($1, $2, $3)', [roomId, creatorUserId, sessionId]);

    const userRes = await query('SELECT username FROM users WHERE id = $1', [creatorUserId]);
    const creatorName = userRes.rows[0].username;

    const systemMessage = `${creatorName} создал комнату`;
    await query('INSERT INTO messages (room_id, sender_name, message) VALUES ($1, $2, $3)', [roomId, 'Система', systemMessage]);

    const participantsMap = new Map();
    participantsMap.set(sessionId, { userId: creatorUserId, name: creatorName, socketId: null, sessionId });
    activeRooms.set(roomId, { creatorUserId, participants: participantsMap });
    sessionToRoom.set(sessionId, roomId);

    res.status(201).json({ id: roomId });
  } catch (err) {
    console.error('Ошибка при создании комнаты:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
