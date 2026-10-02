-- AlterTable
ALTER TABLE "Host" ADD COLUMN "bootOrder" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "UpdateSchedule" ADD COLUMN "rebootAfterUpdate" BOOLEAN NOT NULL DEFAULT false;
