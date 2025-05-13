// server.js

require('dotenv').config(); // Loads .env variables into process.env

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');
const Filter = require('bad-words');
const filter = new Filter();

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
let players = {}; // { socketId: { playerId: 1 or 2, color: 'green', name: 'PlayerX' } }
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
function createNewBoardState(playerId) {
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
        powerups: [],
        foodEatenCounter: 0,
        isGameOver: false,
        playerName: `Player ${playerId}` // Default name included here
    };
}

function resetBoardStatesOnly() {
    console.log("Resetting game board states.");
    boards[1] = createNewBoardState(1);
    boards[2] = createNewBoardState(2);
    gameActuallyRunning = false;

    // Sync colors and names if players are already assigned and have custom names
    if (playerSockets[1] && players[playerSockets[1]]) {
        boards[1].color = players[playerSockets[1]].color;
        boards[1].playerName = players[playerSockets[1]].name; // Update with current name
    }
    if (playerSockets[2] && players[playerSockets[2]]) {
        boards[2].color = players[playerSockets[2]].color;
        boards[2].playerName = players[playerSockets[2]].name; // Update with current name
    }
    // Ensure food is placed correctly after name/color potentially set
    boards[1].food = getRandomPosition(boards[1].snake);
    boards[2].food = getRandomPosition(boards[2].snake);
}

function clearAllIntervalsAndRequests() {
    if (gameInterval) { clearInterval(gameInterval); gameInterval = null; }
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
    restartRequests.clear();
    gameActuallyRunning = false;
}

function getRandomPosition(exclude = []) {
    let position, occupied = true, attempts = 0;
    while (occupied && attempts < (GRID_SIZE * GRID_SIZE)) {
        position = { x: Math.floor(Math.random() * GRID_SIZE), y: Math.floor(Math.random() * GRID_SIZE) };
        occupied = exclude.some(item => item && item.x === position.x && item.y === position.y);
        attempts++;
    }
    if (occupied) console.error("Could not find empty spot for item!");
    return position || { x: 0, y: 0 };
}

// Function to prepare board data with current player names for emission
function getBoardsWithPlayerNames() {
    return {
        1: boards[1] ? {
            ...boards[1],
            playerName: (playerSockets[1] && players[playerSockets[1]]) ? players[playerSockets[1]].name : (boards[1].playerName || 'Player 1')
        } : null,
        2: boards[2] ? {
            ...boards[2],
            playerName: (playerSockets[2] && players[playerSockets[2]]) ? players[playerSockets[2]].name : (boards[2].playerName || 'Player 2')
        } : null
    };
}

// --- Game Start Sequence ---
function initiateGameStartSequence() {
    if (!playerSockets[1] || !playerSockets[2]) {
        console.log("Cannot start game sequence, not enough players.");
        return;
    }
    if (gameInterval || countdownInterval) {
        console.log("Game sequence or game already in progress.");
        return;
    }
    console.log("Initiating game start sequence...");
    clearAllIntervalsAndRequests();
    resetBoardStatesOnly();

    io.emit('gameState', getBoardsWithPlayerNames()); // Send initial state with names

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

// --- Socket.IO Connection Handling ---
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    let assignedPlayerId = null;

    if (!playerSockets[1]) { assignedPlayerId = 1; }
    else if (!playerSockets[2]) { assignedPlayerId = 2; }
    else {
        socket.emit('gameFull');
        console.log('Game full, spectator connected or user tried to rejoin:', socket.id);
        return;
    }

    playerSockets[assignedPlayerId] = socket.id;
    const defaultPlayerName = `Player ${assignedPlayerId}`;
    players[socket.id] = { playerId: assignedPlayerId, color: assignedPlayerId === 1 ? 'green' : 'blue', name: defaultPlayerName };

    if (!boards[assignedPlayerId]) { // Should be created by resetBoardStatesOnly if server just started
        boards[assignedPlayerId] = createNewBoardState(assignedPlayerId);
    }
    boards[assignedPlayerId].color = players[socket.id].color;
    boards[assignedPlayerId].playerName = players[socket.id].name; // Set name on board state
    boards[assignedPlayerId].isGameOver = false;

    console.log(`Player ${assignedPlayerId} (${socket.id}) assigned name: ${players[socket.id].name}`);
    socket.emit('init', {
        yourPlayerId: assignedPlayerId,
        gridSize: GRID_SIZE,
        cellSize: 20, // Client uses this to calc canvas size
        defaultName: players[socket.id].name
    });

    // Notify opponent about the new player's name if opponent exists
    const opponentId = assignedPlayerId === 1 ? 2 : 1;
    if (playerSockets[opponentId] && players[playerSockets[opponentId]]) {
        io.to(playerSockets[opponentId]).emit('opponentNameUpdate', {
            playerId: assignedPlayerId,
            name: players[socket.id].name
        });
        // Also send this player the opponent's current name
        socket.emit('opponentNameUpdate', {
            playerId: opponentId,
            name: players[playerSockets[opponentId]].name
        });
    }


    if (playerSockets[1] && playerSockets[2]) {
        initiateGameStartSequence();
    } else {
        socket.emit('waiting');
        io.emit('gameState', getBoardsWithPlayerNames());
    }

    socket.on('submitPlayerName', (name) => {
        if (players[socket.id] && name && typeof name === 'string') {
            const sanitizedName = name.trim().substring(0, 15);
            if (sanitizedName.length >= 2) {
                players[socket.id].name = sanitizedName;
                // Update name on the player's board state directly
                const playerId = players[socket.id].playerId;
                if (boards[playerId]) {
                    boards[playerId].playerName = sanitizedName;
                }
                console.log(`Player ${playerId} (${socket.id}) updated name to: ${sanitizedName}`);
                socket.emit('nameAccepted', sanitizedName);
                // Broadcast name change to opponent
                const opponentSocketId = playerId === 1 ? playerSockets[2] : playerSockets[1];
                if (opponentSocketId && playerSockets[opponentSocketId === playerSockets[1] ? 1 : 2]) {
                    io.to(opponentSocketId).emit('opponentNameUpdate', { playerId: playerId, name: sanitizedName });
                }
                // Resend game state to ensure all clients have up-to-date names on boards
                io.emit('gameState', getBoardsWithPlayerNames());
            } else {
                socket.emit('nameInvalid', 'Name too short (min 2 chars).');
            }
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
        ) { board.direction = newDirection; }
    });

    socket.on('joinGame', (data) => {
        const playerName = data.name ? data.name.trim() : '';
    
        if (!playerName || playerName.length < 2 || playerName.length > 15) {
            socket.emit('nameRejected', { message: 'Name must be between 2 and 15 characters.' });
            return;
        }
        if (!/^[a-zA-Z0-9_-\s]+$/.test(playerName) || playerName.trim() === '') {
             socket.emit('nameRejected', { message: 'Name contains invalid characters.' });
             return;
        }
    
        try {
            if (filter.isProfane(playerName)) {
                console.log(`Name rejected by filter for ${socket.id}: ${playerName}`);
                socket.emit('nameRejected', { message: 'The name you chose contains inappropriate language. Please pick another.' });
                return;
            }
        } catch (e) {
            // Some filters might throw an error on empty strings or weird inputs
            console.error("Profanity filter error:", e);
            socket.emit('nameRejected', { message: 'This name can not be used on the server. Please try again.' });
            return;
        }

        console.log(`Player ${socket.id} chose name: ${playerName}`);
    });
    

    socket.on('requestRestart', () => {
        if (!players[socket.id]) return;
        const playerId = players[socket.id].playerId;
        console.log(`Player ${playerId} (${socket.id}) requested restart.`);
        restartRequests.add(socket.id);
        io.to(socket.id).emit('restartRequestedByYou');
        const opponentSocketId = playerId === 1 ? playerSockets[2] : playerSockets[1];
        if (opponentSocketId && playerSockets[opponentSocketId === playerSockets[1] ? 1 : 2]) {
            io.to(opponentSocketId).emit('opponentRequestedRestart');
        }
        let connectedPlayerRequests = 0;
        if (playerSockets[1] && restartRequests.has(playerSockets[1])) connectedPlayerRequests++;
        if (playerSockets[2] && restartRequests.has(playerSockets[2])) connectedPlayerRequests++;
        if (connectedPlayerRequests === 2 && playerSockets[1] && playerSockets[2]) {
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
            const disconnectedPlayerName = disconnectedPlayerInfo.name || `Player ${disconnectedPlayerId}`;
            console.log(`${disconnectedPlayerName} (ID: ${disconnectedPlayerId}) disconnected.`);

            playerSockets[disconnectedPlayerId] = null;
            delete players[socket.id];

            // Notify remaining player that opponent left (and their name)
            const remainingPlayerId = disconnectedPlayerId === 1 ? 2 : 1;
            if (playerSockets[remainingPlayerId]) {
                io.to(playerSockets[remainingPlayerId]).emit('opponentNameUpdate', {
                    playerId: disconnectedPlayerId,
                    name: `Player ${disconnectedPlayerId}` // Or "Disconnected"
                });
            }


            if (gameInterval || countdownInterval || gameActuallyRunning) {
                clearAllIntervalsAndRequests();
                if(boards[disconnectedPlayerId]) boards[disconnectedPlayerId].isGameOver = true;

                const winnerId = disconnectedPlayerId === 1 ? 2 : 1;
                if (playerSockets[winnerId]) {
                    if(boards[winnerId]) boards[winnerId].isGameOver = false;
                    io.to(playerSockets[winnerId]).emit('gameOver', { winnerId: winnerId, reason: 'opponentLeft' });
                    io.to(playerSockets[winnerId]).emit('waiting');
                } else { resetBoardStatesOnly(); }
                io.emit('gameState', getBoardsWithPlayerNames());
            } else if (!playerSockets[1] && !playerSockets[2]){
                resetBoardStatesOnly();
                io.emit('gameState', getBoardsWithPlayerNames());
            } else {
                 const stillConnectedPlayerSlot = playerSockets[1] ? 1 : (playerSockets[2] ? 2 : null);
                 if(stillConnectedPlayerSlot){
                     io.to(playerSockets[stillConnectedPlayerSlot]).emit('waiting');
                 }
                 // Reset the board of the disconnected player but keep its slot "empty"
                 if(boards[disconnectedPlayerId]) boards[disconnectedPlayerId] = createNewBoardState(disconnectedPlayerId);
                 io.emit('gameState', getBoardsWithPlayerNames());
            }
        }
        if (!playerSockets[1] && !playerSockets[2]) {
             console.log("All players disconnected. Ready for new game.");
             resetBoardStatesOnly(); // Full reset of board states
        }
    });
});

// --- Game Update Logic ---
async function savePlayerScore(playerName, score) {
    if (!playerName || typeof score !== 'number' || score <= 0) return;
    try {
        const newScore = new Score({ playerName, score });
        await newScore.save();
        console.log(`Score saved for ${playerName}: ${score}`);
    } catch (error) { console.error(`Error saving score for ${playerName}:`, error.message); }
}

function updateGameTick() {
    if (!playerSockets[1] || !playerSockets[2]) {
        console.warn("Game tick with missing players. Stopping game.");
        clearAllIntervalsAndRequests();
        resetBoardStatesOnly();
        io.emit('gameState', getBoardsWithPlayerNames());
        io.emit('waiting');
        return;
    }

    let gameEndedThisTick = false;
    [1, 2].forEach(playerId => {
        if (gameEndedThisTick || boards[playerId].isGameOver) return;
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
        let ateFood = false, ateDebuff = false, shrinkAmountApplied = 0;
        if (nextHead.x === board.food.x && nextHead.y === board.food.y) {
            ateFood = true; board.score += 10; board.foodEatenCounter++;
            board.food = getRandomPosition([...board.snake, board.food, ...board.debuffs, ...board.powerups]);
            if (board.foodEatenCounter >= DEBUFF_TRIGGER_COUNT) {
                board.foodEatenCounter = 0;
                if (opponentBoard && !opponentBoard.isGameOver) {
                    opponentBoard.debuffs.push(getRandomPosition([...opponentBoard.snake, opponentBoard.food, ...opponentBoard.debuffs, ...opponentBoard.powerups]));
                }
            }
        }
        const eatenDebuffIndex = board.debuffs.findIndex(d => d.x === nextHead.x && d.y === nextHead.y);
        if (eatenDebuffIndex !== -1) {
            ateDebuff = true; board.debuffs.splice(eatenDebuffIndex, 1); board.score -= 5;
            let segmentsToRemove = DEBUFF_SHRINK_AMOUNT;
            while (segmentsToRemove > 0 && board.snake.length > MIN_SNAKE_LENGTH) {
                board.snake.pop(); segmentsToRemove--; shrinkAmountApplied++;
            }
        }
        board.snake.unshift(nextHead);
        if (!ateFood && shrinkAmountApplied === 0 && board.snake.length > MIN_SNAKE_LENGTH) {
            board.snake.pop();
        }
    });

    const p1Lost = boards[1].isGameOver;
    const p2Lost = boards[2].isGameOver;
    let winnerId = null;

    if (p1Lost && p2Lost) winnerId = 0;
    else if (p1Lost) winnerId = 2;
    else if (p2Lost) winnerId = 1;

    const currentBoardsWithNames = getBoardsWithPlayerNames(); // Get boards with current names

    if (winnerId !== null) {
        clearAllIntervalsAndRequests();
        console.log(`Game Over! Winner: ${winnerId === 0 ? "Draw" : (currentBoardsWithNames[winnerId]?.playerName || `Player ${winnerId}`)}`);

        if (playerSockets[1] && players[playerSockets[1]] && boards[1]) {
            savePlayerScore(players[playerSockets[1]].name, boards[1].score);
        }
        if (playerSockets[2] && players[playerSockets[2]] && boards[2]) {
            savePlayerScore(players[playerSockets[2]].name, boards[2].score);
        }

        io.emit('gameOver', { winnerId: winnerId, reason: 'collision' });
        io.emit('gameState', currentBoardsWithNames);
    } else {
        io.emit('gameState', currentBoardsWithNames);
    }
}

// --- Server Start ---
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    resetBoardStatesOnly();
    console.log("Server ready. Initial board states created.");
});