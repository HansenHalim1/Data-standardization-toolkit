import type { SupabaseClient } from "@supabase/supabase-js";
import { createLogger } from "./logging";
import { getApiClient } from "./mondayOAuth";
import type { MapColumnsStep, RecipeDefinition, RecipeRow, WriteBackStep } from "./recipe-engine";
import type { Database } from "@/types/supabase";

type Column = {
  id: string;
  title: string;
  type: string;
};

type Item = {
  id: string;
  name: string;
  column_values: Array<{ id: string; text: string | null }>;
};

export type MondayBoardSummary = {
  id: string;
  name: string;
  workspaceName?: string | null;
  kind?: string | null;
};

export type MondayBoardData = {
  boardId: string;
  boardName: string;
  columns: Column[];
  items: Item[];
};

export type MondayColumnMapping = Record<string, string>;

const logger = createLogger({ component: "monday.api" });

type BoardCreationSummary = MondayBoardSummary & { workspaceId?: string | null };
type MondayBoardKind = "public" | "private" | "share";

export type BoardSchema = Record<string, string>;

const NORMALIZED_NAME_SKIP = new Set(["name", "itemname", "pulse"]);

function normalizeColumnKey(value: string | null | undefined): string {
  return value ? value.toString().trim().toLowerCase().replace(/[^a-z0-9]/g, "") : "";
}

function toColumnTitle(field: string): string {
  const spaced = field
    .replace(/[_\-]+/g, " ")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  if (!spaced) {
    return "Column";
  }
  return spaced
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function inferColumnType(field: string): "text" | "email" | "phone" | "date" {
  const normalized = field.toLowerCase();
  if (normalized.includes("email")) {
    return "email";
  }
  if (normalized.includes("phone") || normalized.includes("mobile") || normalized.includes("tel")) {
    return "phone";
  }
  if (normalized.includes("date")) {
    return "date";
  }
  return "text";
}

function collectRecipeFields(recipe: RecipeDefinition): string[] {
  const fields = new Set<string>();

  const mapStep = recipe.steps.find(
    (step): step is MapColumnsStep => step.type === "map_columns"
  );
  if (mapStep) {
    const mapping = mapStep.config.mapping ?? {};
    for (const target of Object.values(mapping)) {
      if (target) {
        fields.add(target);
      }
    }
  }

  const writeStep = recipe.steps.find(
    (step): step is WriteBackStep => step.type === "write_back"
  );
  if (writeStep) {
    if (writeStep.config.columnMapping) {
      for (const target of Object.keys(writeStep.config.columnMapping)) {
        if (target) {
          fields.add(target);
        }
      }
    }
    if (writeStep.config.keyColumn) {
      fields.add(writeStep.config.keyColumn);
    }
    if (writeStep.config.itemNameField) {
      fields.add(writeStep.config.itemNameField);
    }
  }

  return Array.from(fields);
}

function normalizeDateValue(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString().slice(0, 10);
}

function formatColumnValue(rawValue: unknown, columnType?: string): unknown | null {
  if (rawValue === null || rawValue === undefined) {
    return null;
  }
  const normalized = typeof rawValue === "string" ? rawValue.trim() : String(rawValue).trim();
  if (!normalized) {
    return null;
  }

  switch (columnType) {
    case "email":
      return {
        email: normalized,
        text: normalized
      };
    case "phone":
      return {
        phone: normalized
      };
    case "date": {
      const dateValue = normalizeDateValue(normalized);
      return dateValue ? { date: dateValue } : null;
    }
    case "text":
    default:
      // Text columns should be plain strings for Monday's API
      return normalized;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function logMondayPayload(entry: { query: string; variables: unknown }) {
  const timestamp = new Date().toISOString();
  console.log(
    JSON.stringify({
      ts: timestamp,
      level: "info",
      msg: "Monday mutation payload",
      payload: entry
    })
  );
}

export async function resolveOAuthToken(
  supabase: SupabaseClient<Database>,
  accountId: string,
  userId: string
): Promise<string> {
  const accountNumeric = Number(accountId);
  const userNumeric = Number(userId);

  const accountCandidates: Array<string | number> = Number.isFinite(accountNumeric)
    ? [accountNumeric, accountId]
    : [accountId];
  const userCandidates: Array<string | number> = Number.isFinite(userNumeric)
    ? [userNumeric, userId]
    : [userId];

  for (const accountCandidate of accountCandidates) {
    for (const userCandidate of userCandidates) {
      const { data, error } = await supabase
        .from("monday_oauth_tokens")
        .select("access_token")
        .eq("account_id", accountCandidate)
        .eq("user_id", userCandidate)
        .maybeSingle();

      if (error) {
        throw new Error(`Failed to load monday OAuth token: ${error.message}`);
      }
      if (data?.access_token) {
        return data.access_token;
      }
    }
  }

  for (const accountCandidate of accountCandidates) {
    const { data, error } = await supabase
      .from("monday_oauth_tokens")
      .select("access_token")
      .eq("account_id", accountCandidate)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to load monday OAuth token: ${error.message}`);
    }
    if (data?.access_token) {
      logger.warn("Falling back to account-level monday token (user mismatch)", {
        accountId: accountCandidate,
        requestedUserId: userId
      });
      return data.access_token;
    }
  }

  throw new Error("monday.com account is not connected for this user. Reconnect the integration.");
}

export async function fetchBoardSchema({
  accessToken,
  boardId
}: {
  accessToken: string;
  boardId: string;
}): Promise<BoardSchema> {
  const boardData = await fetchBoardData(accessToken, boardId, 1);
  const schema: BoardSchema = {};
  for (const column of boardData.columns) {
    const normalized = normalizeColumnKey(column.title);
    if (!normalized) {
      continue;
    }
    schema[normalized] = column.id;
  }
  return schema;
}

export async function writeBackToMonday({
  accessToken,
  boardId,
  itemId,
  data
}: {
  accessToken: string;
  boardId: string;
  itemId: string;
  data: Record<string, unknown>;
}): Promise<{ id: string } | null> {
  const boardData = await fetchBoardData(accessToken, boardId);
  const columnsById = new Map(boardData.columns.map((column) => [column.id, column]));
  const columnsByName = new Map(
    boardData.columns.map((column) => [normalizeColumnKey(column.title), column])
  );
  const columnValues: Record<string, unknown> = {};

  for (const [field, rawValue] of Object.entries(data)) {
    const column =
      columnsById.get(field) ?? columnsByName.get(normalizeColumnKey(field));
    if (!column) {
      logger.warn("No monday column found for field", { boardId, field });
      continue;
    }

    let payload: unknown = rawValue;
    const isPlainObject =
      typeof rawValue === "object" && rawValue !== null && !Array.isArray(rawValue);
    if (!isPlainObject) {
      const formatted = formatColumnValue(rawValue, column.type);
      if (formatted === null) {
        continue;
      }
      payload = formatted;
    }

    columnValues[column.id] = payload;
  }

  const columnIds = Object.keys(columnValues);
  if (columnIds.length === 0) {
    throw new Error("No valid columns matched the provided data for monday write-back.");
  }

  const client = getApiClient({ accessToken });
  const variables = {
    boardId,
    itemId,
    columnValues: JSON.stringify(columnValues)
  };

  await logMondayPayload({
    query: `
      mutation UpdateItem($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
        change_multiple_column_values(
          board_id: $boardId,
          item_id: $itemId,
          column_values: $columnValues
        ) {
          id
        }
      }
    `,
    variables
  });

  const result = await client<{
    change_multiple_column_values: { id: string } | null;
  }>({
    query: `
      mutation UpdateItem($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
        change_multiple_column_values(
          board_id: $boardId,
          item_id: $itemId,
          column_values: $columnValues
        ) {
          id
        }
      }
    `,
    variables
  });

  return result.change_multiple_column_values ?? null;
}

export async function upsertRowsToBoardBatchSafe({
  accessToken,
  boardId,
  columnMapping,
  rows,
  keyColumn,
  keyColumnId,
  itemNameField,
  batchSize = 5,
  delayMs = 600,
  maxRetries = 3
}: {
  accessToken: string;
  boardId: string;
  columnMapping: MondayColumnMapping;
  rows: RecipeRow[];
  keyColumn?: string;
  keyColumnId?: string;
  itemNameField?: string;
  batchSize?: number;
  delayMs?: number;
  maxRetries?: number;
}): Promise<{
  totalSuccess: number;
  totalFailed: number;
  results: Array<{ itemId?: string; ok: boolean; attempts: number; error?: string }>;
}> {
  if (batchSize <= 0) {
    throw new Error("batchSize must be greater than zero.");
  }

  const results: Array<{ itemId?: string; ok: boolean; attempts: number; error?: string }> = [];
  let totalSuccess = 0;
  let totalFailed = 0;
  const totalBatches = Math.ceil(rows.length / batchSize) || 1;

  logger.info("Starting batch-safe monday upsert", { boardId, totalBatches, batchSize });

  for (let i = 0; i < rows.length; i += batchSize) {
    const batchNumber = Math.floor(i / batchSize) + 1;
    const slice = rows.slice(i, i + batchSize);

    logger.info("Processing monday batch", { boardId, batchNumber, batchSize: slice.length });

    const batchResults = await Promise.all(
      slice.map(async (row) => {
        const candidateItemId =
          typeof row.item_id === "string" ? row.item_id : undefined;
        let attempt = 0;
        let lastError: string | undefined;

        while (attempt < maxRetries) {
          attempt += 1;
          try {
            await upsertRowsToBoard({
              accessToken,
              boardId,
              columnMapping,
              rows: [row],
              keyColumn,
              keyColumnId,
              itemNameField
            });

            return { itemId: candidateItemId, ok: true, attempts: attempt };
          } catch (error) {
            const message =
              error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
            lastError = message;
            const normalized = message.toLowerCase();
            const isRateLimit = normalized.includes("429") || normalized.includes("rate");
            const isServerError =
              normalized.includes("500") ||
              normalized.includes("502") ||
              normalized.includes("503") ||
              normalized.includes("504");

            if ((isRateLimit || isServerError) && attempt < maxRetries) {
              const backoff = delayMs * Math.pow(2, attempt - 1);
              logger.warn("Retrying monday upsert", {
                boardId,
                attempt,
                maxRetries,
                waitMs: Math.round(backoff),
                message
              });
              await sleep(backoff);
              continue;
            }

            logger.error("Permanent monday write-back failure", {
              boardId,
              attempt,
              message
            });
            return { itemId: candidateItemId, ok: false, attempts: attempt, error: message };
          }
        }

        const fallbackError = lastError ?? "Exceeded retry attempts for monday write-back.";
        logger.error("Exceeded retry attempts for monday upsert", {
          boardId,
          attempts: attempt,
          error: fallbackError
        });
        return { itemId: candidateItemId, ok: false, attempts: attempt, error: fallbackError };
      })
    );

    for (const result of batchResults) {
      if (result.ok) {
        totalSuccess += 1;
      } else {
        totalFailed += 1;
      }
      results.push(result);
    }

    if (i + batchSize < rows.length) {
      await sleep(delayMs);
    }
  }

  logger.info("Completed monday upsert batches", {
    boardId,
    totalBatches,
    totalSuccess,
    totalFailed
  });

  return { totalSuccess, totalFailed, results };
}

export async function fetchBoards(accessToken: string, limit = 50): Promise<MondayBoardSummary[]> {
  const client = getApiClient({ accessToken });
  const data = await client<{
    boards: Array<{
      id: string;
      name: string;
      board_kind?: string | null;
      workspace?: { name?: string | null } | null;
    }>;
  }>({
    query: `
      query ListBoards($limit: Int!) {
        boards(limit: $limit) {
          id
          name
          board_kind
          workspace {
            name
          }
        }
      }
    `,
    variables: {
      limit
    }
  });

  return (data.boards ?? []).map((board) => ({
    id: board.id,
    name: board.name,
    workspaceName: board.workspace?.name ?? null,
    kind: board.board_kind ?? null
  }));
}

export async function fetchBoardData(
  accessToken: string,
  boardId: string,
  itemLimit = 500
): Promise<MondayBoardData> {
  const client = getApiClient({ accessToken });
  const data = await client<{
    boards: Array<{
      id: string;
      name: string;
      columns: Column[];
      items_page: {
        cursor: string | null;
        items: Item[];
      };
    }>;
  }>({
    query: `
      query BoardData($boardId: [ID!], $limit: Int!) {
        boards(ids: $boardId) {
          id
          name
          columns {
            id
            title
            type
          }
          items_page(limit: $limit) {
            cursor
            items {
              id
              name
              column_values {
                id
                text
              }
            }
          }
        }
      }
    `,
    variables: {
      boardId: [boardId],
      limit: itemLimit
    }
  });

  const board = data.boards?.[0];
  if (!board) {
    throw new Error(`Board ${boardId} not found or inaccessible`);
  }

  return {
    boardId: board.id,
    boardName: board.name,
    columns: board.columns ?? [],
    items: board.items_page?.items ?? []
  };
}

export async function ensureBoardColumnsForRecipe({
  accessToken,
  boardId,
  recipe,
  boardData,
  client: providedClient
}: {
  accessToken: string;
  boardId: string;
  recipe: RecipeDefinition;
  boardData?: MondayBoardData;
  client?: ReturnType<typeof getApiClient>;
}): Promise<MondayBoardData> {
  const client = providedClient ?? getApiClient({ accessToken });
  let currentBoard = boardData ?? (await fetchBoardData(accessToken, boardId));

  const desiredFields = collectRecipeFields(recipe);
  const existingColumns = new Set(
    currentBoard.columns
      .map((column) => normalizeColumnKey(column.title))
      .filter((value) => value.length > 0)
  );

  const createdColumns: Column[] = [];
  for (const field of desiredFields) {
    const normalizedField = normalizeColumnKey(field);
    if (!normalizedField || NORMALIZED_NAME_SKIP.has(normalizedField)) {
      continue;
    }
    if (existingColumns.has(normalizedField)) {
      continue;
    }

    const title = toColumnTitle(field);
    const columnType = inferColumnType(field);

    try {
      const result = await client<{
        create_column: { id: string; title?: string | null; type?: string | null };
      }>({
        query: `
          mutation CreateColumn($boardId: ID!, $title: String!, $columnType: ColumnType!) {
            create_column(board_id: $boardId, title: $title, column_type: $columnType) {
              id
              title
              type
            }
          }
        `,
        variables: {
          boardId,
          title,
          columnType
        }
      });

      const createdColumn = result.create_column;
      if (createdColumn?.id) {
        const normalizedCreated = normalizeColumnKey(createdColumn.title ?? title);
        if (normalizedCreated) {
          existingColumns.add(normalizedCreated);
        }
        createdColumns.push({
          id: createdColumn.id,
          title: createdColumn.title ?? title,
          type: createdColumn.type ?? columnType
        });
        logger.debug("Created monday column", {
          boardId,
          columnId: createdColumn.id,
          title: createdColumn.title ?? title,
          type: createdColumn.type ?? columnType
        });
      }
    } catch (error) {
      logger.warn("Failed to create monday column", {
        boardId,
        field,
        error: (error as Error).message
      });
    }
  }

  if (createdColumns.length > 0) {
    currentBoard = await fetchBoardData(accessToken, boardId);
  }

  return currentBoard;
}

export function boardItemsToRows(board: MondayBoardData): RecipeRow[] {
  const columnsById = new Map(board.columns.map((column) => [column.id, column.title]));
  return board.items.map((item) => {
    const row: RecipeRow = {
      item_id: item.id,
      item_name: item.name
    };
    for (const columnValue of item.column_values ?? []) {
      const title = columnsById.get(columnValue.id);
      if (!title) {
        continue;
      }
      row[title] = columnValue.text ?? "";
    }
    return row;
  });
}

export async function createBoardForRecipe({
  accessToken,
  recipe,
  boardName,
  boardKind = "share",
  workspaceId,
  extraColumns
}: {
  accessToken: string;
  recipe: RecipeDefinition;
  boardName: string;
  boardKind?: MondayBoardKind;
  workspaceId?: number | string;
  extraColumns?: string[];
}): Promise<{ boardData: MondayBoardData; summary: BoardCreationSummary }> {
  const client = getApiClient({ accessToken });
  const variables: {
    boardName: string;
    boardKind: MondayBoardKind;
    workspaceId?: string | null;
  } = {
    boardName,
    boardKind,
    workspaceId:
      typeof workspaceId === "number" && Number.isFinite(workspaceId)
        ? String(workspaceId)
        : typeof workspaceId === "string" && workspaceId.trim().length > 0
          ? workspaceId.trim()
          : null
  };

  const created = await client<{
    create_board: {
      id: string;
      name: string;
      board_kind?: string | null;
      workspace?: { id?: string | null; name?: string | null } | null;
    };
  }>({
    query: `
      mutation CreateBoard($boardName: String!, $boardKind: BoardKind!, $workspaceId: ID) {
        create_board(board_name: $boardName, board_kind: $boardKind, workspace_id: $workspaceId) {
          id
          name
          board_kind
          workspace {
            id
            name
          }
        }
      }
    `,
    variables
  });

  const board = created.create_board;
  if (!board?.id) {
    throw new Error("Failed to create monday board.");
  }

  logger.info("Created monday board", {
    boardId: board.id,
    boardKind,
    workspaceId: variables.workspaceId ?? undefined
  });

  let boardData = await fetchBoardData(accessToken, board.id);
  // If extraColumns provided (CSV headers), ensure these columns exist too
  if (extraColumns && Array.isArray(extraColumns) && extraColumns.length > 0) {
    // Build a synthetic recipe that includes these fields as desired fields
    const syntheticRecipe = JSON.parse(JSON.stringify(recipe)) as RecipeDefinition;
    // Inject a write_back columnMapping so ensureBoardColumnsForRecipe will create columns
    const writeStep = syntheticRecipe.steps.find((s): s is WriteBackStep => s.type === "write_back");
    if (writeStep) {
      writeStep.config.columnMapping = {
        ...(writeStep.config.columnMapping ?? {}),
      };
      for (const col of extraColumns) {
        if (col && typeof col === "string") {
          writeStep.config.columnMapping[col] = col;
        }
      }
    }
    boardData = await ensureBoardColumnsForRecipe({ accessToken, boardId: board.id, recipe: syntheticRecipe, boardData, client });
  } else {
    boardData = await ensureBoardColumnsForRecipe({
      accessToken,
      boardId: board.id,
      recipe,
      boardData,
      client
    });
  }

  return {
    boardData,
    summary: {
      id: board.id,
      name: board.name,
      kind: board.board_kind ?? null,
      workspaceName: board.workspace?.name ?? null,
      workspaceId: board.workspace?.id ?? null
    }
  };
}

export async function upsertRowsToBoard({
  accessToken,
  boardId,
  columnMapping,
  rows,
  keyColumn,
  keyColumnId,
  itemNameField
}: {
  accessToken: string;
  boardId: string;
  columnMapping: MondayColumnMapping;
  rows: RecipeRow[];
  keyColumn?: string;
  keyColumnId?: string;
  itemNameField?: string;
}): Promise<void> {
  const client = getApiClient({ accessToken });
  const boardData = await fetchBoardData(accessToken, boardId);
  logger.info("Starting upsertRowsToBoard", { boardId, incomingRows: rows.length });
  const columnsById = new Map(boardData.columns.map((column) => [column.id, column]));
  const columnsByName = new Map(
    boardData.columns.map((column) => [normalizeColumnKey(column.title), column])
  );
  const resolveColumn = (identifier: string | undefined): Column | undefined => {
    if (!identifier) {
      return undefined;
    }
    const direct = columnsById.get(identifier);
    if (direct) {
      return direct;
    }
    const normalized = normalizeColumnKey(identifier);
    return columnsByName.get(normalized);
  };

  const resolvedMapping = new Map<string, Column>();
  for (const [field, target] of Object.entries(columnMapping)) {
    const column = resolveColumn(target);
    if (!column) {
      logger.warn("Unknown monday column mapping", { boardId, field, target });
      continue;
    }
    resolvedMapping.set(field, column);
  }

  if (resolvedMapping.size === 0) {
    throw new Error("No valid monday column mappings were resolved for write-back.");
  }

  const resolvedKeyColumn = resolveColumn(
    keyColumnId ?? (keyColumn ? columnMapping[keyColumn] : undefined)
  );
  const keyMap = new Map<string, string>();
  if (keyColumn && resolvedKeyColumn) {
    for (const item of boardData.items) {
      const keyValue = item.column_values?.find((value) => value.id === resolvedKeyColumn.id)?.text;
      if (keyValue) {
        keyMap.set(keyValue.trim().toLowerCase(), item.id);
      }
    }
  }

  for (const row of rows) {
    const columnValues: Record<string, unknown> = {};
    for (const [field, column] of resolvedMapping) {
      const value = row[field];
      const formatted = formatColumnValue(value, column.type);
      if (formatted === null) {
        continue;
      }
      columnValues[column.id] = formatted;
    }

    if (keyColumn && resolvedKeyColumn && columnValues[resolvedKeyColumn.id] === undefined) {
      const keyValueRaw = row[keyColumn];
      const keyValue = typeof keyValueRaw === "string" ? keyValueRaw.trim() : keyValueRaw;
      if (keyValue !== undefined && keyValue !== null && String(keyValue).trim().length > 0) {
        columnValues[resolvedKeyColumn.id] = { text: String(keyValue).trim() };
      }
    }

    if (Object.keys(columnValues).length === 0) {
      logger.warn("Skipping monday write-back row with no mapped values", {
        boardId,
        keyColumn,
        keyValue: keyColumn ? row[keyColumn] : undefined,
        row
      });
      continue;
    }

    const columnValuesJson = JSON.stringify(columnValues);

    const keyValue = keyColumn ? String(row[keyColumn] ?? "").trim() : "";
    const normalizedKey = keyValue.toLowerCase();
    const existingItemId = normalizedKey ? keyMap.get(normalizedKey) : undefined;
    const itemName =
      (itemNameField && row[itemNameField]
        ? String(row[itemNameField]).trim()
        : undefined) ||
      keyValue ||
      "Standardized row";

    if (existingItemId) {
      const query = `
          mutation UpdateItem($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
            change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $columnValues) {
              id
            }
          }
        `;
      const variables = {
        boardId,
        itemId: existingItemId,
        columnValues: columnValuesJson
      };
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "info",
          msg: "Monday mutation payload",
          payload: { query, variables }
        })
      );
      try {
        await client({
          query,
          variables
        });
      } catch (error) {
        const status = (error as { response?: { status?: number } })?.response?.status ?? "unknown";
        const message = error instanceof Error ? error.message : String(error);
        logger.error("monday.com API request failed (update)", {
          boardId,
          itemId: existingItemId,
          status,
          message
        });
        throw error;
      }
      logger.debug("Updated monday item", { boardId, itemId: existingItemId });
      continue;
    }

    const createQuery = `
      mutation CreateItem($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
        create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues) {
          id
        }
      }
    `;
    const createVariables = {
      boardId,
      itemName,
      columnValues: columnValuesJson
    };
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        msg: "Monday mutation payload",
        payload: { query: createQuery, variables: createVariables }
      })
    );
    let createResult: { create_item: { id: string } } | null = null;
    try {
      createResult = await client<{
        create_item: { id: string };
      }>({
        query: createQuery,
        variables: createVariables
      });
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response?.status ?? "unknown";
      const message = error instanceof Error ? error.message : String(error);
      logger.error("monday.com API request failed (create)", {
        boardId,
        status,
        message
      });
      throw error;
    }

    if (normalizedKey && createResult.create_item?.id) {
      keyMap.set(normalizedKey, createResult.create_item.id);
    }
  }
  logger.info("Completed upsertRowsToBoard", { boardId });
}
