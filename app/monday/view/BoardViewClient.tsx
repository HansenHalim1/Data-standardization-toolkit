'use client';

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import mondaySdk from "monday-sdk-js";
import type { RecipeDefinition, RecipePreviewResult, WriteBackStep } from "@/lib/recipe-engine";
import type { PlanFlags } from "@/lib/entitlements";
import { UploadDropzone } from "@/components/UploadDropzone";
import { DataGridPreview } from "@/components/DataGridPreview";
import { DiffViewer } from "@/components/DiffViewer";
import { PlanGate } from "@/components/PlanGate";
import { UsageBadge } from "@/components/UsageBadge";
import { Toast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
  recipe: RecipeDefinition | null;
  premium?: boolean;
};

const CUSTOM_TEMPLATE_ID = "custom";

const BLANK_RECIPE: RecipeDefinition = {
  id: "custom",
  name: "Custom Recipe",
  version: 1,
  steps: [
    {
      type: "map_columns",
      config: {
        mapping: {},
        dropUnknown: false
      }
    },
    {
      type: "write_back",
      config: {
        strategy: "monday_upsert"
      }
    }
  ]
};

const templates: Template[] = [
  {
    id: CUSTOM_TEMPLATE_ID,
    name: "Start from scratch",
    description: "Begin with an empty recipe and configure your own workflow later.",
    recipe: null
  },
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
            strategy: "monday_upsert",
            keyColumn: "order_id",
            keyColumnId: "text_mkwrgn66"
          }
        }
      ]
    }
  }
];

const DEFAULT_TEMPLATE_ID = CUSTOM_TEMPLATE_ID;

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
  const [writeBoardId, setWriteBoardId] = useState<string>("");
  const [writeBoardName, setWriteBoardName] = useState<string>("");
  const [writeBoardError, setWriteBoardError] = useState<string | null>(null);
  const [isPreparingWriteBoard, setPreparingWriteBoard] = useState(false);
  const [newBoardName, setNewBoardName] = useState<string>("");
  const [isCreatingBoard, setIsCreatingBoard] = useState(false);

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

  const isBlankSelection = selectedTemplate?.recipe == null;

  const selectedRecipe = useMemo(
    () => selectedTemplate?.recipe ?? BLANK_RECIPE,
    [selectedTemplate]
  );

  const applyPreparedRecipe = useCallback(
    (recipe: RecipeDefinition | null) => {
      setPreparedRecipe(recipe);
      if (!recipe) {
        setWriteBoardError(null);
        return;
      }
      const writeStep = recipe.steps.find((step): step is WriteBackStep => step.type === "write_back");
      const mapping = writeStep?.config?.columnMapping;
      if (!mapping || Object.keys(mapping).length === 0) {
        if (isBlankSelection) {
          setWriteBoardError(null);
        } else {
          setWriteBoardError(
            "No matching columns found between the template and the selected board. Rename the board columns or adjust the template mapping."
          );
        }
      } else {
        setWriteBoardError(null);
      }
    },
    [isBlankSelection]
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
      if (writeBoardId) {
        const matching = boardsList.find((board) => board.id === writeBoardId);
        if (matching) {
          setWriteBoardName(matching.name);
        }
      }
    } catch (error) {
      setBoards([]);
      setBoardsError((error as Error).message ?? "Failed to load boards.");
    } finally {
      setLoadingBoards(false);
    }
  }, [loadBoards, writeBoardId]);

  const handleWriteBoardSelect = useCallback(
    async (boardId: string, options?: { prepared?: RecipeDefinition | null; boardName?: string }) => {
      setWriteBoardError(null);
      setWriteBoardId(boardId);
      const board = boards.find((entry) => entry.id === boardId);
      const resolvedName = options?.boardName ?? board?.name ?? "";
      setWriteBoardName(resolvedName);

      if (!boardId) {
        applyPreparedRecipe(options?.prepared ?? null);
        return;
      }

      if (options?.prepared) {
        applyPreparedRecipe(options.prepared);
        return;
      }

      if (sourceBoard?.boardId === boardId && preparedRecipe) {
        applyPreparedRecipe(preparedRecipe);
        return;
      }

      try {
        setPreparingWriteBoard(true);
        
        const sessionToken = await getSessionToken();
        const response = await fetch(`/api/monday/boards/${boardId}/prepare`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${sessionToken}`
          },
          body: JSON.stringify({
            recipe: selectedRecipe
          })
        });
        if (!response.ok) {
          throw new Error(await response.text());
        }
        const data = (await response.json()) as {
          preparedRecipe: RecipeDefinition;
          board?: { boardId: string; boardName: string };
        };
        applyPreparedRecipe(data.preparedRecipe);
        setWriteBoardName(data.board?.boardName ?? resolvedName);
      } catch (error) {
        setWriteBoardError((error as Error).message ?? "Failed to prepare board for write-back.");
      } finally {
        setPreparingWriteBoard(false);
      }
    },
    [applyPreparedRecipe, boards, getSessionToken, preparedRecipe, selectedRecipe, sourceBoard?.boardId]
  );

  const handleCreateBoard = useCallback(async () => {
    if (!selectedTemplate) {
      setWriteBoardError("Select a template before creating a board.");
      return;
    }
    const trimmedName = newBoardName.trim();
    if (!trimmedName) {
      setWriteBoardError("Enter a name for the new board.");
      return;
    }

    try {
      setIsCreatingBoard(true);
      setBoardsError(null);
      setWriteBoardError(null);
      const sessionToken = await getSessionToken();
      const recipeForBoard = preparedRecipe ?? selectedRecipe;
      const response = await fetch("/api/monday/boards", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`
        },
        body: JSON.stringify({
          name: trimmedName,
          recipe: recipeForBoard
        })
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      const result = (await response.json()) as {
        board: {
          boardId: string;
          boardName: string;
          workspaceName?: string | null;
          kind?: string | null;
        };
        preparedRecipe: RecipeDefinition;
      };
      setBoards((current) => {
        const filtered = current.filter((entry) => entry.id !== result.board.boardId);
        const next = [
          ...filtered,
          {
            id: result.board.boardId,
            name: result.board.boardName,
            workspaceName: result.board.workspaceName ?? null,
            kind: result.board.kind ?? null
          }
        ];
        return next.sort((a, b) => a.name.localeCompare(b.name));
      });
      await handleWriteBoardSelect(result.board.boardId, {
        prepared: result.preparedRecipe,
        boardName: result.board.boardName
      });
      setNewBoardName("");
      setToast({
        message: `Created board "${result.board.boardName}".`,
        variant: "success"
      });
    } catch (error) {
      setWriteBoardError((error as Error).message ?? "Failed to create board.");
    } finally {
      setIsCreatingBoard(false);
    }
  }, [
    getSessionToken,
    handleWriteBoardSelect,
    newBoardName,
    preparedRecipe,
    selectedRecipe,
    selectedTemplate
  ]);

  useEffect(() => {
    if (!context || !mondayClient) {
      return;
    }
    if (boards.length > 0 || isLoadingBoards) {
      return;
    }
    refreshBoards();
  }, [boards.length, context, isLoadingBoards, mondayClient, refreshBoards]);

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
    applyPreparedRecipe(null);
    setSourceBoard(null);
    setBoardsError(null);
    setWriteBoardId("");
    setWriteBoardName("");
    setPreparingWriteBoard(false);
    setNewBoardName("");
    if (dataSource === "file") {
      setSelectedBoardId("");
    } else {
      setUploadedFile(null);
    }
  }, [applyPreparedRecipe, dataSource]);

  useEffect(() => {
    setPreview(null);
    applyPreparedRecipe(null);
    setSourceBoard(null);
    setWriteBoardId("");
    setWriteBoardName("");
    setNewBoardName("");
  }, [applyPreparedRecipe, selectedTemplateId]);

  useEffect(() => {
    if (dataSource === "board") {
      setPreview(null);
      applyPreparedRecipe(null);
      setSourceBoard(null);
      setWriteBoardId("");
      setWriteBoardName("");
    }
  }, [applyPreparedRecipe, selectedBoardId, dataSource]);

  useEffect(() => {
    if (!writeBoardId) {
      return;
    }
    const matching = boards.find((board) => board.id === writeBoardId);
    if (matching && matching.name !== writeBoardName) {
      setWriteBoardName(matching.name);
    }
  }, [boards, writeBoardId, writeBoardName]);

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
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          {context && (
            <UsageBadge used={context.usage.rowsProcessed} cap={context.flags.rowCap} />
          )}
          <Button
            asChild
            variant="outline"
            size="sm"
          >
            <Link href="/settings/monday" target="_blank" rel="noopener noreferrer">
              Start
            </Link>
          </Button>
        </div>
        {contextError && <p className="text-sm text-destructive">{contextError}</p>}
      </header>

      <section className="grid gap-4 md:grid-cols-[2fr,3fr]">
        <Card>
          <CardHeader>
            <CardTitle>1. Choose a template (optional)</CardTitle>
            <CardDescription>
              Templates are starting points. Leave the default selection to build your own recipe later in the dashboard.
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
                    applyPreparedRecipe(null);
                    setSourceBoard(null);
                    setWriteBoardId("");
                    setWriteBoardName("");
                    
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
                          recipe: selectedRecipe,
                          plan: context.plan
                        })
                      });
                      if (!response.ok) {
                        throw new Error(await response.text());
                      }
                      const result = (await response.json()) as PreviewResponse;
                      setPreview(result);
                      setSourceBoard(result.sourceBoard ?? null);
                      const prepared = result.preparedRecipe ?? (result.sourceBoard ? null : selectedRecipe);
                      if (result.sourceBoard) {
                        await handleWriteBoardSelect(result.sourceBoard.boardId, {
                          prepared,
                          boardName: result.sourceBoard.boardName
                        });
                      } else {
                        applyPreparedRecipe(prepared ?? null);
                        setWriteBoardId("");
                        setWriteBoardName("");
                      }
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
                    formData.set("recipe", JSON.stringify(selectedRecipe));
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
                    applyPreparedRecipe(selectedRecipe);
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
              <div className="space-y-2">
                <Label htmlFor="write-board-select">Write to board</Label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Select
                    id="write-board-select"
                    value={writeBoardId}
                    onChange={(event) => handleWriteBoardSelect(event.target.value)}
                    className="sm:flex-1"
                    disabled={isPreparingWriteBoard}
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
                    size="sm"
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
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    value={newBoardName}
                    onChange={(event) => setNewBoardName(event.target.value)}
                    placeholder="New board name"
                    className="sm:flex-1"
                    disabled={isCreatingBoard || isPreparingWriteBoard}
                  />
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleCreateBoard}
                    disabled={
                      isCreatingBoard ||
                      isPreparingWriteBoard ||
                      !newBoardName.trim()
                    }
                  >
                    {isCreatingBoard ? "Creating..." : "Create board"}
                  </Button>
                </div>
                {isPreparingWriteBoard && (
                  <p className="text-xs text-muted-foreground">Preparing board mapping…</p>
                )}
                {writeBoardError && <p className="text-xs text-destructive">{writeBoardError}</p>}
                {writeBoardId && writeBoardName && !writeBoardError && !isPreparingWriteBoard && (
                  <p className="text-xs text-muted-foreground">
                    Writing to <strong>{writeBoardName}</strong>
                  </p>
                )}
              </div>

              {preview && <DiffViewer diff={preview.diff} />}
              <Button
                variant="secondary"
                disabled={!preview || !context || isExecuting || !writeBoardId || isPreparingWriteBoard}
                onClick={() => {
                  if (!preview || !context || !selectedTemplate) return;
                  if (!writeBoardId) {
                    setToast({ message: "Select a board to write to before running.", variant: "error" });
                    return;
                  }
                  startExecute(async () => {
                    try {
                      const sessionToken = await getSessionToken();
                      const baseRecipe = preparedRecipe ?? selectedRecipe;
                      const recipeForExecution = JSON.parse(JSON.stringify(baseRecipe)) as RecipeDefinition;
                      const writeStep = recipeForExecution.steps.find(
                        (step): step is WriteBackStep => step.type === "write_back"
                      );
                      if (!writeStep) {
                        throw new Error("Recipe missing write-back step.");
                      }
                      writeStep.config.boardId = writeBoardId;
                      if (!writeStep.config.boardId) {
                        throw new Error("Select a board to write to before running.");
                      }
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

