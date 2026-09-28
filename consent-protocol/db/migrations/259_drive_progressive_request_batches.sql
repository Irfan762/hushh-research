-- A request may freeze several independent, owner-approved batches while its
-- encrypted Drive search continues. A source position can enter only one batch.
BEGIN;

ALTER TABLE drive_bulk_shares
  ADD COLUMN IF NOT EXISTS progressive_batch BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE drive_bulk_share_files
  ADD COLUMN IF NOT EXISTS origin_request_id UUID;

UPDATE drive_bulk_share_files f
SET origin_request_id = b.origin_request_id
FROM drive_bulk_shares b
WHERE b.share_id = f.share_id
  AND b.origin_request_id IS NOT NULL
  AND f.origin_request_id IS NULL;

ALTER TABLE drive_bulk_share_files
  DROP CONSTRAINT IF EXISTS drive_bulk_file_origin_request_fk;
ALTER TABLE drive_bulk_share_files
  ADD CONSTRAINT drive_bulk_file_origin_request_fk
  FOREIGN KEY (origin_request_id,user_id)
  REFERENCES drive_share_requests(request_id,user_id);

CREATE UNIQUE INDEX IF NOT EXISTS drive_bulk_request_source_position_unique
  ON drive_bulk_share_files(user_id,origin_request_id,source_position)
  WHERE origin_request_id IS NOT NULL;

ALTER TABLE drive_bulk_shares
  DROP CONSTRAINT IF EXISTS drive_bulk_shares_user_id_search_job_id_key;
DROP INDEX IF EXISTS drive_bulk_origin_request_unique;

COMMIT;
