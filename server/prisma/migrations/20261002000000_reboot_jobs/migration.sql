-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'update';

-- CreateTable
CREATE TABLE "_HostToJob" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_HostToJob_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "_HostToJob_B_index" ON "_HostToJob"("B");

-- AddForeignKey
ALTER TABLE "_HostToJob" ADD CONSTRAINT "_HostToJob_A_fkey" FOREIGN KEY ("A") REFERENCES "Host"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_HostToJob" ADD CONSTRAINT "_HostToJob_B_fkey" FOREIGN KEY ("B") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

