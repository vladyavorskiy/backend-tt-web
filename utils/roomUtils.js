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
  io.in(roomId).emit('update_participants', {
    participants: participantsArray(roomData),
    creatorUserId: roomData.creatorUserId,
  });
}

async function removeUserFromRoomBySession(sessionId) {
  const roomId = sessionToRoom.get(sessionId);
  if (!roomId) return;
  
  const roomData = activeRooms.get(roomId);
  if (!roomData) return;

  const user = roomData.participants.get(sessionId);
  if (!user) return;

  const userName = user.name || 'Неизвестный пользователь';

  roomData.participants.delete(sessionId);
  sessionToRoom.delete(sessionId);
  await query('DELETE FROM room_users WHERE session_id = $1', [sessionId]);

   const leaveMessage = `${userName} вышел из комнаты`;
  await query(
    'INSERT INTO messages (room_id, sender_name, message) VALUES ($1, $2, $3)',
    [roomId, 'Система', leaveMessage]);
 
    io.to(roomId).emit('receive_message', { from: { id: 'system', name: 'Система' }, text: leaveMessage });
  broadcastParticipants(roomId, roomData);
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
  setIo
};