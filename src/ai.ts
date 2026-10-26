/**
 * AI autoplay for Snake 2.0.
 *
 * The original repo's `ai-init.js` only shows a callback hook
 * (`moveSnakeWithAI` → `setDirection`) plus a stub hamiltonian lookup for a
 * tiny fixed board that is not a real cycle. Here we keep that same "pick a
 * direction each step" contract, but use a lightweight BFS heuristic that
 * works on our 25×25 canvas board:
 *   1. Path to food, if taking it still leaves a path from the virtual new
 *      head to the virtual new tail (won't trap itself).
 *   2. Otherwise path toward the current tail (stall / follow self).
 *   3. Otherwise any non-reversing free neighbor, preferring the most open
 *      flood-fill space.
 */

export type Point = { x: number; y: number };

const CARDINALS: readonly Point[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

function cellKey(x: number, y: number, width: number): number {
  return y * width + x;
}

function inBounds(x: number, y: number, width: number, height: number): boolean {
  return x >= 0 && y >= 0 && x < width && y < height;
}

function isReverse(a: Point, b: Point): boolean {
  return a.x === -b.x && a.y === -b.y;
}

/** BFS; returns the first step from `start` toward `goal`, or null. */
function bfsFirstStep(
  start: Point,
  goal: Point,
  blocked: Set<number>,
  width: number,
  height: number
): Point | null {
  const goalKey = cellKey(goal.x, goal.y, width);
  const startKey = cellKey(start.x, start.y, width);
  if (startKey === goalKey) return null;

  const visited = new Uint8Array(width * height);
  const parent = new Int32Array(width * height);
  parent.fill(-1);

  const queue: number[] = [startKey];
  visited[startKey] = 1;
  let headIdx = 0;
  let found = false;

  while (headIdx < queue.length) {
    const cur = queue[headIdx++];
    if (cur === goalKey) {
      found = true;
      break;
    }
    const cx = cur % width;
    const cy = (cur / width) | 0;
    for (const d of CARDINALS) {
      const nx = cx + d.x;
      const ny = cy + d.y;
      if (!inBounds(nx, ny, width, height)) continue;
      const nk = cellKey(nx, ny, width);
      if (visited[nk]) continue;
      // Goal is always enterable even if marked blocked (e.g. chasing tail).
      if (nk !== goalKey && blocked.has(nk)) continue;
      visited[nk] = 1;
      parent[nk] = cur;
      queue.push(nk);
    }
  }

  if (!found) return null;

  // Walk back to the step right after start.
  let cur = goalKey;
  let prev = parent[cur];
  while (prev !== startKey && prev !== -1) {
    cur = prev;
    prev = parent[cur];
  }
  if (prev === -1) return null;
  return { x: (cur % width) - start.x, y: ((cur / width) | 0) - start.y };
}

/** Can we reach `goal` from `start` without stepping on `blocked`? */
function canReach(
  start: Point,
  goal: Point,
  blocked: Set<number>,
  width: number,
  height: number
): boolean {
  return bfsFirstStep(start, goal, blocked, width, height) !== null
    || (start.x === goal.x && start.y === goal.y);
}

function buildBlocked(snake: Point[], width: number, includeTail: boolean): Set<number> {
  const blocked = new Set<number>();
  const last = includeTail ? snake.length : snake.length - 1;
  for (let i = 0; i < last; i++) {
    blocked.add(cellKey(snake[i].x, snake[i].y, width));
  }
  return blocked;
}

/** Count reachable free cells from `start` (flood fill). */
function openSpace(
  start: Point,
  blocked: Set<number>,
  width: number,
  height: number
): number {
  const startKey = cellKey(start.x, start.y, width);
  if (blocked.has(startKey)) return 0;
  const visited = new Uint8Array(width * height);
  const queue: number[] = [startKey];
  visited[startKey] = 1;
  let headIdx = 0;
  let count = 0;
  while (headIdx < queue.length) {
    const cur = queue[headIdx++];
    count++;
    const cx = cur % width;
    const cy = (cur / width) | 0;
    for (const d of CARDINALS) {
      const nx = cx + d.x;
      const ny = cy + d.y;
      if (!inBounds(nx, ny, width, height)) continue;
      const nk = cellKey(nx, ny, width);
      if (visited[nk] || blocked.has(nk)) continue;
      visited[nk] = 1;
      queue.push(nk);
    }
  }
  return count;
}

/**
 * Choose the next move for AI autoplay.
 * Returns a cardinal unit vector (never a 180° reverse of `direction` if avoidable).
 */
export function chooseAiDirection(opts: {
  snake: Point[];
  food: Point;
  direction: Point;
  width: number;
  height: number;
}): Point {
  const { snake, food, direction, width, height } = opts;
  const head = snake[0];
  const tail = snake[snake.length - 1];

  // Body blocks movement; current tail vacates unless we grow this tick.
  const blockedNoTail = buildBlocked(snake, width, false);

  const foodStep = bfsFirstStep(head, food, blockedNoTail, width, height);
  if (foodStep && !isReverse(foodStep, direction)) {
    const nextHead = { x: head.x + foodStep.x, y: head.y + foodStep.y };
    // Virtual snake after eating: new head at food path start… simulate only
    // the immediate step; if that step lands on food, body grows (tail stays).
    const landsOnFood = nextHead.x === food.x && nextHead.y === food.y;
    const virtual: Point[] = [nextHead, ...snake];
    if (!landsOnFood) virtual.pop(); // tail advances
    const vTail = virtual[virtual.length - 1];
    const vBlocked = buildBlocked(virtual, width, false);
    // After moving, we must still be able to reach our tail (escape route).
    if (canReach(nextHead, vTail, vBlocked, width, height)) {
      return foodStep;
    }
  }

  // Stall: walk toward the tail so the corridor keeps opening.
  const tailStep = bfsFirstStep(head, tail, blockedNoTail, width, height);
  if (tailStep && !isReverse(tailStep, direction)) {
    return tailStep;
  }

  // Last resort: safest free neighbor (most open space), never reverse if possible.
  let best: Point | null = null;
  let bestScore = -1;
  let bestNonReverse: Point | null = null;
  let bestNonReverseScore = -1;

  for (const d of CARDINALS) {
    const nx = head.x + d.x;
    const ny = head.y + d.y;
    if (!inBounds(nx, ny, width, height)) continue;
    const nk = cellKey(nx, ny, width);
    if (blockedNoTail.has(nk)) continue;
    // Next cell becomes free of our old head; treat start as free for flood.
    const blocked = new Set(blockedNoTail);
    blocked.delete(cellKey(head.x, head.y, width));
    // Tail vacates this tick if we aren't eating.
    if (!(nx === food.x && ny === food.y)) {
      blocked.delete(cellKey(tail.x, tail.y, width));
    }
    const score = openSpace({ x: nx, y: ny }, blocked, width, height);
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
    if (!isReverse(d, direction) && score > bestNonReverseScore) {
      bestNonReverseScore = score;
      bestNonReverse = d;
    }
  }

  return bestNonReverse ?? best ?? direction;
}
