import { invoke } from '@tauri-apps/api/core';

// Game state interface (mirrors the Rust `GameState` struct)
interface GameStats {
  high_score: number;
  games_played: number;
  total_score: number;
  settings: {
    sound_enabled: boolean;
    theme: string;
    difficulty: string;
  };
}

// Tauri backend integration
class TauriGameManager {
  private gameStats: GameStats | null = null;

  async init() {
    try {
      this.gameStats = await invoke<GameStats>('load_game_state');
      this.updateUI();
      console.log('✅ Game state loaded from Tauri backend:', this.gameStats);
    } catch (error) {
      console.error('Failed to load game state:', error);
      this.gameStats = {
        high_score: 0,
        games_played: 0,
        total_score: 0,
        settings: {
          sound_enabled: true,
          theme: 'classic',
          difficulty: 'normal'
        }
      };
    }
  }

  updateScore(score: number) {
    const currentScoreEl = document.getElementById('current-score');
    if (currentScoreEl) {
      currentScoreEl.textContent = score.toString();
    }
  }

  async onGameEnd(finalScore: number) {
    try {
      const isNewHighScore = await invoke<boolean>('update_high_score', { score: finalScore });

      if (isNewHighScore) {
        this.showNotification('New High Score!', finalScore);
      }

      // Save to disk
      await invoke('save_game_state');

      // Reload stats
      this.gameStats = await invoke<GameStats>('get_game_stats');
      this.updateUI();
    } catch (error) {
      console.error('Failed to update high score:', error);
    }
  }

  async resetStats() {
    try {
      await invoke('reset_stats');
      await invoke('save_game_state');
      this.gameStats = await invoke<GameStats>('get_game_stats');
      this.updateUI();
    } catch (error) {
      console.error('Failed to reset stats:', error);
    }
  }

  updateUI() {
    if (!this.gameStats) return;

    const highScoreEl = document.getElementById('high-score');
    const gamesPlayedEl = document.getElementById('games-played');

    if (highScoreEl) highScoreEl.textContent = this.gameStats.high_score.toString();
    if (gamesPlayedEl) gamesPlayedEl.textContent = this.gameStats.games_played.toString();
  }

  showNotification(title: string, score: number) {
    const notification = document.createElement('div');
    notification.className = 'notification';
    notification.textContent = `${title} ${score}`;
    document.body.appendChild(notification);
    setTimeout(() => notification.remove(), 3000);
  }

  getHighScore() {
    return this.gameStats?.high_score || 0;
  }
}

const tauriManager = new TauriGameManager();

type Point = { x: number; y: number };
type GameStatus = 'idle' | 'running' | 'paused' | 'over';

const UP: Point = { x: 0, y: -1 };
const DOWN: Point = { x: 0, y: 1 };
const LEFT: Point = { x: -1, y: 0 };
const RIGHT: Point = { x: 1, y: 0 };

const KEY_TO_DIRECTION: Record<string, Point> = {
  ArrowUp: UP, w: UP, W: UP,
  ArrowDown: DOWN, s: DOWN, S: DOWN,
  ArrowLeft: LEFT, a: LEFT, A: LEFT,
  ArrowRight: RIGHT, d: RIGHT, D: RIGHT,
};

const START_STEP_MS = 120;
const MIN_STEP_MS = 55;
const STEP_DECREMENT_MS = 3;
const MAX_QUEUED_TURNS = 2;

class SnakeGame {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly gridSize = 20;
  private readonly tileCount = 25;
  private snake: Point[] = [];
  private food: Point = { x: 0, y: 0 };
  private direction: Point = RIGHT;
  // Turns pressed between ticks, so quick double-taps are applied in order
  private turnQueue: Point[] = [];
  private score = 0;
  private stepMs = START_STEP_MS;
  private status: GameStatus = 'idle';
  private won = false;
  private rafId = 0;
  private lastTime = 0;
  private accumulator = 0;

  constructor(containerId: string, private readonly onStatusChange: (status: GameStatus) => void) {
    const container = document.getElementById(containerId);
    if (!container) throw new Error('Container not found');

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.gridSize * this.tileCount;
    this.canvas.height = this.gridSize * this.tileCount;
    container.appendChild(this.canvas);

    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('Could not get canvas context');
    this.ctx = context;

    this.resetState();
    this.setupControls();
    this.draw();
    this.onStatusChange(this.status);
  }

  newGame() {
    this.resetState();
    tauriManager.updateScore(0);
    this.run();
  }

  togglePause() {
    if (this.status === 'running') {
      cancelAnimationFrame(this.rafId);
      this.setStatus('paused');
      this.draw();
    } else if (this.status === 'paused') {
      this.run();
    }
  }

  private resetState() {
    const center = Math.floor(this.tileCount / 2);
    this.snake = [
      { x: center, y: center },
      { x: center - 1, y: center },
      { x: center - 2, y: center }
    ];
    this.direction = RIGHT;
    this.turnQueue = [];
    this.score = 0;
    this.stepMs = START_STEP_MS;
    this.won = false;
    this.placeFood();
  }

  private setStatus(status: GameStatus) {
    this.status = status;
    this.onStatusChange(status);
  }

  /** Returns false when the board is full (the player has won). */
  private placeFood(): boolean {
    const free: Point[] = [];
    for (let y = 0; y < this.tileCount; y++) {
      for (let x = 0; x < this.tileCount; x++) {
        if (!this.snake.some(s => s.x === x && s.y === y)) free.push({ x, y });
      }
    }
    if (free.length === 0) return false;
    this.food = free[Math.floor(Math.random() * free.length)];
    return true;
  }

  private setupControls() {
    document.addEventListener('keydown', (e) => {
      if (e.key === ' ') {
        e.preventDefault();
        this.togglePause();
        return;
      }
      if (e.key === 'Enter') {
        if (this.status === 'idle' || this.status === 'over') {
          e.preventDefault();
          this.newGame();
        }
        return;
      }
      const dir = KEY_TO_DIRECTION[e.key];
      if (!dir) return;
      e.preventDefault();
      if (this.status === 'running') this.queueTurn(dir);
    });

    // Auto-pause when the window is minimized or hidden
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.status === 'running') this.togglePause();
    });
  }

  private queueTurn(dir: Point) {
    // Compare against the last *queued* heading, not the current one, so two
    // fast presses (e.g. Up then Left while moving right) can never add up to
    // a 180° turn into the snake's own neck.
    const last = this.turnQueue[this.turnQueue.length - 1] ?? this.direction;
    const isSame = dir.x === last.x && dir.y === last.y;
    const isReverse = dir.x === -last.x && dir.y === -last.y;
    if (isSame || isReverse || this.turnQueue.length >= MAX_QUEUED_TURNS) return;
    this.turnQueue.push(dir);
  }

  private run() {
    cancelAnimationFrame(this.rafId);
    this.lastTime = performance.now();
    this.accumulator = 0;
    this.setStatus('running');
    this.rafId = requestAnimationFrame(this.loop);
  }

  // Fixed-timestep loop on requestAnimationFrame: rendering follows the
  // display refresh, while the snake advances every `stepMs`, so speed-ups
  // take effect on the very next tick.
  private loop = (time: number) => {
    if (this.status !== 'running') return;
    // Clamp so a long stall (e.g. a dragged window) doesn't fast-forward the game
    this.accumulator += Math.min(time - this.lastTime, 250);
    this.lastTime = time;

    while (this.accumulator >= this.stepMs && this.status === 'running') {
      this.accumulator -= this.stepMs;
      this.step();
    }
    this.draw();

    if (this.status === 'running') {
      this.rafId = requestAnimationFrame(this.loop);
    }
  };

  private step() {
    const turn = this.turnQueue.shift();
    if (turn) this.direction = turn;

    const head = {
      x: this.snake[0].x + this.direction.x,
      y: this.snake[0].y + this.direction.y
    };

    // Check wall collision
    if (head.x < 0 || head.x >= this.tileCount ||
        head.y < 0 || head.y >= this.tileCount) {
      this.gameOver();
      return;
    }

    // The tail moves out of the way this tick unless we eat, so it's not an obstacle
    const willEat = head.x === this.food.x && head.y === this.food.y;
    const obstacles = willEat ? this.snake : this.snake.slice(0, -1);
    if (obstacles.some(s => s.x === head.x && s.y === head.y)) {
      this.gameOver();
      return;
    }

    this.snake.unshift(head);

    if (willEat) {
      this.score++;
      tauriManager.updateScore(this.score);
      this.stepMs = Math.max(MIN_STEP_MS, this.stepMs - STEP_DECREMENT_MS);
      if (!this.placeFood()) {
        this.won = true;
        this.gameOver();
      }
    } else {
      this.snake.pop();
    }
  }

  private gameOver() {
    cancelAnimationFrame(this.rafId);
    this.setStatus('over');
    this.draw();
    // Persist through the Rust backend, then redraw so the overlay shows the new best
    void tauriManager.onGameEnd(this.score).then(() => this.draw());
  }

  private draw() {
    const { ctx } = this;
    const size = this.gridSize * this.tileCount;

    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, size, size);

    // Grid, batched into a single path
    ctx.strokeStyle = '#16213e';
    ctx.beginPath();
    for (let i = 0; i <= this.tileCount; i++) {
      ctx.moveTo(i * this.gridSize, 0);
      ctx.lineTo(i * this.gridSize, size);
      ctx.moveTo(0, i * this.gridSize);
      ctx.lineTo(size, i * this.gridSize);
    }
    ctx.stroke();

    // Snake
    this.snake.forEach((segment, index) => {
      const color = index === 0 ? '#00ff41' : '#0f9';
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = index === 0 ? 15 : 10;
      ctx.fillRect(
        segment.x * this.gridSize + 1,
        segment.y * this.gridSize + 1,
        this.gridSize - 2,
        this.gridSize - 2
      );
    });

    // Food
    ctx.shadowBlur = 20;
    ctx.shadowColor = '#ff006e';
    ctx.fillStyle = '#ff006e';
    ctx.beginPath();
    ctx.arc(
      this.food.x * this.gridSize + this.gridSize / 2,
      this.food.y * this.gridSize + this.gridSize / 2,
      this.gridSize / 2 - 2,
      0,
      Math.PI * 2
    );
    ctx.fill();
    ctx.shadowBlur = 0;

    if (this.status === 'idle') {
      this.drawOverlay('SNAKE 2.0', 'Press Enter or click New Game', 'Arrows / WASD to move, Space to pause');
    } else if (this.status === 'paused') {
      this.drawOverlay('PAUSED', 'Press Space to resume');
    } else if (this.status === 'over') {
      this.drawOverlay(
        this.won ? 'YOU WIN!' : 'GAME OVER',
        `Score: ${this.score}    Best: ${tauriManager.getHighScore()}`,
        'Press Enter to play again'
      );
    }
  }

  private drawOverlay(title: string, ...lines: string[]) {
    const { ctx } = this;
    const size = this.gridSize * this.tileCount;
    const center = size / 2;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
    ctx.fillRect(0, 0, size, size);

    ctx.textAlign = 'center';
    ctx.fillStyle = '#ff006e';
    ctx.font = 'bold 40px "Segoe UI", sans-serif';
    ctx.fillText(title, center, center - 20);

    ctx.fillStyle = '#ffffff';
    ctx.font = '18px "Segoe UI", sans-serif';
    lines.forEach((line, i) => ctx.fillText(line, center, center + 20 + i * 28));
  }
}

async function initApp() {
  // Load persisted stats from the Rust backend before the first frame
  await tauriManager.init();

  const btnNewGame = document.getElementById('btn-new-game');
  const btnPause = document.getElementById('btn-pause') as HTMLButtonElement | null;
  const btnResetStats = document.getElementById('btn-reset-stats');

  const game = new SnakeGame('game-area', (status) => {
    if (!btnPause) return;
    btnPause.textContent = status === 'paused' ? 'Resume' : 'Pause';
    btnPause.disabled = status !== 'running' && status !== 'paused';
  });

  // Blur after clicking so Space/Enter go to the game instead of re-clicking the button
  btnNewGame?.addEventListener('click', () => {
    btnNewGame.blur();
    game.newGame();
  });

  btnPause?.addEventListener('click', () => {
    btnPause.blur();
    game.togglePause();
  });

  btnResetStats?.addEventListener('click', async () => {
    btnResetStats.blur();
    if (confirm('Are you sure you want to reset all stats?')) {
      await tauriManager.resetStats();
    }
  });

  // On-screen gamepad (touch devices): replay the key the button stands for
  const keyCodeToKey: Record<string, string> = {
    '37': 'ArrowLeft', '38': 'ArrowUp', '39': 'ArrowRight', '40': 'ArrowDown', '32': ' '
  };
  document.querySelectorAll<HTMLElement>('.snake-gamepad button').forEach(btn => {
    btn.addEventListener('pointerdown', (evt) => {
      evt.preventDefault();
      const key = keyCodeToKey[btn.dataset.key ?? ''];
      if (key) document.dispatchEvent(new KeyboardEvent('keydown', { key }));
    });
  });
}

// Start the app when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
