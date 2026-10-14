import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeRestores, encodeRestores } from '../src/course-state.js';

test('legacy explicit-skips arrays never restore courses', () => {
  assert.deepEqual(decodeRestores('[1,2,3]'), []);
  assert.deepEqual(decodeRestores('invalid JSON'), []);
  assert.deepEqual(decodeRestores('{"mode":"legacy","ids":[1]}'), []);
});
test('restored courses use a strict versioned record', () => {
  assert.deepEqual(decodeRestores(encodeRestores([3,3,7])), [3,7]);
  assert.deepEqual(decodeRestores('{"mode":"default-skip-v1","ids":[7,-1,300,"4",7]}'), [7]);
  assert.deepEqual(decodeRestores('{"mode":"default-skip-v1","ids":null}'), []);
});
