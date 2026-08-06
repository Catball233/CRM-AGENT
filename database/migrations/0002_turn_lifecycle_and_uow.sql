ALTER TABLE turns ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''
  CHECK (content_hash = '' OR (length(content_hash) = 64 AND lower(content_hash) NOT GLOB '*[^0-9a-f]*'));

ALTER TABLE turns ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 1
  CHECK (attempt_count > 0);

ALTER TABLE turns ADD COLUMN analysis_json TEXT
  CHECK (analysis_json IS NULL OR json_valid(analysis_json));

ALTER TABLE turns ADD COLUMN failure_retryable INTEGER
  CHECK (failure_retryable IS NULL OR failure_retryable IN (0, 1));

CREATE UNIQUE INDEX ux_turns_one_processing_per_conversation
  ON turns(conversation_id)
  WHERE status = 'PROCESSING';

CREATE TABLE turn_retry_attempts (
  turn_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  retry_request_id TEXT NOT NULL CHECK (
    length(retry_request_id) = 36
    AND substr(retry_request_id, 9, 1) = '-'
    AND substr(retry_request_id, 14, 1) = '-'
    AND substr(retry_request_id, 19, 1) = '-'
    AND substr(retry_request_id, 24, 1) = '-'
    AND length(replace(retry_request_id, '-', '')) = 32
    AND lower(replace(retry_request_id, '-', '')) NOT GLOB '*[^0-9a-f]*'
    AND (
      lower(retry_request_id) IN ('00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff')
      OR (lower(substr(retry_request_id, 15, 1)) IN ('1', '2', '3', '4', '5', '6', '7', '8') AND lower(substr(retry_request_id, 20, 1)) IN ('8', '9', 'a', 'b'))
    )
  ),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 1),
  status TEXT NOT NULL CHECK (status IN ('PROCESSING', 'COMPLETED', 'FAILED')),
  started_at TEXT NOT NULL CHECK (
    datetime(started_at) IS NOT NULL
    AND started_at GLOB '????-??-??T??:??:??*'
    AND (substr(started_at, -1) = 'Z' OR (substr(started_at, -6, 1) IN ('+', '-') AND substr(started_at, -3, 1) = ':'))
  ),
  finished_at TEXT CHECK (finished_at IS NULL OR (
    datetime(finished_at) IS NOT NULL
    AND finished_at GLOB '????-??-??T??:??:??*'
    AND (substr(finished_at, -1) = 'Z' OR (substr(finished_at, -6, 1) IN ('+', '-') AND substr(finished_at, -3, 1) = ':'))
  )),
  PRIMARY KEY (turn_id, retry_request_id),
  UNIQUE (turn_id, attempt_number),
  UNIQUE (conversation_id, retry_request_id),
  FOREIGN KEY (turn_id, conversation_id) REFERENCES turns(turn_id, conversation_id) ON DELETE CASCADE,
  CHECK ((status = 'PROCESSING' AND finished_at IS NULL) OR (status <> 'PROCESSING' AND finished_at IS NOT NULL)),
  CHECK (finished_at IS NULL OR datetime(finished_at) >= datetime(started_at))
) STRICT;
