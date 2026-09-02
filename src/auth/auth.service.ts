import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import type { Redis } from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { WalletService } from '../modules/wallet/wallet.service';
import { AuthTokensDto } from './dto/auth-tokens.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import {
  AccessTokenPayload,
  RefreshTokenPayload,
} from './interfaces/jwt-payload.interface';
import { ttlToSeconds } from './utils/ttl.util';

const BCRYPT_SALT_ROUNDS = 10;
const REFRESH_KEY_PREFIX = 'refresh';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly walletService: WalletService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async register(dto: RegisterDto): Promise<AuthTokensDto> {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (existing) {
      throw new ConflictException('A user with this email already exists');
    }

    const hashed = await bcrypt.hash(dto.password, BCRYPT_SALT_ROUNDS);

    // User + wallet are created atomically: a registered user must never
    // end up without a wallet (see task 03 README, "Wallet auto-provisioning").
    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: { email: dto.email, password: hashed },
      });
      await this.walletService.provisionWallet(created.id, tx);
      return created;
    });

    return this.issueTokenPair(user.id, user.role);
  }

  async login(dto: LoginDto): Promise<AuthTokensDto> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordMatches = await bcrypt.compare(dto.password, user.password);
    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return this.issueTokenPair(user.id, user.role);
  }

  async refresh(refreshToken: string): Promise<AuthTokensDto> {
    const payload = await this.verifyRefreshToken(refreshToken);
    const key = this.refreshKey(payload.sub, payload.jti);

    const exists = await this.redis.get(key);
    if (!exists) {
      // Reuse of an already-rotated (or forged) refresh token: treat as a
      // breach and revoke every session belonging to this user.
      await this.revokeAllSessions(payload.sub);
      this.logger.warn(
        `Refresh token reuse detected for user ${payload.sub}; all sessions revoked`,
      );
      throw new UnauthorizedException(
        'Refresh token is no longer valid; all sessions have been revoked',
      );
    }

    // Rotation: delete the used token before issuing a new one.
    await this.redis.del(key);

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });
    if (!user) {
      throw new UnauthorizedException('User no longer exists');
    }

    return this.issueTokenPair(user.id, user.role);
  }

  async logout(refreshToken: string): Promise<void> {
    const payload = await this.verifyRefreshToken(refreshToken, {
      ignoreExpiration: true,
    });
    await this.redis.del(this.refreshKey(payload.sub, payload.jti));
  }

  private async issueTokenPair(
    userId: string,
    role: AccessTokenPayload['role'],
  ): Promise<AuthTokensDto> {
    const accessPayload: AccessTokenPayload = { sub: userId, role };
    const accessToken = await this.jwtService.signAsync(accessPayload, {
      secret: this.config.get<string>('jwt.accessSecret'),
      expiresIn: this.config.get<string>(
        'jwt.accessTtl',
      ) as JwtSignOptions['expiresIn'],
    });

    const jti = randomUUID();
    const refreshTtl = this.config.get<string>('jwt.refreshTtl')!;
    const refreshPayload: RefreshTokenPayload = { sub: userId, jti };
    const refreshToken = await this.jwtService.signAsync(refreshPayload, {
      secret: this.config.get<string>('jwt.refreshSecret'),
      expiresIn: refreshTtl as JwtSignOptions['expiresIn'],
    });

    await this.redis.set(
      this.refreshKey(userId, jti),
      '1',
      'EX',
      ttlToSeconds(refreshTtl),
    );

    return { accessToken, refreshToken };
  }

  private async verifyRefreshToken(
    token: string,
    options?: { ignoreExpiration?: boolean },
  ): Promise<RefreshTokenPayload> {
    try {
      return await this.jwtService.verifyAsync<RefreshTokenPayload>(token, {
        secret: this.config.get<string>('jwt.refreshSecret'),
        ignoreExpiration: options?.ignoreExpiration ?? false,
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }

  private async revokeAllSessions(userId: string): Promise<void> {
    const pattern = `${REFRESH_KEY_PREFIX}:${userId}:*`;
    const keys = await this.redis.keys(pattern);
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }

  private refreshKey(userId: string, jti: string): string {
    return `${REFRESH_KEY_PREFIX}:${userId}:${jti}`;
  }
}
