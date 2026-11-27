import type { DatabaseSync } from "node:sqlite";
import { LedgerError } from "./errors.ts";

/** 스키마를 한 버전 올리는 SQL. 목록의 n번째가 버전 n을 만든다. */
export type Migration = {
  readonly name: string;
  readonly sql: string;
};

/**
 * 스키마는 이 목록으로만 만든다. 이미 내보낸 항목은 고치지 않고, 바꿀 것은 뒤에 더한다.
 * 저장된 데이터를 옮겨야 하는 변경은 더하기 전에 먼저 묻는다.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    name: "변경 이력",
    sql: `
      CREATE TABLE changes (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        actor TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        before_value TEXT NOT NULL,
        after_value TEXT NOT NULL,
        evidence TEXT NOT NULL,
        reason TEXT
      ) STRICT;
    `,
  },
  {
    name: "요청",
    sql: `
      CREATE TABLE requests (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
    `,
  },
];

export function schemaVersion(db: DatabaseSync): number {
  return Number(db.prepare("PRAGMA user_version").get()?.user_version);
}

/**
 * 이 코드가 올릴 수 없는 버전의 파일이면 오류를 낸다. 파일은 건드리지 않는다.
 * 높은 버전은 더 새 프로그램이 만든 파일이고, 음수는 이 프로그램이 만든 적 없는 값이다.
 */
export function assertSupportedVersion(db: DatabaseSync, migrations: readonly Migration[]): void {
  const version = schemaVersion(db);
  if (!Number.isInteger(version) || version < 0) {
    throw new LedgerError(
      "schema_version_invalid",
      `원장 파일의 스키마 버전(${version})이 올바르지 않다. 0 이상이어야 한다`,
    );
  }
  if (version > migrations.length) {
    throw new LedgerError(
      "schema_version_too_new",
      `원장 파일의 스키마 버전(${version})이 이 프로그램이 아는 버전(${migrations.length})보다 높다`,
    );
  }
}

/**
 * 낮은 버전이면 밀린 마이그레이션을 순서대로 적용한다.
 * 밀린 것을 한 트랜잭션으로 올려, 도중에 실패하면 버전과 스키마가 그대로 남는다.
 */
export function migrate(db: DatabaseSync, migrations: readonly Migration[]): void {
  assertSupportedVersion(db, migrations);
  if (schemaVersion(db) === migrations.length) {
    return;
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    // 잠금을 기다리는 사이에 다른 프로세스가 올렸을 수 있으므로 잠금을 잡은 뒤 다시 읽는다.
    assertSupportedVersion(db, migrations);
    for (let version = schemaVersion(db) + 1; version <= migrations.length; version += 1) {
      const migration = migrations[version - 1] as Migration;
      try {
        db.exec(migration.sql);
      } catch (error) {
        throw new Error(
          `원장의 스키마를 버전 ${version}(${migration.name})로 올리지 못했다: ${String((error as Error)?.message ?? error)}`,
          { cause: error },
        );
      }
    }
    db.exec(`PRAGMA user_version = ${migrations.length}`);
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) {
      db.exec("ROLLBACK");
    }
    throw error;
  }
}
