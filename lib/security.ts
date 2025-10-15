import { createHmac, timingSafeEqual } from "crypto";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { UnauthorizedError } from "./errors";
import { env } from "./env";

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
  return env().monday.clientSecret;
}

export type MondaySessionClaims = JwtPayload & {
  accountId: number | string;
  userId: number | string;
  userEmail?: string;
  account?: {
    id?: number | string;
    uuid?: string | number;
    slug?: string;
  };
  user?: {
    id?: number | string;
    uuid?: string | number;
    email?: string;
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
    const accountObj = rawClaims.account as Record<string, unknown> | undefined;
    const userObj = rawClaims.user as Record<string, unknown> | undefined;
    const contextObj = rawClaims.context as Record<string, unknown> | undefined;
    const contextAccount = contextObj?.account as Record<string, unknown> | undefined;
    const contextUser = contextObj?.user as Record<string, unknown> | undefined;

    const extractId = (value: unknown): string | number | undefined => {
      if (typeof value === "string" && value.trim().length > 0) {
        return value;
      }
      if (typeof value === "number") {
        return value;
      }
      return undefined;
    };

    const accountId =
      extractId(rawClaims.accountId) ??
      extractId(rawClaims.account_id) ??
      extractId(accountObj?.id) ??
      extractId(accountObj?.uuid) ??
      extractId(accountObj?.slug) ??
      extractId(contextAccount?.id) ??
      extractId(contextAccount?.uuid) ??
      extractId(contextAccount?.slug);
    const userId =
      extractId(rawClaims.userId) ??
      extractId(rawClaims.user_id) ??
      extractId(userObj?.id) ??
      extractId(userObj?.uuid) ??
      extractId(contextUser?.id) ??
      extractId(contextUser?.uuid);

    if (!accountId || !userId) {
      throw new UnauthorizedError("Session token missing required claims");
    }

    const userEmail =
      (rawClaims.userEmail as string | undefined) ??
      (userObj?.email as string | undefined) ??
      (contextUser?.email as string | undefined);

    const normalizedClaims: MondaySessionClaims = {
      ...(decoded as JwtPayload),
      accountId,
      userId,
      userEmail,
      account: {
        ...(accountObj ?? {}),
        ...(contextAccount ?? {}),
        uuid: extractId(accountObj?.uuid) ?? extractId(contextAccount?.uuid),
        id: accountId
      },
      user: {
        ...(userObj ?? {}),
        ...(contextUser ?? {}),
        uuid: extractId(userObj?.uuid) ?? extractId(contextUser?.uuid),
        id: userId,
        email: userEmail
      }
    };

    return normalizedClaims;
  } catch (error) {
    throw new UnauthorizedError(
      `Monday session token verification failed: ${(error as Error).message ?? "Unknown error"}`
    );
  }
}
