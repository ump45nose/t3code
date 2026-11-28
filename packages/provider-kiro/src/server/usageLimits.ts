import {
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";

export function kiroUsageWindows(output: string) {
  const match = output.match(/^Credits\s*\([^\n]*\),\s*([\d.]+)%\s*$/im);
  if (!match) return [];
  const percent = Number(match[1]);
  if (!Number.isFinite(percent)) return [];
  const reset = output.match(/^Estimated Usage\s*\|\s*resets on (\d{4}-\d{2}-\d{2})/im)?.[1];
  const resetMs = reset ? Date.parse(`${reset}T00:00:00.000Z`) : NaN;
  return [
    {
      id: "credits-monthly",
      kind: "monthly" as const,
      label: "Credits",
      usedPercent: Math.max(0, Math.min(100, percent)),
      ...(Number.isFinite(resetMs)
        ? { resetsAt: DateTime.formatIso(DateTime.makeUnsafe(resetMs)) }
        : {}),
    },
  ];
}

export function makeKiroUsageProbe(command: string, environment: NodeJS.ProcessEnv) {
  return Effect.fn("KiroUsageLimits.read")(function* (version: string | null) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (!version || parseSemver(version) === null || compareSemverVersions(version, "3.5.0") < 0) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: "Kiro CLI 3.5.0 or newer is required to read usage limits.",
      });
    }
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kiro-usage-" });
        const agents = path.join(cwd, ".kiro", "agents");
        yield* fs.makeDirectory(agents, { recursive: true });
        yield* fs.writeFileString(
          path.join(agents, "t3-quota.json"),
          '{"name":"t3-quota","tools":[],"mcpServers":{},"includeMcpJson":false,"resources":[],"hooks":[]}',
        );
        const args = [
          "chat",
          "--agent-engine",
          "v2",
          "--no-interactive",
          "--trust-tools=",
          "--agent",
          "t3-quota",
          "/usage",
        ];
        const spawn = yield* resolveSpawnCommand(command, args, { env: environment });
        return yield* spawnAndCollect(
          command,
          ChildProcess.make(spawn.command, spawn.args, {
            cwd,
            env: environment,
            shell: spawn.shell,
            stdin: "ignore",
          }),
          { maxStdoutBytes: 65_536 },
        );
      }),
    ).pipe(Effect.timeoutOption("20 seconds"), Effect.option);
    if (result._tag === "None" || result.value._tag === "None" || result.value.value.code !== 0) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Could not read Kiro usage limits.",
      });
    }
    const windows = kiroUsageWindows(result.value.value.stdout);
    if (!windows.length)
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Kiro did not return a recognized credit allowance.",
      });
    return makeUsageLimits({ checkedAt, windows });
  });
}
