// Normalize only transport-equivalent zero seconds, never real seconds or zones.
export function normalizeAgendaResult(value){
 for(const item of value.items||[])for(const key of ['localTime','localEnd'])if(typeof item[key]==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(item[key]))item[key]=item[key].slice(0,16);
 return value;
}
