const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).find(script => script.includes('function gen('));
assert.ok(source, 'index.html must contain the game script');

function extractBraced(marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `Could not find ${marker}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Could not extract ${marker}`);
}

const today = '2026-10-18';
const context = vm.createContext({
  Phaser: {Scene: class {}}, URLSearchParams, location: {search: ''},
  TURN_DIRS: [[0, -1], [1, 0], [0, 1], [-1, 0]],
  readProfile: () => ({level: 25, undos: 1, lastRewardDate: today}),
  writeProfile() {}, dateKey: () => today
});
vm.runInContext(source.match(/const MAX_REVIVES_PER_LEVEL=[^;]+;/)[0], context);
for (const marker of ['const ARROW_COLOR_NAMES=', 'function portalExitDirection(', 'function ensureInitialUndo(',
  'function canRevive(', 'function gameOverRecoveryState(', 'function undoBalanceAfterUse(', 'function smoothPath(']) {
  vm.runInContext(extractBraced(marker), context);
}
// As in game-logic.test.js, execute extracted game logic without booting Phaser.
// Keeping Play's prototype also makes any shared reset helper available unchanged.
const Play = vm.runInContext(`(${extractBraced('class Play extends')})`, context);

function label() {
  return {
    text: '', alpha: 1, scale: 1,
    setText(text) { this.text = text; return this; },
    setAlpha(alpha) { this.alpha = alpha; return this; },
    setScale(scale) { this.scale = scale; return this; },
    setColor() { return this; }
  };
}

function arrow(cells, d, col = 0x4cc9f0) {
  return {cells, d, col, body: cells.map(cell => cell.slice()),
    done: false, locked: false, needsTap: 1, tapsLeft: 1};
}

const portal = () => ({entry: [6, 6], destination: [6, 1], d: [0, -1]});

function makeScene() {
  const calls = {messages: [], paths: [], cells: [], feedback: [], animations: 0, kills: 0, gameOvers: 0};
  const scene = new Play();
  scene.init({level: 25});
  Object.assign(scene, {
    cols: 8, rows: 8, cs: 20, portal: portal(), level: 25, reducedMotion: true,
    // Each arrow is blocked by the next, including C -> A, without needing a move.
    snakes: [arrow([[1, 2], [2, 2]], [1, 0]),
      arrow([[3, 2], [3, 3]], [0, 1], 0x80ed99),
      arrow([[3, 5], [2, 5]], [0, -1], 0xff4d6d)],
    mist: 0, combo: 4, lastT: 1000, busy: false, moves: 0, rotations: 2, undos: 1,
    undoHistory: [], freeAdUses: {}, levelStartedAt: null,
    comboT: label(), rotateT: label(), starsT: Array.from({length: 3}, label),
    tweens: {
      killTweensOf() { calls.kills++; },
      add(config) { calls.animations++; config.onComplete?.(); },
      chain(config) { calls.animations++; config.onComplete?.(); }
    },
    time: {delayedCall(delay, callback) { callback(); return {remove() {}}; }},
    showCircuitMessage(text) { calls.messages.push(text); },
    highlightArrowPath(s) { calls.paths.push(s); },
    highlightBoardCell(cell) { calls.cells.push(Array.from(cell)); },
    playFeedback(kind) { calls.feedback.push(kind); },
    render() {}, tapPulse() {}, drawArrowMarker() {}, refreshResourceLabels() {},
    out(s) { s.done = true; },
    // Keep the real gameOver scheduling/state; only the Phaser modal is a boundary.
    showGameOverModal() { calls.gameOvers++; this.gameOverModalVisible = true; }
  });
  return {scene, calls};
}

function assertCellHighlighted(calls, cell) {
  assert.ok(calls.cells.some(([x, y]) => x === cell[0] && y === cell[1]),
    `expected highlighted cell ${JSON.stringify(cell)}, got ${JSON.stringify(calls.cells)}`);
}

test('the first blocked attempt costs a mistake; repeats of that arrow are free', () => {
  const {scene} = makeScene(), [a] = scene.snakes;
  assert.equal(scene.registerBlockedAttempt(a), true);
  const counter = scene.boardChangeCounter, key = scene.lastBlockedAttemptKey;
  assert.ok(Number.isInteger(counter), 'the board change counter is initialized');
  assert.ok(key, 'the last attempt has an opaque composite key');
  for (let i = 0; i < 4; i++) assert.equal(scene.registerBlockedAttempt(a), false);
  assert.equal(scene.boardChangeCounter, counter);
  assert.equal(scene.lastBlockedAttemptKey, key);
});

test('interleaving A, B, A charges every arrow change on the same board', () => {
  const {scene} = makeScene(), [a, b] = scene.snakes;
  const before = scene.failureBoardState();
  let previousKey;
  const results = [a, b, a, b, a].map(s => {
    const charged = scene.registerBlockedAttempt(s);
    assert.ok(scene.lastBlockedAttemptKey);
    assert.notEqual(scene.lastBlockedAttemptKey, previousKey);
    previousKey = scene.lastBlockedAttemptKey;
    assert.equal(scene.registerBlockedAttempt(s), false, 'only an immediate repeat is free');
    return charged;
  });
  assert.deepEqual(results, [true, true, true, true, true]);
  assert.equal(scene.failureBoardState(), before);
});

test('different arrow identities charge even with identical geometry and direction', () => {
  const {scene} = makeScene();
  const a = arrow([[1, 2], [2, 2]], [1, 0]);
  const b = arrow([[1, 2], [2, 2]], [1, 0]);
  scene.snakes = [a, b];
  assert.equal(scene.registerBlockedAttempt(a), true);
  const counter = scene.boardChangeCounter, keyA = scene.lastBlockedAttemptKey;
  assert.equal(scene.registerBlockedAttempt(a), false);
  assert.equal(scene.registerBlockedAttempt(b), true);
  assert.notEqual(scene.lastBlockedAttemptKey, keyA);
  assert.equal(scene.registerBlockedAttempt(b), false);
  assert.equal(scene.registerBlockedAttempt(a), true);
  assert.equal(scene.boardChangeCounter, counter, 'arrow selection does not change the board');
});

const boardChanges = [
  ['another arrow\'s cells', scene => scene.snakes[2].cells[0][0]++],
  ['another arrow\'s direction', scene => { scene.snakes[2].d[0] = 1; scene.snakes[2].d[1] = 0; }],
  ['done', scene => { scene.snakes[2].done = true; }],
  ['locked', scene => { scene.snakes[2].locked = true; }],
  ['tapsLeft', scene => { scene.snakes[2].tapsLeft = 2; }],
  ['needsTap', scene => { scene.snakes[2].needsTap = 2; }],
  ['columns', scene => scene.cols++],
  ['rows', scene => scene.rows++],
  ['portal removal', scene => { scene.portal = null; }],
  ['portal addition', scene => { scene.portal = portal(); }, scene => { scene.portal = null; }]
];
for (const owner of ['shared', 'arrow']) {
  for (const field of ['entry', 'destination', 'd']) {
    boardChanges.push([`${owner} portal ${field}`, scene => {
      const p = owner === 'shared' ? scene.portal : scene.snakes[2].portal;
      if (field === 'd') p.d = [1, 0];
      else p[field][0]++;
    }, scene => {
      if (owner === 'arrow') { scene.portal = null; scene.snakes[2].portal = portal(); }
    }]);
  }
}
for (const [name, change, prepare = () => {}] of boardChanges) {
  test(`changing ${name} changes the board signature and charges the same last arrow again`, () => {
    const {scene} = makeScene(), [a] = scene.snakes;
    prepare(scene);
    const before = scene.failureBoardState();
    assert.equal(typeof before, 'string');
    assert.equal(scene.registerBlockedAttempt(a), true);
    assert.equal(scene.registerBlockedAttempt(a), false);
    const counter = scene.boardChangeCounter, key = scene.lastBlockedAttemptKey;
    change(scene);
    assert.notEqual(scene.failureBoardState(), before);
    assert.equal(scene.registerBlockedAttempt(a), true);
    assert.ok(scene.boardChangeCounter > counter, 'direct gameplay changes advance the counter');
    assert.notEqual(scene.lastBlockedAttemptKey, key);
    assert.equal(scene.registerBlockedAttempt(a), false);
  });
}

test('mistake/combo counters and visual graphics do not change the signature or reset failures', () => {
  const {scene} = makeScene(), [a] = scene.snakes;
  scene.snakes[2].portal = portal();
  const before = scene.failureBoardState();
  scene.registerBlockedAttempt(a);
  const counter = scene.boardChangeCounter, key = scene.lastBlockedAttemptKey;
  scene.mist = 2; scene.combo = 9; scene.lastT = 2000;
  scene.starsT[0].setAlpha(.32);
  const graphic = {alpha: .5}; graphic.scene = graphic; // Real Phaser graphics have cycles.
  a.g = graphic; a.marker = graphic; a.body = [[100, 200]]; a.drawDir = [0, 1];
  scene.portal.g = graphic;
  scene.snakes[2].portal.g = graphic;
  assert.equal(scene.failureBoardState(), before);
  assert.equal(scene.registerBlockedAttempt(a), false);
  assert.equal(scene.boardChangeCounter, counter);
  assert.equal(scene.lastBlockedAttemptKey, key);
});

for (const method of ['resetBlockedAttempts', 'captureUndo', 'init']) {
  test(`${method} clears the last-attempt exemption even with identical board geometry`, () => {
    const {scene} = makeScene(), [a] = scene.snakes;
    const before = scene.failureBoardState();
    scene.fail(a);
    scene.fail(a);
    assert.equal(scene.mist, 1);
    const counter = scene.boardChangeCounter, key = scene.lastBlockedAttemptKey;
    if (method === 'init') scene.init({level: 25}); // Phaser restart reuses the scene instance.
    else scene[method]();
    assert.equal(scene.failureBoardState(), before);
    assert.ok(scene.boardChangeCounter > counter);
    assert.ok(!scene.lastBlockedAttemptKey, 'reset clears the remembered attempt');
    scene.fail(a);
    assert.equal(scene.mist, 2, 'the same last arrow is charged after reset');
    assert.notEqual(scene.lastBlockedAttemptKey, key);
    scene.fail(a);
    assert.equal(scene.mist, 2, 'the immediate repeat is free in the new epoch');
    if (method === 'init') {
      const restartedCounter = scene.boardChangeCounter;
      scene.init({level: 25});
      assert.ok(scene.boardChangeCounter > restartedCounter, 'subsequent restarts stay monotonic');
      assert.ok(!scene.lastBlockedAttemptKey);
      assert.equal(scene.registerBlockedAttempt(a), true);
    }
  });
}

for (const action of ['arming', 'rotation', 'clearing']) {
  test(`successful ${action} resets failures through captureUndo`, () => {
    const {scene} = makeScene(), [a, , mover] = scene.snakes;
    Object.assign(mover, {cells: [[5, 4]], d: [1, 0], body: [[5, 4]]});
    if (action === 'arming') { mover.needsTap = 2; mover.tapsLeft = 2; }
    const previous = {d: mover.d.slice(), done: mover.done, tapsLeft: mover.tapsLeft};
    const before = scene.failureBoardState();
    scene.fail(a);
    scene.fail(a);
    assert.equal(scene.mist, 1);
    const counter = scene.boardChangeCounter;
    if (action === 'rotation') scene.rotateArrow(mover, [0, -1]);
    else scene.commitArrow(mover);
    assert.equal(scene.undoHistory.length, 1, 'the successful action captured undo');
    assert.equal(scene.moves, 1);
    assert.ok(scene.boardChangeCounter > counter);
    assert.ok(!scene.lastBlockedAttemptKey);
    if (action === 'arming') assert.equal(mover.tapsLeft, 1);
    else if (action === 'rotation') assert.deepEqual(Array.from(mover.d), [0, -1]);
    else assert.equal(mover.done, true);
    // Restore geometry without registering a failure in between: a signature-only reset cannot pass.
    Object.assign(mover, previous);
    assert.equal(scene.failureBoardState(), before);
    scene.fail(a);
    assert.equal(scene.mist, 2, 'the same last arrow charges even after restoring identical geometry');
    scene.fail(a);
    assert.equal(scene.mist, 2);
  });
}

test('turning another arrow away and back still resets the last blocked attempt', () => {
  const {scene} = makeScene(), [a, , mover] = scene.snakes;
  Object.assign(mover, {cells: [[5, 4]], d: [1, 0], body: [[5, 4]]});
  const before = scene.failureBoardState();
  scene.fail(a);
  const counter = scene.boardChangeCounter;
  scene.rotateArrow(mover, [0, -1]);
  const turnedCounter = scene.boardChangeCounter;
  scene.rotateArrow(mover, [1, 0]);
  assert.equal(scene.undoHistory.length, 2);
  assert.equal(scene.moves, 2);
  assert.equal(scene.rotations, 0);
  assert.equal(scene.failureBoardState(), before);
  assert.ok(turnedCounter > counter);
  assert.ok(scene.boardChangeCounter > turnedCounter);
  assert.ok(!scene.lastBlockedAttemptKey);
  scene.fail(a);
  assert.equal(scene.mist, 2);
  scene.fail(a);
  assert.equal(scene.mist, 2);
});

for (const method of ['animateModalIn', 'animateModalOut']) {
  test(`${method} clears the same-geometry last-arrow exemption for screen transitions`, () => {
    const {scene} = makeScene(), [a] = scene.snakes;
    const before = scene.failureBoardState();
    scene.fail(a);
    const counter = scene.boardChangeCounter;
    let closed = false;
    if (method === 'animateModalOut') scene.animateModalOut([], null, null, () => { closed = true; });
    else scene.animateModalIn([]);
    if (method === 'animateModalOut') assert.equal(closed, true);
    assert.equal(scene.failureBoardState(), before);
    assert.ok(scene.boardChangeCounter > counter);
    assert.ok(!scene.lastBlockedAttemptKey);
    scene.fail(a);
    assert.equal(scene.mist, 2);
    scene.fail(a);
    assert.equal(scene.mist, 2);
  });
}

for (const reverse of [false, true]) {
  test(`${reverse ? 'B -> A' : 'A -> B'}: portal feedback names the exit blocker and highlights blocker/exit cells`, () => {
    const {scene, calls} = makeScene();
    scene.portal = {entry: [2, 2], destination: [6, 2], d: [1, 0]};
    const moving = arrow([reverse ? [7, 2] : [1, 2]], reverse ? [-1, 0] : [1, 0]);
    const blocker = arrow([reverse ? [1, 2] : [7, 2]], [0, 1], reverse ? 0xff4d6d : 0x80ed99);
    scene.snakes = [moving, blocker];
    scene.firstAvailableExit = () => [0, -1];
    const trace = scene.portalTrace(moving);
    assert.equal(trace.reason, 'other-after-portal');
    assert.equal(trace.blocker, blocker);
    const message = `EXIT BLOCKED BY ${reverse ? 'PINK' : 'GREEN'} ARROW`;
    assert.equal(scene.blockedMoveMessage(moving, trace), message);
    scene.showBlockedMoveFeedback(moving, trace);
    assert.deepEqual(calls.messages, [message]);
    assert.ok(calls.paths.includes(blocker), 'highlight the actual blocker, not the moving arrow');
    assert.ok(!calls.paths.includes(moving));
    assertCellHighlighted(calls, trace.cell);
    assertCellHighlighted(calls, trace.destinationCell);
  });
}

test('a self-blocked portal exit says THIS ARROW and highlights the collision and destination', () => {
  const {scene, calls} = makeScene(), [moving] = scene.snakes;
  const trace = {ok: false, reason: 'self-after-portal', cell: [5, 1], destinationCell: [6, 1]};
  scene.firstAvailableExit = () => [0, -1];
  assert.equal(scene.blockedMoveMessage(moving, trace), 'EXIT BLOCKED BY THIS ARROW');
  scene.showBlockedMoveFeedback(moving, trace);
  assert.deepEqual(calls.messages, ['EXIT BLOCKED BY THIS ARROW']);
  assertCellHighlighted(calls, trace.cell);
  assertCellHighlighted(calls, trace.destinationCell);
});

test('normal blockers retain their color message and optional alternate direction', () => {
  const {scene, calls} = makeScene(), [moving, blocker] = scene.snakes;
  const trace = scene.portalTrace(moving);
  assert.equal(trace.reason, 'other-before-portal');
  for (const alternate of [null, [0, -1]]) {
    scene.firstAvailableExit = s => { assert.equal(s, moving); return alternate; };
    const message = `BLOCKED BY GREEN ARROW${alternate ? ' · TRY UP' : ''}`;
    assert.equal(scene.blockedMoveMessage(moving, trace), message);
    scene.showBlockedMoveFeedback(moving, trace);
    assert.equal(calls.messages.at(-1), message);
    assert.equal(calls.paths.at(-1), blocker);
    assertCellHighlighted(calls, trace.cell);
  }
});

test('fail under reducedMotion repeats feedback without penalties, combo resets, or failure effects', () => {
  const {scene, calls} = makeScene(), [a, blocker] = scene.snakes;
  scene.fail(a);
  assert.equal(scene.mist, 1);
  assert.equal(scene.combo, 0);
  assert.deepEqual(scene.starsT.map(star => star.alpha), [1, 1, .32]);
  assert.deepEqual(calls.feedback, ['fail']);

  scene.combo = 5; scene.lastT = 1234;
  scene.comboT.setText('5×').setAlpha(1).setScale(1.2);
  let removed = 0, stopped = 0;
  const timer = scene.comboHideTimer = {remove() { removed++; }};
  const tween = scene.comboFadeTween = {stop() { stopped++; }};
  const kills = calls.kills;
  for (let i = 0; i < 4; i++) scene.fail(a);
  assert.equal(scene.mist, 1);
  assert.equal(scene.combo, 5);
  assert.equal(scene.lastT, 1234);
  assert.deepEqual([scene.comboT.text, scene.comboT.alpha, scene.comboT.scale], ['5×', 1, 1.2]);
  assert.equal(scene.comboHideTimer, timer);
  assert.equal(scene.comboFadeTween, tween);
  assert.deepEqual([removed, stopped, calls.kills - kills, calls.animations], [0, 0, 0, 0]);
  assert.deepEqual(scene.starsT.map(star => star.alpha), [1, 1, .32]);
  assert.deepEqual(calls.feedback, ['fail']);
  assert.equal(calls.gameOvers, 0);
  assert.equal(scene.busy, false);
  assert.equal(calls.messages.length, 5, 'every repeated failure still explains the blocker');
  assert.equal(calls.paths.length, 5);
  assert.ok(calls.paths.every(s => s === blocker));
  assert.equal(calls.cells.length, 5);
  assertCellHighlighted(calls, blocker.cells[0]);
});

test('fail A, repeat A, fail B, successful move, fail A spends the final star', () => {
  const {scene, calls} = makeScene(), [a, b] = scene.snakes;
  const mover = arrow([[5, 4]], [1, 0]);
  scene.snakes.push(mover);
  scene.fail(a);
  assert.equal(scene.mist, 1);
  scene.fail(a);
  assert.equal(scene.mist, 1);
  scene.fail(b);
  assert.equal(scene.mist, 2);
  assert.equal(calls.gameOvers, 0);
  assert.deepEqual(scene.starsT.map(star => star.alpha), [1, .32, .32]);
  const counter = scene.boardChangeCounter;
  scene.commitArrow(mover);
  assert.equal(mover.done, true);
  assert.equal(scene.moves, 1);
  assert.equal(scene.undoHistory.length, 1);
  assert.ok(scene.boardChangeCounter > counter);
  assert.ok(!scene.lastBlockedAttemptKey);
  scene.fail(a);
  assert.equal(scene.mist, 3);
  assert.equal(calls.gameOvers, 1);
  assert.equal(scene.gameOverActive, true);
  assert.deepEqual(calls.feedback, ['fail', 'fail', 'fail']);
  assert.deepEqual(scene.starsT.map(star => star.alpha), [.32, .32, .32]);
});

test('the first failure of a different arrow at mist=2 immediately triggers game over', () => {
  const {scene, calls} = makeScene(), [a, b] = scene.snakes;
  scene.mist = 2;
  scene.starsT.forEach((star, index) => star.setAlpha(index === 0 ? 1 : .32));
  scene.registerBlockedAttempt(a);
  scene.fail(a);
  assert.equal(scene.mist, 2);
  assert.equal(calls.gameOvers, 0);
  scene.fail(b);
  assert.equal(scene.mist, 3);
  assert.equal(calls.gameOvers, 1);
  assert.equal(scene.gameOverActive, true);
  assert.deepEqual(calls.feedback, ['fail']);
  assert.deepEqual(scene.starsT.map(star => star.alpha), [.32, .32, .32]);
});

test('unchanged last-arrow attempts through commitArrow remain free with only one star left', () => {
  const {scene, calls} = makeScene(), [a, b] = scene.snakes;
  scene.fail(a);
  scene.fail(b);
  assert.equal(scene.mist, 2);
  scene.combo = 7; scene.lastT = 4321;
  const counter = scene.boardChangeCounter, key = scene.lastBlockedAttemptKey;
  for (let i = 0; i < 6; i++) scene.commitArrow(b);
  assert.equal(scene.mist, 2);
  assert.equal(scene.combo, 7);
  assert.equal(scene.lastT, 4321);
  assert.equal(scene.moves, 0);
  assert.equal(scene.undoHistory.length, 0);
  assert.equal(scene.boardChangeCounter, counter);
  assert.equal(scene.lastBlockedAttemptKey, key);
  assert.equal(calls.gameOvers, 0);
  assert.equal(scene.busy, false);
  assert.deepEqual(calls.feedback, ['fail', 'fail']);
  assert.deepEqual(scene.starsT.map(star => star.alpha), [1, .32, .32]);
});

test('A -> B -> A charges all three attempts and triggers game over on an unchanged board', () => {
  const {scene, calls} = makeScene(), [a, b] = scene.snakes;
  const before = scene.failureBoardState();
  scene.fail(a);
  assert.equal(scene.mist, 1);
  const counter = scene.boardChangeCounter;
  scene.fail(b);
  assert.equal(scene.mist, 2);
  assert.equal(calls.gameOvers, 0);
  scene.fail(a);
  assert.equal(scene.mist, 3);
  assert.equal(scene.boardChangeCounter, counter, 'switching arrows is not a board change');
  assert.equal(scene.failureBoardState(), before);
  assert.equal(calls.gameOvers, 1);
  assert.deepEqual(calls.feedback, ['fail', 'fail', 'fail']);
  assert.deepEqual(scene.starsT.map(star => star.alpha), [.32, .32, .32]);
});

test('changing the blocked direction and then returning to it charges each direction change', () => {
  const {scene, calls} = makeScene();
  const a = arrow([[3, 3]], [1, 0]);
  scene.portal = null;
  scene.snakes = [a, arrow([[4, 3]], [0, -1]), arrow([[3, 4]], [1, 0])];
  const before = scene.failureBoardState();
  assert.equal(scene.free(a), false);
  scene.fail(a);
  scene.fail(a);
  assert.equal(scene.mist, 1);
  const counter = scene.boardChangeCounter, key = scene.lastBlockedAttemptKey;
  a.d = [0, 1];
  assert.equal(scene.free(a), false);
  scene.fail(a);
  assert.equal(scene.mist, 2);
  assert.ok(scene.boardChangeCounter > counter);
  assert.notEqual(scene.lastBlockedAttemptKey, key);
  scene.fail(a);
  assert.equal(scene.mist, 2);
  const turnedCounter = scene.boardChangeCounter;
  a.d = [1, 0];
  assert.equal(scene.failureBoardState(), before);
  scene.fail(a);
  assert.equal(scene.mist, 3);
  assert.ok(scene.boardChangeCounter > turnedCounter);
  assert.notEqual(scene.lastBlockedAttemptKey, key, 'returning to a direction cannot reuse its old exemption');
  assert.equal(calls.gameOvers, 1);
  assert.deepEqual(scene.starsT.map(star => star.alpha), [.32, .32, .32]);
});

test('real revive resets the last-arrow exemption without changing board geometry', () => {
  const {scene, calls} = makeScene(), [a, b, c] = scene.snakes;
  const mover = arrow([[5, 4]], [1, 0]);
  scene.snakes.push(mover);
  scene.commitArrow(mover); // A real successful move makes revive available.
  for (const s of [a, b, c]) scene.fail(s);
  assert.equal(scene.mist, 3);
  assert.equal(calls.gameOvers, 1);
  assert.equal(scene.gameOverOptions().reviveAvailable, true);
  const before = scene.failureBoardState(), history = scene.undoHistory;
  const counter = scene.boardChangeCounter, key = scene.lastBlockedAttemptKey;
  // The real modal's close callback releases input before dispatching revive.
  scene.gameOverModalVisible = false; scene.busy = false;
  scene.revive();
  assert.equal(scene.mist, 2);
  assert.equal(scene.revivesUsed, 1);
  assert.equal(scene.freeAdUses.revives, 1);
  assert.equal(scene.profile.freeAdUses[scene.freeAdUseKey].revives, 1);
  assert.equal(scene.gameOverActive, false);
  assert.equal(scene.busy, false);
  assert.deepEqual(scene.starsT.map(star => star.alpha), [1, .32, .32]);
  assert.equal(scene.failureBoardState(), before);
  assert.equal(scene.undoHistory, history);
  assert.equal(scene.moves, 1);
  assert.equal(scene.undos, 1);
  assert.ok(scene.boardChangeCounter > counter);
  assert.ok(!scene.lastBlockedAttemptKey);
  scene.fail(c);
  assert.equal(scene.mist, 3, 'the same last arrow spends the revived star');
  assert.notEqual(scene.lastBlockedAttemptKey, key);
  assert.equal(calls.gameOvers, 2);
  assert.equal(scene.gameOverActive, true);
  assert.deepEqual(scene.starsT.map(star => star.alpha), [.32, .32, .32]);
});

test('animated failures also charge only once and do not replay the failure lunge on repeat', () => {
  const {scene, calls} = makeScene(), [moving] = scene.snakes;
  let flashes = 0, destroyed = 0;
  Object.assign(scene, {reducedMotion: false, time: {now: 1000},
    cameras: {main: {flash() { flashes++; }}},
    add: {graphics() { return {setDepth() { return this; }, destroy() { destroyed++; }}; }}
  });
  scene.fail(moving);
  assert.equal(scene.mist, 1);
  assert.equal(scene.busy, false, 'animation completion releases input');
  assert.deepEqual([calls.animations, flashes, destroyed], [1, 1, 1]);
  scene.fail(moving);
  assert.equal(scene.mist, 1);
  assert.deepEqual([calls.animations, flashes, destroyed], [1, 1, 1]);
  assert.equal(calls.messages.length, 2);
});
