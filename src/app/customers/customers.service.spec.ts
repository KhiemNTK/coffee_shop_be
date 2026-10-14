import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { CustomersService } from './customers.service';
import { WISHLIST_LIMIT } from '../../common/consts/customer-auth';

describe('Customer wishlist ownership', () => {
  const fixture = () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'customer-a' }]),
      customerWishlist: {
        findUnique: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn(),
        deleteMany: jest.fn(),
      },
      menuItem: { findFirst: jest.fn().mockResolvedValue({ id: 'item' }) },
    };
    const prisma = {
      $transaction: jest.fn((fn: (value: typeof tx) => unknown) => fn(tx)),
      customerSession: { findUnique: jest.fn(), deleteMany: jest.fn() },
      customerWishlist: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new CustomersService(
      prisma as never,
      {} as never,
      {} as never,
    );
    return { tx, prisma, service };
  };

  it('scopes create and delete to the authenticated customer and makes delete replay safe', async () => {
    const { service, tx } = fixture();
    await service.addFavorite('customer-a', 'item');
    expect(tx.customerWishlist.create).toHaveBeenCalledWith({
      data: { customerId: 'customer-a', menuItemId: 'item' },
    });
    await service.removeFavorite('customer-a', 'item');
    await service.removeFavorite('customer-a', 'item');
    expect(tx.customerWishlist.deleteMany).toHaveBeenCalledTimes(2);
    expect(tx.customerWishlist.deleteMany).toHaveBeenCalledWith({
      where: { customerId: 'customer-a', menuItemId: 'item' },
    });
  });

  it('replays an already-saved item without changing the creation time or checking current availability', async () => {
    const { service, tx } = fixture();
    tx.customerWishlist.findUnique.mockResolvedValue({ menuItemId: 'item' });
    await service.addFavorite('customer-a', 'item');
    expect(tx.customerWishlist.create).not.toHaveBeenCalled();
    expect(tx.menuItem.findFirst).not.toHaveBeenCalled();
  });

  it('checks the size under the same customer row lock before any write', async () => {
    const { service, tx } = fixture();
    tx.customerWishlist.count.mockResolvedValue(WISHLIST_LIMIT);
    await expect(
      service.addFavorite('customer-a', 'item'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.customerWishlist.create).not.toHaveBeenCalled();
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.customerWishlist.count.mock.invocationCallOrder[0],
    );
  });

  it('rejects a customer disabled between authentication and mutation', async () => {
    const { service, tx } = fixture();
    tx.$queryRaw.mockResolvedValue([]);
    await expect(
      service.addFavorite('customer-a', 'item'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tx.customerWishlist.create).not.toHaveBeenCalled();
  });

  it.each(['expired', 'inactive', 'deleted'])(
    'rejects a %s customer session without employee fallback',
    async (state) => {
      const { service, prisma } = fixture();
      prisma.customerSession.findUnique.mockResolvedValue({
        expiresAt: new Date(Date.now() + (state === 'expired' ? -1000 : 1000)),
        customer: {
          id: 'customer-a',
          email: 'fixture@example.test',
          isActive: state !== 'inactive',
          deletedAt: state === 'deleted' ? new Date() : null,
        },
      });
      await expect(service.authenticate('a'.repeat(43))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    },
  );

  it('never queries with a malformed token', async () => {
    const { service, prisma } = fixture();
    await expect(
      service.authenticate('employee-access-token'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.customerSession.findUnique).not.toHaveBeenCalled();
  });
});
