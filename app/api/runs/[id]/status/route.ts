import { NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/db";

type Params = {
  params: {
    id: string;
  };
};

export async function GET(_: Request, { params }: Params) {
  const supabase = getServiceSupabase();
  const { data } = await supabase
    .from("runs")
    .select("id, status, rows_in, rows_out, errors, preview, started_at, finished_at")
    .eq("id", params.id)
    .maybeSingle();

  if (!data) {
    return new NextResponse("Run not found", { status: 404 });
  }

  return NextResponse.json(data);
}
