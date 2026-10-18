const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).find(script => script.includes('function gen('));
const storageStart = source.indexOf('let profileCache=null;');
const storageEnd = source.indexOf('\nfunction seededRandom', storageStart);
const storageSource = source.slice(storageStart, storageEnd);

function createStorageContext(localStorage, preferences = null) {
  const alerts = [], errors = [];
  const context = vm.createContext({
    localStorage,
    window: {
      ArrowNative: preferences ? {Preferences: preferences} : undefined,
      alert(message) { alerts.push(message); }
    },
    console: {error(...args) { errors.push(args); }}
  });
  vm.runInContext(`${storageSource};this.writeProfile=writeProfile;`, context);
  return {context, alerts, errors};
}

test('profile saves support synchronous localStorage and native Preferences', () => {
  const stored = [], nativeWrites = [];
  const {context, alerts, errors} = createStorageContext(
    {setItem(key, value) { stored.push({key, value}); }},
    {set(options) { nativeWrites.push(options); }}
  );
  const profile = {level: 4};

  context.writeProfile(profile);

  assert.deepEqual(JSON.parse(JSON.stringify(stored)), [{key: 'arrowPathProfile', value: JSON.stringify(profile)}]);
  assert.deepEqual(JSON.parse(JSON.stringify(nativeWrites)), [{key: 'arrowPathProfile', value: JSON.stringify(profile)}]);
  assert.deepEqual(alerts, []);
  assert.deepEqual(errors, []);
});

test('a successful Preferences promise is a fallback when localStorage throws', async () => {
  const nativeWrites = [];
  const {context, alerts, errors} = createStorageContext(
    {setItem() { throw new Error('localStorage unavailable'); }},
    {set(options) { nativeWrites.push(options); return Promise.resolve(); }}
  );

  context.writeProfile({level: 5});
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(nativeWrites.length, 1);
  assert.deepEqual(alerts, []);
  assert.deepEqual(errors, []);
});

test('failed backends notify once and both are retried on the next write', async () => {
  let localAttempts = 0, nativeAttempts = 0;
  const {context, alerts, errors} = createStorageContext(
    {setItem() { localAttempts++; throw new Error('localStorage unavailable'); }},
    {set() { nativeAttempts++; return Promise.reject(new Error('Preferences unavailable')); }}
  );

  context.writeProfile({level: 6});
  context.writeProfile({level: 7});
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(localAttempts, 2);
  assert.equal(nativeAttempts, 2);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /Progress could not be saved/);
  assert.equal(errors.length, 1);
});

test('synchronous storage failures are reported when neither backend succeeds', () => {
  let localAttempts = 0, nativeAttempts = 0;
  const {context, alerts, errors} = createStorageContext(
    {setItem() { localAttempts++; throw new Error('localStorage unavailable'); }},
    {set() { nativeAttempts++; throw new Error('Preferences unavailable'); }}
  );

  assert.doesNotThrow(() => context.writeProfile({level: 8}));
  assert.doesNotThrow(() => context.writeProfile({level: 9}));

  assert.equal(localAttempts, 2);
  assert.equal(nativeAttempts, 2);
  assert.equal(alerts.length, 1);
  assert.equal(errors.length, 1);
});

test('a failed Preferences promise does not warn when localStorage saved successfully', async () => {
  const {context, alerts, errors} = createStorageContext(
    {setItem() {}},
    {set() { return Promise.reject(new Error('Preferences unavailable')); }}
  );

  context.writeProfile({level: 10});
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(alerts, []);
  assert.deepEqual(errors, []);
});

test('unavailable Preferences are reported when localStorage also throws', () => {
  const {context, alerts, errors} = createStorageContext(
    {setItem() { throw new Error('localStorage unavailable'); }}
  );

  context.writeProfile({level: 11});

  assert.equal(alerts.length, 1);
  assert.equal(errors.length, 1);
});
