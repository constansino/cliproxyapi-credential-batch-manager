import { NextRequest, NextResponse } from "next/server";
import { importCredentialsToGithubRepo } from "@/lib/checker";
import { ArchiveInput, CleanupResultRef, ProviderScope } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function parseStatuses(raw: string): string[] {
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
    const archiveFiles = formData
      .getAll("archives")
      .filter((item): item is File => item instanceof File);
    if (archiveFiles.length === 0) {
      return NextResponse.json({ error: "导入需要上传至少一个 zip" }, { status: 400 });
    }

    const importStatuses = parseStatuses(String(formData.get("importStatuses") || ""));
    if (importStatuses.length === 0) {
      return NextResponse.json({ error: "importStatuses 不能为空" }, { status: 400 });
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
        source: String(entry.source || ""),
        origin: String(entry.origin || "upload").toLowerCase() === "repo" ? "repo" : "upload",
        path: String(entry.path || ""),
        status: String(entry.status || ""),
        provider: String(entry.provider || "")
      };
    });

    const archives: ArchiveInput[] = await Promise.all(
      archiveFiles.map(async (file) => ({
        name: file.name || "auths.zip",
        arrayBuffer: await file.arrayBuffer()
      }))
    );

    const result = await importCredentialsToGithubRepo(
      archives,
      resultRefs,
      importStatuses,
      providerScope,
      {
        repoUrl: String(formData.get("repoUrl") || ""),
        githubToken: String(formData.get("githubToken") || ""),
        branch: String(formData.get("branch") || "master"),
        authSubdir: String(formData.get("authSubdir") || "auths")
      }
    );

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "导入失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
