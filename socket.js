const { v4: uuidv4 } = require('uuid');
const { Room, RoomUser, User, Message, Game, GameWord, GameScore } = require("./models");
const { 
  activeRooms, 
  sessionToRoom, 
  broadcastParticipants, 
  participantsArray, 
  removeUserFromRoomBySession,
  getRoomData,
  clearUserSocketData
} = require("./utils/roomUtils");
const { shuffleArray, finishGame, startTurnTimer, endTurnServer } = require("./utils/gameUtils");

function initSocket(io) {
  require("./utils/roomUtils").setIo(io);
  require("./utils/gameUtils").setIo(io);
  
  io.on('connection', (socket) => {
    console.log('Подключен:', socket.id);

  socket.on('check_active_room', async ({ userId }) => {
    try {
      for (const [roomId, room] of activeRooms.entries()) {
        const participant = Array.from(room.participants.values()).find(p => p.userId === userId);
        if (participant) {
          socket.emit('active_room_info', { roomId });
          return;
        }
      }

      const dbCheck = await RoomUser.findOne({
        where: { user_id: userId },
        attributes: ['room_id'],
        order: [['joined_at', 'DESC']]
      });
      
      if (dbCheck) {
        socket.emit('active_room_info', { roomId: dbCheck.room_id });
      } else {
        socket.emit('active_room_info', null);
      }
    } catch (err) {
      console.error('[check_active_room]', err);
      socket.emit('active_room_info', null);
    }
  });

  socket.on('join_room', async (data) => {
    const { roomId, userId, sessionId: providedSessionId } = data || {};
    if (!roomId || !userId) return socket.emit('error_message', 'Неверные параметры join_room');

    const sessionKey = providedSessionId || uuidv4();
    socket.data.sessionId = sessionKey;
    socket.data.userId = userId;
    socket.data.roomId = roomId;

    try {
      const room = await Room.findByPk(roomId, {
        attributes: ['id', 'creator_user_id']
      });
      
      if (!room) return socket.emit('room_not_found');

      const creatorUserId = room.creator_user_id;

      if (!activeRooms.has(roomId)) {
        const dbUsers = await RoomUser.findAll({
          where: { room_id: roomId },
          include: [
            {
              model: User,
              attributes: ['username']
            }
          ]
        });
        
        const participantsMap = new Map();
        dbUsers.forEach(u => {
          participantsMap.set(u.session_id, { 
            userId: u.user_id, 
            name: u.User.username, 
            socketId: u.socket_id, 
            sessionId: u.session_id 
          });
        });
        activeRooms.set(roomId, { creatorUserId, participants: participantsMap });
      }

      const roomData = activeRooms.get(roomId);
      const user = await User.findByPk(userId, {
        attributes: ['username']
      });
      const username = user?.username || 'Неизвестный пользователь';

      let existingParticipant = Array.from(roomData.participants.values()).find(p => p.userId === userId);

      if (existingParticipant) {
        console.log(`[join_room] Пользователь ${userId} уже в комнате ${roomId}, обновляем socketId`);
        existingParticipant.socketId = socket.id;
        existingParticipant.sessionId = sessionKey;

        await RoomUser.update(
          { socket_id: socket.id, session_id: sessionKey },
          { where: { room_id: roomId, user_id: userId } }
        );
      } else {
        console.log(`[join_room] Новый участник ${userId} вошел в комнату ${roomId}`);
        roomData.participants.set(sessionKey, { userId, name: username, socketId: socket.id, sessionId: sessionKey });

        await RoomUser.create({
          room_id: roomId,
          user_id: userId,
          session_id: sessionKey,
          socket_id: socket.id
        });
      }

      sessionToRoom.set(sessionKey, roomId);

      socket.join(roomId);

      const messages = await Message.findAll({
        where: { room_id: roomId },
        attributes: ['sender_name', 'message', 'created_at'],
        order: [['created_at', 'ASC']]
      });
      
      socket.emit('chat_history', messages || []);

      const isFirstJoin = !existingParticipant;
      if (isFirstJoin) {
        const joinMessage =
          userId === creatorUserId
            ? `${username} создал комнату`
            : `${username} присоединился к комнате`;

        await Message.create({
          room_id: roomId,
          sender_name: 'Система',
          message: joinMessage,
        });

        io.to(roomId).emit('receive_message', {
          from: { id: 'system', name: 'Система' },
          text: joinMessage,
        });
      }

      broadcastParticipants(roomId, roomData, sessionKey);

      socket.emit('joined', {
        roomId,
        participants: participantsArray(roomData, sessionKey),
        isCreator: Number(creatorUserId) === Number(userId),
        creatorUserId,
      });
      
      socket.emit('active_room_info', { roomId });
    } catch (err) {
      console.error(err);
      socket.emit('error_message', 'Ошибка сервера');
    }
  });

  socket.on('send_message', async (message) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const user = await User.findByPk(socket.data.userId, {
      attributes: ['username']
    });
    const username = user.username;

    await Message.create({
      room_id: roomId,
      user_id: socket.data.userId,
      sender_name: username,
      message: message
    });
    
    io.to(roomId).emit('receive_message', { from: { id: socket.data.userId, name: username }, text: message });
  });

  socket.on('leave_room_request', async () => {
      console.log(`[leave_room_request] Запрос от socket ${socket.id}`);
      
      const sessionId = socket.data.sessionId;
      const userId = socket.data.userId;
      
      if (!sessionId) {
        console.log(`[leave_room_request] Нет sessionId у socket ${socket.id}`);
        return socket.emit('leave_error', { message: 'Отсутствует идентификатор сессии' });
      }

      try {
        const roomId = sessionToRoom.get(sessionId) || socket.data.roomId;
        
        if (!roomId) {
          console.log(`[leave_room_request] Пользователь ${userId} не в комнате`);
          return socket.emit('leave_error', { message: 'Вы не находитесь в комнате' });
        }

        console.log(`[leave_room_request] Пользователь ${userId} покидает комнату ${roomId}`);

        const result = await removeUserFromRoomBySession(sessionId);
        
        if (!result.success) {
          console.log(`[leave_room_request] Ошибка удаления: ${result.error}`);
          return socket.emit('leave_error', { 
            message: 'Не удалось выйти из комната', 
            details: result.error 
          });
        }

        socket.leave(roomId);
        
        delete socket.data.roomId;
        
        console.log(`[leave_room_request] Пользователь ${userId} успешно вышел из комнаты ${roomId}`);

        socket.emit('left_room_success', { 
          roomId,
          userId,
          userName: result.userName 
        });

        const roomData = activeRooms.get(roomId);
        if (roomData && io) {
          broadcastParticipants(roomId, roomData);
        }

      } catch (err) {
        console.error('[leave_room_request] Необработанная ошибка:', err);
        socket.emit('leave_error', { 
          message: 'Внутренняя ошибка сервера',
          code: 'INTERNAL_ERROR'
        });
      }
    });

  socket.on('delete_room', async () => {
    const roomId = socket.data.roomId;
    if (!roomId || !activeRooms.has(roomId)) return;

    const roomData = activeRooms.get(roomId);
    if (roomData.creatorUserId !== socket.data.userId) {
      socket.emit('error_message', 'Только создатель может удалить комнату');
      return;
    }

    io.to(roomId).emit('room_closed');
    
    await Message.destroy({ where: { room_id: roomId } });
    await RoomUser.destroy({ where: { room_id: roomId } });
    await Room.destroy({ where: { id: roomId } });

    for (const [sessId] of roomData.participants) sessionToRoom.delete(sessId);

    const clients = await io.in(roomId).fetchSockets();
    for (const client of clients) {
      client.leave(roomId);
      client.data.roomId = null;
    }

    activeRooms.delete(roomId);
  });

  socket.on('disconnect', () => {
      console.log(`Отключен: ${socket.id}`);
      
      const { roomId, sessionId, userId } = socket.data || {};
      
      if (sessionId && roomId) {
        console.log(`[disconnect] Пользователь ${userId} отключился от комнаты ${roomId}`);
        
        clearUserSocketData(sessionId, socket.id);
        
        const roomData = activeRooms.get(roomId);
        if (roomData) {
          setTimeout(() => {
            broadcastParticipants(roomId, roomData);
          }, 1000);
        }
      } else {
        console.log(`[disconnect] Отключился socket без данных комнаты: ${socket.id}`);
      }
    });

  socket.on('check_role', ({ roomId, userId }) => {
  console.log(`[check_role] Received request: roomId=${roomId}, userId=${userId}`);

  const room = activeRooms.get(roomId);
  const isCreator = room?.creatorUserId === userId;

  console.log(`[check_role] Computed isCreator=${isCreator} for userId=${userId} in roomId=${roomId}`);

  socket.emit('role_info', { isCreator });
});

socket.on("create_game", async ({ type, mode, roundTime, wordsPerPlayer }) => {
  const roomId = socket.data.roomId;
  const userId = socket.data.userId;
  const room = activeRooms.get(roomId);
  if (!room) return;

  try {
    const game = await Game.create({
      room_id: roomId,
      creator_user_id: userId,
      type,
      mode,
      round_time: roundTime,
      words_per_player: wordsPerPlayer
    });

    const gameId = game.id;

    const gameData = {
      id: gameId,
      type,               // тип игры
      mode,               // solo / team
      roundTime,          // время на раунд
      wordsPerPlayer,     // сколько слов вводит каждый игрок
      phase: "enterWords",
      allWords: [],       // все слова, введённые игроками
      roundWords: [],     // слова текущего раунда
      guessedWords: [],   // угаданные слова
      pairs: [],          // для solo режима
      teams: [[], []],    // для team режима
      scores: {},         // очки
      currentRound: 0,
      activePlayerIndex: 0,
      wordsSubmitted: new Set(),
    };

    room.currentGame = gameData;
    console.log(room.participants.size);
    
    io.to(roomId).emit("phase_changed", {
      phase: "enterWords",
      roundTime,
      wordsPerPlayer,
      waitingStatus: { submitted: 0, total: room.participants.size }
    });
    
  } catch (err) {
    console.error("Ошибка при создании игры:", err);
    socket.emit("error_message", "Ошибка при создании игры");
  }
});

socket.on("submit_words", async ({ words }) => {
  const roomId = socket.data.roomId;
  const userId = socket.data.userId;
  const room = activeRooms.get(roomId);
  const game = room?.currentGame;
  if (!game || game.phase !== "enterWords") return;

  try {
    const wordRecords = words.map(word => ({
      game_id: game.id,
      user_id: userId,
      word: word
    }));

    await GameWord.bulkCreate(wordRecords);

    game.wordsSubmitted.add(socket.data.userId);
    game.allWords.push(...words);

    if (game.wordsSubmitted.size === room.participants.size) {
      game.roundWords = shuffleArray([...game.allWords]);
      game.currentRound = 0;
      game.activePlayerIndex = 0;
      game.phase = "prepare_round";

      const participantsArrayData = Array.from(room.participants.values()).map(p => ({
        id: p.userId,
        name: p.name,
      }));
      
      io.to(roomId).emit("phase_changed", {
        phase: "prepare_round",
        round: game.currentRound,
        type: game.type,
        mode: game.mode,
        roundTime: game.roundTime,
        wordsPerPlayer: game.wordsPerPlayer,
        participants: participantsArrayData,
      });
    } else {
      io.to(roomId).emit("waiting_for_players", {
        submitted: game.wordsSubmitted.size,
        total: room.participants.size,
      });
    }
  } catch (err) {
    console.error("Ошибка при сохранении слов:", err);
    socket.emit("error_message", "Ошибка при сохранении слов");
  }
});

socket.on("set_pairs", ({ pairs }) => {
  const roomId = socket.data.roomId;
  const game = activeRooms.get(roomId)?.currentGame;
  if (!game || game.mode !== "solo") return;

  game.pairs = pairs;
  game.activePlayerIndex = 0;
  game.phase = "game";

  const firstPair = pairs[0];

  io.to(roomId).emit("phase_changed", {
    phase: "game",
    currentWord: null,
    activePlayerId: firstPair.explainer.id,
    guesserId: firstPair.guesser.id,
    round: game.currentRound,
    scores: game.scores,
  });
});

socket.on("set_teams", ({ teams }) => {
  const roomId = socket.data.roomId;
  const game = activeRooms.get(roomId)?.currentGame;
  if (!game || game.mode !== "team") return;

  game.teams = teams;
  game.activePlayerIndex = 0;
  game.phase = "game";

  const explainerId = teams[0][0];
  const guesserId = teams[1][0];
  game.roundWords = shuffleArray([...game.allWords]);

  io.to(roomId).emit("phase_changed", {
    phase: "game",
    currentWord: null,
    activePlayerId: explainerId,
    guesserId,
    round: game.currentRound,
    scores: game.scores,
  });
});

socket.on("player_ready", () => {
  const roomId = socket.data.roomId;
  const game = activeRooms.get(roomId)?.currentGame;
  if (!game || game.phase !== "game") return;

  let currentPair;
  if (game.mode === "solo") {
    currentPair = game.pairs[game.activePlayerIndex];
  } else {
    currentPair = {
      explainer: { id: game.teams[0][game.activePlayerIndex] },
      guesser: { id: game.teams[1][game.activePlayerIndex] },
    };
  }

  if (socket.data.userId !== currentPair.explainer.id) return;

  const word = game.roundWords[0] || null;
  io.to(socket.id).emit("reveal_word", { word });

  const duration = game.roundTime[game.currentRound];
  startTurnTimer(duration, roomId, game, socket);
});

socket.on("word_guessed", async () => {
  const roomId = socket.data.roomId;
  const room = activeRooms.get(roomId);
  const game = activeRooms.get(roomId)?.currentGame;
  if (!game || game.roundWords.length === 0) return;

  const guessedWord = game.roundWords.shift();
  game.guessedWords.push(guessedWord);

  let currentPair;
  if (game.mode === "solo") {
    currentPair = game.pairs[game.activePlayerIndex];
    const explainerId = currentPair.explainer.id;
    const guesserId = currentPair.guesser.id;

    game.scores[explainerId] = (game.scores[explainerId] || 0) + 1;
    game.scores[guesserId] = (game.scores[guesserId] || 0) + 1;

    try {
      for (const playerId of [explainerId, guesserId]) {
        await GameScore.upsert({
          game_id: game.id,
          user_id: playerId,
          score: (game.scores[playerId] || 0)
        }, {
          returning: false
        });
      }
    } catch (err) {
      console.error("Ошибка обновления очков:", err);
    }
  } else {
    currentPair = {
      explainer: { id: game.teams[0][game.activePlayerIndex] },
      guesser: { id: game.teams[1][game.activePlayerIndex] },
    };
  }

  if (game.roundWords.length > 0) {
    console.log(game.roundWords);
    const nextWord = game.roundWords[0];
    console.log(nextWord);
    io.to(currentPair.explainer.id).emit("reveal_word", { word: nextWord });
    io.to(roomId).emit("next_word", {
      word: nextWord,
      scores: game.scores,
    });
  } else {
    game.phase = "prepare_round";
    game.currentRound++;
    game.activePlayerIndex = 0;

    if (game.currentRound >= game.roundTime.length) {
      await finishGame(roomId);
      return;
    }

    game.roundWords = shuffleArray([...game.allWords]);

    io.to(roomId).emit("phase_changed", {
      phase: "prepare_round",
      round: game.currentRound,
      scores: game.scores,
    });
  }
});

socket.on("end_turn", () => {
  const roomId = socket.data.roomId;
  const game = activeRooms.get(roomId)?.currentGame;
  if (!game || game.phase !== "game") return;

  endTurnServer(roomId, game);
});


socket.on("end_game_early", async () => {
  const roomId = socket.data.roomId;
  const game = activeRooms.get(roomId)?.currentGame;
  if (!game) return;
  await finishGame(roomId);
});

socket.on("start_game_request", () => {
  const roomId = socket.data.roomId;
  const room = activeRooms.get(roomId);
  if (!room || room.creatorUserId !== socket.data.userId) return;

  io.to(roomId).emit("game_started");
});

});
}

module.exports = initSocket;