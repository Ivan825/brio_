CREATE TABLE "score_contributors" (
	"agent_key" text NOT NULL,
	"task_type" text NOT NULL,
	"contributor" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "score_contributors_agent_key_task_type_contributor_pk" PRIMARY KEY("agent_key","task_type","contributor")
);
