-- AlterTable
ALTER TABLE "Host" ADD COLUMN     "osCheckedAt" TIMESTAMP(3),
ADD COLUMN     "osUpdatesPending" INTEGER NOT NULL DEFAULT -1;

-- CreateTable
CREATE TABLE "ComposeStack" (
    "id" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "project" TEXT NOT NULL,
    "configFiles" TEXT NOT NULL DEFAULT '',
    "services" TEXT NOT NULL DEFAULT '[]',
    "drift" BOOLEAN NOT NULL DEFAULT false,
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComposeStack_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ComposeStack_hostId_project_key" ON "ComposeStack"("hostId", "project");

-- AddForeignKey
ALTER TABLE "ComposeStack" ADD CONSTRAINT "ComposeStack_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "Host"("id") ON DELETE CASCADE ON UPDATE CASCADE;

