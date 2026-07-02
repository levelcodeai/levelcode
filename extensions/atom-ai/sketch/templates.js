/*---------------------------------------------------------------------------------------------
 *  Atom++ — Agent Sketch · predefined flow templates  [SK1]
 *
 *  Ready-to-load starter sketches for the Agent Sketch canvas. Each template is a full sketch
 *  (name + goal + nodes + edges) built from the agentCatalog archetypes, laid out on a grid so
 *  it renders cleanly the moment it lands on the canvas. Users can:
 *    • pick one from the "Templates…" dropdown → loads the whole flow, or
 *    • drag a template chip onto the canvas → drops the flow at the cursor.
 *
 *  Layout convention: nodes are placed in columns (COL) by pipeline stage and rows (ROW) within
 *  a stage, so upstream→downstream reads left→right. `layoutColumns()` turns a compact
 *  {stages:[[agentId,...],...]} spec into positioned nodes + the obvious stage-to-stage edges.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
'use strict';

const COL = 230;   // horizontal spacing between pipeline stages
const ROW = 110;   // vertical spacing between parallel agents in a stage
const X0 = 40;
const Y0 = 40;

/**
 * Normalize a stage entry: a bare agent id string, or a rich spec object.
 * @param {string | {agent:string, label?:string, task?:string}} entry
 */
function normEntry(entry) {
	if (typeof entry === 'string') { return { agent: entry, label: entry, task: '' }; }
	return { agent: entry.agent, label: entry.label || entry.agent, task: entry.task || '' };
}

/**
 * Turn a compact staged spec into { nodes, edges }.
 * Each stage is an array of entries (agent-id strings, or {agent,label,task} objects);
 * every node in stage N feeds every node in stage N+1 (fan-out / fan-in).
 * @param {{stages: Array<Array<string | {agent:string,label?:string,task?:string}>>}} spec
 */
function layoutColumns(spec) {
	const stages = spec.stages || [];
	const nodes = [];
	const edges = [];
	const stageIds = [];   // stageIndex -> [nodeId,...]
	let seq = 0;

	stages.forEach((stage, ci) => {
		const ids = [];
		const n = stage.length;
		const colH = (n - 1) * ROW;
		stage.forEach((entry, ri) => {
			const e = normEntry(entry);
			const id = 'n' + (++seq);
			ids.push(id);
			nodes.push({
				id,
				agentId: e.agent,
				label: e.label,
				instructions: e.task,
				model: '',
				x: X0 + ci * COL,
				y: Y0 + ri * ROW + Math.max(0, (2 * ROW - colH) / 2)
			});
		});
		stageIds.push(ids);
	});

	// wire every node in a stage to every node in the next stage (fan-out / fan-in)
	for (let ci = 0; ci < stageIds.length - 1; ci++) {
		for (const from of stageIds[ci]) {
			for (const to of stageIds[ci + 1]) {
				edges.push({ from, to });
			}
		}
	}
	return { nodes, edges };
}

/** Build a template descriptor from a staged spec. */
function tpl(id, name, goal, description, stages) {
	const { nodes, edges } = layoutColumns({ stages });
	return { id, name, description, sketch: { name, goal, nodes, edges } };
}

// ─── The hero template: a fully-fledged distributed key-value store ──────────────────────────
// Topology mirrors "Design a Key-Value Store" (System Design Interview, Vol.1 / ByteByteGo):
// scope → architecture → the storage engine + every distributed-systems component in parallel →
// integrate into a running server → test + validate → final review. Each node carries a precise
// task that pins down which aspect of the chapter it owns; the flow GOAL (top of the canvas) sets
// the language, so "build using C" produces a C implementation covering every aspect.
const KV_STORE = tpl(
	'kv-store',
	'Design a Key-Value Store',
	'Build a production-quality, distributed key-value store in C, covering every aspect of the ' +
		'System Design Interview "Design a Key-Value Store" chapter (edit this goal to change the language).',
	'The full System-Design-Interview key-value store: consistent hashing, replication, quorum, ' +
		'vector clocks, gossip failure handling, Merkle anti-entropy, LSM storage — designed, built, tested.',
	[
		[
			{
				agent: 'planner', label: 'requirements',
				task: 'Establish the design scope and non-functional requirements exactly as the "Design a Key-Value Store" chapter: a get(key)/put(key,value)[/delete] API over small pairs, the ability to store big data, high availability, high scalability, automatic scaling, tunable consistency, and low latency. Choose the CAP trade-off (AP / eventually consistent, Dynamo-style) and justify it. Produce the public header (kvstore.h in the target language from the flow goal): the value/version types, get/put/delete signatures, error codes, and a numbered component checklist that MUST be covered downstream: (1) storage engine — commit log/WAL, in-memory memtable, on-disk SSTables, per-SSTable bloom filter, compaction; (2) consistent-hashing ring for partitioning; (3) replication over N nodes; (4) quorum consensus with tunable N/W/R and W+R>N; (5) vector-clock versioning and conflict reconciliation; (6) failure handling — gossip membership + heartbeats, sloppy quorum + hinted handoff, Merkle-tree anti-entropy; (7) coordinator / request routing; (8) the network server. Keep it concrete and implementable.'
			}
		],
		[
			{
				agent: 'system-architect', label: 'architecture',
				task: 'Design the module layout and build for the whole system in the target language (see the flow goal). Define one module (.h/.c for C) per component from the requirements checklist, the key structs (Node, RingEntry, VectorClock, MemTable, SSTable, BloomFilter, GossipMember, HintedHandoffEntry, MerkleNode, Coordinator), the concurrency/ownership model (per-connection threads or an event loop; who owns memory), and a Makefile/build spec. Publish the exact interfaces (function prototypes + structs) between the coordinator, the ring, replication/quorum, versioning, failure-handling, and the storage engine, so the six component implementers can work in parallel against a stable contract. Output the file tree and every header.'
			}
		],
		[
			{
				agent: 'coder', label: 'storage-engine',
				task: 'Implement the single-node storage engine following the chapter\'s write path and read path. Write path: append every mutation to a commit log (WAL) for durability, then apply it to an in-memory memtable; when the memtable is full, flush it as an immutable, sorted SSTable on disk. Read path: check the memtable, then consult each SSTable\'s bloom filter to skip files that cannot contain the key, then read the SSTable. Add background compaction of SSTables. Expose get/put/delete against this engine. Implement the header contract from the architecture node. Files: wal, memtable, sstable, bloomfilter.'
			},
			{
				agent: 'backend-dev', label: 'consistent-hash',
				task: 'Implement consistent hashing for data partitioning per the chapter: a hash ring with configurable virtual nodes per physical server for even load, add-server and remove-server rebalancing that only moves the affected key range, and key→node lookup by walking clockwise. Expose "the N nodes responsible for a key" (the first N unique physical nodes clockwise) since replication depends on it. Implement the header contract from the architecture node.'
			},
			{
				agent: 'coder', label: 'replication+quorum',
				task: 'Implement replication and quorum consensus. Replicate each write to the first N unique nodes clockwise on the ring (from the consistent-hash module). Support configurable N, W, R with W+R>N for tunable/strong consistency and the strong/weak/eventual models the chapter describes. The coordinator gathers W write acknowledgements or R read responses before answering the client; implement read-repair to push the newest version to stale replicas discovered during a read. Implement the header contract from the architecture node.'
			},
			{
				agent: 'coder', label: 'vector-clocks',
				task: 'Implement vector-clock versioning to detect and reconcile conflicting writes exactly as the chapter describes: a version is a list of [server, counter] pairs; increment the coordinating server\'s counter on write; compare two clocks to decide ancestor / descendant / concurrent (sibling). On concurrent writes, keep siblings and expose them to the caller for reconciliation on the next read (last-write-wins is not enough). Cap clock size with the truncation the chapter mentions. Implement the header contract from the architecture node.'
			},
			{
				agent: 'backend-dev', label: 'gossip+failover',
				task: 'Implement decentralized failure handling. Gossip-protocol membership: each node keeps a member list with heartbeat counters, periodically gossips it to random peers, and marks a member failed after its heartbeat stalls past a timeout. Temporary failures: sloppy quorum + hinted handoff — when a replica is down, another node accepts the write with a hint and forwards it once the node recovers. Permanent failures: Merkle-tree anti-entropy — build a Merkle tree per key range and exchange only the differing branches to re-sync divergent replicas cheaply. Files: gossip, hinted_handoff, merkle. Implement the header contract from the architecture node.'
			}
		],
		[
			{
				agent: 'sparc-coder', label: 'integrate+server',
				task: 'Assemble every component into a runnable multi-node key-value server in the target language. Implement the coordinator / request-routing layer that ties ring → replication/quorum → versioning → storage engine together (any node can act as coordinator, as in the chapter\'s architecture diagram). Add a simple TCP line protocol for GET/PUT/DELETE, node bootstrap/config (seeds, this node\'s address, N/W/R), main entry point, and the Makefile/build. Reconcile the interfaces from the upstream module implementations into ONE buildable codebase — if two modules disagree on a signature, pick one and note the adjustment. Output the final file tree and the wiring code (coordinator + main + build).'
			}
		],
		[
			{
				agent: 'tdd-london-swarm', label: 'tests',
				task: 'Write the test suite for the assembled system. Unit tests per module: WAL replay after crash, memtable↔SSTable roundtrip, bloom-filter false-positive behavior, consistent-hash key distribution and minimal movement on rebalance, vector-clock ancestor/descendant/sibling ordering, quorum honoring W+R>N, hinted-handoff delivery on recovery, Merkle-tree diff. Integration tests: stand up a small in-process cluster and verify get-after-put, replication to N nodes, and eventual consistency after a simulated node failure + recovery. Provide a `make test` (or equivalent) target and a lightweight test harness in the target language.'
			},
			{
				agent: 'production-validator', label: 'build+validate',
				task: 'Validate that the assembled system builds and is correct. Confirm the build compiles cleanly with warnings-as-errors (e.g. -Wall -Wextra for C), advise on memory-safety checking (valgrind / AddressSanitizer) and point out likely leak/ownership hotspots, and walk the requirements checklist from the requirements node item by item — for each, name the concrete module/function that satisfies it and flag anything unimplemented or stubbed. Output a pass/fail per requirement and a punch-list of gaps.'
			}
		],
		[
			{
				agent: 'reviewer', label: 'review+run-guide',
				task: 'Produce the final review and deliverable summary. Confirm every aspect of the chapter is covered by real code: single-node storage (WAL/memtable/SSTable/bloom/compaction), consistent-hashing partitioning, N-way replication, tunable N/W/R quorum, vector-clock versioning + reconciliation, gossip failure detection, sloppy quorum + hinted handoff, Merkle anti-entropy, coordinator/request routing, and the client protocol. Flag correctness, concurrency, and security issues from the upstream code and tests. End with a concise build-and-run guide (how to compile, start a 3-node cluster, and issue GET/PUT/DELETE).'
			}
		]
	]
);

/** @type {Array<{id:string,name:string,description:string,sketch:any}>} */
const TEMPLATES = [
	KV_STORE,
	tpl(
		'feature-pipeline',
		'Feature Pipeline',
		'Design, build, test and review a new feature',
		'Plan → build → test → review — the classic end-to-end delivery flow.',
		[
			['planner'],
			['system-architect'],
			['coder'],
			['tester'],
			['reviewer']
		]
	),
	tpl(
		'research-synthesize',
		'Research & Synthesize',
		'Research a topic in depth and produce a synthesized report',
		'Parallel researchers feed an analyst that synthesizes a documented answer.',
		[
			['planner'],
			['researcher', 'researcher'],
			['analyst'],
			['api-docs']
		]
	),
	tpl(
		'code-review-swarm',
		'Code Review Swarm',
		'Review a change for correctness, security and performance',
		'Fan out to specialist reviewers, then roll findings into one report.',
		[
			['code-analyzer', 'security-auditor', 'perf-analyzer'],
			['reviewer']
		]
	),
	tpl(
		'sparc-flow',
		'SPARC Flow',
		'Deliver a feature using the full SPARC methodology',
		'Specification → Pseudocode → Architecture → Refinement → Coder.',
		[
			['specification'],
			['pseudocode'],
			['architecture'],
			['refinement'],
			['sparc-coder']
		]
	),
	tpl(
		'tdd-flow',
		'Test-Driven Flow',
		'Build a component test-first with London-school TDD',
		'Architect the design, write failing tests, implement, then validate.',
		[
			['test-architect'],
			['tdd-london-swarm'],
			['coder'],
			['production-validator']
		]
	),
	tpl(
		'bugfix-flow',
		'Bug Fix Flow',
		'Reproduce, diagnose, fix and verify a reported bug',
		'Research the bug, analyze root cause, fix it, then test the fix.',
		[
			['researcher'],
			['code-analyzer'],
			['coder'],
			['tester']
		]
	),
	tpl(
		'api-service',
		'API Service Build',
		'Design and build a backend API with docs and CI',
		'Architect the API, build backend + database in parallel, document and wire CI.',
		[
			['system-architect'],
			['backend-dev', 'database-specialist'],
			['api-docs', 'cicd-engineer']
		]
	),
	tpl(
		'security-audit',
		'Security Audit',
		'Threat-model and harden a system against vulnerabilities',
		'Model the threats, run a security audit, then implement mitigations.',
		[
			['v3-security-architect'],
			['security-auditor'],
			['security-manager'],
			['reviewer']
		]
	),
	tpl(
		'refactor-flow',
		'Refactor & Optimize',
		'Analyze, refactor and performance-tune a module',
		'Analyze the code, plan refinements, optimize performance, then review.',
		[
			['code-analyzer', 'perf-analyzer'],
			['refinement'],
			['performance-optimizer'],
			['reviewer']
		]
	)
];

/** Palette-friendly list (no full sketch) for the dropdown / drag chips. */
const TEMPLATE_INDEX = TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description }));

/** @type {Map<string, any>} */
const TEMPLATE_BY_ID = new Map(TEMPLATES.map((t) => [t.id, t]));

module.exports = { TEMPLATES, TEMPLATE_INDEX, TEMPLATE_BY_ID };
