import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, uniqueIndex, uuid, vector } from "drizzle-orm/pg-core";
import { deletedAt, id, timestamps } from "./columns";
import { memoryEdgeKind, memoryNodeKind, projectKind } from "./enums";
import { vaultSecrets } from "./governance";
import { runners, workspaces } from "./tenancy";

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
    /** A git token for the repository (in the vault): the runner fetches and pushes with it; nothing else sees it. */
    credentialRef: uuid().references(() => vaultSecrets.id),
    /** The local runner whose machine holds the repository (M8): its path is on that machine; work on it runs there. */
    runnerId: uuid().references(() => runners.id),
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
    /** What the node stands for (task:<id>, file:<path>, prompt:<attempt>, agent:<id>, contract:…): one node each. */
    ref: text(),
    ...timestamps(),
  },
  (t) => [
    index().on(t.projectId, t.kind),
    uniqueIndex().on(t.projectId, t.ref).where(sql`${t.ref} is not null`),
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
  (t) => [index().on(t.fromId), index().on(t.toId), uniqueIndex().on(t.fromId, t.toId, t.kind)],
);
