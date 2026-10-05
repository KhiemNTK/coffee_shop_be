import { Prisma } from '@prisma/client';
import { RecommendationsService } from './recommendations.service';
import {
  PUBLIC_MENU_SELECT,
  PUBLIC_MENU_WHERE,
} from '../menu/public-menu-query';

describe('Recommendation public contract', () => {
  it('returns current public options in candidate order without leaking recipes', async () => {
    const item = {
      id: 'candidate',
      name: 'Cake',
      price: new Prisma.Decimal('12000.25'),
      category: { id: 'category', name: 'Food' },
      optionGroups: [
        {
          id: 'group',
          name: 'Size',
          minSelected: 1,
          maxSelected: 1,
          options: [
            {
              id: 'option',
              name: 'Large',
              priceDelta: new Prisma.Decimal('3000.50'),
            },
          ],
        },
      ],
    };
    const prisma = {
      orderSession: {
        findUnique: jest.fn().mockResolvedValue({
          sessionStatus: 'ACTIVE',
          orderItems: [{ menuItemId: 'anchor' }],
        }),
      },
      menuItemRecommendationPair: {
        findMany: jest.fn().mockResolvedValue([
          { candidateId: 'unavailable', support: 5 },
          { candidateId: 'candidate', support: 3 },
        ]),
      },
      menuItem: { findMany: jest.fn().mockResolvedValue([item]) },
    };
    const service = new RecommendationsService(prisma as never);
    expect(await service.recommendPos('session')).toEqual({
      recommendations: [
        {
          ...item,
          menuItemId: item.id,
          price: '12000.25',
        },
      ],
    });
    expect(prisma.menuItem.findMany).toHaveBeenLastCalledWith({
      where: { ...PUBLIC_MENU_WHERE, id: { in: ['candidate'] } },
      select: PUBLIC_MENU_SELECT,
    });
    expect(PUBLIC_MENU_SELECT).not.toHaveProperty('ingredients');
    expect(
      PUBLIC_MENU_SELECT.optionGroups.select.options.select,
    ).not.toHaveProperty('ingredients');
  });
});
