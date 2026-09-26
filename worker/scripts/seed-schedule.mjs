import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);
const context = vm.createContext({ window: {} });
vm.runInContext(fs.readFileSync(new URL('data.js', root), 'utf8'), context);
const json = JSON.stringify(context.window.APP_DATA);
if (!json || json.length > 100_000) throw new Error('Schedule seed is missing or too large');
const sql = `INSERT OR IGNORE INTO schedule_data (id, content, revision, updated_at) VALUES (1, '${json.replaceAll("'", "''")}', 1, 0);\n`;
fs.writeFileSync(new URL('../migrations/0003_seed_schedule.sql', import.meta.url), sql);
console.log('Initial schedule migration generated');
