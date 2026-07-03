/*---------------------------------------------------------------------------------------------
 *  Atom++ — Agent Sketch · the agent catalog  [SK1]
 *
 *  96 specialized agent archetypes for the visual agent-orchestration canvas, organized into
 *  user-facing palette groups. Derived from the agent library of ruflo (https://github.com/ruvnet/ruflo,
 *  MIT © 2024-2026 ruvnet) — names + one-line roles only; each node runs on Atom++'s OWN agent loop
 *  (extensions/atom-ai/agent.js + providers/), BYO-key, direct to the provider.
 *
 *  `tier` drives the node's default model (fast | balanced | powerful) — resolved against the active
 *  provider via sketch.js MODEL_TIERS. A node's model can be overridden per-node in the canvas, which
 *  is how "recalculate the flow with a different model" works.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

/** Palette groups, in display order. `icon` is a codicon name. */
const AGENT_GROUPS = [
	{ id: 'core', label: 'Core', icon: 'star' },
	{ id: 'orchestration', label: 'Orchestration', icon: 'type-hierarchy' },
	{ id: 'coding', label: 'Coding', icon: 'code' },
	{ id: 'testing', label: 'Testing', icon: 'beaker' },
	{ id: 'review', label: 'Review & Analysis', icon: 'checklist' },
	{ id: 'architecture', label: 'Architecture', icon: 'symbol-structure' },
	{ id: 'security', label: 'Security', icon: 'shield' },
	{ id: 'docs', label: 'Documentation', icon: 'book' },
	{ id: 'github', label: 'GitHub', icon: 'github' },
	{ id: 'consensus', label: 'Consensus & Distributed', icon: 'organization' },
	{ id: 'performance', label: 'Performance', icon: 'dashboard' },
	{ id: 'data', label: 'Data & ML', icon: 'graph' },
	{ id: 'content', label: 'Content & Editorial', icon: 'edit' },
	{ id: 'connectors', label: 'Connectors & Triggers', icon: 'broadcast' },
	{ id: 'specialized', label: 'Specialized', icon: 'tools' }
];

// Content/editorial + connector/trigger archetypes (Atom++ additions, not from ruflo). Connectors
// ACT ON THE WORLD (post to Telegram/Slack, send email, call webhooks) and triggers fire flows on a
// schedule. In an SK1 sketch run every node is TEXT-ONLY: a connector produces the exact
// message/payload it WOULD send and a trigger produces the run context it WOULD fire with — live
// side effects + credentials + permission gating + cron scheduling arrive in SK2/SK3 (see
// docs/atompp-agent-sketch-design.md). Descriptions say so, so the flow reads honestly today.
const EXTRA_AGENTS = [
	// content & editorial
	{ id: 'news-collector', group: 'content', tier: 'balanced', description: 'Collects and summarizes recent news and updates on a given topic from the web (research + dedupe + cite sources); one instance per beat/source.' },
	{ id: 'press-editor', group: 'content', tier: 'powerful', description: 'Head-of-press-release editor: triages incoming items for newsworthiness, sets the angle and priority, and briefs the writers.' },
	{ id: 'copywriter', group: 'content', tier: 'balanced', description: 'Professional copywriter: verifies facts against sources, tightens prose, and composes a single publish-ready post in the target voice.' },
	{ id: 'editor-in-chief', group: 'content', tier: 'powerful', description: 'Final editorial gate: fact-checks, enforces style and legal/compliance, and approves or sends back the post.' },
	{ id: 'social-writer', group: 'content', tier: 'fast', description: 'Adapts an approved post into platform-native copy (length, hashtags, tone) for a specific channel.' },
	{ id: 'translator', group: 'content', tier: 'fast', description: 'Translates and localizes a post into a target language while preserving meaning and tone.' },
	// connectors (SK2 executable — SK1 emits the payload it would send)
	{ id: 'telegram-publisher', group: 'connectors', tier: 'fast', description: 'Publishes a message to a Telegram channel/chat via a bot. SK1: outputs the exact Markdown message it would post; SK2: posts for real using a stored bot token, with per-flow send permission.' },
	{ id: 'email-sender', group: 'connectors', tier: 'fast', description: 'Sends an email (to/subject/body). SK1: outputs the exact email it would send; SK2: sends via stored SMTP/provider credentials, gated by an explicit send confirmation.' },
	{ id: 'slack-publisher', group: 'connectors', tier: 'fast', description: 'Posts a message to a Slack channel via webhook/bot. SK1: outputs the payload; SK2: posts with a stored token + permission.' },
	{ id: 'webhook-caller', group: 'connectors', tier: 'fast', description: 'Calls an outbound HTTP webhook with a JSON payload built from upstream output. SK1: outputs the request it would make; SK2: performs it, gated by an allowlist + confirmation.' },
	{ id: 'file-writer', group: 'connectors', tier: 'fast', description: 'Writes the flow’s result to a workspace file. SK1: outputs the file path + contents it would write; SK2: writes it through the same Keep/Undo review the chat agent uses.' },
	// triggers
	{ id: 'scheduler', group: 'connectors', tier: 'fast', description: 'Periodic trigger (cron): the ROOT of a scheduled flow. SK1: outputs the run context it would fire with (e.g. “collect news since the last run at <time>”); SK3: actually runs the downstream flow on a cron cadence, Managed-Agents-style.' },
	{ id: 'webhook-trigger', group: 'connectors', tier: 'fast', description: 'Event trigger: the ROOT of a flow fired by an inbound webhook (a push, a form submit). SK1: describes the event payload; SK3: runs the flow on real inbound events.' }
];

/** @type {Array<{id:string, group:string, tier:'fast'|'balanced'|'powerful', description:string}>} */
const AGENTS = [
	{ id: 'architecture', group: 'architecture', tier: 'powerful', description: 'SPARC Architecture phase specialist for system design' },
	{ id: 'migration-planner', group: 'architecture', tier: 'powerful', description: 'Comprehensive migration plan for converting commands to agent-based system' },
	{ id: 'pseudocode', group: 'architecture', tier: 'balanced', description: 'SPARC Pseudocode phase specialist for algorithm design' },
	{ id: 'refinement', group: 'architecture', tier: 'balanced', description: 'SPARC Refinement phase specialist for iterative improvement' },
	{ id: 'repo-architect', group: 'architecture', tier: 'powerful', description: 'Repository structure optimization and multi-repo management with ruv-swarm coordination for scalable project architecture and development workflows' },
	{ id: 'specification', group: 'architecture', tier: 'powerful', description: 'SPARC Specification phase specialist for requirements analysis' },
	{ id: 'system-architect', group: 'architecture', tier: 'powerful', description: 'Expert agent for system architecture design, patterns, and high-level technical decisions' },
	{ id: 'v3-integration-architect', group: 'architecture', tier: 'powerful', description: 'V3 Integration Architect for deep agentic-flow@alpha integration. Implements ADR-001 to eliminate 10,000+ duplicate lines and build claude-flow as specialized extension rather than' },
	{ id: 'v3-security-architect', group: 'architecture', tier: 'powerful', description: 'V3 Security Architect responsible for complete security overhaul, threat modeling, and CVE remediation planning. Addresses critical vulnerabilities CVE-1, CVE-2, CVE-3 and implemen' },
	{ id: 'backend-dev', group: 'coding', tier: 'balanced', description: 'Specialized agent for backend API development, including REST and GraphQL endpoints' },
	{ id: 'base-template-generator', group: 'coding', tier: 'fast', description: 'Use this agent when you need to create foundational templates, boilerplate code, or starter configurations for new projects, components, or features. This agent excels at generatin' },
	{ id: 'mobile-dev', group: 'coding', tier: 'balanced', description: 'Expert agent for React Native mobile application development across iOS and Android' },
	{ id: 'sparc-coder', group: 'coding', tier: 'balanced', description: 'Transform specifications into working code with TDD practices' },
	{ id: 'crdt-synchronizer', group: 'consensus', tier: 'fast', description: 'Implements Conflict-free Replicated Data Types for eventually consistent state synchronization' },
	{ id: 'performance-benchmarker', group: 'consensus', tier: 'balanced', description: 'Implements comprehensive performance benchmarking for distributed consensus protocols' },
	{ id: 'quorum-manager', group: 'consensus', tier: 'balanced', description: 'Implements dynamic quorum adjustment and intelligent membership management' },
	{ id: 'raft-manager', group: 'consensus', tier: 'balanced', description: 'Manages Raft consensus algorithm with leader election and log replication' },
	{ id: 'coder', group: 'core', tier: 'balanced', description: 'Implementation specialist for writing clean, efficient code' },
	{ id: 'planner', group: 'core', tier: 'powerful', description: 'Strategic planning and task orchestration agent' },
	{ id: 'researcher', group: 'core', tier: 'balanced', description: 'Deep research and information gathering specialist' },
	{ id: 'reviewer', group: 'core', tier: 'balanced', description: 'Code review and quality assurance specialist' },
	{ id: 'tester', group: 'core', tier: 'balanced', description: 'Comprehensive testing and quality assurance specialist' },
	{ id: 'flow-nexus-neural', group: 'data', tier: 'balanced', description: 'Neural network training and deployment specialist. Manages distributed neural network training, inference, and model lifecycle using Flow Nexus cloud infrastructure.' },
	{ id: 'ml-developer', group: 'data', tier: 'balanced', description: 'Specialized agent for machine learning model development, training, and deployment' },
	{ id: 'safla-neural', group: 'data', tier: 'balanced', description: 'Self-Aware Feedback Loop Algorithm (SAFLA) neural specialist that creates intelligent, memory-persistent AI systems with self-learning capabilities. Combines distributed neural tra' },
	{ id: 'api-docs', group: 'docs', tier: 'balanced', description: 'Expert agent for creating and maintaining OpenAPI/Swagger documentation' },
	{ id: 'github-modes', group: 'github', tier: 'balanced', description: 'Comprehensive GitHub integration modes for workflow orchestration, PR management, and repository coordination with batch optimization' },
	{ id: 'issue-tracker', group: 'github', tier: 'fast', description: 'Intelligent issue management and project coordination with automated tracking, progress monitoring, and team coordination' },
	{ id: 'multi-repo-swarm', group: 'github', tier: 'balanced', description: 'Cross-repository swarm orchestration for organization-wide automation and intelligent collaboration' },
	{ id: 'pr-manager', group: 'github', tier: 'balanced', description: 'Comprehensive pull request management with swarm coordination for automated reviews, testing, and merge workflows' },
	{ id: 'project-board-sync', group: 'github', tier: 'fast', description: 'Synchronize AI swarms with GitHub Projects for visual task management, progress tracking, and team coordination' },
	{ id: 'release-manager', group: 'github', tier: 'balanced', description: 'Automated release coordination and deployment with ruv-swarm orchestration for seamless version management, testing, and deployment across multiple packages' },
	{ id: 'release-swarm', group: 'github', tier: 'balanced', description: 'Orchestrate complex software releases using AI swarms that handle everything from changelog generation to multi-platform deployment' },
	{ id: 'swarm-issue', group: 'github', tier: 'fast', description: 'GitHub issue-based swarm coordination agent that transforms issues into intelligent multi-agent tasks with automatic decomposition and progress tracking' },
	{ id: 'swarm-pr', group: 'github', tier: 'balanced', description: 'Pull request swarm management agent that coordinates multi-agent code review, validation, and integration workflows with automated PR lifecycle management' },
	{ id: 'workflow-automation', group: 'github', tier: 'balanced', description: 'GitHub Actions workflow automation agent that creates intelligent, self-organizing CI/CD pipelines with adaptive multi-agent coordination and automated optimization' },
	{ id: 'Load Balancing Coordinator', group: 'orchestration', tier: 'balanced', description: 'Dynamic task distribution, work-stealing algorithms and adaptive load balancing' },
	{ id: 'adaptive-coordinator', group: 'orchestration', tier: 'balanced', description: 'Dynamic topology switching coordinator with self-organizing swarm patterns and real-time optimization' },
	{ id: 'byzantine-coordinator', group: 'orchestration', tier: 'powerful', description: 'Coordinates Byzantine fault-tolerant consensus protocols with malicious actor detection' },
	{ id: 'code-goal-planner', group: 'orchestration', tier: 'powerful', description: 'Code-centric Goal-Oriented Action Planning specialist that creates intelligent plans for software development objectives. Excels at breaking down complex coding tasks into achievab' },
	{ id: 'codex-coordinator', group: 'orchestration', tier: 'balanced', description: 'Coordinates multiple headless Codex workers for parallel execution' },
	{ id: 'codex-worker', group: 'orchestration', tier: 'balanced', description: 'Headless Codex background worker for parallel task execution with self-learning' },
	{ id: 'collective-intelligence-coordinator', group: 'orchestration', tier: 'balanced', description: 'Orchestrates distributed cognitive processes across the hive mind, ensuring coherent collective decision-making through memory synchronization and consensus protocols' },
	{ id: 'consensus-coordinator', group: 'orchestration', tier: 'powerful', description: 'Distributed consensus agent that uses sublinear solvers for fast agreement protocols in multi-agent systems. Specializes in Byzantine fault tolerance, voting mechanisms, distribute' },
	{ id: 'dual-orchestrator', group: 'orchestration', tier: 'balanced', description: 'Orchestrates Claude Code (interactive) + Codex (headless) for hybrid workflows' },
	{ id: 'goal-planner', group: 'orchestration', tier: 'powerful', description: 'Goal-Oriented Action Planning (GOAP) specialist that dynamically creates intelligent plans to achieve complex objectives. Uses gaming AI techniques to discover novel solutions by c' },
	{ id: 'gossip-coordinator', group: 'orchestration', tier: 'balanced', description: 'Coordinates gossip-based consensus protocols for scalable eventually consistent systems' },
	{ id: 'hierarchical-coordinator', group: 'orchestration', tier: 'balanced', description: 'Queen-led hierarchical swarm coordination with specialized worker delegation' },
	{ id: 'memory-coordinator', group: 'orchestration', tier: 'balanced', description: 'Manage persistent memory across sessions and facilitate cross-agent memory sharing' },
	{ id: 'mesh-coordinator', group: 'orchestration', tier: 'balanced', description: 'Peer-to-peer mesh network swarm with distributed decision making and fault tolerance' },
	{ id: 'project-coordinator', group: 'orchestration', tier: 'balanced', description: 'Coordinates multi-agent workflows for this project' },
	{ id: 'queen-coordinator', group: 'orchestration', tier: 'powerful', description: 'The sovereign orchestrator of hierarchical hive operations, managing strategic decisions, resource allocation, and maintaining hive coherence through centralized-decentralized hybr' },
	{ id: 'scout-explorer', group: 'orchestration', tier: 'balanced', description: 'Information reconnaissance specialist that explores unknown territories, gathers intelligence, and reports findings to the hive mind through continuous memory updates' },
	{ id: 'sublinear-goal-planner', group: 'orchestration', tier: 'powerful', description: 'Goal-Oriented Action Planning (GOAP) specialist that dynamically creates intelligent plans to achieve complex objectives. Uses gaming AI techniques to discover novel solutions by c' },
	{ id: 'swarm-memory-manager', group: 'orchestration', tier: 'balanced', description: 'Manages distributed memory across the hive mind, ensuring data consistency, persistence, and efficient retrieval through advanced caching and synchronization protocols' },
	{ id: 'sync-coordinator', group: 'orchestration', tier: 'fast', description: 'Multi-repository synchronization coordinator that manages version alignment, dependency synchronization, and cross-package integration with intelligent swarm orchestration' },
	{ id: 'task-orchestrator', group: 'orchestration', tier: 'balanced', description: 'Central coordination agent for task decomposition, execution planning, and result synthesis' },
	{ id: 'v3-queen-coordinator', group: 'orchestration', tier: 'powerful', description: 'V3 Queen Coordinator for 15-agent concurrent swarm orchestration, GitHub issue management, and cross-agent coordination. Implements ADR-001 through ADR-010 with hierarchical mesh t' },
	{ id: 'worker-specialist', group: 'orchestration', tier: 'balanced', description: 'Dedicated task execution specialist that carries out assigned work with precision, continuously reporting progress through memory coordination' },
	{ id: 'Benchmark Suite', group: 'performance', tier: 'balanced', description: 'Comprehensive performance benchmarking, regression detection and performance validation' },
	{ id: 'Performance Monitor', group: 'performance', tier: 'fast', description: 'Real-time metrics collection, bottleneck analysis, SLA monitoring and anomaly detection' },
	{ id: 'Resource Allocator', group: 'performance', tier: 'balanced', description: 'Adaptive resource allocation, predictive scaling and intelligent capacity planning' },
	{ id: 'Topology Optimizer', group: 'performance', tier: 'balanced', description: 'Dynamic swarm topology reconfiguration and communication pattern optimization' },
	{ id: 'matrix-optimizer', group: 'performance', tier: 'balanced', description: 'Expert agent for matrix analysis and optimization using sublinear algorithms. Specializes in matrix property analysis, diagonal dominance checking, condition number estimation, and' },
	{ id: 'performance-optimizer', group: 'performance', tier: 'balanced', description: 'System performance optimization agent that identifies bottlenecks and optimizes resource allocation using sublinear algorithms. Specializes in computational performance analysis, s' },
	{ id: 'sona-learning-optimizer', group: 'performance', tier: 'balanced', description: 'SONA-powered self-optimizing agent with LoRA fine-tuning and EWC++ memory preservation' },
	{ id: 'trading-predictor', group: 'performance', tier: 'balanced', description: 'Advanced financial trading agent that leverages temporal advantage calculations to predict and execute trades before market data arrives. Specializes in using sublinear algorithms' },
	{ id: 'v3-performance-engineer', group: 'performance', tier: 'balanced', description: 'V3 Performance Engineer for achieving aggressive performance targets. Responsible for 2.49x-7.47x Flash Attention speedup, 150x-12,500x search improvements, and comprehensive bench' },
	{ id: 'analyst', group: 'review', tier: 'balanced', description: 'Advanced code quality analysis agent for comprehensive code reviews and improvements' },
	{ id: 'code-analyzer', group: 'review', tier: 'balanced', description: 'Advanced code quality analysis agent for comprehensive code reviews and improvements' },
	{ id: 'code-review-swarm', group: 'review', tier: 'balanced', description: 'Deploy specialized AI agents to perform comprehensive, intelligent code reviews that go beyond traditional static analysis' },
	{ id: 'pagerank-analyzer', group: 'review', tier: 'balanced', description: 'Expert agent for graph analysis and PageRank calculations using sublinear algorithms. Specializes in network optimization, influence analysis, swarm topology optimization, and larg' },
	{ id: 'perf-analyzer', group: 'review', tier: 'balanced', description: 'Performance bottleneck analyzer for identifying and resolving workflow inefficiencies' },
	{ id: 'flow-nexus-auth', group: 'security', tier: 'balanced', description: 'Flow Nexus authentication and user management specialist. Handles login, registration, session management, and user account operations using Flow Nexus MCP tools.' },
	{ id: 'security-auditor', group: 'security', tier: 'balanced', description: 'Security audit and hardening specialist' },
	{ id: 'security-manager', group: 'security', tier: 'balanced', description: 'Implements comprehensive security mechanisms for distributed consensus protocols' },
	{ id: 'agentic-payments', group: 'specialized', tier: 'balanced', description: 'Multi-agent payment authorization specialist for autonomous AI commerce with cryptographic verification and Byzantine consensus' },
	{ id: 'cicd-engineer', group: 'specialized', tier: 'balanced', description: 'Specialized agent for GitHub Actions CI/CD pipeline creation and optimization' },
	{ id: 'database-specialist', group: 'specialized', tier: 'balanced', description: 'Database design and optimization specialist' },
	{ id: 'flow-nexus-app-store', group: 'specialized', tier: 'balanced', description: 'Application marketplace and template management specialist. Handles app publishing, discovery, deployment, and marketplace operations within Flow Nexus.' },
	{ id: 'flow-nexus-challenges', group: 'specialized', tier: 'balanced', description: 'Coding challenges and gamification specialist. Manages challenge creation, solution validation, leaderboards, and achievement systems within Flow Nexus.' },
	{ id: 'flow-nexus-payments', group: 'specialized', tier: 'balanced', description: 'Credit management and billing specialist. Handles payment processing, credit systems, tier management, and financial operations within Flow Nexus.' },
	{ id: 'flow-nexus-sandbox', group: 'specialized', tier: 'balanced', description: 'E2B sandbox deployment and management specialist. Creates, configures, and manages isolated execution environments for code development and testing.' },
	{ id: 'flow-nexus-swarm', group: 'specialized', tier: 'balanced', description: 'AI swarm orchestration and management specialist. Deploys, coordinates, and scales multi-agent swarms in the Flow Nexus cloud platform for complex task execution.' },
	{ id: 'flow-nexus-user-tools', group: 'specialized', tier: 'balanced', description: 'User management and system utilities specialist. Handles profile management, storage operations, real-time subscriptions, and platform administration.' },
	{ id: 'flow-nexus-workflow', group: 'specialized', tier: 'balanced', description: 'Event-driven workflow automation specialist. Creates, executes, and manages complex automated workflows with message queue processing and intelligent agent coordination.' },
	{ id: 'python-specialist', group: 'specialized', tier: 'balanced', description: 'Python development specialist' },
	{ id: 'smart-agent', group: 'specialized', tier: 'balanced', description: 'Intelligent agent coordination and dynamic spawning specialist' },
	{ id: 'sparc-coord', group: 'specialized', tier: 'balanced', description: 'SPARC methodology orchestrator for systematic development phase coordination' },
	{ id: 'swarm-init', group: 'specialized', tier: 'balanced', description: 'Swarm initialization and topology optimization specialist' },
	{ id: 'typescript-specialist', group: 'specialized', tier: 'balanced', description: 'TypeScript development specialist' },
	{ id: 'v3-memory-specialist', group: 'specialized', tier: 'balanced', description: 'V3 Memory Specialist for unifying 6+ memory systems into AgentDB with HNSW indexing. Implements ADR-006 (Unified Memory Service) and ADR-009 (Hybrid Memory Backend) to achieve 150x' },
	{ id: 'production-validator', group: 'testing', tier: 'balanced', description: 'Production validation specialist ensuring applications are fully implemented and deployment-ready' },
	{ id: 'tdd-london-swarm', group: 'testing', tier: 'balanced', description: 'TDD London School specialist for mock-driven development within swarm coordination' },
	{ id: 'test-architect', group: 'testing', tier: 'powerful', description: 'Testing and quality assurance specialist' },
	{ id: 'test-long-runner', group: 'testing', tier: 'balanced', description: 'Test agent that can run for 30+ minutes on complex tasks' },
];

// A few ruflo descriptions were length-capped when this catalog was generated and got cut
// mid-word. Since each description is injected verbatim as a node's system-prompt role, trim any
// capped fragment back to a clean sentence — or, failing that, word — boundary. Idempotent.
function normalizeDesc(d) {
	d = String(d || '').trim();
	if (/[.!?)\]]$/.test(d) || d.length < 150) { return d; } // already clean, or short enough to be whole
	const lastStop = Math.max(d.lastIndexOf('. '), d.lastIndexOf('! '), d.lastIndexOf('? '));
	if (lastStop >= 80) { return d.slice(0, lastStop + 1); } // keep the last complete sentence
	const lastSpace = d.lastIndexOf(' ');
	return (lastSpace > 0 ? d.slice(0, lastSpace) : d).replace(/[,;:]+$/, '') + '…'; // drop the partial final word
}
AGENTS.push(...EXTRA_AGENTS); // content/editorial + connector/trigger archetypes (see above)
for (const a of AGENTS) { a.description = normalizeDesc(a.description); }

/** Quick lookup by agent id. */
const AGENT_BY_ID = new Map(AGENTS.map((a) => [a.id, a]));

module.exports = { AGENT_GROUPS, AGENTS, AGENT_BY_ID, normalizeDesc };
