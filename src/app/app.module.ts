import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { LoggingInterceptor } from './logger/logging.interceptor';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ZodSerializerInterceptor, ZodValidationPipe } from 'nestjs-zod';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { EmployeesModule } from './employees/employees.module';
import { SystemSettingsModule } from './system-settings/system-settings.module';
import { InvoicesModule } from './invoices/invoices.module';
import { ReservationsModule } from './reservations/reservations.module';
import { PromotionsModule } from './promotions/promotions.module';
import { EquipmentModule } from './equipment/equipment.module';
import { InventoryModule } from './inventory/inventory.module';
import { MenuModule } from './menu/menu.module';
import { DiningTablesModule } from './dining-tables/dining-tables.module';
import { RolesModule } from './roles/roles.module';
import { DecimalInterceptor } from '../common/interceptors/decimal/decimal.interceptor';
import { PrismaModule } from '../common/prisma/prisma.module';
import { PositionsModule } from './positions/positions.module';
import { QueryUtilModule } from '../common/utils/query-util/query-util.module';
import { CatchEverythingFilter } from '../catch-everything/catch-everything.filter';
import { FormatResponseInterceptor } from '../common/interceptors/format-response/format-response.interceptor';
import { ZodExceptionService } from '../catch-everything/zod-exception/zod-exception.service';
import { ApiUtilModule } from '../common/utils/api-util/api-util.module';
import { RateLimitModule } from '../common/security/rate-limit.module';
import { ThrottlerGuard } from '@nestjs/throttler';
import { MailUtilModule } from '../common/utils/mail-util/mail-util.module';
import { JwtModule } from '@nestjs/jwt';
import { AuthGuard } from './auth/auth.guard';
import { OrdersModule } from './orders/orders.module';
import { AuthorizationModule } from './authorization/authorization.module';
import { PermissionsGuard } from './authorization/permissions.guard';
import { PermissionsModule } from './permissions/permissions.module';
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, expandVariables: true }),
    AuthModule,
    AuthorizationModule,
    PrismaModule,
    EmployeesModule,
    RolesModule,
    PermissionsModule,
    DiningTablesModule,
    MenuModule,
    InventoryModule,
    EquipmentModule,
    PromotionsModule,
    ReservationsModule,
    SystemSettingsModule,
    InvoicesModule,
    PositionsModule,
    QueryUtilModule,
    ApiUtilModule,
    RateLimitModule,
    MailUtilModule,
    JwtModule,
    OrdersModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    ZodExceptionService,
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: DecimalInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: ZodSerializerInterceptor,
    },
    {
      provide: APP_PIPE,
      useClass: ZodValidationPipe,
    },
    {
      provide: APP_FILTER,
      useClass: CatchEverythingFilter,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: FormatResponseInterceptor,
    },
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: PermissionsGuard,
    },
  ],
})
export class AppModule {}
