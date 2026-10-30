import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeAgendaResult} from '../../scripts/lib/agenda-api-format.mjs';
import '../../agenda-core.js';
test('equivalent zero-second transport timestamps become campus minutes; real seconds and zones stay invalid',()=>{
 const value=normalizeAgendaResult({items:[{localTime:'2026-11-04T15:00:00',localEnd:'2026-11-04T16:30:00'}]});
 assert.equal(value.items[0].localTime,'2026-11-04T15:00');assert.equal(value.items[0].localEnd,'2026-11-04T16:30');assert.equal(globalThis.ScheduleAgenda.localTime(value.items[0].localTime),Date.parse('2026-11-04T15:00:00+08:00'));
 for(const bad of ['2026-11-04T15:00:42','2026-11-04T15:00:00Z','2026-11-04T15:00:00+08:00'])assert.throws(()=>globalThis.ScheduleAgenda.localTime(normalizeAgendaResult({items:[{localTime:bad}]}).items[0].localTime));
});
