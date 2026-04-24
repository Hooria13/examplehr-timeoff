export interface BalanceResponseDto {
  employeeId: string;
  locationId: string;
  hcmBalance: number;
  pendingAtHcm: number;
  localHolds: number;
  effectiveAvailable: number;
  hcmSyncedAt: string | null;
  stale: boolean;
}
