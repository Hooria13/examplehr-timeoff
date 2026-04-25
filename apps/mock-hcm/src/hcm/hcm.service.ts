import {
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { FaultService, FaultSpec } from '../fault/fault.service';
import {
  BalanceResponse,
  BatchResponse,
  DeductResponse,
} from './dto';
import { BalanceRecord, DeductResult, HcmStore } from './hcm.store';

const DEFAULT_BATCH_LIMIT = 50;

@Injectable()
export class HcmService {
  constructor(
    private readonly store: HcmStore,
    private readonly faults: FaultService,
  ) {}

  async getBalance(
    employeeId: string,
    locationId: string,
  ): Promise<BalanceResponse> {
    const fault = this.faults.consume('balance');
    await this.applyGenericFaults(fault);

    const record = this.store.get(employeeId, locationId);
    if (!record) {
      throw new NotFoundException(
        `no balance for employee=${employeeId} location=${locationId}`,
      );
    }
    return toBalanceResponse(record);
  }

  async getBatch(page = 0, limit = DEFAULT_BATCH_LIMIT): Promise<BatchResponse> {
    const fault = this.faults.consume('batch');
    await this.applyGenericFaults(fault);

    const all = this.store.list();
    const items = all
      .slice(page * limit, page * limit + limit)
      .map(toBalanceResponse);
    return { page, limit, total: all.length, items };
  }

  /**
   * Deduct days from an employee's balance.
   *
   * Idempotent: a repeat call with the same idempotencyKey returns the
   * stored result without re-applying. When a `silent-accept` fault is
   * armed, returns a response that LOOKS successful (with the expected
   * post-deduct balance) but does NOT mutate the store — modeling the
   * brief's §3.4 failure where HCM accepts a request without applying
   * it. The fabricated response is deliberately not stored as idempotent
   * so the caller's verification path can detect the discrepancy.
   */
  async deduct(input: {
    employeeId: string;
    locationId: string;
    days: number;
    idempotencyKey: string;
  }): Promise<DeductResponse> {
    const replay = this.store.replayIdempotent(input.idempotencyKey);
    if (replay) return toDeductResponse(replay);

    const fault = this.faults.consume('deduct');
    await this.applyGenericFaults(fault);

    const record = this.store.get(input.employeeId, input.locationId);
    if (!record) {
      throw new NotFoundException(
        `no balance for employee=${input.employeeId} location=${input.locationId}`,
      );
    }

    if (fault?.mode === 'silent-accept') {
      const fabricated: DeductResult = {
        employeeId: input.employeeId,
        locationId: input.locationId,
        newBalance: record.balance - input.days,
        idempotencyKey: input.idempotencyKey,
        appliedAt: new Date(),
      };
      return toDeductResponse(fabricated);
    }

    if (record.balance - input.days < 0) {
      throw new ConflictException(
        `insufficient balance: have ${record.balance}, requested ${input.days}`,
      );
    }

    const updated = this.store.adjust(
      input.employeeId,
      input.locationId,
      -input.days,
    );
    const result: DeductResult = {
      employeeId: updated.employeeId,
      locationId: updated.locationId,
      newBalance: updated.balance,
      idempotencyKey: input.idempotencyKey,
      appliedAt: updated.updatedAt,
    };
    this.store.rememberIdempotent(input.idempotencyKey, result);
    return toDeductResponse(result);
  }

  async reverse(input: {
    employeeId: string;
    locationId: string;
    days: number;
    idempotencyKey: string;
  }): Promise<DeductResponse> {
    const replay = this.store.replayIdempotent(input.idempotencyKey);
    if (replay) return toDeductResponse(replay);

    const fault = this.faults.consume('reverse');
    await this.applyGenericFaults(fault);

    if (!this.store.has(input.employeeId, input.locationId)) {
      throw new NotFoundException(
        `no balance for employee=${input.employeeId} location=${input.locationId}`,
      );
    }

    const updated = this.store.adjust(
      input.employeeId,
      input.locationId,
      input.days,
    );
    const result: DeductResult = {
      employeeId: updated.employeeId,
      locationId: updated.locationId,
      newBalance: updated.balance,
      idempotencyKey: input.idempotencyKey,
      appliedAt: updated.updatedAt,
    };
    this.store.rememberIdempotent(input.idempotencyKey, result);
    return toDeductResponse(result);
  }

  private async applyGenericFaults(fault: FaultSpec | undefined): Promise<void> {
    if (!fault) return;
    switch (fault.mode) {
      case 'error500':
        throw new HttpException('injected fault: 500', 500);
      case 'throttle':
        throw new HttpException('injected fault: 429', 429);
      case 'timeout':
        await sleep(fault.timeoutMs ?? 10_000);
        throw new ServiceUnavailableException('injected fault: timeout');
      case 'silent-accept':
        break;
    }
  }
}

function toBalanceResponse(r: BalanceRecord): BalanceResponse {
  return {
    employeeId: r.employeeId,
    locationId: r.locationId,
    balance: r.balance,
    updatedAt: r.updatedAt.toISOString(),
  };
}

function toDeductResponse(r: DeductResult): DeductResponse {
  return {
    employeeId: r.employeeId,
    locationId: r.locationId,
    newBalance: r.newBalance,
    idempotencyKey: r.idempotencyKey,
    appliedAt: r.appliedAt.toISOString(),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
