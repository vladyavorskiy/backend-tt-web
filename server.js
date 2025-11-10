require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const apiRoutes = require("./api");
const initSocket = require("./socket");

const PORT = process.env.PORT || 4000;

const app = express();

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());
app.use("/api", apiRoutes);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', credentials: true } });

initSocket(io);

server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));