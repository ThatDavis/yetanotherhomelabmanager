-- AlterTable
ALTER TABLE "UpdateSchedule" ADD COLUMN     "verifyUpdates" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "HostService" (
    "id" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "port" INTEGER NOT NULL,

    CONSTRAINT "HostService_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HostService_hostId_idx" ON "HostService"("hostId");

-- AddForeignKey
ALTER TABLE "HostService" ADD CONSTRAINT "HostService_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "Host"("id") ON DELETE CASCADE ON UPDATE CASCADE;

