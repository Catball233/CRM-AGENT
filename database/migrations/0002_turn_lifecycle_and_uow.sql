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
  retry_request_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 1),
  status TEXT NOT NULL CHECK (status IN ('PROCESSING', 'COMPLETED', 'FAILED')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  PRIMARY KEY (turn_id, retry_request_id),
  UNIQUE (turn_id, attempt_number),
  UNIQUE (conversation_id, retry_request_id),
  FOREIGN KEY (turn_id, conversation_id) REFERENCES turns(turn_id, conversation_id) ON DELETE CASCADE
) STRICT;
