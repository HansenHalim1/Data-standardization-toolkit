export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  public: {
    Tables: {
      tenants: {
        Row: {
          id: string;
          monday_account_id: string;
          region: string | null;
          plan: string;
          seats: number;
          updated_at: string | null;
        };
        Insert: {
          id?: string;
          monday_account_id: string;
          region?: string | null;
          plan?: string;
          seats?: number;
          updated_at?: string | null;
        };
        Update: {
          id?: string;
          monday_account_id?: string;
          region?: string | null;
          plan?: string;
          seats?: number;
          updated_at?: string | null;
        };
      };
      entitlements: {
        Row: {
          tenant_id: string;
          plan: string;
          seats: number;
          raw: Json | null;
          updated_at: string | null;
        };
        Insert: {
          tenant_id: string;
          plan?: string;
          seats?: number;
          raw?: Json | null;
          updated_at?: string | null;
        };
        Update: {
          tenant_id?: string;
          plan?: string;
          seats?: number;
          raw?: Json | null;
          updated_at?: string | null;
        };
      };
      monday_oauth_tokens: {
        Row: {
          id: number;
          account_id: number;
          user_id: number;
          access_token: string;
          scopes: string[];
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          id?: number;
          account_id: number;
          user_id: number;
          access_token: string;
          scopes: string[];
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          id?: number;
          account_id?: number;
          user_id?: number;
          access_token?: string;
          scopes?: string[];
          created_at?: string | null;
          updated_at?: string | null;
        };
      };
      recipes: {
        Row: {
          id: string;
          tenant_id: string;
          name: string;
          version: number;
          json: Json;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          name: string;
          version: number;
          json: Json;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          name?: string;
          version?: number;
          json?: Json;
          created_at?: string | null;
          updated_at?: string | null;
        };
      };
      runs: {
        Row: {
          id: string;
          tenant_id: string;
          recipe_id: string;
          recipe_version: number;
          status: "queued" | "previewing" | "running" | "success" | "failed" | "canceled";
          idempotency_key: string | null;
          rows_in: number | null;
          rows_out: number | null;
          errors: Json | null;
          preview: Json | null;
          started_at: string | null;
          finished_at: string | null;
          created_by: string | null;
          updated_at: string | null;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          recipe_id: string;
          recipe_version: number;
          status: "queued" | "previewing" | "running" | "success" | "failed" | "canceled";
          idempotency_key?: string | null;
          rows_in?: number | null;
          rows_out?: number | null;
          errors?: Json | null;
          preview?: Json | null;
          started_at?: string | null;
          finished_at?: string | null;
          created_by?: string | null;
          updated_at?: string | null;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          recipe_id?: string;
          recipe_version?: number;
          status?: "queued" | "previewing" | "running" | "success" | "failed" | "canceled";
          idempotency_key?: string | null;
          rows_in?: number | null;
          rows_out?: number | null;
          errors?: Json | null;
          preview?: Json | null;
          started_at?: string | null;
          finished_at?: string | null;
          created_by?: string | null;
          updated_at?: string | null;
        };
      };
      usage_monthly: {
        Row: {
          tenant_id: string;
          month: string;
          rows_processed: number;
          api_calls: number;
          schedules_run: number;
        };
        Insert: {
          tenant_id: string;
          month: string;
          rows_processed?: number;
          api_calls?: number;
          schedules_run?: number;
        };
        Update: {
          tenant_id?: string;
          month?: string;
          rows_processed?: number;
          api_calls?: number;
          schedules_run?: number;
        };
      };
      audit: {
        Row: {
          id: string;
          tenant_id: string;
          actor: string | null;
          action: string;
          entity: string | null;
          entity_id: string | null;
          diff: Json | null;
          created_at: string | null;
        };
        Insert: {
          id?: string;
          tenant_id: string;
          actor?: string | null;
          action: string;
          entity?: string | null;
          entity_id?: string | null;
          diff?: Json | null;
          created_at?: string | null;
        };
        Update: {
          id?: string;
          tenant_id?: string;
          actor?: string | null;
          action?: string;
          entity?: string | null;
          entity_id?: string | null;
          diff?: Json | null;
          created_at?: string | null;
        };
      };
    };
    Functions: {
      increment_usage: {
        Args: { tenant: string; month: string; rows: number; api?: number; schedules?: number };
        Returns: {
          tenant_id: string;
          month: string;
          rows_processed: number;
          api_calls: number;
          schedules_run: number;
        };
      };
    };
  };
};
