import { Controller, Get, HttpException, Param } from '@nestjs/common';
import { HcmError } from '../hcm/hcm.client';
import { BalancesService } from './balances.service';
import { BalanceResponseDto } from './dto/balance-response.dto';

@Controller('balances')
export class BalancesController {
  constructor(private readonly balances: BalancesService) {}

  @Get(':employeeId/:locationId')
  async get(
    @Param('employeeId') employeeId: string,
    @Param('locationId') locationId: string,
  ): Promise<BalanceResponseDto> {
    try {
      return await this.balances.getEffective(employeeId, locationId);
    } catch (err) {
      if (err instanceof HcmError && err.status === 404) {
        throw new HttpException(err.upstreamMessage, 404);
      }
      throw err;
    }
  }
}
