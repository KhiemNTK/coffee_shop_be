import { ConflictException, Injectable } from '@nestjs/common';
import type {
  ExtendedPrismaTransactionClient,
  KitchenRoutableMenuItem,
  KitchenRoutableOrderItem,
} from '../../common/types';
import { PrintingService } from '../printing/printing.service';
import { readSelectedOptions } from '../menu/menu-option-selection';

@Injectable()
export class KitchenRoutingService {
  constructor(private readonly printing: PrintingService) {}

  async createTickets(
    tx: ExtendedPrismaTransactionClient,
    input: {
      orderSessionId: string;
      menuItems: KitchenRoutableMenuItem[];
      orderItems: KitchenRoutableOrderItem[];
      pickupAt?: Date;
    },
  ) {
    const createdAt = new Date();
    if (input.pickupAt && input.pickupAt <= createdAt) {
      throw new ConflictException('Pickup time has elapsed.');
    }
    const menuItems = new Map(input.menuItems.map((item) => [item.id, item]));
    const groups = new Map<
      string,
      {
        station: NonNullable<KitchenRoutableMenuItem['kitchenStation']>;
        items: KitchenRoutableOrderItem[];
      }
    >();

    for (const item of input.orderItems) {
      const station = menuItems.get(item.menuItemId)?.kitchenStation;
      if (!station) {
        if (input.pickupAt) {
          throw new ConflictException(
            'Scheduled orders require a kitchen station for every item.',
          );
        }
        continue;
      }
      const group = groups.get(station.id) ?? { station, items: [] };
      group.items.push(item);
      groups.set(station.id, group);
    }
    if (groups.size === 0) return [];

    const session = await tx.orderSession.findUniqueOrThrow({
      where: { id: input.orderSessionId },
      select: { table: { select: { name: true } } },
    });
    const tickets: Array<{ id: string; stationId: string; availableAt: Date }> =
      [];
    for (const { station, items } of groups.values()) {
      const dueAt =
        input.pickupAt ??
        new Date(createdAt.getTime() + station.prepSlaSeconds * 1_000);
      const availableAt = new Date(
        Math.max(
          createdAt.getTime(),
          dueAt.getTime() - station.prepSlaSeconds * 1_000,
        ),
      );
      const ticket = await tx.kitchenTicket.create({
        data: {
          stationId: station.id,
          orderSessionId: input.orderSessionId,
          dueAt,
          availableAt,
          createdAt,
          items: {
            create: items.map((item) => ({
              orderItemId: item.id,
              itemName: menuItems.get(item.menuItemId)!.name,
              quantity: item.quantity,
              note: item.note,
              selectedOptions: readSelectedOptions(item.selectedOptions),
            })),
          },
        },
        include: { items: true },
      });

      if (station.printDevice?.isActive && !station.printDevice.deletedAt) {
        await this.printing.enqueueKitchenTicket(tx, {
          kitchenTicketId: ticket.id,
          deviceId: station.printDevice.id,
          availableAt,
          payload: {
            ticketId: ticket.id,
            ticketNumber: `${station.code}-${ticket.sequence}`,
            stationCode: station.code,
            stationName: station.name,
            tableName: session.table?.name ?? null,
            orderSessionId: input.orderSessionId,
            dueAt: ticket.dueAt.toISOString(),
            availableAt: availableAt.toISOString(),
            items: ticket.items.map((item) => ({
              orderItemId: item.orderItemId,
              name: item.itemName,
              quantity: item.quantity,
              note: item.note,
              selectedOptions: readSelectedOptions(item.selectedOptions),
            })),
          },
        });
      }
      tickets.push({ id: ticket.id, stationId: ticket.stationId, availableAt });
    }
    return tickets;
  }
}
