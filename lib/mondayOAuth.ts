import { env } from "./env";

export const MONDAY_AUTHORIZE_URL = "https://auth.monday.com/oauth2/authorize";
export const MONDAY_TOKEN_URL = "https://auth.monday.com/oauth2/token";

export const MONDAY_SCOPES = [
  "account:read",
  "account:write",
  "boards:read",
  "boards:write",
  "docs:read",
  "docs:write",
  "me:read",
  "updates:read",
  "updates:write",
  "users:read",
  "workspaces:read",
  "workspaces:write"
] as const;

export type MondayScope = (typeof MONDAY_SCOPES)[number];

export type MondayTokenResponse = {
  access_token: string;
  token_type: "Bearer";
  scope: string;
  account_id: number;
  user_id: number;
};

type AuthorizeUrlOptions = {
  state: string;
  subdomain?: string;
  scopes?: MondayScope[];
  includeForceInstall?: boolean;
};

type GraphQLRequest = {
  query: string;
  variables?: Record<string, unknown>;
};

export function buildAuthorizeHostUrl(subdomain: string): string {
  const slug = subdomain.trim();
  if (!slug) {
    throw new Error("Cannot build host URL without subdomain slug");
  }
  return `https://${slug}.monday.com/oauth2/authorize`;
}

export function getAuthorizeUrl({ state, subdomain, scopes, includeForceInstall }: AuthorizeUrlOptions): string {
  const configuration = env();
  const params = new URLSearchParams({
    client_id: configuration.monday.clientId,
    redirect_uri: configuration.public.mondayRedirectUri,
    state
  });

  const scopeList = scopes?.length ? scopes : parseScopesToArray(configuration.monday.defaultScopes);
  if (scopeList.length) {
    params.set("scope", scopeList.join(" "));
  }

  const forceInstall = includeForceInstall ?? configuration.monday.forceInstall;
  if (forceInstall) {
    params.set("force_install_if_needed", "true");
  }

  if (subdomain) {
    params.set("subdomain", subdomain);
  }

  const authorizeUrl = new URL(MONDAY_AUTHORIZE_URL);
  authorizeUrl.search = params.toString();
  return authorizeUrl.toString();
}

export async function exchangeCodeForToken(code: string): Promise<MondayTokenResponse> {
  const configuration = env();
  const response = await fetch(MONDAY_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      code,
      client_id: configuration.monday.clientId,
      client_secret: configuration.monday.clientSecret,
      redirect_uri: configuration.public.mondayRedirectUri,
      grant_type: "authorization_code"
    })
  });

  const payload = (await response.json().catch(() => null)) as Partial<MondayTokenResponse> & {
    error?: string;
    error_description?: string;
  };

  if (!response.ok) {
    const reason = payload?.error ?? response.statusText;
    const description = payload?.error_description;
    throw new Error(description ? `${reason}: ${description}` : `Token exchange failed: ${reason}`);
  }

  if (!payload?.access_token || payload.token_type !== "Bearer") {
    throw new Error("Unexpected token response from monday.com");
  }

  return payload as MondayTokenResponse;
}

export function parseScopesToArray(scopeString: string): string[] {
  return scopeString
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}

export function getApiClient({ accessToken }: { accessToken: string }) {
  const endpoint = "https://api.monday.com/v2";
  return async <T>(request: GraphQLRequest): Promise<T> => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify({
        query: request.query,
        variables: request.variables ?? {}
      })
    });

    if (!response.ok) {
      throw new Error(`monday.com API request failed with status ${response.status}`);
    }

    const json = (await response.json().catch(() => null)) as {
      data?: T;
      errors?: Array<{ message: string }>;
    };

    if (!json?.data) {
      if (json?.errors?.length) {
        throw new Error(`monday.com API error: ${json.errors[0]?.message ?? "Unknown error"}`);
      }
      throw new Error("monday.com API returned an empty response");
    }

    return json.data;
  };
}

export function buildAuthorizeUrlWithSubdomain(subdomain: string): string {
  const params = new URLSearchParams();
  params.set("subdomain", subdomain);
  const url = new URL(MONDAY_AUTHORIZE_URL);
  url.search = params.toString();
  return url.toString();
}
