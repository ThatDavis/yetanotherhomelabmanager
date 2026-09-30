-- CreateTable
CREATE TABLE "Host" (
    "id" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 22,
    "username" TEXT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Host_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEntry" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT NOT NULL DEFAULT '',
    "params" TEXT NOT NULL DEFAULT '{}',
    "ok" BOOLEAN NOT NULL,
    "output" TEXT NOT NULL DEFAULT '',
    "durationMs" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AuditEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Secret" (
    "id" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Secret_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Host_alias_key" ON "Host"("alias");

-- CreateIndex
CREATE INDEX "AuditEntry_at_idx" ON "AuditEntry"("at");
