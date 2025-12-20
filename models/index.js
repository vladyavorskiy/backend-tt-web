const { Sequelize, DataTypes } = require('sequelize');

const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  logging: true,
});

const User = sequelize.define('User', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  username: {
    type: DataTypes.STRING,
    unique: true,
    allowNull: false,
  },
  password_hash: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  current_session_id: {
    type: DataTypes.STRING,
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'users',
  timestamps: false,
});

const Room = sequelize.define('Room', {
  id: {
    type: DataTypes.UUID,
    primaryKey: true,
    defaultValue: DataTypes.UUIDV4,
  },
//   name: {
//     type: DataTypes.STRING,
//     allowNull: false,
//   },
  creator_user_id: {
    type: DataTypes.INTEGER,
    references: {
      model: 'users',
      key: 'id',
    },
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'rooms',
  timestamps: false,
});

const RoomUser = sequelize.define('RoomUser', {
  id: {
    type: DataTypes.UUID,
    primaryKey: true,
    defaultValue: DataTypes.UUIDV4,
  },
  room_id: {
    type: DataTypes.UUID,
    references: {
      model: 'rooms',
      key: 'id',
    },
  },
  user_id: {
    type: DataTypes.INTEGER,
    references: {
      model: 'users',
      key: 'id',
    },
  },
  session_id: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  socket_id: {
    type: DataTypes.STRING,
  },
  joined_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'room_users',
  timestamps: false,
  indexes: [
    {
      unique: true,
      fields: ['room_id', 'session_id'],
    },
  ],
});

const Message = sequelize.define('Message', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  room_id: {
    type: DataTypes.UUID,
    references: {
      model: 'rooms',
      key: 'id',
    },
  },
  user_id: {
    type: DataTypes.INTEGER,
    references: {
      model: 'users',
      key: 'id',
    },
  },
  sender_name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  message: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'messages',
  timestamps: false,
});

const Game = sequelize.define('Game', {
  id: {
    type: DataTypes.UUID,
    primaryKey: true,
    defaultValue: DataTypes.UUIDV4,
  },
  room_id: {
    type: DataTypes.UUID,
    references: {
      model: 'rooms',
      key: 'id',
    },
  },
  creator_user_id: {
    type: DataTypes.INTEGER,
    references: {
      model: 'users',
      key: 'id',
    },
  },
  type: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  mode: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  round_time: {
    type: DataTypes.ARRAY(DataTypes.INTEGER),
  },
  words_per_player: {
    type: DataTypes.INTEGER,
    defaultValue: 3,
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
  ended_at: {
    type: DataTypes.DATE,
  },
}, {
  tableName: 'games',
  timestamps: false,
});

const GameWord = sequelize.define('GameWord', {
  id: {
    type: DataTypes.UUID,
    primaryKey: true,
    defaultValue: DataTypes.UUIDV4,
  },
  game_id: {
    type: DataTypes.UUID,
    references: {
      model: 'games',
      key: 'id',
    },
  },
  user_id: {
    type: DataTypes.INTEGER,
    references: {
      model: 'users',
      key: 'id',
    },
  },
  word: {
    type: DataTypes.STRING,
    allowNull: false,
  },
}, {
  tableName: 'game_words',
  timestamps: false,
});

const GameScore = sequelize.define('GameScore', {
  id: {
    type: DataTypes.UUID,
    primaryKey: true,
    defaultValue: DataTypes.UUIDV4,
  },
  game_id: {
    type: DataTypes.UUID,
    references: {
      model: 'games',
      key: 'id',
    },
  },
  user_id: {
    type: DataTypes.INTEGER,
    references: {
      model: 'users',
      key: 'id',
    },
  },
  team_id: {
    type: DataTypes.INTEGER,
  },
  score: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
}, {
  tableName: 'game_scores',
  timestamps: false,
  indexes: [
    {
      unique: true,
      fields: ['game_id', 'user_id'],
    },
  ],
});


Room.hasMany(RoomUser, { foreignKey: 'room_id' });
RoomUser.belongsTo(Room, { foreignKey: 'room_id' });

User.hasMany(RoomUser, { foreignKey: 'user_id' });
RoomUser.belongsTo(User, { foreignKey: 'user_id' });

User.hasMany(Message, { foreignKey: 'user_id' });
Message.belongsTo(User, { foreignKey: 'user_id' });

Room.hasMany(Message, { foreignKey: 'room_id' });
Message.belongsTo(Room, { foreignKey: 'room_id' });

Room.hasMany(Game, { foreignKey: 'room_id' });
Game.belongsTo(Room, { foreignKey: 'room_id' });

User.hasMany(Game, { foreignKey: 'creator_user_id' });
Game.belongsTo(User, { foreignKey: 'creator_user_id' });

Game.hasMany(GameWord, { foreignKey: 'game_id' });
GameWord.belongsTo(Game, { foreignKey: 'game_id' });

User.hasMany(GameWord, { foreignKey: 'user_id' });
GameWord.belongsTo(User, { foreignKey: 'user_id' });

Game.hasMany(GameScore, { foreignKey: 'game_id' });
GameScore.belongsTo(Game, { foreignKey: 'game_id' });

User.hasMany(GameScore, { foreignKey: 'user_id' });
GameScore.belongsTo(User, { foreignKey: 'user_id' });

sequelize.sync();

module.exports = {
  sequelize,
  User,
  Room,
  RoomUser,
  Message,
  Game,
  GameWord,
  GameScore,
};