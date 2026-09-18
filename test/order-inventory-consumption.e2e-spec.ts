import { randomUUID } from 'node:crypto';
import {
  Prisma,
  PrismaClient,
  ServeStatus,
  SessionStatus,
} from '@prisma/client';
import { InventoryConsumptionService } from '../src/app/inventory/services/inventory-consumption.service';

describe('Order inventory consumption (e2e)', () => {
  const prisma = new PrismaClient();
  const consumptionService = new InventoryConsumptionService({
    emit: jest.fn(),
  } as never);
  const suffix = randomUUID();

  let positionId: string;
  let employeeId: string;
  let inventoryCategoryId: string;
  let unitId: string;
  let menuCategoryId: string;
  let orderSessionId: string;
  let insufficientInventoryItemId: string;
  let concurrentInventoryItemId: string;
  let insufficientOrderItemId: string;
  let concurrentOrderItemId: string;

  beforeAll(async () => {
    const position = await prisma.position.create({
      data: { name: `Consumption Position ${suffix}`, salary: 0 },
    });
    positionId = position.id;

    const employee = await prisma.employee.create({
      data: {
        email: `consumption-${suffix}@example.com`,
        username: `consumption-${suffix}`,
        fullName: 'Consumption Test Employee',
        password: 'not-used-in-consumption-tests',
        positionId,
      },
    });
    employeeId = employee.id;

    const inventoryCategory = await prisma.inventoryCategory.create({
      data: { name: `Consumption Inventory ${suffix}` },
    });
    inventoryCategoryId = inventoryCategory.id;
    const unit = await prisma.unit.create({
      data: { name: `Consumption Unit ${suffix}` },
    });
    unitId = unit.id;

    const [insufficientInventoryItem, concurrentInventoryItem] =
      await Promise.all([
        prisma.inventoryItem.create({
          data: {
            name: `Insufficient Ingredient ${suffix}`,
            stock: 1,
            categoryId: inventoryCategoryId,
            unitId,
          },
        }),
        prisma.inventoryItem.create({
          data: {
            name: `Concurrent Ingredient ${suffix}`,
            stock: 10,
            categoryId: inventoryCategoryId,
            unitId,
          },
        }),
      ]);
    insufficientInventoryItemId = insufficientInventoryItem.id;
    concurrentInventoryItemId = concurrentInventoryItem.id;

    const menuCategory = await prisma.menuCategory.create({
      data: { name: `Consumption Menu ${suffix}` },
    });
    menuCategoryId = menuCategory.id;
    const [insufficientMenuItem, concurrentMenuItem] = await Promise.all([
      prisma.menuItem.create({
        data: {
          name: `Insufficient Menu Item ${suffix}`,
          price: 10,
          categoryId: menuCategoryId,
          ingredients: {
            create: {
              inventoryItemId: insufficientInventoryItemId,
              quantity: 1,
            },
          },
        },
      }),
      prisma.menuItem.create({
        data: {
          name: `Concurrent Menu Item ${suffix}`,
          price: 10,
          categoryId: menuCategoryId,
          ingredients: {
            create: {
              inventoryItemId: concurrentInventoryItemId,
              quantity: 1,
            },
          },
        },
      }),
    ]);

    const orderSession = await prisma.orderSession.create({
      data: { employeeId, sessionStatus: SessionStatus.ACTIVE },
    });
    orderSessionId = orderSession.id;
    const [insufficientOrderItem, concurrentOrderItem] = await Promise.all([
      prisma.orderItem.create({
        data: {
          orderSessionId,
          menuItemId: insufficientMenuItem.id,
          quantity: 2,
          priceAtTime: 10,
        },
      }),
      prisma.orderItem.create({
        data: {
          orderSessionId,
          menuItemId: concurrentMenuItem.id,
          quantity: 2,
          priceAtTime: 10,
        },
      }),
    ]);
    insufficientOrderItemId = insufficientOrderItem.id;
    concurrentOrderItemId = concurrentOrderItem.id;
  });

  afterAll(async () => {
    try {
      await prisma.inventoryWaste.deleteMany({
        where: {
          orderItemId: { in: [insufficientOrderItemId, concurrentOrderItemId] },
        },
      });
      await prisma.inventoryTransaction.deleteMany({
        where: {
          orderItemId: { in: [insufficientOrderItemId, concurrentOrderItemId] },
        },
      });
      await prisma.orderItemIngredientSnapshot.deleteMany({
        where: {
          orderItemId: { in: [insufficientOrderItemId, concurrentOrderItemId] },
        },
      });
      await prisma.orderItem.deleteMany({ where: { orderSessionId } });
      await prisma.orderSession.deleteMany({ where: { id: orderSessionId } });
      await prisma.menuItemIngredient.deleteMany({
        where: {
          inventoryItemId: {
            in: [insufficientInventoryItemId, concurrentInventoryItemId],
          },
        },
      });
      await prisma.menuItem.deleteMany({
        where: { categoryId: menuCategoryId },
      });
      await prisma.menuCategory.deleteMany({ where: { id: menuCategoryId } });
      await prisma.inventoryItem.deleteMany({
        where: {
          id: { in: [insufficientInventoryItemId, concurrentInventoryItemId] },
        },
      });
      await prisma.inventoryCategory.deleteMany({
        where: { id: inventoryCategoryId },
      });
      await prisma.unit.deleteMany({ where: { id: unitId } });
      await prisma.employee.deleteMany({ where: { id: employeeId } });
      await prisma.position.deleteMany({ where: { id: positionId } });
    } finally {
      await prisma.$disconnect();
    }
  });

  const startCooking = (orderItemId: string) =>
    prisma.$transaction(
      async (tx) => {
        const orderItem = await tx.orderItem.findUniqueOrThrow({
          where: { id: orderItemId },
          select: { id: true, menuItemId: true, quantity: true },
        });
        const claimed = await tx.orderItem.updateMany({
          where: { id: orderItemId, serveStatus: ServeStatus.PENDING },
          data: { serveStatus: ServeStatus.COOKING },
        });
        if (claimed.count !== 1) return false;

        await consumptionService.consumeOrderItem(tx as never, orderItem);
        return true;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

  it('rolls back status and stock when any ingredient is insufficient', async () => {
    await expect(startCooking(insufficientOrderItemId)).rejects.toBeDefined();

    const [orderItem, inventoryItem, snapshots, transactions] =
      await Promise.all([
        prisma.orderItem.findUniqueOrThrow({
          where: { id: insufficientOrderItemId },
        }),
        prisma.inventoryItem.findUniqueOrThrow({
          where: { id: insufficientInventoryItemId },
        }),
        prisma.orderItemIngredientSnapshot.count({
          where: { orderItemId: insufficientOrderItemId },
        }),
        prisma.inventoryTransaction.count({
          where: { orderItemId: insufficientOrderItemId },
        }),
      ]);

    expect(orderItem.serveStatus).toBe(ServeStatus.PENDING);
    expect(inventoryItem.stock.toString()).toBe('1');
    expect(snapshots).toBe(0);
    expect(transactions).toBe(0);
  });

  it('allows only one concurrent consumption for an order item', async () => {
    const results = await Promise.allSettled([
      startCooking(concurrentOrderItemId),
      startCooking(concurrentOrderItemId),
    ]);
    const successfulClaims = results.filter(
      (result) => result.status === 'fulfilled' && result.value,
    );

    const [orderItem, inventoryItem, snapshots, transactions] =
      await Promise.all([
        prisma.orderItem.findUniqueOrThrow({
          where: { id: concurrentOrderItemId },
        }),
        prisma.inventoryItem.findUniqueOrThrow({
          where: { id: concurrentInventoryItemId },
        }),
        prisma.orderItemIngredientSnapshot.count({
          where: { orderItemId: concurrentOrderItemId },
        }),
        prisma.inventoryTransaction.count({
          where: { orderItemId: concurrentOrderItemId },
        }),
      ]);

    expect(successfulClaims).toHaveLength(1);
    expect(orderItem.serveStatus).toBe(ServeStatus.COOKING);
    expect(inventoryItem.stock.toString()).toBe('8');
    expect(snapshots).toBe(1);
    expect(transactions).toBe(1);
  });
});
