import { NextRequest, NextResponse } from "next/server";
import { checkGithubRepoCredentials, normalizeOptions } from "@/lib/checker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const report = await checkGithubRepoCredentials(
      {
        repoUrl: String(payload.repoUrl || ""),
        githubToken: String(payload.githubToken || ""),
        branch: String(payload.branch || "master"),
        authSubdir: String(payload.authSubdir || "auths")
      },
      normalizeOptions({
        codexModel: String(payload.codexModel || "gpt-5"),
        codexUsageLimitOnly: Boolean(payload.codexUsageLimitOnly),
        timeoutSeconds: Number(payload.timeoutSeconds || 35),
        workers: Number(payload.workers || 200)
      })
    );

    return NextResponse.json(report, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "仓库检查失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
