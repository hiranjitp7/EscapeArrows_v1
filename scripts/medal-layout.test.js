const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).find(script => script.includes('function gen('));
const W = 360;
const DEFAULT_CONTENT_WIDTH = 316;
const KEYS = ['FLAWLESS', 'NO HINTS', 'LOW MOVES'];
const LABELS = ['FLAWLESS', 'NO HINTS', 'FEW MOVES'];
const STATES = ['current', 'past', 'locked'];
const STATUS = {current: 'EARNED', past: 'BEST RUN', locked: 'LOCKED'};
const combinations = STATES.flatMap(a => STATES.flatMap(b => STATES.map(c => [a, b, c])));

// Use the same isolated method/VM approach as game-logic.test.js, without booting Phaser.
function extractMethod(name) {
  const match = new RegExp(`^\\s*${name}\\s*\\(`, 'm').exec(source);
  assert.ok(match, `index.html must define the shared ${name} method`);
  const start = match.index;
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

function loadMethod(name, height = 640, globals = {}) {
  return vm.runInNewContext(`({${extractMethod(name)}}).${name}`, {
    W, H: height, FONT: 'sans-serif', MIN_READABLE_FONT_SIZE: 12, MODAL_SIDE_PADDING: 22,
    UI_Y: y => y + (height - 640) / 2,
    modalInnerWidth: width => Math.max(1, width - 44),
    ...globals
  });
}

function bounds(x, y, width, height) {
  return {x, y, width, height, left: x, right: x + width, top: y, bottom: y + height,
    centerX: x + width / 2, centerY: y + height / 2};
}

function near(actual, expected, tolerance, message) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected} +/- ${tolerance}, received ${actual}`);
}

function contains(outer, inner, message, tolerance = 1) {
  assert.ok([inner.left, inner.right, inner.top, inner.bottom].every(Number.isFinite),
    `${message} has finite coordinates`);
  assert.ok(inner.left >= outer.left - tolerance && inner.right <= outer.right + tolerance &&
    inner.top >= outer.top - tolerance && inner.bottom <= outer.bottom + tolerance,
    `${message} must fit its chip: ${JSON.stringify({outer, inner})}`);
}

function makeDisplay(x = 0, y = 0) {
  return {
    x, y, originX: 0, originY: 0, alpha: 1, scaleX: 1, scaleY: 1,
    setOrigin(x, y = x) { this.originX = x; this.originY = y; return this; },
    setDepth(depth) { this.depth = depth; return this; },
    setX(x) { this.x = x; return this; },
    setY(y) { this.y = y; return this; },
    setPosition(x, y = x) { this.x = x; this.y = y; return this; },
    setAlpha(alpha) { this.alpha = alpha; return this; },
    setScale(x, y = x) { this.scaleX = x; this.scaleY = y; return this; },
    setSize(width, height) { this.width = width; this.height = height; return this; },
    setStrokeStyle() { return this; },
    setInteractive() { return this; },
    disableInteractive() { return this; },
    on() { return this; },
    destroy() { this.destroyed = true; }
  };
}

function makeDrawingScene(properties = {}) {
  const drawing = {texts: [], rectangles: [], strokes: [], stars: []};
  const scene = {
    level: 1, daily: false,
    lockHeaderForModal() {},
    add: {
      text(x, y, text, style = {}) {
        const object = Object.assign(makeDisplay(x, y), {
          text: String(text), style: {...style},
          setText(text) { this.text = String(text); return this; },
          setStyle(style) { Object.assign(this.style, style); return this; },
          setFontSize(size) { this.style.fontSize = size; return this; },
          setColor(color) { this.style.color = color; return this; },
          getBounds() {
            return bounds(this.x - this.displayWidth * this.originX,
              this.y - this.displayHeight * this.originY, this.displayWidth, this.displayHeight);
          }
        });
        // Approximate one-line canvas metrics; positioning still uses the renderer's measured width.
        Object.defineProperties(object, {
          width: {get() { return Math.max(...this.text.split('\n').map(line => line.length)) *
            parseFloat(this.style.fontSize) * .62; }},
          height: {get() { return this.text.split('\n').length * parseFloat(this.style.fontSize) * 1.2; }},
          displayWidth: {get() { return this.width * this.scaleX; }},
          displayHeight: {get() { return this.height * this.scaleY; }}
        });
        drawing.texts.push(object);
        return object;
      },
      graphics(config = {}) {
        let paths = [], fill = {}, line = {};
        const graphic = Object.assign(makeDisplay(config.x, config.y), {
          fillStyle(color, alpha = 1) { fill = {color, alpha}; return this; },
          lineStyle(width, color, alpha = 1) { line = {width, color, alpha}; return this; },
          fillRoundedRect(x, y, width, height) {
            drawing.rectangles.push({graphic, x, y, width, height, ...fill}); return this;
          },
          fillRect(x, y, width, height) { return this.fillRoundedRect(x, y, width, height); },
          beginPath() { paths = []; return this; },
          moveTo(x, y) { paths.push([{x, y}]); return this; },
          lineTo(x, y) { if (!paths.length) paths.push([]); paths.at(-1).push({x, y}); return this; },
          closePath() { if (paths.at(-1)?.length) paths.at(-1).push(paths.at(-1)[0]); return this; },
          strokePath() {
            paths.forEach(points => drawing.strokes.push({graphic, points: points.slice(), ...line}));
            return this;
          },
          strokePoints(points, close = false) {
            const copied = Array.from(points, point => ({x: point.x, y: point.y}));
            if (close && copied.length) copied.push(copied[0]);
            drawing.strokes.push({graphic, points: copied, ...line}); return this;
          },
          lineBetween(x1, y1, x2, y2) {
            drawing.strokes.push({graphic, points: [{x: x1, y: y1}, {x: x2, y: y2}], ...line});
            return this;
          },
          fillPath() { return this; },
          fillCircle() { return this; },
          strokeCircle() { return this; },
          strokeRoundedRect() { return this; },
          clear() { return this; }
        });
        return graphic;
      },
      rectangle(x, y, width, height) { return makeDisplay(x, y).setSize(width, height); },
      circle(x, y, radius) { return makeDisplay(x, y).setSize(radius * 2, radius * 2); },
      container(x, y, children) { return Object.assign(makeDisplay(x, y), {children}); }
    },
    drawStar(graphic, x, y, radius, color, alpha = 1) {
      drawing.stars.push({graphic, x, y, radius, color, alpha});
    },
    ...properties
  };
  return {scene, drawing};
}

function medalInputs(states, includeCurrentInRecord = true) {
  return {
    medalDefs: KEYS.map((key, index) => [key, states[index] === 'current', `description ${index}`]),
    recordMedals: KEYS.filter((key, index) => states[index] === 'past' ||
      includeCurrentInRecord && states[index] === 'current')
  };
}

function render(states, {width = DEFAULT_CONTENT_WIDTH, height = 640, level = 1,
  daily = false, includeCurrentInRecord = true} = {}) {
  const {scene, drawing} = makeDrawingScene({level, daily});
  const {medalDefs, recordMedals} = medalInputs(states, includeCurrentInRecord);
  loadMethod('drawCompletionMedals', height).call(scene, medalDefs, recordMedals, width);
  return drawing;
}

function rectangleBounds(rectangle) {
  return bounds(rectangle.x + rectangle.graphic.x, rectangle.y + rectangle.graphic.y,
    rectangle.width, rectangle.height);
}

function strokePoints(stroke) {
  return stroke.points.map(point => ({x: point.x + stroke.graphic.x, y: point.y + stroke.graphic.y}));
}

function pointBounds(points, padding = 0) {
  const left = Math.min(...points.map(point => point.x)) - padding;
  const top = Math.min(...points.map(point => point.y)) - padding;
  return bounds(left, top, Math.max(...points.map(point => point.x)) + padding - left,
    Math.max(...points.map(point => point.y)) + padding - top);
}

function hasCheckShape(strokes) {
  const segments = strokes.flatMap(stroke => {
    const points = strokePoints(stroke);
    return points.slice(1).map((point, index) => {
      const previous = points[index];
      return previous.x <= point.x ? [previous, point] : [point, previous];
    });
  });
  // A check descends to a shared elbow, then rises to the right; do not prescribe its exact vertices.
  return segments.some(([a, elbow]) => elbow.x > a.x && elbow.y > a.y &&
    segments.some(([join, end]) => Math.hypot(join.x - elbow.x, join.y - elbow.y) <= 1.5 &&
      end.x > join.x && end.y < join.y));
}

function assertLayout(drawing, states, width = DEFAULT_CONTENT_WIDTH, height = 640) {
  const top = 382 + (height - 640) / 2;
  const chips = drawing.rectangles.map(rectangleBounds).sort((a, b) => a.left - b.left);
  assert.equal(chips.length, 3, 'exactly three medal chips');
  assert.equal(drawing.texts.length, 6, 'only the three labels and three plain-text status lines');
  assert.equal(drawing.stars.length, 3, 'one top star per chip');
  near(chips[0].left, (W - width) / 2, 1, 'group left edge respects content width');
  near(chips[2].right, (W + width) / 2, 1, 'group right edge respects content width');
  near((chips[0].left + chips[2].right) / 2, W / 2, .5, 'group is centered');
  const gaps = chips.slice(1).map((chip, index) => chip.left - chips[index].right);
  gaps.forEach(gap => near(gap, 8, 2, 'roughly 8px gap'));
  near(gaps[0], gaps[1], .5, 'equal chip gaps');

  const labelSizes = [], statusSizes = [], labelRows = [], statusRows = [], starRows = [];
  const usedStrokes = new Set();
  chips.forEach((chip, index) => {
    near(chip.top, top, .5, 'chip top uses UI_Y(382)');
    near(chip.height, 54, .5, 'chip height');
    near(chip.width, chips[0].width, .5, 'equal chip widths');
    contains(bounds(0, 0, W, height), chip, 'chip');
    const texts = drawing.texts.filter(text => text.getBounds().centerX >= chip.left &&
      text.getBounds().centerX <= chip.right);
    assert.equal(texts.length, 2, `chip ${index} has a label and status`);
    const label = texts.find(text => text.text === LABELS[index]);
    const status = texts.find(text => text.text === STATUS[states[index]]);
    assert.ok(label, `chip ${index} displays ${LABELS[index]}`);
    assert.ok(status, `chip ${index} displays ${STATUS[states[index]]}`);
    [label, status].forEach(text => {
      assert.ok(!text.text.includes('\n'), 'medal text stays on one line');
      assert.ok(!(Number(text.style.wordWrap?.width) > 0), 'medal text does not enable word wrapping');
      assert.ok(parseFloat(text.style.fontSize) >= 12, 'medal font is at least 12px');
      contains(chip, text.getBounds(), text.text);
    });
    const labelBox = label.getBounds(), statusBox = status.getBounds();
    labelSizes.push(parseFloat(label.style.fontSize));
    statusSizes.push(parseFloat(status.style.fontSize));
    labelRows.push(labelBox.centerY); statusRows.push(statusBox.centerY);
    near(labelBox.centerX, chip.centerX, 1.5, 'label centered in chip');
    assert.ok(labelBox.bottom <= statusBox.top + 1, 'label and status do not overlap');

    const stars = drawing.stars.filter(star => star.x + star.graphic.x >= chip.left &&
      star.x + star.graphic.x <= chip.right);
    assert.equal(stars.length, 1, `chip ${index} has one star`);
    const star = stars[0], starX = star.x + star.graphic.x, starY = star.y + star.graphic.y;
    assert.ok(star.radius > 0 && star.alpha * star.graphic.alpha > 0, 'top star is visible');
    near(starX, chip.centerX, 1.5, 'star centered above the label');
    starRows.push(starY);
    contains(chip, bounds(starX - star.radius, starY - star.radius, star.radius * 2, star.radius * 2), 'star');
    assert.ok(starY + star.radius <= labelBox.top + 2, 'star sits above the label');

    const checks = drawing.strokes.filter(stroke => {
      const box = pointBounds(strokePoints(stroke));
      return box.centerX >= chip.left && box.centerX <= chip.right &&
        Math.abs(box.centerY - statusBox.centerY) <= statusBox.height;
    });
    checks.forEach(stroke => usedStrokes.add(stroke));
    if (states[index] === 'locked') {
      assert.equal(checks.length, 0, 'locked medals have no check');
      near(statusBox.centerX, chip.centerX, 1.5, 'LOCKED centered without a check');
    } else {
      assert.ok(checks.length > 0 && hasCheckShape(checks), `${status.text} has a separate vector check`);
      checks.forEach(stroke => assert.ok(stroke.width > 0 && stroke.alpha * stroke.graphic.alpha > 0,
        'check strokes are visible'));
      const checkBox = pointBounds(checks.flatMap(strokePoints), Math.max(...checks.map(stroke => stroke.width)) / 2);
      contains(chip, checkBox, 'vector check');
      assert.ok(checkBox.width >= 5 && checkBox.height >= 3, 'check is visibly sized');
      const gap = statusBox.left - checkBox.right;
      assert.ok(gap >= 0 && gap <= 10, `check immediately precedes ${status.text} (gap ${gap})`);
      near(checkBox.centerY, statusBox.centerY, 3, 'check aligns with the status line');
      near((checkBox.left + statusBox.right) / 2, chip.centerX, 2.5, 'whole check-plus-status group centered');
    }
  });
  assert.equal(usedStrokes.size, drawing.strokes.length, 'all vector strokes belong to status checks');
  for (const [name, values] of [['label font sizes', labelSizes], ['status font sizes', statusSizes],
    ['label row', labelRows], ['status row', statusRows], ['star row', starRows]]) {
    values.forEach(value => near(value, values[0], .5, `consistent ${name}`));
  }
}

test('completion medal geometry and states cover all 27 current/past/locked combinations', async t => {
  for (const states of combinations) {
    await t.test(states.join(' / '), () => assertLayout(render(states), states));
  }
});

test('current-run awards take precedence even before being merged into the record', () => {
  for (const states of combinations.filter(states => states.includes('current'))) {
    assertLayout(render(states, {includeCurrentInRecord: false}), states);
  }
});

test('medal geometry follows supplied content width and vertically shifted UI coordinates', () => {
  const states = ['current', 'past', 'locked'];
  for (const width of [300, DEFAULT_CONTENT_WIDTH, 332]) {
    for (const height of [640, 800]) assertLayout(render(states, {width, height}), states, width, height);
  }
});

test('locked top stars are dimmer than both current-run and best-run stars', () => {
  const brightness = star => {
    const color = star.color;
    return (((color >> 16) & 255) * .2126 + ((color >> 8) & 255) * .7152 + (color & 255) * .0722) *
      star.alpha * star.graphic.alpha;
  };
  const current = render(['current', 'current', 'current']);
  const past = render(['past', 'past', 'past']);
  const locked = render(['locked', 'locked', 'locked']);
  locked.stars.forEach((star, index) => {
    assert.ok(brightness(star) < brightness(current.stars[index]), 'locked star dimmer than earned');
    assert.ok(brightness(star) < brightness(past.stars[index]), 'locked star dimmer than best run');
  });
});

function geometrySnapshot(drawing) {
  // Normalize nested style values created in separate VM realms before comparing snapshots.
  return JSON.parse(JSON.stringify({
    chips: drawing.rectangles.map(rectangleBounds),
    texts: drawing.texts.map(text => ({text: text.text, style: text.style, bounds: text.getBounds()})),
    stars: drawing.stars.map(({graphic, ...star}) => ({...star, x: star.x + graphic.x, y: star.y + graphic.y})),
    strokes: drawing.strokes.map(stroke => ({points: strokePoints(stroke), width: stroke.width,
      color: stroke.color, alpha: stroke.alpha}))
  }));
}

test('the shared renderer has the same layout for campaign and daily levels', () => {
  const states = ['current', 'past', 'locked'];
  const expected = geometrySnapshot(render(states));
  for (const level of [1, 5, 11, 18, 31, 32, 101, 250]) {
    for (const daily of [false, true]) {
      const drawing = render(states, {level, daily});
      assertLayout(drawing, states);
      assert.deepEqual(geometrySnapshot(drawing), expected, `level ${level}, daily=${daily}`);
    }
  }
});

test('win delegates every campaign/daily clear to the shared renderer without extra medal chips', () => {
  const today = '2026-10-18';
  const win = loadMethod('win', 640, {
    dateKey: () => today, writeProfile() {},
    COLLECTION_ITEMS: [{id: 'house', name: 'HOUSE', level: 5}, {id: 'gem', name: 'PRISM GEM', level: 250}],
    Phaser: {Geom: {Rectangle: class Rectangle { static Contains() { return true; } }}},
    containerHitArea: (width, height) => ({x: 0, y: 0, width, height})
  });
  for (const level of [1, 5, 18, 32, 250]) {
    for (const daily of [false, true]) {
      for (const states of [['current', 'current', 'current'], ['current', 'past', 'locked'],
        ['locked', 'locked', 'locked']]) {
        const {recordMedals} = medalInputs(states, false);
        const expectedMedals = medalInputs(states).recordMedals;
        const resultKey = daily ? `daily:${today}` : String(level);
        const calls = [], pending = [];
        const reward = !daily && level === 5 ? {id: 'house', name: 'HOUSE'} : null;
        const {scene, drawing} = makeDrawingScene({
          level, daily, mist: states[0] === 'current' ? 0 : 1,
          hintsUsed: states[1] === 'current' ? 0 : 1,
          moves: states[2] === 'current' ? 3 : 10,
          snakes: [{}, {}, {}], initialRotations: 2, rotations: 2,
          shapeId: reward?.id || null, shapeReward: reward,
          theme: {name: 'Neon Metro', colors: [0xff4d6d, 0xffb703, 0x4cc9f0]},
          profile: {level: 300, gallery: [], results: {
            [resultKey]: {bestTime: 20, bestMoves: 5, medals: recordMedals.slice()}
          }},
          time: {delayedCall(delay, callback) { pending.push({delay, callback}); }},
          tweens: {add() {}}, playFeedback() {}, comboBurst() {}, markButton() {}, drawCollectibleArt() {},
          drawCompletionMedals(medalDefs, recordMedals, contentWidth) {
            calls.push({medalDefs: Array.from(medalDefs, medal => Array.from(medal)),
              recordMedals: Array.from(recordMedals), contentWidth});
          }
        });
        win.call(scene);
        // Flush the scheduled clear overlay and celebration effects, leaving button callbacks untouched.
        while (pending.length) pending.sort((a, b) => a.delay - b.delay).shift().callback();
        const description = `level ${level}, daily=${daily}, ${states.join('/')}`;
        assert.equal(calls.length, 1, `${description}: one shared medal render`);
        const call = calls[0];
        assert.deepEqual(call.medalDefs.map(medal => medal[0]), KEYS, `${description}: medal keys`);
        assert.deepEqual(call.medalDefs.map(medal => medal[1]), states.map(state => state === 'current'),
          `${description}: current-run medal flags`);
        assert.deepEqual(call.recordMedals.slice().sort(), expectedMedals.slice().sort(), `${description}: stored medals`);
        assert.equal(call.contentWidth, DEFAULT_CONTENT_WIDTH, `${description}: shared content width`);
        assert.equal(drawing.stars.length, 0, `${description}: win does not render its own medal stars`);
        const chipBand = box => box.centerY >= 382 && box.centerY < 436;
        assert.equal(drawing.texts.filter(text => chipBand(text.getBounds())).length, 0,
          `${description}: no inline medal labels or statuses`);
        assert.equal(drawing.rectangles.map(rectangleBounds).filter(chipBand).length, 0,
          `${description}: no inline chip backgrounds`);
        assert.equal(drawing.strokes.filter(stroke => chipBand(pointBounds(strokePoints(stroke)))).length, 0,
          `${description}: no inline status checks`);
      }
    }
  }
});
