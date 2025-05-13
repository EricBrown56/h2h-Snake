const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

// --- Game Constants ---
const GRID_SIZE = 20;
const TICK_RATE = 150;
const MIN_SNAKE_LENGTH = 2;
const DEBUFF_TRIGGER_COUNT = 3;
const DEBUFF_SHRINK_AMOUNT = 2;
const COUNTDOWN_SECONDS = 3;

// --- Game State Variables ---
let players = {}; // { socketId: { playerId: 1 or 2, color: 'green' } }
let boards = { 1: null, 2: null };
let playerSockets = { 1: null, 2: null }; // Map playerId to socketId

let gameInterval = null;         // For the main snake movement game loop
let countdownInterval = null;    // For the 3,2,1 countdown
let currentCountdown = COUNTDOWN_SECONDS;
let gameActuallyRunning = false; // True when snakes can actually move (after countdown)
let restartRequests = new Set(); // Stores socket.ids of players wanting to restart

// --- Utility Functions ---

function createNewBoardState(playerId) {
    const startX = Math.floor(GRID_SIZE / 4);
    const startY = Math.floor(GRID_SIZE / 2);
    const startColor = playerId === 1 ? 'green' : 'blue'; // Use consistent colors
    const initialSnake = [{ x: startX, y: startY }, { x: startX - 1, y: startY }];
    return {
        playerId: playerId,
        snake: initialSnake,
        direction: 'RIGHT',
        color: startColor, // Assign color here
        score: 0,
        food: getRandomPosition(initialSnake),
        debuffs: [],
        powerups: [],
        foodEatenCounter: 0,
        isGameOver: false
    };
}

function resetBoardStatesOnly() {
    console.log("Resetting game board states.");
    boards[1] = createNewBoardState(1);
    boards[2] = createNewBoardState(2);
    gameActuallyRunning = false;

    // Sync colors if players are already assigned
    if (playerSockets[1] && players[playerSockets[1]]) {
         boards[1].color = players[playerSockets[1]].color;
    }
    if (playerSockets[2] && players[playerSockets[2]]) {
         boards[2].color = players[playerSockets[2]].color;
    }
    boards[1].food = getRandomPosition(boards[1].snake); // Ensure food is placed correctly
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
    return position || { x: 0, y: 0 }; // Fallback
}

// --- Game Start Sequence ---
function initiateGameStartSequence() {
    if (!playerSockets[1] || !playerSockets[2]) {
        console.log("Cannot start game sequence, not enough players.");
        return;
    }
    if (gameInterval || countdownInterval) { // Prevent multiple sequences
        console.log("Game sequence or game already in progress.");
        return;
    }

    console.log("Initiating game start sequence...");
    clearAllIntervalsAndRequests(); // Ensure clean state
    resetBoardStatesOnly();         // Prepare fresh boards
    io.emit('gameState', boards);   // Send the reset board state first

    currentCountdown = COUNTDOWN_SECONDS;
    io.emit('countdownUpdate', currentCountdown);

    countdownInterval = setInterval(() => {
        currentCountdown--;
        if (currentCountdown > 0) {
            io.emit('countdownUpdate', currentCountdown);
        } else if (currentCountdown === 0) {
            io.emit('countdownUpdate', 'GO!');
        } else { // currentCountdown < 0 (after GO!)
            clearInterval(countdownInterval);
            countdownInterval = null;
            io.emit('countdownUpdate', null); // Clear countdown display on client
            console.log("Countdown finished. Starting game loop.");
            startGameLoop();
        }
    }, 1000);
}

function startGameLoop() {
    if (gameInterval) return; // Already running
    gameActuallyRunning = true; // Snakes can move now
    console.log("Starting game loop (snakes moving)...");
    gameInterval = setInterval(updateGameTick, TICK_RATE);
}

// --- Express Setup ---
app.use(express.static(path.join(__dirname, 'public')));

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
    players[socket.id] = { playerId: assignedPlayerId, color: assignedPlayerId === 1 ? 'green' : 'blue' };

    // Ensure board state exists for this player if joining
    if (!boards[assignedPlayerId]) {
        boards[assignedPlayerId] = createNewBoardState(assignedPlayerId);
    }
    boards[assignedPlayerId].color = players[socket.id].color; // Assign color
    boards[assignedPlayerId].isGameOver = false; // Ensure not marked as game over on join

    console.log(`Player ${assignedPlayerId} (${socket.id}) assigned.`);
    socket.emit('init', { yourPlayerId: assignedPlayerId, gridSize: GRID_SIZE, cellSize: 20 });


    if (playerSockets[1] && playerSockets[2]) {
        initiateGameStartSequence();
    } else {
        socket.emit('waiting');
        io.emit('gameState', boards); // Send current state even if one player is waiting
    }

    socket.on('directionChange', (newDirection) => {
        if (!gameActuallyRunning) return; // Ignore input if game (snake movement) hasn't started

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
        const playerId = players[socket.id].playerId;
        console.log(`Player ${playerId} (${socket.id}) requested restart.`);
        restartRequests.add(socket.id);
        io.to(socket.id).emit('restartRequestedByYou');

        const opponentSocketId = playerId === 1 ? playerSockets[2] : playerSockets[1];
        if (opponentSocketId && playerSockets[opponentSocketId === playerSockets[1] ? 1 : 2]) { // Check opponent still connected
            io.to(opponentSocketId).emit('opponentRequestedRestart');
        }

        // Check if both *currently connected* players have requested restart
        let connectedPlayerRequests = 0;
        if (playerSockets[1] && restartRequests.has(playerSockets[1])) connectedPlayerRequests++;
        if (playerSockets[2] && restartRequests.has(playerSockets[2])) connectedPlayerRequests++;

        if (connectedPlayerRequests === 2 && playerSockets[1] && playerSockets[2]) {
            console.log("Both connected players requested restart. Starting new game sequence.");
            io.emit('allPlayersReadyForRestart');
            initiateGameStartSequence(); // This also clears restartRequests
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        const disconnectedPlayerInfo = players[socket.id];
        restartRequests.delete(socket.id); // Remove from restart requests

        if (disconnectedPlayerInfo) {
            const disconnectedPlayerId = disconnectedPlayerInfo.playerId;
            playerSockets[disconnectedPlayerId] = null;
            delete players[socket.id];

            // If game was running or in countdown, the other player wins.
            if (gameInterval || countdownInterval || gameActuallyRunning) {
                clearAllIntervalsAndRequests();
                if(boards[disconnectedPlayerId]) boards[disconnectedPlayerId].isGameOver = true;

                const winnerId = disconnectedPlayerId === 1 ? 2 : 1;
                if (playerSockets[winnerId]) { // If winner is still connected
                    if(boards[winnerId]) boards[winnerId].isGameOver = false; // Ensure winner is not game over
                    io.to(playerSockets[winnerId]).emit('gameOver', { winnerId: winnerId, reason: 'opponentLeft' });
                    io.to(playerSockets[winnerId]).emit('waiting'); // Put winner back to waiting
                } else { // Both disconnected or winner left fast
                     resetBoardStatesOnly(); // Reset for fresh game
                }
                io.emit('gameState', boards); // Send final state
            } else if (!playerSockets[1] && !playerSockets[2]){ // Both left, no game was running
                resetBoardStatesOnly(); // Ensure clean state
                io.emit('gameState', boards);
            } else { // One player left while waiting
                 const remainingPlayerId = playerSockets[1] ? 1 : (playerSockets[2] ? 2 : null);
                 if(remainingPlayerId){
                     io.to(playerSockets[remainingPlayerId]).emit('waiting');
                 }
                 if(boards[disconnectedPlayerId]) boards[disconnectedPlayerId] = createNewBoardState(disconnectedPlayerId); // Reset the board of disconnected player
                 io.emit('gameState', boards);
            }
        }
        // If no players left, ensure clean state for next joiners
        if (!playerSockets[1] && !playerSockets[2]) {
             console.log("All players disconnected. Ready for new game.");
             resetBoardStatesOnly(); // Full reset
        }
    });
});

// --- Game Update Logic ---
function updateGameTick() {
    if (!playerSockets[1] || !playerSockets[2]) {
        console.warn("Game tick with missing players. Stopping game.");
        clearAllIntervalsAndRequests();
        resetBoardStatesOnly(); // Reset and wait for new players
        io.emit('gameState', boards);
        io.emit('waiting'); // Notify any remaining client they are waiting
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

    if (winnerId !== null) {
        clearAllIntervalsAndRequests(); // Stops gameInterval from within
        console.log(`Game Over! Winner: ${winnerId === 0 ? "Draw" : "Player " + winnerId}`);
        io.emit('gameOver', { winnerId: winnerId, reason: 'collision' });
        io.emit('gameState', boards); // Send final board state
    } else {
        io.emit('gameState', boards);
    }
}

// --- Server Start ---
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    // Initial reset of boards for a clean slate when server starts
    resetBoardStatesOnly();
    console.log("Server ready. Initial board states created.");
});