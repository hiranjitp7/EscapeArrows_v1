const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).find(script => script.includes('function collectionCardTextLayout('));
assert.ok(source, 'index.html contains the readable-text layouts');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `could not find ${name}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`could not extract ${name}`);
}

const layoutContext = vm.createContext({});
vm.runInContext(`const MIN_READABLE_FONT_SIZE=12;${extractFunction('collectionCardTextLayout')};
  this.collectionCardTextLayout=collectionCardTextLayout;`, layoutContext);

test('fixed text sizes do not fall below the 12px readable-text floor', () => {
  assert.match(source, /const MIN_READABLE_FONT_SIZE=12;/);
  for (const match of source.matchAll(/fontSize\s*:\s*['"](\d+(?:\.\d+)?)px['"]/g)) {
    assert.ok(Number(match[1]) >= 12, `font size ${match[1]}px is below the minimum`);
  }
  assert.doesNotMatch(source, /setFontSize\((?:[0-9]|1[01])(?:\.\d+)?\)/);
});

test('collection card labels fit with 15% larger fonts at 320px, 360px, and 414px', () => {
  const fontScale = 1.15, lineHeight = 1.2, glyphWidth = .62;
  for (const viewportWidth of [320, 360, 414]) {
    const gridWidth = viewportWidth * .96 - 44, gap = gridWidth * .035;
    const tileSize = (gridWidth - gap * 2) / 3;
    const layout = layoutContext.collectionCardTextLayout(tileSize);
    const nameSize = layout.nameFontSize * fontScale, detailSize = layout.detailFontSize * fontScale;
    const artBottom = layout.artY + layout.artSize / 2;
    const nameTop = layout.nameY - nameSize * lineHeight / 2;
    const nameBottom = layout.nameY + nameSize * lineHeight / 2;
    const detailTop = layout.detailY - detailSize * lineHeight / 2;
    const detailBottom = layout.detailY + detailSize * lineHeight / 2;

    assert.ok(nameTop >= artBottom, `${viewportWidth}px: name clears artwork`);
    assert.ok(nameBottom <= detailTop, `${viewportWidth}px: name clears level detail`);
    assert.ok(detailBottom <= tileSize / 2, `${viewportWidth}px: detail remains inside card`);
    for (const label of ['SATELLITE', 'LEVEL 250']) {
      assert.ok(label.length * Math.max(nameSize, detailSize) * glyphWidth <= layout.labelWidth,
        `${viewportWidth}px: ${label} fits without wrapping`);
    }
  }
});

test('long gameplay messages wrap instead of shrinking below the minimum', () => {
  assert.match(source, /wordWrap:\{width:W-20,useAdvancedWrap:true\}/);
  assert.match(source, /setText\(text\)\.setFontSize\(MIN_READABLE_FONT_SIZE\)/);
  assert.doesNotMatch(source, /circuitT\.width>W-20/);
});
