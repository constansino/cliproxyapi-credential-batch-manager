import { NextRequest, NextResponse } from "next/server";
import { deleteCredentialsFromGithubRepo } from "@/lib/checker";
import { CleanupResultRef, ProviderScope } from "@/lib/types";

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
    const payload = (await request.json()) as Record<string, unknown>;
    const deleteStatuses = parseStatuses(String(payload.deleteStatuses || ""));
    if (deleteStatuses.length === 0) {
      return NextResponse.json({ error: "deleteStatuses 不能为空" }, { status: 400 });
    }

    const providerScopeRaw = String(payload.providerScope || "all").toLowerCase();
    const providerScope: ProviderScope = providerScopeRaw === "codex" ? "codex" : "all";

    const refsRaw = payload.resultRefs;
    if (!Array.isArray(refsRaw)) {
      return NextResponse.json({ error: "resultRefs 必须是数组" }, { status: 400 });
    }

    const resultRefs: CleanupResultRef[] = refsRaw.map((item) => {
      const entry = item as Record<string, unknown>;
      return {
        source: String(entry.source || ""),
        origin: String(entry.origin || "upload").toLowerCase() === "repo" ? "repo" : "upload",
        path: String(entry.path || ""),
        status: String(entry.status || ""),
        provider: String(entry.provider || "")
      };
    });

    const result = await deleteCredentialsFromGithubRepo(resultRefs, deleteStatuses, providerScope, {
      repoUrl: String(payload.repoUrl || ""),
      githubToken: String(payload.githubToken || ""),
      branch: String(payload.branch || "master"),
      authSubdir: String(payload.authSubdir || "auths")
    });

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "仓库删除失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
