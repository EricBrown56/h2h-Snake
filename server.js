// server.js

require('dotenv').config();

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

// ****** NEW: For unique active player name tracking ******
let activePlayerNames = new Set(); // Stores lowercase names of currently connected and playing users

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
    // Using 'unique: true' on playerName would prevent multiple scores for the same player,
    // which is NOT what we want if we are to pick the highest.
    // We will handle "highest score per player" in the API query.
    playerName: { type: String, required: true, trim: true, minlength: 2, maxlength: 15, index: true }, // Index for faster queries
    score: { type: Number, required: true, min: 0 },
    timestamp: { type: Date, default: Date.now }
});
const Score = mongoose.model('Score', scoreSchema);

// --- Utility Functions ---
function createNewBoardState(playerId, playerNameFromArg) {
    const playerName = playerNameFromArg || `Player ${playerId}`;
    const startX = Math.floor(GRID_SIZE / 4) + (playerId === 1 ? 0 : Math.floor(GRID_SIZE / 2.5)); // slightly different start for P2
    const startY = Math.floor(GRID_SIZE / 2);
    const startColor = playerId === 1 ? 'green' : 'blue';
    const initialSnake = [{ x: startX, y: startY }, { x: startX - 1, y: startY }];
    return {
        playerId: playerId,
        snake: initialSnake,
        direction: 'right',
        dx: 1, // Initial dx
        dy: 0,  // Initial dy
        color: startColor,
        score: 0,
        food: getRandomPosition(initialSnake),
        debuffs: [],
        powerups: [],
        foodEatenCounter: 0,
        isGameOver: false,
        playerName: playerName
    };
}

function resetBoardStatesOnly(keepNames = false) { // Added keepNames parameter
    console.log("Resetting game board states.");
    const p1Name = (keepNames && playerSockets[1] && players[playerSockets[1]]) ? players[playerSockets[1]].name : `Player 1`;
    const p2Name = (keepNames && playerSockets[2] && players[playerSockets[2]]) ? players[playerSockets[2]].name : `Player 2`;

    boards[1] = createNewBoardState(1, p1Name);
    boards[2] = createNewBoardState(2, p2Name);
    gameActuallyRunning = false;

    if (playerSockets[1] && players[playerSockets[1]]) {
        boards[1].color = players[playerSockets[1]].color;
    }
    if (playerSockets[2] && players[playerSockets[2]]) {
        boards[2].color = players[playerSockets[2]].color;
    }
    // No need to generate food here, createNewBoardState does it.
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
        const currentExcludes = Array.isArray(exclude) ? exclude : []; // Ensure exclude is an array
        occupied = currentExcludes.some(item => item && item.x === position.x && item.y === position.y);
        attempts++;
    }
    if (occupied && attempts >= maxAttempts) console.warn("Could not find an empty spot for item after max attempts!");
    return position || { x: 0, y: 0 };
}

function getBoardsWithPlayerNames() {
    const currentBoards = {};
    // Ensure boards are fully populated even if a player slot is empty for client rendering
    currentBoards[1] = boards[1] ? { ...boards[1], playerName: (playerSockets[1] && players[playerSockets[1]]) ? players[playerSockets[1]].name : (boards[1].playerName || 'Player 1') } : createNewBoardState(1, 'Player 1');
    currentBoards[2] = boards[2] ? { ...boards[2], playerName: (playerSockets[2] && players[playerSockets[2]]) ? players[playerSockets[2]].name : (boards[2].playerName || 'Player 2') } : createNewBoardState(2, 'Player 2');
    
    // If a board was null (player not connected), ensure its isGameOver is true for client
    if (!playerSockets[1] && currentBoards[1]) currentBoards[1].isGameOver = true;
    if (!playerSockets[2] && currentBoards[2]) currentBoards[2].isGameOver = true;

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
    restartRequests.clear(); // Also clear restart requests here

    // Reset board states ensuring names from active players are used
    resetBoardStatesOnly(true);

    io.emit('gameState', getBoardsWithPlayerNames()); // Send initial clean boards

    currentCountdown = COUNTDOWN_SECONDS;
    io.emit('countdownUpdate', currentCountdown);
    countdownInterval = setInterval(() => {
        currentCountdown--;
        if (currentCountdown > 0) {
            io.emit('countdownUpdate', currentCountdown);
        } else if (currentCountdown === 0) {
            io.emit('countdownUpdate', 'GO!');
        } else { // currentCountdown < 0
            clearInterval(countdownInterval);
            countdownInterval = null;
            io.emit('countdownUpdate', null); // Clear countdown display on client
            console.log("Countdown finished. Starting game loop.");
            startGameLoop();
        }
    }, 1000);
}

function startGameLoop() {
    if (gameInterval) return; // Prevent multiple intervals
    if (!playerSockets[1] || !players[playerSockets[1]] || !playerSockets[2] || !players[playerSockets[2]]) {
        console.error("Attempted to start game loop without two valid players. Aborting.");
        return;
    }
    gameActuallyRunning = true;
    console.log("Starting game loop (snakes moving)...");
    // Ensure boards are fresh if coming from restart
    if (!boards[1] || boards[1].isGameOver || !boards[2] || boards[2].isGameOver) {
        resetBoardStatesOnly(true);
        io.emit('gameState', getBoardsWithPlayerNames());
    }
    gameInterval = setInterval(updateGameTick, TICK_RATE);
}

// --- Express Setup ---
app.use(express.static(path.join(__dirname, 'public'))); // Ensure this path is correct
app.use(express.json());

// --- API Endpoints ---
app.get('/api/leaderboard', async (req, res) => {
    try {
        // Use Mongoose aggregation to get the highest score for each unique playerName
        const topScores = await Score.aggregate([
            { $sort: { score: -1 } }, // Sort by score first to ensure $first picks the highest
            {
                $group: {
                    _id: "$playerName", // Group by playerName
                    highestScore: { $first: "$score" }, // Get the first score (which is the highest due to sort)
                    timestamp: { $first: "$timestamp" } // Get timestamp of that highest score
                }
            },
            { $sort: { highestScore: -1 } }, // Sort the groups by highestScore
            { $limit: 10 }, // Limit to top 10 unique players
            {
                $project: { // Reshape the output
                    _id: 0, // Exclude the default _id from group stage
                    playerName: "$_id", // Rename _id to playerName
                    score: "$highestScore",
                    timestamp: "$timestamp"
                }
            }
        ]);
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

        io.on('connection', (socket) => {
            console.log('User connected:', socket.id, "- Awaiting 'joinGame' with name.");

            socket.on('joinGame', (data) => {
                if (players[socket.id]) { // Player is already in 'players' object
                    console.log(`Socket ${socket.id} (${players[socket.id].name}) tried to join again. Resyncing.`);
                    socket.emit('init', { // Resend init data
                        yourPlayerId: players[socket.id].playerId,
                        gridSize: GRID_SIZE,
                        cellSize: 20, // Assuming cellSize is fixed or send from config
                        yourName: players[socket.id].name
                    });
                    io.emit('gameState', getBoardsWithPlayerNames()); // Send current game state
                    // If game is over, resend gameOver event
                    if((boards[1] && boards[1].isGameOver) || (boards[2] && boards[2].isGameOver)) {
                        const winnerId = (boards[1] && boards[1].isGameOver) ? ( (boards[2] && boards[2].isGameOver) ? 0 : 2) : 1;
                        socket.emit('gameOver', { winnerId, reason: 'rejoinToGameOver' });
                    }
                    return;
                }

                if (!data || typeof data.name !== 'string') {
                    socket.emit('nameRejected', { message: 'Invalid join request data.' }); return;
                }
                const playerName = data.name.trim();
                const playerNameLower = playerName.toLowerCase();

                if (!playerName || playerName.length < 2 || playerName.length > 15) {
                    socket.emit('nameRejected', { message: 'Name must be 2-15 characters.' }); return;
                }
                if (!/^[a-zA-Z0-9_-\s]+$/.test(playerName)) {
                    socket.emit('nameRejected', { message: 'Name contains invalid characters.' }); return;
                }
                try {
                    if (filterInstance.isProfane(playerName)) {
                        socket.emit('nameRejected', { message: 'Name contains inappropriate language.' }); return;
                    }
                } catch (e) {
                    socket.emit('nameRejected', { message: 'Error validating name. Try another.' }); return;
                }

                // ****** UNIQUE ACTIVE NAME CHECK ******
                if (activePlayerNames.has(playerNameLower)) {
                    socket.emit('nameRejected', { message: `Name "${playerName}" is currently in use. Please choose another.` });
                    return;
                }

                let assignedPlayerId = null;
                if (!playerSockets[1]) assignedPlayerId = 1;
                else if (!playerSockets[2]) assignedPlayerId = 2;
                else {
                    socket.emit('gameFull', { message: 'Sorry, the game is currently full.' }); return;
                }

                playerSockets[assignedPlayerId] = socket.id;
                players[socket.id] = {
                    playerId: assignedPlayerId,
                    color: assignedPlayerId === 1 ? 'green' : 'blue', // Default, can be customized
                    name: playerName,
                    socketId: socket.id
                };
                activePlayerNames.add(playerNameLower); // Add to active names
                socket.playerName = playerName; // Store on socket for easy access on disconnect

                // Initialize or update board for this player
                boards[assignedPlayerId] = createNewBoardState(assignedPlayerId, playerName);
                boards[assignedPlayerId].color = players[socket.id].color; // Ensure color matches

                console.log(`Player ${assignedPlayerId} (${playerName}, ${socket.id}) joined.`);
                socket.emit('init', {
                    yourPlayerId: assignedPlayerId,
                    gridSize: GRID_SIZE,
                    cellSize: 20, // Example
                    yourName: playerName
                });

                const opponentId = assignedPlayerId === 1 ? 2 : 1;
                if (playerSockets[opponentId] && players[playerSockets[opponentId]]) {
                    io.to(playerSockets[opponentId]).emit('opponentNameUpdate', {
                        playerId: assignedPlayerId,
                        name: playerName
                    });
                    socket.emit('opponentNameUpdate', { // Send opponent's name to the new joiner
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
                    io.emit('gameState', getBoardsWithPlayerNames()); // Send current state even if waiting
                }
            });

            socket.on('directionChange', (newDirection) => {
                if (!gameActuallyRunning) return;
                const playerInfo = players[socket.id];
                if (!playerInfo || !boards[playerInfo.playerId] || boards[playerInfo.playerId].isGameOver) return;

                const board = boards[playerInfo.playerId];
                const currentDirString = board.direction;

                if (
                    (newDirection === 'up'    && currentDirString !== 'down') ||
                    (newDirection === 'down'  && currentDirString !== 'up')   ||
                    (newDirection === 'left'  && currentDirString !== 'right')||
                    (newDirection === 'right' && currentDirString !== 'left') ||
                    !currentDirString // Allow initial direction set
                ) {
                    board.direction = newDirection;
                    switch (newDirection) {
                        case 'up':    board.dx = 0; board.dy = -1; break;
                        case 'down':  board.dx = 0; board.dy = 1;  break;
                        case 'left':  board.dx = -1; board.dy = 0; break;
                        case 'right': board.dx = 1; board.dy = 0;  break;
                    }
                }
            });

            socket.on('requestRestart', () => {
                if (!players[socket.id] || (!boards[1]?.isGameOver && !boards[2]?.isGameOver)) {
                    // Only allow restart if game is over for at least one player, or player is valid
                    return;
                }
                const playerInfo = players[socket.id];
                console.log(`Player ${playerInfo.name} (Socket: ${socket.id}) requested restart.`);
                restartRequests.add(playerInfo.playerId); // Store by playerId for consistency

                socket.emit('restartRequestedByYou');

                const opponentId = playerInfo.playerId === 1 ? 2 : 1;
                const opponentSocketId = playerSockets[opponentId];
                if (opponentSocketId) {
                    io.to(opponentSocketId).emit('opponentRequestedRestart');
                }

                // Check if both *currently connected* players have requested
                let p1Requested = playerSockets[1] ? restartRequests.has(1) : false;
                let p2Requested = playerSockets[2] ? restartRequests.has(2) : false;

                if (playerSockets[1] && playerSockets[2] && p1Requested && p2Requested) {
                    console.log("Both connected players agreed to restart. Starting new game sequence.");
                    io.emit('allPlayersReadyForRestart'); // Notify clients
                    restartRequests.clear();
                    initiateGameStartSequence();
                }
            });

            socket.on('disconnect', () => {
                console.log('User disconnected:', socket.id);
                const disconnectedPlayerInfo = players[socket.id];
                
                if (disconnectedPlayerInfo) {
                    const { playerId, name } = disconnectedPlayerInfo;
                    const nameLower = name.toLowerCase();
                    activePlayerNames.delete(nameLower); // Remove from active names
                    console.log(`Player ${name} (ID: ${playerId}) disconnected. Active names: ${[...activePlayerNames].join(', ')}`);

                    playerSockets[playerId] = null;
                    if(boards[playerId]) boards[playerId].isGameOver = true; // Mark their board as over
                    delete players[socket.id];
                    restartRequests.delete(playerId); // Remove their restart request if any

                    const opponentId = playerId === 1 ? 2 : 1;
                    const opponentSocketId = playerSockets[opponentId];

                    if (gameActuallyRunning || countdownInterval) { // If game or countdown was active
                        clearAllIntervalsAndRequests();
                        if (opponentSocketId && players[opponentSocketId]) { // If opponent is still there
                            if (boards[opponentId]) boards[opponentId].isGameOver = false; // Winner is not game over
                             // Save scores before emitting gameOver to ensure they reflect the game state
                            if (boards[playerId]) savePlayerScore(name, boards[playerId].score);
                            if (boards[opponentId] && players[opponentSocketId]) savePlayerScore(players[opponentSocketId].name, boards[opponentId].score);

                            io.emit('gameOver', { winnerId: opponentId, reason: 'opponentLeft' });
                            io.to(opponentSocketId).emit('waiting'); // Opponent waits for new player
                        } else { // No opponent or opponent also left
                            resetBoardStatesOnly(); // Full reset
                        }
                    } else if (opponentSocketId && players[opponentSocketId]) { // Not in active game, but opponent exists
                        io.to(opponentSocketId).emit('opponentNameUpdate', { playerId, name: `Player ${playerId}` }); // Clear name on opponent's side
                        io.to(opponentSocketId).emit('waiting');
                        if (boards[playerId]) boards[playerId] = createNewBoardState(playerId, `Player ${playerId}`); // Reset board slot
                    } else { // No game, no opponent
                        resetBoardStatesOnly();
                    }
                    io.emit('gameState', getBoardsWithPlayerNames()); // Update everyone
                }
            });
        });

        server.listen(PORT, () => {
            console.log(`Server listening on port ${PORT}`);
            resetBoardStatesOnly(); // Initial reset to create default board structures
            console.log("Server ready. Initial board states created.");
        });

    } catch (err) {
        console.error("Failed to initialize server or load profanity filter:", err);
        process.exit(1);
    }
}

async function savePlayerScore(playerName, score) {
    if (!playerName || typeof score !== 'number' || score < 0) {
        console.warn(`Not saving score for ${playerName} with score ${score} (invalid name/score).`);
        return;
    }
    // No need to check for highest score here; the API query handles that.
    // We save all game scores, which could be useful for other stats later.
    try {
        const newScoreEntry = new Score({ playerName, score });
        await newScoreEntry.save();
        console.log(`Score saved for ${playerName}: ${score}`);
    } catch (error) {
        console.error(`Error saving score for ${playerName}:`, error.message);
    }
}

function updateGameTick() {
    if (!gameActuallyRunning || !playerSockets[1] || !players[playerSockets[1]] || !playerSockets[2] || !players[playerSockets[2]]) {
        // This condition should ideally be caught before updateGameTick is even called by startGameLoop
        if(gameActuallyRunning) { // If it somehow gets here while gameActuallyRunning is true
            console.warn("Game tick: Inconsistent state - game set as running but players missing. Stopping.");
            clearAllIntervalsAndRequests();
            if (playerSockets[1] && players[playerSockets[1]]) io.to(playerSockets[1]).emit('waiting');
            if (playerSockets[2] && players[playerSockets[2]]) io.to(playerSockets[2]).emit('waiting');
            resetBoardStatesOnly(true); // Keep names if players are still partially there
            io.emit('gameState', getBoardsWithPlayerNames());
        }
        return;
    }

    let gameShouldEnd = false;

    [1, 2].forEach(playerId => {
        if (!boards[playerId] || boards[playerId].isGameOver) return;

        const board = boards[playerId];
        const currentHead = { ...board.snake[0] }; // Get current head
        const nextHead = { x: currentHead.x + board.dx, y: currentHead.y + board.dy }; // Calculate next based on dx/dy

        // Wall collision
        if (nextHead.x < 0 || nextHead.x >= GRID_SIZE || nextHead.y < 0 || nextHead.y >= GRID_SIZE) {
            board.isGameOver = true; gameShouldEnd = true; return;
        }
        // Self collision
        for (let i = 0; i < board.snake.length; i++) { // Check against all segments including new potential head if it overlaps
            if (nextHead.x === board.snake[i].x && nextHead.y === board.snake[i].y) {
                board.isGameOver = true; gameShouldEnd = true; return;
            }
        }
        if (board.isGameOver) return;


        let ateFood = false;
        let justShrunkByDebuff = false;

        if (nextHead.x === board.food.x && nextHead.y === board.food.y) {
            ateFood = true;
            board.score += 10;
            board.foodEatenCounter++;
            board.food = getRandomPosition([...board.snake, board.food, ...(board.debuffs || []), ...(board.powerups || [])]);

            if (board.foodEatenCounter >= DEBUFF_TRIGGER_COUNT) {
                board.foodEatenCounter = 0;
                const opponentId = playerId === 1 ? 2 : 1;
                const opponentBoard = boards[opponentId];
                if (opponentBoard && !opponentBoard.isGameOver) { // Check if opponentBoard exists
                    opponentBoard.debuffs.push(getRandomPosition([...opponentBoard.snake, opponentBoard.food, ...(opponentBoard.debuffs || []), ...(opponentBoard.powerups || [])]));
                }
            }
        }

        const eatenDebuffIndex = board.debuffs.findIndex(d => d.x === nextHead.x && d.y === nextHead.y);
        if (eatenDebuffIndex !== -1) {
            board.debuffs.splice(eatenDebuffIndex, 1);
            board.score = Math.max(0, board.score - 5); // Ensure score doesn't go negative
            let segmentsToRemove = DEBUFF_SHRINK_AMOUNT;
            while (segmentsToRemove > 0 && board.snake.length > MIN_SNAKE_LENGTH) {
                board.snake.pop();
                segmentsToRemove--;
            }
            justShrunkByDebuff = true;
        }

        board.snake.unshift(nextHead); // Add new head
        if (!ateFood && !justShrunkByDebuff) {
            if (board.snake.length > MIN_SNAKE_LENGTH) { // Only pop if longer than min length
                 board.snake.pop();
            } else if (board.snake.length > 1 && board.score === 0) { // Special case for initial length of 2 and no score
                 board.snake.pop();
            }
        } else if (!ateFood && justShrunkByDebuff && board.snake.length === 0) {
            // If shrunk to nothing, game over for this player
            board.isGameOver = true; gameShouldEnd = true;
        }


         // Check if snake shrunk to zero length (game over)
        if (board.snake.length === 0) {
            board.isGameOver = true;
            gameShouldEnd = true;
        }

    }); // End of forEach player loop

    const currentBoardsWithNames = getBoardsWithPlayerNames(); // Get names once

    if (gameShouldEnd || (boards[1] && boards[1].isGameOver) || (boards[2] && boards[2].isGameOver)) {
        clearAllIntervalsAndRequests(); // Stop game loop, countdowns
        gameActuallyRunning = false;

        const p1 = boards[1];
        const p2 = boards[2];
        let winnerId = null;

        if (p1 && p1.isGameOver && p2 && p2.isGameOver) winnerId = 0; // Draw
        else if (p1 && p1.isGameOver) winnerId = 2; // P2 wins
        else if (p2 && p2.isGameOver) winnerId = 1; // P1 wins
        else {
             // This case should not be reached if gameShouldEnd is true due to one player losing
             console.error("updateGameTick: gameShouldEnd true, but no loser identified clearly.");
             winnerId = 0; // Default to draw if logic error
        }

        console.log(`Game Over! Winner: ${winnerId === 0 ? "Draw" : (currentBoardsWithNames[winnerId]?.playerName || `Player ${winnerId}`)}`);

        if (playerSockets[1] && players[playerSockets[1]] && p1) {
            savePlayerScore(players[playerSockets[1]].name, p1.score);
        }
        if (playerSockets[2] && players[playerSockets[2]] && p2) {
            savePlayerScore(players[playerSockets[2]].name, p2.score);
        }

        io.emit('gameOver', { winnerId: winnerId, reason: 'collision' });
    }
    // Always emit game state, whether game ended or continues
    io.emit('gameState', currentBoardsWithNames);
}

initializeServer().catch(err => {
    console.error("Unhandled error during server startup:", err);
    process.exit(1);
});