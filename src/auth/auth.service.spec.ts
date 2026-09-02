import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  let service: AuthService;
  let prisma: {
    user: {
      findUnique: jest.Mock;
      create: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let jwtService: {
    signAsync: jest.Mock;
    verifyAsync: jest.Mock;
  };
  let redis: {
    get: jest.Mock;
    set: jest.Mock;
    del: jest.Mock;
    keys: jest.Mock;
  };
  let config: { get: jest.Mock };
  let walletService: { provisionWallet: jest.Mock };

  const CONFIG_VALUES: Record<string, string> = {
    'jwt.accessSecret': 'access-secret',
    'jwt.accessTtl': '15m',
    'jwt.refreshSecret': 'refresh-secret',
    'jwt.refreshTtl': '7d',
  };

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(
      async (cb: (tx: unknown) => unknown) => cb(prisma),
    );
    walletService = { provisionWallet: jest.fn() };
    jwtService = {
      signAsync: jest.fn(),
      verifyAsync: jest.fn(),
    };
    redis = {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
      keys: jest.fn(),
    };
    config = {
      get: jest.fn((key: string) => CONFIG_VALUES[key]),
    };

    service = new AuthService(
      prisma as never,
      jwtService as unknown as JwtService,
      config as unknown as ConfigService,
      walletService as never,
      redis as never,
    );

    jwtService.signAsync.mockImplementation(
      async (payload: Record<string, unknown>) =>
        `signed.${JSON.stringify(payload)}`,
    );
  });

  describe('register', () => {
    it('hashes the password and never stores it in plain text', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockImplementation(
        async ({ data }: { data: { email: string; password: string } }) => ({
          id: 'user-1',
          email: data.email,
          password: data.password,
          role: 'CUSTOMER',
        }),
      );

      await service.register({
        email: 'new@example.com',
        password: 'plaintext-password',
      });

      const createdData = prisma.user.create.mock.calls[0][0].data;
      expect(createdData.password).not.toBe('plaintext-password');
      const matches = await bcrypt.compare(
        'plaintext-password',
        createdData.password,
      );
      expect(matches).toBe(true);
    });

    it('rejects registration when the email is already taken', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'existing' });

      await expect(
        service.register({ email: 'dup@example.com', password: 'password1' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('issues an access token and a refresh token, storing the refresh session in redis', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({
        id: 'user-1',
        email: 'new@example.com',
        password: 'hashed',
        role: 'CUSTOMER',
      });

      const tokens = await service.register({
        email: 'new@example.com',
        password: 'plaintext-password',
      });

      expect(tokens.accessToken).toBeDefined();
      expect(tokens.refreshToken).toBeDefined();
      expect(redis.set).toHaveBeenCalledWith(
        expect.stringMatching(/^refresh:user-1:/),
        '1',
        'EX',
        7 * 24 * 60 * 60,
      );
    });
  });

  describe('login', () => {
    it('throws Unauthorized for an unknown email', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.login({ email: 'ghost@example.com', password: 'whatever1' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('throws Unauthorized for a wrong password', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'a@example.com',
        password: await bcrypt.hash('correct-password', 10),
        role: 'CUSTOMER',
      });

      await expect(
        service.login({ email: 'a@example.com', password: 'wrong-password' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('returns a token pair for valid credentials', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'a@example.com',
        password: await bcrypt.hash('correct-password', 10),
        role: 'ADMIN',
      });

      const tokens = await service.login({
        email: 'a@example.com',
        password: 'correct-password',
      });

      expect(tokens.accessToken).toBeDefined();
      expect(tokens.refreshToken).toBeDefined();
    });
  });

  describe('refresh (rotation)', () => {
    it('deletes the used refresh token and issues a new pair when the session is valid', async () => {
      jwtService.verifyAsync.mockResolvedValue({
        sub: 'user-1',
        jti: 'jti-1',
      });
      redis.get.mockResolvedValue('1');
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'a@example.com',
        role: 'CUSTOMER',
      });

      const tokens = await service.refresh('some.refresh.token');

      expect(redis.del).toHaveBeenCalledWith('refresh:user-1:jti-1');
      expect(tokens.accessToken).toBeDefined();
      expect(tokens.refreshToken).toBeDefined();
    });

    it('revokes every session for the user when a token is reused (already rotated)', async () => {
      jwtService.verifyAsync.mockResolvedValue({
        sub: 'user-1',
        jti: 'jti-1',
      });
      redis.get.mockResolvedValue(null);
      redis.keys.mockResolvedValue([
        'refresh:user-1:jti-1',
        'refresh:user-1:jti-2',
      ]);

      await expect(service.refresh('reused.token')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );

      expect(redis.keys).toHaveBeenCalledWith('refresh:user-1:*');
      expect(redis.del).toHaveBeenCalledWith(
        'refresh:user-1:jti-1',
        'refresh:user-1:jti-2',
      );
    });

    it('rejects an invalid/expired refresh token before touching redis', async () => {
      jwtService.verifyAsync.mockRejectedValue(new Error('bad signature'));

      await expect(service.refresh('garbage')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(redis.get).not.toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    it('deletes only the targeted session', async () => {
      jwtService.verifyAsync.mockResolvedValue({
        sub: 'user-1',
        jti: 'jti-1',
      });

      await service.logout('some.refresh.token');

      expect(redis.del).toHaveBeenCalledWith('refresh:user-1:jti-1');
      expect(redis.del).toHaveBeenCalledTimes(1);
    });
  });
});
