-- AlterTable
ALTER TABLE "Node" ADD COLUMN     "lastCheckedAt" TIMESTAMP(3),
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'unknown';
