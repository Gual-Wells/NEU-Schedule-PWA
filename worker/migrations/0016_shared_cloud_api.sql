
CREATE TABLE IF NOT EXISTS api_cloud_runs (
 project TEXT NOT NULL, task TEXT NOT NULL, attempt TEXT NOT NULL,
 request_digest TEXT NOT NULL, model TEXT NOT NULL, outcome TEXT NOT NULL,
 started_at INTEGER NOT NULL, finished_at INTEGER, http_status INTEGER,
 response_id TEXT, request_id TEXT, response_json TEXT, usage_json TEXT,
 failure_code TEXT, stream_digest TEXT,
 PRIMARY KEY(project,task,attempt)
);
CREATE TABLE IF NOT EXISTS api_cloud_streams (
 run_key TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL,
 PRIMARY KEY(run_key,seq)
);
CREATE TABLE IF NOT EXISTS api_cloud_locks (
 project TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS api_cloud_usage (
 project TEXT PRIMARY KEY, input_tokens INTEGER NOT NULL DEFAULT 0,
 output_tokens INTEGER NOT NULL DEFAULT 0, cached_input_tokens INTEGER NOT NULL DEFAULT 0,
 responses INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS api_cloud_runs_outcome ON api_cloud_runs(project,outcome);
CREATE TRIGGER IF NOT EXISTS api_cloud_usage_count_once
AFTER UPDATE OF usage_json ON api_cloud_runs
WHEN OLD.usage_json IS NULL AND NEW.usage_json IS NOT NULL AND json_valid(NEW.usage_json)
BEGIN
 INSERT INTO api_cloud_usage(project,input_tokens,output_tokens,cached_input_tokens,responses,revision)
 VALUES(NEW.project,
  MAX(0,COALESCE(CAST(json_extract(NEW.usage_json,'$.input_tokens') AS INTEGER),0)),
  MAX(0,COALESCE(CAST(json_extract(NEW.usage_json,'$.output_tokens') AS INTEGER),0)),
  MAX(0,COALESCE(CAST(json_extract(NEW.usage_json,'$.input_tokens_details.cached_tokens') AS INTEGER),0)),1,1)
 ON CONFLICT(project) DO UPDATE SET input_tokens=input_tokens+excluded.input_tokens,
 output_tokens=output_tokens+excluded.output_tokens,cached_input_tokens=cached_input_tokens+excluded.cached_input_tokens,
 responses=responses+1,revision=revision+1;
END;
