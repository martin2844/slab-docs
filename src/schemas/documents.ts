import { z } from "zod";
import { normalizeTags } from "../utils/tags.js";

export const documentIdSchema = z.uuid("Document id must be a UUID.");
export const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must use lowercase letters, numbers, and hyphens.");

const titleSchema = z.string().trim().min(1).max(200);
const bodySchema = z.string().max(2_000_000);
const authorSchema = z.string().trim().min(1).max(100);
const tagSchema = z.string().trim().min(1).max(64);
const tagsSchema = z.array(tagSchema).max(50).transform(normalizeTags);

export const createDocumentSchema = z
  .object({
    title: titleSchema,
    slug: slugSchema.optional(),
    body: bodySchema,
    parent_id: documentIdSchema.nullable().optional(),
    tags: tagsSchema.default([]),
    author: authorSchema.optional()
  })
  .strict();

export const updateDocumentSchema = z
  .object({
    title: titleSchema.optional(),
    body: bodySchema.optional(),
    parent_id: documentIdSchema.nullable().optional(),
    tags: tagsSchema.optional(),
    author: authorSchema.optional()
  })
  .strict()
  .refine(
    ({ title, body, parent_id, tags }) =>
      title !== undefined || body !== undefined || parent_id !== undefined || tags !== undefined,
    { message: "At least one document field must be provided." }
  );

const archivedQuerySchema = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((value) => value === true || value === "true");

export const listDocumentsSchema = z
  .object({
    parent_id: documentIdSchema.nullable().optional(),
    tag: tagSchema.optional(),
    archived: z.boolean().default(false),
    search: z.string().trim().min(1).max(500).optional(),
    limit: z.number().int().min(1).max(100).default(50),
    offset: z.number().int().min(0).default(0)
  })
  .strict();

export const listDocumentsQuerySchema = z
  .object({
    parent_id: documentIdSchema.optional(),
    tag: tagSchema.optional(),
    archived: archivedQuerySchema.default(false),
    search: z.string().trim().min(1).max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0)
  })
  .strict();

export const searchDocumentsSchema = z
  .object({
    query: z.string().trim().min(1).max(500),
    limit: z.number().int().min(1).max(50).default(20)
  })
  .strict();

export const searchDocumentsQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(500),
    limit: z.coerce.number().int().min(1).max(50).default(20)
  })
  .strict();

export const revisionNumberSchema = z.coerce.number().int().min(1);

export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;
export type UpdateDocumentInput = z.infer<typeof updateDocumentSchema>;
export type ListDocumentsInput = z.infer<typeof listDocumentsSchema>;
export type SearchDocumentsInput = z.infer<typeof searchDocumentsSchema>;
