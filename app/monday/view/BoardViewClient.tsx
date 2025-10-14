'use client';

import { useEffect, useMemo, useState, useTransition } from "react";
import mondaySdk from "monday-sdk-js";
import type { RecipeDefinition, RecipePreviewResult } from "@/lib/recipe-engine";
import type { PlanFlags } from "@/lib/entitlements";
import { UploadDropzone } from "@/components/UploadDropzone";
import { DataGridPreview } from "@/components/DataGridPreview";
import { DiffViewer } from "@/components/DiffViewer";
import { PlanGate } from "@/components/PlanGate";
import { UsageBadge } from "@/components/UsageBadge";
import { Toast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { Label } from "@/components/ui/label";

type MondayContext = {
  tenantId: string;
  plan: string;
  seats: number;
  flags: PlanFlags;
  usage: {
    rowsProcessed: number;
  };
};

const STUB_CONTEXT: MondayContext = {
  tenantId: "11111111-1111-1111-1111-111111111111",
  plan: "pro",
  seats: 10,
  flags: {
    plan: "pro",
    rowCap: 50000,
    fuzzyMatching: true,
    schedules: true,
    apiAccess: true,
    seats: 10
  },
  usage: {
    rowsProcessed: 0
  }
};

type Template = {
  id: string;
  name: string;
  description: string;
  recipe: RecipeDefinition;
  premium?: boolean;
};

const templates: Template[] = [
  {
    id: "crm",
    name: "CRM Contacts",
    description: "Clean and normalize contact details for CRM funnels.",
    recipe: {
      id: "crm",
      name: "CRM Contacts",
      version: 1,
      steps: [
        {
          type: "map_columns",
          config: {
            mapping: {
              FirstName: "first_name",
              LastName: "last_name",
              Email: "email",
              Phone: "phone",
              Company: "company",
              Country: "country"
            }
          }
        },
        {
          type: "format",
          config: {
            operations: [
              { field: "first_name", op: { kind: "title_case" } },
              { field: "last_name", op: { kind: "title_case" } },
              { field: "email", op: { kind: "email_normalize" } },
              { field: "phone", op: { kind: "phone_e164", defaultCountry: "US" } },
              { field: "country", op: { kind: "iso_country" } }
            ]
          }
        },
        {
          type: "validate",
          config: {
            rules: [
              { kind: "required", field: "email" },
              { kind: "regex", field: "email", pattern: "^[^@]+@[^@]+\\.[^@]+$" },
              { kind: "required", field: "first_name" }
            ]
          }
        },
        {
          type: "dedupe",
          config: {
            keys: ["email"],
            fuzzy: {
              enabled: true,
              threshold: 0.92
            }
          }
        },
        {
          type: "write_back",
          config: {
            strategy: "monday_upsert",
            keyColumn: "email"
          }
        }
      ]
    },
    premium: true
  },
  {
    id: "hr",
    name: "HR Roster",
    description: "Standardize employee rosters with compliance checks.",
    recipe: {
      id: "hr",
      name: "HR Roster",
      version: 1,
      steps: [
        {
          type: "map_columns",
          config: {
            mapping: {
              "Employee Name": "full_name",
              Email: "email",
              "Start Date": "start_date",
              Department: "department",
              Country: "country"
            }
          }
        },
        {
          type: "format",
          config: {
            operations: [
              { field: "full_name", op: { kind: "title_case" } },
              { field: "email", op: { kind: "email_normalize" } },
              { field: "start_date", op: { kind: "date_parse", outputFormat: "yyyy-MM-dd" } },
              { field: "country", op: { kind: "iso_country" } }
            ]
          }
        },
        {
          type: "validate",
          config: {
            rules: [
              { kind: "required", field: "full_name" },
              { kind: "required", field: "start_date" },
              { kind: "in_set", field: "department", values: ["Finance", "HR", "Sales", "Engineering"] }
            ]
          }
        },
        {
          type: "dedupe",
          config: {
            keys: ["email"]
          }
        },
        {
          type: "write_back",
          config: {
            strategy: "monday_upsert",
            keyColumn: "email"
          }
        }
      ]
    }
  },
  {
    id: "orders",
    name: "Orders",
    description: "Normalize order feeds and currency values.",
    recipe: {
      id: "orders",
      name: "Orders",
      version: 1,
      steps: [
        {
          type: "map_columns",
          config: {
            mapping: {
              "Order ID": "order_id",
              Amount: "amount",
              Currency: "currency",
              "Order Date": "order_date",
              "Customer Email": "email"
            }
          }
        },
        {
          type: "format",
          config: {
            operations: [
              { field: "amount", op: { kind: "number_parse", locale: "en-US" } },
              { field: "currency", op: { kind: "currency_code" } },
              { field: "order_date", op: { kind: "date_parse", outputFormat: "yyyy-MM-dd" } },
              { field: "email", op: { kind: "email_normalize" } }
            ]
          }
        },
        {
          type: "validate",
          config: {
            rules: [
              { kind: "required", field: "order_id" },
              { kind: "required", field: "amount" },
              { kind: "required", field: "currency" }
            ]
          }
        },
        {
          type: "dedupe",
          config: {
            keys: ["order_id"]
          }
        },
        {
          type: "write_back",
          config: {
            strategy: "csv"
          }
        }
      ]
    }
  }
];

type BoardViewClientProps = {
  token: string | null;
};

export default function BoardViewClient({ token }: BoardViewClientProps) {
  const [context, setContext] = useState<MondayContext | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(token);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(templates[0]?.id ?? "");
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<(RecipePreviewResult & { runId?: string }) | null>(null);
  const [toast, setToast] = useState<{ message: string; variant?: "default" | "success" | "error" } | null>(
    null
  );
  const [isPreviewing, startPreview] = useTransition();
  const [isExecuting, startExecute] = useTransition();

  const mondayClient = useMemo(() => {
    if (typeof window === "undefined") {
      return null;
    }
    return mondaySdk();
  }, []);

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === selectedTemplateId) ?? templates[0],
    [selectedTemplateId]
  );

  useEffect(() => {
    if (token) {
      setSessionToken(token);
      return;
    }

    if (process.env.NEXT_PUBLIC_ENABLE_STUB_CONTEXT === "1") {
      setContext(STUB_CONTEXT);
      setContextError(null);
      return;
    }

    if (!mondayClient) {
      return;
    }

    let mounted = true;
    mondayClient
      .get("sessionToken")
      .then((result: { data?: string }) => {
        if (!mounted) return;
        if (result?.data) {
          setSessionToken(result.data);
        } else {
          setContextError("Unable to retrieve monday session token.");
        }
      })
      .catch((error: unknown) => {
        if (!mounted) return;
        setContextError((error as Error).message ?? "Failed to retrieve monday session token.");
      });

    return () => {
      mounted = false;
    };
  }, [token, mondayClient]);

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_ENABLE_STUB_CONTEXT === "1") {
      setContext(STUB_CONTEXT);
      setContextError(null);
      return;
    }

    if (!sessionToken) {
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/monday/context/verify", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ token: sessionToken })
        });
        if (!response.ok) {
          throw new Error(await response.text());
        }
        const result = (await response.json()) as MondayContext;
        if (!cancelled) {
          setContext(result);
          setContextError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setContextError((error as Error).message);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionToken]);

  const planAllowsFuzzy = context?.flags.fuzzyMatching ?? false;
  const needsPremium = context ? !!selectedTemplate?.premium && !planAllowsFuzzy : false;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Data Standardization Toolkit</h1>
        <p className="text-sm text-muted-foreground">
          Upload a CSV/XLSX or choose a monday board source to preview transformations before writing back.
        </p>
        {context && (
          <UsageBadge used={context.usage.rowsProcessed} cap={context.flags.rowCap} />
        )}
        {contextError && <p className="text-sm text-destructive">{contextError}</p>}
      </header>

      <section className="grid gap-4 md:grid-cols-[2fr,3fr]">
        <Card>
          <CardHeader>
            <CardTitle>1. Choose a template</CardTitle>
            <CardDescription>
              Templates are starting points. Customize recipes in the dashboard after saving.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Label htmlFor="template">Template</Label>
            <Select
              id="template"
              value={selectedTemplateId}
              onChange={(event) => setSelectedTemplateId(event.target.value)}
            >
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </Select>
            <p className="text-xs text-muted-foreground">{selectedTemplate?.description}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>2. Upload data</CardTitle>
            <CardDescription>Supports CSV or XLSX up to 5 MB.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <UploadDropzone
              onFile={(file) => {
                setUploadedFile(file);
                setPreview(null);
                setToast({ message: `Loaded ${file.name}`, variant: "success" });
              }}
            />
            <Button
              disabled={!uploadedFile || !context || isPreviewing || needsPremium}
              onClick={() => {
                if (!uploadedFile || !context || !selectedTemplate) return;
                startPreview(async () => {
                  try {
                    const formData = new FormData();
                    formData.set("file", uploadedFile);
                    formData.set("tenantId", context.tenantId);
                    formData.set("recipe", JSON.stringify(selectedTemplate.recipe));
                    formData.set("plan", context.plan);
                    const response = await fetch("/api/recipes/run/preview", {
                      method: "POST",
                      body: formData
                    });
                    if (!response.ok) {
                      throw new Error(await response.text());
                    }
                    const result = (await response.json()) as RecipePreviewResult & { runId?: string };
                    setPreview(result);
                    setToast({ message: "Preview ready", variant: "success" });
                  } catch (error) {
                    setToast({ message: (error as Error).message, variant: "error" });
                  }
                });
              }}
            >
              {isPreviewing ? "Processing..." : "Preview recipe"}
            </Button>
          </CardContent>
        </Card>
      </section>

      <PlanGate
        allowed={!needsPremium}
        plan={context?.plan ?? "free"}
        feature="fuzzy deduplication"
        onUpgrade={() => setToast({ message: "Upgrade to unlock fuzzy dedupe.", variant: "default" })}
      >
        <section className="grid gap-6 md:grid-cols-[3fr,2fr]">
          <Card className="md:col-span-2">
            <CardHeader>
              <CardTitle>Preview</CardTitle>
              <CardDescription>Shows the first rows with error badges and changes.</CardDescription>
            </CardHeader>
            <CardContent>
              {preview ? (
                <DataGridPreview rows={preview.rows} diff={preview.diff} errors={preview.errors} />
              ) : (
                <p className="text-sm text-muted-foreground">Run a preview to inspect transformed data.</p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Diff & Actions</CardTitle>
              <CardDescription>Confirm changes before running write-back.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {preview && <DiffViewer diff={preview.diff} />}
              <Button
                variant="secondary"
                disabled={!preview || !context || isExecuting}
                onClick={() => {
                  if (!preview || !context || !selectedTemplate) return;
                  startExecute(async () => {
                    try {
                      const response = await fetch("/api/recipes/run/execute", {
                        method: "POST",
                        headers: {
                          "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                          tenantId: context.tenantId,
                          recipe: selectedTemplate.recipe,
                          runId: preview.runId,
                          previewRows: preview.rows,
                          plan: context.plan
                        })
                      });
                      if (!response.ok) {
                        throw new Error(await response.text());
                      }
                      const result = (await response.json()) as { rowsWritten: number };
                      setToast({
                        message: `Run complete. ${result.rowsWritten} rows processed.`,
                        variant: "success"
                      });
                    } catch (error) {
                      setToast({ message: (error as Error).message, variant: "error" });
                    }
                  });
                }}
              >
                {isExecuting ? "Running..." : "Run write-back"}
              </Button>
            </CardContent>
          </Card>
        </section>
      </PlanGate>

      <Toast message={toast?.message ?? null} variant={toast?.variant} />
    </div>
  );
}
