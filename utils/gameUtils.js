const { Game, GameScore, Message } = require("../models");
const { activeRooms } = require("./roomUtils");

function shuffleArray(array) {
  return array.sort(() => Math.random() - 0.5);
}

async function finishGame(roomId) {
  try {
    const room = activeRooms.get(roomId);
    if (!room) return;
    const game = room.currentGame;
    if (!game) return;

    try {
      await Game.update(
        { ended_at: new Date() },
        { where: { id: game.id } }
      );
    } catch (err) {
      console.warn("finishGame: couldn't set ended_at (maybe column absent).", err.message || err);
    }

    if (game.scores && Object.keys(game.scores).length > 0) {
      const entries = Object.entries(game.scores);
      for (const [userIdStr, scoreValue] of entries) {
        const userId = Number(userIdStr);
        await GameScore.upsert({
          game_id: game.id,
          user_id: userId,
          score: Number(scoreValue) || 0
        });
      }
    }

    const scoreText = Object.entries(game.scores || {})
      .map(([uid, sc]) => {
        let name = "Игрок";
        try {
          for (const [, p] of (room.participants || [])) {
          }
        } catch (e) {  }
        if (room.participants) {
          for (const p of room.participants.values()) {
            if (p && Number(p.userId) === Number(uid)) { name = p.name || name; break; }
          }
        }
        return `${name}: ${sc}`;
      })
      .join(", ");

    const leaveMessage = scoreText.length ? `Игра завершена — итоговый счёт: ${scoreText}` : `Игра завершена.`;

    try {
      await Message.create({
        room_id: roomId,
        user_id: null,
        sender_name: 'Система',
        message: leaveMessage
      });
    } catch (err) {
      console.warn("finishGame: failed to insert message", err.message || err);
    }

    game.phase = "finished";
    io.to(roomId).emit("phase_changed", { phase: "finished", scores: game.scores });
    io.to(roomId).emit("receive_message", { from: { id: 'system', name: 'Система' }, text: leaveMessage });
    console.log(`finishGame: game ${game.id} finished for room ${roomId}`);
  } catch (err) {
    console.error("finishGame error:", err);
  }
}


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

async function endTurnServer(roomId, game) {
  try {
    if (!game) return;

    game.activePlayerIndex++;
    const totalPairs =
      game.mode === "solo"
        ? (Array.isArray(game.pairs) ? game.pairs.length : 0)
        : Math.min((game.teams[0] || []).length, (game.teams[1] || []).length);

    if (game.activePlayerIndex >= totalPairs) {
      game.activePlayerIndex = 0;

      if (!game.roundWords || game.roundWords.length === 0) {
        game.currentRound++;

        game.pairs = [];

        if (game.currentRound >= (Array.isArray(game.roundTime) ? game.roundTime.length : 0)) {
          await finishGame(roomId);
          return;
        }

        game.roundWords = shuffleArray(game.allWords.filter(w => !game.guessedWords.includes(w)));
        game.phase = "prepare_round";

        io.to(roomId).emit("phase_changed", {
          phase: "prepare_round",
          round: game.currentRound,
          scores: game.scores
        });

        return;
      }
    }

    let nextPair;
    if (game.mode === "solo") {
      nextPair = game.pairs[game.activePlayerIndex] || null;
    } else {
      nextPair = {
        explainer: { id: (game.teams[0] || [])[game.activePlayerIndex] },
        guesser: { id: (game.teams[1] || [])[game.activePlayerIndex] }
      };
    }

    io.to(roomId).emit("turn_changed", {
      activePlayerId: nextPair?.explainer?.id || null,
      guesserId: nextPair?.guesser?.id || null,
      word: null,
      round: game.currentRound,
      scores: game.scores,
    });
  } catch (err) {
    console.error("endTurnServer error:", err);
  }
}

let io;
function setIo(socketIo) {
  io = socketIo;
}

module.exports = { 
  shuffleArray, 
  finishGame, 
  startTurnTimer, 
  endTurnServer,
  setIo
};