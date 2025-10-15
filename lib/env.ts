import { z } from "zod";

const optionalBooleanString = z
  .union([z.literal("true"), z.literal("false"), z.literal("1"), z.literal("0")])
  .optional()
  .transform((value) => (value ? value === "true" || value === "1" : false));

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    APP_BASE_URL: z.string().url(),
    MONDAY_CLIENT_ID: z.string().min(1, "MONDAY_CLIENT_ID is required"),
    MONDAY_CLIENT_SECRET: z.string().min(1, "MONDAY_CLIENT_SECRET is required"),
    MONDAY_SIGNING_SECRET: z.string().min(1, "MONDAY_SIGNING_SECRET is required"),
    MONDAY_DEFAULT_SCOPES: z.string().min(1, "MONDAY_DEFAULT_SCOPES is required"),
    MONDAY_FORCE_INSTALL_IF_NEEDED: z
      .enum(["true", "false"])
      .optional()
      .default("false")
      .transform((value) => value === "true"),
    NEXT_PUBLIC_MONDAY_REDIRECT_URI: z.string().url(),
    SUPABASE_URL: z.string().url(),
    SUPABASE_ANON_KEY: z.string().min(1, "SUPABASE_ANON_KEY is required"),
    SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
    ENABLE_SUPABASE_STUB: optionalBooleanString,
    DEBUG_MONDAY_OAUTH: optionalBooleanString
  })
  .superRefine((values, ctx) => {
    const expectedRedirect = `${values.APP_BASE_URL.replace(/\/$/, "")}/api/monday/oauth/callback`;
    if (values.NEXT_PUBLIC_MONDAY_REDIRECT_URI.replace(/\/$/, "") !== expectedRedirect) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["NEXT_PUBLIC_MONDAY_REDIRECT_URI"],
        message: "NEXT_PUBLIC_MONDAY_REDIRECT_URI must match APP_BASE_URL + '/api/monday/oauth/callback'"
      });
    }
  });

type RawEnv = z.infer<typeof envSchema>;

type AppEnv = {
  nodeEnv: RawEnv["NODE_ENV"];
  app: {
    baseUrl: RawEnv["APP_BASE_URL"];
  };
  monday: {
    clientId: RawEnv["MONDAY_CLIENT_ID"];
    clientSecret: RawEnv["MONDAY_CLIENT_SECRET"];
    signingSecret: RawEnv["MONDAY_SIGNING_SECRET"];
    defaultScopes: RawEnv["MONDAY_DEFAULT_SCOPES"];
    forceInstall: boolean;
  };
  supabase: {
    url: RawEnv["SUPABASE_URL"];
    anonKey: RawEnv["SUPABASE_ANON_KEY"];
    serviceRoleKey?: RawEnv["SUPABASE_SERVICE_ROLE_KEY"];
    enableStub: boolean;
  };
  public: {
    mondayRedirectUri: RawEnv["NEXT_PUBLIC_MONDAY_REDIRECT_URI"];
  };
  debug: {
    mondayOAuth: boolean;
  };
};

let cachedEnv: AppEnv | null = null;

export function loadEnv(): AppEnv {
  if (cachedEnv) {
    return cachedEnv;
  }

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(", ");
    throw new Error(`Environment validation failed: ${issues}`);
  }

  const raw = parsed.data;
  cachedEnv = {
    nodeEnv: raw.NODE_ENV,
    app: {
      baseUrl: raw.APP_BASE_URL
    },
    monday: {
      clientId: raw.MONDAY_CLIENT_ID,
      clientSecret: raw.MONDAY_CLIENT_SECRET,
      signingSecret: raw.MONDAY_SIGNING_SECRET,
      defaultScopes: raw.MONDAY_DEFAULT_SCOPES,
      forceInstall: raw.MONDAY_FORCE_INSTALL_IF_NEEDED
    },
    supabase: {
      url: raw.SUPABASE_URL,
      anonKey: raw.SUPABASE_ANON_KEY,
      serviceRoleKey: raw.SUPABASE_SERVICE_ROLE_KEY,
      enableStub: raw.ENABLE_SUPABASE_STUB
    },
    public: {
      mondayRedirectUri: raw.NEXT_PUBLIC_MONDAY_REDIRECT_URI
    },
    debug: {
      mondayOAuth: raw.DEBUG_MONDAY_OAUTH
    }
  };

  return cachedEnv;
}

export function env(): AppEnv {
  return loadEnv();
}
