const { Room, RoomUser, User, Message } = require("../models");

const activeRooms = new Map();
const sessionToRoom = new Map();

function participantsArray(roomData, activeSessionId = null) {
  return Array.from(roomData.participants.values()).map((p) => ({
    id: p.socketId,
    name: p.name,
    sessionId: p.sessionId,
    userId: p.userId,
    isCreator: roomData.creatorUserId === p.userId,
    isActive: roomData.currentTurnSessionId === p.sessionId,
  }));
}

function broadcastParticipants(roomId, roomData) {
  if (!io) {
    console.error('[broadcastParticipants] io не инициализирован');
    return;
  }
  io.in(roomId).emit('update_participants', {
    participants: participantsArray(roomData),
    creatorUserId: roomData.creatorUserId,
  });
}

async function removeUserFromRoomBySession(sessionId) {
  try {
    console.log(`[removeUserFromRoomBySession] Начинаем удаление сессии ${sessionId}`);
    
    const roomId = sessionToRoom.get(sessionId);
    if (!roomId) {
      console.log(`[removeUserFromRoomBySession] Сессия ${sessionId} не найдена в sessionToRoom`);
      return { success: false, error: 'Сессия не найдена' };
    }
    
    const roomData = activeRooms.get(roomId);
    if (!roomData) {
      console.log(`[removeUserFromRoomBySession] Комната ${roomId} не найдена в activeRooms`);
      
      const dbCheck = await RoomUser.findOne({
        where: { session_id: sessionId },
        attributes: ['room_id']
      });
      
      if (dbCheck) {
        await RoomUser.destroy({ where: { session_id: sessionId } });
        sessionToRoom.delete(sessionId);
        return { success: true, roomId: dbCheck.room_id };
      }
      
      return { success: false, error: 'Комната не найдена' };
    }

    const user = roomData.participants.get(sessionId);
    if (!user) {
      console.log(`[removeUserFromRoomBySession] Пользователь с сессией ${sessionId} не найден в комнате`);
      return { success: false, error: 'Пользователь не найден в комнате' };
    }

    const userName = user.name || 'Неизвестный пользователь';
    const userId = user.userId;

    console.log(`[removeUserFromRoomBySession] Удаляем пользователя ${userName} (ID: ${userId}) из комнаты ${roomId}`);

    roomData.participants.delete(sessionId);
    sessionToRoom.delete(sessionId);

    if (roomData.participants.size === 0) {
      console.log(`[removeUserFromRoomBySession] Комната ${roomId} пуста, удаляем из памяти`);
      activeRooms.delete(roomId);
      
      await RoomUser.destroy({ where: { room_id: roomId } });
      await Message.destroy({ where: { room_id: roomId } });
      await Room.destroy({ where: { id: roomId } });
    } else {
      await RoomUser.destroy({ where: { session_id: sessionId } });
    }

    if (roomData && io) {
      const leaveMessage = `${userName} вышел из комнаты`;
      
      try {
        await Message.create({
          room_id: roomId,
          sender_name: 'Система',
          message: leaveMessage,
        });
        
        io.to(roomId).emit('receive_message', { 
          from: { id: 'system', name: 'Система' }, 
          text: leaveMessage 
        });
      } catch (err) {
        console.error('[removeUserFromRoomBySession] Ошибка при добавлении сообщения:', err);
      }

      broadcastParticipants(roomId, roomData);
    }

    console.log(`[removeUserFromRoomBySession] Успешно удален пользователь ${userName} из комнаты ${roomId}`);
    return { success: true, roomId, userId, userName };

  } catch (err) {
    console.error('[removeUserFromRoomBySession] Ошибка:', err);
    return { success: false, error: err.message };
  }
}

async function getRoomData(roomId) {
  try {
    const roomData = activeRooms.get(roomId);
    if (roomData) {
      return { data: roomData, source: 'memory' };
    }

    const rooms = await Room.findAll({
      where: { id: roomId },
      include: [
        {
          model: RoomUser,
          include: [
            {
              model: User,
              attributes: ['username']
            }
          ]
        }
      ]
    });

    if (!rooms || rooms.length === 0) {
      return { data: null, source: 'none' };
    }

    const room = rooms[0];
    const participantsMap = new Map();
    let creatorUserId = room.creator_user_id;

    if (room.RoomUsers && room.RoomUsers.length > 0) {
      room.RoomUsers.forEach(roomUser => {
        if (roomUser.session_id && roomUser.User) {
          participantsMap.set(roomUser.session_id, {
            userId: roomUser.user_id,
            name: roomUser.User.username,
            socketId: roomUser.socket_id,
            sessionId: roomUser.session_id
          });
        }
      });
    }

    const restoredRoomData = {
      creatorUserId,
      participants: participantsMap
    };

    activeRooms.set(roomId, restoredRoomData);
    
    if (room.RoomUsers && room.RoomUsers.length > 0) {
      room.RoomUsers.forEach(roomUser => {
        if (roomUser.session_id) {
          sessionToRoom.set(roomUser.session_id, roomId);
        }
      });
    }

    return { data: restoredRoomData, source: 'database' };

  } catch (err) {
    console.error('[getRoomData] Ошибка:', err);
    return { data: null, source: 'error', error: err.message };
  }
}

function clearUserSocketData(sessionId, socketId) {
  try {
    const roomId = sessionToRoom.get(sessionId);
    if (roomId) {
      const roomData = activeRooms.get(roomId);
      if (roomData) {
        const user = roomData.participants.get(sessionId);
        if (user && user.socketId === socketId) {
          user.socketId = null;
          console.log(`[clearUserSocketData] Очищен socketId для сессии ${sessionId}`);
        }
      }
    }
  } catch (err) {
    console.error('[clearUserSocketData] Ошибка:', err);
  }
}

let io;
function setIo(socketIo) {
  io = socketIo;
}

module.exports = {
  activeRooms,
  sessionToRoom,
  participantsArray,
  broadcastParticipants,
  removeUserFromRoomBySession,
  getRoomData,
  clearUserSocketData,
  setIo
};