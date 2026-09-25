import 'dotenv/config';
import { PrismaClient, SettingValueType } from '@prisma/client';
import bcrypt from 'bcrypt';
import {
  CashControlSettingDefaults,
  CashControlSettingKeys,
} from '../src/common/consts/cash-control-settings';
import {
  PermissionKeys,
  SYSTEM_ROLE_NAMES,
} from '../src/common/consts/permission-keys';
import type { PermissionKey } from '../src/common/types';

const prisma = new PrismaClient();

type PermissionSeed = {
  key: string;
  name: string;
  description: string;
};

type RoleSeed = {
  name: string;
  description: string;
  permissions: PermissionKey[];
};

const toTitle = (keyName: string) =>
  keyName
    .split('_')
    .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
    .join(' ');

const permissionSeeds: PermissionSeed[] = Object.entries(PermissionKeys).map(
  ([name, key]) => ({
    key,
    name: toTitle(name),
    description: `Allows ${key}`,
  }),
);

const roleSeeds: RoleSeed[] = [
  {
    name: SYSTEM_ROLE_NAMES.OWNER,
    description: 'System owner with every permission',
    permissions: Object.values(PermissionKeys),
  },
  {
    name: SYSTEM_ROLE_NAMES.MANAGER,
    description:
      'Manager for staff, menu, tables, orders, invoices, and reports',
    permissions: [
      PermissionKeys.PERMISSIONS_READ,
      PermissionKeys.ROLES_READ,
      PermissionKeys.ROLE_PERMISSIONS_READ,
      PermissionKeys.EMPLOYEES_READ,
      PermissionKeys.EMPLOYEES_CREATE,
      PermissionKeys.EMPLOYEES_UPDATE,
      PermissionKeys.EMPLOYEE_ROLES_READ,
      PermissionKeys.EMPLOYEE_ROLES_UPDATE,
      PermissionKeys.POSITIONS_READ,
      PermissionKeys.DINING_TABLES_READ,
      PermissionKeys.DINING_TABLES_CREATE,
      PermissionKeys.DINING_TABLES_UPDATE,
      PermissionKeys.DINING_TABLES_DELETE,
      PermissionKeys.ORDERS_SESSIONS_READ,
      PermissionKeys.ORDERS_SESSIONS_CREATE,
      PermissionKeys.ORDERS_SESSIONS_CANCEL,
      PermissionKeys.ORDERS_ITEMS_CREATE,
      PermissionKeys.ORDERS_ITEMS_UPDATE_STATUS,
      PermissionKeys.ORDERS_ITEMS_CANCEL,
      PermissionKeys.ORDERS_TABLES_TRANSFER,
      PermissionKeys.ORDERS_TABLES_MERGE,
      PermissionKeys.ORDERS_TABLES_SPLIT,
      PermissionKeys.ORDERS_TABLES_CLEAR,
      PermissionKeys.KITCHEN_STATIONS_READ,
      PermissionKeys.KITCHEN_STATIONS_MANAGE,
      PermissionKeys.KITCHEN_TICKETS_READ,
      PermissionKeys.MENU_READ,
      PermissionKeys.MENU_CREATE,
      PermissionKeys.MENU_UPDATE,
      PermissionKeys.INVENTORY_READ,
      PermissionKeys.INVENTORY_STOCK_ADJUST,
      PermissionKeys.INVENTORY_SUPPLIERS_READ,
      PermissionKeys.INVENTORY_SUPPLIERS_MANAGE,
      PermissionKeys.INVENTORY_PURCHASE_RECEIPTS_READ,
      PermissionKeys.INVENTORY_PURCHASE_RECEIPTS_CREATE,
      PermissionKeys.INVENTORY_PURCHASE_RECEIPTS_POST,
      PermissionKeys.INVENTORY_STOCKTAKES_READ,
      PermissionKeys.INVENTORY_STOCKTAKES_CREATE,
      PermissionKeys.INVENTORY_STOCKTAKES_POST,
      PermissionKeys.INVOICES_READ,
      PermissionKeys.INVOICES_CREATE,
      PermissionKeys.INVOICES_UPDATE,
      PermissionKeys.PAYMENT_ATTEMPTS_CREATE,
      PermissionKeys.PAYMENT_ATTEMPTS_READ,
      PermissionKeys.PAYMENT_REFUNDS_CREATE,
      PermissionKeys.PAYMENT_REFUNDS_READ,
      PermissionKeys.PAYMENT_RECONCILIATION_READ,
      PermissionKeys.PAYMENT_RECONCILIATION_MANAGE,
      PermissionKeys.PRINT_DEVICES_READ,
      PermissionKeys.PRINT_DEVICES_MANAGE,
      PermissionKeys.PRINT_JOBS_READ,
      PermissionKeys.PRINT_JOBS_MANAGE,
      PermissionKeys.RECEIPTS_REPRINT,
      PermissionKeys.PROMOTIONS_READ,
      PermissionKeys.PROMOTIONS_CREATE,
      PermissionKeys.PROMOTIONS_UPDATE,
      PermissionKeys.RESERVATIONS_READ,
      PermissionKeys.RESERVATIONS_CREATE,
      PermissionKeys.RESERVATIONS_UPDATE,
      PermissionKeys.RESERVATIONS_CANCEL,
      PermissionKeys.RESERVATIONS_CHECK_IN,
      PermissionKeys.EQUIPMENT_READ,
      PermissionKeys.EQUIPMENT_CREATE,
      PermissionKeys.EQUIPMENT_UPDATE,
      PermissionKeys.EQUIPMENT_TRANSITION,
      PermissionKeys.SYSTEM_SETTINGS_READ,
      PermissionKeys.SYSTEM_SETTINGS_UPDATE,
      PermissionKeys.REPORTS_READ,
      PermissionKeys.REPORTS_EXPORT,
      PermissionKeys.REPORTS_CLOSE,
      PermissionKeys.FUNDS_READ,
      PermissionKeys.FUNDS_MANAGE,
      PermissionKeys.CASHIER_SHIFTS_CURRENT,
      PermissionKeys.CASHIER_SHIFTS_READ,
      PermissionKeys.CASHIER_SHIFTS_OPEN,
      PermissionKeys.CASHIER_SHIFTS_CLOSE,
      PermissionKeys.CASHIER_SHIFTS_TRANSACTIONS_CREATE,
      PermissionKeys.CASHIER_SHIFTS_EXPENSES_REVIEW,
      PermissionKeys.CASH_HANDOVERS_CREATE,
      PermissionKeys.CASH_HANDOVERS_READ,
      PermissionKeys.CASH_HANDOVERS_REVIEW,
      PermissionKeys.CASH_HANDOVERS_SETTLE,
      PermissionKeys.BANK_RECONCILIATION_READ,
      PermissionKeys.BANK_RECONCILIATION_IMPORT,
      PermissionKeys.BANK_RECONCILIATION_MANAGE,
    ],
  },
  {
    name: SYSTEM_ROLE_NAMES.CASHIER,
    description: 'Cashier for sessions, payments, and invoices',
    permissions: [
      PermissionKeys.DINING_TABLES_READ,
      PermissionKeys.ORDERS_SESSIONS_READ,
      PermissionKeys.ORDERS_SESSIONS_CREATE,
      PermissionKeys.ORDERS_SESSIONS_CANCEL,
      PermissionKeys.ORDERS_ITEMS_CREATE,
      PermissionKeys.ORDERS_ITEMS_CANCEL,
      PermissionKeys.ORDERS_TABLES_TRANSFER,
      PermissionKeys.ORDERS_TABLES_MERGE,
      PermissionKeys.ORDERS_TABLES_SPLIT,
      PermissionKeys.ORDERS_TABLES_CLEAR,
      PermissionKeys.MENU_READ,
      PermissionKeys.INVOICES_READ,
      PermissionKeys.INVOICES_CREATE,
      PermissionKeys.INVOICES_UPDATE,
      PermissionKeys.PAYMENT_ATTEMPTS_CREATE,
      PermissionKeys.PAYMENT_ATTEMPTS_READ,
      PermissionKeys.PAYMENT_REFUNDS_READ,
      PermissionKeys.PRINT_JOBS_READ,
      PermissionKeys.RECEIPTS_REPRINT,
      PermissionKeys.PROMOTIONS_READ,
      PermissionKeys.RESERVATIONS_READ,
      PermissionKeys.RESERVATIONS_CREATE,
      PermissionKeys.RESERVATIONS_UPDATE,
      PermissionKeys.RESERVATIONS_CANCEL,
      PermissionKeys.RESERVATIONS_CHECK_IN,
      PermissionKeys.FUNDS_READ,
      PermissionKeys.CASHIER_SHIFTS_CURRENT,
      PermissionKeys.CASHIER_SHIFTS_OPEN,
      PermissionKeys.CASHIER_SHIFTS_CLOSE,
      PermissionKeys.CASHIER_SHIFTS_TRANSACTIONS_CREATE,
      PermissionKeys.CASH_HANDOVERS_CREATE,
    ],
  },
  {
    name: SYSTEM_ROLE_NAMES.WAITER,
    description: 'Waiter for table service and order entry',
    permissions: [
      PermissionKeys.DINING_TABLES_READ,
      PermissionKeys.ORDERS_SESSIONS_READ,
      PermissionKeys.ORDERS_SESSIONS_CREATE,
      PermissionKeys.ORDERS_ITEMS_CREATE,
      PermissionKeys.ORDERS_ITEMS_CANCEL,
      PermissionKeys.ORDERS_TABLES_TRANSFER,
      PermissionKeys.ORDERS_TABLES_MERGE,
      PermissionKeys.ORDERS_TABLES_SPLIT,
      PermissionKeys.MENU_READ,
      PermissionKeys.RESERVATIONS_READ,
      PermissionKeys.RESERVATIONS_CREATE,
      PermissionKeys.RESERVATIONS_CANCEL,
      PermissionKeys.RESERVATIONS_CHECK_IN,
    ],
  },
  {
    name: SYSTEM_ROLE_NAMES.KITCHEN,
    description: 'Kitchen staff for order item status updates',
    permissions: [
      PermissionKeys.ORDERS_SESSIONS_READ,
      PermissionKeys.ORDERS_ITEMS_UPDATE_STATUS,
      PermissionKeys.MENU_READ,
      PermissionKeys.KITCHEN_STATIONS_READ,
      PermissionKeys.KITCHEN_TICKETS_READ,
    ],
  },
  {
    name: SYSTEM_ROLE_NAMES.INVENTORY_STAFF,
    description: 'Inventory staff for stock and equipment management',
    permissions: [
      PermissionKeys.INVENTORY_READ,
      PermissionKeys.INVENTORY_CREATE,
      PermissionKeys.INVENTORY_UPDATE,
      PermissionKeys.INVENTORY_STOCK_ADJUST,
      PermissionKeys.INVENTORY_SUPPLIERS_READ,
      PermissionKeys.INVENTORY_SUPPLIERS_MANAGE,
      PermissionKeys.INVENTORY_PURCHASE_RECEIPTS_READ,
      PermissionKeys.INVENTORY_PURCHASE_RECEIPTS_CREATE,
      PermissionKeys.INVENTORY_PURCHASE_RECEIPTS_POST,
      PermissionKeys.INVENTORY_STOCKTAKES_READ,
      PermissionKeys.INVENTORY_STOCKTAKES_CREATE,
      PermissionKeys.INVENTORY_STOCKTAKES_POST,
      PermissionKeys.EQUIPMENT_READ,
      PermissionKeys.EQUIPMENT_CREATE,
      PermissionKeys.EQUIPMENT_UPDATE,
      PermissionKeys.EQUIPMENT_TRANSITION,
      PermissionKeys.MENU_READ,
    ],
  },
];

async function upsertPermission(seed: PermissionSeed) {
  const existing = await prisma.permission.findFirst({
    where: { key: seed.key, deletedAt: null },
    select: { id: true },
  });

  if (existing) {
    return prisma.permission.update({
      where: { id: existing.id },
      data: {
        name: seed.name,
        description: seed.description,
        isSystemPermission: true,
      },
    });
  }

  return prisma.permission.create({
    data: {
      ...seed,
      isSystemPermission: true,
    },
  });
}

async function upsertRole(seed: RoleSeed) {
  const existing = await prisma.role.findFirst({
    where: { name: seed.name, deletedAt: null },
    select: { id: true },
  });

  if (existing) {
    return prisma.role.update({
      where: { id: existing.id },
      data: {
        description: seed.description,
        isSystemRole: true,
      },
    });
  }

  return prisma.role.create({
    data: {
      name: seed.name,
      description: seed.description,
      isSystemRole: true,
    },
  });
}

async function seedCashControlSettings() {
  const seeds = [
    {
      key: CashControlSettingKeys.EXPENSE_APPROVAL_THRESHOLD,
      value: CashControlSettingDefaults.EXPENSE_APPROVAL_THRESHOLD,
      description: 'Cash expense amount that requires manager approval',
    },
    {
      key: CashControlSettingKeys.SHIFT_DISCREPANCY_NOTE_THRESHOLD,
      value: CashControlSettingDefaults.SHIFT_DISCREPANCY_NOTE_THRESHOLD,
      description: 'Cash discrepancy amount that requires a closing note',
    },
    {
      key: CashControlSettingKeys.HANDOVER_SETTLEMENT_SLA_HOURS,
      value: CashControlSettingDefaults.HANDOVER_SETTLEMENT_SLA_HOURS,
      description: 'Hours allowed to confirm a bank handover settlement',
    },
  ];

  for (const seed of seeds) {
    const existing = await prisma.systemSetting.findUnique({
      where: { key: seed.key },
      select: { id: true, valueType: true },
    });
    if (existing) {
      if (existing.valueType !== SettingValueType.NUMBER) {
        throw new Error(`System setting '${seed.key}' must use NUMBER type`);
      }
      await prisma.systemSetting.update({
        where: { id: existing.id },
        data: { isSystem: true, deletedAt: null },
      });
      continue;
    }

    await prisma.systemSetting.create({
      data: {
        ...seed,
        valueType: SettingValueType.NUMBER,
        isPublic: false,
        isSystem: true,
        revisions: {
          create: {
            version: 1,
            value: seed.value,
            valueType: SettingValueType.NUMBER,
            description: seed.description,
            isPublic: false,
          },
        },
      },
    });
  }
}

async function main(permissionsOnly: boolean) {
  if (!permissionsOnly) await seedCashControlSettings();
  const permissions = await Promise.all(permissionSeeds.map(upsertPermission));
  const permissionByKey = new Map(
    permissions.map((permission) => [permission.key, permission.id]),
  );

  for (const roleSeed of roleSeeds) {
    const role = await upsertRole(roleSeed);
    const data = roleSeed.permissions.map((permissionKey) => ({
      roleId: role.id,
      permissionId: permissionByKey.get(permissionKey)!,
    }));
    if (permissionsOnly) {
      await prisma.rolePermission.createMany({ data, skipDuplicates: true });
    } else {
      await prisma.$transaction([
        prisma.rolePermission.deleteMany({ where: { roleId: role.id } }),
        prisma.rolePermission.createMany({ data, skipDuplicates: true }),
      ]);
    }
  }

  if (permissionsOnly) return;
  const ownerEmail = process.env.OWNER_EMAIL;
  if (ownerEmail) {
    const [existingOwner, ownerRole] = await Promise.all([
      prisma.employee.findUnique({ where: { email: ownerEmail } }),
      prisma.role.findFirst({
        where: { name: SYSTEM_ROLE_NAMES.OWNER, deletedAt: null },
      }),
    ]);

    if (!ownerRole) {
      throw new Error('OWNER role was not created');
    }

    let owner = existingOwner;
    if (!owner) {
      const ownerPassword = process.env.OWNER_PASSWORD;
      const ownerUsername = process.env.OWNER_USERNAME;
      const ownerFullName = process.env.OWNER_FULL_NAME;
      if (!ownerPassword || !ownerUsername || !ownerFullName) {
        throw new Error(
          'OWNER_PASSWORD, OWNER_USERNAME and OWNER_FULL_NAME are required when bootstrapping a new owner',
        );
      }
      if (ownerPassword.length < 12) {
        throw new Error('OWNER_PASSWORD must contain at least 12 characters');
      }

      let staffPosition = await prisma.position.findFirst({
        where: { name: 'Staff', deletedAt: null },
      });
      staffPosition ??= await prisma.position.create({
        data: { name: 'Staff', salary: 0 },
      });

      owner = await prisma.employee.create({
        data: {
          email: ownerEmail,
          username: ownerUsername,
          fullName: ownerFullName,
          password: await bcrypt.hash(ownerPassword, 12),
          positionId: staffPosition.id,
          isActive: true,
        },
      });
    }

    if (owner) {
      await prisma.employeeRole.upsert({
        where: {
          employeeId_roleId: {
            employeeId: owner.id,
            roleId: ownerRole.id,
          },
        },
        create: { employeeId: owner.id, roleId: ownerRole.id },
        update: {},
      });
    }
  }
}

main(process.argv.includes('--permissions-only'))
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
