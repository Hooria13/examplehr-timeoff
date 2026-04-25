import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';

export interface HcmBalanceSnapshot {
  employeeId: string;
  locationId: string;
  balance: number;
  updatedAt: string;
}

export interface HcmDeductResult {
  employeeId: string;
  locationId: string;
  newBalance: number;
  idempotencyKey: string;
  appliedAt: string;
}

export interface HcmBatchPage {
  page: number;
  limit: number;
  total: number;
  items: HcmBalanceSnapshot[];
}

export class HcmError extends Error {
  constructor(
    public readonly status: number,
    public readonly upstreamMessage: string,
    public readonly isRetryable: boolean,
  ) {
    super(`HCM ${status}: ${upstreamMessage}`);
  }
}

@Injectable()
export class HcmClient {
  private readonly logger = new Logger(HcmClient.name);
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly http: HttpService,
    config: ConfigService,
  ) {
    this.baseUrl =
      config.get<string>('HCM_BASE_URL') ?? 'http://localhost:3001';
    this.timeoutMs = Number(config.get<string>('HCM_TIMEOUT_MS') ?? '5000');
  }

  async getBalance(
    employeeId: string,
    locationId: string,
  ): Promise<HcmBalanceSnapshot> {
    const url = `${this.baseUrl}/hcm/balance/${encodeURIComponent(
      employeeId,
    )}/${encodeURIComponent(locationId)}`;
    try {
      const resp = await firstValueFrom(
        this.http.get<HcmBalanceSnapshot>(url, { timeout: this.timeoutMs }),
      );
      return resp.data;
    } catch (err) {
      throw this.wrap(err);
    }
  }

  async getBatch(page = 0, limit = 50): Promise<HcmBatchPage> {
    const url = `${this.baseUrl}/hcm/batch`;
    try {
      const resp = await firstValueFrom(
        this.http.get<HcmBatchPage>(url, {
          params: { page, limit },
          timeout: this.timeoutMs,
        }),
      );
      return resp.data;
    } catch (err) {
      throw this.wrap(err);
    }
  }

  async deduct(input: {
    employeeId: string;
    locationId: string;
    days: number;
    idempotencyKey: string;
  }): Promise<HcmDeductResult> {
    const url = `${this.baseUrl}/hcm/deduct`;
    try {
      const resp = await firstValueFrom(
        this.http.post<HcmDeductResult>(url, input, {
          timeout: this.timeoutMs,
        }),
      );
      return resp.data;
    } catch (err) {
      throw this.wrap(err);
    }
  }

  async reverse(input: {
    employeeId: string;
    locationId: string;
    days: number;
    idempotencyKey: string;
  }): Promise<HcmDeductResult> {
    const url = `${this.baseUrl}/hcm/reverse`;
    try {
      const resp = await firstValueFrom(
        this.http.post<HcmDeductResult>(url, input, {
          timeout: this.timeoutMs,
        }),
      );
      return resp.data;
    } catch (err) {
      throw this.wrap(err);
    }
  }

  /**
   * Translate an axios failure into an HcmError that carries a retry hint.
   * 5xx, 429, and network/timeout failures are retryable. 4xx business
   * rejections (insufficient balance, unknown employee/location) are not.
   */
  private wrap(err: unknown): HcmError {
    if (err && typeof err === 'object' && 'isAxiosError' in err) {
      const ax = err as AxiosError;
      const status = ax.response?.status ?? 0;
      const body = ax.response?.data;
      const msg =
        typeof body === 'object' && body && 'message' in body
          ? String((body as { message: unknown }).message)
          : ax.message;
      const isRetryable =
        status === 0 || status === 429 || (status >= 500 && status < 600);
      this.logger.warn(`HCM call failed status=${status} msg=${msg}`);
      return new HcmError(status, msg, isRetryable);
    }
    this.logger.error(`HCM call failed unexpectedly: ${String(err)}`);
    return new HcmError(0, String(err), true);
  }
}
