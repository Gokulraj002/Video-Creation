-- DropForeignKey
ALTER TABLE "director_runs" DROP CONSTRAINT "director_runs_project_id_fkey";

-- AlterTable
ALTER TABLE "director_cache_entries" ADD COLUMN     "chunk" TEXT;

-- AlterTable
ALTER TABLE "director_runs" ADD COLUMN     "warnings" JSONB NOT NULL DEFAULT '[]',
ALTER COLUMN "project_id" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "director_runs" ADD CONSTRAINT "director_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
