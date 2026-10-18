const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).find(script => script.includes('function gen('));
assert.ok(source, 'index.html must contain the game script');

// Match game-logic.test.js: execute only the real pure logic, without booting Phaser.
function extractBraced(start, name) {
  assert.ok(start >= 0, `Could not find ${name}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

const directionSource = extractBraced(source.indexOf('function portalExitDirection('), 'portalExitDirection');
const portalExitDirection = vm.runInNewContext(`(${directionSource})`);
const context = vm.createContext({portalExitDirection, MIN_READABLE_FONT_SIZE: 12});
function loadMethod(name) {
  const match = new RegExp(`^  ${name}\\(`, 'm').exec(source);
  const method = extractBraced(match ? match.index : -1, name);
  return vm.runInContext(`({${method}}).${name}`, context);
}
const portalTrace = loadMethod('portalTrace');
const portalMove = loadMethod('portalMove');
const free = loadMethod('free');
const portalBodyAtProgress = vm.runInContext(`(${extractBraced(source.indexOf('function portalBodyAtProgress('), 'portalBodyAtProgress')})`, context);
const plain = value => JSON.parse(JSON.stringify(value)); // Also normalizes reverse-direction -0.

function makeArrow(id, cells, d, col = 0x4cc9f0) {
  return {id, cells: cells.map(cell => cell.slice()), d: d.slice(), col};
}

const routes = [
  {
    name: 'A -> B', sourceEnd: 'A', cells: [[1, 6], [2, 6]], exitDirection: [0, -1],
    blockerCells: [[8, 2], [8, 3], [8, 4]], blockingCell: [8, 4], farCell: [8, 1],
    otherSide: [[8, 10], [8, 9]], behindCell: [8, 8], translatedTail: [7, 7]
  },
  {
    name: 'B -> A', sourceEnd: 'B', cells: [[5, 7], [6, 7]], exitDirection: [0, 1],
    blockerCells: [[4, 9], [4, 10], [4, 11]], blockingCell: [4, 9], farCell: [4, 12],
    otherSide: [[4, 3], [4, 4]], behindCell: [4, 5], translatedTail: [3, 6]
  }
];

function makeFixture(route, others = []) {
  const portal = {entry: [4, 6], destination: [8, 7], d: [0, -1]};
  const arrow = makeArrow(`moving-from-${route.sourceEnd}`, route.cells, [1, 0]);
  const scene = {snakes: [arrow, ...others], portal, cols: 10, rows: 14, portalTrace, portalMove};
  return {route, arrow, scene};
}

function endpoints({route, scene}) {
  return route.sourceEnd === 'A'
    ? {source: scene.portal.entry, destination: scene.portal.destination}
    : {source: scene.portal.destination, destination: scene.portal.entry};
}

function arrowIdentity(scene, arrow) {
  return {id: arrow.id, index: scene.snakes.indexOf(arrow), color: `0x${arrow.col.toString(16).padStart(6, '0')}`};
}

function outgoingDirection(scene, trace) {
  // The fallback also makes the diagnostic usable against the original, incomplete blocked traces.
  return trace.exitDirection || (trace.sourceEnd ? portalExitDirection(scene.portal, trace.sourceEnd) : null);
}

function diagnostic({scene, arrow}) {
  const trace = portalTrace.call(scene, arrow);
  return {
    free: free.call(scene, arrow), reason: trace.reason || null,
    source: trace.sourceEnd ? {end: trace.sourceEnd, cell: trace.sourceCell} : null,
    destination: trace.destinationCell
      ? {end: trace.sourceEnd === 'A' ? 'B' : 'A', cell: trace.destinationCell} : null,
    exitDirection: outgoingDirection(scene, trace), blockingCell: trace.cell || null,
    arrow: arrowIdentity(scene, arrow), blocker: trace.blocker ? arrowIdentity(scene, trace.blocker) : null
  };
}

function assertTraversable(fixture, direction = fixture.route.exitDirection) {
  const {scene, arrow, route} = fixture;
  assert.equal(free.call(scene, arrow), true, 'the head and following tail have a clear portal route');
  const trace = portalTrace.call(scene, arrow);
  const ends = endpoints(fixture);
  assert.equal(trace.ok, true);
  assert.equal(trace.sourceEnd, route.sourceEnd);
  assert.deepEqual(plain(trace.sourceCell), ends.source);
  assert.deepEqual(plain(trace.destinationCell), ends.destination);
  assert.deepEqual(plain(trace.exitDirection), direction);
  assert.equal(trace.blocker, undefined);
  const moved = portalMove.call(scene, arrow);
  assert.ok(moved, 'a clear portal trace must yield a portal move');
  assert.equal(moved.portal, scene.portal);
  assert.equal(moved.sourceEnd, route.sourceEnd);
  assert.deepEqual(plain(moved.sourceCell), ends.source);
  assert.deepEqual(plain(moved.destinationCell), ends.destination);
  assert.deepEqual(plain(moved.d), direction);
  // Do not enshrine rigidly translated finalCells as the intended body traversal.
}

test('reproduction: sparse right-moving arrow exits B upward into the pink column at [8,4]', t => {
  const blocker = makeArrow('pink-column', [[8, 2], [8, 3], [8, 4]], [0, -1], 0xff4d6d);
  const fixture = makeFixture(routes[0], [blocker]);
  t.diagnostic(JSON.stringify(diagnostic(fixture)));
  const {scene, arrow} = fixture;
  const trace = portalTrace.call(scene, arrow);
  assert.equal(free.call(scene, arrow), false);
  assert.equal(trace.ok, false);
  assert.equal(trace.reason, 'other-after-portal');
  assert.equal(trace.sourceEnd, 'A');
  assert.deepEqual(plain(trace.sourceCell), [4, 6]);
  assert.deepEqual(plain(trace.destinationCell), [8, 7]);
  assert.deepEqual(plain(outgoingDirection(scene, trace)), [0, -1]);
  assert.equal(trace.blocker, blocker);
  assert.deepEqual(plain(trace.cell), [8, 4]);
  assert.equal(portalMove.call(scene, arrow), null);
});

test('direction convention: A -> B uses portal.d and B -> A uses its negative', () => {
  // This is the convention already asserted by game-logic.test.js, not an inferred new rule.
  for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const portal = {d: d.slice()};
    assert.deepEqual(plain(portalExitDirection(portal, 'A')), d);
    assert.deepEqual(plain(portalExitDirection(portal, 'B')), plain([-d[0], -d[1]]));
    assert.deepEqual(portal.d, d, 'deriving a reverse direction must not mutate portal.d');
  }
});

for (const route of routes) {
  test(`${route.name}: clear exit traverses the shared portal`, () => {
    assertTraversable(makeFixture(route));
  });

  test(`${route.name}: exit ray reports the nearest blocker and its exact occupied cell`, () => {
    const far = makeArrow('farther-blocker', [route.farCell], [1, 0], 0xffb703);
    const blocker = makeArrow('nearest-pink-column', route.blockerCells, [0, -1], 0xff4d6d);
    const fixture = makeFixture(route, [far, blocker]); // Farther arrow deliberately comes first.
    const {scene, arrow} = fixture;
    const trace = portalTrace.call(scene, arrow);
    const ends = endpoints(fixture);
    assert.equal(free.call(scene, arrow), false);
    assert.equal(trace.ok, false);
    assert.equal(trace.reason, 'other-after-portal');
    assert.equal(trace.sourceEnd, route.sourceEnd);
    assert.deepEqual(plain(trace.exitDirection), route.exitDirection, 'blocked traces carry the actual outgoing direction');
    assert.deepEqual(plain(trace.sourceCell), ends.source);
    assert.deepEqual(plain(trace.destinationCell), ends.destination);
    assert.deepEqual(plain(outgoingDirection(scene, trace)), route.exitDirection);
    assert.equal(trace.blocker, blocker);
    assert.deepEqual(plain(trace.cell), route.blockingCell);
    assert.equal(portalMove.call(scene, arrow), null);
  });

  test(`${route.name}: a same-column arrow on the other side of the exit is not ray-blocking`, () => {
    const other = makeArrow('opposite-side-column', route.otherSide, route.exitDirection, 0xff4d6d);
    assertTraversable(makeFixture(route, [other]));
  });

  test(`${route.name}: an adjacent cell behind the destination mouth is not ray-blocking`, () => {
    const behind = makeArrow('behind-mouth', [route.behindCell], route.exitDirection, 0xff4d6d);
    assertTraversable(makeFixture(route, [behind]));
  });

  test(`${route.name}: marking the exit blocker done clears the route`, () => {
    const blocker = makeArrow('departing-pink-column', route.blockerCells, [0, -1], 0xff4d6d);
    const fixture = makeFixture(route, [blocker]);
    assert.equal(free.call(fixture.scene, fixture.arrow), false);
    blocker.done = true;
    assertTraversable(fixture);
  });

  test(`${route.name}: an exit ray stops at the board boundary before offboard cells`, () => {
    const offboardCell = route.sourceEnd === 'A' ? [8, -1] : [4, 14];
    const outside = makeArrow('already-offboard', [offboardCell], route.exitDirection, 0xff4d6d);
    assertTraversable(makeFixture(route, [outside]));
  });

  test(`${route.name}: an outward edge exit ignores cells beyond the board and behind the mouth`, () => {
    const fixture = makeFixture(route);
    const destination = route.sourceEnd === 'A' ? [8, 0] : [4, 13];
    if (route.sourceEnd === 'A') fixture.scene.portal.destination = destination;
    else fixture.scene.portal.entry = destination;
    const [dx, dy] = route.exitDirection;
    fixture.scene.snakes.push(
      makeArrow('outside-edge', [[destination[0] + dx, destination[1] + dy]], route.exitDirection, 0xff4d6d),
      makeArrow('inside-behind-edge', [[destination[0] - dx, destination[1] - dy]], route.exitDirection, 0x80ed99)
    );
    assertTraversable(fixture);
  });

  test(`${route.name}: an occupied destination mouth remains a real blocker`, () => {
    const fixture = makeFixture(route);
    const destination = endpoints(fixture).destination;
    const blocker = makeArrow('mouth-blocker', [destination], [1, 0], 0xff4d6d);
    fixture.scene.snakes.push(blocker);
    const trace = portalTrace.call(fixture.scene, fixture.arrow);
    assert.equal(free.call(fixture.scene, fixture.arrow), false);
    assert.equal(trace.reason, 'other-after-portal');
    assert.equal(trace.blocker, blocker);
    assert.deepEqual(plain(trace.cell), destination);
    assert.equal(portalMove.call(fixture.scene, fixture.arrow), null);
  });
}

for (const reverse of [false, true]) {
  for (const atMouth of [false, true]) {
    test(`${reverse ? 'B -> A' : 'A -> B'}: still blocks real source-body collision ${atMouth ? 'at the mouth' : 'along the exit'}`, () => {
      const arrow = makeArrow('long-source-body', [[1,6],[2,6],[3,6],[4,6],[5,6]], [1,0]);
      const entrance = [6,6], exit = atMouth ? [4,6] : [4,5];
      const portal = {entry: reverse ? exit : entrance, destination: reverse ? entrance : exit,
        d: reverse ? [0,-1] : [0,1]};
      const scene = {snakes: [arrow], portal, cols: 10, rows: 14, portalTrace, portalMove};
      const trace = portalTrace.call(scene, arrow);
      assert.equal(free.call(scene, arrow), false);
      assert.equal(trace.reason, 'self-after-portal');
      assert.deepEqual(plain(trace.cell), [4,6]);
      assert.deepEqual(plain(trace.exitDirection), [0,1]);
      assert.equal(trace.blocker, undefined);
      assert.equal(portalMove.call(scene, arrow), null);
    });
  }
}

test('movement snapshots and animation agree when the head emerges at either mouth', () => {
  for (const route of routes) {
    const {scene, arrow} = makeFixture(route);
    const moved = portalMove.call(scene, arrow);
    const length = arrow.cells.length - 1;
    const frame = portalBodyAtProgress(arrow.cells, moved.sourceCell, moved.destinationCell,
      moved.d, moved.steps, length, 30, moved.steps);
    assert.deepEqual(plain(moved.cells), plain([...frame.sourcePoints, ...frame.destinationPoints]));
    const later = portalBodyAtProgress(arrow.cells, moved.sourceCell, moved.destinationCell,
      moved.d, moved.steps, length, 30, moved.steps + 1);
    assert.deepEqual(plain(later.destinationPoints.at(-1)),
      moved.destinationCell.map((value, axis) => value + moved.d[axis]));
  }
});

test('the actual portal animation uses the traced exit heading in both directions', () => {
  Object.assign(context, {PORTAL_EXIT_DISTANCE: 600, PORTAL_MOVE_SPEED: 1200, portalBodyAtProgress});
  context.portalAnimationTiming = vm.runInContext(`(${extractBraced(source.indexOf('function portalAnimationTiming('), 'portalAnimationTiming')})`, context);
  const animatePortalExit = loadMethod('animatePortalExit');
  for (const route of routes) for (const direction of [[1,0],[-1,0],[0,1],[0,-1]]) {
    const {scene, arrow} = makeFixture(route), frames = [], tweens = [];
    scene.portal.d = direction;
    const move = portalMove.call(scene, arrow);
    assert.ok(move);
    arrow.body = arrow.cells.map(cell => cell.slice()); arrow.len = arrow.cells.length - 1;
    arrow.g = {setAlpha() {}};
    Object.assign(scene, {cs: 1, pos: cell => cell.slice(), playFeedback() {},
      renderPortal(s, before, after, heading) { frames.push({after, heading: plain(heading)}); },
      cameras: {main: {flash() {}}},
      tweens: {add(config) { tweens.push(config); }, killTweensOf() {}},
      add: {graphics() { return {setDepth() { return this; }, lineStyle() {}, strokeCircle() {}, destroy() {}}; }}
    });
    animatePortalExit.call(scene, arrow, () => {}, move, arrow.d);
    assert.deepEqual(frames[0].heading, arrow.d);
    const travel = tweens.find(tween => 'progress' in tween.targets);
    travel.targets.progress = move.approachDistance + .5; travel.onUpdate();
    assert.deepEqual(frames.at(-1).heading, plain(move.d));
    assert.ok(frames.at(-1).after.length > 0, 'the head has emerged');
  }
});

test('each portal ring has a vector exit tick that uses the same direction convention', () => {
  context.FONT = 'sans-serif';
  const drawPortalTiles = loadMethod('drawPortalTiles');
  for (const d of [[1,0],[-1,0],[0,1],[0,-1]]) {
    const ticks = [], centers = [], portal = {entry: [2,2], destination: [7,7], d};
    const scene = {cs: 32, portal, pos: ([x,y]) => [x*32,y*32], add: {
      graphics() {
        let points;
        return {setDepth() { return this; }, lineStyle() {}, strokeCircle() {},
          beginPath() { points = []; }, moveTo(x,y) { points.push([x,y]); },
          lineTo(x,y) { points.push([x,y]); }, strokePath() { ticks.push(points); }};
      },
      text(x,y) { centers.push([x,y]); return {setOrigin() { return this; }, setDepth() { return this; }}; }
    }};
    drawPortalTiles.call(scene);
    assert.equal(ticks.length, 2);
    ['B','A'].forEach((sourceEnd, index) => {
      const expected = plain(portalExitDirection(portal, sourceEnd));
      const offset = ticks[index][1].map((value, axis) => value - centers[index][axis]);
      assert.ok(offset[0]*expected[0] + offset[1]*expected[1] > 0, 'tip points out of this mouth');
      assert.equal(Math.abs(offset[0]*expected[1] - offset[1]*expected[0]), 0, 'tip follows the exit axis');
      assert.equal(ticks[index].length, 3, 'a visible three-vertex chevron, not color alone');
    });
  }
});

for (const {name, cells, direction, cell} of [
  {name: 'reversing through a straight body', cells: [[1, 6], [2, 6]], direction: [-1, 0], cell: [1, 6]},
  {name: 'turning into an earlier bent segment', cells: [[1, 6], [2, 6], [2, 5]], direction: [0, 1], cell: [2, 6]}
]) {
  test(`self-collision remains blocked: ${name}`, () => {
    const fixture = makeFixture(routes[0]);
    const {scene, arrow} = fixture;
    arrow.cells = cells;
    const trace = portalTrace.call(scene, arrow, direction);
    assert.equal(free.call(scene, arrow, direction), false);
    assert.equal(trace.reason, 'self-before-portal');
    assert.deepEqual(plain(trace.cell), cell);
    assert.equal(trace.blocker, undefined);
    assert.equal(portalMove.call(scene, arrow, direction), null);
  });
}

// These regressions failed before the fix; they must remain traversable.
// Existing animation feeds the tail through the source mouth after the head. A rigid
// translated pre-entry body therefore must not veto an otherwise clear traversal.
// These cases preserve the established portal-defined outgoing direction throughout.
for (const route of routes) {
  test(`${route.name}: a translated offboard tail does not prevent an outward edge exit`, () => {
    const fixture = makeFixture(route);
    if (route.sourceEnd === 'A') fixture.scene.portal.destination = [0, 0];
    else fixture.scene.portal.entry = [0, 13];
    // Translating everything at once invents [-1,0] / [-1,13]. The tail
    // actually stays on the source side until it follows the head offboard.
    assertTraversable(fixture);
  });

  test(`${route.name}: a blocker beside the mouth is not an un-emerged body collision`, () => {
    const blocker = makeArrow('beside-mouth-not-on-route', [route.translatedTail], [0, -1], 0xff4d6d);
    const fixture = makeFixture(route, [blocker]);
    // Neither the clear incoming row nor the vertical outgoing ray visits this cell.
    assertTraversable(fixture);
  });

  test(`${route.name}: a following tail is not a stationary body on the outgoing ray`, () => {
    const fixture = makeFixture(route);
    fixture.scene.portal.d = route.sourceEnd === 'A' ? [-1, 0] : [1, 0];
    // Both routes legitimately exit left under the existing direction convention.
    // The translated tail at [7,7] / [3,6] has not emerged there ahead of the head.
    assertTraversable(fixture, [-1, 0]);
  });
}
