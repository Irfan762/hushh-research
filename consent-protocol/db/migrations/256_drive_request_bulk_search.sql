-- Bind a durable Drive search and bulk share to one existing document request.
-- Request identity is opaque; recipient and file metadata remain encrypted.
BEGIN;

ALTER TABLE drive_share_requests
  ADD COLUMN IF NOT EXISTS bulk_search_started_at TIMESTAMPTZ;

ALTER TABLE drive_owner_search_jobs
  ADD COLUMN IF NOT EXISTS unshareable_count INTEGER NOT NULL DEFAULT 0
  CHECK (unshareable_count BETWEEN 0 AND 10000);

ALTER TABLE drive_bulk_shares
  ADD COLUMN IF NOT EXISTS origin_request_id UUID,
  ADD COLUMN IF NOT EXISTS origin_request_revision BIGINT;

ALTER TABLE drive_bulk_shares
  ADD CONSTRAINT drive_bulk_origin_request_fk
    FOREIGN KEY (origin_request_id,user_id)
    REFERENCES drive_share_requests(request_id,user_id);

ALTER TABLE drive_bulk_shares
  ADD CONSTRAINT drive_bulk_origin_request_revision_check
    CHECK ((origin_request_id IS NULL) = (origin_request_revision IS NULL));

CREATE UNIQUE INDEX IF NOT EXISTS drive_bulk_origin_request_unique
  ON drive_bulk_shares(user_id,origin_request_id)
  WHERE origin_request_id IS NOT NULL;

COMMIT;
