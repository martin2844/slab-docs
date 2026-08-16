import { openDatabase } from "../../src/db/database.js";
import { DocumentService } from "../../src/services/document-service.js";

function deterministicUuid(sequence: number): string {
  return `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`;
}

export function createTestContext() {
  const database = openDatabase(":memory:");
  let idSequence = 0;
  let timeSequence = 0;
  const service = new DocumentService(database, {
    id: () => deterministicUuid(++idSequence),
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, timeSequence++)).toISOString()
  });

  return { database, service };
}
