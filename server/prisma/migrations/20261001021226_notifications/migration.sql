-- AlterTable
ALTER TABLE "PingTarget" ADD COLUMN     "notify" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "notifyEmail" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Webhook" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "url" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Webhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "_PingTargetToWebhook" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_PingTargetToWebhook_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "_PingTargetToWebhook_B_index" ON "_PingTargetToWebhook"("B");

-- AddForeignKey
ALTER TABLE "_PingTargetToWebhook" ADD CONSTRAINT "_PingTargetToWebhook_A_fkey" FOREIGN KEY ("A") REFERENCES "PingTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PingTargetToWebhook" ADD CONSTRAINT "_PingTargetToWebhook_B_fkey" FOREIGN KEY ("B") REFERENCES "Webhook"("id") ON DELETE CASCADE ON UPDATE CASCADE;
