'use client';

import { useEffect, useState } from "react";

type ToastProps = {
  message: string | null;
  variant?: "default" | "error" | "success";
  duration?: number;
};

export function Toast({ message, variant = "default", duration = 4000 }: ToastProps) {
  const [visible, setVisible] = useState(Boolean(message));

  useEffect(() => {
    if (!message) return;
    setVisible(true);
    const timer = window.setTimeout(() => setVisible(false), duration);
    return () => window.clearTimeout(timer);
  }, [message, duration]);

  if (!message || !visible) {
    return null;
  }

  const variantClass =
    variant === "error"
      ? "bg-destructive text-destructive-foreground"
      : variant === "success"
      ? "bg-primary text-primary-foreground"
      : "bg-secondary text-secondary-foreground";

  return (
    <div className={`fixed bottom-6 right-6 rounded-lg px-4 py-3 shadow-lg ${variantClass}`}>
      <span className="text-sm">{message}</span>
    </div>
  );
}
