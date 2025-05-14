// game.js
const socket = io();

// --- DOM Elements ---
let canvas1, ctx1, canvas2, ctx2;
let statusDiv, score1Span, score2Span, p1StatusSpan, p2StatusSpan, youP1Span, youP2Span;
let countdownDisplayDiv, restartButton;
let playerNameModal, playerNameInput, submitNameButton, nameStatusMessage; // 'submitNameButton' will be our "Join Game" button
let leaderboardList, refreshLeaderboardButton; // Leaderboard is now a sidebar
let p1NameDisplay, p2NameDisplay;
let gameAreaDiv; // Main game area div

// --- Client Game State ---
let myPlayerId = null;
let gridSize = null, cellSize = 20, canvasWidth = null, canvasHeight = null;
let currentBoardsState = null;
let gameActiveForInput = false;
let localPlayerName = null; // Store the player's chosen name locally, confirmed by server

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    // Get canvas elements and contexts
    canvas1 = document.getElementById('gameCanvas1');
    if (canvas1) ctx1 = canvas1.getContext('2d'); else console.error("Canvas1 not found");
    canvas2 = document.getElementById('gameCanvas2');
    if (canvas2) ctx2 = canvas2.getContext('2d'); else console.error("Canvas2 not found");
    gameAreaDiv = document.getElementById('gameArea'); 

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
    submitNameButton = document.getElementById('submitNameButton'); // This button submits the name to join
    nameStatusMessage = document.getElementById('nameStatusMessage');

    // Leaderboard elements (sidebar)
    leaderboardList = document.getElementById('leaderboardList');
    refreshLeaderboardButton = document.getElementById('refreshLeaderboardButton');

    // Initial UI setup
    if (statusDiv) updateStatus('Connecting to server...', true); // Initial status
    if (restartButton) {
        restartButton.style.display = 'none';
        restartButton.addEventListener('click', handleRestartRequest);
    }

    if (submitNameButton) {
        // This button is now primarily for the initial "Join Game" with name
        submitNameButton.addEventListener('click', handleJoinGameAttempt);
    } else {
        console.error("Submit Name Button (for joining) not found!");
    }

    if (refreshLeaderboardButton) {
        refreshLeaderboardButton.addEventListener('click', fetchAndShowLeaderboard);
    }

    if (playerNameModal) {
        playerNameModal.addEventListener('click', (event) => {
            if (event.target === playerNameModal) {
                // Optional: allow closing modal by clicking overlay if not critical stage
                // For now, keep focus, don't auto-close
            }
        });
        showPlayerNameModal(); // Show name modal immediately on load
    } else {
        console.error("Player Name Modal not found! Cannot get player name.");
        if(statusDiv) updateStatus("Error: UI components missing. Cannot start game.");
        return;
    }

    fetchAndShowLeaderboard();
    setupSocketEventHandlers();
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
    if (!context || !context.canvas || !canvasWidth || !canvasHeight) return;
    const bgColor = getComputedStyle(context.canvas).backgroundColor || '#FFF';
    context.fillStyle = bgColor;
    context.fillRect(0, 0, canvasWidth, canvasHeight);
}

function handleRestartRequest() {
    if (socket && socket.connected) {
        socket.emit('requestRestart');
        if (restartButton) {
            restartButton.disabled = true;
            restartButton.textContent = 'Restart Requested...';
        }
        updateStatus('Restart requested. Waiting for opponent...');
    } else {
        updateStatus("Not connected to server to request restart.");
    }
}

// --- Player Name and Joining Functions ---
function showPlayerNameModal(defaultName = '') {
    if (playerNameModal) {
        if (playerNameInput) {
            playerNameInput.value = localPlayerName || defaultName || '';
            playerNameInput.disabled = false;
        }
        if (nameStatusMessage) {
            nameStatusMessage.textContent = 'Please enter your name to join the game.';
            nameStatusMessage.className = 'name-status';
        }
        if (submitNameButton) {
            submitNameButton.disabled = false;
            submitNameButton.textContent = 'Join Game';
        }
        playerNameModal.classList.add('visible');
        if (playerNameInput) playerNameInput.focus();
        console.log("UI: Showing Player Name Modal");
    }
}

function handleJoinGameAttempt() {
    if (!playerNameInput || !nameStatusMessage || !submitNameButton) return;

    const name = playerNameInput.value.trim();
    if (name.length >= 2 && name.length <= 15) {
        if (socket && socket.connected) {
            console.log("Client: Attempting to join with name -", name);
            socket.emit('joinGame', { name: name });
            nameStatusMessage.textContent = "Attempting to join...";
            nameStatusMessage.className = 'name-status';
            playerNameInput.disabled = true;
            submitNameButton.disabled = true;
            submitNameButton.textContent = 'Joining...';
        } else {
            nameStatusMessage.textContent = 'Not connected to server. Please wait or refresh.';
            nameStatusMessage.className = 'name-status error';
        }
    } else {
        nameStatusMessage.textContent = 'Name must be 2-15 characters.';
        nameStatusMessage.className = 'name-status error';
    }
}

// --- Leaderboard Functions ---
async function fetchAndShowLeaderboard() {
    if (!leaderboardList) return;
    leaderboardList.innerHTML = '<li>Refreshing...</li>';

    try {
        const response = await fetch('/api/leaderboard');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const scores = await response.json();
        renderLeaderboard(scores);
    } catch (error) {
        console.error("Failed to fetch leaderboard:", error);
        if (leaderboardList) leaderboardList.innerHTML = '<li>Error loading scores. Please try again.</li>';
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

// --- Socket Event Handlers Setup ---
function setupSocketEventHandlers() {
    socket.on('connect', () => {
        console.log('Socket.IO: Connected! Socket ID:', socket.id);
        if (playerNameModal && !playerNameModal.classList.contains('visible') && !myPlayerId) {
            showPlayerNameModal();
            updateStatus('Connected. Enter your name to join.', true);
        } else if (!myPlayerId) {
            updateStatus('Connected. Enter your name to join.', true);
        } else {
            updateStatus('Reconnected to server.');
        }
    });

    socket.on('disconnect', (reason) => {
        console.log('Socket.IO: Disconnected -', reason);
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
    });

    socket.on('init', (data) => {
        console.log('Socket.IO: Game initialized by server:', data);
        myPlayerId = data.yourPlayerId;
        gridSize = data.gridSize;
        cellSize = data.cellSize || 20;
        canvasWidth = gridSize * cellSize;
        canvasHeight = gridSize * cellSize;
        localPlayerName = data.yourName;

        [canvas1, canvas2].forEach(c => { if (c) { c.width = canvasWidth; c.height = canvasHeight; } });

        if (playerNameModal) playerNameModal.classList.remove('visible');

        updateStatus(`You are ${localPlayerName} (Player ${myPlayerId}). Waiting...`, true);
        if (youP1Span) youP1Span.style.display = (myPlayerId === 1) ? 'inline' : 'none';
        if (youP2Span) youP2Span.style.display = (myPlayerId === 2) ? 'inline' : 'none';
        gameActiveForInput = false;
        if (restartButton) restartButton.style.display = 'none';
        if (countdownDisplayDiv) countdownDisplayDiv.classList.remove('visible');

        updatePlayerNameDisplays(myPlayerId, localPlayerName);

        // --- MAKE SURE GAME AREA IS SHOWN ---
    if (gameAreaDiv) { // Assuming 'gameAreaDiv' is your main game container
        gameAreaDiv.style.display = 'block'; // Or whatever your display type is
        console.log("UI: Showing gameAreaDiv.");
    } else {
        console.error("UI: gameAreaDiv not found to show!");
    }
    // --- END ---

    updateStatus(`You are ${localPlayerName} (Player ${myPlayerId}). Waiting for opponent...`, true);
    });

    socket.on('nameRejected', (data) => {
        console.error('Socket.IO: Name rejected by server -', data.message);
        if (nameStatusMessage) {
            nameStatusMessage.textContent = data.message || 'Name rejected. Try another.';
            nameStatusMessage.className = 'name-status error';
        }
        if (playerNameInput) playerNameInput.disabled = false;
        if (submitNameButton) {
             submitNameButton.disabled = false;
             submitNameButton.textContent = 'Join Game';
        }
    });

    socket.on('gameFull', (data) => {
        console.warn('Socket.IO: Game is full -', data.message);
        if (playerNameModal && playerNameModal.classList.contains('visible')) {
            if(nameStatusMessage) {
                nameStatusMessage.textContent = data.message || 'Game is full. Try later.';
                nameStatusMessage.className = 'name-status error';
            }
            if (playerNameInput) playerNameInput.disabled = false; // Still allow typing
            if (submitNameButton) {
                 submitNameButton.disabled = true;
                 submitNameButton.textContent = 'Game Full';
            }
        } else {
            updateStatus(data.message || 'Game is full. Please try again later.');
        }
    });

    socket.on('alreadyJoined', (data) => {
        console.warn('Socket.IO: Server says already joined -', data.message);
        myPlayerId = data.yourPlayerId;
        localPlayerName = data.yourName;
        if (playerNameModal) playerNameModal.classList.remove('visible');
        updateStatus(`Rejoined as ${localPlayerName}. Server will sync state.`);
    });

    socket.on('waiting', () => {
        console.log('Socket.IO: Waiting for opponent...');
        if (!myPlayerId) {
            console.warn("Socket.IO: Received 'waiting' but not yet initialized. Showing name modal.");
            showPlayerNameModal();
            return;
        }
        updateStatus(`Waiting for opponent to join, ${localPlayerName}...`, true);
        gameActiveForInput = false;
        if (restartButton) restartButton.style.display = 'none';
        if (myPlayerId) updatePlayerStatusAndClass(myPlayerId, "Waiting", "waiting");

        const opponentId = myPlayerId === 1 ? 2 : 1;
        if (!currentBoardsState || !currentBoardsState[opponentId]) {
             updatePlayerNameDisplays(opponentId, `Player ${opponentId}`);
             updatePlayerStatusAndClass(opponentId, "Waiting", "waiting");
             const opponentCtx = opponentId === 1 ? ctx1 : ctx2;
             if (opponentCtx) clearCanvas(opponentCtx);
             const opponentScore = opponentId === 1 ? score1Span : score2Span;
             if (opponentScore) opponentScore.textContent = '0';
        }
    });

    socket.on('countdownUpdate', (count) => {
        console.log('Socket.IO: Countdown update -', count);
        gameActiveForInput = false;
        if (restartButton) restartButton.style.display = 'none';
        if (playerNameModal && playerNameModal.classList.contains('visible')) {
            playerNameModal.classList.remove('visible');
        }

        if (count === null) {
            gameActiveForInput = true;
            if (countdownDisplayDiv) countdownDisplayDiv.classList.remove('visible');
            return;
        }
        if (countdownDisplayDiv) {
            countdownDisplayDiv.textContent = count;
            countdownDisplayDiv.classList.add('visible');
        }
        if (count === 'GO!') {
            updateStatus('GO!');
            gameActiveForInput = true;
        } else if (typeof count === 'number') {
            updateStatus(`Game starting in ${count}...`);
        }
    });

    socket.on('opponentNameUpdate', (data) => {
        console.log("Socket.IO: Opponent name update - ", data);
        if (data && data.playerId !== myPlayerId) {
            updatePlayerNameDisplays(data.playerId, data.name);
        }
    });

    socket.on('gameState', (boardsData) => {
        if (!myPlayerId) {
            console.log("Socket.IO: Received gameState but client not initialized. Ignoring.");
            return;
        }
        console.log("Socket.IO: Received game state:", boardsData);
        currentBoardsState = boardsData;
        drawGame();

        [1, 2].forEach(playerId => {
            const board = currentBoardsState[playerId];
            const scoreSpan = (playerId === 1) ? score1Span : score2Span;
            const nameDisplay = (playerId === 1) ? p1NameDisplay : p2NameDisplay;

            if (board) {
                if (scoreSpan) scoreSpan.textContent = board.score;
                if (board.playerName && nameDisplay && nameDisplay.textContent !== board.playerName) {
                    nameDisplay.textContent = board.playerName;
                }

                if (!board.isGameOver && gameActiveForInput) {
                    updatePlayerStatusAndClass(playerId, "Playing", "playing");
                } else if (!board.isGameOver && countdownDisplayDiv && countdownDisplayDiv.classList.contains('visible')) {
                    updatePlayerStatusAndClass(playerId, "Ready", "waiting");
                } else if (!board.isGameOver) {
                    updatePlayerStatusAndClass(playerId, "Waiting", "waiting");
                }
            } else {
                if (scoreSpan) scoreSpan.textContent = '0';
                updatePlayerStatusAndClass(playerId, "Waiting", "waiting");
                if (nameDisplay) nameDisplay.textContent = `Player ${playerId}`;
                const CtxToClear = playerId === 1 ? ctx1 : ctx2;
                if(CtxToClear) clearCanvas(CtxToClear);
            }
        });
    });

    socket.on('gameOver', (data) => {
        console.log('Socket.IO: Game Over!', data);
        gameActiveForInput = false;
        if (countdownDisplayDiv) countdownDisplayDiv.classList.remove('visible');
        let message = "Game Over! ";

        const winnerServerPlayerId = data.winnerId;
        let winnerDisplayName = "Unknown";

        if (winnerServerPlayerId !== 0 && currentBoardsState && currentBoardsState[winnerServerPlayerId]) {
            winnerDisplayName = currentBoardsState[winnerServerPlayerId].playerName;
        } else if (winnerServerPlayerId === 0) {
            winnerDisplayName = "Draw";
        }

        const loserId = winnerServerPlayerId === 1 ? 2 : (winnerServerPlayerId === 2 ? 1 : null);

        if (data.reason === 'opponentLeft') {
            message = `${winnerDisplayName} wins! (Opponent disconnected)`;
            updatePlayerStatusAndClass(winnerServerPlayerId, "Winner!", "winner");
            if (loserId) updatePlayerStatusAndClass(loserId, "Disconnected", "disconnected");
        } else if (winnerServerPlayerId === 0) {
            message += "It's a draw!";
            updatePlayerStatusAndClass(1, "Draw", "draw");
            updatePlayerStatusAndClass(2, "Draw", "draw");
        } else {
            message += `${winnerDisplayName} wins!`;
            updatePlayerStatusAndClass(winnerServerPlayerId, "Winner!", "winner");
            if (loserId) updatePlayerStatusAndClass(loserId, "Lost", "lost");
        }
        updateStatus(message);

        if (restartButton) {
            restartButton.style.display = 'block';
            restartButton.disabled = false;
            restartButton.textContent = 'Request Restart';
        }

        if (currentBoardsState) {
            if(currentBoardsState[1]) currentBoardsState[1].isGameOver = (winnerServerPlayerId === 2 || winnerServerPlayerId === 0 || (data.reason === 'opponentLeft' && winnerServerPlayerId === 2));
            if(currentBoardsState[2]) currentBoardsState[2].isGameOver = (winnerServerPlayerId === 1 || winnerServerPlayerId === 0 || (data.reason === 'opponentLeft' && winnerServerPlayerId === 1));
            drawGame();
        }

        fetchAndShowLeaderboard();

        setTimeout(() => {
            const currentNameForThisPlayer = myPlayerId ? ( (myPlayerId === 1 && p1NameDisplay) ? p1NameDisplay.textContent : ( (myPlayerId === 2 && p2NameDisplay) ? p2NameDisplay.textContent : "" ) ) : "";
            if (!localPlayerName || (currentNameForThisPlayer && currentNameForThisPlayer.startsWith('Player'))) {
                 showPlayerNameModal(localPlayerName || (myPlayerId ? `Player ${myPlayerId}` : ''));
            }
        }, 1500);
    });

    socket.on('gameFull', (data) => { // Expects data.message
        updateStatus(data.message || 'Game is full. Please try again later.');
        if (playerNameModal && playerNameModal.classList.contains('visible')) {
            if(nameStatusMessage) nameStatusMessage.textContent = data.message || 'Game is full. Try later.';
            if(submitNameButton) {
                submitNameButton.disabled = true;
                submitNameButton.textContent = 'Game Full';
            }
        }
    });

    socket.on('restartRequestedByYou', () => {
        if (restartButton) {
            restartButton.textContent = 'Restart Requested!';
            restartButton.disabled = true;
        }
        updateStatus("Restart requested. Waiting for opponent...");
    });

    socket.on('opponentRequestedRestart', () => {
        updateStatus('Opponent wants to restart! Click "Request Restart" to begin.', true);
        if(restartButton) restartButton.disabled = false;
    });

    socket.on('allPlayersReadyForRestart', () => {
        updateStatus('Both players ready! New game starting soon...');
        if (restartButton) restartButton.style.display = 'none';
        if (countdownDisplayDiv) countdownDisplayDiv.classList.remove('visible');
    });
} // End of setupSocketEventHandlers


// --- Drawing Functions ---
function updatePlayerNameDisplays(playerIdToUpdate, name) { // Helper function for name display
    const nameDisplaySpan = (playerIdToUpdate === 1) ? p1NameDisplay : p2NameDisplay;
    if (nameDisplaySpan) {
        nameDisplaySpan.textContent = name;
    }
}

function drawGame() {
    if (!currentBoardsState || !canvasWidth || !canvasHeight) return;
    if (ctx1) {
        if (currentBoardsState[1]) drawBoard(1, currentBoardsState[1], ctx1);
        else clearCanvas(ctx1);
    }
    if (ctx2) {
        if (currentBoardsState[2]) drawBoard(2, currentBoardsState[2], ctx2);
        else clearCanvas(ctx2);
    }
}

function drawBoard(playerId, boardState, context) {
    if (!context || !boardState) return;
    clearCanvas(context);

    if (boardState.food) {
        context.fillStyle = 'red';
        context.fillRect(boardState.food.x * cellSize, boardState.food.y * cellSize, cellSize, cellSize);
    }

    if (boardState.debuffs) {
        context.fillStyle = 'purple';
        boardState.debuffs.forEach(debuff => {
            context.fillRect(debuff.x * cellSize + cellSize * 0.15, debuff.y * cellSize + cellSize * 0.15, cellSize * 0.7, cellSize * 0.7);
        });
    }

    if (boardState.snake) {
        context.fillStyle = boardState.color || (playerId === 1 ? 'green' : 'blue');
        context.strokeStyle = '#111';
        context.lineWidth = 1;
        boardState.snake.forEach((segment, index) => {
            context.fillRect(segment.x * cellSize, segment.y * cellSize, cellSize, cellSize);
            context.strokeRect(segment.x * cellSize, segment.y * cellSize, cellSize, cellSize);
            if (index === 0 && boardState.direction) {
                context.fillStyle = '#FFF';
                let eyeX = segment.x * cellSize;
                let eyeY = segment.y * cellSize;
                const eyeSize = Math.max(1, Math.floor(cellSize / 5)); // Ensure eyeSize is at least 1

                switch(boardState.direction.toUpperCase()) { // Use toUpperCase for safety
                    case 'UP':
                        eyeX += cellSize / 2 - eyeSize / 2;
                        eyeY += cellSize / 4 - eyeSize / 2;
                        break;
                    case 'DOWN':
                        eyeX += cellSize / 2 - eyeSize / 2;
                        eyeY += cellSize * 0.75 - eyeSize / 2;
                        break;
                    case 'LEFT':
                        eyeX += cellSize / 4 - eyeSize / 2;
                        eyeY += cellSize / 2 - eyeSize / 2;
                        break;
                    case 'RIGHT':
                        eyeX += cellSize * 0.75 - eyeSize / 2;
                        eyeY += cellSize / 2 - eyeSize / 2;
                        break;
                }
                context.fillRect(eyeX, eyeY, eyeSize, eyeSize);
                context.fillStyle = boardState.color || (playerId === 1 ? 'green' : 'blue'); // Reset fillStyle
            }
        });
    }

    if (boardState.isGameOver) {
        context.fillStyle = 'rgba(26, 26, 46, 0.75)'; // Dark overlay
        context.fillRect(0, 0, canvasWidth, canvasHeight);
        context.fillStyle = '#e94560'; // Accent text color
        const bodyFont = getComputedStyle(document.body).fontFamily.split(',')[0].trim() || 'sans-serif';
        context.font = `bold ${Math.max(24, Math.floor(cellSize * 1.5))}px ${bodyFont}`;
        context.textAlign = 'center';
        context.shadowColor = 'black'; context.shadowBlur = 5;
        context.fillText('GAME OVER', canvasWidth / 2, canvasHeight / 2);
        context.shadowBlur = 0;
    }
}

// --- Keyboard Input Handler ---
// --- Keyboard Input Handler ---
function handleKeyPress(event) {
    console.log(`Key Press: ${event.key}, gameActiveForInput: ${gameActiveForInput}, myPlayerId: ${myPlayerId}, boardExists: ${!!(currentBoardsState && currentBoardsState[myPlayerId])}, isGameOver: ${currentBoardsState && currentBoardsState[myPlayerId] ? currentBoardsState[myPlayerId].isGameOver : 'N/A'}`)
    // Check if input should be processed:
    // 1. Is the game active for input? (e.g., not in countdown, not game over)
    // 2. Does the client have a player ID?
    // 3. Is there a current board state for this player?
    // 4. Is this player's game NOT over?
    if (!gameActiveForInput || !myPlayerId || !currentBoardsState || !currentBoardsState[myPlayerId] || currentBoardsState[myPlayerId].isGameOver) {
        // Optional: Log why input is being ignored, can be helpful for debugging
        // console.log("Key press ignored. Conditions:", {
        //     gameActiveForInput,
        //     myPlayerId,
        //     hasBoardState: !!(currentBoardsState && currentBoardsState[myPlayerId]),
        //     isGameOver: currentBoardsState && currentBoardsState[myPlayerId] ? currentBoardsState[myPlayerId].isGameOver : 'N/A'
        // });
        return;
    }

    let direction = null;
    // Use toUpperCase() for matching the event.key, but assign the lowercase string for the server
    switch (event.key.toUpperCase()) {
        case 'W':
        case 'ARROWUP':
            direction = 'up'; // Changed to lowercase
            break;
        case 'S':
        case 'ARROWDOWN':
            direction = 'down'; // Changed to lowercase
            break;
        case 'A':
        case 'ARROWLEFT':
            direction = 'left'; // Changed to lowercase
            break;
        case 'D':
        case 'ARROWRIGHT':
            direction = 'right'; // Changed to lowercase
            break;
        default:
            // Not a movement key we care about
            return;
    }

    if (direction) {
        // console.log(`Client: Emitting directionChange '${direction}' for player ${myPlayerId}`); // For debugging
        socket.emit('directionChange', direction);
    }
}