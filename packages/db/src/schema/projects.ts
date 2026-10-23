import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, uuid, vector } from "drizzle-orm/pg-core";
import { deletedAt, id, timestamps } from "./columns";
import { memoryEdgeKind, memoryNodeKind, projectKind } from "./enums";
import { workspaces } from "./tenancy";

export const EMBEDDING_DIMENSIONS = 1536;

export const projects = pgTable(
  "projects",
  {
    id: id(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id),
    name: text().notNull(),
    kind: projectKind().notNull(),
    repoUrl: text(),
    defaultBranch: text(),
    settings: jsonb().$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    ...timestamps(),
    deletedAt: deletedAt(),
  },
  (t) => [index().on(t.workspaceId)],
);

export const memoryNodes = pgTable(
  "memory_nodes",
  {
    id: id(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id),
    projectId: uuid()
      .notNull()
      .references(() => projects.id),
    kind: memoryNodeKind().notNull(),
    title: text().notNull(),
    body: text().notNull().default(""),
    embedding: vector({ dimensions: EMBEDDING_DIMENSIONS }),
    sourceEventId: uuid(),
    ...timestamps(),
  },
  (t) => [
    index().on(t.projectId, t.kind),
    index("memory_nodes_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

export const memoryEdges = pgTable(
  "memory_edges",
  {
    id: id(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id),
    fromId: uuid()
      .notNull()
      .references(() => memoryNodes.id, { onDelete: "cascade" }),
    toId: uuid()
      .notNull()
      .references(() => memoryNodes.id, { onDelete: "cascade" }),
    kind: memoryEdgeKind().notNull(),
    ...timestamps(),
  },
  (t) => [index().on(t.fromId), index().on(t.toId)],
);
