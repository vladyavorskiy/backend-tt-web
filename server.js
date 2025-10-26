require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { query, pool } = require('./db');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_key';

const app = express();
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', credentials: true } });

const activeRooms = new Map();
const sessionToRoom = new Map();

// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ

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

function shuffleArray(array) {
  return array.sort(() => Math.random() - 0.5);
}

// API: Пользователи

app.post('/api/register', async (req, res) => {
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

app.post('/api/login', async (req, res) => {
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

app.get('/api/user/profile', async (req, res) => {
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

app.put('/api/user/update_profile', async (req, res) => {
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

// API: Комнаты

app.post('/api/rooms', async (req, res) => {
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


// SOCKET.IO

io.on('connection', (socket) => {
  console.log('Подключен:', socket.id);

  socket.on('join_room', async (data) => {
    const { roomId, userId, sessionId: providedSessionId } = data || {};
    if (!roomId || !userId) return socket.emit('error_message', 'Неверные параметры join_room');

    const sessionKey = providedSessionId || uuidv4();
    socket.data.sessionId = sessionKey;
    socket.data.userId = userId;
    socket.data.roomId = roomId;

    try {
      const roomRes = await query('SELECT id, creator_user_id FROM rooms WHERE id = $1', [roomId]);
      if (roomRes.rowCount === 0) return socket.emit('room_not_found');

      const creatorUserId = roomRes.rows[0].creator_user_id;

      if (!activeRooms.has(roomId)) {
        const dbUsers = await query(
          `SELECT ru.session_id, ru.user_id, ru.socket_id, u.username
           FROM room_users ru
           JOIN users u ON ru.user_id = u.id
           WHERE ru.room_id = $1`,
          [roomId]
        );
        const participantsMap = new Map();
        dbUsers.rows.forEach(u => {
          participantsMap.set(u.session_id, { userId: u.user_id, name: u.username, socketId: u.socket_id, sessionId: u.session_id });
        });
        activeRooms.set(roomId, { creatorUserId, participants: participantsMap });
      }

      const roomData = activeRooms.get(roomId);
      const userRes = await query('SELECT username FROM users WHERE id = $1', [userId]);
      const username = userRes.rows[0].username;

      const isFirstJoin = !roomData.participants.has(sessionKey);
      roomData.participants.set(sessionKey, { userId, name: username, socketId: socket.id, sessionId: sessionKey });
      sessionToRoom.set(sessionKey, roomId);

      await query(
        `INSERT INTO room_users (room_id, user_id, session_id, socket_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (room_id, session_id)
         DO UPDATE SET socket_id = EXCLUDED.socket_id, user_id = EXCLUDED.user_id`,
        [roomId, userId, sessionKey, socket.id]
      );

      socket.join(roomId);

      const messagesRes = await query('SELECT sender_name, message, created_at FROM messages WHERE room_id = $1 ORDER BY created_at ASC', [roomId]);
      socket.emit('chat_history', messagesRes.rows || []);

      if (isFirstJoin && userId !== roomData.creatorUserId) {
        const joinMessage = `${username} присоединился к комнате`;
        await query('INSERT INTO messages (room_id, sender_name, message) VALUES ($1, $2, $3)', [roomId, 'Система', joinMessage]);
        io.to(roomId).emit('receive_message', { from: { id: 'system', name: 'Система' }, text: joinMessage });
      }

      broadcastParticipants(roomId, roomData, sessionKey);

      socket.emit('joined', {
        roomId,
        participants: participantsArray(roomData, sessionKey),
        isCreator: creatorUserId === userId,
        creatorUserId,
      });
    } catch (err) {
      console.error(err);
      socket.emit('error_message', 'Ошибка сервера');
    }
  });

  socket.on('send_message', async (message) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const userRes = await query('SELECT username FROM users WHERE id = $1', [socket.data.userId]);
    const username = userRes.rows[0].username;

    await query('INSERT INTO messages (room_id, user_id, sender_name, message) VALUES ($1, $2, $3, $4)', [roomId, socket.data.userId, username, message]);
    io.to(roomId).emit('receive_message', { from: { id: socket.data.userId, name: username }, text: message });
  });

  socket.on('leave_room_request', async () => {
    const sessionId = socket.data.sessionId;
    const roomId = socket.data.roomId;
    if (!roomId || !activeRooms.has(roomId)) return socket.emit('error_message', 'Вы не в комнате');

    await removeUserFromRoomBySession(sessionId, true);
    socket.leave(roomId);
    socket.data.roomId = null;
    socket.emit('left_room_success');
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
    await query('DELETE FROM messages WHERE room_id = $1', [roomId]);
    await query('DELETE FROM room_users WHERE room_id = $1', [roomId]);
    await query('DELETE FROM rooms WHERE id = $1', [roomId]);

    for (const [sessId] of roomData.participants) sessionToRoom.delete(sessId);

    const clients = await io.in(roomId).fetchSockets();
    for (const client of clients) {
      client.leave(roomId);
      client.data.roomId = null;
    }

    activeRooms.delete(roomId);
  });

  socket.on('disconnect', () => {
    const { roomId, sessionId } = socket.data || {};
    if (!roomId || !activeRooms.has(roomId)) return;

    const roomData = activeRooms.get(roomId);
    const user = roomData.participants.get(sessionId);
    if (user) user.socketId = null;

    console.log(`Пользователь ${sessionId} временно отключился`);
  });


socket.on("create_game", ({ type, mode, roundTime, wordsPerPlayer }) => {
  const roomId = socket.data.roomId;
  const room = activeRooms.get(roomId);
  if (!room) return;

  const game = {
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

  room.currentGame = game;

  io.to(roomId).emit("phase_changed", {
    phase: "enterWords",
    roundTime,
    wordsPerPlayer,
  });
});

socket.on("submit_words", ({ words }) => {
  const roomId = socket.data.roomId;
  const room = activeRooms.get(roomId);
  const game = room?.currentGame;
  if (!game || game.phase !== "enterWords") return;

  game.wordsSubmitted.add(socket.data.userId);
  game.allWords.push(...words);

  if (game.wordsSubmitted.size === room.participants.size) {
    game.roundWords = shuffleArray([...game.allWords]);
    game.currentRound = 0;
    game.activePlayerIndex = 0;
    game.phase = "prepare_round";

    const participantsArray = Array.from(room.participants.values()).map(p => ({
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
      participants: participantsArray,
    });
  } else {
    io.to(roomId).emit("waiting_for_players", {
      submitted: game.wordsSubmitted.size,
      total: room.participants.size,
    });
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

socket.on("word_guessed", () => {
  const roomId = socket.data.roomId;
  const game = activeRooms.get(roomId)?.currentGame;
  if (!game || game.roundWords.length === 0) return;

  const guessedWord = game.roundWords.shift();
  game.guessedWords.push(guessedWord);

  let currentPair;
  if (game.mode === "solo") {
    currentPair = game.pairs[game.activePlayerIndex];
    game.scores[currentPair.explainer.id] =
      (game.scores[currentPair.explainer.id] || 0) + 1;
    game.scores[currentPair.guesser.id] =
      (game.scores[currentPair.guesser.id] || 0) + 1;
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
      game.phase = "finished";
      io.to(roomId).emit("phase_changed", {
        phase: "finished",
        scores: game.scores,
      });
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


socket.on("end_game_early", () => {
  const roomId = socket.data.roomId;
  const game = activeRooms.get(roomId)?.currentGame;
  if (!game) return;

  game.phase = "finished";
  io.to(roomId).emit("phase_changed", {
    phase: "finished",
    scores: game.scores,
  });
});

socket.on("start_game_request", () => {
  const roomId = socket.data.roomId;
  const room = activeRooms.get(roomId);
  if (!room || room.creatorUserId !== socket.data.userId) return;

  io.to(roomId).emit("game_started");
  io.to(roomId).emit("phase_changed", { phase: "setup" });
});

function startTurnTimer(duration, roomId, game, socket) {
  let timeLeft = duration;

  const interval = setInterval(() => {
    if (!game || game.phase !== "game") {
      clearInterval(interval);
      return;
    }

    io.to(roomId).emit("update_timer", { timeLeft });

    timeLeft -= 1;
    if (timeLeft < 0) {
      clearInterval(interval);
      endTurnServer(roomId, game);
    }
  }, 1000);
}


function endTurnServer(roomId, game) {
  game.activePlayerIndex++;
  const totalPairs =
    game.mode === "solo"
      ? game.pairs.length
      : Math.min(game.teams[0].length, game.teams[1].length);

  if (game.activePlayerIndex >= totalPairs) {
    game.activePlayerIndex = 0;
    if (game.roundWords.length === 0) {
      game.currentRound++;
      if (game.currentRound >= game.roundTime.length) {
        game.phase = "finished";
        io.to(roomId).emit("phase_changed", {
          phase: "finished",
          scores: game.scores,
        });
        return;
      }
      game.roundWords = shuffleArray([...game.allWords]);

    }
  }

  let nextPair;
  if (game.mode === "solo") {
    nextPair = game.pairs[game.activePlayerIndex];
  } else {
    nextPair = {
      explainer: { id: game.teams[0][game.activePlayerIndex] },
      guesser: { id: game.teams[1][game.activePlayerIndex] },
    };
  }

  io.to(roomId).emit("turn_changed", {
    activePlayerId: nextPair.explainer.id,
    guesserId: nextPair.guesser.id,
    word: null,
    round: game.currentRound,
    scores: game.scores,
  });
}
});


server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));