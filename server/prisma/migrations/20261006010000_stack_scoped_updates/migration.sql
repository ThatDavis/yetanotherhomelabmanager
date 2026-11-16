-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "project" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "UpdateSchedule" ADD COLUMN     "containerProjects" TEXT NOT NULL DEFAULT '[]';

