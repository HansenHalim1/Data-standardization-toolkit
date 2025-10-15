import jwt, { JwtPayload } from "jsonwebtoken";
import { UnauthorizedError } from "./errors";
import { env } from "./env";

type MondayIntegrationJwtPayload = JwtPayload & {
  accountId?: number | string;
  account_id?: number | string;
  account?: {
    id?: number | string;
  };
  userId?: number | string;
  user_id?: number | string;
  user?: {
    id?: number | string;
  };
  shortLivedToken?: string;
  short_lived_token?: string;
};

type VerifiedIntegrationContext = {
  accountId: string;
  userId: string;
  shortLivedToken?: string;
};

export function verifyMondayJwt(authHeader: string): VerifiedIntegrationContext {
  if (!authHeader) {
    throw new UnauthorizedError("Missing monday integration Authorization header");
  }

  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : authHeader.trim();
  if (!token) {
    throw new UnauthorizedError("Empty monday integration token");
  }

  const configuration = env();
  const expectedAudience = `${configuration.app.baseUrl.replace(/\/$/, "")}/api/monday/integration`;

  let payload: MondayIntegrationJwtPayload;
  try {
    payload = jwt.verify(token, configuration.monday.signingSecret, {
      audience: expectedAudience
    }) as MondayIntegrationJwtPayload;
  } catch (error) {
    throw new UnauthorizedError(
      `Invalid monday integration token: ${(error as Error).message ?? "verification failed"}`
    );
  }

  if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) {
    throw new UnauthorizedError("Expired monday integration token");
  }

  const rawAccountId =
    payload.accountId ?? payload.account_id ?? payload.account?.id ?? (payload as Record<string, unknown>)["account_id"];
  const rawUserId = payload.userId ?? payload.user_id ?? payload.user?.id ?? (payload as Record<string, unknown>)["user_id"];

  const accountId = normalizeIdentifier(rawAccountId);
  const userId = normalizeIdentifier(rawUserId);
  const shortLivedToken = normalizeOptionalString(payload.shortLivedToken ?? payload.short_lived_token);

  if (!accountId) {
    throw new UnauthorizedError("monday integration token missing accountId");
  }
  if (!userId) {
    throw new UnauthorizedError("monday integration token missing userId");
  }

  return {
    accountId,
    userId,
    shortLivedToken
  };
}

function normalizeIdentifier(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}
