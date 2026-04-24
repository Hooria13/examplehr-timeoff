import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
} from '@nestjs/common';
import { RegisterFaultDto } from '../fault/dto';
import { FaultService } from '../fault/fault.service';
import { HcmStore } from '../hcm/hcm.store';
import {
  AnniversaryDto,
  SeedDto,
  YearStartDto,
} from './dto';

/**
 * Test-only control surface for driving the mock HCM into specific states.
 * In production-equivalent code, mounting this controller would be gated by
 * a build flag / env var. Here it is always mounted because the app is a
 * test fixture only.
 */
@Controller('__test')
export class TestControlController {
  constructor(
    private readonly store: HcmStore,
    private readonly faults: FaultService,
  ) {}

  @Post('reset')
  @HttpCode(204)
  reset(): void {
    this.store.reset();
    this.faults.clearAll();
  }

  @Post('seed')
  @HttpCode(204)
  seed(@Body() body: SeedDto): void {
    this.store.seed(body.records);
  }

  @Post('anniversary')
  @HttpCode(200)
  anniversary(@Body() body: AnniversaryDto): { mutated: number } {
    if (body.locationId) {
      this.store.adjust(body.employeeId, body.locationId, body.delta);
      return { mutated: 1 };
    }
    let count = 0;
    for (const rec of this.store.list()) {
      if (rec.employeeId === body.employeeId) {
        this.store.adjust(rec.employeeId, rec.locationId, body.delta);
        count += 1;
      }
    }
    return { mutated: count };
  }

  @Post('yearstart')
  @HttpCode(204)
  yearStart(@Body() body: YearStartDto): void {
    this.store.setAll(body.balance);
  }

  @Post('fault')
  @HttpCode(201)
  registerFault(@Body() body: RegisterFaultDto): void {
    this.faults.register(body);
  }

  @Delete('fault')
  @HttpCode(204)
  clearFaults(): void {
    this.faults.clearAll();
  }

  @Get('state')
  state(): {
    balances: ReturnType<HcmStore['list']>;
    faults: ReturnType<FaultService['list']>;
  } {
    return { balances: this.store.list(), faults: this.faults.list() };
  }
}
