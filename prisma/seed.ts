import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import {
  PermissionKeys,
  SYSTEM_ROLE_NAMES,
} from '../src/common/consts/permission-keys';

const prisma = new PrismaClient();

type PermissionSeed = {
  key: string;
  name: string;
  description: string;
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

const roleSeeds = [
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
      PermissionKeys.MENU_READ,
      PermissionKeys.MENU_CREATE,
      PermissionKeys.MENU_UPDATE,
      PermissionKeys.INVOICES_READ,
      PermissionKeys.INVOICES_CREATE,
      PermissionKeys.INVOICES_UPDATE,
      PermissionKeys.PROMOTIONS_READ,
      PermissionKeys.PROMOTIONS_CREATE,
      PermissionKeys.PROMOTIONS_UPDATE,
      PermissionKeys.RESERVATIONS_READ,
      PermissionKeys.RESERVATIONS_CREATE,
      PermissionKeys.RESERVATIONS_UPDATE,
      PermissionKeys.EQUIPMENT_READ,
      PermissionKeys.SYSTEM_SETTINGS_READ,
      PermissionKeys.SYSTEM_SETTINGS_UPDATE,
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
      PermissionKeys.PROMOTIONS_READ,
      PermissionKeys.RESERVATIONS_READ,
      PermissionKeys.RESERVATIONS_CREATE,
      PermissionKeys.RESERVATIONS_UPDATE,
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
    ],
  },
  {
    name: SYSTEM_ROLE_NAMES.KITCHEN,
    description: 'Kitchen staff for order item status updates',
    permissions: [
      PermissionKeys.ORDERS_SESSIONS_READ,
      PermissionKeys.ORDERS_ITEMS_UPDATE_STATUS,
      PermissionKeys.MENU_READ,
    ],
  },
  {
    name: SYSTEM_ROLE_NAMES.INVENTORY_STAFF,
    description: 'Inventory staff for stock and equipment management',
    permissions: [
      PermissionKeys.INVENTORY_READ,
      PermissionKeys.INVENTORY_CREATE,
      PermissionKeys.INVENTORY_UPDATE,
      PermissionKeys.EQUIPMENT_READ,
      PermissionKeys.EQUIPMENT_CREATE,
      PermissionKeys.EQUIPMENT_UPDATE,
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

async function upsertRole(seed: (typeof roleSeeds)[number]) {
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

async function main() {
  const permissions = await Promise.all(permissionSeeds.map(upsertPermission));
  const permissionByKey = new Map(
    permissions.map((permission) => [permission.key, permission.id]),
  );

  for (const roleSeed of roleSeeds) {
    const role = await upsertRole(roleSeed);
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: roleSeed.permissions.map((permissionKey) => ({
        roleId: role.id,
        permissionId: permissionByKey.get(permissionKey)!,
      })),
      skipDuplicates: true,
    });
  }

  const ownerEmail = process.env.OWNER_EMAIL;
  if (ownerEmail) {
    const [owner, ownerRole] = await Promise.all([
      prisma.employee.findUnique({ where: { email: ownerEmail } }),
      prisma.role.findFirst({
        where: { name: SYSTEM_ROLE_NAMES.OWNER, deletedAt: null },
      }),
    ]);

    if (owner && ownerRole) {
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

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
