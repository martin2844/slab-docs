export interface Document {
  id: string;
  slug: string;
  title: string;
  body: string;
  parent_id: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface DocumentRevision {
  id: string;
  document_id: string;
  revision: number;
  title: string;
  body: string;
  author: string;
  created_at: string;
}

export interface SearchResult {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  updated_at: string;
  score: number;
}

export type DocumentIdentifier = { id: string; slug?: never } | { id?: never; slug: string };
