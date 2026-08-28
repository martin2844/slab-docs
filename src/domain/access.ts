export const WORKSPACE_COLLECTION_ID = "workspace";

export interface AdminDocumentAccess {
  kind: "admin";
}

export interface ScopedDocumentAccess {
  kind: "scoped";
  subject: string;
  readCollectionIds: readonly string[];
  writeCollectionIds: readonly string[];
}

export type DocumentAccess = AdminDocumentAccess | ScopedDocumentAccess;

export const ADMIN_DOCUMENT_ACCESS: AdminDocumentAccess = { kind: "admin" };

export interface DocumentCollection {
  id: string;
  name: string;
  kind: "workspace" | "source";
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export function canReadCollection(
  access: DocumentAccess,
  collectionId: string,
): boolean {
  return (
    access.kind === "admin" || access.readCollectionIds.includes(collectionId)
  );
}

export function canWriteCollection(
  access: DocumentAccess,
  collectionId: string,
): boolean {
  return (
    access.kind === "admin" || access.writeCollectionIds.includes(collectionId)
  );
}
