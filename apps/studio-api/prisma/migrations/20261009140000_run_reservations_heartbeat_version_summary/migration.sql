-- AlterTable: per-run cost reservation (daily USD quota) and worker heartbeat (stale-run reaper)
ALTER TABLE "director_runs" ADD COLUMN     "heartbeat_at" TIMESTAMP(3),
ADD COLUMN     "reserved_cost_usd" DECIMAL(12,6) NOT NULL DEFAULT 0;

-- Runs already RUNNING when this migration is applied get a fresh heartbeat (grace period before reaping).
UPDATE "director_runs" SET "heartbeat_at" = CURRENT_TIMESTAMP WHERE "status" = 'RUNNING';

-- AlterTable: version summary columns (the version list no longer reads the timeline JSON)
ALTER TABLE "project_versions" ADD COLUMN     "duration_in_frames" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "fps" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "scene_count" INTEGER NOT NULL DEFAULT 0;

-- BEGIN version-summary backfill (also exercised by test/migration-backfill.test.ts)
UPDATE "project_versions"
SET "scene_count" = CASE
        WHEN jsonb_typeof("timeline" -> 'scenes') = 'array' THEN jsonb_array_length("timeline" -> 'scenes')
        ELSE 0
    END,
    "duration_in_frames" = CASE
        WHEN jsonb_typeof("timeline" -> 'durationInFrames') = 'number'
            THEN LEAST(GREATEST(ROUND(("timeline" ->> 'durationInFrames')::numeric), 1), 2147483647)::integer
        ELSE 1
    END,
    "fps" = CASE
        WHEN jsonb_typeof("timeline" -> 'settings' -> 'fps') = 'number'
            THEN LEAST(GREATEST(ROUND(("timeline" -> 'settings' ->> 'fps')::numeric), 1), 2147483647)::integer
        ELSE 30
    END;
-- END version-summary backfill

-- CreateIndex
CREATE INDEX "director_runs_requested_by_id_status_idx" ON "director_runs"("requested_by_id", "status");

-- CreateIndex
CREATE INDEX "director_runs_status_heartbeat_at_idx" ON "director_runs"("status", "heartbeat_at");
