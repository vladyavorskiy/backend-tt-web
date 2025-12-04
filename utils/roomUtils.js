const { query } = require("../db");

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
      
      const dbCheck = await query(
        'SELECT room_id FROM room_users WHERE session_id = $1',
        [sessionId]
      );
      
      if (dbCheck.rowCount > 0) {
        await query('DELETE FROM room_users WHERE session_id = $1', [sessionId]);
        sessionToRoom.delete(sessionId);
        return { success: true, roomId: dbCheck.rows[0].room_id };
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
      
      await query('DELETE FROM room_users WHERE room_id = $1', [roomId]);
      await query('DELETE FROM messages WHERE room_id = $1', [roomId]);
      await query('DELETE FROM rooms WHERE id = $1', [roomId]);
    } else {
      await query('DELETE FROM room_users WHERE session_id = $1', [sessionId]);
    }

    if (roomData && io) {
      const leaveMessage = `${userName} вышел из комнаты`;
      
      try {
        await query(
          'INSERT INTO messages (room_id, sender_name, message) VALUES ($1, $2, $3)',
          [roomId, 'Система', leaveMessage]
        );
        
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

    const dbCheck = await query(
      `SELECT r.id, r.creator_user_id, 
              ru.session_id, ru.user_id, ru.socket_id,
              u.username
       FROM rooms r
       LEFT JOIN room_users ru ON r.id = ru.room_id
       LEFT JOIN users u ON ru.user_id = u.id
       WHERE r.id = $1`,
      [roomId]
    );

    if (dbCheck.rowCount === 0) {
      return { data: null, source: 'none' };
    }

    const participantsMap = new Map();
    let creatorUserId = null;

    dbCheck.rows.forEach(row => {
      if (row.session_id) {
        participantsMap.set(row.session_id, {
          userId: row.user_id,
          name: row.username,
          socketId: row.socket_id,
          sessionId: row.session_id
        });
      }
      if (!creatorUserId && row.creator_user_id) {
        creatorUserId = row.creator_user_id;
      }
    });

    const restoredRoomData = {
      creatorUserId,
      participants: participantsMap
    };

    activeRooms.set(roomId, restoredRoomData);
    dbCheck.rows.forEach(row => {
      if (row.session_id) {
        sessionToRoom.set(row.session_id, roomId);
      }
    });

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