
// MemoryGameService.js - Server-side socket handlers (Node.js)

// Card symbols for the memory game
const CARD_SYMBOLS = [
  '🎮', '🎯', '🎲', '🃏', '🎪', '🎨', '🎭', '🎪',
  '⚽', '🏀', '🏈', '⚾', '🎾', '🏓', '🏸', '🏐',
  '🚗', '🚙', '🚌', '🚎', '🏎️', '🚓', '🚑', '🚒',
];

class MemoryGameService {
  constructor(io) {
    this.io = io;
    this.rooms = new Map();
  }

  setupSocketHandlers(socket) {
    socket.on('START_MEMORY_GAME', (data) => this.startMemoryGame(socket, data));
    socket.on('SELECT_MEMORY_CARD', (data) => this.selectCard(socket, data));
    socket.on('JOIN_MEMORY_ROOM', (data) => this.joinRoom(socket, data));
  }

  generateGameBoard() {
    // Create pairs of cards
    const pairs = CARD_SYMBOLS.slice(0, 12); // 12 unique symbols
    const cards = [...pairs, ...pairs]; // Duplicate for pairs
    
    // Shuffle the cards
    for (let i = cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cards[i], cards[j]] = [cards[j], cards[i]];
    }

    // Create card objects
    return cards.map((symbol, index) => ({
      id: index,
      symbol,
      isFlipped: false,
      isMatched: false,
    }));
  }

  startMemoryGame(socket, { roomId, playerId }) {
    const room = this.rooms.get(roomId);
    if (!room || room.players.length < 2) return;

    const gameBoard = this.generateGameBoard();
    
    room.gameState = {
      board: gameBoard,
      currentTurn: room.players[0].id,
      turnIndex: 0,
      selectedCards: [],
      scores: { score1: 0, score2: 0 },
      matchedPairs: 0,
      status: 'playing',
    };

    this.io.to(roomId).emit('MEMORY_GAME_STARTED', {
      gameBoard: gameBoard.map(card => ({ 
        id: card.id, 
        isFlipped: false, 
        isMatched: false 
      })),
      players: room.players,
    });

    this.io.to(roomId).emit('MEMORY_GAME_CURRENT_TURN', {
      currentPlayer: room.gameState.currentTurn,
    });
  }

  selectCard(socket, { roomId, playerId, position }) {
    const room = this.rooms.get(roomId);
    if (!room || !room.gameState || room.gameState.currentTurn !== playerId) return;

    const gameState = room.gameState;
    const card = gameState.board[position];

    if (card.isFlipped || card.isMatched || gameState.selectedCards.length >= 2) return;

    // Add card to selected cards
    gameState.selectedCards.push({ position, symbol: card.symbol });
    card.isFlipped = true;

    // Emit card flip to all players
    this.io.to(roomId).emit('OPEN_CARD', {
      position,
      symbol: card.symbol,
    });

    // Check if two cards are selected
    if (gameState.selectedCards.length === 2) {
      setTimeout(() => this.checkMatch(roomId), 1000);
    }
  }

  checkMatch(roomId) {
    const room = this.rooms.get(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    const [card1, card2] = gameState.selectedCards;

    if (card1.symbol === card2.symbol) {
      // Cards match
      const positions = [card1.position, card2.position];
      
      // Mark cards as matched
      positions.forEach(pos => {
        gameState.board[pos].isMatched = true;
      });

      // Update score
      const currentPlayerIndex = gameState.turnIndex;
      const scoreKey = currentPlayerIndex === 0 ? 'score1' : 'score2';
      gameState.scores[scoreKey] += 10;
      gameState.matchedPairs += 1;

      // Emit match event
      this.io.to(roomId).emit('CARDS_MATCHED', {
        positions,
        playerId: gameState.currentTurn,
      });

      this.io.to(roomId).emit('MEMORY_GAME_SCORE_UPDATE', {
        scores: gameState.scores,
      });

      // Check if game is over
      if (gameState.matchedPairs === 12) {
        this.endGame(roomId);
        return;
      }

      // Player gets another turn for matching
    } else {
      // Cards don't match
      const positions = [card1.position, card2.position];
      
      // Flip cards back
      positions.forEach(pos => {
        gameState.board[pos].isFlipped = false;
      });

      this.io.to(roomId).emit('CLOSE_CARDS', {
        positions,
      });

      // Switch turns
      this.switchTurn(roomId);
    }

    // Clear selected cards
    gameState.selectedCards = [];
  }

  switchTurn(roomId) {
    const room = this.rooms.get(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    gameState.turnIndex = (gameState.turnIndex + 1) % room.players.length;
    gameState.currentTurn = room.players[gameState.turnIndex].id;

    this.io.to(roomId).emit('MEMORY_GAME_CURRENT_TURN', {
      currentPlayer: gameState.currentTurn,
    });
  }

  endGame(roomId) {
    const room = this.rooms.get(roomId);
    if (!room || !room.gameState) return;

    const gameState = room.gameState;
    const { score1, score2 } = gameState.scores;
    
    let winner;
    if (score1 > score2) {
      winner = room.players[0].id;
    } else if (score2 > score1) {
      winner = room.players[1].id;
    } else {
      winner = null; // Tie
    }

    this.io.to(roomId).emit('END_GAME', {
      winner,
      finalScores: gameState.scores,
      gameType: 'memory',
    });

    // Reset game state
    room.gameState = null;
  }

  joinRoom(socket, { roomId, playerId, playerName }) {
    let room = this.rooms.get(roomId);
    
    if (!room) {
      room = {
        id: roomId,
        players: [],
        gameState: null,
      };
      this.rooms.set(roomId, room);
    }

    // Add player if not already in room
    if (!room.players.find(p => p.id === playerId)) {
      room.players.push({
        id: playerId,
        name: playerName,
        socketId: socket.id,
      });
    }

    socket.join(roomId);
    
    // Notify room about player joining
    this.io.to(roomId).emit('PLAYER_JOINED', {
      playerId,
      playerName,
      playersCount: room.players.length,
    });
  }
}

module.exports = MemoryGameService;