import { createHmac, timingSafeEqual } from "crypto";
import { UnauthorizedError } from "./errors";

type VerifyContextInput = {
  token: string;
  secret: string;
};

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

export function verifyMondayContext({ token, secret }: VerifyContextInput) {
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) {
    throw new UnauthorizedError("Invalid monday context token");
  }
  const payload = Buffer.from(encoded, "base64").toString("utf8");
  if (!verifySignature(payload, signature, secret)) {
    throw new UnauthorizedError("Failed monday context signature verification");
  }
  try {
    return JSON.parse(payload) as {
      accountId: string;
      userId: string;
      userEmail?: string;
      region?: string;
    };
  } catch (error) {
    throw new UnauthorizedError(`Unable to parse monday context payload: ${(error as Error).message}`);
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
