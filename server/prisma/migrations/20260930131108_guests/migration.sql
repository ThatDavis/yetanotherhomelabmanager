-- CreateTable
CREATE TABLE "Guest" (
    "id" TEXT NOT NULL,
    "nodeDbId" TEXT NOT NULL,
    "pveNode" TEXT NOT NULL,
    "vmid" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Guest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Guest_nodeDbId_vmid_key" ON "Guest"("nodeDbId", "vmid");
