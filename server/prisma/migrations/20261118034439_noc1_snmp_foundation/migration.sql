-- CreateTable
CREATE TABLE "SnmpProfile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 161,
    "secretRef" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SnmpProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "siteId" TEXT,
    "sysDescr" TEXT NOT NULL DEFAULT '',
    "sysObjectId" TEXT NOT NULL DEFAULT '',
    "sysName" TEXT NOT NULL DEFAULT '',
    "vendor" TEXT NOT NULL DEFAULT '',
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceInterface" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "ifIndex" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "descr" TEXT NOT NULL DEFAULT '',
    "alias" TEXT NOT NULL DEFAULT '',
    "speedBps" BIGINT NOT NULL DEFAULT 0,
    "mac" TEXT NOT NULL DEFAULT '',
    "operStatus" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "DeviceInterface_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SnmpProfile_name_key" ON "SnmpProfile"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Device_address_profileId_key" ON "Device"("address", "profileId");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceInterface_deviceId_ifIndex_key" ON "DeviceInterface"("deviceId", "ifIndex");

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "SnmpProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceInterface" ADD CONSTRAINT "DeviceInterface_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
