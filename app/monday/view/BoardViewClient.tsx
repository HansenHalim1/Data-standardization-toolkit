'use client';

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
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

const DEFAULT_TEMPLATE_ID =
  templates.find((template) => !template.premium)?.id ?? templates[0]?.id ?? "";

type DataSource = "file" | "board";

type MondayBoardOption = {
  id: string;
  name: string;
  workspaceName?: string | null;
  kind?: string | null;
};

type PreviewResponse = RecipePreviewResult & {
  runId?: string;
  preparedRecipe?: RecipeDefinition;
  sourceBoard?: {
    boardId: string;
    boardName: string;
  };
};

export default function BoardViewClient() {
  const [context, setContext] = useState<MondayContext | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(DEFAULT_TEMPLATE_ID);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [preparedRecipe, setPreparedRecipe] = useState<RecipeDefinition | null>(null);
  const [toast, setToast] = useState<{ message: string; variant?: "default" | "success" | "error" } | null>(
    null
  );
  const [isPreviewing, startPreview] = useTransition();
  const [isExecuting, startExecute] = useTransition();
  const [dataSource, setDataSource] = useState<DataSource>("file");
  const [boards, setBoards] = useState<MondayBoardOption[]>([]);
  const [isLoadingBoards, setLoadingBoards] = useState(false);
  const [boardsError, setBoardsError] = useState<string | null>(null);
  const [selectedBoardId, setSelectedBoardId] = useState<string>("");
  const [sourceBoard, setSourceBoard] = useState<PreviewResponse["sourceBoard"] | null>(null);

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

  const getSessionToken = useCallback(async () => {
    if (!mondayClient) {
      throw new Error("Missing monday context token. Launch this app from a monday board.");
    }
    const result: { data?: string } = await mondayClient.get("sessionToken");
    const token = result?.data;
    if (!token) {
      throw new Error("Unable to retrieve monday session token.");
    }
    return token;
  }, [mondayClient]);

  const loadBoards = useCallback(async () => {
    const sessionToken = await getSessionToken();
    const response = await fetch("/api/monday/boards", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${sessionToken}`
      }
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    const data = (await response.json()) as { boards?: MondayBoardOption[] };
    return data.boards ?? [];
  }, [getSessionToken]);

  const refreshBoards = useCallback(async () => {
    try {
      setLoadingBoards(true);
      setBoardsError(null);
      const boardsList = await loadBoards();
      setBoards(boardsList);
    } catch (error) {
      setBoards([]);
      setBoardsError((error as Error).message ?? "Failed to load boards.");
    } finally {
      setLoadingBoards(false);
    }
  }, [loadBoards]);

  useEffect(() => {
    if (!mondayClient) {
      setContextError("Missing monday context token. Launch this app from a monday board.");
      setContext(null);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const sessionToken = await getSessionToken();
        if (cancelled) {
          return;
        }
        const response = await fetch("/api/monday/context/verify", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${sessionToken}`
          }
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
          setContextError((error as Error).message ?? "Failed to verify monday context token.");
          setContext(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [mondayClient, getSessionToken]);

  const planAllowsFuzzy = context?.flags.fuzzyMatching ?? false;
  const needsPremium = context ? !!selectedTemplate?.premium && !planAllowsFuzzy : false;
  const canPreview =
    Boolean(context) &&
    !needsPremium &&
    !isPreviewing &&
    ((dataSource === "file" && Boolean(uploadedFile)) || (dataSource === "board" && Boolean(selectedBoardId)));

  useEffect(() => {
    if (dataSource !== "board" || !mondayClient) {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        setLoadingBoards(true);
        setBoardsError(null);
        const boardsList = await loadBoards();
        if (!cancelled) {
          setBoards(boardsList);
        }
      } catch (error) {
        if (!cancelled) {
          setBoards([]);
          setBoardsError((error as Error).message ?? "Failed to load boards.");
        }
      } finally {
        if (!cancelled) {
          setLoadingBoards(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dataSource, loadBoards, mondayClient]);

  useEffect(() => {
    setPreview(null);
    setPreparedRecipe(null);
    setSourceBoard(null);
    setBoardsError(null);
    if (dataSource === "file") {
      setSelectedBoardId("");
    } else {
      setUploadedFile(null);
    }
  }, [dataSource]);

  useEffect(() => {
    setPreview(null);
    setPreparedRecipe(null);
    setSourceBoard(null);
  }, [selectedTemplateId]);

  useEffect(() => {
    if (dataSource === "board") {
      setPreview(null);
      setPreparedRecipe(null);
      setSourceBoard(null);
    }
  }, [selectedBoardId, dataSource]);

  useEffect(() => {
    if (!context) {
      return;
    }
    if (!needsPremium) {
      return;
    }
    const fallback = templates.find((template) => !template.premium);
    if (fallback && fallback.id !== selectedTemplateId) {
      setSelectedTemplateId(fallback.id);
      setToast({
        message: `${selectedTemplate?.name ?? "This template"} requires an upgraded plan. Switched to ${fallback.name}.`,
        variant: "default"
      });
    }
  }, [context, needsPremium, selectedTemplate?.name, selectedTemplateId]);

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
                  {template.premium ? " (Premium)" : ""}
                </option>
              ))}
            </Select>
            <p className="text-xs text-muted-foreground">{selectedTemplate?.description}</p>
            {needsPremium && (
              <p className="text-xs text-destructive">
                {selectedTemplate?.name} requires an upgraded plan with fuzzy deduplication. Choose another template or
                upgrade to unlock it.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>2. Select data source</CardTitle>
            <CardDescription>Preview via upload or directly from a monday board.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="data-source">Source</Label>
              <Select
                id="data-source"
                value={dataSource}
                onChange={(event) => setDataSource(event.target.value as DataSource)}
              >
                <option value="file">Upload CSV/XLSX</option>
                <option value="board">monday.com board</option>
              </Select>
            </div>

            {dataSource === "file" ? (
              <>
                <UploadDropzone
                  onFile={(file) => {
                    setDataSource("file");
                    setUploadedFile(file);
                    setPreview(null);
                    setPreparedRecipe(null);
                    setSourceBoard(null);
                    setToast({ message: `Loaded ${file.name}`, variant: "success" });
                  }}
                />
                {uploadedFile && (
                  <p className="text-xs text-muted-foreground truncate">Ready: {uploadedFile.name}</p>
                )}
              </>
            ) : (
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="board-select">Board</Label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Select
                      id="board-select"
                      value={selectedBoardId}
                      onChange={(event) => setSelectedBoardId(event.target.value)}
                      className="sm:flex-1"
                    >
                      <option value="">Select a board</option>
                      {boards.map((board) => (
                        <option key={board.id} value={board.id}>
                          {board.name}
                          {board.workspaceName ? ` — ${board.workspaceName}` : ""}
                        </option>
                      ))}
                    </Select>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        if (!mondayClient) {
                          setBoardsError("Missing monday context. Open this app inside monday.");
                          return;
                        }
                        refreshBoards();
                      }}
                      disabled={isLoadingBoards}
                    >
                      {isLoadingBoards ? "Refreshing..." : "Refresh"}
                    </Button>
                  </div>
                  {isLoadingBoards && (
                    <p className="text-xs text-muted-foreground">Loading boards…</p>
                  )}
                  {boardsError && <p className="text-xs text-destructive">{boardsError}</p>}
                  {sourceBoard && (
                    <p className="text-xs text-muted-foreground">
                      Previewing data from <strong>{sourceBoard.boardName}</strong>
                    </p>
                  )}
                </div>
              </div>
            )}

            <Button
              disabled={!canPreview}
              onClick={() => {
                if (!context || !selectedTemplate) return;
                if (dataSource === "board") {
                  if (!selectedBoardId) {
                    setToast({ message: "Select a board to preview.", variant: "error" });
                    return;
                  }
                  startPreview(async () => {
                    try {
                      const sessionToken = await getSessionToken();
                      const response = await fetch("/api/recipes/run/preview", {
                        method: "POST",
                        headers: {
                          "Content-Type": "application/json",
                          Authorization: `Bearer ${sessionToken}`
                        },
                        body: JSON.stringify({
                          source: { type: "board", boardId: selectedBoardId },
                          recipe: selectedTemplate.recipe,
                          plan: context.plan
                        })
                      });
                      if (!response.ok) {
                        throw new Error(await response.text());
                      }
                      const result = (await response.json()) as PreviewResponse;
                      setPreview(result);
                      setPreparedRecipe(result.preparedRecipe ?? selectedTemplate.recipe);
                      setSourceBoard(result.sourceBoard ?? null);
                      setToast({
                        message: `Preview ready${result.sourceBoard ? ` for ${result.sourceBoard.boardName}` : ""}`,
                        variant: "success"
                      });
                    } catch (error) {
                      setToast({ message: (error as Error).message, variant: "error" });
                    }
                  });
                  return;
                }

                if (!uploadedFile) {
                  setToast({ message: "Upload a file to preview.", variant: "error" });
                  return;
                }

                startPreview(async () => {
                  try {
                    const sessionToken = await getSessionToken();
                    const formData = new FormData();
                    formData.set("file", uploadedFile);
                    formData.set("tenantId", context.tenantId);
                    formData.set("recipe", JSON.stringify(selectedTemplate.recipe));
                    formData.set("plan", context.plan);
                    const response = await fetch("/api/recipes/run/preview", {
                      method: "POST",
                      headers: {
                        Authorization: `Bearer ${sessionToken}`
                      },
                      body: formData
                    });
                    if (!response.ok) {
                      throw new Error(await response.text());
                    }
                    const result = (await response.json()) as PreviewResponse;
                    setPreview(result);
                    setPreparedRecipe(selectedTemplate.recipe);
                    setSourceBoard(null);
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
                      const sessionToken = await getSessionToken();
                      const recipeForExecution = preparedRecipe ?? selectedTemplate.recipe;
                      const response = await fetch("/api/recipes/run/execute", {
                        method: "POST",
                        headers: {
                          "Content-Type": "application/json",
                          Authorization: `Bearer ${sessionToken}`
                        },
                        body: JSON.stringify({
                          tenantId: context.tenantId,
                          recipe: recipeForExecution,
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

