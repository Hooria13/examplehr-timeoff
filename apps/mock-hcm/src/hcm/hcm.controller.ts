import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  BalanceResponse,
  BatchQueryDto,
  BatchResponse,
  DeductDto,
  DeductResponse,
  ReverseDto,
} from './dto';
import { HcmService } from './hcm.service';

@Controller('hcm')
export class HcmController {
  constructor(private readonly hcm: HcmService) {}

  @Get('balance/:employeeId/:locationId')
  getBalance(
    @Param('employeeId') employeeId: string,
    @Param('locationId') locationId: string,
  ): Promise<BalanceResponse> {
    return this.hcm.getBalance(employeeId, locationId);
  }

  @Get('batch')
  getBatch(@Query() q: BatchQueryDto): Promise<BatchResponse> {
    return this.hcm.getBatch(q.page, q.limit);
  }

  @Post('deduct')
  deduct(@Body() body: DeductDto): Promise<DeductResponse> {
    return this.hcm.deduct(body);
  }

  @Post('reverse')
  reverse(@Body() body: ReverseDto): Promise<DeductResponse> {
    return this.hcm.reverse(body);
  }
}
