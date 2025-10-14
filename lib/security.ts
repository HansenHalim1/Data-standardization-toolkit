import { createHmac, timingSafeEqual } from "crypto";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { UnauthorizedError } from "./errors";

export function signPayload(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload, "utf8").digest("base64");
}

export function verifySignature(payload: string, signature: string, secret: string) {
  const expected = signPayload(payload, secret);
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

export function assertWebhookSignature({
  signature,
  rawBody,
  secret
}: {
  signature?: string | null;
  rawBody: string;
  secret: string;
}) {
  if (!signature) {
    throw new UnauthorizedError("Missing webhook signature");
  }
  if (!verifySignature(rawBody, signature, secret)) {
    throw new UnauthorizedError("Invalid webhook signature");
  }
}

function assertMondayClientSecret(): string {
  const secret = process.env.MONDAY_CLIENT_SECRET;
  if (!secret) {
    throw new UnauthorizedError("Missing monday client secret configuration");
  }
  return secret;
}

export type MondaySessionClaims = JwtPayload & {
  accountId: number | string;
  userId: number | string;
  userEmail?: string;
  account?: {
    id?: number | string;
    slug?: string;
  };
};

export function verifyMondaySessionToken(token: string): MondaySessionClaims {
  const secret = assertMondayClientSecret();
  try {
    const decoded = jwt.verify(token, secret);
    if (!decoded || typeof decoded !== "object") {
      throw new UnauthorizedError("Invalid monday session token payload");
    }
    const claims = decoded as MondaySessionClaims;
    if (!claims.accountId || !claims.userId) {
      throw new UnauthorizedError("Session token missing required claims");
    }
    return claims;
  } catch (error) {
    throw new UnauthorizedError(
      `Monday session token verification failed: ${(error as Error).message ?? "Unknown error"}`
    );
  }
}
