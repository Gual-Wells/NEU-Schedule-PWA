import {WorkerEntrypoint} from 'cloudflare:workers';
import worker from './index.js';
import {runCloudAgenda} from './agenda-cloud.js';

export default worker;

// Only the series clock's configured service binding can invoke this capability.
export class ScheduleAPIExecutor extends WorkerEntrypoint {
  async run() {return runCloudAgenda(this.env);}
}
