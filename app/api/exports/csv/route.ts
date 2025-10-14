import { NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/db";
import { toCsv } from "@/lib/csv";
import type { Database } from "@/types/supabase";

type RunPreviewRecord = Pick<Database["public"]["Tables"]["runs"]["Row"], "preview">;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const runId = searchParams.get("runId");
  if (!runId) {
    return new NextResponse("runId required", { status: 400 });
  }

  const supabase = getServiceSupabase();
  const { data } = await supabase
    .from("runs")
    .select("preview")
    .eq("id", runId)
    .maybeSingle();

  const run = data as RunPreviewRecord | null;
  const previewPayload = (run?.preview ?? null) as
    | {
        rows?: Record<string, unknown>[];
      }
    | null;
  const rows = Array.isArray(previewPayload?.rows) ? previewPayload.rows : null;

  if (!rows) {
    return new NextResponse("Preview data not found", { status: 404 });
  }

  const csv = toCsv(rows);
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="run-${runId}.csv"`
    }
  });
}
