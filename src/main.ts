import { invoke } from '@tauri-apps/api/core';
import { chooseAiDirection } from './ai';

// Game state interface (mirrors the Rust `GameState` struct)
interface GameSettings {
  sound_enabled: boolean;
  theme: string;
  difficulty: string;
}

interface GameStats {
  high_score: number;
  games_played: number;
  total_score: number;
  settings: GameSettings;
}

/** Milliseconds per step for each difficulty (matches patorjk/JavaScript-Snake). */
const DIFFICULTY_STEP_MS: Record<string, number> = {
  easy: 100,
  medium: 75,
  hard: 50,
  impossible: 25,
  rush: 110,
};

const RUSH_DECREMENT_MS = 5;
const RUSH_FLOOR_MS = 25;
const DEFAULT_DIFFICULTY = 'medium';

function normalizeDifficulty(raw: string | undefined | null): string {
  if (raw && raw in DIFFICULTY_STEP_MS) return raw;
  // Legacy save used "normal"; treat it as medium.
  if (raw === 'normal') return DEFAULT_DIFFICULTY;
  return DEFAULT_DIFFICULTY;
}

function baseStepMs(difficulty: string): number {
  return DIFFICULTY_STEP_MS[normalizeDifficulty(difficulty)];
}

/** Canvas color palettes adapted from patorjk/JavaScript-Snake CSS themes. */
interface ThemePalette {
  background: string;
  grid: string;
  snakeHead: string;
  snakeBody: string;
  food: string;
  overlayTitle: string;
  overlayText: string;
}

const THEME_PALETTES: Record<string, ThemePalette> = {
  // Main Theme by patorjk — blue field, yellow snakeblock.png, red food
  main: {
    background: '#0000a8',
    grid: '#000080',
    snakeHead: '#ffff54',
    snakeBody: '#f0f050',
    food: '#ff0000',
    overlayTitle: '#fcfc54',
    overlayText: '#ffffff',
  },
  // Dark Theme by KenyStev — purple field, dark teal body / white highlights
  dark: {
    background: '#312e44',
    grid: '#241f33',
    snakeHead: '#f0f0f0',
    snakeBody: '#102020',
    food: '#000000',
    overlayTitle: '#938996',
    overlayText: '#c4bbc9',
  },
  // Matrix Theme by Geahad Haymor — black field, green snake, red food
  matrix: {
    background: '#000000',
    grid: '#003b08',
    snakeHead: '#00ff11',
    snakeBody: '#00a050',
    food: '#d00000',
    overlayTitle: '#00ff11',
    overlayText: '#00ff11',
  },
  // Neon Theme by Daisy21000 — cyan field, neon-yellow body, red food
  neon: {
    background: '#00ffd4',
    grid: '#00d9b5',
    snakeHead: '#0fff00',
    snakeBody: '#f0f000',
    food: '#ff0000',
    overlayTitle: '#0fff00',
    overlayText: '#000000',
  },
  // Golden Theme By JosephVoboril29 — gold field / head, copper body, amber food
  golden: {
    background: '#b9a21d',
    grid: '#9a8919',
    snakeHead: '#ffe81c',
    snakeBody: '#c4480f',
    food: '#ffbb00',
    overlayTitle: '#ffe81c',
    overlayText: '#ffffff',
  },
};

const DEFAULT_THEME = 'main';

function normalizeTheme(raw: string | undefined | null): string {
  if (raw && raw in THEME_PALETTES) return raw;
  // Legacy save used "classic" before named themes existed.
  if (raw === 'classic') return DEFAULT_THEME;
  return DEFAULT_THEME;
}

function themePalette(theme: string): ThemePalette {
  return THEME_PALETTES[normalizeTheme(theme)];
}

// Tauri backend integration
class TauriGameManager {
  private gameStats: GameStats | null = null;

  async init() {
    try {
      this.gameStats = await invoke<GameStats>('load_game_state');
      this.gameStats.settings.difficulty = normalizeDifficulty(
        this.gameStats.settings.difficulty
      );
      this.gameStats.settings.theme = normalizeTheme(
        this.gameStats.settings.theme
      );
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
          theme: DEFAULT_THEME,
          difficulty: DEFAULT_DIFFICULTY
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
      this.gameStats.settings.difficulty = normalizeDifficulty(
        this.gameStats.settings.difficulty
      );
      this.gameStats.settings.theme = normalizeTheme(
        this.gameStats.settings.theme
      );
      this.updateUI();
    } catch (error) {
      console.error('Failed to reset stats:', error);
    }
  }

  getDifficulty(): string {
    return normalizeDifficulty(this.gameStats?.settings.difficulty);
  }

  getSettings(): GameSettings {
    return {
      sound_enabled: this.gameStats?.settings.sound_enabled ?? true,
      theme: this.getTheme(),
      difficulty: this.getDifficulty()
    };
  }

  /** Persist difficulty (keeping sound/theme) via update_settings + save_game_state. */
  async setDifficulty(difficulty: string): Promise<string> {
    const next = normalizeDifficulty(difficulty);
    const settings: GameSettings = {
      ...this.getSettings(),
      difficulty: next
    };
    try {
      await invoke('update_settings', { settings });
      await invoke('save_game_state');
      if (this.gameStats) {
        this.gameStats.settings = settings;
      }
    } catch (error) {
      console.error('Failed to save difficulty:', error);
    }
    return next;
  }

  getTheme(): string {
    return normalizeTheme(this.gameStats?.settings.theme);
  }

  /** Persist theme (keeping sound/difficulty) via update_settings + save_game_state. */
  async setTheme(theme: string): Promise<string> {
    const next = normalizeTheme(theme);
    const settings: GameSettings = {
      ...this.getSettings(),
      theme: next
    };
    try {
      await invoke('update_settings', { settings });
      await invoke('save_game_state');
      if (this.gameStats) {
        this.gameStats.settings = settings;
      }
    } catch (error) {
      console.error('Failed to save theme:', error);
    }
    return next;
  }

  updateUI() {
    if (!this.gameStats) return;

    const highScoreEl = document.getElementById('high-score');
    const gamesPlayedEl = document.getElementById('games-played');
    const difficultyEl = document.getElementById('select-difficulty') as HTMLSelectElement | null;
    const themeEl = document.getElementById('select-theme') as HTMLSelectElement | null;

    if (highScoreEl) highScoreEl.textContent = this.gameStats.high_score.toString();
    if (gamesPlayedEl) gamesPlayedEl.textContent = this.gameStats.games_played.toString();
    if (difficultyEl) difficultyEl.value = this.getDifficulty();
    if (themeEl) themeEl.value = this.getTheme();
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
  private difficulty = DEFAULT_DIFFICULTY;
  private theme = DEFAULT_THEME;
  private palette = themePalette(DEFAULT_THEME);
  private stepMs = baseStepMs(DEFAULT_DIFFICULTY);
  private status: GameStatus = 'idle';
  private won = false;
  private aiEnabled = false;
  private aiRestartTimer = 0;
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

  setDifficulty(difficulty: string) {
    this.difficulty = normalizeDifficulty(difficulty);
    // Apply the new base speed immediately (Rush restarts at 110).
    this.stepMs = baseStepMs(this.difficulty);
  }

  getDifficulty() {
    return this.difficulty;
  }

  setTheme(theme: string) {
    this.theme = normalizeTheme(theme);
    this.palette = themePalette(this.theme);
    this.draw();
  }

  getTheme() {
    return this.theme;
  }

  setAiEnabled(enabled: boolean) {
    this.aiEnabled = enabled;
    if (!enabled && this.aiRestartTimer) {
      window.clearTimeout(this.aiRestartTimer);
      this.aiRestartTimer = 0;
    }
    // Mirror original ai-init onInit → startAIGame when enabling from idle/over.
    if (enabled && (this.status === 'idle' || this.status === 'over')) {
      this.newGame();
    }
  }

  isAiEnabled() {
    return this.aiEnabled;
  }

  newGame() {
    if (this.aiRestartTimer) {
      window.clearTimeout(this.aiRestartTimer);
      this.aiRestartTimer = 0;
    }
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
    this.stepMs = baseStepMs(this.difficulty);
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
      // AI owns steering while autoplay is on (Space/Enter still work above).
      if (this.aiEnabled) return;
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
    if (this.aiEnabled) {
      this.turnQueue = [];
      this.direction = chooseAiDirection({
        snake: this.snake,
        food: this.food,
        direction: this.direction,
        width: this.tileCount,
        height: this.tileCount,
      });
    } else {
      const turn = this.turnQueue.shift();
      if (turn) this.direction = turn;
    }

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
      // Only Rush accelerates: -5ms per food, floor 25ms (other modes stay fixed).
      if (this.difficulty === 'rush') {
        this.stepMs = Math.max(RUSH_FLOOR_MS, this.stepMs - RUSH_DECREMENT_MS);
      }
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
    void tauriManager.onGameEnd(this.score).then(() => {
      this.draw();
      // Optional continuous autoplay (original ai-init leaves this to onDeath → startAIGame).
      if (this.aiEnabled) {
        this.aiRestartTimer = window.setTimeout(() => {
          this.aiRestartTimer = 0;
          if (this.aiEnabled && this.status === 'over') this.newGame();
        }, 900);
      }
    });
  }

  private draw() {
    const { ctx, palette } = this;
    const size = this.gridSize * this.tileCount;

    ctx.fillStyle = palette.background;
    ctx.fillRect(0, 0, size, size);

    // Grid, batched into a single path
    ctx.strokeStyle = palette.grid;
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
      const color = index === 0 ? palette.snakeHead : palette.snakeBody;
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
    ctx.shadowColor = palette.food;
    ctx.fillStyle = palette.food;
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
    const { ctx, palette } = this;
    const size = this.gridSize * this.tileCount;
    const center = size / 2;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
    ctx.fillRect(0, 0, size, size);

    ctx.textAlign = 'center';
    ctx.fillStyle = palette.overlayTitle;
    ctx.font = 'bold 40px "Segoe UI", sans-serif';
    ctx.fillText(title, center, center - 20);

    ctx.fillStyle = palette.overlayText;
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
  const selectDifficulty = document.getElementById('select-difficulty') as HTMLSelectElement | null;
  const selectTheme = document.getElementById('select-theme') as HTMLSelectElement | null;
  const toggleAi = document.getElementById('toggle-ai') as HTMLInputElement | null;

  const game = new SnakeGame('game-area', (status) => {
    if (!btnPause) return;
    btnPause.textContent = status === 'paused' ? 'Resume' : 'Pause';
    btnPause.disabled = status !== 'running' && status !== 'paused';
  });

  // Restore difficulty + theme from disk and sync dropdowns / drawing
  const savedDifficulty = tauriManager.getDifficulty();
  game.setDifficulty(savedDifficulty);
  if (selectDifficulty) selectDifficulty.value = savedDifficulty;

  const savedTheme = tauriManager.getTheme();
  game.setTheme(savedTheme);
  if (selectTheme) selectTheme.value = savedTheme;

  selectDifficulty?.addEventListener('change', async () => {
    const next = await tauriManager.setDifficulty(selectDifficulty.value);
    game.setDifficulty(next);
    selectDifficulty.blur();
  });

  selectTheme?.addEventListener('change', async () => {
    const next = await tauriManager.setTheme(selectTheme.value);
    game.setTheme(next);
    selectTheme.blur();
  });

  // Session-only AI toggle (original does not persist autoplay preference).
  toggleAi?.addEventListener('change', () => {
    game.setAiEnabled(toggleAi.checked);
    toggleAi.blur();
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
      const difficulty = tauriManager.getDifficulty();
      game.setDifficulty(difficulty);
      if (selectDifficulty) selectDifficulty.value = difficulty;
      const theme = tauriManager.getTheme();
      game.setTheme(theme);
      if (selectTheme) selectTheme.value = theme;
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
