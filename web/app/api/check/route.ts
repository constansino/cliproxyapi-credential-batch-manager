import { NextRequest, NextResponse } from "next/server";
import { checkArchiveCredentials, normalizeOptions } from "@/lib/checker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const formData = await request.formData();
    const archive = formData.get("archive");
    if (!(archive instanceof File)) {
      return NextResponse.json({ error: "缺少 archive 文件" }, { status: 400 });
    }

    const options = normalizeOptions({
      codexModel: String(formData.get("codexModel") || "gpt-5"),
      codexUsageLimitOnly: String(formData.get("codexUsageLimitOnly") || "").toLowerCase() === "true",
      timeoutSeconds: Number(formData.get("timeoutSeconds") || 35),
      workers: Number(formData.get("workers") || 120)
    });

    const report = await checkArchiveCredentials(await archive.arrayBuffer(), options);
    return NextResponse.json(report, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "检查失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
