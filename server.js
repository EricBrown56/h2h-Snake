// server.js

require('dotenv').config();

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');
const { start } = require('repl');
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

// --- AI Player Configuration ---
const AI_PLAYER_NAME = "AI Snake";
// AI_JOIN_TIMEOUT is removed

// --- Game State Variables ---
let players = {}; // { socketId: { playerId, name, color, socketId, isAi (optional) } }
let boards = { 1: null, 2: null };
let playerSockets = { 1: null, 2: null }; // Map playerId to socketId

let gameInterval = null;
let countdownInterval = null;
let currentCountdown = COUNTDOWN_SECONDS;
let gameActuallyRunning = false;
let restartRequests = new Set();
// aiJoinTimer is removed

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
    const player1Info = playerSockets[1] ? players[playerSockets[1]] : null;
    const player2Info = playerSockets[2] ? players[playerSockets[2]] : null;

    // Player 1
    if (boards[1]) {
        currentBoards[1] = {
            ...boards[1],
            playerName: player1Info ? player1Info.name : (boards[1].playerName || 'Player 1'),
            isAi: player1Info ? !!player1Info.isAi : false
        };
    } else {
        currentBoards[1] = createNewBoardState(1, 'Player 1');
        currentBoards[1].isAi = false; // Explicitly set for new board state
    }

    // Player 2
    if (boards[2]) {
        currentBoards[2] = {
            ...boards[2],
            playerName: player2Info ? player2Info.name : (boards[2].playerName || 'Player 2'),
            isAi: player2Info ? !!player2Info.isAi : false
        };
    } else {
        currentBoards[2] = createNewBoardState(2, 'Player 2');
        currentBoards[2].isAi = false; // Explicitly set for new board state
    }
    
    // If a board slot is not actively filled by a connected player, mark as game over for client rendering
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




// --- Main Server Initialization Function ---
let filterInstance;

async function setupAsyncDependencies() { // Renamed for clarity
    try {
        // 1. Connect to MongoDB
        await mongoose.connect(MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });
        console.log('Successfully connected to MongoDB!');

        // 2. Initialize Profanity Filter
        const badWordsModule = await import('bad-words');
        const FilterClass = badWordsModule.default;
        filterInstance = new FilterClass(); // Assign to the global-in-module variable
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
                    // Notify existing opponent about the new player
                    io.to(playerSockets[opponentId]).emit('opponentNameUpdate', {
                        playerId: assignedPlayerId,
                        name: playerName,
                        isAi: false // New joiner is human
                    });
                    // Notify new player about the existing opponent
                    const opponentInfo = players[playerSockets[opponentId]];
                    socket.emit('opponentNameUpdate', { 
                        playerId: opponentId,
                        name: opponentInfo.name,
                        isAi: !!opponentInfo.isAi // Send isAi status of the existing opponent
                    });
                }

                // Logic for 'joinGame' is now for two human players
                if (playerSockets[1] && playerSockets[2]) {
                    console.log("Both human players are now in. Initiating game sequence.");
                    initiateGameStartSequence();
                } else if (assignedPlayerId === 1) { // Player 1 joined, waiting for Player 2
                    console.log(`Player ${playerName} (P1) is waiting for a human opponent.`);
                    socket.emit('waiting');
                    io.emit('gameState', getBoardsWithPlayerNames());
                } else { // Player 2 joined, P1 should already be there
                    // This case is covered by the `playerSockets[1] && playerSockets[2]` check above
                    // If P1 is not there, assignedPlayerId would have been 1.
                    // So this 'else' implies P2 joined and P1 exists.
                    // The initiateGameStartSequence will be called.
                }
            });

            socket.on('requestAiGame', (data) => {
                console.log(`Socket ${socket.id} requested AI game with name: ${data ? data.name : 'undefined'}`);
                if (!data || typeof data.name !== 'string') {
                    socket.emit('nameRejected', { message: 'Invalid request data.' }); return;
                }
                const playerName = data.name.trim();
                const playerNameLower = playerName.toLowerCase();

                // Name Validation (same as joinGame)
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
                if (activePlayerNames.has(playerNameLower)) {
                    socket.emit('nameRejected', { message: `Name "${playerName}" is currently in use. Please choose another.` });
                    return;
                }

                // Check if slots are available
                if (playerSockets[1] || playerSockets[2]) {
                    // Check if P1 slot is taken by this same user (e.g. a quick re-request)
                    if (playerSockets[1] === socket.id && players[socket.id] && players[socket.id].name === playerName) {
                        // If AI is already P2, maybe just resend init or ignore
                        if (playerSockets[2] === 'ai_socket_id') {
                             console.warn(`Player ${playerName} (${socket.id}) requested AI game again, already set up.`);
                             socket.emit('init', { yourPlayerId: 1, gridSize: GRID_SIZE, cellSize: 20, yourName: playerName });
                             io.to(socket.id).emit('opponentNameUpdate', { playerId: 2, name: AI_PLAYER_NAME, isAi: true });
                             // Do not start sequence again if game might be running
                             if (!gameActuallyRunning && !countdownInterval) {
                                 initiateGameStartSequence();
                             }
                             return;
                        }
                    }
                    // If P1 or P2 slots are taken by anyone else (human or AI)
                    console.warn(`AI game request rejected: Player 1 slot taken by ${playerSockets[1]}, Player 2 slot by ${playerSockets[2]}`);
                    socket.emit('gameFull', { message: 'Cannot start AI game, server busy or slots taken.' });
                    return;
                }

                // Setup Player 1 (Human)
                playerSockets[1] = socket.id;
                players[socket.id] = {
                    playerId: 1,
                    color: 'green',
                    name: playerName,
                    socketId: socket.id,
                    isAi: false
                };
                activePlayerNames.add(playerNameLower);
                socket.playerName = playerName;
                boards[1] = createNewBoardState(1, playerName);
                boards[1].color = players[socket.id].color;
                console.log(`Player 1 (${playerName}, ${socket.id}) joined for AI game.`);
                socket.emit('init', {
                    yourPlayerId: 1,
                    gridSize: GRID_SIZE,
                    cellSize: 20,
                    yourName: playerName
                });

                // Create AI Player for Player 2 slot
                createAiPlayer(); // This will set up P2 as AI

                // Start the game
                if (playerSockets[1] && playerSockets[2] === 'ai_socket_id') {
                    console.log("Player 1 and AI ready. Initiating game sequence for AI game.");
                    initiateGameStartSequence();
                } else {
                    // This should not happen if logic is correct
                    console.error("Error setting up AI game: AI player not created correctly.");
                    // Cleanup P1 if AI setup failed
                    activePlayerNames.delete(playerNameLower);
                    delete players[socket.id];
                    playerSockets[1] = null;
                    boards[1] = null;
                    socket.emit('nameRejected', { message: 'Server error creating AI game.' }); // Or a generic error
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
                if (opponentSocketId && opponentSocketId !== 'ai_socket_id') { // Don't emit to AI
                    io.to(opponentSocketId).emit('opponentRequestedRestart');
                }

                // Check if both *currently connected* players have requested
                let p1Requested = playerSockets[1] ? restartRequests.has(1) : false;
                // If P2 is AI, AI "agrees" immediately if P1 requests
                let p2Requested = playerSockets[2] ? (playerSockets[2] === 'ai_socket_id' ? p1Requested : restartRequests.has(2)) : false;


                if (playerSockets[1] && playerSockets[2] && p1Requested && p2Requested) {
                    console.log("Both players (or Player 1 and AI) agreed to restart. Starting new game sequence.");
                    io.emit('allPlayersReadyForRestart'); // Notify clients
                    restartRequests.clear();
                    initiateGameStartSequence(); // This will use existing player names, including AI if present
                } else if (playerSockets[1] && playerSockets[2] === 'ai_socket_id' && p1Requested) {
                    // Special case: P1 requests, P2 is AI. AI auto-agrees.
                    console.log("Player 1 requested restart, AI opponent auto-agrees. Starting new game sequence.");
                    io.emit('allPlayersReadyForRestart');
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
                    if(boards[playerId]) boards[playerId].isGameOver = true;
                    delete players[socket.id];
                    restartRequests.delete(playerId);

                    // Clear AI join timer if Player 1 disconnects -- REMOVED as aiJoinTimer is removed
                    // if (playerId === 1 && aiJoinTimer) {
                    //     clearTimeout(aiJoinTimer);
                    //     aiJoinTimer = null;
                    //     console.log("Player 1 disconnected, AI join timer cancelled.");
                    // }

                    const opponentId = playerId === 1 ? 2 : 1;
                    const opponentSocketId = playerSockets[opponentId];

                    if (gameActuallyRunning || countdownInterval) {
                        clearAllIntervalsAndRequests();
                        if (opponentSocketId) { // If opponent exists (human or AI)
                            if (opponentSocketId === 'ai_socket_id') { // Disconnected player's opponent was AI
                                console.log("Human player disconnected, AI opponent is being removed.");
                                // Reset AI player state fully
                                playerSockets[2] = null;
                                delete players['ai_socket_id'];
                                activePlayerNames.delete(AI_PLAYER_NAME.toLowerCase());
                                boards[2] = createNewBoardState(2, 'Player 2'); // Reset board slot
                                // No specific "gameOver" here as the game ends and AI is removed.
                                // The remaining human player (if any, though P1 left here) would go to waiting.
                                // If P1 disconnects and P2 is AI, game effectively ends.
                                resetBoardStatesOnly(); // Full reset as game with AI cannot continue
                            } else if (players[opponentSocketId]) { // Opponent is human
                                if (boards[opponentId]) boards[opponentId].isGameOver = false;
                                if (boards[playerId]) savePlayerScore(name, boards[playerId].score);
                                if (boards[opponentId] && players[opponentSocketId]) savePlayerScore(players[opponentSocketId].name, boards[opponentId].score);
                                io.emit('gameOver', { winnerId: opponentId, reason: 'opponentLeft' });
                                io.to(opponentSocketId).emit('waiting');
                            }
                        } else { // No opponent or opponent also left (or was AI and now removed)
                            resetBoardStatesOnly();
                        }
                    } else if (opponentSocketId) { // Not in active game, but opponent exists
                        if (opponentSocketId === 'ai_socket_id') {
                            // P1 disconnected while waiting for P2, and AI timer was running or AI created.
                            // AI needs to be cleaned up.
                            console.log("Player 1 disconnected while AI was pending/active (not in game). Cleaning up AI.");
                            playerSockets[2] = null;
                            delete players['ai_socket_id'];
                            activePlayerNames.delete(AI_PLAYER_NAME.toLowerCase());
                            boards[2] = createNewBoardState(2, 'Player 2');
                        } else if (players[opponentSocketId]) { // Human opponent
                            io.to(opponentSocketId).emit('opponentNameUpdate', { playerId, name: `Player ${playerId}` });
                            io.to(opponentSocketId).emit('waiting');
                        }
                        if (boards[playerId]) boards[playerId] = createNewBoardState(playerId, `Player ${playerId}`);
                    } else { // No game, no opponent
                        resetBoardStatesOnly();
                    }
                    io.emit('gameState', getBoardsWithPlayerNames());
                }
            });
        });

        

    } catch (err) {
        console.error("Failed to setup async dependencies (MongoDB or Filter):", err);
        process.exit(1); // Exit if critical dependencies fail
    }
}

function initializeSocketIoHandlers() {
    io.on('connection', (socket) => {
        console.log('User connected:', socket.id, "- Awaiting 'joinGame' with name.");
        // Socket handlers are now initialized in setupAsyncDependencies
        socket.on('joinGame', (data) => {
            if (!filterInstance) {
                console.error("Attempted to join game but profanity filter is not yet initialized.");
                socket.emit('nameRejected', { message: 'Server is initializing. Please try again.' });
                return;
            }
    });
})};

async function startServer() {
    await setupAsyncDependencies(); // Wait for DB and filter setup
    // Now that async dependencies are ready, set up Socket.IO handlers
    initializeSocketIoHandlers();

    // Setup Express routes and static files AFTER app is defined
    app.use(express.static(path.join(__dirname, 'public')));
    app.use(express.json());

    app.get('/api/leaderboard', async (req, res) => {
        try {
            // Use Mongoose aggregation to get the highest score for each unique playerName
            const topScores = await Score.aggregate([
                { $sort: { score: -1 } },
                {
                    $group: {
                        _id: "$playerName",
                        highestScore: { $first: "$score" },
                        timestamp: { $first: "$timestamp" }
                    }
                },
                { $sort: { highestScore: -1 } },
                { $limit: 10 },
                {
                    $project: {
                        _id: 0,
                        playerName: "$_id",
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
}

server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    resetBoardStatesOnly(); // Initial reset to create default board structures
    console.log("Server ready. Initial board states created.");
});

startServer().catch(err => {
    console.error("Error starting server:", err);
    process.exit(1);
});

    

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
        if(gameActuallyRunning) {
            console.warn("Game tick: Inconsistent state - game set as running but players missing. Stopping.");
            clearAllIntervalsAndRequests();
            if (playerSockets[1] && players[playerSockets[1]]) io.to(playerSockets[1]).emit('waiting');
            const p2Info = players[playerSockets[2]];
            if (p2Info && !p2Info.isAi) {
                 io.to(playerSockets[2]).emit('waiting');
            }
            resetBoardStatesOnly(true);
            io.emit('gameState', getBoardsWithPlayerNames());
        }
        return;
    }

    const player2Object = players[playerSockets[2]];
    if (player2Object?.isAi && boards[2] && !boards[2].isGameOver) {
        const aiMove = getAiNextMove(boards[2], boards[1]);
        if (aiMove) {
            boards[2].direction = aiMove;
            switch (aiMove) {
                case 'up':    boards[2].dx = 0; boards[2].dy = -1; break;
                case 'down':  boards[2].dx = 0; boards[2].dy = 1;  break;
                case 'left':  boards[2].dx = -1; boards[2].dy = 0; break;
                case 'right': boards[2].dx = 1; boards[2].dy = 0;  break;
            }
        }
    }

    let gameShouldEnd = false;
    [1, 2].forEach(playerId => {
        if (!boards[playerId] || boards[playerId].isGameOver) return;
        const board = boards[playerId];
        const currentHead = { ...board.snake[0] };
        const nextHead = { x: currentHead.x + board.dx, y: currentHead.y + board.dy };

        if (nextHead.x < 0 || nextHead.x >= GRID_SIZE || nextHead.y < 0 || nextHead.y >= GRID_SIZE) {
            board.isGameOver = true; gameShouldEnd = true;
            const playerSocketId = playerSockets[playerId];
            const pInfo = players[playerSocketId];
            if (pInfo && !pInfo.isAi) {
                io.to(playerSocketId).emit('gameOver', { winnerId: playerId === 1 ? 2 : 1, reason: 'wallCollision' });
            } else if (pInfo?.isAi) {
                if(playerSockets[1] && players[playerSockets[1]]) {
                    io.to(playerSockets[1]).emit('gameOver', { winnerId: 1, reason: 'opponentWallCollision' });
                }
            }
            return;
        }
        for (let i = 0; i < board.snake.length; i++) {
            if (nextHead.x === board.snake[i].x && nextHead.y === board.snake[i].y) {
                board.isGameOver = true; gameShouldEnd = true;
                const playerSocketId = playerSockets[playerId];
                const pInfo = players[playerSocketId];
                if (pInfo && !pInfo.isAi) {
                    io.to(playerSocketId).emit('gameOver', { winnerId: playerId === 1 ? 2 : 1, reason: 'selfCollision' });
                } else if (pInfo?.isAi) {
                     if(playerSockets[1] && players[playerSockets[1]]) {
                        io.to(playerSockets[1]).emit('gameOver', { winnerId: 1, reason: 'opponentSelfCollision' });
                    }
                }
                return;
            }
        }

        let ateFood = false;
        let justShrunkByDebuff = false;
        if (nextHead.x === board.food.x && nextHead.y === board.food.y) {
            ateFood = true;
            board.score += 10;
            board.foodEatenCounter++;
            board.food = getRandomPosition([...board.snake, board.food, ...(board.debuffs || []), ...(board.powerups || [])]);
            const playerSocketId = playerSockets[playerId];
            const pInfo = players[playerSocketId];
            if (pInfo && !pInfo.isAi) {
                io.to(playerSocketId).emit('playSound', 'eatFood');
            } else if (pInfo?.isAi) {
                 if(playerSockets[1] && players[playerSockets[1]]) {
                    io.to(playerSockets[1]).emit('playSound', 'eatFood');
                 }
            }
            if (board.foodEatenCounter >= DEBUFF_TRIGGER_COUNT) {
                board.foodEatenCounter = 0;
                const opponentId = playerId === 1 ? 2 : 1;
                const opponentBoard = boards[opponentId];
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
            }
            justShrunkByDebuff = true;
            const playerSocketId = playerSockets[playerId];
            const pInfo = players[playerSocketId];
            if (pInfo && !pInfo.isAi) {
                io.to(playerSocketId).emit('playSound', 'debuff'); // Corrected sound name
            } else if (pInfo?.isAi) {
                if(playerSockets[1] && players[playerSockets[1]]) {
                    io.to(playerSockets[1]).emit('playSound', 'debuff'); // Corrected sound name for P1
                }
            }
        }

        board.snake.unshift(nextHead);
        if (!ateFood && !justShrunkByDebuff) {
            if (board.snake.length > MIN_SNAKE_LENGTH) {
                 board.snake.pop();
            } else if (board.snake.length > 1 && board.score === 0) {
                 board.snake.pop();
            }
        } else if (justShrunkByDebuff && board.snake.length === 0) {
            board.isGameOver = true; gameShouldEnd = true;
        }
        if (board.snake.length === 0) {
            board.isGameOver = true; gameShouldEnd = true;
        }
    });

    const currentBoardsWithNames = getBoardsWithPlayerNames();
    if (gameShouldEnd || (boards[1]?.isGameOver) || (boards[2]?.isGameOver)) {
        clearAllIntervalsAndRequests();
        gameActuallyRunning = false;
        const p1 = boards[1];
        const p2 = boards[2];
        let winnerId = null;
        if (p1?.isGameOver && p2?.isGameOver) winnerId = 0;
        else if (p1?.isGameOver) winnerId = 2;
        else if (p2?.isGameOver) winnerId = 1;
        else { winnerId = 0; }
        console.log(`Game Over! Winner: ${winnerId === 0 ? "Draw" : (currentBoardsWithNames[winnerId]?.playerName || `Player ${winnerId}`)}`);
        if (playerSockets[1] && players[playerSockets[1]] && p1) {
            savePlayerScore(players[playerSockets[1]].name, p1.score);
        }
        const player2InfoObject = players[playerSockets[2]]; // Renamed to avoid conflict
        if (player2InfoObject && !player2InfoObject.isAi && p2) {
            savePlayerScore(player2InfoObject.name, p2.score);
        }
        io.emit('gameOver', { winnerId: winnerId, reason: (p1?.isGameOver && p2?.isGameOver) ? 'draw' : 'collision' });
    }
    io.emit('gameState', currentBoardsWithNames);
}
// --- AI Player Functions ---
function createAiPlayer() {
    if (playerSockets[2]) { // Should not happen if logic is correct
        console.warn("Attempted to create AI player when Player 2 slot is already taken.");
        return;
    }
    console.log("Creating AI Player...");

    playerSockets[2] = 'ai_socket_id'; // Special ID for AI
    players['ai_socket_id'] = {
        playerId: 2,
        color: 'cyan', // AI distinct color
        name: AI_PLAYER_NAME,
        socketId: 'ai_socket_id',
        isAi: true
    };
    activePlayerNames.add(AI_PLAYER_NAME.toLowerCase());

    boards[2] = createNewBoardState(2, AI_PLAYER_NAME);
    boards[2].color = players['ai_socket_id'].color;

    console.log(`AI Player "${AI_PLAYER_NAME}" created for Player 2 slot.`);

    // Notify Player 1 about their new AI opponent (if P1 exists)
    if (playerSockets[1] && players[playerSockets[1]]) {
        io.to(playerSockets[1]).emit('opponentNameUpdate', {
            playerId: 2,
            name: AI_PLAYER_NAME,
            isAi: true // AI player
        });
    }
    // DO NOT call initiateGameStartSequence() here.
    // The calling context (e.g., requestAiGame handler) is responsible for that.
}

function getAiNextMove(aiBoard, opponentBoard) { // opponentBoard is still not used but kept for signature
    if (!aiBoard || !aiBoard.snake || aiBoard.snake.length === 0) {
        return aiBoard.direction || 'right';
    }

    const head = { ...aiBoard.snake[0] };
    const snake = aiBoard.snake;
    const food = aiBoard.food;
    const currentDirection = aiBoard.direction;
    const gridSize = GRID_SIZE;

    const allDirections = [
        { name: 'up', dx: 0, dy: -1 },
        { name: 'down', dx: 0, dy: 1 },
        { name: 'left', dx: -1, dy: 0 },
        { name: 'right', dx: 1, dy: 0 }
    ];

    let level1SafeMoves = [];
    for (const dir of allDirections) {
        if ((currentDirection === 'up' && dir.name === 'down') ||
            (currentDirection === 'down' && dir.name === 'up') ||
            (currentDirection === 'left' && dir.name === 'right') ||
            (currentDirection === 'right' && dir.name === 'left')) {
            continue;
        }
        const nextHead = { x: head.x + dir.dx, y: head.y + dir.dy };
        if (nextHead.x < 0 || nextHead.x >= gridSize || nextHead.y < 0 || nextHead.y >= gridSize) {
            continue;
        }
        let selfCollision = false;
        for (let i = 0; i < snake.length; i++) {
            if (nextHead.x === snake[i].x && nextHead.y === snake[i].y) {
                selfCollision = true;
                break;
            }
        }
        if (selfCollision) {
            continue;
        }
        level1SafeMoves.push(dir);
    }

    if (level1SafeMoves.length === 0) {
        return currentDirection || 'right';
    }

    let level2SafeMoves = [];
    for (const dir of level1SafeMoves) {
        const nextHead = { x: head.x + dir.dx, y: head.y + dir.dy };
        let isWallTrap = false;
        let isSelfTrap = false;

        // Refined Wall Trap Check: considers if food is the target
        if (!(nextHead.x === food.x && nextHead.y === food.y)) {
            const furtherHead = { x: nextHead.x + dir.dx, y: nextHead.y + dir.dy };
            if (furtherHead.x < 0 || furtherHead.x >= gridSize || furtherHead.y < 0 || furtherHead.y >= gridSize) {
                 // If the move 'dir' takes snake to 'nextHead', and then applying 'dir' again from 'nextHead' leads to 'furtherHead' being a wall.
                 isWallTrap = true;
            }
        }

        const snakeAfterMove1 = [{...nextHead}, ...snake.slice(0, snake.length -1)];
        let canMakeSecondMove = false;
        for (const nextDir of allDirections) {
            if ((dir.name === 'up' && nextDir.name === 'down') ||
                (dir.name === 'down' && nextDir.name === 'up') ||
                (dir.name === 'left' && nextDir.name === 'right') ||
                (dir.name === 'right' && nextDir.name === 'left')) {
                continue;
            }
            const headAfterMove2 = { x: nextHead.x + nextDir.dx, y: nextHead.y + nextDir.dy };
            if (headAfterMove2.x < 0 || headAfterMove2.x >= gridSize || headAfterMove2.y < 0 || headAfterMove2.y >= gridSize) {
                continue;
            }
            let selfCollisionMove2 = false;
            for (let i = 0; i < snakeAfterMove1.length; i++) {
                if (headAfterMove2.x === snakeAfterMove1[i].x && headAfterMove2.y === snakeAfterMove1[i].y) {
                    selfCollisionMove2 = true;
                    break;
                }
            }
            if (!selfCollisionMove2) {
                canMakeSecondMove = true;
                break;
            }
        }
        if (!canMakeSecondMove) {
            isSelfTrap = true;
        }

        if (!isWallTrap && !isSelfTrap) {
            level2SafeMoves.push(dir);
        }
    }

    let bestMovesToConsider = [];
    if (level2SafeMoves.length > 0) {
        bestMovesToConsider = level2SafeMoves;
    } else if (level1SafeMoves.length > 0) {
        bestMovesToConsider = level1SafeMoves;
    } else {
        return currentDirection || 'right';
    }

    let finalChoice = null;
    let minDistanceToFood = Infinity;

    for (const dir of bestMovesToConsider) {
        const pHead = { x: head.x + dir.dx, y: head.y + dir.dy };
        const distance = Math.abs(pHead.x - food.x) + Math.abs(pHead.y - food.y);
        if (distance < minDistanceToFood) {
            minDistanceToFood = distance;
            finalChoice = dir.name;
        } else if (distance === minDistanceToFood) {
            if (dir.name === currentDirection) {
                finalChoice = dir.name;
            }
        }
    }

    if (!finalChoice) {
        if (bestMovesToConsider.some(d => d.name === currentDirection)) {
            finalChoice = currentDirection;
        } else {
            finalChoice = bestMovesToConsider[0].name;
        }
    }
    return finalChoice;
}


