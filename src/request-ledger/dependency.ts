// 먼저 끝나야 하는 작업(선후 관계). 같은 요청 안에서만 정한다.
import type { WriteScope } from "./changes.ts";
import { LedgerError } from "./errors.ts";
import { existingTask } from "./lookup.ts";

/** 그 작업이 기다리는 작업들. 더한 순서대로다. */
export function dependenciesOf(scope: WriteScope, taskId: string): string[] {
  return scope
    .all("SELECT depends_on FROM task_dependencies WHERE task_id = ? ORDER BY rowid", taskId)
    .map((row) => String(row.depends_on));
}

/**
 * 선후 관계로 정할 수 있는지 확인한다. 먼저 끝나야 하는 작업은 같은 요청의 작업이어야 하고,
 * 작업이 자기 자신을 기다리거나 선후 관계를 따라가면 자기에게 돌아오게 되면 거부한다.
 * `taskId`는 기다리는 작업이고, 새로 더하는 작업이면 null이다.
 */
export function assertDependencies(
  scope: WriteScope,
  requestId: string,
  taskId: string | null,
  dependsOn: readonly string[],
): void {
  for (const dependency of dependsOn) {
    if (dependency === taskId) {
      throw new LedgerError("invalid_dependency", "작업이 자기 자신을 기다릴 수 없다");
    }
    if (existingTask(scope, dependency).request_id !== requestId) {
      throw new LedgerError(
        "invalid_dependency",
        `먼저 끝나야 하는 작업은 같은 요청 안에서만 정한다 (${dependency})`,
      );
    }
  }
  if (taskId === null) {
    return;
  }
  // 먼저 끝나야 하는 작업에서 선후 관계를 따라가 이 작업에 닿으면, 이 쓰기로 자기에게 돌아오게 된다.
  const seen = new Set<string>();
  const pending = [...dependsOn];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (next === taskId) {
      throw new LedgerError(
        "invalid_dependency",
        "선후 관계를 따라가면 자기에게 돌아오게 되는 쓰기는 받지 않는다",
      );
    }
    if (!seen.has(next)) {
      seen.add(next);
      pending.push(...dependenciesOf(scope, next));
    }
  }
}

/** 그 작업이 기다리는 작업들을 주어진 것으로 바꾼다. */
export function replaceDependencies(
  scope: WriteScope,
  taskId: string,
  dependsOn: readonly string[],
): void {
  scope.run("DELETE FROM task_dependencies WHERE task_id = ?", taskId);
  for (const dependency of dependsOn) {
    scope.run(
      "INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)",
      taskId,
      dependency,
    );
  }
}
