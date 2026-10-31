import test from 'node:test';
import assert from 'node:assert/strict';
import {AGENDA_JOB_ROOT,assertAgendaRoot,redactExpiredImages} from './clean-expired-agenda-request-images.mjs';

const request=()=>({digest:'fixed-original-digest',project:'second-schedule',task:'fixed-task',startedAt:'2026-10-29T01:00:00Z',model:'gpt-6.1-terra',
  outcomeUnknown:true,body:{model:'gpt-6.1-terra',input:[{role:'user',content:[{type:'input_text',text:'保留文字证据'},
    {type:'input_image',image_url:'data:image/jpeg;base64,fixture-image'},{type:'input_image',image_url:'https://example.test/retained'}]}]}});
test('maintenance accepts only the explicit fixed agenda data root',()=>{
  assert.doesNotThrow(()=>assertAgendaRoot(AGENDA_JOB_ROOT));
  for(const root of ['D:\\CodexStorage\\services','D:\\CodexStorage\\services\\neu-schedule-agenda','D:\\CodexStorage\\services\\neu-schedule-agenda\\jobs\\child','C:\\jobs','D:\\other\\jobs'])assert.throws(()=>assertAgendaRoot(root));
});
test('original source expiry is mandatory and cannot be replaced by an assumed retention period',()=>{
  const value=request();
  for(const sourceExpiresAt of [undefined,null,NaN,'100',101])assert.deepEqual(redactExpiredImages(value,{sourceExpiresAt,now:100}),{record:value,images:0});
});
test('only expired data URLs are removed while digests, charge state and text evidence survive',()=>{
  const value=request(),result=redactExpiredImages(value,{sourceExpiresAt:100,now:100});
  assert.equal(result.images,1);assert.equal(result.record.body.input[0].content[1].image_url,null);
  assert.equal(result.record.body.input[0].content[0].text,'保留文字证据');assert.equal(result.record.body.input[0].content[2].image_url,'https://example.test/retained');
  assert.equal(result.record.digest,value.digest);assert.equal(result.record.outcomeUnknown,true);assert.match(result.record.streamDigest,/^[a-f0-9]{64}$/);
  assert.equal(value.body.input[0].content[1].image_url,'data:image/jpeg;base64,fixture-image');
});
test('repeated redaction is idempotent and does not alter an existing transport digest',()=>{
  const value=request();value.streamDigest='already-recorded';
  const first=redactExpiredImages(value,{sourceExpiresAt:100,now:100});
  assert.equal(first.record.streamDigest,'already-recorded');
  const second=redactExpiredImages(first.record,{sourceExpiresAt:100,now:200});
  assert.equal(second.images,0);assert.deepEqual(second.record,first.record);
});
