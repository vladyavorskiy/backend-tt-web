const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const { Room, RoomUser, User, Message } = require("../models");
const { activeRooms, sessionToRoom } = require("../utils/roomUtils");

router.post('/rooms', async (req, res) => {
  const { creatorUserId, sessionId } = req.body;
  if (!creatorUserId || !sessionId) return res.status(400).json({ error: 'Отсутствуют обязательные данные' });

  try {
    if (sessionToRoom.has(sessionId)) return res.status(400).json({ error: 'Вы уже состоите в другой комнате' });

    const roomId = uuidv4();
    
    await Room.create({
      id: roomId,
      creator_user_id: creatorUserId,
    });
    
    await RoomUser.create({
      room_id: roomId,
      user_id: creatorUserId,
      session_id: sessionId,
    });

    const user = await User.findByPk(creatorUserId, {
      attributes: ['username']
    });
    const creatorName = user.username;

    const systemMessage = `${creatorName} создал комнату`;
    await Message.create({
      room_id: roomId,
      sender_name: 'Система',
      message: systemMessage,
    });

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