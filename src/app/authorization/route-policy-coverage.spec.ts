import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { AppController } from '../app.controller';
import { AuthController } from '../auth/auth.controller';
import { IS_SKIP_AUTH } from '../auth/auth.decorator';
import { BankReconciliationController } from '../cashier-shifts/bank-reconciliation.controller';
import { CashHandoversController } from '../cashier-shifts/cash-handovers.controller';
import { CashierShiftsController } from '../cashier-shifts/cashier-shifts.controller';
import { FundsController } from '../cashier-shifts/funds.controller';
import { DiningTablesController } from '../dining-tables/dining-tables.controller';
import { EmployeesController } from '../employees/employees.controller';
import { EquipmentController } from '../equipment/equipment.controller';
import { HealthController } from '../health/health.controller';
import { InventoryController } from '../inventory/inventory.controller';
import { InvoicesController } from '../invoices/invoices.controller';
import { MenuController } from '../menu/menu.controller';
import { KitchenController } from '../kitchen/kitchen.controller';
import { MetricsController } from '../observability/metrics.controller';
import { OrdersController } from '../orders/orders.controller';
import { PaymentsController } from '../payments/payments.controller';
import { PermissionsController } from '../permissions/permissions.controller';
import { PositionsController } from '../positions/positions.controller';
import { PrintAgentController } from '../printing/print-agent.controller';
import { PrintingController } from '../printing/printing.controller';
import { PromotionsController } from '../promotions/promotions.controller';
import { ReportsController } from '../reports/reports.controller';
import { ReservationsController } from '../reservations/reservations.controller';
import { RolesController } from '../roles/roles.controller';
import { SystemSettingsController } from '../system-settings/system-settings.controller';
import { REQUIRED_PERMISSIONS_KEY } from './authorization.decorator';

const controllers = [
  AppController,
  AuthController,
  BankReconciliationController,
  CashHandoversController,
  CashierShiftsController,
  DiningTablesController,
  EmployeesController,
  EquipmentController,
  FundsController,
  HealthController,
  InventoryController,
  InvoicesController,
  KitchenController,
  MenuController,
  MetricsController,
  OrdersController,
  PaymentsController,
  PermissionsController,
  PositionsController,
  PrintAgentController,
  PrintingController,
  PromotionsController,
  ReportsController,
  ReservationsController,
  RolesController,
  SystemSettingsController,
];

const discoverControllerFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return discoverControllerFiles(path);
    return entry.name.endsWith('.controller.ts') ? [basename(path)] : [];
  });

const getControllerFileName = (controller: (typeof controllers)[number]) =>
  `${controller.name
    .replace(/Controller$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()}.controller.ts`;

describe('Route authorization policy coverage', () => {
  it('includes every controller source file in the coverage suite', () => {
    const discovered = discoverControllerFiles(
      resolve(process.cwd(), 'src', 'app'),
    ).sort();
    const declared = controllers.map(getControllerFileName).sort();

    expect(declared).toEqual(discovered);
  });

  it('requires every HTTP route to declare an auth policy', () => {
    const missing: string[] = [];

    for (const controller of controllers) {
      const prototype = controller.prototype;
      const classSkipsAuth = Reflect.getMetadata(IS_SKIP_AUTH, controller);
      const classPermissions = Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        controller,
      );

      for (const methodName of Object.getOwnPropertyNames(prototype)) {
        if (methodName === 'constructor') continue;
        const handler = prototype[methodName as keyof typeof prototype];
        if (typeof handler !== 'function') continue;
        if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) {
          continue;
        }

        const hasPolicy =
          classSkipsAuth ||
          classPermissions !== undefined ||
          Reflect.getMetadata(IS_SKIP_AUTH, handler) ||
          Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler) !== undefined;
        if (!hasPolicy) {
          const path = Reflect.getMetadata(PATH_METADATA, handler);
          missing.push(`${controller.name}.${methodName} (${String(path)})`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});
