'use client';

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

type PlanGateProps = {
  allowed: boolean;
  plan: string;
  feature: string;
  onUpgrade?: () => void;
  children: React.ReactNode;
};

export function PlanGate({ allowed, plan, feature, onUpgrade, children }: PlanGateProps) {
  if (allowed) {
    return <>{children}</>;
  }

  return (
    <div className="rounded-lg border border-dashed p-6 text-center">
      <Badge variant="outline" className="mb-2">
        {plan.toUpperCase()} plan
      </Badge>
      <h3 className="text-lg font-semibold">Unlock {feature}</h3>
      <p className="mt-2 text-sm text-muted-foreground">
        Upgrade your monday.com plan to access this premium capability instantly.
      </p>
      <Button className="mt-4" onClick={onUpgrade}>
        Contact workspace admin
      </Button>
    </div>
  );
}
