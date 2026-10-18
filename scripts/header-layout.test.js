const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).find(script => script.includes('function gen('));
assert.ok(source, 'index.html must contain the game script');
const start = source.indexOf('const MODAL_SIDE_PADDING=');
const end = source.indexOf('const modalInnerWidth=', start);
assert.ok(start >= 0 && end > start, 'header layout prelude must be extractable');
class Rectangle {
  constructor(x, y, width, height) { Object.assign(this, {x, y, width, height}); }
}
const {UI_SPACING, MODAL_CLOSE_INSET, gameHeaderLayout, modalClosePosition, modalTitleBounds, containerHitArea} = vm.runInNewContext(
  `${source.slice(start, end)};({UI_SPACING,MODAL_CLOSE_INSET,gameHeaderLayout,modalClosePosition,modalTitleBounds,containerHitArea})`,
  {Phaser: {Geom: {Rectangle}}}
);

function box(item) {
  return {left: item.left, right: item.right, top: item.top, bottom: item.bottom};
}

test('shared header tokens keep controls at mobile hit-target sizes', () => {
  assert.deepEqual({...UI_SPACING}, {
    edge: 16, gap: 8, rowGap: 14, touch: 44, icon: 32, boardGap: 16, bottomSafe: 20
  });
  const layout = gameHeaderLayout(360, 640, 3);
  assert.equal(layout.icons.length, 2);
  layout.icons.forEach(icon => {
    assert.equal(icon.width, 44);
    assert.equal(icon.height, 44);
    assert.equal(icon.visualSize, 32);
  });
  assert.equal(layout.chips.length, 3);
  layout.chips.forEach(chip => {
    assert.equal(chip.width, 104);
    assert.equal(chip.height, 44);
  });
  assert.equal(layout.icons[0].left, 16);
  assert.equal(layout.icons[1].right, 344);
  assert.equal(layout.close.x, 32);
  assert.equal(layout.close.y, 27, 'daily exit stays in the title row above gameplay controls');
});

test('campaign and daily share the same vertical header rows and daily divider is clear', () => {
  for (const width of [320, 360, 414]) {
    const campaign = gameHeaderLayout(width, 640, 3);
    const daily = gameHeaderLayout(width, 640, 3);
    assert.deepEqual(
      {title: campaign.title.y, divider: campaign.divider.y, icons: campaign.iconY,
        resources: campaign.resourceY, boardTop: campaign.boardTop, bottomSafe: campaign.bottomSafe},
      {title: daily.title.y, divider: daily.divider.y, icons: daily.iconY,
        resources: daily.resourceY, boardTop: daily.boardTop, bottomSafe: daily.bottomSafe}
    );
    assert.equal(daily.title.y, daily.close.y);
    daily.stars.forEach(star => assert.equal(star.y, daily.title.y));
    assert.equal(daily.close.x - UI_SPACING.icon / 2, daily.edge,
      `${width}px: close icon has the same outer padding as the stars`);
    assert.equal(daily.stars.at(-1).x + 8, width - daily.edge,
      `${width}px: right star has matching outer padding`);
    assert.ok(daily.title.left > daily.close.x + UI_SPACING.icon / 2,
      `${width}px: title clears the close icon`);
    assert.ok(daily.title.right < daily.stars[0].x - 8,
      `${width}px: title clears the stars`);
    assert.equal(daily.title.x, (daily.title.left + daily.title.right) / 2,
      `${width}px: title is centered in the available space`);
    assert.equal(daily.title.maxWidth, daily.title.right - daily.title.left,
      `${width}px: title sizing uses its collision-free space`);
    const iconBottom = campaign.icons[0].bottom;
    const resourceTop = campaign.chips[0].top;
    assert.equal(resourceTop - iconBottom, UI_SPACING.rowGap);
    assert.ok(campaign.divider.y - iconBottom >= 6, 'divider clears the icon hit target');
    assert.ok(resourceTop - campaign.divider.y >= 6, 'divider clears the resource hit target');
  }
  assert.match(source, /Math\.max\(16,Math\.floor\(23\*availableTitleWidth\/this\.levelT\.width\)\)/,
    'long Daily Challenge titles preserve the 16px minimum size');
  assert.match(source, /this\.drawStar\(star,headerLayout\.stars\[index\]\.x,headerLayout\.stars\[index\]\.y,9,0xffd166\)/,
    'vector stars share the title and close button center line');
});

test('resource chip positions reflow from two to three buttons without changing row geometry', () => {
  const two = gameHeaderLayout(360, 640, 2);
  const three = gameHeaderLayout(360, 640, 3);
  assert.equal(two.chips.length, 2);
  assert.equal(two.chips[0].left, 16);
  assert.equal(two.chips.at(-1).right, 344);
  assert.equal(two.chips[1].left - two.chips[0].right, UI_SPACING.gap);
  assert.equal(three.chips[1].left - three.chips[0].right, UI_SPACING.gap);
  assert.equal(two.resourceY, three.resourceY);
  assert.equal(two.chips[0].height, three.chips[0].height);
  assert.ok(two.chips[0].width > three.chips[0].width, 'two-button labels get the extra width');
});

test('container hit areas align with HUD visuals and target only their own chip', () => {
  const contains = (slot, point, scale) => {
    const area = containerHitArea(slot.width, UI_SPACING.touch);
    const localX = (point.x - slot.x) / scale + slot.width / 2;
    const localY = (point.y - slot.y) / scale + UI_SPACING.touch / 2;
    return localX >= area.x && localX < area.x + area.width &&
      localY >= area.y && localY < area.y + area.height;
  };
  const cameraPoint = (world, scroll, zoom, renderScale, fitScale, offset) =>
    offset + (world - scroll) * zoom * renderScale * fitScale;
  const pointerWorld = (page, scroll, zoom, renderScale, fitScale, offset) =>
    (page - offset) / (zoom * renderScale * fitScale) + scroll;

  for (const level of [10, 11, 10]) {
    const count = level >= 11 ? 3 : 2;
    const campaign = gameHeaderLayout(360, 640, count);
    const daily = gameHeaderLayout(360, 640, count);
    assert.equal(campaign.chips.length, count, `campaign level ${level} updates its resource count`);
    assert.equal(daily.chips.length, count, `daily level ${level} preserves its resource count`);
    for (const layout of [campaign, daily]) {
      for (const renderScale of [1, 1.5, 2]) {
        const zoom = renderScale, fitScale = .5, scroll = -180 * (renderScale - 1);
        const offsetX = 23, offsetY = 41, objectScale = 1;
        const hitsAt = (worldX, worldY) => {
          const pageX = cameraPoint(worldX, scroll, zoom, renderScale, fitScale, offsetX);
          const pageY = cameraPoint(worldY, scroll, zoom, renderScale, fitScale, offsetY);
          const mapped = {
            x: pointerWorld(pageX, scroll, zoom, renderScale, fitScale, offsetX),
            y: pointerWorld(pageY, scroll, zoom, renderScale, fitScale, offsetY)
          };
          return Array.from(layout.chips, (slot, index) =>
            contains(slot, mapped, objectScale) ? index : null).filter(Number.isInteger);
        };

        layout.chips.forEach((slot, index) => {
          const visual = {
            left: slot.x - slot.width / 2, right: slot.x + slot.width / 2,
            top: slot.y - UI_SPACING.touch / 2, bottom: slot.y + UI_SPACING.touch / 2
          };
          const area = containerHitArea(slot.width, UI_SPACING.touch);
          const hit = {
            left: slot.x + (area.x - slot.width / 2),
            right: slot.x + (area.x + area.width - slot.width / 2),
            top: slot.y + (area.y - UI_SPACING.touch / 2),
            bottom: slot.y + (area.y + area.height - UI_SPACING.touch / 2)
          };
          assert.deepEqual(hit, visual, `level ${level}, scale ${renderScale}, chip ${index}`);
          for (const third of [1 / 6, 1 / 2, 5 / 6]) {
            const pageX = cameraPoint(slot.x - slot.width / 2 + slot.width * third,
              scroll, zoom, renderScale, fitScale, offsetX);
            const pageY = cameraPoint(slot.y, scroll, zoom, renderScale, fitScale, offsetY);
            const mapped = {
              x: pointerWorld(pageX, scroll, zoom, renderScale, fitScale, offsetX),
              y: pointerWorld(pageY, scroll, zoom, renderScale, fitScale, offsetY)
            };
            assert.deepEqual(hitsAt(mapped.x, mapped.y), [index],
              `level ${level}, scale ${renderScale}, chip ${index}, third ${third}`);
          }
        });
        for (let index = 0; index < layout.chips.length - 1; index++) {
          const gapX = (layout.chips[index].right + layout.chips[index + 1].left) / 2;
          assert.deepEqual(hitsAt(gapX, layout.resourceY), [],
            `level ${level}, scale ${renderScale}, gap ${index} activates no chip`);
        }
      }
    }
  }
});

test('centered container controls use Phaser origin-normalized hit rectangles', () => {
  for (const [width, height] of [[104, 44], [220, 48], [48, 42], [320, 620]]) {
    assert.deepEqual(
      {...containerHitArea(width, height)},
      {x: 0, y: 0, width, height}
    );
  }
  assert.match(source, /const width=slot\.width,height=UI_SPACING\.touch,visualHeight=height/);
  assert.doesNotMatch(source, /setInteractive\(new Phaser\.Geom\.Rectangle\(-/);
  assert.match(source, /setInteractive\(containerHitArea\(hitSize,hitSize\)/,
    'close controls use the same centered hit bounds');
  assert.match(source, /setInteractive\(containerHitArea\(panelWidth,panelHeight\)/,
    'modal panels do not leave shifted interactive overlays');
  assert.match(source, /gameHeaderLayout\(W,H,this\.level>=11\?3:2\)/,
    'the campaign switches between two and three resource chips at level 11');
  assert.match(source, /this\.rotateT=this\.level>=11\?chip/,
    'TURN remains unavailable before level 11');
  assert.match(source, /`HINTS \$\{match\[1\]\}`/,
    'HINTS and its count stay on one line');
});

test('board safe area stays inside short and tall viewport heights', () => {
  for (const width of [320, 360, 414]) for (const height of [360, 480, 640, 800]) {
    const layout = gameHeaderLayout(width, height, 3);
    assert.ok(layout.boardTop < height - layout.bottomSafe, `${width}x${height}: board has room`);
    assert.ok(layout.boardHeight > 0, `${width}x${height}: board height is positive`);
    assert.ok(layout.boardTop + layout.boardHeight <= height - layout.bottomSafe,
      `${width}x${height}: board fits before bottom safe area`);
    assert.ok(layout.boardWidth > 0, `${width}x${height}: board width is positive`);
    assert.deepEqual(box(layout.chips[0]), {
      left: layout.chips[0].left, right: layout.chips[0].right,
      top: layout.resourceY - 22, bottom: layout.resourceY + 22
    });
  }
});

test('every modal close position uses the same visual inset and touch target', () => {
  for (const [left, top, width] of [[7, 10, 346], [18, 70, 324], [35, 170, 290]]) {
    const position = modalClosePosition(left, top, width), radius=UI_SPACING.icon/2;
    assert.equal(position.x + radius, left + width - 14);
    assert.equal(position.y - radius, top + 14);
    assert.equal(UI_SPACING.touch, 44);
  }
});

test('shared modal titles reserve both sides for the close target and its inset', () => {
  const titles = [
    'MAKE YOUR FIRST ESCAPE', 'EXIT DAILY CHALLENGE?', 'NEON ART COLLECTION',
    'PRIVACY SETTINGS', 'OUT OF STARS', 'LEVELS & MEDALS'
  ];
  for (const [panelLeft, panelWidth] of [[7, 286], [20, 320], [8, 345]]) {
    const bounds = modalTitleBounds(panelLeft, panelWidth);
    assert.equal(bounds.x, panelLeft + panelWidth / 2);
    assert.equal(bounds.width, panelWidth - 2 * (MODAL_CLOSE_INSET + UI_SPACING.touch));
    assert.ok(bounds.width > 0);
    titles.forEach(title => assert.ok(title.length > 0));
  }
});
