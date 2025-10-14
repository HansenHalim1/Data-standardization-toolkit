import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Database } from "@/types/supabase";

type TableName = keyof Database["public"]["Tables"];

type MemoryRow<K extends TableName> = Database["public"]["Tables"][K]["Row"];
type MemoryInsert<K extends TableName> = Database["public"]["Tables"][K]["Insert"];
type MemoryUpdate<K extends TableName> = Database["public"]["Tables"][K]["Update"];

const memoryStore: { [K in TableName]: MemoryRow<K>[] } = {
  tenants: [],
  entitlements: [],
  recipes: [],
  runs: [],
  usage_monthly: [],
  audit: []
};

function createSelectBuilder<K extends TableName>(table: MemoryRow<K>[]) {
  let workingSet = [...table];
  const filters: Array<(row: MemoryRow<K>) => boolean> = [];

  const applyFilters = () => filters.reduce((acc, filter) => acc.filter(filter), workingSet);

  return {
    eq(field: string, value: unknown) {
      filters.push((row) => (row as Record<string, unknown>)[field] === value);
      return this;
    },
    order(field: string, options: { ascending: boolean }) {
      workingSet = [...workingSet].sort((a, b) => {
        const av = (a as Record<string, unknown>)[field];
        const bv = (b as Record<string, unknown>)[field];
        if (av === bv) return 0;
        const direction = options.ascending ? 1 : -1;
        return av! > bv! ? direction : -direction;
      });
      return this;
    },
    limit(count: number) {
      workingSet = workingSet.slice(0, count);
      return this;
    },
    async maybeSingle() {
      const data = applyFilters()[0] ?? null;
      return { data };
    },
    async single() {
      const data = applyFilters()[0];
      if (!data) {
        throw new Error("Record not found");
      }
      return { data };
    }
  };
}

function createUpdateBuilder<K extends TableName>(table: MemoryRow<K>[], values: Partial<MemoryUpdate<K>>) {
  const filters: Array<(row: MemoryRow<K>) => boolean> = [];

  const applyUpdate = () => {
    const updated: MemoryRow<K>[] = [];
    table.forEach((row, index) => {
      if (filters.every((filter) => filter(row))) {
        const merged = { ...row, ...values } as MemoryRow<K>;
        table[index] = merged;
        updated.push(merged);
      }
    });
    return updated;
  };

  return {
    eq(field: string, value: unknown) {
      filters.push((row) => (row as Record<string, unknown>)[field] === value);
      return this;
    },
    async maybeSingle() {
      const updated = applyUpdate();
      return { data: updated[0] ?? null, error: null };
    },
    async then(
      resolve: (value: { data: MemoryRow<K>[]; error: null }) => void,
      reject: (reason?: unknown) => void
    ) {
      try {
        const updated = applyUpdate();
        resolve({ data: updated, error: null });
      } catch (error) {
        reject(error);
      }
    }
  };
}

function createMemoryClient(): SupabaseClient<Database> {
  return {
    from(tableName: string) {
      const table = memoryStore[tableName as TableName] as MemoryRow<TableName>[];
      return {
        select: () => createSelectBuilder(table),
        insert: async (
          records: MemoryInsert<TableName> | MemoryInsert<TableName>[]
        ) => {
          const payload = Array.isArray(records) ? records : [records];
          payload.forEach((record) => {
            table.push(record as MemoryRow<TableName>);
          });
          return { data: payload, error: null };
        },
        upsert: async (
          records: MemoryInsert<TableName> | MemoryInsert<TableName>[],
          options?: { onConflict?: string }
        ) => {
          const payload = Array.isArray(records) ? records : [records];
          payload.forEach((record) => {
            if (options?.onConflict) {
              const matchIndex = table.findIndex(
                (row) =>
                  (row as Record<string, unknown>)[options.onConflict!] ===
                  (record as Record<string, unknown>)[options.onConflict!]
              );
              if (matchIndex >= 0) {
                table[matchIndex] = {
                  ...table[matchIndex],
                  ...record
                } as MemoryRow<TableName>;
                return;
              }
            }
            table.push(record as MemoryRow<TableName>);
          });
          return { data: payload, error: null };
        },
        update: (values: Partial<MemoryUpdate<TableName>>) =>
          createUpdateBuilder(table, values)
      };
    },
    rpc(name: string, args: { tenant: string; month: string; rows: number; api?: number; schedules?: number }) {
      if (name !== "increment_usage") {
        return Promise.resolve({ data: null, error: new Error("Unsupported RPC") });
      }
      const existing = memoryStore.usage_monthly.find(
        (row) => row.tenant_id === args.tenant && row.month === args.month
      );
      if (existing) {
        existing.rows_processed += args.rows;
        existing.api_calls += args.api ?? 0;
        existing.schedules_run += args.schedules ?? 0;
        return Promise.resolve({ data: existing, error: null });
      }
      const record = {
        tenant_id: args.tenant,
        month: args.month,
        rows_processed: args.rows,
        api_calls: args.api ?? 0,
        schedules_run: args.schedules ?? 0
      };
      memoryStore.usage_monthly.push(record);
      return Promise.resolve({ data: record, error: null });
    }
  } as unknown as SupabaseClient<Database>;
}

let serviceClient: SupabaseClient<Database> | null = null;

function assertEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getServiceSupabase(): SupabaseClient<Database> {
  if (serviceClient) {
    return serviceClient;
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    if (process.env.NODE_ENV === "test" || process.env.ENABLE_SUPABASE_STUB === "1") {
      serviceClient = createMemoryClient();
      seedMemoryStore();
      return serviceClient;
    }
    throw new Error("Supabase service role credentials are not configured.");
  }

  serviceClient = createClient<Database>(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    },
    global: {
      headers: {
        "X-Client-Info": "data-standardization-toolkit/0.1.0"
      }
    }
  });

  return serviceClient;
}

export function getAnonSupabase(): SupabaseClient<Database> {
  const url = assertEnv("SUPABASE_URL");
  const key = assertEnv("SUPABASE_ANON_KEY");

  return createClient<Database>(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}

function seedMemoryStore() {
  if (memoryStore.tenants.length > 0) {
    return;
  }
  const tenantId = "11111111-1111-1111-1111-111111111111";
  memoryStore.tenants.push({
    id: tenantId,
    monday_account_id: "demo-account",
    region: "us-east-1",
    plan: "pro",
    seats: 10,
    updated_at: new Date().toISOString()
  });
  memoryStore.entitlements.push({
    tenant_id: tenantId,
    plan: "pro",
    seats: 10,
    raw: { source: "memory" },
    updated_at: new Date().toISOString()
  });
  memoryStore.recipes.push({
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    tenant_id: tenantId,
    name: "CRM Contacts",
    version: 1,
    json: {
      id: "crm",
      name: "CRM Contacts",
      version: 1,
      steps: []
    },
    created_at: new Date().toISOString(),
    updated_at: null
  });
}
