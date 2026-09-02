import type { Role } from '../../generated/prisma/enums';

/** Payload encoded inside a short-lived access token. */
export interface AccessTokenPayload {
  sub: string;
  role: Role;
}

/** Payload encoded inside a refresh token (opaque session id = jti). */
export interface RefreshTokenPayload {
  sub: string;
  jti: string;
}

/** Shape attached to `request.user` once the access token is validated. */
export interface CurrentUserPayload {
  userId: string;
  role: Role;
}
