const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).find(script => script.includes('class Play extends'));
assert.ok(source, 'index.html must contain the game script');

// As in blocked-feedback.test.js, keep the real Play prototype without booting Phaser.
// Load its prelude too, so new pure helpers are resolved from the implementation itself.
const classStart = source.indexOf('class Play extends');
let depth = 0, classEnd = -1;
for (let i = source.indexOf('{', classStart); i < source.length; i++) {
  if (source[i] === '{') depth++;
  if (source[i] === '}' && --depth === 0) { classEnd = i + 1; break; }
}
assert.ok(classEnd > classStart, 'could not extract Play');
const gameSource = source.slice(0, classEnd);
const TODAY = '2026-10-18';
const W = 360;
const plain = value => JSON.parse(JSON.stringify(value));

function loadGame({height = 640, profile = {level: 25, undos: 3}, onWrite = () => {}} = {}) {
  const storage = new Map([['arrowPathProfile', JSON.stringify({lastRewardDate: TODAY, ...profile})]]);
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [`${TODAY}T12:00:00Z`])); }
    static now() { return Date.parse(`${TODAY}T12:00:00Z`); }
  }
  class Rectangle {
    constructor(x, y, width, height) { Object.assign(this, {x, y, width, height}); }
    static Contains() { return true; }
  }
  const context = vm.createContext({
    Date: FixedDate, URLSearchParams, location: {search: ''}, window: {},
    document: {getElementById: () => ({clientWidth: W, clientHeight: height, style: {}})},
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem(key, value) { storage.set(key, value); onWrite(JSON.parse(value)); }
    },
    Phaser: {Scene: class {}, Geom: {Rectangle}}
  });
  vm.runInContext(gameSource, context);
  const Play = vm.runInContext('Play', context);
  return {context, Play, storage,
    recovery: state => vm.runInContext('gameOverRecoveryState', context)(state)};
}

const states = [
  ['both available, free undo first',
    {historyLength: 2, undos: 3, freeUndoUsed: false, moves: 4, revivesUsed: 0},
    true, 'FREE UNDO', true, 'REVIVE ×1'],
  ['both available, paid undo',
    {historyLength: 2, undos: 3, freeUndoUsed: true, moves: 4, revivesUsed: 0},
    true, 'UNDO ×3', true, 'REVIVE ×1'],
  ['undo available, revive consumed',
    {historyLength: 1, undos: 2, freeUndoUsed: true, moves: 1, revivesUsed: 1},
    true, 'UNDO ×2', false, 'REVIVE USED'],
  ['free undo remains available with no charges',
    {historyLength: 1, undos: 0, freeUndoUsed: false, moves: 1, revivesUsed: 1},
    true, 'FREE UNDO', false, 'REVIVE USED'],
  ['revive available with exhausted undo charges',
    {historyLength: 1, undos: 0, freeUndoUsed: true, moves: 8, revivesUsed: 0},
    false, 'UNDO ×0 · NO CHARGES', true, 'REVIVE ×1'],
  ['neither action available after both budgets are spent',
    {historyLength: 1, undos: 0, freeUndoUsed: true, moves: 8, revivesUsed: 1},
    false, 'UNDO ×0 · NO CHARGES', false, 'REVIVE USED'],
  ['no successful moves, even with resources',
    {historyLength: 0, undos: 5, freeUndoUsed: false, moves: 0, revivesUsed: 0},
    false, 'UNDO · NO MOVES', false, 'REVIVE ×1 · NO MOVES'],
  ['bounded undo history is empty but successful moves still permit revive',
    {historyLength: 0, undos: 2, freeUndoUsed: false, moves: 40, revivesUsed: 0},
    false, 'UNDO · NO MOVES', true, 'REVIVE ×1'],
  ['empty history and a consumed revive cannot offer recovery',
    {historyLength: 0, undos: 2, freeUndoUsed: true, moves: 40, revivesUsed: 1},
    false, 'UNDO · NO MOVES', false, 'REVIVE USED']
];

function assertTruthfulCopy(result) {
  assert.equal(typeof result.body, 'string');
  assert.match(result.body, /restart/i, 'every state offers restart');
  // Reasons can change wording freely. Remove the returned explanations before
  // checking that the remaining advice names only actions that can be performed.
  let advice = result.body;
  const reasons = [result.unavailableReason, result.undoReason, result.reviveReason]
    .filter(reason => typeof reason === 'string' && reason.length > 0)
    .sort((a, b) => b.length - a.length);
  for (const reason of reasons) advice = advice.split(reason).join('');
  for (const [action, available] of [['undo', result.undoAvailable], ['reviv', result.reviveAvailable]]) {
    if (available) assert.match(result.body, new RegExp(action, 'i'), `${action} is advertised when available`);
    else assert.doesNotMatch(advice, new RegExp(action, 'i'), `disabled ${action} must not be offered`);
  }
  for (const action of ['undo', 'revive']) {
    const reason = result[`${action}Reason`];
    if (!result[`${action}Available`]) {
      assert.equal(typeof reason, 'string');
      assert.ok(reason.trim().length > 0, `disabled ${action} explains why`);
    }
  }
  if (!result.undoAvailable && !result.reviveAvailable) {
    assert.equal(typeof result.unavailableReason, 'string');
    assert.ok(result.unavailableReason.trim().length > 0);
    assert.ok(!result.unavailableReason.includes('\n'), 'the unavailable explanation is one short line');
    assert.ok(result.unavailableReason.length <= 180, 'the unavailable explanation stays concise');
    assert.ok(result.body.includes(result.unavailableReason), 'the body includes the unavailable explanation');
  }
}

for (const [name, input, undoAvailable, undoLabel, reviveAvailable, reviveLabel] of states) {
  test(`recovery state: ${name}`, () => {
    const game = loadGame();
    const frozen = Object.freeze({...input});
    const result = plain(game.recovery(frozen));
    assert.deepEqual(Object.keys(result).sort(), [
      'undoAvailable', 'undoLabel', 'undoReason', 'reviveAvailable', 'reviveLabel',
      'reviveReason', 'body', 'unavailableReason'
    ].sort());
    assert.deepEqual({undoAvailable: result.undoAvailable, undoLabel: result.undoLabel,
      reviveAvailable: result.reviveAvailable, reviveLabel: result.reviveLabel},
    {undoAvailable, undoLabel, reviveAvailable, reviveLabel});
    assert.deepEqual(frozen, input, 'the pure function does not modify its input');
    assert.deepEqual(plain(game.recovery(frozen)), result, 'identical inputs have identical output');
    assertTruthfulCopy(result);
  });
}

test('revive availability uses successful moves and the one-use level budget', () => {
  const {context} = loadGame();
  assert.equal(vm.runInContext('MAX_REVIVES_PER_LEVEL', context), 1);
  const canRevive = vm.runInContext('canRevive', context);
  for (const moves of [0, 1, 40]) {
    for (const used of [0, 1, 2]) assert.equal(canRevive(moves, used), moves > 0 && used < 1);
  }
  const calls = [];
  context.canRevive = (moves, used) => { calls.push([moves, used]); return false; };
  const result = vm.runInContext('gameOverRecoveryState', context)({
    historyLength: 0, undos: 0, freeUndoUsed: true, moves: 40, revivesUsed: 0
  });
  assert.ok(calls.some(([moves, used]) => moves === 40 && used === 0),
    'the shared state passes move count, not history length, to canRevive');
  assert.equal(result.reviveAvailable, false, 'the shared state honors canRevive');
});

test('recovery availability and truthful copy cover independent history, charges, moves, and usage', () => {
  const {recovery} = loadGame();
  for (const historyLength of [0, 1, 24]) for (const undos of [0, 1, 4]) {
    for (const freeUndoUsed of [false, true]) for (const moves of [0, 1, 40]) {
      for (const revivesUsed of [0, 1]) {
        const input = {historyLength, undos, freeUndoUsed, moves, revivesUsed};
        const result = recovery(input);
        assert.equal(result.undoAvailable, historyLength > 0 && (!freeUndoUsed || undos > 0), JSON.stringify(input));
        assert.equal(result.reviveAvailable, moves > 0 && revivesUsed < 1, JSON.stringify(input));
        assertTruthfulCopy(result);
      }
    }
  }
});

function box(x, y, width, height) {
  return {left: x, top: y, right: x + width, bottom: y + height, width, height,
    centerX: x + width / 2, centerY: y + height / 2};
}

function display(x = 0, y = 0, width = 0, height = 0) {
  const handlers = new Map(), data = new Map();
  return {
    x, y, width, height, originX: .5, originY: .5, alpha: 1, scaleX: 1, scaleY: 1,
    setOrigin(x, y = x) { this.originX = x; this.originY = y; return this; },
    setDepth(depth) { this.depth = depth; return this; },
    setAlpha(alpha) { this.alpha = alpha; return this; },
    setScale(x, y = x) { this.scaleX = x; this.scaleY = y; return this; },
    setX(x) { this.x = x; return this; },
    setY(y) { this.y = y; return this; },
    setPosition(x, y) { this.x = x; this.y = y; return this; },
    setSize(width, height) { this.width = width; this.height = height; return this; },
    setStrokeStyle() { return this; },
    setInteractive(hitArea) { this.input = {enabled: true, hitArea}; return this; },
    disableInteractive() { if (this.input) this.input.enabled = false; return this; },
    setData(key, value) { data.set(key, value); return this; },
    getData(key) { return data.get(key); },
    on(event, callback) { handlers.set(event, [...(handlers.get(event) || []), callback]); return this; },
    emit(event, ...args) { for (const callback of handlers.get(event) || []) callback(...args); return this; },
    getBounds() {
      return box(this.x - this.width * this.originX, this.y - this.height * this.originY,
        this.width, this.height);
    },
    destroy() { this.destroyed = true; }
  };
}

function drawingTools() {
  const drawing = {texts: [], rectangles: [], containers: []};
  const add = {
    rectangle(x, y, width, height) {
      const object = display(x, y, width, height); drawing.rectangles.push(object); return object;
    },
    text(x, y, text, style = {}) {
      const object = Object.assign(display(x, y), {
        text: String(text), style: {...style},
        setText(value) { this.text = String(value); return this; },
        setFontSize(value) { this.style.fontSize = value; return this; },
        setColor(value) { this.style.color = value; return this; }
      });
      // Approximate canvas text metrics; button hit areas and panel geometry are real values.
      const lines = () => object.text.split('\n').flatMap(line => {
        const width = Number(object.style.wordWrap?.width) || Infinity;
        const count = Math.max(1, Math.floor(width / (parseFloat(object.style.fontSize) * .6)));
        return Array.from({length: Math.max(1, Math.ceil(line.length / count))}, (_, i) => line.slice(i * count, (i + 1) * count));
      });
      Object.defineProperties(object, {
        width: {get: () => Math.max(...lines().map(line => line.length)) * parseFloat(object.style.fontSize) * .6},
        height: {get: () => lines().length * parseFloat(object.style.fontSize) * 1.2 +
          Math.max(0, lines().length - 1) * (object.style.lineSpacing || 0)}
      });
      drawing.texts.push(object); return object;
    },
    graphics() {
      const graphic = display();
      for (const method of ['clear', 'fillStyle', 'fillRoundedRect', 'lineStyle', 'strokeRoundedRect',
        'beginPath', 'moveTo', 'lineTo', 'strokePath']) graphic[method] = function () { return this; };
      return graphic;
    },
    container(x, y, children) {
      const object = Object.assign(display(x, y), {children});
      drawing.containers.push(object); return object;
    }
  };
  return {drawing, add};
}

function fixture({daily = false, height = 640, undos = 3, freeUndoUsed = false,
  revivesUsed = 0, moves = 4, mist = 3, profile: suppliedProfile} = {}) {
  const calls = {restarts: [], messages: [], ads: [], writes: [], animations: [], selected: 0, settings: 0};
  let scene;
  const game = loadGame({height, profile: suppliedProfile || {level: 25, undos},
    onWrite(profile) { calls.writes.push({profile, active: scene?.gameOverActive, mist: scene?.mist}); }});
  const {drawing, add} = drawingTools(), pending = [];
  scene = new game.Play();
  scene.init({level: 25, daily, seed: daily ? 'daily-test-seed' : null});
  Object.assign(scene, {
    undos, revivesUsed, moves, mist, freeAdUses: {hint: false, undo: freeUndoUsed, revives: revivesUsed},
    busy: false, gameOverActive: true, undoHistory: [], undoUsed: false,
    cols: 8, rows: 8, combo: 0, hints: 3, hintsUsed: 0, bonusHints: 0, rotations: 2,
    levelStartedAt: 1000, snakes: [{cells: [[1, 1], [2, 1]], d: [1, 0], done: false, needsTap: 1, tapsLeft: 1}],
    starsT: Array.from({length: 3}, () => display().setAlpha(.32)), add,
    time: {delayedCall(delay, callback) {
      const timer = {delay, callback, removed: false, remove() { this.removed = true; }};
      pending.push(timer); return timer;
    }},
    tweens: {killTweensOf() {}, add(config) { config.onComplete?.(); }},
    scene: {restart(data) { calls.restarts.push(data); }},
    animateModalIn(objects, shade, panel) { calls.animations.push({objects, shade, panel}); },
    animateModalOut(objects, shade, panel, callback) { callback(); },
    showCircuitMessage(message) { calls.messages.push(message); },
    showAdPrompt(...args) { calls.ads.push(args); },
    showLevelSelect() { calls.selected++; }, showSettings() { calls.settings++; },
    playFeedback() {}, render() {}
  });
  function flush() {
    let count = 0;
    while (pending.length) {
      assert.ok(++count <= 100, 'scene timers must settle');
      const timer = pending.sort((a, b) => a.delay - b.delay).shift();
      if (!timer.removed) timer.callback();
    }
  }
  return {...game, scene, calls, drawing, flush};
}

function setHistory(scene, length) {
  for (let i = 0; i < length; i++) scene.captureUndo();
}

function buttons(drawing) { return drawing.containers.filter(object => object.labelText); }

function press(button) {
  assert.equal(button.input?.enabled, true, `${button.labelText.text} must accept input`);
  button.emit('pointerdown', {}, 0, 0, {stopPropagation() {}});
}

test('Play.gameOverOptions delegates the real current values to the pure state', () => {
  const {scene, context} = fixture({moves: 40, undos: 7, freeUndoUsed: true, revivesUsed: 1});
  setHistory(scene, 2);
  const inputs = [], sentinel = {marker: 'pure state result'};
  context.gameOverRecoveryState = input => { inputs.push(plain(input)); return sentinel; };
  assert.equal(scene.gameOverOptions(), sentinel);
  assert.deepEqual(inputs[0], {historyLength: 2, undos: 7, freeUndoUsed: true, moves: 40, revivesUsed: 1});
  scene.undoHistory = []; scene.undos = 0; scene.freeAdUses.undo = false;
  scene.moves = 0; scene.revivesUsed = 0;
  assert.equal(scene.gameOverOptions(), sentinel);
  assert.deepEqual(inputs[1], {historyLength: 0, undos: 0, freeUndoUsed: false, moves: 0, revivesUsed: 1},
    'the consumed-use ledger takes precedence over a stale scene count');
  scene.freeAdUses.revives = 0;
  scene.gameOverOptions();
  assert.equal(inputs[2].revivesUsed, 0);
});

function near(actual, expected, message) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= .5,
    `${message}: expected ${expected}, got ${actual}`);
}

function assertModalLayout(f, height) {
  const controls = buttons(f.drawing), panel = f.calls.animations.at(-1)?.panel;
  assert.equal(controls.length, 5, 'exactly five recovery buttons');
  assert.ok(panel, 'the shared modal has a panel');
  const outer = panel.getBounds(), boxes = controls.map(button => button.getBounds());
  near(outer.centerX, W / 2, 'panel centered');
  const gaps = [];
  boxes.forEach((bounds, index) => {
    assert.ok(bounds.height >= 44, 'each button is at least 44px high');
    near(bounds.centerX, W / 2, 'each button is centered');
    near(bounds.width, boxes[0].width, 'consistent button width');
    assert.ok(bounds.left - outer.left >= 8 && outer.right - bounds.right >= 8, 'horizontal panel padding');
    assert.ok(bounds.top - outer.top >= 8 && outer.bottom - bounds.bottom >= 8, 'vertical panel padding');
    assert.ok(bounds.top >= 0 && bounds.bottom <= height, 'button fits the viewport');
    const label = controls[index].labelText;
    assert.ok(label.width <= bounds.width - 16, 'button label has at least 8px horizontal padding');
    assert.ok(label.height <= bounds.height - 16, 'button label has at least 8px vertical padding');
    if (index) gaps.push(bounds.top - boxes[index - 1].bottom);
  });
  gaps.forEach(gap => { assert.ok(gap >= 8, 'edge-to-edge button gaps are at least 8px'); near(gap, gaps[0], 'equal button gaps'); });
  const body = f.drawing.texts.find(text => text.text === f.scene.gameOverOptions().body);
  assert.ok(body, 'the modal renders the shared recovery body');
  assert.ok(body.getBounds().bottom <= boxes[0].top - 8, 'body and first button have at least 8px separation');
}

test('shared modal layout and disabled actions are consistent for campaign and daily recovery states', () => {
  for (const daily of [false, true]) for (const height of [640, 800]) {
    for (const [name, state, undoAvailable, undoLabel, reviveAvailable, reviveLabel] of states) {
      const f = fixture({daily, height, undos: state.undos, freeUndoUsed: state.freeUndoUsed,
        revivesUsed: state.revivesUsed, moves: state.moves});
      setHistory(f.scene, state.historyLength);
      f.scene.showGameOverModal(); f.flush();
      assertModalLayout(f, height);
      const controls = buttons(f.drawing);
      assert.deepEqual(controls.map(button => button.labelText.text),
        [undoLabel, reviveLabel, daily ? 'RESTART DAILY' : 'RESTART LEVEL', 'LEVEL SELECT', 'SETTINGS'], name);
      assert.equal(controls[0].input?.enabled, undoAvailable, `${name}: undo interactivity`);
      assert.equal(controls[1].input?.enabled, reviveAvailable, `${name}: revive interactivity`);
      controls.slice(2).forEach(button => assert.equal(button.input?.enabled, true));
      assert.equal(f.calls.ads.length, 0, 'showing recovery never opens an ad retry');
    }
  }
});

test('both gameOver branches open the shared modal once, without the daily ad-retry branch', () => {
  for (const daily of [false, true]) {
    const f = fixture({daily});
    f.scene.gameOverActive = false;
    let sharedCalls = 0, dailyFailureCalls = 0;
    const show = f.scene.showGameOverModal;
    f.scene.showGameOverModal = function (...args) { sharedCalls++; return show.apply(this, args); };
    f.scene.showDailyFailure = () => { dailyFailureCalls++; };
    f.scene.gameOver(); f.scene.gameOver(); f.flush();
    assert.equal(sharedCalls, 1, 'duplicate gameOver calls cannot schedule duplicate modals');
    assert.equal(dailyFailureCalls, 0, 'daily goes directly to the shared recovery modal');
    assert.equal(f.scene.gameOverActive, true);
    assert.equal(f.scene.gameOverModalVisible, true);
    assert.equal(buttons(f.drawing).length, 5);
    f.scene.gameOver(); f.flush();
    assert.equal(sharedCalls, 1, 'a visible modal is not reopened');
    assert.equal(f.calls.ads.length, 0);
  }
});

test('modal actions close cleanly and dispatch undo, revive, mode-correct restart, levels, and settings', () => {
  for (const daily of [false, true]) for (let action = 0; action < 5; action++) {
    const f = fixture({daily});
    setHistory(f.scene, 1);
    let undos = 0, revives = 0;
    f.scene.undo = function () { assert.equal(this.busy, false); undos++; };
    f.scene.revive = function () { assert.equal(this.busy, false); revives++; };
    f.scene.showGameOverModal(); f.flush();
    press(buttons(f.drawing)[action]); f.flush();
    assert.equal(f.scene.gameOverModalVisible, false);
    assert.equal(undos, Number(action === 0));
    assert.equal(revives, Number(action === 1));
    assert.equal(f.calls.selected, Number(action === 3));
    assert.equal(f.calls.settings, Number(action === 4));
    assert.equal(f.calls.restarts.length, Number(action === 2));
    if (action === 2) {
      const data = f.calls.restarts[0];
      assert.equal(data.level, 25);
      assert.equal(!!data.daily, daily);
      if (daily) assert.equal(data.seed, 'daily-test-seed');
      assert.ok(!data.restore, 'restart begins a fresh board');
    }
  }
});

// Phaser's scene-restart boundary is mocked. Re-run the real init, then hydrate only
// board/resources that create reads from restoreData; usage flags stay owned by init.
function resumeUndo(f) {
  f.flush();
  assert.ok(f.calls.restarts.length, 'successful undo schedules a scene restart');
  const data = f.calls.restarts.at(-1), restore = data.restore;
  assert.ok(restore, 'undo restarts from a snapshot');
  f.scene.init(data);
  for (const field of ['snakes', 'moves', 'mist', 'undos', 'undoHistory', 'undoUsed', 'combo',
    'hints', 'hintsUsed', 'bonusHints', 'rotations', 'levelStartedAt']) {
    if (Object.prototype.hasOwnProperty.call(restore, field)) f.scene[field] = restore[field];
  }
  f.scene.busy = false;
  return {data, restore};
}

function successfulMove(scene, x) {
  scene.captureUndo();
  scene.moves++;
  scene.snakes[0].cells = [[x, 1], [x + 1, 1]];
}

test('undo pops exactly one successful-move snapshot, free first and then one charge per use', () => {
  const f = fixture({moves: 0, mist: 0, undos: 3});
  for (const x of [2, 3, 4]) successfulMove(f.scene, x);
  const snapshots = plain(f.scene.undoHistory);
  f.scene.mist = 3;
  for (let use = 0; use < 3; use++) {
    f.scene.undo();
    const {data, restore} = resumeUndo(f), expected = snapshots[2 - use];
    assert.equal(restore.moves, expected.moves);
    assert.equal(restore.mist, expected.mist, 'restore the successful-move snapshot, not a failed attempt');
    assert.deepEqual(plain(restore.snakes), expected.snakes);
    assert.deepEqual(plain(restore.undoHistory), snapshots.slice(0, 2 - use));
    assert.equal(restore.undos, 3 - use, 'free use preserves charges; later uses spend one');
    assert.equal(f.scene.profile.undos, 3 - use);
    assert.equal(data.freeAdUses.undo, true);
    assert.equal(restore.freeAdUses.undo, true, 'the snapshot cannot refill the free undo');
    assert.equal(f.scene.freeAdUses.undo, true);
    assert.equal(restore.undoUsed, true);
  }
  assert.equal(f.calls.ads.length, 0);
  assert.equal(JSON.parse(f.storage.get('arrowPathProfile')).undos, 1, 'paid economy persists');
});

test('undo cannot restore while busy, without history, or with spent free use and no charges', () => {
  for (const scenario of ['busy', 'no history', 'no charges']) {
    const f = fixture({undos: scenario === 'no charges' ? 0 : 2, freeUndoUsed: scenario === 'no charges'});
    if (scenario !== 'no history') setHistory(f.scene, 1);
    if (scenario === 'busy') f.scene.busy = true;
    const before = plain({snakes: f.scene.snakes, moves: f.scene.moves, undos: f.scene.undos,
      history: f.scene.undoHistory, uses: f.scene.freeAdUses});
    f.scene.undo(); f.flush();
    assert.equal(f.calls.restarts.length, 0, scenario);
    assert.deepEqual(plain({snakes: f.scene.snakes, moves: f.scene.moves, undos: f.scene.undos,
      history: f.scene.undoHistory, uses: f.scene.freeAdUses}), before, scenario);
  }
});

test('revive restores exactly one star in place without undo history or undo charges', () => {
  for (const historyLength of [0, 2]) for (const freeUndoUsed of [false, true]) {
    const f = fixture({undos: 0, freeUndoUsed, moves: 40});
    setHistory(f.scene, historyLength);
    f.scene.snakes[0].done = true;
    const before = plain({snakes: f.scene.snakes, moves: f.scene.moves, history: f.scene.undoHistory,
      undos: f.scene.undos, undoUsed: f.scene.undoUsed, freeUndoUsed: f.scene.freeAdUses.undo});
    f.scene.revive(); f.flush();
    assert.equal(f.scene.mist, 2, 'one star, not a full mistake reset');
    assert.equal(f.scene.revivesUsed, 1);
    assert.equal(f.scene.freeAdUses.revives, 1);
    assert.equal(f.scene.gameOverActive, false);
    assert.equal(f.scene.busy, false);
    assert.deepEqual(f.scene.starsT.map(star => star.alpha), [1, .32, .32]);
    assert.deepEqual(plain({snakes: f.scene.snakes, moves: f.scene.moves, history: f.scene.undoHistory,
      undos: f.scene.undos, undoUsed: f.scene.undoUsed, freeUndoUsed: f.scene.freeAdUses.undo}), before);
    assert.equal(f.scene.profile.undos, 0);
    assert.equal(f.calls.ads.length, 0, 'revive is independent of ad/undo currency');
    const persisted = f.calls.writes.find(write => write.profile.freeAdUses?.[f.scene.freeAdUseKey]?.revives === 1);
    assert.ok(persisted, 'the consumed revive is persisted');
    assert.equal(persisted.active, true, 'persist the revive before resuming play');
    assert.equal(JSON.parse(f.storage.get('arrowPathProfile')).freeAdUses[f.scene.freeAdUseKey].revives, 1);
  }
});

test('revive rejects busy play, remaining stars, no moves, and an already consumed use', () => {
  for (const change of [{busy: true}, {mist: 0}, {mist: 2}, {moves: 0}, {revivesUsed: 1}]) {
    const f = fixture();
    setHistory(f.scene, 1);
    Object.assign(f.scene, change);
    const before = plain({mist: f.scene.mist, moves: f.scene.moves, snakes: f.scene.snakes,
      history: f.scene.undoHistory, undos: f.scene.undos, uses: f.scene.freeAdUses, revivesUsed: f.scene.revivesUsed});
    const writes = f.calls.writes.length;
    f.scene.revive(); f.flush();
    assert.deepEqual(plain({mist: f.scene.mist, moves: f.scene.moves, snakes: f.scene.snakes,
      history: f.scene.undoHistory, undos: f.scene.undos, uses: f.scene.freeAdUses, revivesUsed: f.scene.revivesUsed}), before);
    assert.equal(f.calls.writes.length, writes);
    assert.equal(f.calls.restarts.length, 0);
    assert.equal(f.calls.ads.length, 0);
  }
});

test('init merges spent free undo and revive usage monotonically across all restore sources', () => {
  for (const daily of [false, true]) {
    const key = daily ? `daily:${TODAY}` : 'level:25';
    for (const consumedIn of ['saved', 'restart', 'snapshot', 'revivesUsed']) {
      const uses = {hint: false, undo: false, revives: 0};
      const profile = {level: 25, undos: 0, freeAdUses: {[key]: {...uses}}};
      const data = {level: 25, daily, seed: 'same-seed', freeAdUses: {...uses},
        restore: {freeAdUses: {...uses}, revivesUsed: 0}};
      if (consumedIn === 'saved') profile.freeAdUses[key] = {...uses, undo: true, revives: 1};
      if (consumedIn === 'restart') data.freeAdUses = {...uses, undo: true, revives: 1};
      if (consumedIn === 'snapshot') data.restore.freeAdUses = {...uses, undo: true, revives: 1};
      if (consumedIn === 'revivesUsed') data.restore.revivesUsed = 1;
      const {Play} = loadGame({profile}), scene = new Play();
      scene.init(data);
      assert.equal(scene.freeAdUses.undo, consumedIn !== 'revivesUsed', `${consumedIn}: free undo merge`);
      assert.equal(scene.revivesUsed, 1, `${consumedIn}: revive merge`);
      assert.equal(scene.freeAdUses.revives, 1, `${consumedIn}: stored usage agrees`);
      scene.init({level: 25, daily, seed: 'same-seed'});
      assert.equal(scene.revivesUsed, 1, `${consumedIn}: a plain restart cannot refill revive`);
      assert.equal(scene.freeAdUses.undo, consumedIn !== 'revivesUsed', `${consumedIn}: restart cannot refill free undo`);
    }
    const {Play} = loadGame({profile: {level: 25, undos: 0,
      freeAdUses: {'level:24': {undo: true, revives: 1}, 'daily:2026-10-17': {undo: true, revives: 1}}}});
    const scene = new Play(); scene.init({level: 25, daily});
    assert.equal(scene.freeAdUses.undo, false, 'usage is scoped to the current level/daily key');
    assert.equal(scene.revivesUsed, 0);
  }
});

test('init merges independent consumed resources instead of choosing one usage object', () => {
  for (const daily of [false, true]) {
    const key = daily ? `daily:${TODAY}` : 'level:25';
    const {Play} = loadGame({profile: {level: 25, undos: 0,
      freeAdUses: {[key]: {hint: false, undo: true, revives: 0}}}});
    const scene = new Play();
    scene.init({level: 25, daily, freeAdUses: {hint: false, undo: false, revives: 0},
      restore: {freeAdUses: {hint: false, undo: false, revives: 1}, revivesUsed: 0}});
    assert.equal(scene.freeAdUses.undo, true, 'preserve the saved spent free undo');
    assert.equal(scene.freeAdUses.revives, 1, 'preserve revive usage from the snapshot');
    assert.equal(scene.revivesUsed, 1, 'a stale explicit revive count cannot mask consumed usage');
  }
});

test('revive → undo → fail → restart cycles cannot farm revive or free undo', () => {
  for (const daily of [false, true]) {
    const f = fixture({daily, moves: 0, mist: 0, undos: 2});
    successfulMove(f.scene, 3); successfulMove(f.scene, 4);
    f.scene.mist = 3;
    f.scene.revive(); f.flush();
    assert.equal(f.scene.revivesUsed, 1);
    f.scene.undo();
    const {restore} = resumeUndo(f);
    assert.equal(restore.revivesUsed, 1, 'old pre-revive snapshots cannot refill revive');
    assert.equal(restore.freeAdUses.revives, 1);
    assert.equal(f.scene.revivesUsed, 1);
    assert.equal(f.scene.freeAdUses.undo, true);
    assert.equal(f.scene.undos, 2, 'the first actual undo is still free after revive');
    f.scene.mist = 3; f.scene.gameOverActive = true;
    f.scene.revive(); f.flush();
    assert.equal(f.scene.mist, 3, 'a second failure cannot be revived');
    assert.equal(f.scene.revivesUsed, 1);
    f.scene.undo(); resumeUndo(f);
    assert.equal(f.scene.undos, 1, 'the second undo consumes a charge');
    assert.equal(f.scene.profile.undos, 1);
    assert.equal(f.scene.revivesUsed, 1);
    f.scene.init({level: 25, daily, seed: daily ? 'daily-test-seed' : null});
    assert.equal(f.scene.freeAdUses.undo, true, 'plain restart cannot refill free undo');
    assert.equal(f.scene.freeAdUses.revives, 1, 'plain restart cannot refill revive');
    assert.equal(f.scene.revivesUsed, 1);
    const saved = JSON.parse(f.storage.get('arrowPathProfile'));
    const fresh = loadGame({profile: saved}), reloaded = new fresh.Play();
    reloaded.init({level: 25, daily});
    assert.equal(reloaded.freeAdUses.undo, true, 'consumed free undo survives profile read-back');
    assert.equal(reloaded.revivesUsed, 1, 'consumed revive survives profile read-back');
  }
});

test('undo → fail → revive → undo keeps the free use spent and never charges for revive', () => {
  for (const daily of [false, true]) {
    const f = fixture({daily, moves: 0, mist: 0, undos: 2});
    for (const x of [2, 3, 4]) successfulMove(f.scene, x);
    f.scene.undo(); resumeUndo(f);
    assert.equal(f.scene.freeAdUses.undo, true);
    assert.equal(f.scene.undos, 2);
    f.scene.mist = 3; f.scene.gameOverActive = true;
    const history = plain(f.scene.undoHistory), board = plain(f.scene.snakes);
    f.scene.revive(); f.flush();
    assert.equal(f.scene.mist, 2);
    assert.equal(f.scene.freeAdUses.undo, true);
    assert.equal(f.scene.undos, 2, 'revive cannot spend a paid undo after the free use is gone');
    assert.equal(f.scene.profile.undos, 2);
    assert.deepEqual(plain(f.scene.undoHistory), history);
    assert.deepEqual(plain(f.scene.snakes), board);
    f.scene.undo(); resumeUndo(f);
    assert.equal(f.scene.undos, 1);
    assert.equal(f.scene.profile.undos, 1);
    assert.equal(f.scene.revivesUsed, 1);
    assert.equal(f.scene.freeAdUses.undo, true);
    f.scene.mist = 3; f.scene.gameOverActive = true;
    f.scene.revive(); f.flush();
    assert.equal(f.scene.mist, 3, 'the older snapshot cannot make a second revive available');
  }
});
