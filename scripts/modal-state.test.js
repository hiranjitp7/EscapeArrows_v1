const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).find(script => script.includes('class Play extends'));
assert.ok(source, 'index.html must contain the game script');

const classStart = source.indexOf('class Play extends');
let depth = 0, classEnd = -1;
for (let index = source.indexOf('{', classStart); index < source.length; index++) {
  if (source[index] === '{') depth++;
  if (source[index] === '}' && --depth === 0) { classEnd = index + 1; break; }
}
assert.ok(classEnd > classStart, 'could not extract Play');

function extractMethod(name) {
  const start = source.indexOf(`  ${name}(`, classStart);
  assert.ok(start >= 0, `could not find ${name}`);
  const opening = /\)\s*\{/g;
  opening.lastIndex = start;
  const match = opening.exec(source);
  const open = match ? match.index + match[0].lastIndexOf('{') : -1;
  assert.ok(Number.isInteger(open), `could not find the body of ${name}`);
  let braces = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === '{') braces++;
    if (source[index] === '}' && --braces === 0) return source.slice(start, index + 1);
  }
  throw new Error(`could not extract ${name}`);
}

function makeScene() {
  const context = vm.createContext({
    URLSearchParams,
    location: {search: ''},
    window: {},
    document: {getElementById: () => ({clientWidth: 360, clientHeight: 640, style: {}})},
    localStorage: {getItem: () => null, setItem() {}},
    Phaser: {Scene: class {}}
  });
  vm.runInContext(source.slice(0, classEnd), context);
  const Play = vm.runInContext('Play', context);
  const scene = new Play();
  scene.headerObjects = Array.from({length: 8}, () => ({
    visible: true,
    destroyed: false,
    setVisible(value) { this.visible = value; return this; }
  }));
  scene.resetBlockedAttempts = () => {};
  scene.tweens = {add() {}, killTweensOf() {}};
  scene.time = {delayedCall(_delay, callback) { callback(); }};
  scene.input = {enabled: false};
  return scene;
}

test('header buttons stay hidden until the outermost modal closes', () => {
  for (const entryPoint of ['campaign settings', 'daily settings', 'game over']) {
    const scene = makeScene();
    scene.animateModalIn([]);
    assert.ok(scene.headerObjects.every(object => !object.visible), `${entryPoint} hides header`);

    scene.animateModalIn([]);
    scene.animateModalOut([], null, null);
    assert.ok(scene.headerObjects.every(object => !object.visible),
      `${entryPoint}: closing a nested overlay keeps the parent modal active`);

    scene.animateModalOut([], null, null);
    assert.ok(scene.headerObjects.every(object => object.visible), `${entryPoint} restores header`);
    assert.equal(scene.headerModalCount, 0);
    assert.equal(scene.input.enabled, true, `${entryPoint} restores scene input`);
  }
});

test('shared modal entry and exit wiring covers header, tutorial, picker, prompts, and game-over', () => {
  for (const name of ['showTutorial', 'showSettings', 'showGallery', 'showInfoModal',
    'showSharedConfirm', 'showLevelSelect', 'showLevelSelectTutorial', 'showGameOverModal']) {
    assert.match(extractMethod(name), /this\.animateModalIn\(/, `${name} enters the shared modal state`);
  }
  for (const name of ['showTutorial', 'showSettings', 'showGallery', 'showInfoModal',
    'showSharedConfirm', 'showLevelSelect', 'showLevelSelectTutorial', 'showGameOverModal']) {
    assert.match(extractMethod(name), /this\.animateModalOut\(/, `${name} exits the shared modal state`);
  }
  assert.match(extractMethod('showSettings'), /this\.closeIconButton\(objects,settingsClose\.x,settingsClose\.y/);
  assert.match(extractMethod('showSettings'), /settingButton\(UI_Y\(580\),'CLOSE'/);
  assert.match(source, /this\.dailyCloseT=this\.closeIconButton\(\[\],headerLayout\.close\.x,headerLayout\.close\.y,\(\)=>\{\s*this\.showSharedConfirm\('EXIT DAILY CHALLENGE\?'/,
    'the Daily Challenge header X opens the shared exit confirmation');
  assert.match(extractMethod('showSharedConfirm'), /this\.closeIconButton\(objects,confirmClose\.x,confirmClose\.y/);
  assert.match(source, /const closeDepth=Math\.max\(depth,\.\.\.\(objects\|\|\[\]\)\.map\(object=>object\.depth\|\|0\)\)\+1/,
    'each modal X is above the other objects already registered in that modal');
});

test('Daily header close uses the shared outlined X at a smaller scale and keeps its touch target', () => {
  const closeIconButton = vm.runInNewContext(`({${extractMethod('closeIconButton')}}).closeIconButton`, {
    UI_SPACING: {touch: 44},
    containerHitArea: (width, height) => ({x: 0, y: 0, width, height}),
    Phaser: {Geom: {Rectangle: {Contains() {}}}}
  });
  const graphics = [], buttons = [];
  const scene = {
    add: {
      graphics() {
        const drawing = {operations: [], path: []};
        for (const method of ['lineStyle', 'strokeCircle', 'fillCircle', 'fillStyle']) {
          drawing[method] = (...args) => { drawing.operations.push([method, ...args]); return drawing; };
        }
        drawing.beginPath = () => { drawing.path = []; return drawing; };
        drawing.moveTo = (x, y) => { drawing.path.push([x, y]); return drawing; };
        drawing.lineTo = (x, y) => { drawing.path.push([x, y]); return drawing; };
        drawing.strokePath = () => { drawing.operations.push(['strokePath', drawing.path.slice()]); return drawing; };
        graphics.push(drawing);
        return drawing;
      },
      container(x, y, children) {
        const button = {x, y, children,
          setSize(width, height) { this.width = width; this.height = height; return this; },
          setDepth(depth) { this.depth = depth; return this; },
          setInteractive(area) { this.area = area; return this; },
          setData(key, value) { this[key] = value; return this; },
          on() { return this; }};
        buttons.push(button);
        return button;
      }
    },
    markButton(button) { return button; }
  };

  closeIconButton.call(scene, [], 32, 27, () => {}, 44);
  closeIconButton.call(scene, [], 32, 27, () => {}, 44, 0x4cc9f0, .75);

  assert.deepEqual(graphics.map(drawing => drawing.operations.filter(([name]) => name === 'strokeCircle')
    .map(([, x, y, radius]) => [x, y, radius])), [[[0, 0, 16]], [[0, 0, 12]]]);
  assert.equal(graphics[0].operations.some(([name]) => name === 'fillCircle'), false,
    'the shared close icon is an outlined ring like the Settings cross');
  assert.deepEqual(graphics.map(drawing => drawing.operations.filter(([name]) => name === 'lineStyle')
    .map(([, width, color]) => [width, color])),
  [[[1.5, 0x4cc9f0], [2, 0x4cc9f0]], [[1.125, 0x4cc9f0], [1.5, 0x4cc9f0]]]);
  assert.deepEqual(buttons.map(button => [button.x, button.y, button.width, button.height]),
    [[32, 27, 44, 44], [32, 27, 44, 44]]);
});

test('Settings-to-picker/tutorial and Daily-exit modal order restores controls without stale locks', () => {
  const campaign = makeScene();
  campaign.animateModalIn([]); // Settings from campaign.
  campaign.animateModalOut([], null, null); // X or footer CLOSE.
  assert.ok(campaign.headerObjects.every(object => object.visible));

  campaign.animateModalIn([]); // Level Select.
  campaign.animateModalIn([]); // How-to-use-medals tutorial.
  campaign.animateModalOut([], null, null);
  assert.ok(campaign.headerObjects.every(object => !object.visible));
  campaign.animateModalOut([], null, null);
  assert.ok(campaign.headerObjects.every(object => object.visible));

  const daily = makeScene();
  daily.animateModalIn([]); // Settings from Daily Challenge.
  daily.animateModalOut([], null, null);
  daily.animateModalIn([]); // Daily header X -> exit confirmation.
  assert.ok(daily.headerObjects.every(object => !object.visible));
  daily.animateModalOut([], null, null); // X or CLOSE on the confirmation.
  assert.ok(daily.headerObjects.every(object => object.visible));
  assert.equal(daily.headerModalCount, 0);
});

test('long modal titles wrap inside the shared close-button exclusion area', () => {
  const methods = ['showTutorial', 'showSettings', 'showGallery', 'showInfoModal',
    'showSharedConfirm', 'showLevelSelect', 'showLevelSelectTutorial', 'showGameOverModal'];
  for (const name of methods) {
    assert.match(extractMethod(name), /this\.createModalTitle\(/, `${name} uses the shared title layout`);
  }

  const scene = makeScene(), created = [];
  scene.add = {
    text(x, y, label, style) {
      const title = {x, y, label, style, setOrigin(value) { this.origin = value; return this; },
        setDepth(value) { this.depth = value; return this; }};
      created.push(title);
      return title;
    }
  };
  const titles = [
    ['MAKE YOUR FIRST ESCAPE', 320, 21],
    ['EXIT DAILY CHALLENGE?', 290, 22],
    ['NEON ART COLLECTION', 345, 22],
    ['PRIVACY SETTINGS', 290, 22],
    ['OUT OF STARS', 320, 28]
  ];
  for (const [label, width, fontSize] of titles) {
    const panelLeft = (360 - width) / 2, y = 120;
    const title = scene.createModalTitle(panelLeft, width, y, label, fontSize, '#ffffff', 42);
    const exclusion = 14 + 44;
    assert.equal(title.x, 180);
    assert.equal(title.y, y);
    assert.equal(title.style.fixedWidth, width - 2 * exclusion);
    assert.equal(title.style.wordWrap.width, width - 2 * exclusion);
    assert.equal(title.style.align, 'center');
    assert.ok(Number.parseInt(title.style.fontSize, 10) >= 16);
    assert.equal(title.origin, .5);
    assert.equal(title.depth, 42);
  }
  assert.equal(created.length, titles.length);
});
