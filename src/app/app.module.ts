import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { LoggingInterceptor } from './logger/logging.interceptor';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { EmployeesModule } from './employees/employees.module';
import { SystemSettingsModule } from './system-settings/system-settings.module';
import { ExpenseVouchersModule } from './expense-vouchers/expense-vouchers.module';
import { BudgetsModule } from './budgets/budgets.module';
import { ExportOrdersModule } from './export-orders/export-orders.module';
import { ImportOrdersModule } from './import-orders/import-orders.module';
import { InvoicesModule } from './invoices/invoices.module';
import { ReservationsModule } from './reservations/reservations.module';
import { PromotionsModule } from './promotions/promotions.module';
import { EquipmentModule } from './equipment/equipment.module';
import { InventoryModule } from './inventory/inventory.module';
import { MenuModule } from './menu/menu.module';
import { DiningTablesModule } from './dining-tables/dining-tables.module';
import { RolesModule } from './roles/roles.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, expandVariables: true }),
    AuthModule,
    EmployeesModule,
    RolesModule,
    DiningTablesModule,
    MenuModule,
    InventoryModule,
    EquipmentModule,
    PromotionsModule,
    ReservationsModule,
    ImportOrdersModule,
    ExportOrdersModule,
    BudgetsModule,
    ExpenseVouchersModule,
    SystemSettingsModule,
    InvoicesModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
  ],
})
export class AppModule {}
