import { Injectable } from '@nestjs/common';

export interface BalanceRecord {
  employeeId: string;
  locationId: string;
  balance: number;
  updatedAt: Date;
}

export interface DeductResult {
  employeeId: string;
  locationId: string;
  newBalance: number;
  idempotencyKey: string;
  appliedAt: Date;
}

const key = (employeeId: string, locationId: string): string =>
  `${employeeId}::${locationId}`;

@Injectable()
export class HcmStore {
  private balances = new Map<string, BalanceRecord>();
  private idempotency = new Map<string, DeductResult>();

  reset(): void {
    this.balances.clear();
    this.idempotency.clear();
  }

  seed(records: Array<Omit<BalanceRecord, 'updatedAt'>>): void {
    const now = new Date();
    for (const r of records) {
      this.balances.set(key(r.employeeId, r.locationId), {
        ...r,
        updatedAt: now,
      });
    }
  }

  get(employeeId: string, locationId: string): BalanceRecord | undefined {
    return this.balances.get(key(employeeId, locationId));
  }

  has(employeeId: string, locationId: string): boolean {
    return this.balances.has(key(employeeId, locationId));
  }

  list(): BalanceRecord[] {
    return [...this.balances.values()];
  }

  adjust(employeeId: string, locationId: string, delta: number): BalanceRecord {
    const existing = this.balances.get(key(employeeId, locationId));
    if (!existing) {
      throw new Error(`no balance for ${employeeId}/${locationId}`);
    }
    const updated: BalanceRecord = {
      ...existing,
      balance: existing.balance + delta,
      updatedAt: new Date(),
    };
    this.balances.set(key(employeeId, locationId), updated);
    return updated;
  }

  setAll(balance: number): void {
    const now = new Date();
    for (const [k, r] of this.balances.entries()) {
      this.balances.set(k, { ...r, balance, updatedAt: now });
    }
  }

  rememberIdempotent(idempotencyKey: string, result: DeductResult): void {
    this.idempotency.set(idempotencyKey, result);
  }

  replayIdempotent(idempotencyKey: string): DeductResult | undefined {
    return this.idempotency.get(idempotencyKey);
  }
}
