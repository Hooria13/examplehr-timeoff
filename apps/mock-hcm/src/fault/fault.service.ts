import { Injectable } from '@nestjs/common';

export type FaultOp = 'balance' | 'deduct' | 'reverse' | 'batch';
export type FaultMode = 'error500' | 'throttle' | 'timeout' | 'silent-accept';

export interface FaultSpec {
  op: FaultOp;
  mode: FaultMode;
  /** If set, auto-clears after this many triggers. Default: unlimited until clearAll. */
  remainingTriggers?: number;
  /** For timeout mode, how long to sleep (ms). Default 10s. */
  timeoutMs?: number;
}

@Injectable()
export class FaultService {
  private faults: FaultSpec[] = [];

  list(): FaultSpec[] {
    return this.faults.map((f) => ({ ...f }));
  }

  register(spec: FaultSpec): void {
    this.faults.push({ ...spec });
  }

  clearAll(): void {
    this.faults = [];
  }

  /**
   * Consume the first fault matching `op`. If the matching fault has a
   * finite trigger budget, decrement it; if it hits zero, remove it.
   */
  consume(op: FaultOp): FaultSpec | undefined {
    const idx = this.faults.findIndex((f) => f.op === op);
    if (idx < 0) return undefined;
    const spec = { ...this.faults[idx] };
    if (typeof spec.remainingTriggers === 'number') {
      this.faults[idx].remainingTriggers = spec.remainingTriggers - 1;
      if (this.faults[idx].remainingTriggers! <= 0) {
        this.faults.splice(idx, 1);
      }
    }
    return spec;
  }
}
