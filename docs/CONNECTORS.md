# Connector Registry (human-readable)

Generated from `registry/connectors.json` on 23 Oct 2026. Interactive version: https://claude.ai/artifact/GbHSRF1dxGym8erCtwvZXK (private to the owner).

Routes: Model API · Headless CLI · SDK · Hosted agent API · A2A · MCP · Browser / UI only · Self-host / local · No official API. Tiers: P0 wire first → P3 later or never.

## Frontier model APIs

The labs whose own models you call directly. These are the brains your router picks between.

| Connector | Maker | Routes | How to connect | Tier | Status | Adapter / milestone | Notes |
|---|---|---|---|---|---|---|---|
| OpenAI API | OpenAI | Model API, SDK | Responses API · Chat Completions · Batch · Realtime | P0 | Verified Oct 2026 | `openai-compatible:openai` · M1 | GPT-6 family (Sol, Luna, Astra) live in the API in Oct 2026; API prices unchanged with the GPT-6 ChatGPT launch. |
| Claude API | Anthropic | Model API, SDK | Messages API · Batch · prompt caching · tool use | P0 | Established | `anthropic` · M1 | Pull live model list; Opus, Sonnet and Haiku tiers serve planner, worker and utility roles. |
| Gemini API | Google | Model API, SDK | AI Studio key or Vertex AI · Interactions API | P0 | Established | `gemini` · M1 | Same key also unlocks Gemini Managed Agents (preview). Very long context; cheap Flash tier. |
| Grok API | xAI (operating as SpaceXAI) | Model API, SDK | OpenAI-SDK compatible: change base URL · Responses + Agents API | P0 | Verified Oct 2026 | `openai-compatible:xai` · M1 | Grok 4.6 (Aug 2026) aimed at long-running agents and coding; also grok-code-fast and a multi-agent variant. Server-side tools billed per call. |
| Meta Model API (Muse Spark) | Meta Superintelligence Labs | Model API | OpenAI-compatible endpoint · model id muse-spark-1.1 | P1 | Preview / limited | `openai-compatible:meta` · M1 | Public preview, US developers only. $1.25 / $4.25 per M tokens, 1M context, tool calls, caching. Muse Image not in the API yet. |
| Mistral API | Mistral AI | Model API, Self-host / local | La Plateforme API · open-weight models to self-host | P1 | Established | `openai-compatible:mistral` · M1 | EU-hosted option for customers who need data in Europe; strong code models. |
| Cohere API | Cohere | Model API | Chat · Embed · Rerank endpoints | P2 | Established | M1 | Use mainly for rerank and embeddings in your memory layer. |
| Amazon Nova | AWS | Model API | Via Amazon Bedrock | P2 | Established | M1 | Nova 2 family incl. Omni and Sonic voice; cheap option inside AWS accounts. |
| Microsoft MAI models | Microsoft | Model API | Via Microsoft Foundry | P3 | Established | M1 | Mostly image and voice so far (MAI-Image-2.5, Jun 2026). Check text-model availability. |
| AI21 Jamba | AI21 Labs | Model API, Self-host / local | AI21 Studio API | P3 | Established | M1 | Long-context niche; low priority. |

## Open-weight & regional models

Cheaper, often OpenAI-compatible APIs, plus models you can host yourself. Strong for bulk and utility steps.

| Connector | Maker | Routes | How to connect | Tier | Status | Adapter / milestone | Notes |
|---|---|---|---|---|---|---|---|
| DeepSeek API | DeepSeek | Model API, Self-host / local | OpenAI- and Anthropic-format endpoints | P1 | Established | `openai-compatible:deepseek` · M1 | Very low cost; V4 series with thinking mode. Good for bulk coding and reasoning steps. |
| Qwen (Model Studio) | Alibaba Cloud | Model API, Self-host / local, Headless CLI | DashScope / Model Studio API · Qwen Code CLI · open weights | P1 | Established | `openai-compatible:qwen` · M1 | Qwen3 coder line is a strong open coding model; run locally or via API. |
| Kimi API | Moonshot AI | Model API, Headless CLI, Self-host / local | Kimi platform API · Kimi Code API · Kimi CLI | P1 | Established | `openai-compatible:kimi` · M1 | K2 series for agentic coding and long docs. OpenAI and Anthropic compatible. |
| GLM API | Zhipu (Z.ai) | Model API, Self-host / local | Z.ai API · GLM Coding Plan (works inside Claude Code / Cline) | P1 | Established | `openai-compatible:glm` · M1 | GLM-5.x noted for reliable structured output and long coding runs. |
| Sarvam AI API | Sarvam AI (India) | Model API, Self-host / local | Chat Completions (sarvam-105b) · speech · Document AI | P1 | Verified Oct 2026 | `openai-compatible:sarvam` · M1 | Indian-language specialist. Sarvam-105B is the only supported chat model since Jul 2026; self-host in your own AWS available. |
| Local models | Ollama · vLLM · LM Studio | Self-host / local, Model API | OpenAI-compatible localhost endpoint | P1 | Established | `openai-compatible:local` · M1 | Private or offline mode: route sensitive sub-tasks to a model on the user's machine. |
| MiniMax API | MiniMax | Model API, Self-host / local | MiniMax platform API · open weights | P2 | Established | M1 | Budget coding and long context; also speech and video models. |
| NVIDIA NIM | NVIDIA | Model API, Self-host / local | NIM microservices · build.nvidia.com API | P2 | Established | M1 | Packaged open models (Nemotron, Llama, Sarvam and others) for GPU hosts. |

## Gateways & clouds

One key or one bill reaching many models. Use for fallback, price routing and enterprise buyers.

| Connector | Maker | Routes | How to connect | Tier | Status | Adapter / milestone | Notes |
|---|---|---|---|---|---|---|---|
| OpenRouter | OpenRouter | Model API | One key, OpenAI-format; per-model routing and fallbacks | P0 | Verified Oct 2026 | `openai-compatible:openrouter` · M1 | Fastest way to reach hundreds of models incl. Grok 4.x on day one. Your router can sit on top. |
| LiteLLM | BerriAI (open source) | Self-host / local, Model API | Self-hosted proxy: one API, 100+ providers, budgets, logs | P0 | Established | `openai-compatible:litellm` · M1 | Your internal plumbing: metering, keys per workspace, spend caps. Pairs with Mandate-style limits. |
| Amazon Bedrock | AWS | Model API | Converse API · Claude, Llama, Mistral, Nova and more | P1 | Established | M1 | Enterprise buyers already on AWS; data stays in their account. |
| Microsoft Foundry | Microsoft | Model API, Hosted agent API, A2A | Responses-API wire format · OpenAI, Anthropic, Meta, Mistral models | P1 | Verified Oct 2026 | M1 | Renamed from Azure AI Foundry; Foundry Agent Service went GA on 16 Mar 2026. |
| Vertex AI Model Garden | Google Cloud | Model API | Gemini, Claude, Llama and open models in one GCP project | P1 | Established | M1 | Google-cloud customers; also the billed path for Antigravity SDK. |
| Groq · Cerebras | Groq · Cerebras | Model API | OpenAI-compatible fast-inference endpoints | P2 | Established | `openai-compatible:groq` · M1 | Very low latency for quick routing, classification and judge calls. |
| Together · Fireworks · DeepInfra | Various | Model API | OpenAI-compatible hosts for open-weight models | P2 | Established | `openai-compatible:together` · M1 | Cheap hosted open models without running GPUs. |
| Vercel AI Gateway · Cloudflare AI Gateway | Vercel · Cloudflare | Model API | Edge proxy with caching and analytics | P2 | Established | M1 | Useful if you host on Vercel; both listed Grok 4.6 at launch. |
| Hugging Face Inference Providers | Hugging Face | Model API, Self-host / local | One HF token routes to many hosts | P3 | Established | M1 | Long tail of niche and research models. |

## Coding agents

Full agents (not just models) that edit repos. Driven headless, by SDK, or as cloud tasks.

| Connector | Maker | Routes | How to connect | Tier | Status | Adapter / milestone | Notes |
|---|---|---|---|---|---|---|---|
| Claude Code | Anthropic | Headless CLI, SDK, MCP | claude -p (headless) · Claude Agent SDK (Python/TS) | P0 | Verified Oct 2026 | `claude-code` · M2 | Use API keys: subscription limits are not allowed for third-party agents. Hooks let you intercept writes, as Relay does. |
| OpenAI Codex | OpenAI | Headless CLI, SDK, Hosted agent API | codex exec · Codex SDK (TS) · Codex Cloud tasks · GitHub Action | P0 | Verified Oct 2026 | `codex` · M2 | Cloud tasks need a ChatGPT plan; an API key runs Codex locally only. DevDay 2026 rebuilt Codex Cloud environments. |
| Cursor Agent | Anysphere | Headless CLI, Hosted agent API | cursor agent -p --trust (stream-json) · Cloud Agents | P0 | Verified Oct 2026 | `cursor-agent` · M2 | Headless CLI works anywhere with CURSOR_API_KEY; supports worktrees and ACP. Cloud Agents run in Cursor VMs. |
| Google Antigravity | Google | Headless CLI, SDK, Hosted agent API | agy -p --output-format stream-json · Antigravity SDK · Managed Agents | P0 | Verified Oct 2026 | `antigravity` · M2 | Serves Gemini plus Claude and GPT-OSS models. Headless permission bug (issue #548) auto-denies tools; set explicit allowlists. |
| Jules | Google Labs | Model API, Headless CLI | Jules REST API (v1alpha) · Jules Tools CLI | P1 | Verified Oct 2026 | `jules` · M2 | Async issue-to-PR agent; GitHub only. Good for background backlog work. |
| GitHub Copilot coding agent | GitHub / Microsoft | Headless CLI, Hosted agent API | Copilot CLI · assign issues to Copilot via GitHub API | P1 | Established | M2 | Works where the user's code already lives; enterprise seat holders. |
| Grok Build | xAI | Headless CLI | Local-first coding agent; Grok 4.6 is its default | P1 | Preview / limited | M2 | Was waitlisted into spring 2026; confirm open access and headless flags. |
| Devin | Cognition | Model API, Hosted agent API | Devin API: create sessions, poll, fetch PRs | P1 | Established | `devin` · M2 | Long autonomous tasks in its own VM. Cognition also owns Windsurf. |
| OpenCode | open source | Headless CLI, Self-host / local | opencode run (headless) · any model via BYOK | P1 | Established | `opencode` · M2 | Model-agnostic terminal agent; easy to pair with cheap open models. |
| Kiro | AWS | Headless CLI | Kiro IDE · Kiro CLI · Kiro Powers | P2 | Established | M6+ | Spec-driven coding; natural fit for AWS-heavy teams and AgentCore. |
| Cline · Roo Code · Kilo Code | open source | Headless CLI, Self-host / local | Cline CLI · VS Code extensions · BYOK | P2 | Established | M6+ | Popular BYOK agents; Cline bundles open-weight models in a cheap pass. |
| Aider | open source | Headless CLI, Self-host / local | aider --message (scriptable) | P2 | Established | `aider` · M6+ | Lightweight git-native pair programmer. |
| Goose · OpenHands | Block · All Hands (open source) | Headless CLI, Self-host / local, Hosted agent API | goose run · OpenHands headless / cloud | P2 | Established | `goose` · M6+ | Open agents you can self-host as specialists. |
| Amp · Factory Droid · Augment · Warp · Junie | Various | Headless CLI | Each ships a CLI or headless mode | P2 | Established | M6+ | Add as demand appears; check each for non-interactive flags. |
| v0 · Lovable · Bolt · Replit Agent | Vercel · Lovable · StackBlitz · Replit | Model API, Browser / UI only | v0 Platform API; others mostly app-only | P2 | Established | M6+ | Full-app builders for prototypes and landing pages. Confirm which expose task APIs. |
| Gemini CLI | Google | Headless CLI | gemini (API-key mode) | P3 | Changing / retiring | M6+ | Free and AI Pro/Ultra sign-ins moved to Antigravity CLI on 18 Jun 2026. Treat agy as the successor. |

## Hosted agent runtimes

Vendor-run sandboxes you send a task to over REST and get results back. Best way to run other labs' agents at scale.

| Connector | Maker | Routes | How to connect | Tier | Status | Adapter / milestone | Notes |
|---|---|---|---|---|---|---|---|
| Claude Managed Agents | Anthropic | Hosted agent API | REST beta, header managed-agents-2026-04-01 | P0 | Verified Oct 2026 | `claude-managed-agents` · M6 | Anthropic runs the harness, sandbox and session log. Launched 8 Apr 2026; not ZDR or HIPAA eligible yet. |
| OpenAI Agents API | OpenAI | Hosted agent API | POST /v1/agents/sessions, header OpenAI-Beta: agents=v1 | P0 | Verified Oct 2026 | `openai-agents` · M6 | Since 29 Sep 2026 can run tasks in an OpenAI-hosted browser; your app handles site approvals and sign-in. |
| Gemini Managed Agents | Google | Hosted agent API, MCP | Antigravity harness via the Interactions API | P1 | Preview / limited | `gemini-managed-agents` · M6 | Preview: persistent sandboxes, saved agents, triggers, budgets, remote MCP. |
| Bedrock AgentCore | AWS | Hosted agent API, A2A, MCP | Runtime · Gateway · Memory · Browser · managed harness (preview) | P1 | Verified Oct 2026 | `bedrock-agentcore` · M6 | Per-session microVMs; Cedar policies on tool calls. CLI and harness added Apr 2026. |
| Foundry Agent Service | Microsoft | Hosted agent API, A2A | Prompt agents or hosted agents on the Responses API | P1 | Verified Oct 2026 | `foundry-agents` · M6 | GA Mar 2026. Bridges to Copilot Studio over A2A. |

## Computer-use & browser agents

For sites and apps with no API. Slower and riskier, so use only where no API exists.

| Connector | Maker | Routes | How to connect | Tier | Status | Adapter / milestone | Notes |
|---|---|---|---|---|---|---|---|
| Claude computer use | Anthropic | Model API | Computer-use tool in the Messages API | P1 | Established | `anthropic-computer-use` · M6 | Run it in your own VM or cloud browser for sites without APIs. |
| Amazon Nova Act | AWS | SDK, Hosted agent API | pip install nova-act · CLI deploys to AgentCore Runtime | P1 | Verified Oct 2026 | `nova-act` · M6 | Browser agent on a Nova model trained for web driving; playground at nova.amazon.com/act. |
| Browser Use | Browser Use (open source + cloud) | SDK, Hosted agent API, Self-host / local | Python library · Browser Use Cloud API | P1 | Verified Oct 2026 | `browser-use` · M6 | Leading open framework; cloud adds stealth browsers and proxies. |
| Browserbase · Steel · Hyperbrowser | Various | Model API | Cloud browser sessions over CDP | P2 | Established | M6 | Infrastructure under any browser agent; Steel documents an OpenAI computer-use integration. |
| Skyvern | open source | Model API, Self-host / local | Skyvern API · self-host | P3 | Established | M6 | Form-filling workflows on legacy portals. |
| Perplexity Comet | Perplexity | Browser / UI only, MCP | Consumer browser; community MCP bridges over CDP | P3 | No API / ToS risk | not supported | No public REST API for Comet itself. Use Perplexity's Agent API instead. |
| ChatGPT agent · Atlas | OpenAI | Browser / UI only | Consumer app only | P3 | No API / ToS risk | not supported | Do not scrape; the Agents API offers the same hosted-browser ability legitimately. |
| Claude in Chrome · Gemini in Chrome | Anthropic · Google | Browser / UI only | User-side browser extensions | P3 | No API / ToS risk | not supported | Runs in the user's own browser; your product can hand off to it but not drive it remotely. |

## Research & search

Deep research agents and search APIs that feed facts and citations to every other agent.

| Connector | Maker | Routes | How to connect | Tier | Status | Adapter / milestone | Notes |
|---|---|---|---|---|---|---|---|
| Perplexity Agent API | Perplexity | Model API | Agent API (replacing Sonar API) | P1 | Changing / retiring | M6 | Perplexity said Sonar API retires 27 Sep 2026 in favour of the Agent API. Cited, web-grounded answers. |
| OpenAI search & deep research | OpenAI | Model API | gpt-5-search-api · deep-research models via Responses | P1 | Verified Oct 2026 | M6 | Search-grounded model snapshot dated 14 Oct 2026. |
| Grok live search | xAI | Model API | Server-side web and X search tools in the xAI API | P1 | Verified Oct 2026 | M6 | Unique access to live X posts; useful for market chatter. |
| Exa · Tavily · Parallel | Various | Model API, MCP | Search APIs built for agents | P1 | Established | M6 | Give every agent the same search tool so results are comparable. |
| Gemini Deep Research | Google | Model API | Via Gemini API / Interactions | P2 | Established | M6 | Long multi-source reports; confirm API exposure in your region. |
| Brave Search API · You.com | Brave · You.com | Model API | Web index APIs | P2 | Established | M6 | Independent indexes for cross-checking. |
| Firecrawl · Jina Reader | Various | Model API, MCP | URL to clean markdown | P2 | Established | M6 | Page fetching for research agents. |

## General autonomous agents

Do-anything agents. Few have real APIs, so most are reachable only through their apps.

| Connector | Maker | Routes | How to connect | Tier | Status | Adapter / milestone | Notes |
|---|---|---|---|---|---|---|---|
| Manus | Butterfly Effect | Model API | Manus API: tasks, projects, connectors, webhooks | P1 | Verified Oct 2026 | `manus` · M6 | One of few general agents with an official API. Wide Research and cloud browser included. |
| OpenClaw · OpenManus | open source | Self-host / local | Self-hosted general agents | P2 | Established | M6 | Host as your own general-purpose worker. |
| Genspark | Genspark | Browser / UI only, MCP | Workspace app; MCP and skills inside | P3 | No API / ToS risk | not supported | No documented public task API found. Treat as user-side only. |
| Kimi Agent · MiniMax Agent | Moonshot · MiniMax | Browser / UI only | Consumer apps (Agent Swarm, Kimi Claw) | P3 | No API / ToS risk | not supported | Use their model APIs instead of the apps. |

## Image, video, voice & music

Specialists the router hands creative sub-tasks to.

| Connector | Maker | Routes | How to connect | Tier | Status | Adapter / milestone | Notes |
|---|---|---|---|---|---|---|---|
| OpenAI image & voice | OpenAI | Model API | gpt-image · Realtime · gpt-transcribe | P1 | Verified Oct 2026 | `openai-image` · M6 | Sora API was scheduled to shut down 24 Sep 2026; don't build on it. |
| Google Veo · Nano Banana | Google | Model API | Gemini API / Vertex | P1 | Changing / retiring | `google-media` · M6 | Imagen 4 was deprecated in the Gemini API (shutdown 17 Aug 2026). Use current image and Veo models. |
| Black Forest Labs Flux | BFL | Model API, Self-host / local | Official API · open weights | P1 | Established | `flux` · M6 | The legitimate stand-in for Midjourney-style images. |
| Runway | Runway | Model API | Official API (Gen-4.5, Aleph editing) | P1 | Verified Oct 2026 | `runway` · M6 | Video generation and frame-directed editing. |
| ElevenLabs | ElevenLabs | Model API, MCP | TTS · voice cloning · conversational agents API | P1 | Established | `elevenlabs` · M6 | Voice layer for explainer videos and voice agents. |
| Luma · Kling | Luma AI · Kuaishou | Model API | Official video APIs | P2 | Verified Oct 2026 | `luma` · M6 | Luma Uni-1.1 API (May 2026); Kling 3 with native 4K. |
| Ideogram · Recraft | Ideogram · Recraft | Model API | Official image APIs | P2 | Established | `ideogram` · M6 | Text-in-image and vector or brand graphics. |
| Midjourney | Midjourney | No official API | Discord / web app only | P3 | No API / ToS risk | not supported | No official API. Third-party proxies breach its terms and risk bans. |
| Suno · Udio | Suno · Udio | No official API | Apps; access mainly via unofficial wrappers | P3 | No API / ToS risk | not supported | No confirmed official public API; check licensing before any use. |
| Muse Image | Meta | No official API | Meta AI app only | P3 | Preview / limited | not supported | Shipped Jul 2026 but not yet in the Meta Model API. |

## Design & workspace tools

Where outputs land and get edited: design canvases, docs, workspaces.

| Connector | Maker | Routes | How to connect | Tier | Status | Adapter / milestone | Notes |
|---|---|---|---|---|---|---|---|
| Figma | Figma | Model API, MCP | REST API · Dev Mode MCP server | P1 | Established | M6 | Read designs into coding agents; write back comments and frames. |
| Canva | Canva | Model API, MCP | Connect API · Canva MCP | P1 | Established | M6 | Branded marketing assets from agent output. |
| Notion | Notion | Model API, MCP | Notion API · Notion MCP · Notion agents | P2 | Established | M6 | Common place teams want final docs and task boards. |
| Google Workspace · Microsoft 365 | Google · Microsoft | Model API, MCP | Drive / Docs / Sheets APIs · Graph API | P2 | Established | M6 | Deliver outputs where the user already works. |
| Claude Design · Claude artifacts | Anthropic | Browser / UI only | Inside the Claude app | P3 | No API / ToS risk | not supported | No standalone public API known; drive Claude through its API and render designs yourself. |
| Gamma · Google Stitch | Gamma · Google | Browser / UI only, Model API | Decks and UI generation | P3 | Established | M6 | Check current API exposure before committing. |

## Enterprise agent platforms

Company agent stacks that already speak A2A. Your orchestrator can delegate to them, or be delegated to.

| Connector | Maker | Routes | How to connect | Tier | Status | Adapter / milestone | Notes |
|---|---|---|---|---|---|---|---|
| Microsoft Copilot Studio | Microsoft | A2A, MCP | A2A delegation · connected agents · MCP tools | P2 | Verified Oct 2026 | M6 | Can directly talk to and delegate to first-, second- and third-party agents over A2A. |
| Gemini Enterprise (Agentspace) | Google Cloud | A2A | A2A agent registry | P2 | Established | M6 | Google donated A2A; its enterprise agents speak it natively. |
| Salesforce Agentforce | Salesforce | A2A, Model API | Agent API · A2A | P2 | Established | M6 | CRM-side agents for sales and service tasks. |
| ServiceNow · SAP Joule · Workday | Various | A2A | A2A-enabled enterprise agents | P3 | Established | M6 | Later, for enterprise deals; confirm each vendor's A2A status. |

## Protocols & frameworks

The plumbing: open protocols to talk to agents, and frameworks to build your own specialist agents.

| Connector | Maker | Routes | How to connect | Tier | Status | Adapter / milestone | Notes |
|---|---|---|---|---|---|---|---|
| A2A protocol | Linux Foundation | A2A | Agent Cards (JSON) · tasks · streaming · artifacts | P0 | Verified Oct 2026 | `a2a` · M7 | v1.0 in Mar 2026; 150+ organisations; built into Google, Microsoft and AWS. AP2 adds agent payments. |
| Model Context Protocol | Linux Foundation | MCP | Tools and data for any agent | P0 | Established | `mcp` · M7 | Expose your orchestrator as an MCP server so any agent can call it, and consume thousands of MCP tools. |
| Agent Client Protocol (ACP) | Zed and others | Headless CLI | Standard way for a client to drive a coding agent | P1 | Verified Oct 2026 | M7 | Cursor CLI honours ACP; lets one adapter drive several CLIs. |
| OpenAI Agents SDK | OpenAI | SDK | pip install openai-agents · @openai/agents | P1 | Verified Oct 2026 | M7 | Model-agnostic; handoffs, tracing, MCP. v0.24 on 15 Oct 2026. |
| Claude Agent SDK | Anthropic | SDK | pip install claude-agent-sdk · @anthropic-ai/claude-agent-sdk | P1 | Verified Oct 2026 | M7 | Claude Code's harness as a library; prototype here, graduate to Managed Agents. |
| Google ADK | Google | SDK, A2A | Agent Development Kit (Python, Java) | P2 | Established | M7 | Native A2A publishing of your own agents. |
| LangGraph · CrewAI · Microsoft Agent Framework | Various | SDK | Graph and crew orchestration libraries | P2 | Established | M7 | Borrow patterns; your core router is likely custom. |
| Pydantic AI · Mastra | open source | SDK | Typed agent frameworks (Python, TS) | P3 | Established | M7 | Clean options for small specialist agents. |

## Automation & app hubs

Thousands of apps behind one auth layer, so agents can act in Gmail, Slack, CRMs and more.

| Connector | Maker | Routes | How to connect | Tier | Status | Adapter / milestone | Notes |
|---|---|---|---|---|---|---|---|
| Composio | Composio | Model API, MCP | Managed OAuth + tools for 250+ apps | P1 | Established | M6 | Saves you building auth for every SaaS app agents need to touch. |
| Zapier AI Actions / MCP | Zapier | MCP, Model API | Zapier MCP server · 8,000+ apps | P2 | Established | M6 | Widest app coverage; per-action pricing. |
| n8n · Make · Pipedream | Various | Model API, Self-host / local | Workflow engines with AI nodes | P2 | Established | M6 | n8n is self-hostable; Sarvam ships an n8n node. |

## Sources

- [Meta opens Muse Spark 1.1 via Model API (Axios)](https://www.axios.com/2026/07/09/meta-ai-spark-model-update-developer)
- [Meta Model API pricing and region (implicator.ai)](https://www.implicator.ai/meta-prices-its-first-paid-ai-model-api-at-4-25-per-million-output-tokens/)
- [Grok 4.6 availability (geotoolbox)](https://geotoolbox.ai/fr/blog/grok-4-6.md)
- [Grok for coding: Grok Build, xAI API (Verdent)](https://www.verdent.ai/guides/grok-for-coding-2026)
- [Cursor Agent CLI](https://cursor.com/blog/cli)
- [Antigravity CLI headless adapter (docs.rs)](https://docs.rs/crate/atomr-agents-coding-cli-vendor-antigravity/latest)
- [Gemini CLI to Antigravity transition, terms (Glama)](https://glama.ai/mcp/servers/dssbdev/gemini-bridge/tree)
- [Antigravity headless permissions issue (Glama)](https://glama.ai/mcp/servers/LoliLin/memoh-antigravity-cli-mcp/tree)
- [Gemini Managed Agents snapshot (SuperQode)](https://superagenticai.github.io/superqode/providers/antigravity/)
- [Codex Cloud after DevDay 2026 (Flavio Copes)](https://flaviocopes.com/codex-cloud.md)
- [OpenAI GPT-6 release and API ids](https://andrew.ooo/answers/what-changed-latest-openai-model-release-gpt-6-october-2026/)
- [OpenAI Agents API computer use](https://www.developersdigest.tech/blog/openai-agents-api-computer-use)
- [OpenAI Agents SDK versions](https://www.developersdigest.tech/agent-frameworks/openai-agents-sdk)
- [Claude Managed Agents docs](https://platform.claude.com/docs/en/managed-agents/)
- [Claude Agent SDK and subscription rules](https://tutorialsdojo.com/claude-agent-sdk/)
- [Jules Tools and Jules API (Google)](https://blog.google/technology/google-labs/jules-tools-jules-api/)
- [Genspark vs Manus, Manus API](https://aiidelist.com/blog/genspark-vs-manus)
- [Perplexity Sonar to Agent API](https://tech-insider.org/it/?p=990)
- [Comet has no public API (apis.io)](https://apis.io/providers/comet-browser/)
- [Nova Act interfaces (AWS docs)](https://docs.aws.amazon.com/nova-act/latest/userguide/interfaces.md)
- [Bedrock AgentCore new features (AWS)](https://aws.amazon.com/fr/about-aws/whats-new/2026/04/agentcore-new-features-to-build-agents-faster/)
- [Microsoft Foundry vs Copilot Studio](https://jannikreinhard.com/foundry-vs-copilot-studio/)
- [Copilot Studio A2A (Microsoft)](https://www.microsoft.com/en-us/microsoft-copilot/blog/?p=7459)
- [A2A one-year milestones (Linux Foundation)](https://linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year)
- [Sarvam API changelog](https://docs.sarvam.ai/changelog.md)
- [Midjourney API status](https://www.myarchitectai.com/blog/midjourney-apis)
- [Media model status, Sora and Imagen retirements](https://github.com/jayeshmepani/Media-AI)
- [Browser Use and computer-use agents (fast.io)](https://fast.io/resources/best-computer-use-ai-agents-2026/)
- [Open-weight coding models (DeepSeek, Kimi, GLM, Qwen)](https://www.test.atlascloud.ai/blog/tips/coding-plan-best-open-source-coding-llm)
- [Grok 4.20 on OpenRouter](https://openrouter.ai/x-ai/grok-4.20/api)
