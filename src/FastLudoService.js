// FastLudoService.js - Fast Ludo game implementation with timer and points
const logger = require('./config/logger');

class FastLudoService {
  constructor(io) {
    this.io = io;
    this.games = new Map();
    this.BOARD_SIZE = 52;
    this.HOME_POSITIONS = {
      red: 0,
      blue: 13,
      green: 26,
      yellow: 39
    };
    this.COLORS = ['red', 'blue', 'green', 'yellow'];
    this.POINTS = {
      MOVE: 1,
      KILL: 5,
      FINISH_TOKEN: 10,
      KILLED_PENALTY: -3
    };
  }

  setupSocketHandlers(socket) {
    socket.on('START_FAST_LUDO', (data) => this.startGame(socket, data));
    socket.on('ROLL_FAST_LUDO_DICE', (data) => this.rollDice(socket, data));
    socket.on('MOVE_FAST_LUDO_PIECE', (data) => this.movePiece(socket, data));
    socket.on('JOIN_FAST_LUDO_ROOM', (data) => this.joinRoom(socket, data));
  }

  initializeGameBoard(maxPlayers) {
    const board = {};
    const colors = this.COLORS.slice(0, maxPlayers);
    
    colors.forEach((color, index) => {
      board[color] = {
        pieces: [
          { id: 0, position: 'board', boardPosition: this.HOME_POSITIONS[color], isInSafeZone: false },
          { id: 1, position: 'board', boardPosition: this.HOME_POSITIONS[color], isInSafeZone: false },
          { id: 2, position: 'board', boardPosition: this.HOME_POSITIONS[color], isInSafeZone: false },
          { id: 3, position: 'board', boardPosition: this.HOME_POSITIONS[color], isInSafeZone: false }
        ],
        piecesFinished: 0,
        score: 0,
        playerId: null
      };
    });
    
    return board;
  }

  startGame(socket, { gameId, playerId }) {
    const game = this.games.get(gameId);
    if (!game || game.players.length < 2) return;

    const gameBoard = this.initializeGameBoard(game.players.length);
    
    // Assign colors to players
    game.players.forEach((player, index) => {
      const color = this.COLORS[index];
      gameBoard[color].playerId = player.id;
    });

    const timerDuration = game.players.length === 2 ? 300000 : 600000; // 5 or 10 minutes

    game.gameState = {
      board: gameBoard,
      currentTurn: 0,
      diceValue: null,
      diceRolled: false,
      status: 'playing',
      startTime: Date.now(),
      timerDuration: timerDuration,
      endTime: Date.now() + timerDuration
    };

    this.io.to(gameId).emit('FAST_LUDO_GAME_STARTED', {
      gameBoard: gameBoard,
      players: game.players,
      timerDuration: timerDuration,
      endTime: game.gameState.endTime
    });

    this.io.to(gameId).emit('FAST_LUDO_TURN_UPDATE', {
      currentPlayer: game.players[0].id,
      currentTurn: 0
    });

    // Start game timer
    this.startGameTimer(gameId);

    logger.info(`Fast Ludo game ${gameId} started with ${game.players.length} players`);
  }

  startGameTimer(gameId) {
    const game = this.games.get(gameId);
    if (!game || !game.gameState) return;

    const timer = setTimeout(() => {
      this.endGameByTimer(gameId);
    }, game.gameState.timerDuration);

    game.timer = timer;
  }

  rollDice(socket, { gameId, playerId }) {
    const game = this.games.get(gameId);
    if (!game || !game.gameState || game.gameState.status !== 'playing') return;

    const currentPlayer = game.players[game.gameState.currentTurn];
    if (currentPlayer.id !== playerId) return;

    if (game.gameState.diceRolled) return;

    const diceValue = Math.floor(Math.random() * 6) + 1;
    game.gameState.diceValue = diceValue;
    game.gameState.diceRolled = true;

    this.io.to(gameId).emit('FAST_LUDO_DICE_ROLLED', {
      playerId,
      diceValue,
      currentTurn: game.gameState.currentTurn
    });

    logger.info(`Fast Ludo: Player ${playerId} rolled ${diceValue} in game ${gameId}`);
  }

  movePiece(socket, { gameId, playerId, pieceId }) {
    const game = this.games.get(gameId);
    if (!game || !game.gameState || game.gameState.status !== 'playing') return;

    const currentPlayer = game.players[game.gameState.currentTurn];
    if (currentPlayer.id !== playerId) return;

    if (!game.gameState.diceRolled || !game.gameState.diceValue) return;

    const playerColor = this.getPlayerColor(game.gameState.board, playerId);
    if (!playerColor) return;

    const piece = game.gameState.board[playerColor].pieces[pieceId];
    if (!piece) return;

    const moveResult = this.validateAndExecuteMove(piece, game.gameState.diceValue, playerColor, game.gameState.board, playerId);
    
    if (!moveResult.success) {
      socket.emit('FAST_LUDO_ERROR', { message: moveResult.message });
      return;
    }

    // Update board
    game.gameState.board[playerColor] = moveResult.updatedPlayerBoard;
    
    // Update scores for all affected players
    if (moveResult.killedPlayers) {
      moveResult.killedPlayers.forEach(killedPlayerId => {
        const killedColor = this.getPlayerColor(game.gameState.board, killedPlayerId);
        if (killedColor) {
          game.gameState.board[killedColor].score += this.POINTS.KILLED_PENALTY;
        }
      });
    }

    // Reset dice
    game.gameState.diceRolled = false;
    game.gameState.diceValue = null;

    // Check if all tokens are finished (early win condition)
    let winner = null;
    if (game.gameState.board[playerColor].piecesFinished === 4) {
      winner = playerId;
      this.endGame(gameId, winner);
      return;
    }

    // Switch turns (no extra turn for 6 in fast ludo)
    game.gameState.currentTurn = (game.gameState.currentTurn + 1) % game.players.length;

    // Broadcast move result
    this.io.to(gameId).emit('FAST_LUDO_PIECE_MOVED', {
      playerId,
      pieceId,
      gameBoard: game.gameState.board,
      scores: this.getScores(game.gameState.board),
      nextTurn: game.gameState.currentTurn,
      nextPlayer: game.players[game.gameState.currentTurn].id
    });

    logger.info(`Fast Ludo: Player ${playerId} moved piece ${pieceId} in game ${gameId}`);
  }

  validateAndExecuteMove(piece, diceValue, playerColor, board, playerId) {
    const playerBoard = { ...board[playerColor] };
    const updatedPiece = { ...piece };
    let killedPlayers = [];

    if (piece.position === 'board') {
      const newPosition = (piece.boardPosition + diceValue) % this.BOARD_SIZE;
      
      // Check if piece reaches home stretch
      const homeStretchStart = (this.HOME_POSITIONS[playerColor] + 51) % this.BOARD_SIZE;
      
      if (this.isEnteringHomeStretch(piece.boardPosition, newPosition, homeStretchStart)) {
        const homeSteps = diceValue - (homeStretchStart - piece.boardPosition);
        if (homeSteps <= 6) {
          if (homeSteps === 6) {
            updatedPiece.position = 'finished';
            updatedPiece.boardPosition = -1;
            playerBoard.piecesFinished++;
            playerBoard.score += this.POINTS.FINISH_TOKEN;
          } else {
            updatedPiece.position = 'homeStretch';
            updatedPiece.boardPosition = homeSteps;
          }
        } else {
          return { success: false, message: 'Cannot overshoot home' };
        }
      } else {
        updatedPiece.boardPosition = newPosition;
        playerBoard.score += this.POINTS.MOVE;
        
        // Check for captures
        const captureResult = this.checkForCaptures(newPosition, playerColor, board, playerId);
        if (captureResult.killed.length > 0) {
          playerBoard.score += this.POINTS.KILL * captureResult.killed.length;
          killedPlayers = captureResult.killed;
        }
      }
    } else if (piece.position === 'homeStretch') {
      const newHomePosition = piece.boardPosition + diceValue;
      if (newHomePosition === 6) {
        updatedPiece.position = 'finished';
        updatedPiece.boardPosition = -1;
        playerBoard.piecesFinished++;
        playerBoard.score += this.POINTS.FINISH_TOKEN;
      } else if (newHomePosition < 6) {
        updatedPiece.boardPosition = newHomePosition;
        playerBoard.score += this.POINTS.MOVE;
      } else {
        return { success: false, message: 'Cannot overshoot finish line' };
      }
    } else if (piece.position === 'finished') {
      return { success: false, message: 'Piece already finished' };
    }

    // Update the piece in the board
    playerBoard.pieces[updatedPiece.id] = updatedPiece;

    return {
      success: true,
      updatedPlayerBoard: playerBoard,
      updatedPiece,
      killedPlayers
    };
  }

  checkForCaptures(position, currentPlayerColor, board, currentPlayerId) {
    const killed = [];
    
    Object.keys(board).forEach(color => {
      if (color !== currentPlayerColor) {
        board[color].pieces.forEach((piece, index) => {
          if (piece.boardPosition === position && piece.position === 'board' && !piece.isInSafeZone) {
            // Send piece back to start position
            board[color].pieces[index] = {
              ...piece,
              boardPosition: this.HOME_POSITIONS[color]
            };
            killed.push(board[color].playerId);
          }
        });
      }
    });

    return { killed };
  }

  isEnteringHomeStretch(currentPos, newPos, homeStretchStart) {
    return currentPos < homeStretchStart && newPos >= homeStretchStart;
  }

  getPlayerColor(board, playerId) {
    for (const color of this.COLORS) {
      if (board[color] && board[color].playerId === playerId) {
        return color;
      }
    }
    return null;
  }

  getScores(board) {
    const scores = {};
    Object.keys(board).forEach(color => {
      if (board[color].playerId) {
        scores[board[color].playerId] = board[color].score;
      }
    });
    return scores;
  }

  endGameByTimer(gameId) {
    const game = this.games.get(gameId);
    if (!game || !game.gameState) return;

    // Find winner by highest score
    const scores = this.getScores(game.gameState.board);
    let winner = null;
    let highestScore = -Infinity;

    Object.keys(scores).forEach(playerId => {
      if (scores[playerId] > highestScore) {
        highestScore = scores[playerId];
        winner = playerId;
      }
    });

    this.endGame(gameId, winner, 'timer');
  }

  endGame(gameId, winner, reason = 'completion') {
    const game = this.games.get(gameId);
    if (!game) return;

    if (game.timer) {
      clearTimeout(game.timer);
    }

    game.gameState.status = 'finished';
    game.gameState.winner = winner;

    const finalScores = this.getScores(game.gameState.board);

    this.io.to(gameId).emit('FAST_LUDO_GAME_ENDED', {
      winner,
      reason,
      finalScores,
      gameBoard: game.gameState.board
    });

    logger.info(`Fast Ludo game ${gameId} ended. Winner: ${winner}, Reason: ${reason}`);
  }

  joinRoom(socket, { gameId, playerId, playerName }) {
    let game = this.games.get(gameId);
    
    if (!game) {
      game = {
        id: gameId,
        players: [],
        gameState: null,
        timer: null
      };
      this.games.set(gameId, game);
    }

    // Add player if not already in game
    if (!game.players.find(p => p.id === playerId)) {
      game.players.push({
        id: playerId,
        name: playerName,
        socketId: socket.id
      });
    }

    socket.join(gameId);
    
    // Notify room about player joining
    this.io.to(gameId).emit('FAST_LUDO_PLAYER_JOINED', {
      playerId,
      playerName,
      playersCount: game.players.length
    });

    logger.info(`Player ${playerId} joined Fast Ludo game ${gameId}`);
  }
}

module.exports = FastLudoService;