// server.js

require('dotenv').config(); // Loads .env variables into process.env

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');
// bad-words will be imported dynamically

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

// --- Game Constants ---
const GRID_SIZE = 20;
const TICK_RATE = 150;
const MIN_SNAKE_LENGTH = 2;
const DEBUFF_TRIGGER_COUNT = 3;
const DEBUFF_SHRINK_AMOUNT = 2;
const COUNTDOWN_SECONDS = 3;

// --- Game State Variables ---
let players = {}; // { socketId: { playerId, name, color, socketId } }
let boards = { 1: null, 2: null };
let playerSockets = { 1: null, 2: null }; // Map playerId to socketId

let gameInterval = null;
let countdownInterval = null;
let currentCountdown = COUNTDOWN_SECONDS;
let gameActuallyRunning = false;
let restartRequests = new Set();

// --- Mongoose Setup ---
mongoose.connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
})
.then(() => console.log('Successfully connected to MongoDB!'))
.catch(err => {
    console.error('Error connecting to MongoDB:', err.message);
    process.exit(1);
});

const scoreSchema = new mongoose.Schema({
    playerName: { type: String, required: true, trim: true, minlength: 2, maxlength: 15 },
    score: { type: Number, required: true, min: 0 },
    timestamp: { type: Date, default: Date.now }
});
const Score = mongoose.model('Score', scoreSchema);

// --- Utility Functions ---
function createNewBoardState(playerId, playerNameFromArg) {
    const playerName = playerNameFromArg || `Player ${playerId}`;
    const startX = Math.floor(GRID_SIZE / 4);
    const startY = Math.floor(GRID_SIZE / 2);
    const startColor = playerId === 1 ? 'green' : 'blue';
    const initialSnake = [{ x: startX, y: startY }, { x: startX - 1, y: startY }];
    return {
        playerId: playerId,
        snake: initialSnake,
        direction: 'RIGHT',
        color: startColor,
        score: 0,
        food: getRandomPosition(initialSnake),
        debuffs: [],
        powerups: [], // You can add power-up logic later
        foodEatenCounter: 0,
        isGameOver: false,
        playerName: playerName
    };
}

function resetBoardStatesOnly() {
    console.log("Resetting game board states.");
    const p1Name = (playerSockets[1] && players[playerSockets[1]]) ? players[playerSockets[1]].name : `Player 1`;
    const p2Name = (playerSockets[2] && players[playerSockets[2]]) ? players[playerSockets[2]].name : `Player 2`;

    boards[1] = createNewBoardState(1, p1Name);
    boards[2] = createNewBoardState(2, p2Name);
    gameActuallyRunning = false;

    if (playerSockets[1] && players[playerSockets[1]]) {
        boards[1].color = players[playerSockets[1]].color;
    }
    if (playerSockets[2] && players[playerSockets[2]]) {
        boards[2].color = players[playerSockets[2]].color;
    }
    if (boards[1]) boards[1].food = getRandomPosition(boards[1].snake);
    if (boards[2]) boards[2].food = getRandomPosition(boards[2].snake);
}

function clearAllIntervalsAndRequests() {
    if (gameInterval) { clearInterval(gameInterval); gameInterval = null; }
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
    restartRequests.clear();
    gameActuallyRunning = false;
}

function getRandomPosition(exclude = []) {
    let position, occupied = true, attempts = 0;
    const maxAttempts = GRID_SIZE * GRID_SIZE;
    while (occupied && attempts < maxAttempts) {
        position = { x: Math.floor(Math.random() * GRID_SIZE), y: Math.floor(Math.random() * GRID_SIZE) };
        occupied = exclude.some(item => item && item.x === position.x && item.y === position.y);
        attempts++;
    }
    if (occupied) console.warn("Could not find an empty spot for item after max attempts!");
    return position || { x: 0, y: 0 };
}

function getBoardsWithPlayerNames() {
    const currentBoards = {};
    if (boards[1]) {
        currentBoards[1] = { ...boards[1], playerName: (playerSockets[1] && players[playerSockets[1]]) ? players[playerSockets[1]].name : (boards[1].playerName || 'Player 1') };
    } else {
        currentBoards[1] = null;
    }
    if (boards[2]) {
        currentBoards[2] = { ...boards[2], playerName: (playerSockets[2] && players[playerSockets[2]]) ? players[playerSockets[2]].name : (boards[2].playerName || 'Player 2') };
    } else {
        currentBoards[2] = null;
    }
    return currentBoards;
}

// --- Game Start Sequence ---
function initiateGameStartSequence() {
    if (!playerSockets[1] || !players[playerSockets[1]] || !playerSockets[2] || !players[playerSockets[2]]) {
        console.log("Cannot start game sequence, not enough players fully joined (with names).");
        return;
    }
    if (gameInterval || countdownInterval) {
        console.log("Game sequence or game already in progress. Aborting new sequence.");
        return;
    }
    console.log("Initiating game start sequence...");
    clearAllIntervalsAndRequests();

    boards[1] = createNewBoardState(1, players[playerSockets[1]].name);
    boards[2] = createNewBoardState(2, players[playerSockets[2]].name);
    boards[1].color = players[playerSockets[1]].color;
    boards[2].color = players[playerSockets[2]].color;

    io.emit('gameState', getBoardsWithPlayerNames());

    currentCountdown = COUNTDOWN_SECONDS;
    io.emit('countdownUpdate', currentCountdown);
    countdownInterval = setInterval(() => {
        currentCountdown--;
        if (currentCountdown > 0) {
            io.emit('countdownUpdate', currentCountdown);
        } else if (currentCountdown === 0) {
            io.emit('countdownUpdate', 'GO!');
        } else {
            clearInterval(countdownInterval);
            countdownInterval = null;
            io.emit('countdownUpdate', null);
            console.log("Countdown finished. Starting game loop.");
            startGameLoop();
        }
    }, 1000);
}

function startGameLoop() {
    if (gameInterval) return;
    gameActuallyRunning = true;
    console.log("Starting game loop (snakes moving)...");
    gameInterval = setInterval(updateGameTick, TICK_RATE);
}

// --- Express Setup ---
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- API Endpoints ---
app.get('/api/leaderboard', async (req, res) => {
    try {
        const topScores = await Score.find({})
                                    .sort({ score: -1 })
                                    .limit(10)
                                    .select('playerName score timestamp');
        res.json(topScores);
    } catch (error) {
        console.error("Error fetching leaderboard:", error);
        res.status(500).json({ message: "Error fetching leaderboard data." });
    }
});

// --- Main Server Initialization Function ---
let filterInstance;

async function initializeServer() {
    try {
        const badWordsModule = await import('bad-words');
        const FilterClass = badWordsModule.default;
        filterInstance = new FilterClass();
        console.log("Profanity filter initialized.");

        // --- Socket.IO Connection Handling (AFTER filter is ready) ---
        io.on('connection', (socket) => {
            console.log('User connected:', socket.id, "- Awaiting 'joinGame' with name.");

            socket.on('joinGame', (data) => {
                if (!data || typeof data.name !== 'string') {
                    socket.emit('nameRejected', { message: 'Invalid join request data.' });
                    return;
                }
                const playerName = data.name.trim();

                if (players[socket.id]) {
                    console.log(`Socket ${socket.id} (Player ${players[socket.id].name}) tried to join again.`);
                    socket.emit('alreadyJoined', { message: 'You are already in the game.' });
                    return;
                }

                if (!playerName || playerName.length < 2 || playerName.length > 15) {
                    socket.emit('nameRejected', { message: 'Name must be between 2 and 15 characters.' });
                    return;
                }
                if (!/^[a-zA-Z0-9_-\s]+$/.test(playerName)) {
                    socket.emit('nameRejected', { message: 'Name contains invalid characters.' });
                    return;
                }
                try {
                    if (filterInstance.isProfane(playerName)) {
                        console.log(`Name rejected by filter for ${socket.id}: ${playerName}`);
                        socket.emit('nameRejected', { message: 'The name you chose contains inappropriate language. Please pick another.' });
                        return;
                    }
                } catch (e) {
                    console.error("Profanity filter error:", e);
                    socket.emit('nameRejected', { message: 'This name cannot be used on the server. Please try again.' });
                    return;
                }

                let assignedPlayerId = null;
                if (!playerSockets[1]) {
                    assignedPlayerId = 1;
                } else if (!playerSockets[2]) {
                    assignedPlayerId = 2;
                } else {
                    socket.emit('gameFull', { message: 'Sorry, the game is currently full.' });
                    console.log('Game full when', playerName, 'tried to join with socket:', socket.id);
                    return;
                }

                playerSockets[assignedPlayerId] = socket.id;
                players[socket.id] = {
                    playerId: assignedPlayerId,
                    color: assignedPlayerId === 1 ? 'green' : 'blue',
                    name: playerName,
                    socketId: socket.id
                };

                boards[assignedPlayerId] = createNewBoardState(assignedPlayerId, playerName);
                boards[assignedPlayerId].isGameOver = false;

                console.log(`Player ${assignedPlayerId} (${playerName}, ${socket.id}) joined.`);
                socket.emit('init', {
                    yourPlayerId: assignedPlayerId,
                    gridSize: GRID_SIZE,
                    cellSize: 20,
                    yourName: playerName
                });

                const opponentId = assignedPlayerId === 1 ? 2 : 1;
                if (playerSockets[opponentId] && players[playerSockets[opponentId]]) {
                    io.to(playerSockets[opponentId]).emit('opponentNameUpdate', {
                        playerId: assignedPlayerId,
                        name: playerName
                    });
                    socket.emit('opponentNameUpdate', {
                        playerId: opponentId,
                        name: players[playerSockets[opponentId]].name
                    });
                }

                if (playerSockets[1] && playerSockets[2]) {
                    console.log("Both players are now in. Initiating game sequence.");
                    initiateGameStartSequence();
                } else {
                    console.log(`Player ${playerName} is waiting for an opponent.`);
                    socket.emit('waiting');
                    io.emit('gameState', getBoardsWithPlayerNames());
                }
            });

            socket.on('directionChange', (newDirection) => {
                if (!gameActuallyRunning) return;
                const playerInfo = players[socket.id];
                if (!playerInfo || !boards[playerInfo.playerId] || boards[playerInfo.playerId].isGameOver) return;

                const board = boards[playerInfo.playerId];
                const currentDir = board.direction;
                if (
                    (newDirection === 'UP' && currentDir !== 'DOWN') ||
                    (newDirection === 'DOWN' && currentDir !== 'UP') ||
                    (newDirection === 'LEFT' && currentDir !== 'RIGHT') ||
                    (newDirection === 'RIGHT' && currentDir !== 'LEFT')
                ) {
                    board.direction = newDirection;
                }
            });

            socket.on('requestRestart', () => {
                if (!players[socket.id]) return;
                const playerInfo = players[socket.id];
                console.log(`Player ${playerInfo.name} (ID: ${playerInfo.playerId}, Socket: ${socket.id}) requested restart.`);
                restartRequests.add(socket.id);

                io.to(socket.id).emit('restartRequestedByYou');

                const opponentId = playerInfo.playerId === 1 ? 2 : 1;
                const opponentSocketId = playerSockets[opponentId];
                if (opponentSocketId && players[opponentSocketId]) {
                    io.to(opponentSocketId).emit('opponentRequestedRestart');
                }

                let connectedPlayerRequests = 0;
                if (playerSockets[1] && restartRequests.has(playerSockets[1])) connectedPlayerRequests++;
                if (playerSockets[2] && restartRequests.has(playerSockets[2])) connectedPlayerRequests++;

                if (playerSockets[1] && playerSockets[2] && connectedPlayerRequests === 2) {
                    console.log("Both connected players requested restart. Starting new game sequence.");
                    io.emit('allPlayersReadyForRestart');
                    initiateGameStartSequence();
                }
            });

            socket.on('disconnect', () => {
                console.log('User disconnected:', socket.id);
                const disconnectedPlayerInfo = players[socket.id];
                restartRequests.delete(socket.id);

                if (disconnectedPlayerInfo) {
                    const disconnectedPlayerId = disconnectedPlayerInfo.playerId;
                    const disconnectedPlayerName = disconnectedPlayerInfo.name;
                    console.log(`${disconnectedPlayerName} (ID: ${disconnectedPlayerId}) disconnected.`);

                    playerSockets[disconnectedPlayerId] = null;
                    if(boards[disconnectedPlayerId]) {
                        boards[disconnectedPlayerId].isGameOver = true;
                    }
                    delete players[socket.id];

                    const remainingPlayerId = disconnectedPlayerId === 1 ? 2 : 1;
                    const remainingPlayerSocketId = playerSockets[remainingPlayerId];

                    if (gameInterval || countdownInterval || gameActuallyRunning) {
                        clearAllIntervalsAndRequests();
                        if (remainingPlayerSocketId && players[remainingPlayerSocketId]) {
                            if(boards[remainingPlayerId]) boards[remainingPlayerId].isGameOver = false;
                            io.to(remainingPlayerSocketId).emit('gameOver', { winnerId: remainingPlayerId, reason: 'opponentLeft' });
                            io.to(remainingPlayerSocketId).emit('waiting');
                        } else {
                            resetBoardStatesOnly();
                        }
                    } else if (remainingPlayerSocketId && players[remainingPlayerSocketId]){
                         io.to(remainingPlayerSocketId).emit('opponentNameUpdate', {
                            playerId: disconnectedPlayerId,
                            name: `Player ${disconnectedPlayerId}`
                        });
                        io.to(remainingPlayerSocketId).emit('waiting');
                        boards[disconnectedPlayerId] = createNewBoardState(disconnectedPlayerId); // Reset this board slot
                    } else if (!playerSockets[1] && !playerSockets[2]) {
                        console.log("All players disconnected. Resetting for new game.");
                        resetBoardStatesOnly();
                    }
                    io.emit('gameState', getBoardsWithPlayerNames());
                } else {
                    console.log(`Socket ${socket.id} disconnected but was not in the active players list.`);
                }
            });
        }); // End of io.on('connection')

        // Start listening AFTER filter is ready and io handlers are set up
        server.listen(PORT, () => {
            console.log(`Server listening on port ${PORT}`);
            resetBoardStatesOnly();
            console.log("Server ready. Initial board states created.");
        });

    } catch (err) {
        console.error("Failed to initialize server or load profanity filter:", err);
        process.exit(1);
    }
}

// --- Game Update Logic ---
async function savePlayerScore(playerName, score) {
    if (!playerName || typeof score !== 'number' || score < 0) { // Allow score 0 to be saved
        console.log(`Not saving score for ${playerName} with score ${score} (invalid name/score).`);
        if (score < 0) return; // Do not save negative scores
    }
    try {
        const newScore = new Score({ playerName, score });
        await newScore.save();
        console.log(`Score saved for ${playerName}: ${score}`);
    } catch (error) {
        console.error(`Error saving score for ${playerName}:`, error.message);
    }
}

function updateGameTick() {
    if (!gameActuallyRunning || !playerSockets[1] || !players[playerSockets[1]] || !playerSockets[2] || !players[playerSockets[2]]) {
        if(gameActuallyRunning) {
            console.warn("Game tick attempted without two active players or game not running. Stopping.");
            clearAllIntervalsAndRequests();
            if (playerSockets[1] && players[playerSockets[1]]) io.to(playerSockets[1]).emit('waiting');
            if (playerSockets[2] && players[playerSockets[2]]) io.to(playerSockets[2]).emit('waiting');
            resetBoardStatesOnly();
            io.emit('gameState', getBoardsWithPlayerNames());
        }
        return;
    }

    let gameEndedThisTick = false;
    [1, 2].forEach(playerId => {
        if (gameEndedThisTick || !boards[playerId] || boards[playerId].isGameOver) return;

        const board = boards[playerId];
        const opponentId = playerId === 1 ? 2 : 1;
        const opponentBoard = boards[opponentId];

        const currentHead = board.snake[0];
        const nextHead = { ...currentHead };

        switch (board.direction) {
            case 'UP':    nextHead.y -= 1; break;
            case 'DOWN':  nextHead.y += 1; break;
            case 'LEFT':  nextHead.x -= 1; break;
            case 'RIGHT': nextHead.x += 1; break;
        }

        if (nextHead.x < 0 || nextHead.x >= GRID_SIZE || nextHead.y < 0 || nextHead.y >= GRID_SIZE) {
            board.isGameOver = true; gameEndedThisTick = true; return;
        }
        for (let i = 0; i < board.snake.length; i++) {
            if (nextHead.x === board.snake[i].x && nextHead.y === board.snake[i].y) {
                board.isGameOver = true; gameEndedThisTick = true; return;
            }
        }

        let ateFood = false;
        let justShrunkByDebuff = false; // Flag to prevent normal pop if shrunk by debuff

        if (nextHead.x === board.food.x && nextHead.y === board.food.y) {
            ateFood = true;
            board.score += 10;
            board.foodEatenCounter++;
            board.food = getRandomPosition([...board.snake, board.food, ...(board.debuffs || []), ...(board.powerups || [])]);

            if (board.foodEatenCounter >= DEBUFF_TRIGGER_COUNT) {
                board.foodEatenCounter = 0;
                if (opponentBoard && !opponentBoard.isGameOver) {
                    opponentBoard.debuffs.push(getRandomPosition([...opponentBoard.snake, opponentBoard.food, ...(opponentBoard.debuffs || []), ...(opponentBoard.powerups || [])]));
                }
            }
        }

        const eatenDebuffIndex = board.debuffs.findIndex(d => d.x === nextHead.x && d.y === nextHead.y);
        if (eatenDebuffIndex !== -1) {
            board.debuffs.splice(eatenDebuffIndex, 1);
            board.score = Math.max(0, board.score - 5);
            let segmentsToRemove = DEBUFF_SHRINK_AMOUNT;
            while (segmentsToRemove > 0 && board.snake.length > MIN_SNAKE_LENGTH) {
                board.snake.pop();
                segmentsToRemove--;
                justShrunkByDebuff = true;
            }
        }

        board.snake.unshift(nextHead);
        if (!ateFood && !justShrunkByDebuff && board.snake.length > MIN_SNAKE_LENGTH) { // Added !justShrunkByDebuff
            board.snake.pop();
        }
    }); // End of forEach player loop

    const p1Lost = boards[1] ? boards[1].isGameOver : true; // Assume lost if board doesn't exist
    const p2Lost = boards[2] ? boards[2].isGameOver : true;
    let winnerId = null;

    if (p1Lost && p2Lost) {
        winnerId = 0; // Draw
    } else if (p1Lost) {
        winnerId = 2; // Player 2 wins
    } else if (p2Lost) {
        winnerId = 1; // Player 1 wins
    }

    const currentBoardsWithNames = getBoardsWithPlayerNames();

    if (winnerId !== null) { // Game has ended
        clearAllIntervalsAndRequests();
        gameActuallyRunning = false; // Explicitly set
        console.log(`Game Over! Winner: ${winnerId === 0 ? "Draw" : (currentBoardsWithNames[winnerId]?.playerName || `Player ${winnerId}`)}`);

        // Save scores for both players if they were part of the game
        if (playerSockets[1] && players[playerSockets[1]] && boards[1]) {
            savePlayerScore(players[playerSockets[1]].name, boards[1].score);
        }
        if (playerSockets[2] && players[playerSockets[2]] && boards[2]) {
            savePlayerScore(players[playerSockets[2]].name, boards[2].score);
        }

        io.emit('gameOver', { winnerId: winnerId, reason: 'collision' }); // Or 'draw'
        io.emit('gameState', currentBoardsWithNames); // Send final state
    } else {
        // Game continues, send updated state
        io.emit('gameState', currentBoardsWithNames);
    }
} // End of updateGameTick

// --- Start the Server ---
initializeServer().catch(err => {
    console.error("Unhandled error during server startup:", err);
    process.exit(1);
});