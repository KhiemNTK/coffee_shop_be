import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PermissionKeys } from '../../common/consts/permission-keys';
import { IDDto } from '../../common/dto/param.dto';
import { RequirePermissions } from '../authorization/authorization.decorator';
import { SkipAuth } from '../auth/auth.decorator';
import {
  RecommendOnlineItemsDto,
  RecommendationExperimentDto,
} from './dto/recommendation.dto';
import { RecommendationsService } from './recommendations.service';

@ApiTags('Recommendations')
@Controller('recommendations')
export class RecommendationsController {
  constructor(private readonly recommendations: RecommendationsService) {}

  @Post('online')
  @SkipAuth()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  recommendOnline(@Body() dto: RecommendOnlineItemsDto) {
    return this.recommendations.recommendOnline(dto);
  }

  @Get('pos/:id')
  @RequirePermissions(PermissionKeys.ORDERS_SESSIONS_READ)
  @Header('Cache-Control', 'no-store')
  recommendPos(@Param() { id }: IDDto) {
    return this.recommendations.recommendPos(id);
  }

  @Get('experiment')
  @RequirePermissions(PermissionKeys.REPORTS_READ)
  @Header('Cache-Control', 'no-store')
  getExperiment(@Query() { from, to }: RecommendationExperimentDto) {
    return this.recommendations.getExperiment(from, to);
  }
}
