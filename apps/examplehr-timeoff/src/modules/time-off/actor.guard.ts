import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';

export type ActorRole = 'employee' | 'manager' | 'admin';

export interface Actor {
  userId: string;
  role: ActorRole;
}

export const REQUIRED_ROLES_KEY = 'actor:requiredRoles';
export const RequireRole = (...roles: ActorRole[]) =>
  SetMetadata(REQUIRED_ROLES_KEY, roles);

/**
 * Header-based actor guard. Production would replace the header extraction
 * with JWT verification or mTLS and enforce real identity claims. This stub
 * is documented in TRD §10 as the auth seam.
 */
@Injectable()
export class ActorGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request & { actor?: Actor }>();
    const userId = req.header('x-user-id');
    const roleHeader = req.header('x-user-role') ?? 'employee';

    if (!userId) {
      throw new UnauthorizedException('missing X-User-Id');
    }
    if (!['employee', 'manager', 'admin'].includes(roleHeader)) {
      throw new UnauthorizedException(`unknown role "${roleHeader}"`);
    }
    const actor: Actor = { userId, role: roleHeader as ActorRole };
    req.actor = actor;

    const required = this.reflector.getAllAndOverride<ActorRole[] | undefined>(
      REQUIRED_ROLES_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (required && required.length > 0 && !required.includes(actor.role)) {
      throw new ForbiddenException(
        `requires one of roles [${required.join(', ')}], got "${actor.role}"`,
      );
    }
    return true;
  }
}
