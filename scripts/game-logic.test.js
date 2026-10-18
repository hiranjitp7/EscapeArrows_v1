const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
const source = scripts.find(script => script.includes('function gen('));

function extractBraced(sourceText, start) {
  const open = sourceText.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < sourceText.length; i++) {
    if (sourceText[i] === '{') depth++;
    if (sourceText[i] === '}' && --depth === 0) return sourceText.slice(start, i + 1);
  }
  throw new Error('Could not extract source block');
}

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Could not find function ${name}`);
  return extractBraced(source, start);
}

const context = vm.createContext({
  DIRS: [[1, 0], [-1, 0], [0, 1], [0, -1]],
  TURN_DIRS: [[0, -1], [1, 0], [0, 1], [-1, 0]],
  PORTAL_MOVE_SPEED: 1200,
  PORTAL_EXIT_DISTANCE: 600,
  MAX_REVIVES_PER_LEVEL: 1
});
const itemsStart = source.indexOf('const COLLECTION_ITEMS=');
const itemsEnd = source.indexOf('\n];', itemsStart) + 3;
vm.runInContext(`${source.slice(itemsStart, itemsEnd)}; this.COLLECTION_ITEMS=COLLECTION_ITEMS;`, context);
const shuffleStart = source.indexOf('const shuffle=');
const shuffleEnd = source.indexOf('\nconst dateKey=', shuffleStart);
vm.runInContext(source.slice(shuffleStart, shuffleEnd), context);
for (const name of [
  'seededRandom', 'hashSeed', 'resolveArrowHit', 'genCandidate', 'expectedMechanics', 'analyzeGeneratedBoard',
  'generatedBoardMeetsQuality', 'addBlockingArrow', 'safeFallbackBoard', 'gen', 'campaignRandom', 'shapeRewardFor', 'showcaseLevel'
]) {
  vm.runInContext(extractFunction(name), context);
}

const resolveArrowHit = vm.runInNewContext(`(${extractFunction('resolveArrowHit')})`, context);

const freeStart = source.indexOf('  free(s,d=s.d){');
const freeMethod = extractBraced(source, freeStart);
const free = vm.runInNewContext(`({${freeMethod}}).free`);
const portalExitDirection = vm.runInNewContext(`(${extractFunction('portalExitDirection')})`, context);
const portalTraceStart = source.indexOf('  portalTrace(s,d=s.d,portal=this.portal||s.portal){');
const portalTraceMethod = extractBraced(source, portalTraceStart);
const portalTrace = vm.runInNewContext(`({${portalTraceMethod}}).portalTrace`, vm.createContext({portalExitDirection}));
const portalMoveStart = source.indexOf('  portalMove(s,d=s.d,portal=this.portal||s.portal){');
const portalMoveMethod = extractBraced(source, portalMoveStart);
const portalMove = vm.runInNewContext(`({${portalMoveMethod}}).portalMove`);
const addPortalPairStart = source.indexOf('  addPortalPair(rng){');
const addPortalPairMethod = extractBraced(source, addPortalPairStart);
const addPortalPair = vm.runInNewContext(`({${addPortalPairMethod}}).addPortalPair`, context);
const portalBodyAtProgress = vm.runInNewContext(`(${extractFunction('portalBodyAtProgress')})`, context);
const portalAnimationTiming = vm.runInNewContext(`(${extractFunction('portalAnimationTiming')})`, context);
const ensureInitialUndo = vm.runInNewContext(`(${extractFunction('ensureInitialUndo')})`, context);
const canRevive = vm.runInNewContext(`(${extractFunction('canRevive')})`, context);
const shouldRestoreGameOverModal = vm.runInNewContext(`(${extractFunction('shouldRestoreGameOverModal')})`, context);
const undoBalanceAfterUse = vm.runInNewContext(`(${extractFunction('undoBalanceAfterUse')})`, context);

function makeScene(snake) {
  return {snakes: [snake], cols: 6, rows: 6, portalTrace, portalMove};
}

function applyCircuitRules(snakes, level) {
  const pairs = [[0, snakes.length - 1]];
  if (level >= 11 && snakes.length >= 4) pairs.push([1, snakes.length - 2]);
  if (level >= 21 && snakes.length >= 6) pairs.push([2, snakes.length - 3]);
  if (level >= 51 && snakes.length >= 8) pairs.push([3, snakes.length - 4]);
  if (level >= 101 && snakes.length >= 10) pairs.push([4, snakes.length - 5]);
  if (level >= 151 && snakes.length >= 12) pairs.push([5, snakes.length - 6]);
  pairs.forEach(([gateIndex, relayIndex], index) => {
    const gate = snakes[gateIndex], relay = snakes[relayIndex], switchTile = index === 2 || index === 5;
    gate.locked = true;
    gate.isGate = true;
    relay.isRelay = !switchTile;
    relay.isSwitch = switchTile;
    relay.unlocks = [gate];
    relay.unlockIndices = [gateIndex];
  });
  return snakes;
}

function solveBoard(board, cols, rows, turnBudget = 0, stateCap = 100000) {
  const snakes = JSON.parse(JSON.stringify(board));
  const portal = snakes.find(snake => snake.portal)?.portal || null;
  const unlockSources = snakes.map((snake, index) =>
    snakes.reduce((sources, relay, relayIndex) => relay.unlockIndices?.includes(index) ? [...sources, relayIndex] : sources, []));
  const directions = snakes.map(snake => snake.d.slice());
  const memo = new Map();
  let states = 0, capped = false;
  const encodeDirection = d => d[0] === 1 ? 'R' : d[0] === -1 ? 'L' : d[1] === 1 ? 'D' : 'U';
  const search = (done, dirs, turns, armed) => {
    if (done.every(Boolean)) return {solutions: 1, path: []};
    const key = `${done.map(Boolean).map(Number).join('')}:${dirs.map(encodeDirection).join('')}:${turns}:${armed.map(Number).join('')}`;
    if (memo.has(key)) return memo.get(key);
    if (++states > stateCap) { capped = true; return {solutions: 0, path: []}; }
    const active = snakes.map((snake, index) => ({...snake, d: dirs[index], done: done[index]}));
    const scene = {snakes: active, cols, rows, portal, portalTrace, portalMove};
    const transitions = [];
    for (let index = 0; index < active.length; index++) {
      if (done[index] || snakes[index].locked && !unlockSources[index].some(source => done[source])) continue;
      if (snakes[index].needsTap > 1 && !armed[index]) {
        const nextArmed = armed.slice();nextArmed[index] = true;
        transitions.push({nextDone: done, nextDirs: dirs, nextTurns: turns, nextArmed, action: {type: 'arm', index}});
        continue;
      }
      if (free.call(scene, active[index], dirs[index])) {
        const nextDone = done.slice();nextDone[index] = true;
        transitions.push({nextDone, nextDirs: dirs, nextTurns: turns, nextArmed: armed, action: {type: 'clear', index}});
      }
      if (turns <= 0) continue;
      const start = context.TURN_DIRS.findIndex(d => d[0] === dirs[index][0] && d[1] === dirs[index][1]);
      for (let step = 1; step < context.TURN_DIRS.length; step++) {
        const nextDirection = context.TURN_DIRS[(start + step) % context.TURN_DIRS.length];
        if (!free.call(scene, active[index], nextDirection)) continue;
        const nextDirs = dirs.map(d => d.slice());nextDirs[index] = nextDirection.slice();
        transitions.push({nextDone: done, nextDirs, nextTurns: turns - 1, nextArmed: armed, action: {type: 'turn', index, direction: nextDirection.slice()}});
        break;
      }
    }
    let solutions = 0, firstPath = [];
    for (const transition of transitions) {
      const result = search(transition.nextDone, transition.nextDirs, transition.nextTurns, transition.nextArmed);
      if (result.solutions && !solutions) firstPath = [transition.action, ...result.path];
      solutions = Math.min(10000, solutions + result.solutions);
      if (solutions >= 10000) break;
    }
    const result = {solutions, path: firstPath};memo.set(key, result);return result;
  };
  const solved = search(snakes.map(() => false), directions, turnBudget, snakes.map(() => false));
  const openingMoves = snakes.reduce((count, snake, index) => {
    if (snake.locked) return count;
    const scene = {snakes, cols, rows, portal, portalTrace, portalMove};
    return count + (free.call(scene, snake, snake.d) ? 1 : 0);
  }, 0);
  return {...solved, openingMoves, states, capped};
}

function axisDirection(direction) {
  return Math.abs(direction[0]) ? 'horizontal' : 'vertical';
}

function blockedByCrossAxis(board, cols, rows) {
  for (let index = 0; index < board.length; index++) {
    let [x, y] = board[index].cells.at(-1), [dx, dy] = board[index].d;
    x += dx;y += dy;
    while (x >= 0 && y >= 0 && x < cols && y < rows) {
      const blocker = board.find((snake, other) => other !== index && snake.cells.some(cell => cell[0] === x && cell[1] === y));
      if (blocker) {
        if (axisDirection(board[index].d) !== axisDirection(blocker.d)) return true;
        break;
      }
      x += dx;y += dy;
    }
  }
  return false;
}

function hitPoint(x, y, cs = 40, ox = 0, oy = 0) {
  return {x: ox + (x + .5) * cs, y: oy + (y + .5) * cs};
}

test('body-cell taps resolve to the arrow occupying that cell', () => {
  const bodyArrow = {cells: [[1, 1], [2, 1]], d: [1, 0]};
  const otherArrow = {cells: [[4, 3]], d: [0, -1]};
  assert.equal(resolveArrowHit([bodyArrow, otherArrow], hitPoint(1, 1), 0, 0, 40, 6, 6), bodyArrow);
});

test('head-cell taps resolve to the arrow head', () => {
  const bodyArrow = {cells: [[1, 1], [2, 1]], d: [1, 0]};
  assert.equal(resolveArrowHit([bodyArrow], hitPoint(2, 1), 0, 0, 40, 6, 6), bodyArrow);
});

test('equally close occupied cells prefer the arrow with the closer head', () => {
  const headNear = {cells: [[1, 0], [1, 1]], d: [0, 1]};
  const bodyNear = {cells: [[3, 1], [3, 2]], d: [0, 1]};
  const midpoint = hitPoint(2, 1, 20);
  assert.equal(resolveArrowHit([headNear, bodyNear], midpoint, 0, 0, 20, 6, 6), headNear);
});

test('empty-space taps outside the hit radius resolve to nothing', () => {
  const arrow = {cells: [[1, 1]], d: [1, 0]};
  assert.equal(resolveArrowHit([arrow], hitPoint(5, 5), 0, 0, 40, 6, 6), null);
});

test('TURN rejects a 180-degree turn through a straight arrow body', () => {
  const snake = {cells: [[1, 2], [2, 2], [3, 2]], d: [1, 0]};
  assert.equal(free.call(makeScene(snake), snake, [-1, 0]), false);
});

test('TURN rejects a bent arrow path that enters an earlier segment', () => {
  const snake = {cells: [[1, 2], [2, 2], [2, 1]], d: [0, -1]};
  assert.equal(free.call(makeScene(snake), snake, [0, 1]), false);
});

test('a rotated portal arrow cannot route through its own body', () => {
  const snake = {
    cells: [[1, 2], [2, 2], [3, 2]],
    d: [1, 0],
    portal: {entry: [4, 2], destination: [4, 4], d: [0, 1]}
  };
  assert.equal(free.call(makeScene(snake), snake, [-1, 0]), false);
});

test('portal relocation may overlap the arrow\'s vacated source cells', () => {
  const snake = {
    cells: [[1, 2], [2, 2], [3, 2]],
    d: [1, 0],
    // At arrival the original tail [1,2] has vacated; [2,2] is still occupied by the following body.
    portal: {entry: [4, 2], destination: [1, 2], d: [0, -1]}
  };
  assert.equal(free.call(makeScene(snake), snake), true);
});

test('level 25 arrows in a column all travel through the shared portal', () => {
  const portal = {entry: [5, 4], destination: [6, 0], d: [1, 0]};
  const purple = {cells: [[5, 7], [5, 6], [5, 5]], d: [0, -1]};
  const green = {cells: [[5, 10], [5, 9]], d: [0, -1]};
  const orange = {cells: [[5, 13], [5, 12]], d: [0, -1], isRelay: true};
  const scene = {snakes: [purple, green, orange], portal, cols: 10, rows: 14, portalTrace, portalMove};
  const expectedCells = [
    // Snapshot at head emergence, matching the split-body animation rather than a rigid translation.
    [[5, 6], [5, 5], [6, 0]],
    [[5, 5], [6, 0]],
    [[5, 5], [6, 0]]
  ];
  [purple, green, orange].forEach((arrow, index) => {
    assert.equal(free.call(scene, arrow), true, `arrow ${index} should reach portal A`);
    const moved = portalMove.call(scene, arrow, arrow.d);
    assert.deepEqual(JSON.parse(JSON.stringify(moved.cells)), expectedCells[index]);
    assert.deepEqual(JSON.parse(JSON.stringify(moved.d)), [1, 0]);
    arrow.cells = moved.cells;
    arrow.d = moved.d;
    arrow.done = true;
  });
});

test('a rotated portal arrow still respects its own body', () => {
  const snake = {
    cells: [[1, 2], [2, 2], [3, 2]],
    d: [1, 0],
    portal: {entry: [4, 2], destination: [4, 4], d: [0, 1]}
  };
  const scene = {snakes: [snake], cols: 6, rows: 6, portalTrace, portalMove};
  assert.equal(free.call(scene, snake, [-1, 0]), false);
  assert.equal(portalMove.call(scene, snake, [-1, 0]), null);
});

test('arrows reaching the same portal from different directions teleport', () => {
  const portal = {entry: [4, 4], destination: [8, 8], d: [0, -1]};
  const arrows = [
    {cells: [[4, 5]], d: [0, -1]},
    {cells: [[5, 4]], d: [-1, 0]},
    {cells: [[3, 4]], d: [1, 0]},
    {cells: [[4, 3]], d: [0, 1]}
  ];
  const scene = {snakes: arrows, portal, cols: 10, rows: 10, portalTrace, portalMove};
  arrows.forEach(arrow => {
    assert.equal(free.call(scene, arrow), true);
    const moved = portalMove.call(scene, arrow, arrow.d);
    assert.deepEqual(JSON.parse(JSON.stringify(moved.cells)), [[8, 8]]);
    assert.deepEqual(JSON.parse(JSON.stringify(moved.d)), [0, -1]);
    arrow.cells = moved.cells;
    arrow.d = moved.d;
    arrow.done = true;
  });
});

test('both portal endpoints are entrances and share the exit convention', () => {
  const portal = {entry: [2, 2], destination: [7, 2], d: [0, 1]};
  const fromA = {cells: [[2, 3]], d: [0, -1]};
  const fromB = {cells: [[8, 2]], d: [-1, 0]};
  const scene = {snakes: [fromA, fromB], portal, cols: 10, rows: 10, portalTrace, portalMove};
  assert.equal(free.call(scene, fromA), true);
  const aMove = portalMove.call(scene, fromA, fromA.d);
  assert.deepEqual(JSON.parse(JSON.stringify(aMove.cells)), [[7, 2]]);
  assert.deepEqual(JSON.parse(JSON.stringify(aMove.d)), [0, 1]);
  fromA.done = true;
  assert.equal(free.call(scene, fromB), true);
  const bMove = portalMove.call(scene, fromB, fromB.d);
  assert.deepEqual(JSON.parse(JSON.stringify(bMove.cells)), [[2, 2]]);
  assert.deepEqual(JSON.parse(JSON.stringify(bMove.d)), [0, -1]);
});

test('a reverse portal exit at the board edge is not blocked by a neighboring head', () => {
  const portal = {entry: [0, 2], destination: [3, 2], d: [1, 0]};
  const arrow = {cells: [[4, 2]], d: [-1, 0]};
  const neighbor = {cells: [[1, 2]], d: [1, 0], col: 0xff4d6d};
  const scene = {snakes: [arrow, neighbor], portal, cols: 6, rows: 6, portalTrace, portalMove};
  const trace = portalTrace.call(scene, arrow, arrow.d);
  assert.equal(trace.ok, true);
  assert.equal(trace.sourceEnd, 'B');
  assert.deepEqual(JSON.parse(JSON.stringify(trace.destinationCell)), [0, 2]);
  assert.deepEqual(JSON.parse(JSON.stringify(trace.exitDirection)), [-1, 0]);
  assert.equal(trace.blocker, undefined);
});

test('a forward portal exit at the board edge also ignores a neighboring head', () => {
  const portal = {entry: [2, 2], destination: [5, 2], d: [1, 0]};
  const arrow = {cells: [[1, 2]], d: [1, 0]};
  const neighbor = {cells: [[4, 2]], d: [-1, 0]};
  const scene = {snakes: [arrow, neighbor], portal, cols: 6, rows: 6, portalTrace, portalMove};
  assert.equal(free.call(scene, arrow), true);
});

test('portal exit blockers report the exact arrow and cell', () => {
  const portal = {entry: [2, 2], destination: [5, 2], d: [1, 0]};
  const arrow = {cells: [[6, 2]], d: [-1, 0]};
  const blocker = {cells: [[1, 2]], d: [0, 1], col: 0x80ed99};
  const scene = {snakes: [arrow, blocker], portal, cols: 7, rows: 6, portalTrace, portalMove};
  const trace = portalTrace.call(scene, arrow, arrow.d);
  assert.equal(trace.ok, false);
  assert.equal(trace.reason, 'other-after-portal');
  assert.equal(trace.blocker, blocker);
  assert.deepEqual(JSON.parse(JSON.stringify(trace.cell)), [1, 2]);
});

test('initial undo balance distinguishes missing from explicitly exhausted', () => {
  const missing = {};
  assert.equal(ensureInitialUndo(missing, null), true);
  assert.equal(missing.undos, 1);
  const exhausted = {undos: 0};
  assert.equal(ensureInitialUndo(exhausted, null), false);
  assert.equal(exhausted.undos, 0);
  assert.equal(undoBalanceAfterUse(0, true), 0);
  assert.equal(undoBalanceAfterUse(0, false), 0);
  assert.equal(undoBalanceAfterUse(4, false), 3);
});

test('revive requires a move and is limited per level', () => {
  assert.equal(canRevive(0, 0), false);
  assert.equal(canRevive(1, 0), true);
  assert.equal(canRevive(1, 1), false);
  assert.equal(canRevive(3, 4), false);
});

test('game-over recovery reopens only when no modal owns the screen', () => {
  assert.equal(shouldRestoreGameOverModal(true, false, false, false, false), true);
  assert.equal(shouldRestoreGameOverModal(true, true, false, false, false), false);
  assert.equal(shouldRestoreGameOverModal(true, false, true, false, false), false);
  assert.equal(shouldRestoreGameOverModal(true, false, false, true, false), false);
  assert.equal(shouldRestoreGameOverModal(true, false, false, false, true), false);
});

test('portal animation keeps the snake split across both mouths mid-move', () => {
  const frame = portalBodyAtProgress([[4, 7], [4, 6], [4, 5]], [4, 4], [8, 1], [1, 0], 1, 2, 10, 1.5);
  assert.equal(frame.sourcePoints.length, 2);
  assert.equal(frame.destinationPoints.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(frame.sourcePoints.at(-1))), [4, 4.5]);
  assert.deepEqual(JSON.parse(JSON.stringify(frame.destinationPoints[0])), [8.5, 1]);
  const reverseFrame = portalBodyAtProgress([[8, 4], [8, 3], [8, 2]], [8, 1], [4, 4], [1, 0], 1, 2, 10, 1.5);
  assert.equal(reverseFrame.sourcePoints.length, 2);
  assert.equal(reverseFrame.destinationPoints.length, 1);
});

test('a portal move is blocked when the exit at the other endpoint is occupied', () => {
  const portal = {entry: [2, 2], destination: [6, 2], d: [1, 0]};
  const arrow = {cells: [[2, 3]], d: [0, -1]};
  const blocker = {cells: [[7, 2]], d: [1, 0]};
  const scene = {snakes: [arrow, blocker], portal, cols: 10, rows: 10, portalTrace, portalMove};
  const trace = portalTrace.call(scene, arrow, arrow.d);
  assert.equal(trace.ok, false);
  assert.equal(trace.reason, 'other-after-portal');
  assert.deepEqual(JSON.parse(JSON.stringify(trace.cell)), [7, 2]);
  assert.equal(portalMove.call(scene, arrow, arrow.d), null);
});

test('portal animation timing uses one speed and no portal dwell for every arrow', () => {
  const timings = [0, 1, 2].map(() => portalAnimationTiming(96, 64, 600));
  assert.deepEqual(timings.map(timing => timing.duration), [timings[0].duration, timings[0].duration, timings[0].duration]);
  assert.deepEqual(timings.map(timing => timing.speed), [1200, 1200, 1200]);
  assert.deepEqual(timings.map(timing => timing.delay), [0, 0, 0]);
  const longerApproach = portalAnimationTiming(192, 64, 600);
  assert.ok(Math.abs(longerApproach.duration-timings[0].duration-96/1200*1000)<1e-9);
});

test('daily levels 5 and 10 do not receive campaign gallery rewards', () => {
  for (const level of [5, 10]) {
    assert.equal(context.shapeRewardFor(level, true), null);
    assert.ok(context.shapeRewardFor(level, false));
  }
});

test('campaign generation is deterministic for the same level number', () => {
  const first = context.gen(10, 14, 32, context.campaignRandom(32));
  const restarted = context.gen(10, 14, 32, context.campaignRandom(32));
  assert.equal(JSON.stringify(first), JSON.stringify(restarted));
});

test('campaign and fixed-date Daily generation are deterministic without unseeded randomness', () => {
  const originalRandom = vm.runInContext('Math.random', context);
  context.originalMathRandom = originalRandom;
  vm.runInContext('Math.random=()=>{throw new Error("unseeded generation randomness")}', context);
  try {
    for (let level = 32; level <= 200; level++) {
      const first = context.gen(10, 14, level, context.campaignRandom(level));
      const restarted = context.gen(10, 14, level, context.campaignRandom(level));
      assert.equal(JSON.stringify(first), JSON.stringify(restarted), `campaign level ${level}`);
    }

    const fixedDate = '2026-01-01', seed = context.hashSeed(fixedDate), level = 3 + seed % 12;
    const cols = Math.min(5 + (level >> 1), 10), rows = Math.min(6 + level, 14);
    const first = context.gen(cols, rows, level, context.seededRandom(seed));
    const restarted = context.gen(cols, rows, level, context.seededRandom(seed));
    assert.equal(JSON.stringify(first), JSON.stringify(restarted), `Daily Challenge ${fixedDate}`);
  } finally {
    vm.runInContext('Math.random=originalMathRandom', context);
    delete context.originalMathRandom;
  }
});

test('seeded Fisher–Yates shuffles in place, preserves every item, and avoids Math.random', () => {
  const shuffle = vm.runInContext('shuffle', context);
  const values = ['up', 'right', 'down', 'left', 'relay', 'gate'];
  const first = values.slice(), second = values.slice();
  const originalRandom = vm.runInContext('Math.random', context);
  context.originalMathRandom = originalRandom;
  vm.runInContext('Math.random=()=>{throw new Error("unseeded shuffle")}', context);
  try {
    assert.equal(shuffle(first, context.campaignRandom(117)), first,
      'shuffle retains the in-place return behavior');
    shuffle(second, context.campaignRandom(117));
  } finally {
    vm.runInContext('Math.random=originalMathRandom', context);
    delete context.originalMathRandom;
  }
  assert.equal(JSON.stringify(first), JSON.stringify(second), 'the same seed gives the same order');
  assert.deepEqual(first.slice().sort(), values.slice().sort(), 'every input element appears exactly once');
  assert.notDeepEqual(first, values, 'the fixed regression seed exercises an actual reordering');
});

test('level 11 requires one turn on its highlighted arrow', () => {
  const board = applyCircuitRules(context.showcaseLevel(11, 10, 14), 11);
  const withoutTurn = solveBoard(board, 10, 14, 0);
  const withTurn = solveBoard(board, 10, 14, 1);
  assert.equal(withoutTurn.solutions, 0);
  assert.ok(withTurn.solutions > 0);
  assert.deepEqual(withTurn.path.filter(action => action.type === 'turn').map(action => [action.index, action.direction]), [[2, [0, 1]]]);
  assert.ok(board[2].tutorialTurnTarget);
  assert.match(source, /Turn the highlighted arrow down/);
});

test('mutually blocking locked gates remain solvable through their matching relays', () => {
  const board = applyCircuitRules([
    {cells: [[1, 2], [2, 2]], d: [1, 0]},
    {cells: [[5, 2], [4, 2]], d: [-1, 0]},
    {cells: [[1, 4], [2, 4]], d: [1, 0]},
    {cells: [[1, 0], [2, 0]], d: [1, 0]}
  ], 11);
  const scene = {snakes: board, cols: 8, rows: 6, portalTrace, portalMove};
  assert.equal(free.call(scene, board[0]), false, 'first gate is blocked by the second gate');
  assert.equal(free.call(scene, board[1]), false, 'second gate is blocked by the first gate');

  const solution = solveBoard(board, 8, 6, 2);
  assert.ok(solution.solutions > 0, 'the level 11 turn charges must provide a path through the gate deadlock');
  for (const [gateIndex, relayIndex] of [[0, 3], [1, 2]]) {
    const relayStep = solution.path.findIndex(action => action.type === 'clear' && action.index === relayIndex);
    const gateStep = solution.path.findIndex(action => action.type === 'clear' && action.index === gateIndex);
    assert.ok(relayStep >= 0 && gateStep > relayStep,
      `gate ${gateIndex} must become available only after matching relay ${relayIndex}`);
  }
  assert.match(source, /const required=this\.snakes\.filter\(s=>!s\.done&&s\.unlocks\?\.includes\(locked\)\)/,
    'tapping a locked gate identifies its matching relay');
  assert.match(source, /required\.forEach\(s=>this\.highlightArrowPath\(s,0x00e5ff,980\)\)/,
    'the matching relay is highlighted to the player');
});

test('levels 22–31 solve with spatial blockers and varied paths', () => {
  for (let level = 22; level <= 31; level++) {
    const board = applyCircuitRules(context.showcaseLevel(level, 10, 14), level);
    const result = solveBoard(board, 10, 14, 0);
    assert.ok(result.solutions > 0, `level ${level} has no solution`);
    assert.ok(level === 30 ? result.openingMoves === 1 : result.openingMoves >= 2,
      `level ${level} has an unexpected number of opening choices`);
    assert.ok(board.some(snake => snake.cells.length >= 4), `level ${level} lacks longer paths`);
    assert.ok(blockedByCrossAxis(board, 10, 14), `level ${level} lacks a cross-axis blocker`);
    assert.ok(board.some((snake, index) => snake.isRelay && !free.call({snakes: board, cols: 10, rows: 14, portalTrace, portalMove}, snake, snake.d)),
      `level ${level} has no blocked relay`);
  }
});

test('level 30 has a unique forced solution', () => {
  const board = applyCircuitRules(context.showcaseLevel(30, 10, 14), 30);
  const result = solveBoard(board, 10, 14, 0);
  assert.equal(result.solutions, 1);
  assert.equal(result.path.filter(action => action.type === 'clear').length, board.length);
});

test('authored portal layouts remain solvable with two-way portal rules', () => {
  const authoredLevels = [3, 11, 15, 18, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31];
  const changedSolutionPaths=[];
  authoredLevels.forEach(level => {
    const board = applyCircuitRules(context.showcaseLevel(level, 10, 14), level);
    const result = solveBoard(board, 10, 14, level >= 11 ? 2 : 0);
    const baselineBoard=JSON.parse(JSON.stringify(board));baselineBoard.forEach(snake=>delete snake.portal);
    const baseline=solveBoard(baselineBoard,10,14,level>=11?2:0);
    if(JSON.stringify(result.path)!==JSON.stringify(baseline.path))changedSolutionPaths.push(level);
    assert.ok(result.solutions > 0, `authored level ${level} is no longer solvable`);
  });
  assert.deepEqual(changedSolutionPaths, [], `authored solution paths changed: ${changedSolutionPaths.join(', ')}`);
});

test('procedural portal layouts remain solvable across varied positions and lengths', () => {
  const levels = [32, 36, 44, 52, 68, 84, 101, 128, 151, 176, 200];
  let portalCount = 0;
  levels.forEach(level => {
    const rng = context.campaignRandom(level),board = context.gen(10, 14, level, rng);
    const eligible = board.filter(snake => !snake.isGate && !snake.isRelay && !snake.isSwitch);
    const doubleTapCount = level >= 101 ? 3 : level >= 51 ? 2 : 1;
    for(let index=0;index<doubleTapCount&&eligible.length;index++)eligible.splice(Math.floor(rng()*eligible.length),1)[0].needsTap=2;
    applyCircuitRules(board, level);
    const baseline = solveBoard(JSON.parse(JSON.stringify(board)), 10, 14, 0, 20000);
    const portalScene = {
      snakes: board, cols: 10, rows: 14, portal: null, specials: [], portalTrace,
      boardHasSolution: portal => {
        const candidateBoard = JSON.parse(JSON.stringify(board));candidateBoard[0].portal=portal;
        return solveBoard(candidateBoard, 10, 14, 0, 20000).solutions>0;
      }
    };
    addPortalPair.call(portalScene, rng);
    if(portalScene.portal)portalCount++;
    const result = solveBoard(board, 10, 14, 0, 20000);
    assert.ok(result.solutions > 0, `procedural level ${level} is no longer solvable: baseline=${baseline.solutions} portal=${JSON.stringify(portalScene.portal)} states=${result.states} capped=${result.capped}`);
  });
  assert.ok(portalCount>=3, 'procedural validation did not exercise at least three portal layouts');
});

test('generated campaign boards pass quality and mechanic validation from levels 32–200', () => {
  const levels=[...new Set([...Array.from({length:43},(_,index)=>32+index*4),51,101,151])].sort((a,b)=>a-b);
  for (const level of levels) {
    const board = context.gen(10, 14, level, context.campaignRandom(level));
    const expected = context.expectedMechanics(level);
    const metrics = context.analyzeGeneratedBoard(board, 10, 14, level);
    assert.ok(context.generatedBoardMeetsQuality(board, 10, 14, level, metrics),
      `level ${level} failed quality validation: ${JSON.stringify(metrics)} (${board.length} arrows)`);
    assert.ok(board.length >= Math.max(10, expected.minimumSnakes), `level ${level} lacks arrows for its mechanics`);
    assert.equal(metrics.shortestSolutionLength, board.length + expected.doubleTaps);
    assert.ok(metrics.openingMoves >= 1);
    assert.ok(metrics.averageBranchingFactor <= 4.5);
    const configured = applyCircuitRules(JSON.parse(JSON.stringify(board)), level);
    const gateCount = configured.filter(snake => snake.isGate).length;
    const switchCount = configured.filter(snake => snake.isSwitch).length;
    const eligible = configured.filter(snake => !snake.isGate && !snake.isRelay && !snake.isSwitch);
    assert.equal(gateCount, expected.relayPairs);
    assert.equal(switchCount, (level >= 21 ? 1 : 0) + (level >= 151 ? 1 : 0));
    assert.ok(eligible.length >= expected.doubleTaps, `level ${level} lacks eligible double-tap arrows`);
    const doubleTapIndices = eligible.slice(0, expected.doubleTaps).map(snake => {
      snake.needsTap = 2;return configured.indexOf(snake);
    });
    const solution = solveBoard(configured, 10, 14, 0, 12000);
    assert.ok(solution.solutions > 0, `level ${level} has no solver-confirmed solution`);
    assert.deepEqual(solution.path.filter(action => action.type === 'arm').map(action => action.index).sort((a, b) => a - b),
      doubleTapIndices.sort((a, b) => a - b), `level ${level} did not require its assigned double taps`);
    for (const relay of configured.filter(snake => snake.unlockIndices)) {
      const gateIndex = relay.unlockIndices[0],relayStep = solution.path.findIndex(action => action.type === 'clear' && action.index === configured.indexOf(relay));
      const gateStep = solution.path.findIndex(action => action.type === 'clear' && action.index === gateIndex);
      assert.ok(relayStep >= 0 && gateStep > relayStep, `level ${level} does not require its relay before the gate`);
    }
  }
});

test('seeded campaign boards meet quality and solvability checks for every level 32–200', () => {
  const fallbackLevels = [], invalidLevels = [];
  for (let level = 32; level <= 200; level++) {
    const board = context.gen(10, 14, level, context.campaignRandom(level));
    if (JSON.stringify(board) === JSON.stringify(context.safeFallbackBoard(10, 14, level))) {
      fallbackLevels.push(level);
    }
    const metrics = context.analyzeGeneratedBoard(board, 10, 14, level);
    if (!context.generatedBoardMeetsQuality(board, 10, 14, level, metrics)) {
      invalidLevels.push({level, metrics});
      continue;
    }
    const configured = applyCircuitRules(JSON.parse(JSON.stringify(board)), level);
    const solved = solveBoard(configured, 10, 14, 0, 12000);
    if (!solved.solutions) invalidLevels.push({level, states: solved.states, capped: solved.capped});
  }
  assert.deepEqual(fallbackLevels, [], `fallback used at levels: ${fallbackLevels.join(', ')}`);
  assert.deepEqual(invalidLevels, [], `unsolved or low-quality levels: ${JSON.stringify(invalidLevels)}`);
});

test('Daily Challenge generation is solvable for every supported level 3–14', () => {
  const dailyCases = new Map();
  for (let day = 0; dailyCases.size < 12; day++) {
    const date = new Date(Date.UTC(2026, 0, 1 + day));
    const dateKey = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
    const seed = context.hashSeed(dateKey), level = 3 + seed % 12;
    if (!dailyCases.has(level)) dailyCases.set(level, {dateKey, seed});
  }
  const invalid = [];
  for (const [level, {seed}] of dailyCases) {
    const cols = Math.min(5 + (level >> 1), 10), rows = Math.min(6 + level, 14);
    const board = context.gen(cols, rows, level, context.seededRandom(seed));
    const configured = applyCircuitRules(JSON.parse(JSON.stringify(board)), level);
    const solved = solveBoard(configured, cols, rows, level >= 11 ? 2 : 0);
    if (!solved.solutions) invalid.push({level, states: solved.states, capped: solved.capped});
  }
  assert.deepEqual(invalid, [], `unsolved Daily Challenge levels: ${JSON.stringify(invalid)}`);
  assert.equal(dailyCases.size, 12);
});

test('bounded fallback is deterministic, solvable, and supports level-200 mechanics', () => {
  const first = context.safeFallbackBoard(10, 14, 200);
  const restarted = context.safeFallbackBoard(10, 14, 200);
  assert.equal(JSON.stringify(first), JSON.stringify(restarted));
  const expected = context.expectedMechanics(200),configured = applyCircuitRules(first, 200);
  const eligible = configured.filter(snake => !snake.isGate && !snake.isRelay && !snake.isSwitch);
  assert.ok(configured.length >= expected.minimumSnakes);
  assert.ok(eligible.length >= expected.doubleTaps);
  eligible.slice(0, expected.doubleTaps).forEach(snake => { snake.needsTap = 2; });
  assert.ok(solveBoard(configured, 10, 14, 0, 12000).solutions > 0);
});
