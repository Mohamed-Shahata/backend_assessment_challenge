import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Role } from '../generated/prisma/enums';
import { AuthService } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { Roles } from './decorators/roles.decorator';
import { AuthTokensDto } from './dto/auth-tokens.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import type { CurrentUserPayload } from './interfaces/jwt-payload.interface';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  // Not as strict as login (it's not a brute-force target the same way),
  // but still capped to stop scripted mass-account creation.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Create a new CUSTOMER account' })
  @ApiResponse({
    status: 201,
    description: 'Account created, wallet provisioned, tokens issued',
    type: AuthTokensDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation error (bad email/password)',
  })
  @ApiResponse({
    status: 409,
    description: 'A user with this email already exists',
  })
  register(@Body() dto: RegisterDto): Promise<AuthTokensDto> {
    return this.authService.register(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  // Brute-force prevention: 5 attempts / minute per IP (the throttler's
  // default tracker), well below the app-wide default limit.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Log in with email + password' })
  @ApiResponse({ status: 200, type: AuthTokensDto })
  @ApiResponse({
    status: 400,
    description: 'Validation error (bad email/password)',
  })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  login(@Body() dto: LoginDto): Promise<AuthTokensDto> {
    return this.authService.login(dto);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Rotate a refresh token for a new access/refresh pair',
  })
  @ApiResponse({ status: 200, type: AuthTokensDto })
  @ApiResponse({
    status: 400,
    description: 'Validation error (missing refreshToken)',
  })
  @ApiResponse({
    status: 401,
    description:
      'Invalid, expired, or already-rotated refresh token (reuse of a rotated/forged token revokes all sessions for that user)',
  })
  refresh(@Body() dto: RefreshTokenDto): Promise<AuthTokensDto> {
    return this.authService.refresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke a refresh token / end a session' })
  @ApiResponse({
    status: 204,
    description: 'Session revoked (or token was already invalid)',
  })
  @ApiResponse({
    status: 400,
    description: 'Validation error (missing refreshToken)',
  })
  async logout(@Body() dto: RefreshTokenDto): Promise<void> {
    await this.authService.logout(dto.refreshToken);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Return the currently authenticated user' })
  @ApiResponse({
    status: 200,
    description: 'Current user payload from the access token',
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  me(@CurrentUser() user: CurrentUserPayload): CurrentUserPayload {
    return user;
  }

  /**
   * Temporary RBAC smoke-test endpoint for this task's Definition of Done
   * (verifying that @Roles(Role.ADMIN) rejects CUSTOMER users with 403).
   * Safe to remove/replace once a real admin-only route exists.
   */
  @Get('admin-check')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[RBAC demo] ADMIN-only endpoint' })
  @ApiResponse({
    status: 200,
    description: 'Caller is authenticated and has the ADMIN role',
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  @ApiResponse({ status: 403, description: 'Authenticated but not an ADMIN' })
  adminCheck(): { ok: true } {
    return { ok: true };
  }
}
