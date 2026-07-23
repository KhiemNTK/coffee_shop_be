/*
  Warnings:

  - The `status` column on the `DiningTable` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the column `budgetId` on the `Invoice` table. All the data in the column will be lost.
  - You are about to drop the column `deletedAt` on the `Invoice` table. All the data in the column will be lost.
  - You are about to drop the column `dateTime` on the `Reservation` table. All the data in the column will be lost.
  - You are about to drop the column `invoiceId` on the `Reservation` table. All the data in the column will be lost.
  - You are about to drop the `Budget` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ExpenseVoucher` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ExportItemDetail` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ExportOrder` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ImportEquipmentDetail` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ImportItemDetail` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ImportOrder` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `InvoiceDetail` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `InvoicePromotion` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[cashTransactionId]` on the table `Equipment` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[invoiceNumber]` on the table `Invoice` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `name` to the `DiningTable` table without a default value. This is not possible if the table is not empty.
  - Added the required column `employeeId` to the `Equipment` table without a default value. This is not possible if the table is not empty.
  - Added the required column `purchaseDate` to the `Equipment` table without a default value. This is not possible if the table is not empty.
  - Added the required column `quantity` to the `Equipment` table without a default value. This is not possible if the table is not empty.
  - Added the required column `totalAmount` to the `Equipment` table without a default value. This is not possible if the table is not empty.
  - Added the required column `unitPrice` to the `Equipment` table without a default value. This is not possible if the table is not empty.
  - Added the required column `categoryId` to the `InventoryItem` table without a default value. This is not possible if the table is not empty.
  - Added the required column `invoiceNumber` to the `Invoice` table without a default value. This is not possible if the table is not empty.
  - Added the required column `orderSessionId` to the `Invoice` table without a default value. This is not possible if the table is not empty.
  - Added the required column `subTotal` to the `Invoice` table without a default value. This is not possible if the table is not empty.
  - Made the column `employeeId` on table `Invoice` required. This step will fail if there are existing NULL values in that column.
  - Added the required column `categoryId` to the `MenuItem` table without a default value. This is not possible if the table is not empty.
  - Added the required column `discountType` to the `Promotion` table without a default value. This is not possible if the table is not empty.
  - Added the required column `discountValue` to the `Promotion` table without a default value. This is not possible if the table is not empty.
  - Added the required column `endDate` to the `Promotion` table without a default value. This is not possible if the table is not empty.
  - Added the required column `startDate` to the `Promotion` table without a default value. This is not possible if the table is not empty.
  - Added the required column `phoneNumber` to the `Reservation` table without a default value. This is not possible if the table is not empty.
  - Added the required column `reservationDate` to the `Reservation` table without a default value. This is not possible if the table is not empty.
  - Added the required column `reservationTime` to the `Reservation` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "TableStatus" AS ENUM ('EMPTY', 'OCCUPIED', 'RESERVED');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ServeStatus" AS ENUM ('PENDING', 'COOKING', 'SERVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'CARD', 'TRANSFER');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED');

-- CreateEnum
CREATE TYPE "InventoryTxType" AS ENUM ('IMPORT', 'EXPORT');

-- CreateEnum
CREATE TYPE "CashFlowType" AS ENUM ('INCOME', 'EXPENSE');

-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('PENDING', 'ARRIVED', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "EquipmentStatus" AS ENUM ('IN_USE', 'MAINTENANCE', 'BROKEN', 'LIQUIDATED');

-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('OPEN', 'CLOSED');

-- DropForeignKey
ALTER TABLE "EmployeeRole" DROP CONSTRAINT "EmployeeRole_employeeId_fkey";

-- DropForeignKey
ALTER TABLE "EmployeeRole" DROP CONSTRAINT "EmployeeRole_roleId_fkey";

-- DropForeignKey
ALTER TABLE "ExpenseVoucher" DROP CONSTRAINT "ExpenseVoucher_budgetId_fkey";

-- DropForeignKey
ALTER TABLE "ExpenseVoucher" DROP CONSTRAINT "ExpenseVoucher_employeeId_fkey";

-- DropForeignKey
ALTER TABLE "ExportItemDetail" DROP CONSTRAINT "ExportItemDetail_exportOrderId_fkey";

-- DropForeignKey
ALTER TABLE "ExportItemDetail" DROP CONSTRAINT "ExportItemDetail_inventoryItemId_fkey";

-- DropForeignKey
ALTER TABLE "ExportOrder" DROP CONSTRAINT "ExportOrder_budgetId_fkey";

-- DropForeignKey
ALTER TABLE "ExportOrder" DROP CONSTRAINT "ExportOrder_employeeId_fkey";

-- DropForeignKey
ALTER TABLE "ImportEquipmentDetail" DROP CONSTRAINT "ImportEquipmentDetail_equipmentId_fkey";

-- DropForeignKey
ALTER TABLE "ImportEquipmentDetail" DROP CONSTRAINT "ImportEquipmentDetail_importOrderId_fkey";

-- DropForeignKey
ALTER TABLE "ImportItemDetail" DROP CONSTRAINT "ImportItemDetail_importOrderId_fkey";

-- DropForeignKey
ALTER TABLE "ImportItemDetail" DROP CONSTRAINT "ImportItemDetail_inventoryItemId_fkey";

-- DropForeignKey
ALTER TABLE "ImportOrder" DROP CONSTRAINT "ImportOrder_budgetId_fkey";

-- DropForeignKey
ALTER TABLE "ImportOrder" DROP CONSTRAINT "ImportOrder_employeeId_fkey";

-- DropForeignKey
ALTER TABLE "Invoice" DROP CONSTRAINT "Invoice_budgetId_fkey";

-- DropForeignKey
ALTER TABLE "Invoice" DROP CONSTRAINT "Invoice_employeeId_fkey";

-- DropForeignKey
ALTER TABLE "InvoiceDetail" DROP CONSTRAINT "InvoiceDetail_invoiceId_fkey";

-- DropForeignKey
ALTER TABLE "InvoiceDetail" DROP CONSTRAINT "InvoiceDetail_menuItemId_fkey";

-- DropForeignKey
ALTER TABLE "InvoicePromotion" DROP CONSTRAINT "InvoicePromotion_invoiceId_fkey";

-- DropForeignKey
ALTER TABLE "InvoicePromotion" DROP CONSTRAINT "InvoicePromotion_promotionId_fkey";

-- DropForeignKey
ALTER TABLE "Reservation" DROP CONSTRAINT "Reservation_invoiceId_fkey";

-- DropForeignKey
ALTER TABLE "RolePermission" DROP CONSTRAINT "RolePermission_permissionId_fkey";

-- DropForeignKey
ALTER TABLE "RolePermission" DROP CONSTRAINT "RolePermission_roleId_fkey";

-- AlterTable
ALTER TABLE "DiningTable" ADD COLUMN     "name" TEXT NOT NULL,
DROP COLUMN "status",
ADD COLUMN     "status" "TableStatus" NOT NULL DEFAULT 'EMPTY';

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "salary" DECIMAL(65,30);

-- AlterTable
ALTER TABLE "Equipment" ADD COLUMN     "cashTransactionId" TEXT,
ADD COLUMN     "employeeId" TEXT NOT NULL,
ADD COLUMN     "purchaseDate" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "quantity" INTEGER NOT NULL,
ADD COLUMN     "status" "EquipmentStatus" NOT NULL DEFAULT 'IN_USE',
ADD COLUMN     "totalAmount" DECIMAL(65,30) NOT NULL,
ADD COLUMN     "unitPrice" DECIMAL(65,30) NOT NULL;

-- AlterTable
ALTER TABLE "InventoryItem" ADD COLUMN     "categoryId" TEXT NOT NULL,
ADD COLUMN     "stock" DECIMAL(65,30) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Invoice" DROP COLUMN "budgetId",
DROP COLUMN "deletedAt",
ADD COLUMN     "amountTendered" DECIMAL(65,30),
ADD COLUMN     "changeAmount" DECIMAL(65,30),
ADD COLUMN     "discountAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
ADD COLUMN     "invoiceNumber" TEXT NOT NULL,
ADD COLUMN     "orderSessionId" TEXT NOT NULL,
ADD COLUMN     "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'CASH',
ADD COLUMN     "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "promotionId" TEXT,
ADD COLUMN     "shiftId" TEXT,
ADD COLUMN     "subTotal" DECIMAL(65,30) NOT NULL,
ADD COLUMN     "taxAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
ADD COLUMN     "taxRate" DECIMAL(65,30) NOT NULL DEFAULT 0,
ALTER COLUMN "employeeId" SET NOT NULL;

-- AlterTable
ALTER TABLE "MenuItem" ADD COLUMN     "categoryId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Promotion" ADD COLUMN     "discountType" "DiscountType" NOT NULL,
ADD COLUMN     "discountValue" DECIMAL(65,30) NOT NULL,
ADD COLUMN     "endDate" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "maxDiscount" DECIMAL(65,30),
ADD COLUMN     "startDate" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "Reservation" DROP COLUMN "dateTime",
DROP COLUMN "invoiceId",
ADD COLUMN     "phoneNumber" TEXT NOT NULL,
ADD COLUMN     "reservationDate" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "reservationTime" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "status" "ReservationStatus" NOT NULL DEFAULT 'PENDING';

-- DropTable
DROP TABLE "Budget";

-- DropTable
DROP TABLE "ExpenseVoucher";

-- DropTable
DROP TABLE "ExportItemDetail";

-- DropTable
DROP TABLE "ExportOrder";

-- DropTable
DROP TABLE "ImportEquipmentDetail";

-- DropTable
DROP TABLE "ImportItemDetail";

-- DropTable
DROP TABLE "ImportOrder";

-- DropTable
DROP TABLE "InvoiceDetail";

-- DropTable
DROP TABLE "InvoicePromotion";

-- CreateTable
CREATE TABLE "Fund" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "balance" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Fund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MenuCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "MenuCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "InventoryCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashierShift" (
    "id" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "startingCash" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "reportedEndingCash" DECIMAL(65,30),
    "actualEndingCash" DECIMAL(65,30),
    "status" "ShiftStatus" NOT NULL DEFAULT 'OPEN',
    "employeeId" TEXT NOT NULL,

    CONSTRAINT "CashierShift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryTransaction" (
    "id" TEXT NOT NULL,
    "type" "InventoryTxType" NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL,
    "unitPrice" DECIMAL(65,30),
    "totalAmount" DECIMAL(65,30),
    "transactionDate" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inventoryItemId" TEXT NOT NULL,

    CONSTRAINT "InventoryTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderSession" (
    "id" TEXT NOT NULL,
    "sessionStatus" "SessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "guestCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tableId" TEXT,
    "employeeId" TEXT NOT NULL,
    "shiftId" TEXT,

    CONSTRAINT "OrderSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "priceAtTime" DECIMAL(65,30) NOT NULL,
    "note" TEXT,
    "serveStatus" "ServeStatus" NOT NULL DEFAULT 'PENDING',
    "isPaid" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "orderSessionId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "invoiceId" TEXT,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashTransaction" (
    "id" TEXT NOT NULL,
    "type" "CashFlowType" NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "description" TEXT NOT NULL,
    "transactionDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "fundId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "shiftId" TEXT,

    CONSTRAINT "CashTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrintSetting" (
    "id" TEXT NOT NULL,
    "paperSize" TEXT NOT NULL,
    "printerName" TEXT NOT NULL,
    "printLimit" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "employeeId" TEXT NOT NULL,

    CONSTRAINT "PrintSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionLog" (
    "id" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "employeeId" TEXT NOT NULL,

    CONSTRAINT "ActionLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PrintSetting_employeeId_key" ON "PrintSetting"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "Equipment_cashTransactionId_key" ON "Equipment"("cashTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_invoiceNumber_key" ON "Invoice"("invoiceNumber");

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeRole" ADD CONSTRAINT "EmployeeRole_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeRole" ADD CONSTRAINT "EmployeeRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "MenuCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Equipment" ADD CONSTRAINT "Equipment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Equipment" ADD CONSTRAINT "Equipment_cashTransactionId_fkey" FOREIGN KEY ("cashTransactionId") REFERENCES "CashTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "InventoryCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashierShift" ADD CONSTRAINT "CashierShift_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryTransaction" ADD CONSTRAINT "InventoryTransaction_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderSession" ADD CONSTRAINT "OrderSession_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "DiningTable"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderSession" ADD CONSTRAINT "OrderSession_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderSession" ADD CONSTRAINT "OrderSession_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "CashierShift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderSessionId_fkey" FOREIGN KEY ("orderSessionId") REFERENCES "OrderSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_orderSessionId_fkey" FOREIGN KEY ("orderSessionId") REFERENCES "OrderSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "CashierShift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashTransaction" ADD CONSTRAINT "CashTransaction_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "Fund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashTransaction" ADD CONSTRAINT "CashTransaction_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashTransaction" ADD CONSTRAINT "CashTransaction_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "CashierShift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrintSetting" ADD CONSTRAINT "PrintSetting_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionLog" ADD CONSTRAINT "ActionLog_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
