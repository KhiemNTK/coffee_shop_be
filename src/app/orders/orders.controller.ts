import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
} from '@nestjs/common';
import {
  AddOrderItemsDto,
  CancelOrderItemDto,
  MergeDiningTableDto,
  OpenSessionDto,
  SplitOrderSessionDto,
  TransferDiningTableDto,
  UpdateOrderItemStatusDto,
} from './dto';
import { OrdersService } from './orders.service';
import { IDDto } from '../../common/dto/param.dto';
import { Employee } from '../../common/decorators/employee.decorator';

@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post('sessions')
  openSession(
    @Employee('employeeId') employeeId: string,
    @Body() openSessionDto: OpenSessionDto,
  ) {
    return this.ordersService.openSession({
      ...openSessionDto,
      employeeId,
    });
  }

  @Get('sessions')
  getActiveSessions() {
    return this.ordersService.getActiveSessions();
  }

  @Get('sessions/:id')
  getSessionById(@Param() { id }: IDDto) {
    return this.ordersService.getSessionById(id);
  }

  @Post('sessions/:id/items')
  addOrderItems(
    @Param() { id }: IDDto,
    @Body() addOrderItemsDto: AddOrderItemsDto,
  ) {
    return this.ordersService.addOrderItems(id, addOrderItemsDto);
  }

  @Patch('items/:id/status')
  updateItemStatus(
    @Param() { id }: IDDto,
    @Body() updateItemStatusDto: UpdateOrderItemStatusDto,
  ) {
    return this.ordersService.updateItemStatus(id, updateItemStatusDto);
  }

  @Patch('items/:id/cancel')
  cancelItem(
    @Param() { id }: IDDto,
    @Body() cancelItemDto: CancelOrderItemDto,
  ) {
    return this.ordersService.cancelItem(id, cancelItemDto);
  }

  @Delete('sessions/:id')
  cancelSession(@Param() { id }: IDDto) {
    return this.ordersService.cancelSession(id);
  }

  @Post('sessions/transfer-table')
  transferTable(@Body() dto: TransferDiningTableDto) {
    return this.ordersService.transferTable(dto);
  }

  @Post('sessions/merge')
  mergeTables(@Body() dto: MergeDiningTableDto) {
    return this.ordersService.mergeTables(dto);
  }

  @Post('sessions/split')
  splitTable(@Body() dto: SplitOrderSessionDto) {
    return this.ordersService.splitTable(dto);
  }

  @Post('tables/:id/clear')
  clearTable(@Param() { id }: IDDto) {
    return this.ordersService.clearTable(id);
  }
}
