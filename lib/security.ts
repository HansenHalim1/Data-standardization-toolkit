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
    const rawClaims = decoded as Record<string, unknown>;
    const accountId =
      (rawClaims.accountId as number | string | undefined) ??
      (rawClaims.account_id as number | string | undefined) ??
      ((rawClaims.account as Record<string, unknown> | undefined)?.id as number | string | undefined) ??
      ((rawClaims.context as Record<string, unknown> | undefined)?.account as Record<string, unknown> | undefined)?.id;
    const userId =
      (rawClaims.userId as number | string | undefined) ??
      (rawClaims.user_id as number | string | undefined) ??
      ((rawClaims.user as Record<string, unknown> | undefined)?.id as number | string | undefined) ??
      ((rawClaims.context as Record<string, unknown> | undefined)?.user as Record<string, unknown> | undefined)?.id;

    if (!accountId || !userId) {
      throw new UnauthorizedError("Session token missing required claims");
    }

    const userEmail =
      (rawClaims.userEmail as string | undefined) ??
      ((rawClaims.user as Record<string, unknown> | undefined)?.email as string | undefined);

    const normalizedClaims: MondaySessionClaims = {
      ...(decoded as JwtPayload),
      accountId,
      userId,
      userEmail,
      account: {
        ...(rawClaims.account as Record<string, unknown> | undefined),
        id: accountId
      }
    };

    return normalizedClaims;
  } catch (error) {
    throw new UnauthorizedError(
      `Monday session token verification failed: ${(error as Error).message ?? "Unknown error"}`
    );
  }
}
