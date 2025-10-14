import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const features = [
  {
    title: "Opinionated Recipes",
    description: "Normalize contacts, HR rosters, and orders with ready-to-run templates."
  },
  {
    title: "Usage Metering",
    description: "Stay within plan caps automatically with proactive plan gating."
  },
  {
    title: "Supabase Audit Trail",
    description: "Every run is persisted with structured logs for compliance."
  }
];

export default function MarketingPage() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-16 px-6 py-24 text-center">
      <section className="flex flex-col items-center gap-6">
        <span className="rounded-full bg-secondary px-4 py-1 text-sm font-medium text-secondary-foreground">
          Built for monday.com workspaces
        </span>
        <h1 className="text-4xl font-bold sm:text-6xl">Ship clean data to every monday board</h1>
        <p className="max-w-3xl text-lg text-muted-foreground">
          Data Standardization Toolkit keeps your monday boards tidy with reusable normalization recipes,
          realtime usage metering, and monetization-ready plan gates.
        </p>
        <div className="flex flex-wrap justify-center gap-4">
          <Button asChild size="lg">
            <Link href="/monday/view">Open monday board app</Link>
          </Button>
          <Button variant="outline" size="lg" asChild>
            <Link href="/dashboard">Go to dashboard</Link>
          </Button>
        </div>
      </section>

      <section className="grid gap-6 sm:grid-cols-3">
        {features.map((feature) => (
          <Card key={feature.title} className="h-full">
            <CardHeader>
              <CardTitle>{feature.title}</CardTitle>
              <CardDescription>{feature.description}</CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Tailored for teams that need predictable data quality before it hits mission critical dashboards.
            </CardContent>
          </Card>
        ))}
      </section>
    </main>
  );
}
