type MondayClientOptions = {
  accessToken: string;
  endpoint?: string;
};

type GraphQLResponse<T> = {
  data?: T;
  errors?: Array<{ message: string }>;
};

export class MondayClient {
  private readonly accessToken: string;
  private readonly endpoint: string;

  constructor({ accessToken, endpoint = "https://api.monday.com/v2" }: MondayClientOptions) {
    this.accessToken = accessToken;
    this.endpoint = endpoint;
  }

  async graphql<T = unknown>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.accessToken
      },
      body: JSON.stringify({ query, variables })
    });

    if (!response.ok) {
      throw new Error(`monday.com GraphQL request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as GraphQLResponse<T>;
    if (payload.errors?.length) {
      throw new Error(`monday.com GraphQL error: ${payload.errors[0]?.message}`);
    }
    if (!payload.data) {
      throw new Error("monday.com GraphQL empty response");
    }
    return payload.data;
  }

  async upsertByColumn({
    boardId,
    columnId,
    rows
  }: {
    boardId: number;
    columnId: string;
    rows: Array<Record<string, unknown>>;
  }): Promise<void> {
    // TODO: Replace with production-grade monday.com upsert mutation.
    await this.graphql(
      `
        mutation UpsertStub($boardId: ID!, $columnId: String!, $items: JSON!) {
          upsert_many_items(
            board_id: $boardId,
            column_values: $items,
            kind: by_column_values,
            create_labels_if_missing: true
          ) {
            id
          }
        }
      `,
      {
        boardId,
        columnId,
        items: rows
      }
    );
  }
}

export async function exchangeCodeForToken({
  code,
  redirectUri,
  clientId,
  clientSecret
}: {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ access_token: string; refresh_token?: string; account_id: string }> {
  const response = await fetch("https://auth.monday.com/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code"
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to exchange monday OAuth code: ${response.statusText}`);
  }

  const payload = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    account_id: string;
  };

  return payload;
}

export async function fetchAccountDetails(accessToken: string): Promise<{
  id: string;
  name: string;
  region?: string;
}> {
  const client = new MondayClient({ accessToken });
  const data = await client.graphql<{ me: { account: { id: string; name: string } } }>(
    `
      query ViewerAccount {
        me {
          account {
            id
            name
          }
        }
      }
    `
  );
  return {
    id: data.me.account.id,
    name: data.me.account.name,
    region: undefined
  };
}
