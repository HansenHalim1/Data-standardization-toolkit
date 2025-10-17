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
  const formBody = new URLSearchParams({
    client_id: configuration.monday.clientId,
    client_secret: configuration.monday.clientSecret,
    redirect_uri: configuration.public.mondayRedirectUri,
    code
  });
  const response = await fetch(MONDAY_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: formBody
  });

  const rawBody = await response.text();
  let parsedJson: Partial<MondayTokenResponse> & {
    error?: string;
    error_description?: string;
  };
  try {
    parsedJson = JSON.parse(rawBody) as Partial<MondayTokenResponse> & {
      error?: string;
      error_description?: string;
    };
  } catch {
    throw new Error(
      `Token exchange failed: unexpected response (${response.status}) ${rawBody.slice(0, 200)}`
    );
  }

  if (!response.ok) {
    const reason = parsedJson?.error ?? response.statusText;
    const description = parsedJson?.error_description;
    throw new Error(
      description
        ? `${reason}: ${description}`
        : `Token exchange failed (${response.status}): ${rawBody.slice(0, 200)}`
    );
  }

  if (!parsedJson?.access_token) {
    throw new Error(
      `Unexpected token response from monday.com: missing access_token (${rawBody.slice(0, 200)})`
    );
  }

  if (
    parsedJson.token_type &&
    parsedJson.token_type.localeCompare("Bearer", undefined, { sensitivity: "accent" }) !== 0
  ) {
    throw new Error(
      `Unexpected token response from monday.com: token_type=${parsedJson.token_type}`
    );
  }

  return {
    ...parsedJson,
    token_type: "Bearer"
  } as MondayTokenResponse;
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

    const responseText = await response.text().catch(() => null);
    if (!response.ok) {
      // Include response body when available to aid debugging unauthorized/403 errors
      const bodySnippet = typeof responseText === "string" ? responseText.slice(0, 200) : String(responseText);
      throw new Error(`monday.com API request failed with status ${response.status}: ${bodySnippet}`);
    }

    const json = (() => {
      try {
        return JSON.parse(responseText as string) as { data?: T; errors?: Array<{ message: string }> };
      } catch {
        return null as any;
      }
    })();

    if (!json?.data) {
      if (json?.errors?.length) {
        throw new Error(`monday.com API error: ${json.errors[0]?.message ?? "Unknown error"}`);
      }
      throw new Error(`monday.com API returned an empty response: ${String(responseText).slice(0, 400)}`);
    }

    // If the response includes GraphQL errors, surface the first one instead of returning partial data
    if (json?.errors?.length) {
      throw new Error(`monday.com API error: ${json.errors[0]?.message ?? "Unknown error"} - ${String(responseText).slice(0,400)}`);
    }

    // If the returned data contains nulls for any top-level selection (e.g., create_item: null),
    // log the full response text to help diagnose server-side reasons (permissions, validation, etc.).
    try {
      const topLevelValues = json && typeof json === "object" ? Object.values(json) : [];
      if (topLevelValues.some((v) => v === null)) {
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: "warn",
            msg: "monday.api.partial_response",
            responseText: String(responseText).slice(0, 2000)
          })
        );
      }
    } catch {
      /* ignore logging errors */
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
