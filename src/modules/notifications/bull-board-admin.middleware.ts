import { Injectable, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { NextFunction, Request, Response } from 'express';
import type { AccessTokenPayload } from '../../auth/interfaces/jwt-payload.interface';
import { Role } from '../../generated/prisma/enums';

/**
 * Protects Bull Board (`/admin/queues`) the same way `JwtAuthGuard` +
 * `RolesGuard(Role.ADMIN)` would protect a normal Nest route. Bull Board
 * mounts its own router outside the regular controller pipeline, so an
 * Express middleware (rather than a Nest guard) is what actually runs here.
 */
@Injectable()
export class BullBoardAdminMiddleware implements NestMiddleware {
  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length)
      : undefined;

    if (!token) {
      res.status(401).json({ statusCode: 401, message: 'Unauthorized' });
      return;
    }

    try {
      const payload = this.jwtService.verify<AccessTokenPayload>(token, {
        secret: this.config.get<string>('jwt.accessSecret'),
      });

      if (payload.role !== Role.ADMIN) {
        res.status(403).json({ statusCode: 403, message: 'Forbidden' });
        return;
      }

      next();
    } catch {
      res.status(401).json({ statusCode: 401, message: 'Unauthorized' });
    }
  }
}
