const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).find(script => script.includes('class Play extends'));
assert.ok(source, 'index.html contains the game script');
const classStart = source.indexOf('class Play extends');
let depth = 0, classEnd = -1;
for (let i = source.indexOf('{', classStart); i < source.length; i++) {
  if (source[i] === '{') depth++;
  if (source[i] === '}' && --depth === 0) { classEnd = i + 1; break; }
}
assert.ok(classEnd > classStart, 'could not extract Play');
const plain = value => JSON.parse(JSON.stringify(value));
const NAMES = ['FLAWLESS', 'NO HINTS', 'LOW MOVES'];
const OWNED = ['root', 'surface', 'number', 'play', 'celebrationGlow'];
const medalsFor = mask => NAMES.filter((_, i) => mask & (1 << i));

function loadGame() {
  // Execute the real prelude and prototype, like game-over.test.js; never boot Phaser.
  const context = vm.createContext({URLSearchParams, location: {search: ''}, window: {},
    document: {getElementById: () => ({clientWidth: 360, clientHeight: 640, style: {}})},
    localStorage: {getItem: () => null, setItem() {}}, Phaser: {Scene: class {}}});
  vm.runInContext(source.slice(0, classEnd), context);
  return vm.runInContext('({Play, state:levelSelectTileState, types:LEVEL_MEDAL_TYPES, medalChipLayout:levelSelectMedalChipLayout})', context);
}

function display(x = 0, y = 0) {
  const object = {x, y, alpha: 1, visible: true, scaleX: 1, scaleY: 1, rotation: 0,
    originX: .5, originY: .5, tint: 0xffffff, isTinted: false, text: '', style: {}, ops: [],
    setAlpha(value) { this.alpha = value; return this; },
    setVisible(value) { this.visible = value; return this; },
    setScale(x, y = x) { this.scaleX = x; this.scaleY = y; return this; },
    setRotation(value) { this.rotation = value; return this; },
    setAngle(value) { this.rotation = value * Math.PI / 180; return this; },
    setPosition(x, y = x) { this.x = x; this.y = y; return this; },
    setX(x) { this.x = x; return this; }, setY(y) { this.y = y; return this; },
    setOrigin(x, y = x) { this.originX = x; this.originY = y; return this; },
    setSize(width, height) { Object.assign(this, {width, height}); return this; },
    setDisplaySize(width, height) { return this.setSize(width, height); },
    setDepth(depth) { this.depth = depth; return this; },
    setText(value) { this.text = String(value); return this; },
    setColor(color) { this.style.color = color; return this; },
    setStyle(style) { Object.assign(this.style, style); return this; },
    setFontSize(size) { this.style.fontSize = size; return this; },
    setTint(tint) { this.tint = tint; this.isTinted = tint !== 0xffffff; return this; },
    clearTint() { return this.setTint(0xffffff); },
    setTexture(key) { this.texture = {key}; return this; },
    clear() { this.ops = []; return this; }, destroy() { this.destroyed = true; },
    setInteractive() { return this; }, disableInteractive() { return this; }, on() { return this; }};
  Object.defineProperty(object, 'scale', {get() { return this.scaleX; },
    set(value) { this.scaleX = this.scaleY = value; }});
  for (const method of ['fillStyle', 'lineStyle', 'fillRoundedRect', 'strokeRoundedRect',
    'fillCircle', 'strokeCircle', 'fillRect', 'strokeRect', 'beginPath', 'closePath',
    'moveTo', 'lineTo', 'strokePath', 'fillPath', 'lineBetween', 'fillPoints', 'strokePoints']) {
    object[method] = function (...args) { this.ops.push([method, ...args]); return this; };
  }
  return object;
}

function tweenManager() {
  const records = [], props = ['alpha', 'scale', 'scaleX', 'scaleY', 'rotation', 'x', 'y'];
  const manager = {
    records,
    add(config) {
      const targets = [config.targets].flat(Infinity);
      const tween = {config, targets, active: true, started: false,
        starts: targets.map(target => Object.fromEntries(props.map(key => [key, target[key]]))),
        stop() { this.active = false; return this; }, remove() { return this.stop(); }};
      records.push(tween); return tween;
    },
    killTweensOf(targets) {
      const killed = [targets].flat(Infinity);
      for (const tween of records) if (tween.targets.some(target => killed.includes(target))) tween.stop();
    },
    advance(settle = false) {
      // A finite yoyo ends at its captured start; infinite pulses advance one cycle.
      for (const tween of records.slice()) {
        if (!tween.active) continue;
        const {config, targets, starts} = tween;
        if (!tween.started) { tween.started = true; config.onStart?.(tween, targets); }
        targets.forEach((target, i) => props.forEach(key => {
          if (!(key in config)) return;
          const end = typeof config[key] === 'object' ? config[key].to : config[key];
          target[key] = settle && config.yoyo ? starts[i][key] : end;
        }));
        config.onUpdate?.(tween, targets);
        if (settle && config.repeat !== -1) { tween.stop(); config.onComplete?.(tween, targets); }
      }
    }
  };
  return manager;
}

function fixture() {
  const game = loadGame(), textures = new Map(), tweens = tweenManager();
  const scene = Object.assign(new game.Play(), {tweens,
    textures: {exists: key => textures.has(key)}, add: {graphics() {
      const graphic = display();
      graphic.generateTexture = function (key, width, height) {
        textures.set(key, {width, height, ops: plain(this.ops)}); return this;
      };
      return graphic;
    }}});
  const tile = () => ({level: 0, renderVersion: 0,
    root: display(120, 200), surface: display(), number: display(0, -7.2),
    play: display(0, 25.92).setText('PLAY').setVisible(false), celebrationGlow: display()});
  return {...game, scene, tweens, textures, tile,
    draw(tile, state, celebration = null) { scene.drawLevelSelectTile(tile, state, 72, celebration); }};
}

function snapshot(tile, includeGlow = true) {
  return Object.fromEntries(OWNED.filter(key => includeGlow || key !== 'celebrationGlow').map(key => {
    const o = tile[key];
    return [key, plain({x:o.x, y:o.y, alpha:o.alpha, visible:o.visible,
      scaleX:o.scaleX, scaleY:o.scaleY, rotation:o.rotation, tint:o.tint, isTinted:o.isTinted,
      originX:o.originX, originY:o.originY, text:o.text, style:o.style,
      texture:o.texture?.key, ops:o.ops})];
  }));
}

function profileAt(clears) {
  return {level: clears + 1, results: Object.fromEntries(Array.from({length: clears}, (_, i) =>
    [String(i + 1), {medals: medalsFor((i + clears) % 8), bestMoves: i + 3}]))};
}

function assertCompleted(state, level, medals) {
  assert.equal(state.level, level); assert.equal(state.cleared, true);
  assert.equal(state.locked, false); assert.equal(state.current, false);
  assert.equal(state.playVisible, false); assert.equal(state.rootAlpha, 1);
  assert.equal(state.surfaceAlpha, 1);
  assert.deepEqual(Array.from(state.medals).sort(), medals.slice().sort(), `level ${level}: saved medals`);
  assert.equal(state.allEarned, NAMES.every(name => medals.includes(name)));
}

test('Level Select medal chips give equal padded space to every full label', () => {
  const {medalChipLayout} = loadGame();
  const labels = ['FLAWLESS', 'NO HINTS', 'LOW MOVES'];
  for (const viewportWidth of [320, 360, 414]) {
    const panelWidth = viewportWidth * .96, innerWidth = panelWidth - 44;
    const gap = innerWidth * .025, chipWidth = (innerWidth - gap * 2) / 3;
    const chips = labels.map((_, index) =>
      medalChipLayout(22 + index * (chipWidth + gap), 100, chipWidth, 56));
    assert.ok(chips.every(chip => Math.abs(chip.labelWidth - (chipWidth - 8)) < .001),
      `${viewportWidth}px: every label gets equal inner padding`);
    assert.equal(new Set(chips.map(chip => chip.labelFontSize)).size, 1,
      'all three full labels share one font size');
    assert.equal(new Set(chips.map(chip => chip.countFontSize)).size, 1,
      'all three counts share one font size');
    labels.forEach((label, index) => {
      const estimatedTextWidth = label.length * chips[index].labelFontSize * .62;
      assert.ok(estimatedTextWidth <= chips[index].labelWidth,
        `${viewportWidth}px: ${label} fits without truncation`);
      assert.ok(chips[index].starY < chips[index].labelY &&
        chips[index].labelY < chips[index].countY &&
        chips[index].countY < chips[index].barY,
      `${viewportWidth}px: star, full label, count, and progress bar do not overlap`);
      assert.ok(chips[index].starY + chips[index].starRadius <= chips[index].labelY - 7.2 + 1,
        `${viewportWidth}px: star clears the label`);
      assert.ok(chips[index].labelY + 7.2 <= chips[index].countY -
        chips[index].countFontSize * .6 + 1, `${viewportWidth}px: label clears count`);
      assert.ok(chips[index].countY + chips[index].countFontSize * .6 < chips[index].barY,
        `${viewportWidth}px: count clears progress bar`);
    });
  }
});

test('shared medal definitions retain the three saved names and numeric colors', () => {
  const {types} = loadGame();
  assert.deepEqual(Array.from(types, type => type.name), NAMES);
  for (const type of types) assert.ok(Number.isInteger(type.color) && type.color >= 0 && type.color <= 0xffffff);
});

test('progress 1..10: every saved clear stays bright with every recent index, before/after tween settling', () => {
  const f = fixture();
  for (let progress = 1; progress <= 10; progress++) for (let recent = 0; recent <= progress + 1; recent++) {
    const profile = {...profileAt(progress), levelSelectCelebration: {level: recent, medals: NAMES.slice()}};
    for (let level = 1; level <= progress; level++) {
      const state = f.state(level, profile), tile = f.tile();
      assertCompleted(state, level, profile.results[level].medals);
      f.draw(tile, state, profile.levelSelectCelebration);
      assert.equal(tile.root.alpha, 1); assert.equal(tile.surface.alpha, 1);
      assert.equal(tile.play.visible, false); assert.equal(tile.number.text, String(level));
      assert.equal(tile.number.style.color, state.numberColor);
      const base = snapshot(tile, false);
      f.tweens.advance(); assert.deepEqual(snapshot(tile, false), base, 'pulse never animates base/medals');
      f.tweens.advance(true); assert.deepEqual(snapshot(tile, false), base, 'settled base remains bright');
    }
    f.tweens.records.length = 0;
  }
});

test('progress past 32, 100 and 250 preserves all clears and the exact current/locked boundary', () => {
  const f = fixture();
  for (const progress of [32, 33, 100, 101, 250, 251]) {
    const profile = profileAt(progress);
    for (let level = 1; level <= progress; level++) assertCompleted(f.state(level, profile), level, profile.results[level].medals);
    const current = f.state(progress + 1, profile), locked = f.state(progress + 2, profile);
    assert.equal(current.current, true); assert.equal(current.locked, false); assert.equal(current.playVisible, true);
    assert.equal(current.rootAlpha, 1); assert.equal(current.surfaceAlpha, 1);
    assert.equal(locked.locked, true); assert.equal(locked.current, false); assert.equal(locked.playVisible, false);
    assert.ok(locked.rootAlpha < 1 || locked.surfaceAlpha < 1, 'unplayed future tile is visibly locked');
    for (const level of [1, progress - 1, progress]) {
      const tile = f.tile(), state = f.state(level, profile);
      f.draw(tile, state, {level: level + 1, medals: NAMES}); f.tweens.advance(true);
      assert.equal(tile.surface.alpha, 1); assert.equal(tile.root.alpha, 1); assert.equal(tile.play.visible, false);
    }
  }
});

test('locked level numbers remain high-contrast without brightening the locked tile', () => {
  const f = fixture(), state = f.state(5, {level: 4, results: {}}), tile = f.tile();
  f.draw(tile, state);

  assert.equal(state.numberColor, '#f4f8ff');
  assert.equal(tile.number.style.color, '#f4f8ff');
  assert.equal(state.rootAlpha, .48);
  assert.equal(tile.root.alpha, .48);
  assert.equal(state.surfaceAlpha, 1);
  const texture = f.textures.get(tile.surface.texture.key);
  assert.ok(texture.ops.some(op => op[0] === 'fillStyle' && op[1] === 0x111728 && op[2] === .8),
    'locked tile retains its dark surface');
  assert.ok(texture.ops.filter(op => op[0] === 'strokeRoundedRect').length >= 3,
    'locked tile retains its lock icon and border');
});

test('saved records override stale current/lock pointers; old accessible gaps never invent awards', () => {
  const {state} = loadGame();
  for (const level of [1, 10, 32, 101, 250]) for (const pointer of [1, level, level + 1]) {
    for (let mask = 0; mask < 8; mask++) for (const filter of [null, ...NAMES]) {
      const medals = medalsFor(mask);
      assertCompleted(state(level, {level:pointer, results:{[level]:{medals}}}, filter), level, medals);
    }
  }
  const old = state(5, {level:10, results:{}});
  assert.equal(old.locked, false); assert.equal(old.current, false); assert.equal(old.playVisible, false);
  assert.deepEqual(Array.from(old.medals), []); assert.equal(old.allEarned, false);
});

function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test('pure state ignores recent/daily data, preserves inputs, and filters actual earned medals', () => {
  const {state} = loadGame(), base = profileAt(5);
  for (const recent of [1, 3, 5, 6, 250]) {
    const profile = freeze({...plain(base), levelSelectCelebration:{level:recent, medals:NAMES.slice()},
      daily:true, dailyLevel:250, results:{...plain(base.results),
        'daily:2026-10-18':{medals:NAMES.slice()}, 'daily:1':{medals:NAMES.slice()}}});
    const before = plain(profile);
    for (const filter of [null, ...NAMES]) for (let level = 1; level <= 7; level++) {
      const result = state(level, profile, filter);
      assert.deepEqual(plain(result), plain(state(level, base, filter)), `level ${level}, recent ${recent}`);
      if (level <= 5) assert.equal(result.missingFilteredMedal,
        !!filter && !base.results[level].medals.includes(filter));
    }
    assert.deepEqual(plain(profile), before, 'pure state does not mutate saved profile');
  }
});

test('recent/current effects target only the separate glow and recent -> normal matches a fresh render', () => {
  for (const settleFirst of [false, true]) {
    const f = fixture(), profile = {level:3, results:{'1':{medals:['FLAWLESS', 'LOW MOVES']}}};
    const state = f.state(1, profile), tile = f.tile(), fresh = f.tile();
    for (const recent of [1, 2]) {
      f.draw(tile, state, {level:recent, medals:NAMES});
      for (const tween of f.tweens.records.filter(tween => tween.active))
        assert.ok(tween.targets.every(target => target === tile.celebrationGlow), 'pulse owns only glow');
      f.tweens.advance(settleFirst); f.draw(tile, state); f.draw(fresh, state);
      assert.deepEqual(snapshot(tile), snapshot(fresh), 'normal repaint clears every prior visual');
      f.tweens.advance(true); assert.deepEqual(snapshot(tile), snapshot(fresh), 'old effects cannot dirty settled tile');
    }
    const current = f.tile(); f.draw(current, f.state(3, profile));
    for (const tween of f.tweens.records.filter(tween => tween.active))
      assert.ok(tween.targets.every(target => target === current.celebrationGlow));
    const base = snapshot(current, false); f.tweens.advance();
    assert.deepEqual(snapshot(current, false), base, 'current pulse leaves base surface unchanged');
  }
});

test('pooled locked/current/recent tiles reset all owned visuals and cancel stale tween callbacks', () => {
  for (const previous of ['locked', 'current', 'recent']) for (const sameLevel of [false, true]) {
    const f = fixture(), tile = f.tile(), fresh = f.tile(), profile = profileAt(3);
    const level = previous === 'locked' ? 100 : previous === 'current' ? 4 : 2;
    f.draw(tile, f.state(level, profile), previous === 'recent' ? {level:2, medals:NAMES} : null);
    f.tweens.advance();
    for (const key of OWNED) {
      tile[key].setAlpha(.15).setScale(.7, 1.3).setRotation(.4).setTint(0xff00ff).setVisible(false);
      f.tweens.add({targets:tile[key], alpha:0, duration:100, onComplete() { tile[key].setRotation(2); }});
    }
    tile.celebrationGlow.fillStyle(0xffffff).fillCircle(1, 2, 9);
    const completedLevel = sameLevel ? level : 1;
    profile.results[completedLevel] = {medals:['NO HINTS', 'LOW MOVES']};
    const stale = f.tweens.records.slice(), completed = f.state(completedLevel, profile);
    f.draw(tile, completed); f.draw(fresh, completed);
    assert.ok(stale.every(tween => !tween.active), 'every owned tween was stopped, including root/labels/glow');
    assert.deepEqual(snapshot(tile), snapshot(fresh), `${previous}: repaint is deterministic`);
    f.tweens.advance(true); assert.deepEqual(snapshot(tile), snapshot(fresh), `${previous}: canceled callbacks stay canceled`);
  }
});

test('real cached surface textures distinguish all eight saved medal masks, including equal-count masks', () => {
  const f = fixture(), keys = [], drawings = [];
  for (let mask = 0; mask < 8; mask++) {
    const state = f.state(1, {level:2, results:{'1':{medals:medalsFor(mask)}}});
    const key = f.scene.levelTileSurfaceTexture(state, 72);
    assert.ok(f.textures.has(key), 'the real renderer generated its texture');
    keys.push(key); drawings.push(JSON.stringify(f.textures.get(key)));
    const count = f.textures.size;
    assert.equal(f.scene.levelTileSurfaceTexture(state, 72), key);
    assert.equal(f.textures.size, count, 'repeated state reuses cached texture');
    const tile = f.tile(); f.draw(tile, state); assert.equal(tile.surface.texture.key, key);
  }
  assert.equal(new Set(keys).size, 8, 'cache identity includes the actual earned-mask distribution');
  assert.equal(new Set(drawings).size, 8, 'visible medal drawings change with the earned mask');
});
