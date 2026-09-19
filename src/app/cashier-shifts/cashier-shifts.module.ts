import { Module } from '@nestjs/common';
import { PaginationUtilModule } from '../../common/utils/pagination-util/pagination-util.module';
import { CashHandoversController } from './cash-handovers.controller';
import { CashHandoversService } from './cash-handovers.service';
import { CashierShiftLedgerService } from './cashier-shift-ledger.service';
import { CashierShiftsController } from './cashier-shifts.controller';
import { CashierShiftsService } from './cashier-shifts.service';
import { FundsController } from './funds.controller';
import { FundsService } from './funds.service';

@Module({
  imports: [PaginationUtilModule],
  controllers: [
    CashierShiftsController,
    CashHandoversController,
    FundsController,
  ],
  providers: [
    CashierShiftsService,
    CashierShiftLedgerService,
    CashHandoversService,
    FundsService,
  ],
  exports: [CashierShiftLedgerService],
})
export class CashierShiftsModule {}
