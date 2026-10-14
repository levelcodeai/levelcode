// The engine's execution limits, every one of them, explicit. just-bash resolves a limit that is not given from a
// profile ("normal": an hour, 256 MiB of output, 1 GiB of file system), and a key it does not know is ignored
// without a word, so the table here is the ONLY thing in force and a test dumps `ctx.limits` of a running command to
// prove it: its keys equal this object's keys, and its values equal these values.
//
// README §7 fixes the first group. The others are bounds on work and memory that README does not name, chosen so that
// nothing the engine can be asked to do holds more than a few tens of MiB or runs for more than seconds without a
// limit speaking first. The host's own timer (agent.js commandTimeout, Ctrl+C) is what a person actually waits for.
'use strict';
// @ts-check

const MiB = 1024 * 1024;

const LIMITS = Object.freeze({
	// --- README §7
	maxCommandCount: 100000,
	maxLoopIterations: 100000,
	maxCallDepth: 100,
	maxOutputSize: 8 * MiB,
	maxStringLength: 16 * MiB,
	maxLiveBytes: 64 * MiB,
	maxInputBytes: 32 * MiB,
	maxExecutionTimeMs: 600000,

	// --- the same order of magnitude, for the loops inside a program
	maxAwkIterations: 100000,
	maxSedIterations: 100000,
	maxJqIterations: 1000000,
	maxWorkUnits: 100000000,

	// --- what a script can nest or expand
	// (the parser has a limit of its own that nothing here sets: a script, heredocs included, of more than 1,000,000
	// bytes is "Input too large", whatever maxSourceBytes and maxHeredocSize say; the host sees a syntax error, status 2)
	maxSourceBytes: 8 * MiB,
	maxExecDepth: 64,
	maxSubstitutionDepth: 50,
	maxSourceDepth: 100,
	maxHeredocSize: 16 * MiB,
	maxArrayElements: 100000,
	maxBraceExpansionResults: 100000,
	maxFileDescriptors: 1024,

	// --- walking the workspace: each entry is a read through the host
	maxTraversalEntries: 100000,
	maxTraversalDepth: 256,
	maxTraversalWork: 100000,
	maxGlobOperations: 100000,

	// --- parsers of jq / awk / csv
	maxQueryTokens: 25000,
	maxQueryDepth: 256,
	maxQueryElements: 100000,
	maxAwkParserTokens: 25000,
	maxAwkParserDepth: 128,
	maxAwkParserOperations: 100000,
	maxCsvRows: 100000,
	maxCsvCells: 1000000,

	// --- programs this shell does not have (kept at the smallest values the engine uses, so a future program
	//     that appears in the list does not arrive with a library default)
	maxFileSystemBytes: 128 * MiB,
	maxDatabaseBytes: 64 * MiB,
	maxDatabaseResultBytes: 16 * MiB,
	maxArchiveBytes: 128 * MiB,
	maxArchiveCompressedBytes: 64 * MiB,
	maxArchiveEntryBytes: 64 * MiB,
	maxArchiveEntries: 100000,
	maxWorkerMessageBytes: 16 * MiB,
	maxSqliteTimeoutMs: 5000,
	maxPythonTimeoutMs: 10000,
	maxJsTimeoutMs: 10000,
	maxJsBridgeRequests: 100000,
	maxExtensionCleanupTimeMs: 100,
});

module.exports = { LIMITS };
