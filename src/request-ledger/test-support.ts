// 테스트에서만 쓰는 도우미다. 모듈의 공개 계약이 아니다.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

/** 저장소 밖에 임시 폴더를 만들고, 테스트가 끝나면 지운다. */
export function makeTempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-butler-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 파일이나 폴더의 권한 비트만 돌려준다. */
export function permissionBits(mode: number): number {
  return mode & 0o777;
}

/** concurrency-writer.ts의 hold 모드가 쓰는 요청의 id. 테스트가 이 행이 보이는지를 확인한다. */
export const HELD_REQUEST_ID = "req-held";
