const socket = io();

// --- DOM Elements ---
let canvas1, ctx1, canvas2, ctx2;
let statusDiv, score1Span, score2Span, p1StatusSpan, p2StatusSpan, youP1Span, youP2Span;
let countdownDisplayDiv, restartButton;
// NEW UI Elements for Name and Leaderboard
let playerNameModal, playerNameInput, submitNameButton, nameStatusMessage;
let showLeaderboardButton, leaderboardModal, leaderboardList, closeLeaderboardButton;
let p1NameDisplay, p2NameDisplay; // For showing names in player areas

// --- Client Game State ---
let myPlayerId = null;
let gridSize = null, cellSize = 20, canvasWidth = null, canvasHeight = null; // Default cellSize
let currentBoardsState = null;
let gameActiveForInput = false;
let localPlayerName = null; // Store the player's chosen name locally

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
    p1NameDisplay = document.getElementById('p1-name-display');
    p2NameDisplay = document.getElementById('p2-name-display');

    // Player Name Modal elements
    playerNameModal = document.getElementById('playerNameModal');
    playerNameInput = document.getElementById('playerNameInput');
    submitNameButton = document.getElementById('submitNameButton');
    nameStatusMessage = document.getElementById('nameStatusMessage');

    // Leaderboard elements
    showLeaderboardButton = document.getElementById('showLeaderboardButton');
    leaderboardModal = document.getElementById('leaderboardModal');
    leaderboardList = document.getElementById('leaderboardList');
    closeLeaderboardButton = document.getElementById('closeLeaderboardButton');

    // Initial setup
    updateStatus('Connecting to server...', true);
    if (restartButton) {
        restartButton.style.display = 'none';
        restartButton.addEventListener('click', handleRestartRequest);
    }
    if (submitNameButton) {
        submitNameButton.addEventListener('click', handleSubmitPlayerName);
    }
    if (showLeaderboardButton) {
        showLeaderboardButton.addEventListener('click', fetchAndShowLeaderboard);
    }
    if (closeLeaderboardButton) {
        closeLeaderboardButton.addEventListener('click', () => {
            if(leaderboardModal) leaderboardModal.classList.remove('visible');
        });
    }
     // Close modals if overlay is clicked
     [playerNameModal, leaderboardModal].forEach(modal => {
        if (modal) {
            modal.addEventListener('click', (event) => {
                if (event.target === modal) { // Clicked on overlay, not content
                    modal.classList.remove('visible');
                }
            });
        }
    });

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
        span.className = 'player-status';
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

// --- Player Name Functions ---
function showPlayerNameModal(defaultName = '') {
    if (playerNameModal) {
        if(playerNameInput) playerNameInput.value = localPlayerName || defaultName || '';
        if(nameStatusMessage) {
            nameStatusMessage.textContent = '';
            nameStatusMessage.className = 'name-status'; // Reset class
        }
        playerNameModal.classList.add('visible');
        if(playerNameInput) playerNameInput.focus();
    }
}

function handleSubmitPlayerName() {
    if (playerNameInput && nameStatusMessage) {
        const name = playerNameInput.value.trim();
        if (name.length >= 2 && name.length <= 15) {
            socket.emit('submitPlayerName', name);
            nameStatusMessage.textContent = "Submitting name...";
            nameStatusMessage.className = 'name-status'; // Neutral
        } else {
            nameStatusMessage.textContent = 'Name must be 2-15 characters.';
            nameStatusMessage.className = 'name-status error';
        }
    }
}

// --- Leaderboard Functions ---
async function fetchAndShowLeaderboard() {
    if (!leaderboardModal || !leaderboardList) return;
    leaderboardList.innerHTML = '<li>Loading...</li>';
    leaderboardModal.classList.add('visible');

    try {
        const response = await fetch('/api/leaderboard');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const scores = await response.json();
        renderLeaderboard(scores);
    } catch (error) {
        console.error("Failed to fetch leaderboard:", error);
        if(leaderboardList) leaderboardList.innerHTML = '<li>Error loading scores. Please try again.</li>';
    }
}

function renderLeaderboard(scores) {
    if (!leaderboardList) return;
    leaderboardList.innerHTML = '';

    if (scores.length === 0) {
        leaderboardList.innerHTML = '<li>No scores yet. Be the first!</li>';
        return;
    }

    scores.forEach(scoreEntry => {
        const li = document.createElement('li');
        const nameSpan = document.createElement('span');
        nameSpan.className = 'leaderboard-name';
        nameSpan.textContent = scoreEntry.playerName;

        const scoreSpan = document.createElement('span');
        scoreSpan.className = 'leaderboard-score';
        scoreSpan.textContent = scoreEntry.score;

        li.appendChild(nameSpan);
        li.appendChild(scoreSpan);
        leaderboardList.appendChild(li);
    });
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
    if (p1NameDisplay) p1NameDisplay.textContent = "Player 1";
    if (p2NameDisplay) p2NameDisplay.textContent = "Player 2";
    if (youP1Span) youP1Span.style.display = 'none';
    if (youP2Span) youP2Span.style.display = 'none';
    if (restartButton) restartButton.style.display = 'none';
    if (countdownDisplayDiv) countdownDisplayDiv.classList.remove('visible');
    if (playerNameModal) playerNameModal.classList.remove('visible');
    if (leaderboardModal) leaderboardModal.classList.remove('visible');
});

socket.on('init', (data) => {
    console.log('Init received:', data);
    myPlayerId = data.yourPlayerId;
    gridSize = data.gridSize;
    cellSize = data.cellSize || 20; // Use server's cellSize or default
    canvasWidth = gridSize * cellSize;
    canvasHeight = gridSize * cellSize;

    [canvas1, canvas2].forEach(c => { if(c) { c.width = canvasWidth; c.height = canvasHeight; } });

    updateStatus(`You are Player ${myPlayerId}. Waiting...`, true);
    if (youP1Span) youP1Span.style.display = (myPlayerId === 1) ? 'inline' : 'none';
    if (youP2Span) youP2Span.style.display = (myPlayerId === 2) ? 'inline' : 'none';
    gameActiveForInput = false;
    if (restartButton) restartButton.style.display = 'none';
    if (countdownDisplayDiv) countdownDisplayDiv.classList.remove('visible');

    localPlayerName = data.defaultName;
    updatePlayerNameDisplays(myPlayerId, data.defaultName);

    // Prompt for name if it's the default placeholder.
    if (localPlayerName && localPlayerName.startsWith('Player')) {
        setTimeout(() => showPlayerNameModal(data.defaultName), 500);
    }
});

socket.on('nameAccepted', (acceptedName) => {
    localPlayerName = acceptedName;
    if (playerNameModal) playerNameModal.classList.remove('visible');
    if(nameStatusMessage) {
        nameStatusMessage.textContent = 'Name saved!';
        nameStatusMessage.className = 'name-status success';
        setTimeout(() => { if(nameStatusMessage) nameStatusMessage.textContent = ''; }, 2000);
    }
    updatePlayerNameDisplays(myPlayerId, acceptedName);
    // Status might be 'Waiting' or game starting, so don't overwrite specific game phase status.
    console.log(`Name set to: ${acceptedName}`);
});

socket.on('nameInvalid', (errorMessage) => {
    if(nameStatusMessage) {
        nameStatusMessage.textContent = errorMessage;
        nameStatusMessage.className = 'name-status error';
    }
});

socket.on('waiting', () => {
    console.log('Waiting for opponent...');
    updateStatus('Waiting for opponent to join...', true);
    gameActiveForInput = false;
    if (restartButton) restartButton.style.display = 'none';
    if (myPlayerId) updatePlayerStatusAndClass(myPlayerId, "Waiting", "waiting");
    // Clear opponent's specific display if they are no longer in currentBoardsState
    if (currentBoardsState && myPlayerId) {
        const opponentId = myPlayerId === 1 ? 2 : 1;
        if (!currentBoardsState[opponentId]) { // Opponent data is missing
            const opponentCtx = opponentId === 1 ? ctx1 : ctx2;
            const opponentScoreSpan = opponentId === 1 ? score1Span : score2Span;
            const opponentNameDisplay = opponentId === 1 ? p1NameDisplay : p2NameDisplay;

            if(opponentCtx) clearCanvas(opponentCtx);
            if(opponentScoreSpan) opponentScoreSpan.textContent = '0';
            if(opponentNameDisplay) opponentNameDisplay.textContent = `Player ${opponentId}`;
            updatePlayerStatusAndClass(opponentId, "Waiting", "waiting");
        }
    }
});

socket.on('countdownUpdate', (count) => {
    gameActiveForInput = false;
    if (restartButton) restartButton.style.display = 'none';
    if (playerNameModal) playerNameModal.classList.remove('visible');

    if (count === null) {
        if (countdownDisplayDiv) countdownDisplayDiv.classList.remove('visible');
        gameActiveForInput = true;
        updateStatus('GO! Game in progress!');
        return;
    }
    if (countdownDisplayDiv) {
        countdownDisplayDiv.textContent = count;
        countdownDisplayDiv.classList.add('visible');
    }
    if (count === 'GO!') {
        updateStatus('GO!');
    } else if (typeof count === 'number') {
        updateStatus(`Game starting in ${count}...`);
    }
});

// Function to update player name displays in the H2 tags
function updatePlayerNameDisplays(playerIdToUpdate, name) {
    const nameDisplaySpan = (playerIdToUpdate === 1) ? p1NameDisplay : p2NameDisplay;
    if (nameDisplaySpan) {
        nameDisplaySpan.textContent = name;
    }
}

// Listen for an event from server if opponent's name changes
socket.on('opponentNameUpdate', (data) => { // data = { playerId: opponentId, name: opponentName }
    if (data && data.playerId !== myPlayerId) {
        updatePlayerNameDisplays(data.playerId, data.name);
    }
});


socket.on('gameState', (boardsData) => {
    if (!myPlayerId) return;

    currentBoardsState = boardsData;
    drawGame();

    [1, 2].forEach(playerId => {
        const board = currentBoardsState[playerId];
        const scoreSpan = (playerId === 1) ? score1Span : score2Span;
        // Player names updated via 'init' and 'opponentNameUpdate'
        // Or server needs to include names in `boardsData.playerId.playerName`

        if (board) {
            if (scoreSpan) scoreSpan.textContent = board.score;
            // Update name if server sends it with board data (requires server change)
            const nameDisplay = playerId === 1 ? p1NameDisplay : p2NameDisplay;
            if (board.playerName && nameDisplay) { // Assuming server adds 'playerName' to board state
                nameDisplay.textContent = board.playerName;
            }


            if (!board.isGameOver && gameActiveForInput) {
                updatePlayerStatusAndClass(playerId, "Playing", "playing");
            } else if (!board.isGameOver && countdownDisplayDiv && countdownDisplayDiv.classList.contains('visible')) {
                 updatePlayerStatusAndClass(playerId, "Ready", "waiting");
            } else if (!board.isGameOver) {
                 updatePlayerStatusAndClass(playerId, "Waiting", "waiting");
            }
            // isGameOver true cases handled by 'gameOver' event
        } else { // Board data missing for this player
            if (scoreSpan) scoreSpan.textContent = '0';
            updatePlayerStatusAndClass(playerId, "Waiting", "waiting");
            const nameDisplay = playerId === 1 ? p1NameDisplay : p2NameDisplay;
            if(nameDisplay) nameDisplay.textContent = `Player ${playerId}`; // Reset to default
        }
    });
});


socket.on('gameOver', (data) => {
    console.log('Game Over!', data);
    gameActiveForInput = false;
    if (countdownDisplayDiv) countdownDisplayDiv.classList.remove('visible');
    let message = "Game Over! ";

    const winnerName = currentBoardsState[data.winnerId]?.playerName || `Player ${data.winnerId}`;
    const loserId = data.winnerId === 1 ? 2 : 1;
    // const loserName = currentBoardsState[loserId]?.playerName || `Player ${loserId}`;

    if (data.reason === 'opponentLeft') {
        message = `${winnerName} wins! (Opponent disconnected)`;
        updatePlayerStatusAndClass(data.winnerId, "Winner!", "winner");
        updatePlayerStatusAndClass(loserId, "Disconnected", "disconnected");
    } else if (data.winnerId === 0) {
        message += "It's a draw!";
        updatePlayerStatusAndClass(1, "Draw", "draw");
        updatePlayerStatusAndClass(2, "Draw", "draw");
    } else {
        message += `${winnerName} wins!`;
        updatePlayerStatusAndClass(data.winnerId, "Winner!", "winner");
        updatePlayerStatusAndClass(loserId, "Lost", "lost");
    }
    updateStatus(message);

    if (restartButton) {
        restartButton.style.display = 'block';
        restartButton.disabled = false;
        restartButton.textContent = 'Request Restart';
    }

    // Ensure final game over state is visually rendered
    if (currentBoardsState) {
        if(currentBoardsState[1]) currentBoardsState[1].isGameOver = (data.winnerId === 2 || data.winnerId === 0 || (data.reason === 'opponentLeft' && data.winnerId === 2));
        if(currentBoardsState[2]) currentBoardsState[2].isGameOver = (data.winnerId === 1 || data.winnerId === 0 || (data.reason === 'opponentLeft' && data.winnerId === 1));
        drawGame();
    }

     // After game, prompt for name if it's still the default, then show leaderboard
     setTimeout(() => {
         const currentName = (myPlayerId === 1 && p1NameDisplay) ? p1NameDisplay.textContent : ( (myPlayerId === 2 && p2NameDisplay) ? p2NameDisplay.textContent : "");
         if (!localPlayerName || currentName.startsWith('Player')) { // Check current displayed name too
             showPlayerNameModal(localPlayerName || (myPlayerId ? `Player${myPlayerId}`: ''));
         } else {
             fetchAndShowLeaderboard(); // Show leaderboard if name is already set
         }
     }, 1500);
});

socket.on('gameFull', () => {
    updateStatus('Game is full. Please try again later.');
});
socket.on('restartRequestedByYou', () => {
    if(restartButton) {
        restartButton.textContent = 'Restart Requested!';
        restartButton.disabled = true;
    }
});
socket.on('opponentRequestedRestart', () => {
    updateStatus('Opponent wants to restart! Click "Request Restart" to begin.', true);
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
        context.fillStyle = '#e94560'; // Use accent text color from CSS
        // Try to get primary font from body for consistency
        const bodyFont = getComputedStyle(document.body).fontFamily.split(',')[0].trim() || 'sans-serif';
        context.font = `bold ${Math.max(24, Math.floor(cellSize * 1.5))}px ${bodyFont}`;
        context.textAlign = 'center';
        context.shadowColor = 'black'; context.shadowBlur = 5;
        context.fillText('GAME OVER', canvasWidth / 2, canvasHeight / 2);
        context.shadowBlur = 0; // Reset shadow for other drawings
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
        default: return; // Ignore other keys
    }
    socket.emit('directionChange', direction);
}