// MemoryGameService.js - Complete Memory Game Implementation
const logger = require('../config/logger');
const gameService = require('./gameService');
const prisma = require('../config/database');

class MemoryGameService {
  constructor(io) {
    this.io = io;
    this.games = new Map();
    this.TURN_TIMER = 15000; // 15 seconds total for 2 cards
    this.turnTimers = new Map();
    this.countdownIntervals = new Map();
  }

  setupSocketHandlers(socket) {
    socket.on('START_MEMORY_GAME', (data) => this.startGame(data));
    socket.on('SELECT_MEMORY_CARD', (data) => this.selectCard(socket, data));
    socket.on('selectCard', (data) => this.selectCard(socket, data));
    socket.on('JOIN_MEMORY_ROOM', (data) => this.joinRoom(socket, data));
    socket.on('LEAVE_MEMORY_GAME', (data) => this.handlePlayerLeave(socket, data));
    socket.on('disconnect', () => this.handlePlayerDisconnect(socket));
  }

  async startGame({ roomId }) {
    try {
      logger.info(`Memory Game: Starting game ${roomId}`);
      
      const game = await gameService.getGameById(roomId);
      if (!game || !game.participants || game.participants.length < 2) {
        this.io.to(`game:${roomId}`).emit('MEMORY_GAME_ERROR', { 
          message: 'Not enough players to start game.' 
        });
        return;
      }

      // Initialize game board with 11 pairs (22 cards)
      const initialBoard = this.createGameBoard();
      
      // Create players array
      const players = game.participants.map((p, index) => ({
        id: p.userId,
        name: p.user?.name || `Player ${index + 1}`,
        position: index,
        score: 0
      }));

      // Initialize game state
      const gameState = {
        board: initialBoard,
        players: players,
        currentTurnIndex: 0,
        currentTurnPlayerId: players[0].id,
        selectedCards: [],
        scores: {},
        matchedPairs: 0,
        totalPairs: 11,
        status: 'playing',
        processingCards: false
      };

      // Initialize scores
      players.forEach(player => {
        gameState.scores[player.id] = 0;
      });

      // Store game instance
      this.games.set(roomId, gameState);

      // Update database
      await gameService.updateGameState(roomId, initialBoard, 0, 'PLAYING', null);

      // Emit game started
      this.io.to(`game:${roomId}`).emit('MEMORY_GAME_STARTED', {
        gameBoard: initialBoard.map(card => ({
          id: card.id,
          position: card.position,
          isFlipped: false,
          isMatched: false,
          symbol: null
        })),
        players: players,
        currentPlayer: players[0],
        scores: gameState.scores,
        totalPairs: 11,
        prizePool: game.prizePool || 0
      });

      // Emit initial turn state
      this.io.to(`game:${roomId}`).emit('MEMORY_GAME_CURRENT_TURN', {
        currentPlayer: players[0].id,
        currentPlayerName: players[0].name,
        players: players
      });

      // Start turn timer
      this.startTurnTimer(roomId);

      logger.info(`Memory Game: Game ${roomId} started successfully with ${players.length} players`);
    } catch (error) {
      logger.error(`Memory Game: Error starting game ${roomId}:`, error);
      this.io.to(`game:${roomId}`).emit('MEMORY_GAME_ERROR', { 
        message: 'Failed to start game.' 
      });
    }
  }

  createGameBoard() {
    const symbols = ['🎮', '🎯', '🎲', '🃏', '🎪', '🎨', '🎭', '💡', '⚽', '🏀', '🏈'];
    const cards = [];
    
    // Create pairs
    symbols.forEach((symbol, index) => {
      cards.push({
        id: index * 2,
        position: index * 2,
        symbol: symbol,
        isFlipped: false,
        isMatched: false
      });
      cards.push({
        id: index * 2 + 1,
        position: index * 2 + 1,
        symbol: symbol,
        isFlipped: false,
        isMatched: false
      });
    });

    // Better randomization using Fisher-Yates shuffle with multiple passes
    for (let pass = 0; pass < 3; pass++) {
      for (let i = cards.length - 1; i > 0; i--) {
        // Use crypto-quality randomness if available
        const randomValue = typeof crypto !== 'undefined' && crypto.getRandomValues 
          ? crypto.getRandomValues(new Uint32Array(1))[0] / (0xFFFFFFFF + 1)
          : Math.random();
        const j = Math.floor(randomValue * (i + 1));
        [cards[i], cards[j]] = [cards[j], cards[i]];
      }
    }

    // Additional entropy by shuffling based on timestamp
    const timeBasedSeed = Date.now() % cards.length;
    for (let i = 0; i < timeBasedSeed; i++) {
      const randomIndex1 = Math.floor(Math.random() * cards.length);
      const randomIndex2 = Math.floor(Math.random() * cards.length);
      [cards[randomIndex1], cards[randomIndex2]] = [cards[randomIndex2], cards[randomIndex1]];
    }

    // Update positions after shuffle
    cards.forEach((card, index) => {
      card.position = index;
    });

    return cards;
  }

  async selectCard(socket, data) {
    try {
      const gameId = data.gameId || data.roomId;
      const playerId = data.playerId || socket.user?.id;
      const position = parseInt(data.position);

      if (!gameId || !playerId || position === undefined || position < 0) {
        return socket.emit('MEMORY_GAME_ERROR', { 
          message: 'Invalid card selection parameters.' 
        });
      }

      const gameState = this.games.get(gameId);
      if (!gameState) {
        return socket.emit('MEMORY_GAME_ERROR', { 
          message: 'Game not found.' 
        });
      }

      // Check if it's player's turn
      if (gameState.currentTurnPlayerId !== playerId) {
        return socket.emit('MEMORY_GAME_ERROR', { 
          message: 'Not your turn.' 
        });
      }

      // Check if processing cards
      if (gameState.processingCards) {
        return socket.emit('MEMORY_GAME_ERROR', { 
          message: 'Please wait, cards are being processed.' 
        });
      }

      // Validate position
      if (position >= gameState.board.length) {
        return socket.emit('MEMORY_GAME_ERROR', { 
          message: 'Invalid card position.' 
        });
      }

      const card = gameState.board[position];
      
      // Check if card can be selected
      if (card.isFlipped || card.isMatched) {
        return socket.emit('MEMORY_GAME_ERROR', { 
          message: 'Card already revealed or matched.' 
        });
      }

      // Check if already selected 2 cards
      if (gameState.selectedCards.length >= 2) {
        return socket.emit('MEMORY_GAME_ERROR', { 
          message: 'Maximum 2 cards per turn.' 
        });
      }

      // Check if card already selected this turn
      if (gameState.selectedCards.some(selected => selected.position === position)) {
        return socket.emit('MEMORY_GAME_ERROR', { 
          message: 'Card already selected this turn.' 
        });
      }

      // Only clear timer if this is the first card selection
      if (gameState.selectedCards.length === 0) {
        this.clearTurnTimer(gameId);
      }

      // Flip card
      card.isFlipped = true;
      gameState.selectedCards.push({
        position: position,
        symbol: card.symbol,
        cardId: card.id
      });

      // Emit card opened
      this.io.to(`game:${gameId}`).emit('MEMORY_CARD_OPENED', {
        position: position,
        symbol: card.symbol,
        playerId: playerId,
        selectedCount: gameState.selectedCards.length
      });

      // If 2 cards selected, check for match
      if (gameState.selectedCards.length === 2) {
        // Clear timer now that turn is complete
        this.clearTurnTimer(gameId);
        gameState.processingCards = true;
        // Process match immediately for better responsiveness
        setTimeout(() => this.processMatch(gameId), 500);
      }
      // Don't restart timer for second card - let the original timer continue

    } catch (error) {
      logger.error(`Memory Game: Select card error:`, error);
      socket.emit('MEMORY_GAME_ERROR', { message: 'Failed to select card.' });
    }
  }

  async processMatch(gameId) {
    try {
      const gameState = this.games.get(gameId);
      if (!gameState || gameState.selectedCards.length !== 2) {
        return;
      }

      const [card1, card2] = gameState.selectedCards;
      const currentPlayer = gameState.players.find(p => p.id === gameState.currentTurnPlayerId);

      if (card1.symbol === card2.symbol) {
        // Match found!
        gameState.board[card1.position].isMatched = true;
        gameState.board[card2.position].isMatched = true;
        gameState.matchedPairs++;
        
        // Update score
        gameState.scores[gameState.currentTurnPlayerId] += 10;
        currentPlayer.score += 10;

        // Update player score in database (non-blocking)
        gameService.updatePlayerScore(gameId, gameState.currentTurnPlayerId, currentPlayer.score).catch(err => {
          logger.error('Failed to update player score:', err);
        });

        // Emit match event immediately
        this.io.to(`game:${gameId}`).emit('MEMORY_CARDS_MATCHED', {
          positions: [card1.position, card2.position],
          playerId: gameState.currentTurnPlayerId,
          playerName: currentPlayer.name,
          scores: gameState.scores,
          matchedPairs: gameState.matchedPairs
        });

        // Check if game finished
        if (gameState.matchedPairs >= gameState.totalPairs) {
          await this.endGame(gameId);
          return;
        }

        // Player gets another turn - reset immediately
        gameState.selectedCards = [];
        gameState.processingCards = false;
        this.startTurnTimer(gameId);

      } else {
        // No match - flip back immediately and change turn
        gameState.board[card1.position].isFlipped = false;
        gameState.board[card2.position].isFlipped = false;
        
        // Emit mismatch event with immediate flip back
        this.io.to(`game:${gameId}`).emit('MEMORY_CARDS_MISMATCHED', {
          positions: [card1.position, card2.position],
          symbols: [card1.symbol, card2.symbol],
          nextPlayerName: gameState.players[(gameState.currentTurnIndex + 1) % gameState.players.length].name
        });

        // Change turn immediately
        this.nextTurn(gameId);
      }

      // Update database (non-blocking)
      gameService.updateGameState(gameId, gameState.board, gameState.currentTurnIndex, 'PLAYING', null).catch(err => {
        logger.error('Failed to update game state:', err);
      });

    } catch (error) {
      logger.error(`Memory Game: Process match error:`, error);
      const gameState = this.games.get(gameId);
      if (gameState) {
        gameState.selectedCards = [];
        gameState.processingCards = false;
      }
    }
  }

  nextTurn(gameId) {
    const gameState = this.games.get(gameId);
    if (!gameState) return;

    // Move to next player
    gameState.currentTurnIndex = (gameState.currentTurnIndex + 1) % gameState.players.length;
    gameState.currentTurnPlayerId = gameState.players[gameState.currentTurnIndex].id;
    gameState.selectedCards = [];
    gameState.processingCards = false;

    const currentPlayer = gameState.players[gameState.currentTurnIndex];

    // Emit turn change
    this.io.to(`game:${gameId}`).emit('MEMORY_TURN_CHANGED', {
      currentPlayer: currentPlayer,
      currentPlayerId: currentPlayer.id,
      currentPlayerName: currentPlayer.name,
      scores: gameState.scores
    });

    // Also emit the old event name for compatibility
    this.io.to(`game:${gameId}`).emit('MEMORY_GAME_CURRENT_TURN', {
      currentPlayer: currentPlayer.id,
      currentPlayerName: currentPlayer.name,
      players: gameState.players
    });

    // Start timer for new player
    this.startTurnTimer(gameId);
  }

  startTurnTimer(gameId) {
    this.clearTurnTimer(gameId);

    const gameState = this.games.get(gameId);
    if (!gameState) return;

    const currentPlayer = gameState.players.find(p => p.id === gameState.currentTurnPlayerId);

    // Start timer
    const timer = setTimeout(() => {
      this.handleTurnTimeout(gameId);
    }, this.TURN_TIMER);

    this.turnTimers.set(gameId, timer);

    // Emit timer start
    this.io.to(`game:${gameId}`).emit('MEMORY_TURN_TIMER', {
      playerId: gameState.currentTurnPlayerId,
      playerName: currentPlayer?.name || 'Unknown',
      timeLeft: this.TURN_TIMER / 1000
    });

    // Send countdown updates
    let timeLeft = this.TURN_TIMER / 1000;
    const countdownInterval = setInterval(() => {
      timeLeft--;
      if (timeLeft > 0) {
        this.io.to(`game:${gameId}`).emit('MEMORY_TIMER_UPDATE', {
          timeLeft: timeLeft
        });
      } else {
        clearInterval(countdownInterval);
      }
    }, 1000);

    this.countdownIntervals.set(gameId, countdownInterval);
  }

  clearTurnTimer(gameId) {
    if (this.turnTimers.has(gameId)) {
      clearTimeout(this.turnTimers.get(gameId));
      this.turnTimers.delete(gameId);
    }
    if (this.countdownIntervals.has(gameId)) {
      clearInterval(this.countdownIntervals.get(gameId));
      this.countdownIntervals.delete(gameId);
    }
  }

  handleTurnTimeout(gameId) {
    const gameState = this.games.get(gameId);
    if (!gameState) return;

    const currentPlayer = gameState.players.find(p => p.id === gameState.currentTurnPlayerId);
    const nextPlayerIndex = (gameState.currentTurnIndex + 1) % gameState.players.length;
    const nextPlayer = gameState.players[nextPlayerIndex];

    // Clear any selected cards
    gameState.selectedCards.forEach(selected => {
      gameState.board[selected.position].isFlipped = false;
    });

    // Emit turn skipped event
    this.io.to(`game:${gameId}`).emit('MEMORY_TURN_SKIPPED', {
      skippedPlayer: currentPlayer?.name || 'Unknown',
      nextPlayerName: nextPlayer?.name || 'Unknown',
      reason: 'timeout'
    });

    // Move to next turn
    this.nextTurn(gameId);
  }

  async endGame(gameId) {
    try {
      const gameState = this.games.get(gameId);
      if (!gameState) return;

      this.clearTurnTimer(gameId);

      // Find winner and create leaderboard
      let winnerId = null;
      let highestScore = -1;
      
      // Create sorted leaderboard
      const leaderboard = gameState.players.map(player => ({
        id: player.id,
        name: player.name,
        score: gameState.scores[player.id] || 0
      })).sort((a, b) => b.score - a.score);

      // Determine winner
      if (leaderboard.length > 0) {
        winnerId = leaderboard[0].id;
        highestScore = leaderboard[0].score;
      }

      const winner = gameState.players.find(p => p.id === winnerId);

      // Get game info for prize pool
      const game = await gameService.getGameById(gameId);
      const prizePool = game?.prizePool || 0;

      // Update database
      await gameService.updateGameState(gameId, gameState.board, gameState.currentTurnIndex, 'FINISHED', winnerId);

      // Emit game end with complete information
      this.io.to(`game:${gameId}`).emit('MEMORY_GAME_ENDED', {
        winner: winner,
        winnerId: winnerId,
        finalScores: gameState.scores,
        players: gameState.players,
        prizePool: prizePool,
        leaderboard: leaderboard,
        totalPlayers: gameState.players.length,
        gameStats: {
          totalPairs: gameState.totalPairs,
          matchedPairs: gameState.matchedPairs,
          winnerScore: highestScore
        }
      });

      // Process winnings (non-blocking)
      gameService.processGameWinnings(gameId).catch(err => {
        logger.error('Failed to process game winnings:', err);
      });

      // Clean up
      this.games.delete(gameId);

      logger.info(`Memory Game: Game ${gameId} ended. Winner: ${winnerId} with score: ${highestScore}`);
    } catch (error) {
      logger.error(`Memory Game: End game error:`, error);
    }
  }

  async joinRoom(socket, { roomId, playerId, playerName }) {
    try {
      let gameState = this.games.get(roomId);
      
      if (!gameState) {
        const gameFromDb = await gameService.getGameById(roomId);
        if (!gameFromDb) {
          return socket.emit('MEMORY_GAME_ERROR', { message: 'Game not found.' });
        }

        // Recreate game state from database
        const players = gameFromDb.participants.map((p, index) => ({
          id: p.userId,
          name: p.user?.name || `Player ${index + 1}`,
          position: index,
          score: 0
        }));

        gameState = {
          board: gameFromDb.gameData || [],
          players: players,
          currentTurnIndex: gameFromDb.currentTurn || 0,
          currentTurnPlayerId: players[gameFromDb.currentTurn || 0]?.id,
          selectedCards: [],
          scores: {},
          matchedPairs: 0,
          totalPairs: 11,
          status: gameFromDb.status,
          processingCards: false
        };

        // Initialize scores
        players.forEach(player => {
          gameState.scores[player.id] = 0;
        });

        this.games.set(roomId, gameState);
      }

      socket.join(`game:${roomId}`);

      // Get game info for prize pool
      const gameFromDb = await gameService.getGameById(roomId);
      
      // Send current state to joining player
      socket.emit('MEMORY_CURRENT_STATE', {
        gameBoard: gameState.board.map(card => ({
          id: card.id,
          position: card.position,
          isFlipped: card.isFlipped,
          isMatched: card.isMatched,
          symbol: card.isFlipped || card.isMatched ? card.symbol : null
        })),
        players: gameState.players,
        currentPlayer: gameState.players.find(p => p.id === gameState.currentTurnPlayerId),
        scores: gameState.scores,
        matchedPairs: gameState.matchedPairs,
        totalPairs: gameState.totalPairs,
        status: gameState.status,
        prizePool: gameFromDb?.prizePool || 0,
        selectedCards: gameState.selectedCards || [],
        processingCards: gameState.processingCards || false
      });

      // If player is reconnecting and it's their turn, restart timer
      if (gameState.currentTurnPlayerId === playerId && gameState.status === 'playing') {
        // Only restart timer if no cards are selected or processing
        if (gameState.selectedCards.length === 0 && !gameState.processingCards) {
          this.startTurnTimer(roomId);
        }
      }

      logger.info(`Memory Game: Player ${playerName} joined room ${roomId}`);
    } catch (error) {
      logger.error(`Memory Game: Join room error:`, error);
      socket.emit('MEMORY_GAME_ERROR', { message: 'Failed to join room.' });
    }
  }

  async handlePlayerLeave(socket, { roomId, playerId }) {
    try {
      const gameState = this.games.get(roomId);
      if (!gameState) return;

      await this.handlePlayerExit(roomId, playerId, 'left');
    } catch (error) {
      logger.error(`Memory Game: Player leave error:`, error);
    }
  }

  async handlePlayerDisconnect(socket) {
    try {
      // Find all games this socket is part of
      const playerId = socket.user?.id;
      if (!playerId) return;

      for (const [roomId, gameState] of this.games.entries()) {
        const player = gameState.players.find(p => p.id === playerId);
        if (player) {
          await this.handlePlayerExit(roomId, playerId, 'disconnected');
        }
      }
    } catch (error) {
      logger.error(`Memory Game: Player disconnect error:`, error);
    }
  }

  async handlePlayerExit(roomId, playerId, reason) {
    try {
      const gameState = this.games.get(roomId);
      if (!gameState || gameState.status !== 'playing') return;

      const leavingPlayer = gameState.players.find(p => p.id === playerId);
      if (!leavingPlayer) return;

      // Clear timers
      this.clearTurnTimer(roomId);

      // If it's a 2-player game, automatically declare the other player as winner
      if (gameState.players.length === 2) {
        const remainingPlayer = gameState.players.find(p => p.id !== playerId);
        
        if (remainingPlayer) {
          // Get game info for prize pool
          const game = await gameService.getGameById(roomId);
          const prizePool = game?.prizePool || 0;

          // Update database with winner
          await gameService.updateGameState(roomId, gameState.board, gameState.currentTurnIndex, 'FINISHED', remainingPlayer.id);

          // Create leaderboard with remaining player as winner
          const leaderboard = [
            {
              id: remainingPlayer.id,
              name: remainingPlayer.name,
              score: gameState.scores[remainingPlayer.id] || 0
            },
            {
              id: playerId,
              name: leavingPlayer.name,
              score: gameState.scores[playerId] || 0
            }
          ];

          // Emit game end with winner
          this.io.to(`game:${roomId}`).emit('MEMORY_GAME_ENDED', {
            winner: remainingPlayer,
            winnerId: remainingPlayer.id,
            finalScores: gameState.scores,
            players: gameState.players,
            prizePool: prizePool,
            leaderboard: leaderboard,
            totalPlayers: gameState.players.length,
            gameStats: {
              totalPairs: gameState.totalPairs,
              matchedPairs: gameState.matchedPairs,
              winnerScore: gameState.scores[remainingPlayer.id] || 0
            },
            reason: `${leavingPlayer.name} ${reason} the game`
          });

          // Process winnings
          gameService.processGameWinnings(roomId).catch(err => {
            logger.error('Failed to process game winnings:', err);
          });

          // Clean up
          this.games.delete(roomId);

          logger.info(`Memory Game: Game ${roomId} ended due to player ${reason}. Winner: ${remainingPlayer.id}`);
        }
      } else {
        // For games with more than 2 players, just remove the player and continue
        gameState.players = gameState.players.filter(p => p.id !== playerId);
        delete gameState.scores[playerId];

        // If it was the leaving player's turn, move to next player
        if (gameState.currentTurnPlayerId === playerId) {
          this.nextTurn(roomId);
        }

        // Notify remaining players
        this.io.to(`game:${roomId}`).emit('MEMORY_PLAYER_LEFT', {
          playerId: playerId,
          playerName: leavingPlayer.name,
          reason: reason,
          remainingPlayers: gameState.players
        });
      }
    } catch (error) {
      logger.error(`Memory Game: Handle player exit error:`, error);
    }
  }
}

module.exports = MemoryGameService;