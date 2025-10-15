import { Metadata } from "next";
import { getServiceSupabase } from "@/lib/db";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type TokenRecord = {
  scopes: string[];
};

type MondaySettingsPageProps = {
  searchParams: {
    mondayAccountId?: string;
    mondayUserId?: string;
    mondayScopes?: string;
    mondayAccountSlug?: string;
  };
};

export const metadata: Metadata = {
  title: "monday.com Settings | Data Standardization Toolkit"
};

export default async function MondaySettingsPage({ searchParams }: MondaySettingsPageProps) {
  const accountIdParam = searchParams.mondayAccountId ?? "";
  const userIdParam = searchParams.mondayUserId ?? "";
  const slugParam = searchParams.mondayAccountSlug ?? "";
  const scopeParam = parseScopes(searchParams.mondayScopes);

  let storedToken: TokenRecord | null = null;
  if (accountIdParam && userIdParam) {
    const supabase = getServiceSupabase();
    const { data } = await supabase
      .from("monday_oauth_tokens")
      .select("scopes")
      .eq("account_id", Number(accountIdParam))
      .eq("user_id", Number(userIdParam))
      .maybeSingle();
    storedToken = (data as TokenRecord | null) ?? null;
  }

  const scopes = scopeParam.length ? scopeParam : storedToken?.scopes ?? [];
  const isConnected = Boolean(storedToken);

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-12">
      <section className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold">monday.com Integration</h1>
        <p className="text-sm text-muted-foreground">
          Connect your monday.com account to store OAuth tokens securely in Supabase and power integrations.
        </p>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Connection</CardTitle>
          <CardDescription>
            Authenticate via OAuth 2.0. Provide an optional account slug if you need to target a specific workspace.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <form action="/api/monday/oauth/start" method="GET" className="flex flex-col gap-3 md:flex-row">
            <Input
              name="subdomain"
              placeholder="workspace slug (optional)"
              aria-label="monday.com account slug"
              defaultValue={slugParam}
              className="md:max-w-xs"
            />
            <input type="hidden" name="return_to" value="/settings/monday" />
            <Button type="submit" className="w-full md:w-auto">
              Connect monday.com
            </Button>
          </form>

          <div className="space-y-3 rounded-md border border-border p-4 text-sm">
            <p className="font-medium">{isConnected ? "Connected" : "Not connected"}</p>
            <div className="grid gap-1 text-muted-foreground sm:grid-cols-2">
              <span>Account ID</span>
              <span className="font-mono text-foreground">{accountIdParam || "—"}</span>
            </div>
            <div className="grid gap-1 text-muted-foreground sm:grid-cols-2">
              <span>Account Slug</span>
              <span className="font-mono text-foreground">{slugParam || "—"}</span>
            </div>
            <div className="grid gap-1 text-muted-foreground sm:grid-cols-2">
              <span>User ID</span>
              <span className="font-mono text-foreground">{userIdParam || "—"}</span>
            </div>
            <div className="grid gap-1 text-muted-foreground sm:grid-cols-2">
              <span>Scopes</span>
              <span className="font-mono text-foreground">
                {scopes.length ? scopes.join(" ") : "No scopes granted"}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}

function parseScopes(value?: string): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}
