const socket = io();

// --- DOM Elements ---
let canvas1, ctx1, canvas2, ctx2;
let statusDiv, score1Span, score2Span, p1StatusSpan, p2StatusSpan, youP1Span, youP2Span;
let countdownDisplayDiv, restartButton;

// --- Client Game State ---
let myPlayerId = null;
let gridSize = null, cellSize = null, canvasWidth = null, canvasHeight = null;
let currentBoardsState = null; // Holds the latest state { 1: boardData, 2: boardData }
let gameActiveForInput = false; // True only when snakes should respond to input (after GO!)

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    // Get canvas elements and contexts
    canvas1 = document.getElementById('gameCanvas1'); ctx1 = canvas1.getContext('2d');
    canvas2 = document.getElementById('gameCanvas2'); ctx2 = canvas2.getContext('2d');

    // Get UI elements
    statusDiv = document.getElementById('status');
    score1Span = document.getElementById('score1'); score2Span = document.getElementById('score2');
    p1StatusSpan = document.getElementById('p1-status'); p2StatusSpan = document.getElementById('p2-status');
    youP1Span = document.getElementById('you-p1'); youP2Span = document.getElementById('you-p2');
    countdownDisplayDiv = document.getElementById('countdownDisplay');
    restartButton = document.getElementById('restartButton');

    // Initial setup
    updateStatus('Connecting to server...', true);
    if (restartButton) {
        restartButton.style.display = 'none';
        restartButton.addEventListener('click', handleRestartRequest);
    }

    // Setup keyboard listener
    document.addEventListener('keydown', handleKeyPress);
});

// --- Utility Functions ---
function updateStatus(message, shouldPulse = false) {
    if (statusDiv) {
        statusDiv.textContent = message;
        statusDiv.classList.toggle('pulsing', shouldPulse);
    }
}

function updatePlayerStatusAndClass(playerId, statusText, statusClass) {
    const span = (playerId === 1) ? p1StatusSpan : p2StatusSpan;
    if (span) {
        span.textContent = statusText;
        span.className = 'player-status'; // Reset base class
        if (statusClass) span.classList.add(statusClass);
    }
}

function clearCanvas(context) {
    if (!context || !canvasWidth || !canvasHeight) return;
    const bgColor = getComputedStyle(context.canvas).backgroundColor || '#FFF';
    context.fillStyle = bgColor;
    context.fillRect(0, 0, canvasWidth, canvasHeight);
}

function handleRestartRequest() {
    socket.emit('requestRestart');
    if (restartButton) {
        restartButton.disabled = true;
        restartButton.textContent = 'Restart Requested...';
    }
    updateStatus('Restart requested. Waiting for opponent...');
}


// --- Socket Event Handlers ---
socket.on('connect', () => {
    console.log('Connected! Socket ID:', socket.id);
    updateStatus('Connected. Waiting for assignment...', true);
});

socket.on('disconnect', () => {
    console.log('Disconnected.');
    updateStatus('Disconnected. Please refresh.');
    myPlayerId = null; gameActiveForInput = false;
    updatePlayerStatusAndClass(1, "Offline", "disconnected");
    updatePlayerStatusAndClass(2, "Offline", "disconnected");
    if (youP1Span) youP1Span.style.display = 'none';
    if (youP2Span) youP2Span.style.display = 'none';
    if (restartButton) restartButton.style.display = 'none';
    if (countdownDisplayDiv) countdownDisplayDiv.classList.remove('visible');
});

socket.on('init', (data) => {
    console.log('Init received:', data);
    myPlayerId = data.yourPlayerId;
    gridSize = data.gridSize;
    cellSize = data.cellSize; // Assuming server sends this, or use a fixed value
    canvasWidth = gridSize * cellSize;
    canvasHeight = gridSize * cellSize;

    [canvas1, canvas2].forEach(c => { if(c) {c.width = canvasWidth; c.height = canvasHeight;} });

    updateStatus(`You are Player ${myPlayerId}. Waiting...`, true);
    if (youP1Span) youP1Span.style.display = (myPlayerId === 1) ? 'inline' : 'none';
    if (youP2Span) youP2Span.style.display = (myPlayerId === 2) ? 'inline' : 'none';
    gameActiveForInput = false;
    if (restartButton) restartButton.style.display = 'none';
    if (countdownDisplayDiv) countdownDisplayDiv.classList.remove('visible');

    // Request initial state or wait for first gameState/countdown
    // If server sends boards with init, draw them:
    // if (data.boards) { currentBoardsState = data.boards; drawGame(); }
});

socket.on('waiting', () => {
    console.log('Waiting for opponent...');
    updateStatus('Waiting for opponent to join...', true);
    gameActiveForInput = false;
    if (restartButton) restartButton.style.display = 'none';
    if (myPlayerId) updatePlayerStatusAndClass(myPlayerId, "Waiting", "waiting");
    // Clear opponent board if they left and this client is still waiting
    if (currentBoardsState && myPlayerId) {
        const opponentId = myPlayerId === 1 ? 2 : 1;
        if (!currentBoardsState[opponentId] || (playerSockets && !playerSockets[opponentId])) { // Simplified check
            const opponentCtx = opponentId === 1 ? ctx1 : ctx2;
            const opponentScoreSpan = opponentId === 1 ? score1Span : score2Span;
            if(opponentCtx) clearCanvas(opponentCtx);
            if(opponentScoreSpan) opponentScoreSpan.textContent = '0';
            updatePlayerStatusAndClass(opponentId, "Waiting", "waiting");
        }
    }
});

socket.on('countdownUpdate', (count) => {
    gameActiveForInput = false; // Input disabled during countdown
    if (restartButton) restartButton.style.display = 'none';

    if (count === null) { // Server signals to hide countdown
        if (countdownDisplayDiv) countdownDisplayDiv.classList.remove('visible');
        gameActiveForInput = true; // Snakes can move now!
        updateStatus('GO! Game in progress!');
        return;
    }

    if (countdownDisplayDiv) {
        countdownDisplayDiv.textContent = count;
        countdownDisplayDiv.classList.add('visible');
    }

    if (count === 'GO!') {
        updateStatus('GO!');
        // Server will send null next to hide, gameActiveForInput set true then.
    } else if (typeof count === 'number') {
        updateStatus(`Game starting in ${count}...`);
    }
});

socket.on('gameState', (boardsData) => {
    if (!myPlayerId) return; // Not initialized yet

    currentBoardsState = boardsData;
    drawGame();

    // Update scores and player statuses
    [1, 2].forEach(playerId => {
        const board = currentBoardsState[playerId];
        const scoreSpan = (playerId === 1) ? score1Span : score2Span;

        if (board) {
            if (scoreSpan) scoreSpan.textContent = board.score;
            // Game over status is handled by the 'gameOver' event for finality
            // During game, if not game over, consider "Playing" or "Waiting"
            if (!board.isGameOver && gameActiveForInput) {
                updatePlayerStatusAndClass(playerId, "Playing", "playing");
            } else if (!board.isGameOver && !gameActiveForInput && countdownDisplayDiv && countdownDisplayDiv.classList.contains('visible')) {
                 updatePlayerStatusAndClass(playerId, "Ready", "waiting"); // Or just "Waiting"
            } else if (!board.isGameOver) {
                 updatePlayerStatusAndClass(playerId, "Waiting", "waiting");
            }
            // isGameOver true cases are handled by the 'gameOver' event typically
        } else {
            if (scoreSpan) scoreSpan.textContent = '0';
            updatePlayerStatusAndClass(playerId, "Waiting", "waiting");
        }
    });
});

socket.on('gameOver', (data) => {
    console.log('Game Over!', data);
    gameActiveForInput = false;
    if (countdownDisplayDiv) countdownDisplayDiv.classList.remove('visible');
    let message = "Game Over! ";

    if (data.reason === 'opponentLeft') {
        message = `Player ${data.winnerId} wins! (Opponent disconnected)`;
        updatePlayerStatusAndClass(data.winnerId, "Winner!", "winner");
        const loserId = data.winnerId === 1 ? 2 : 1;
        updatePlayerStatusAndClass(loserId, "Disconnected", "disconnected");
    } else if (data.winnerId === 0) {
        message += "It's a draw!";
        updatePlayerStatusAndClass(1, "Draw", "draw");
        updatePlayerStatusAndClass(2, "Draw", "draw");
    } else {
        message += `Player ${data.winnerId} wins!`;
        const loserId = data.winnerId === 1 ? 2 : 1;
        updatePlayerStatusAndClass(data.winnerId, "Winner!", "winner");
        updatePlayerStatusAndClass(loserId, "Lost", "lost");
    }
    updateStatus(message);

    if (restartButton) {
        restartButton.style.display = 'block';
        restartButton.disabled = false;
        restartButton.textContent = 'Request Restart';
    }
    // Ensure visual update of game over state on boards
    if (currentBoardsState) {
        if(currentBoardsState[1]) currentBoardsState[1].isGameOver = (data.winnerId === 2 || data.winnerId === 0 || (data.reason === 'opponentLeft' && data.winnerId === 2));
        if(currentBoardsState[2]) currentBoardsState[2].isGameOver = (data.winnerId === 1 || data.winnerId === 0 || (data.reason === 'opponentLeft' && data.winnerId === 1));
        drawGame();
    }
});

socket.on('gameFull', () => {
    updateStatus('Game is full. Please try again later.');
});

socket.on('restartRequestedByYou', () => {
    if(restartButton) {
        restartButton.textContent = 'Restart Requested!';
        restartButton.disabled = true; // Already handled by click, but good for server ack
    }
});

socket.on('opponentRequestedRestart', () => {
    updateStatus('Opponent wants to restart! Click "Request Restart" to begin.', true);
    // No change to button needed, if user hasn't clicked, they still need to "Request Restart"
});

socket.on('allPlayersReadyForRestart', () => {
    updateStatus('Both players ready! New game starting soon...');
    if(restartButton) restartButton.style.display = 'none';
    if (countdownDisplayDiv) countdownDisplayDiv.classList.remove('visible');
});


// --- Drawing Functions ---
function drawGame() {
    if (!currentBoardsState || !ctx1 || !ctx2 || !canvasWidth || !canvasHeight) return;
    if (currentBoardsState[1]) drawBoard(1, currentBoardsState[1], ctx1); else if(ctx1) clearCanvas(ctx1);
    if (currentBoardsState[2]) drawBoard(2, currentBoardsState[2], ctx2); else if(ctx2) clearCanvas(ctx2);
}

function drawBoard(playerId, boardState, context) {
    clearCanvas(context);

    // Draw Food
    context.fillStyle = 'red';
    context.fillRect(boardState.food.x * cellSize, boardState.food.y * cellSize, cellSize, cellSize);

    // Draw Debuffs
    context.fillStyle = 'purple';
    boardState.debuffs.forEach(debuff => {
        context.fillRect(debuff.x * cellSize + cellSize * 0.15, debuff.y * cellSize + cellSize * 0.15, cellSize * 0.7, cellSize * 0.7);
    });

    // Draw Snake
    context.fillStyle = boardState.color;
    context.strokeStyle = '#111';
    context.lineWidth = 1;
    boardState.snake.forEach((segment, index) => {
        context.fillRect(segment.x * cellSize, segment.y * cellSize, cellSize, cellSize);
        context.strokeRect(segment.x * cellSize, segment.y * cellSize, cellSize, cellSize);
        if (index === 0) { // Draw head eye
            context.fillStyle = '#FFF';
            let eyeX = segment.x * cellSize, eyeY = segment.y * cellSize;
            const eyeSize = cellSize / 5;
            switch(boardState.direction) {
                case 'UP': eyeX += cellSize / 2 - eyeSize / 2; eyeY += cellSize / 4 - eyeSize / 2; break;
                case 'DOWN': eyeX += cellSize / 2 - eyeSize / 2; eyeY += cellSize * 0.75 - eyeSize / 2; break;
                case 'LEFT': eyeX += cellSize / 4 - eyeSize / 2; eyeY += cellSize / 2 - eyeSize / 2; break;
                case 'RIGHT': eyeX += cellSize * 0.75 - eyeSize / 2; eyeY += cellSize / 2 - eyeSize / 2; break;
            }
            context.fillRect(eyeX, eyeY, eyeSize, eyeSize);
            context.fillStyle = boardState.color; // Reset fillStyle
        }
    });

    if (boardState.isGameOver) {
        context.fillStyle = 'rgba(26, 26, 46, 0.75)';
        context.fillRect(0, 0, canvasWidth, canvasHeight);
        context.fillStyle = '#e94560';
        context.font = `bold ${Math.max(24, Math.floor(cellSize * 1.5))}px ${getComputedStyle(document.body).fontFamily.split(',')[0].trim()}`;
        context.textAlign = 'center';
        context.shadowColor = 'black'; context.shadowBlur = 5;
        context.fillText('GAME OVER', canvasWidth / 2, canvasHeight / 2);
        context.shadowBlur = 0;
    }
}

// --- Keyboard Input Handler ---
function handleKeyPress(event) {
    if (!gameActiveForInput || !myPlayerId || !currentBoardsState || !currentBoardsState[myPlayerId] || currentBoardsState[myPlayerId].isGameOver) {
        return;
    }
    let direction = null;
    switch (event.key.toUpperCase()) {
        case 'W': direction = 'UP'; break;
        case 'S': direction = 'DOWN'; break;
        case 'A': direction = 'LEFT'; break;
        case 'D': direction = 'RIGHT'; break;
        default: return;
    }
    socket.emit('directionChange', direction);
}