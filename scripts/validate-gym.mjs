import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const storageMap = new Map();
const storage = {
  getItem: key => storageMap.get(key) ?? null,
  setItem: (key, value) => storageMap.set(key, value),
  removeItem: key => storageMap.delete(key)
};
const context = vm.createContext({ window: {}, Math, Date });
vm.runInContext(fs.readFileSync(new URL('../gym-store.js', import.meta.url), 'utf8'), context);
const create = () => context.window.GymStore.create(storage);
const startAt = Date.now() - 4 * 3600000;

let store = create();
const first = store.start(startAt, startAt + 2 * 3600000);
assert.equal(store.active().id, first.id);
store.stop(startAt + 42 * 60000);
assert.equal(store.active(), null);
store = create();
assert.equal(store.list()[0].endAt - store.list()[0].startAt, 42 * 60000, 'completed workout must survive reload');

const second = store.start(startAt + 2 * 3600000, startAt + 3 * 3600000);
assert.equal(store.reconcile(startAt + 2 * 3600000 + 1), false);
assert.equal(store.reconcile(startAt + 3 * 3600000 + 1), true, 'workout should close at physical closing time');
assert.equal(store.list().find(item => item.id === second.id).endAt, startAt + 3 * 3600000);
assert.equal(store.list().find(item => item.id === second.id).endReason, 'closing');

store.revise(first.id, startAt + 60000, startAt + 40 * 60000);
assert.equal(store.list().find(item => item.id === first.id).endAt - store.list().find(item => item.id === first.id).startAt, 39 * 60000);
store.remove(second.id);
assert.equal(store.list().length, 1);

const backup = store.list();
const anotherMap = new Map();
const otherStorage = {
  getItem: key => anotherMap.get(key) ?? null,
  setItem: (key, value) => anotherMap.set(key, value),
  removeItem: key => anotherMap.delete(key)
};
const imported = context.window.GymStore.create(otherStorage);
assert.equal(imported.importSessions(backup), 1);
assert.equal(imported.list()[0].id, first.id);
assert.throws(() => imported.importSessions([{ id: 'bad', startAt: 1, endAt: -1, closesAt: 2 }]), /格式无效/);
console.log('Gym session persistence and closing OK');
