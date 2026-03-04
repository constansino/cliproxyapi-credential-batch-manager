import { NextRequest, NextResponse } from "next/server";
import { cleanupArchiveCredentials } from "@/lib/checker";
import { CleanupResultRef, ProviderScope } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function parseDeleteStatuses(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
    )
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const formData = await request.formData();
    const archive = formData.get("archive");
    if (!(archive instanceof File)) {
      return NextResponse.json({ error: "缺少 archive 文件" }, { status: 400 });
    }

    const deleteStatuses = parseDeleteStatuses(String(formData.get("deleteStatuses") || ""));
    if (deleteStatuses.length === 0) {
      return NextResponse.json({ error: "deleteStatuses 不能为空" }, { status: 400 });
    }

    const providerScopeRaw = String(formData.get("providerScope") || "all").toLowerCase();
    const providerScope: ProviderScope = providerScopeRaw === "codex" ? "codex" : "all";

    const refsRaw = String(formData.get("resultRefs") || "[]");
    const parsedRefs = JSON.parse(refsRaw) as unknown;
    if (!Array.isArray(parsedRefs)) {
      return NextResponse.json({ error: "resultRefs 必须是数组" }, { status: 400 });
    }

    const resultRefs: CleanupResultRef[] = parsedRefs.map((item) => {
      const entry = item as Record<string, unknown>;
      return {
        path: String(entry.path || ""),
        status: String(entry.status || ""),
        provider: String(entry.provider || "")
      };
    });

    const { zipBuffer, deletedPaths } = await cleanupArchiveCredentials(
      await archive.arrayBuffer(),
      deleteStatuses,
      resultRefs,
      providerScope
    );

    return new NextResponse(new Uint8Array(zipBuffer), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="auths.cleaned.${Date.now()}.zip"`,
        "X-Deleted-Count": String(deletedPaths.length),
        "X-Deleted-Preview": deletedPaths.slice(0, 20).join(",")
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "清理失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
