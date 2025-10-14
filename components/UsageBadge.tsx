'use client';

import { Badge } from "./ui/badge";

type UsageBadgeProps = {
  used: number;
  cap: number;
};

export function UsageBadge({ used, cap }: UsageBadgeProps) {
  const percent = Math.min(100, Math.round((used / cap) * 100));
  const variant = (percent > 90 ? "destructive" : percent > 60 ? "secondary" : "default") as
    | "default"
    | "secondary"
    | "destructive";

  return (
    <Badge variant={variant} className="flex items-center gap-1 text-xs">
      <span>Usage</span>
      <span>
        {used.toLocaleString()} / {cap.toLocaleString()} rows ({percent}%)
      </span>
    </Badge>
  );
}
