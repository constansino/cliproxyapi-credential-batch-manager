import { NextRequest, NextResponse } from "next/server";
import { checkArchiveCredentials, normalizeOptions } from "@/lib/checker";
import { ArchiveInput } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const formData = await request.formData();
    const archiveFiles = formData
      .getAll("archives")
      .filter((item): item is File => item instanceof File);
    if (archiveFiles.length === 0) {
      const legacyArchive = formData.get("archive");
      if (legacyArchive instanceof File) {
        archiveFiles.push(legacyArchive);
      }
    }
    if (archiveFiles.length === 0) {
      return NextResponse.json({ error: "缺少 archive 文件，至少上传一个 zip" }, { status: 400 });
    }

    const options = normalizeOptions({
      codexModel: String(formData.get("codexModel") || "gpt-5"),
      codexUsageLimitOnly: String(formData.get("codexUsageLimitOnly") || "").toLowerCase() === "true",
      timeoutSeconds: Number(formData.get("timeoutSeconds") || 35),
      workers: Number(formData.get("workers") || 200)
    });

    const archives: ArchiveInput[] = await Promise.all(
      archiveFiles.map(async (file) => ({
        name: file.name || "auths.zip",
        arrayBuffer: await file.arrayBuffer()
      }))
    );
    const report = await checkArchiveCredentials(archives, options);
    return NextResponse.json(report, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "检查失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
