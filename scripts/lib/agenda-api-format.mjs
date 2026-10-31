// Transport normalization only: 15:00 and 15:00:00 are the same minute.
// Nonzero seconds and timezone-bearing strings remain invalid under the business validator.
export {normalizeAgendaResult} from '../../worker/src/agenda-api-format.js';
