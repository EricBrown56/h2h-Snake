// game.js
const socket = io();

// --- DOM Elements ---
let canvas1, ctx1, canvas2, ctx2;
let statusDiv, score1Span, score2Span, p1StatusSpan, p2StatusSpan, youP1Span, youP2Span;
let countdownDisplayDiv, restartButton;
let playerNameModal, playerNameInput, submitNameButton, playAiButton, nameStatusMessage; // Added playAiButton
let leaderboardList, refreshLeaderboardButton; // Leaderboard is now a sidebar
let p1NameDisplay, p2NameDisplay;
let gameAreaDiv; // Main game area div
let soundToggleMuteButton; // Sound toggle button

// --- Client Game State ---
let myPlayerId = null;
let gridSize = null, cellSize = 20, canvasWidth = null, canvasHeight = null;
let currentBoardsState = null;
let gameActiveForInput = false;
let localPlayerName = null; // Store the player's chosen name locally, confirmed by server
let sounds = {
    eatFood: new Audio('/audio/eat_food.mp3'),
    gameOver: new Audio('/audio/game_over.mp3'),
    click: new Audio('/audio/click.mp3'),
    countdown: new Audio('/audio/count.mp3'),
    debuff: new Audio('/audio/debuff_pickup.mp3'),
    go: new Audio('/audio/go.mp3'),
    shrink: new Audio('/audio/snake_shrink.mp3'),
    wallHit: new Audio('/audio/wall_hit.mp3'),
    backgroundMusic: new Audio('/audio/background_music.mp3')

    // Add more sounds as needed
};

let isMuted = false; // Track if sounds are muted
const SOUND_VOLUME = 0.5; // Set a default volume for sounds
const MUSIC_VOLUME = 0.2; // Set a default volume for background music
// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    // Get canvas elements and contexts
    canvas1 = document.getElementById('gameCanvas1');
    if (canvas1) ctx1 = canvas1.getContext('2d'); else console.error("Canvas1 not found");
    canvas2 = document.getElementById('gameCanvas2');
    if (canvas2) ctx2 = canvas2.getContext('2d'); else console.error("Canvas2 not found");
    gameAreaDiv = document.getElementById('gameArea'); 
    soundToggleMuteButton = document.getElementById('soundToggleMuteButton');

    // Load sounds 
    loadSounds(); 

    if (soundToggleMuteButton) {
        soundToggleMuteButton.addEventListener('click', toggleMuteAllSounds); 
        updateMuteButtonVisuals(); 
    }  
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
    playAiButton = document.getElementById('playAiButton'); // Get the new AI button
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

    if (playAiButton) {
        playAiButton.addEventListener('click', handlePlayAiRequest);
    } else {
        console.error("Play AI Button not found!");
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

// --- Sound Functions ---
function loadSounds() { 
    console.log("Loading sounds..."); 
    sounds.eatFood = new Audio('/audio/eat_food.mp3');
    sounds.gameOver = new Audio('/audio/game_over.mp3');
    sounds.click = new Audio('/audio/click.mp3');
    sounds.countdown = new Audio('/audio/count.mp3');
    sounds.debuff = new Audio('/audio/debuff_pickup.mp3');
    sounds.go = new Audio('/audio/go.mp3');
    sounds.shrink = new Audio('/audio/snake_shrink.mp3');
    sounds.wallHit = new Audio('/audio/wall_hit.mp3');

    sounds.backgroundMusic = new Audio('/audio/background_music.mp3');
    sounds.backgroundMusic.loop = true; // Loop the background music

    // Set initial volumes
    for (const key in sounds) { 
        if (key.toLowerCase().includes('music')) {
            sounds[key].volume = MUSIC_VOLUME; 
        } else {
            sounds[key].volume = SOUND_VOLUME; 
        }
    }
    console.log("Sounds loaded.");
}

function playSound(soundName) { 
    if (isMuted || sounds[soundName]) return; // Don't play if muted or sound not found
    if (sounds[soundName].paused || sounds[soundName].ended) {
        sounds[soundName].currentTime = 0; // Reset to start
        console.log(`Sound: ${soundName}, Paused: ${sounds[soundName].paused}, 
            Ended: ${sounds[soundName].ended}, currentTime: ${sounds[soundName].currentTime}, src: ${sounds[soundName].src}`);
        sounds[soundName].play().catch(error => console.warn(`Error playing sound ${soundName}:`, error));
    } else {
        sounds[soundName].currentTime = 0; // Reset to start
        console.log(`Sound: ${soundName}, Paused: ${sounds[soundName].paused}, 
            Ended: ${sounds[soundName].ended}, currentTime: ${sounds[soundName].currentTime}, src: ${sounds[soundName].src}`);
        sounds[soundName].play().catch(error => console.warn(`Error playing sound ${soundName}:`, error));
    }
} 

function playMusic(musicName) {
    if (isMuted || !sounds[musicName]) return; // Don't play if muted or sound not found
    if (sounds[musicName].paused) {
        sounds[musicName].currentTime = 0; // Reset to start
        sounds[musicName].play().catch(error => console.warn(`Error playing music ${musicName}:`, error));
    }
}

function stopMusic(musicName) {
    if (sounds[musicName]) {
        sounds[musicName].pause();
        sounds[musicName].currentTime = 0; // Reset to start
    }
}

function stopAllSoundsAndMusic() {
    for (const key in sounds) {
        if (sounds[key]) {
            sounds[key].pause();
            sounds[key].currentTime = 0; // Reset to start
        }
    }
}

function toggleMuteAllSounds() {
    isMuted = !isMuted; // Toggle mute state
    if (isMuted) {
        stopAllSoundsAndMusic(); // Stop all sounds and music
    } else {
        playMusic('backgroundMusic'); // Play background music if unmuted
    }
    console.log("Sound muted:", isMuted);
    updateMuteButtonVisuals();
}

function updateMuteButtonVisuals() {
    if (soundToggleMuteButton) {
        soundToggleMuteButton.textContent = isMuted ? 'Unmute Sounds' : 'Mute Sounds';
    }
}

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
        if (playAiButton) { // Also reset AI button when modal is shown
            playAiButton.disabled = false;
            playAiButton.textContent = 'Play Solo vs AI';
        }
        playerNameModal.classList.add('visible');
        if (playerNameInput) playerNameInput.focus();
        console.log("UI: Showing Player Name Modal");
    }
}

function handleJoinGameAttempt() {
    console.log('Socket connected:', socket.connected); // Added for debugging
    if (!playerNameInput || !nameStatusMessage || !submitNameButton) return;

    const name = playerNameInput.value.trim();
    if (name.length >= 2 && name.length <= 15) {
        if (socket && socket.connected) {
            console.log("Client: Attempting to join with name -", name);
            playSound('click'); // Play sound on successful validation and connection
            socket.emit('joinGame', { name: name });
            nameStatusMessage.textContent = "Attempting to join...";
            nameStatusMessage.className = 'name-status';
            playerNameInput.disabled = true;
            submitNameButton.disabled = true;
            submitNameButton.textContent = 'Joining...';
            if (playAiButton) {
                playAiButton.disabled = true;
                playAiButton.textContent = 'Requesting...'; // Or a consistent "Joining..."
            }
        } else {
            nameStatusMessage.textContent = 'Not connected to server. Please wait or refresh.';
            nameStatusMessage.className = 'name-status error';
        }
    } else {
        nameStatusMessage.textContent = 'Name must be 2-15 characters.';
        nameStatusMessage.className = 'name-status error';
    }
}

function handlePlayAiRequest() {
    console.log('Socket connected:', socket.connected); // Added for debugging
    if (!playerNameInput || !nameStatusMessage || !submitNameButton || !playAiButton) return;

    const name = playerNameInput.value.trim();
    if (name.length < 2 || name.length > 15) {
        nameStatusMessage.textContent = 'Name must be 2-15 characters.';
        nameStatusMessage.className = 'name-status error';
        return; // Exit if name is invalid
    }

    if (socket && socket.connected) {
        console.log("Client: Attempting to start AI game with name -", name);
        playSound('click'); // Play sound on successful validation and connection
        socket.emit('requestAiGame', { name: name });
        nameStatusMessage.textContent = "Requesting AI game...";
        nameStatusMessage.className = 'name-status';
        playerNameInput.disabled = true;
        submitNameButton.disabled = true;
        playAiButton.disabled = true;
        submitNameButton.textContent = 'Requesting...';
        playAiButton.textContent = 'Requesting...';
    } else {
        nameStatusMessage.textContent = 'Not connected to server. Please wait or refresh.';
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
        if (playerNameModal && !playerNameModal.classList.contains('visible') && !myPlayerId) { // If modal not visible and no player ID
            showPlayerNameModal(localPlayerName || ''); // Pass localPlayerName as default
            updateStatus('Connected. Enter your name to join.', true);
        } else if (!myPlayerId) { // If no player ID (modal might be visible)
            updateStatus('Connected. Enter your name to join.', true);
             if (playerNameInput && localPlayerName) playerNameInput.value = localPlayerName; // Pre-fill if modal shows
        } else { // Has myPlayerId - was likely in a game
            updateStatus('Reconnected to server. Attempting to rejoin...');
            // Attempt to rejoin automatically if we have the necessary info
            if (localPlayerName) {
                console.log("Client: Reconnecting, attempting to rejoin with name:", localPlayerName);
                socket.emit('joinGame', { name: localPlayerName, rejoining: true /* you might add old socket.id or playerID if server uses it */ });
            } else {
                // If localPlayerName was lost, might need to show modal again
                showPlayerNameModal();
                updateStatus('Reconnected. Please re-enter your name to join.', true);
            }
        }
    });

    socket.on('disconnect', (reason) => {
        console.log('Socket.IO: Disconnected -', reason);
        updateStatus('Disconnected. Attempting to reconnect...'); // Changed message
        // myPlayerId = null; // Keep myPlayerId for rejoin attempt on 'connect'
        gameActiveForInput = false;
        updatePlayerStatusAndClass(1, "Offline", "disconnected");
        updatePlayerStatusAndClass(2, "Offline", "disconnected");
        // Don't reset player names immediately, they might be useful for rejoin
        // if (p1NameDisplay) p1NameDisplay.textContent = "Player 1";
        // if (p2NameDisplay) p2NameDisplay.textContent = "Player 2";
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

        stopAllSoundsAndMusic(); // Stop all sounds on init

        [canvas1, canvas2].forEach(c => { if (c) { c.width = canvasWidth; c.height = canvasHeight; } });

        if (playerNameModal) playerNameModal.classList.remove('visible');
        
        // Re-enable buttons in case they were disabled and player is now successfully in game
        // (e.g. after a disconnect and reconnect, or game end leading to new game)
        // This is more of a fallback; showPlayerNameModal should handle reset if modal is shown.
        // If modal is NOT shown (e.g. successful rejoin), these might not be needed here
        // but doesn't hurt to ensure they are enabled if player is 'init'.
        if (submitNameButton) {
            submitNameButton.disabled = false;
            submitNameButton.textContent = 'Join Game';
        }
        if (playAiButton) {
            playAiButton.disabled = false;
            playAiButton.textContent = 'Play Solo vs AI';
        }


        updateStatus(`You are ${localPlayerName} (Player ${myPlayerId}). Waiting...`, true);
        if (youP1Span) youP1Span.style.display = (myPlayerId === 1) ? 'inline' : 'none';
        if (youP2Span) youP2Span.style.display = (myPlayerId === 2) ? 'inline' : 'none';
        gameActiveForInput = false;
        if (restartButton) restartButton.style.display = 'none';
        if (countdownDisplayDiv) countdownDisplayDiv.classList.remove('visible');

        // For 'init', the player themselves is never an AI
        updatePlayerNameDisplays(myPlayerId, localPlayerName, false); 

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
        if (playAiButton) { // Also re-enable AI button on name rejection
            playAiButton.disabled = false;
            playAiButton.textContent = 'Play Solo vs AI';
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
            if (playAiButton) { // Also disable AI button if game is full
                playAiButton.disabled = true;
                // playAiButton.textContent = 'Game Full'; // Optional text change
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
        if (typeof count === 'number' && count > 0) {
            updateStatus(`Game starting in ${count}...`);
            playSound('count'); // Play tick sound for numbers 3, 2, 1
        } else if (count === 'GO!') {
            updateStatus('GO!');
            playSound('go');            // Play "GO!" sound
            playMusic('backgroundMusic'); // Start gameplay music
            gameActiveForInput = true;  // Game is now active for input
        }
    });

    socket.on('opponentNameUpdate', (data) => {
        console.log("Socket.IO: Opponent name update - ", data);
        if (data && data.playerId !== myPlayerId) {
            // Use the isAi flag from the data, default to false if not provided
            updatePlayerNameDisplays(data.playerId, data.name, !!data.isAi);
        }
    });

    socket.on('gameState', (boardsData) => {
        if (!myPlayerId) {
            console.log("Socket.IO: Received gameState but client not initialized. Ignoring.");
            return;
        }
        console.log("Socket.IO: Received game state:", boardsData);
        currentBoardsState = boardsData;

        if (myPlayerId && currentBoardsState && currentBoardsState[myPlayerId] && boardsData && boardsData[myPlayerId]) {
            const oldPlayerBoard = currentBoardsState[myPlayerId];
            const newPlayerBoard = boardsData[myPlayerId];

            // Food eaten sound
            if (newPlayerBoard.score > oldPlayerBoard.score && newPlayerBoard.snake.length >= oldPlayerBoard.snake.length) {
                playSound('eatFood');
            }
            // Debuff pickup sound
            if (oldPlayerBoard.debuffs && newPlayerBoard.debuffs && newPlayerBoard.debuffs.length < oldPlayerBoard.debuffs.length) {
                playSound('debuffPickup');
            }
        }

        currentBoardsState = boardsData;

        drawGame();

        [1, 2].forEach(playerId => {
            const board = currentBoardsState[playerId];
            const scoreSpan = (playerId === 1) ? score1Span : score2Span;
            const nameDisplay = (playerId === 1) ? p1NameDisplay : p2NameDisplay;

            const board = currentBoardsState[playerId]; // Use currentBoardsState which should now have isAi
            const scoreSpan = (playerId === 1) ? score1Span : score2Span;
            // const nameDisplay = (playerId === 1) ? p1NameDisplay : p2NameDisplay; // updatePlayerNameDisplays handles this

            if (board) {
                if (scoreSpan) scoreSpan.textContent = board.score;
                // Update name display using the helper function to ensure "(AI)" is appended if needed
                // Only update if the name or AI status might have changed.
                // The nameDisplay.textContent check inside updatePlayerNameDisplays will prevent redundant DOM updates.
                updatePlayerNameDisplays(playerId, board.playerName, board.isAi);

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
            const winnerBoard = currentBoardsState[winnerServerPlayerId];
            winnerDisplayName = winnerBoard.playerName + (winnerBoard.isAi ? " (AI)" : "");
        } else if (winnerServerPlayerId === 0) {
            winnerDisplayName = "Draw";
        }

        const loserId = winnerServerPlayerId === 1 ? 2 : (winnerServerPlayerId === 2 ? 1 : null);
        let loserDisplayName = "";
        if (loserId && currentBoardsState && currentBoardsState[loserId]) {
            const loserBoard = currentBoardsState[loserId];
            loserDisplayName = loserBoard.playerName + (loserBoard.isAi ? " (AI)" : "");
        }


        if (data.reason === 'opponentLeft') {
            // Message construction for opponent left needs to be careful if the opponent was AI (though AI shouldn't "leave")
            // Server-side, if AI is P2 and P1 leaves, AI is removed, game ends.
            // If P1 leaves, P2 (human) wins.
            const opponentWhoLeftName = loserDisplayName || `Player ${loserId}`; // Fallback if name not found
            message = `${winnerDisplayName} wins! (${opponentWhoLeftName} disconnected)`;
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

        stopMusic('backgroundMusic'); // Stop background music on game over
        playSound('gameOver'); // Play game over sound
    });

    socket.on('gameFull', (data) => { // Expects data.message
        updateStatus(data.message || 'Game is full. Please try again later.');
        if (playerNameModal && playerNameModal.classList.contains('visible')) {
            if(nameStatusMessage) nameStatusMessage.textContent = data.message || 'Game is full. Try later.';
            if(submitNameButton) {
                submitNameButton.disabled = true;
                submitNameButton.textContent = 'Game Full';
            }
            if (playAiButton) { // Also disable AI button when game is full (from this specific handler)
                playAiButton.disabled = true;
                // playAiButton.textContent = 'Game Full';
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

    socket.on('playSound', (soundName) => {
        // Play sound on client side from server request
        if (sounds[soundName]) {
            playSound(soundName);
        } else {
            console.warn(`Sound ${soundName} not found on client.`);
        }
    })
} // End of setupSocketEventHandlers


// --- Drawing Functions ---
function updatePlayerNameDisplays(playerIdToUpdate, name, isAi = false) { // Helper function for name display
    const nameDisplaySpan = (playerIdToUpdate === 1) ? p1NameDisplay : p2NameDisplay;
    if (nameDisplaySpan) {
        const displayName = name + (isAi ? " (AI)" : "");
        if (nameDisplaySpan.textContent !== displayName) { // Only update if text actually changes
            nameDisplaySpan.textContent = displayName;
        }
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

// game.js (or wherever your drawBoard function is)

function drawBoard(playerId, boardState, context) {
    if (!context || !boardState) return;
    clearCanvas(context); // Assuming clearCanvas is defined and works

    const radius = cellSize / 2; // Radius for full-cell circles

    // --- Draw Food (as a circle) ---
    if (boardState.food) {
        context.fillStyle = 'red'; // Food color
        context.beginPath();
        context.arc(
            boardState.food.x * cellSize + radius, // center x
            boardState.food.y * cellSize + radius, // center y
            radius,                                // circle radius
            0,                                     // startAngle
            2 * Math.PI                            // endAngle (full circle)
        );
        context.fill();
    }

    // --- Draw Debuffs (keeping them as smaller squares for now, or change to circles if desired) ---
    if (boardState.debuffs) {
        context.fillStyle = 'purple'; // Debuff color
        boardState.debuffs.forEach(debuff => {
            // Original square debuff:
            context.fillRect(debuff.x * cellSize + cellSize * 0.15, debuff.y * cellSize + cellSize * 0.15, cellSize * 0.7, cellSize * 0.7);
            
            // If you want circular debuffs (optional):
            // const debuffRadius = (cellSize * 0.7) / 2;
            // context.beginPath();
            // context.arc(
            //     debuff.x * cellSize + radius, // center x (same as full cell for simplicity here)
            //     debuff.y * cellSize + radius, // center y
            //     debuffRadius,
            //     0,
            //     2 * Math.PI
            // );
            // context.fill();
        });
    }

    // --- Draw Snake (as circles) ---
    if (boardState.snake) {
        context.fillStyle = boardState.color || (playerId === 1 ? 'green' : 'blue'); // Snake color
        context.strokeStyle = '#111'; // Outline color for segments
        context.lineWidth = 1;         // Outline width

        boardState.snake.forEach((segment, index) => {
            // Draw segment body
            context.beginPath();
            context.arc(
                segment.x * cellSize + radius, // center x
                segment.y * cellSize + radius, // center y
                radius,                        // segment radius
                0,
                2 * Math.PI
            );
            context.fill();
            if (context.lineWidth > 0) { // Only draw stroke if lineWidth is set
                context.stroke(); // Outline for the segment
            }

            // --- Draw Eyes on the Head (as circles) ---
            if (index === 0 && boardState.direction) { // If it's the head segment
                context.fillStyle = '#FFF'; // Eye color (white)
                const eyeSize = Math.max(1, Math.floor(cellSize / 4.5)); // Radius of the eye
                let eye1X, eye1Y, eye2X, eye2Y; // Positions for two eyes

                // Calculate eye positions based on direction (more distinct two eyes look)
                // These positions are relative to the center of the head segment
                const offsetAmount = radius * 0.45; // How far from center eyes are

                switch (boardState.direction.toUpperCase()) {
                    case 'UP':
                        eye1X = segment.x * cellSize + radius - offsetAmount;
                        eye1Y = segment.y * cellSize + radius - offsetAmount * 0.5;
                        eye2X = segment.x * cellSize + radius + offsetAmount;
                        eye2Y = segment.y * cellSize + radius - offsetAmount * 0.5;
                        break;
                    case 'DOWN':
                        eye1X = segment.x * cellSize + radius - offsetAmount;
                        eye1Y = segment.y * cellSize + radius + offsetAmount * 0.5;
                        eye2X = segment.x * cellSize + radius + offsetAmount;
                        eye2Y = segment.y * cellSize + radius + offsetAmount * 0.5;
                        break;
                    case 'LEFT':
                        eye1X = segment.x * cellSize + radius - offsetAmount * 0.5;
                        eye1Y = segment.y * cellSize + radius - offsetAmount;
                        eye2X = segment.x * cellSize + radius - offsetAmount * 0.5;
                        eye2Y = segment.y * cellSize + radius + offsetAmount;
                        break;
                    case 'RIGHT':
                        eye1X = segment.x * cellSize + radius + offsetAmount * 0.5;
                        eye1Y = segment.y * cellSize + radius - offsetAmount;
                        eye2X = segment.x * cellSize + radius + offsetAmount * 0.5;
                        eye2Y = segment.y * cellSize + radius + offsetAmount;
                        break;
                    default: // Should not happen if direction is always set
                        return;
                }

                // Draw first eye
                context.beginPath();
                context.arc(eye1X, eye1Y, eyeSize, 0, 2 * Math.PI);
                context.fill();

                // Draw second eye
                context.beginPath();
                context.arc(eye2X, eye2Y, eyeSize, 0, 2 * Math.PI);
                context.fill();

                // Reset fillStyle to snake color for next segments
                context.fillStyle = boardState.color || (playerId === 1 ? 'green' : 'blue');
            }
        });
    }

    // --- Draw Game Over Overlay ---
    if (boardState.isGameOver) {
        context.fillStyle = 'rgba(26, 26, 46, 0.75)'; // Dark overlay
        context.fillRect(0, 0, canvasWidth, canvasHeight); // Assuming canvasWidth/Height are available
        context.fillStyle = '#e94560'; // Accent text color
        const bodyFont = getComputedStyle(document.body).fontFamily.split(',')[0].trim() || 'sans-serif';
        context.font = `bold ${Math.max(24, Math.floor(cellSize * 1.5))}px ${bodyFont}`;
        context.textAlign = 'center';
        context.shadowColor = 'black'; context.shadowBlur = 5;
        context.fillText('GAME OVER', canvasWidth / 2, canvasHeight / 2);
        context.shadowBlur = 0; // Reset shadow
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