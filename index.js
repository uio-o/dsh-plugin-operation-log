/**
 * Host half of the operation-log plugin.
 *
 * Registers one `ctx.sessionProjections` unit (`operationLog`) that purely
 * folds existing session events — never a new event type — into a per-turn
 * breakdown of Skill calls, MCP calls, other tool calls, file targets, error
 * detail, and the task list each turn ran under. It also exposes optional,
 * authenticated Fetch routes for the Client's file-existence and Git sections,
 * each guarded so a missing service (`connection`, `shell`, `fs`) never breaks
 * the projection half.
 *
 * Classification is a best-effort two-axis tag (source: agent/skill/mcp;
 * kind: file-read/file-write/file-create/command/search/skill/mcp/tool).
 * Harness-native tool names are classified exactly; MCP inner-method names are
 * classified by a naming heuristic and marked `kindConfidence: "heuristic"` so
 * the UI can show "推测" rather than presenting a guess as fact.
 *
 * Retained detail is bounded on purpose: this state is checkpointed, so every
 * string field has a cap and retained error excerpts are a bounded FIFO.
 */

/** The projection registry is the plugin's whole purpose; without it the fiber stays pending. */
export const inject = ["sessionProjections"];

/**
 * Minimal local schema helpers (no external dependency: a `link:`-mounted
 * bundle cannot rely on undeclared packages resolving). Each validator is a
 * function `(value, path) => void` that throws a descriptive TypeError on
 * mismatch, and each composite exposes `.parse(value)` for the projection
 * registry's checkpoint-validation contract.
 */
const Types = {
	string(value, path) {
		if (typeof value !== "string") throw new TypeError(`${path}: expected string`);
	},
	number(value, path) {
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${path}: expected non-negative safe integer`);
	},
	boolean(value, path) {
		if (typeof value !== "boolean") throw new TypeError(`${path}: expected boolean`);
	}
};

/**
 * Wrap one base validator with `| null`.
 * @param {Function} base - the underlying validator.
 * @returns {Function} a validator accepting null as well.
 */
function nullable(base) {
	return (value, path) => {
		if (value === null) return;
		base(value, path);
	};
}

/**
 * Build an object validator over a field map; unknown keys are rejected.
 *
 * `parse()` mirrors the one zod contract the projection registry relies on:
 * it RETURNS the value it validated, because the registry assigns that return
 * value directly (`state = schema.parse(row)` and
 * `values[key] = viewSchema.parse(view)`). Returning nothing would erase both
 * the fold state and the Client-visible view.
 * @param {Record<string, Function>} fields - field name to validator.
 * @returns {{parse: (value: unknown) => unknown}} the validator with parse().
 */
function objectOf(fields) {
	return {
		parse(value) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("expected object");
			for (const key of Object.keys(value)) {
				if (!Object.hasOwn(fields, key)) throw new TypeError(`${key}: unknown field`);
			}
			for (const [key, check] of Object.entries(fields)) {
				check(value[key], key);
			}
			return value;
		}
	};
}

/**
 * Build a string-enum validator.
 * @param {string[]} values - allowed strings.
 * @returns {Function} the validator.
 */
function enumOf(values) {
	return (value, path) => {
		if (typeof value !== "string" || !values.includes(value)) throw new TypeError(`${path}: expected one of ${values.join("|")}`);
	};
}

/**
 * Build an array validator over one element validator.
 * @param {Function} element - the element validator.
 * @returns {Function} the validator.
 */
function arrayOf(element) {
	return (value, path) => {
		if (!Array.isArray(value)) throw new TypeError(`${path}: expected array`);
		value.forEach((item, index) => element(item, `${path}[${index}]`));
	};
}

/**
 * Build a record validator: plain object keyed by string, values validated.
 * @param {Function} value - the value validator.
 * @returns {Function} the validator.
 */
function recordOf(value) {
	return (target, path) => {
		if (typeof target !== "object" || target === null || Array.isArray(target)) throw new TypeError(`${path}: expected object`);
		for (const [key, item] of Object.entries(target)) value(item, `${path}.${key}`);
	};
}

/** The PTC run_code container tool name: tracked for callId→(turn,step) lookup, excluded from Skill/MCP stats. */
const PTC_CONTAINER_TOOL = "run_code";

/** Tool names whose arguments name one workspace file this plugin shows as a target. */
const FILE_TOOLS = new Set(["read", "read_image", "write", "edit"]);

/** The skill loader: its `name` argument is the skill that was loaded. */
const SKILL_TOOL = "skill";

/** Caps on retained detail: this state is checkpointed, so every field is bounded. */
const MAX_TARGET_CHARS = 512;
const MAX_ERROR_TEXT_CHARS = 2048;
const MAX_ERROR_EXCERPTS = 300;
const MAX_TODOS = 50;
const MAX_TODO_CHARS = 500;

/**
 * Coerce a turn/step ordinal to a non-negative integer, or null when the event
 * carries none. Never guesses: an absent ordinal stays unknown.
 * @param value - the raw field value.
 * @returns the ordinal, or null.
 */
function asOrdinal(value) {
	return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Truncate a string field to its retention cap.
 * @param value - the raw field value.
 * @param max - the cap in characters.
 * @returns the string, or null when absent/empty.
 */
function asText(value, max) {
	if (typeof value !== "string" || value.length === 0) return null;
	return value.length > max ? value.slice(0, max) : value;
}

/**
 * Extract the file a file tool was called with, from the raw argument JSON.
 * The model's arguments are the only place a read's path exists; a malformed or
 * absent payload yields no target rather than a guess.
 * @param argumentsJson - the `arguments` string carried by the call event.
 * @returns the path, or null.
 */
function fileTargetFrom(argumentsJson) {
	if (typeof argumentsJson !== "string") return null;
	let parsed;
	try {
		parsed = JSON.parse(argumentsJson);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	return asText(parsed.file_path ?? parsed.path ?? parsed.filePath, MAX_TARGET_CHARS);
}

/**
 * The name of the skill a `skill` call loaded. The loader's only argument is
 * `name`, so this is the exact skill the model asked for — the detail a bare
 * "skill" row cannot show.
 * @param argumentsJson - the `arguments` string carried by the call event.
 * @returns the skill name, or null.
 */
function skillNameFrom(argumentsJson) {
	if (typeof argumentsJson !== "string") return null;
	let parsed;
	try {
		parsed = JSON.parse(argumentsJson);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	return asText(parsed.name, MAX_TARGET_CHARS);
}

/**
 * The retained subject of one call: the file a file tool acted on, the skill a
 * skill call loaded, or nothing. Never guessed from a malformed payload.
 * @param toolName - the tool's wire name.
 * @param argumentsJson - the call's raw arguments.
 * @returns the subject, or null.
 */
function subjectOf(toolName, argumentsJson) {
	if (toolName === SKILL_TOOL) return skillNameFrom(argumentsJson);
	if (FILE_TOOLS.has(toolName)) return fileTargetFrom(argumentsJson);
	return null;
}

/**
 * Flatten a tool result's content into plain text, defensively: content is a
 * block array in practice, but a shape change must not throw inside `apply`.
 * @param content - the raw content value.
 * @returns the flattened text (possibly empty).
 */
function textFromContent(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts = [];
		for (const block of content) {
			if (typeof block === "string") {
				parts.push(block);
				continue;
			}
			if (block === null || typeof block !== "object") continue;
			if (typeof block.text === "string") parts.push(block.text);
			else if (typeof block.content === "string") parts.push(block.content);
			else if (typeof block.value === "string") parts.push(block.value);
		}
		return parts.join("\n");
	}
	if (content !== null && typeof content === "object" && typeof content.text === "string") return content.text;
	return "";
}

/**
 * Build the retained error detail for one failed call: the structured triple
 * the harness attaches plus a bounded excerpt of the reported text.
 * @param errorInfo - the event's `error` field, when present.
 * @param content - the result content to excerpt.
 * @returns the detail, or null when nothing is known.
 */
function errorDetailFrom(errorInfo, content) {
	const name = asText(errorInfo?.name, 200);
	const code = asText(errorInfo?.code, 200);
	const reason = asText(errorInfo?.reason, 500);
	const text = textFromContent(content);
	const truncated = text.length > MAX_ERROR_TEXT_CHARS;
	const kept = truncated ? text.slice(0, MAX_ERROR_TEXT_CHARS) : text;
	if (name === null && code === null && reason === null && kept.length === 0) return null;
	return { name, code, reason, text: kept, truncated };
}

/**
 * Normalize one `todo/write` payload into the retained task list.
 * @param value - the event's `todos` field.
 * @returns the normalized list, or null when the payload is not a list.
 */
function normalizeTodos(value) {
	if (!Array.isArray(value)) return null;
	const todos = [];
	for (const item of value.slice(0, MAX_TODOS)) {
		const content = asText(item?.content, MAX_TODO_CHARS);
		const status = item?.status;
		if (content === null) continue;
		if (status !== "pending" && status !== "in_progress" && status !== "completed") continue;
		todos.push({ content, status });
	}
	return todos;
}

/**
 * Classify a tool name into the two-axis tag. Harness-native names get an
 * exact tag; everything else (including MCP inner methods) is a heuristic.
 * @param toolName - the raw tool name as it appears in `tool/call`/`tool/ptc-dispatch(-start)`.
 * @returns the classification, with `excluded` set only for the PTC container tool itself.
 */
function classify(toolName) {
	if (toolName === PTC_CONTAINER_TOOL) {
		return {
			source: "agent",
			kind: "tool",
			kindConfidence: "exact",
			excluded: true
		};
	}
	if (toolName === "skill") {
		return {
			source: "skill",
			kind: "skill",
			kindConfidence: "exact",
			excluded: false
		};
	}
	// MCP tools are named `mcp__<server>__<method>`. The method routinely contains
	// underscores (`create_repository`, `get_file_contents`), so the separator is
	// the first `__` after the server segment — never a "last segment has no
	// underscore" pattern, which silently misclassifies most real MCP tools.
	const mcp = splitMcpName(toolName);
	if (mcp !== void 0) {
		return {
			source: "mcp",
			kind: mcpInnerKind(mcp.method),
			kindConfidence: "heuristic",
			excluded: false
		};
	}
	switch (toolName) {
		case "read":
		case "read_image":
			return {
				source: "agent",
				kind: "file-read",
				kindConfidence: "exact",
				excluded: false
			};
		case "write":
			return {
				source: "agent",
				kind: "file-create",
				kindConfidence: "exact",
				excluded: false
			};
		case "edit":
			return {
				source: "agent",
				kind: "file-write",
				kindConfidence: "exact",
				excluded: false
			};
		case "glob":
		case "grep":
			return {
				source: "agent",
				kind: "search",
				kindConfidence: "exact",
				excluded: false
			};
		case "web_search":
		case "web_fetch":
		case "advanced_search":
		case "multi_search":
		case "platform_search":
		case "video_search":
			return {
				source: "agent",
				kind: "search",
				kindConfidence: "exact",
				excluded: false
			};
		case "pwsh":
		case "shell":
			return {
				source: "agent",
				kind: "command",
				kindConfidence: "exact",
				excluded: false
			};
		default:
			return {
				source: "agent",
				kind: "tool",
				kindConfidence: "heuristic",
				excluded: false
			};
	}
}

/**
 * Split an MCP tool name `mcp__<server>__<method>` into its parts.
 *
 * The method may contain underscores, so the separator is the first `__` after
 * the server segment; a server name containing a double underscore is not a
 * shape the Harness produces.
 * @param toolName - the raw wire tool name.
 * @returns the parts, or undefined when the name is not an MCP tool.
 */
function splitMcpName(toolName) {
	if (!toolName.startsWith("mcp__")) return void 0;
	const rest = toolName.slice(5);
	const separator = rest.indexOf("__");
	if (separator <= 0 || separator + 2 >= rest.length) return void 0;
	return {
		server: rest.slice(0, separator),
		method: rest.slice(separator + 2)
	};
}

/**
 * Heuristic kind for one MCP tool's inner method name, by naming convention
 * only — never asserted as exact. Deliberately conservative: an unmatched
 * method stays the generic `mcp` kind rather than claiming a file operation it
 * may not perform (e.g. `create_repository` is not a file creation).
 * @param inner - the inner method name, e.g. "write_file" from "mcp__fs__write_file".
 * @returns the best-guess kind.
 */
function mcpInnerKind(inner) {
	const lower = inner.toLowerCase();
	if (/(^|_)(write|put|upload|edit|modify|update|patch|append)_?(file|files|content|contents)?$/.test(lower)) return "file-write";
	if (/(^|_)(create|new|make|mkdir)_?(file|files|directory|dir|folder)$/.test(lower)) return "file-create";
	if (/(^|_)(read|get|download|fetch)_?(file|files|content|contents|text|blob)$/.test(lower)) return "file-read";
	if (/(^|_)(search|query|find|grep|glob|list)/.test(lower)) return "search";
	if (/(^|_)(execute|run|command|terminal|shell|exec|spawn)/.test(lower)) return "command";
	return "mcp";
}

const SOURCE_VALUES = ["agent", "skill", "mcp"];
const KIND_VALUES = ["file-read", "file-write", "file-create", "command", "search", "skill", "mcp", "tool"];
const CONFIDENCE_VALUES = ["exact", "heuristic"];
const TODO_STATUS_VALUES = ["pending", "in_progress", "completed"];

/** The retained error detail of one failed call. */
const errorDetailSchema = objectOf({
	name: nullable(Types.string),
	code: nullable(Types.string),
	reason: nullable(Types.string),
	text: Types.string,
	truncated: Types.boolean
});

/** One call record kept in fold state, keyed by its callId (top-level) or subCallId (PTC). */
const callRecordSchema = objectOf({
	name: Types.string,
	source: enumOf(SOURCE_VALUES),
	kind: enumOf(KIND_VALUES),
	kindConfidence: enumOf(CONFIDENCE_VALUES),
	excluded: Types.boolean,
	nested: Types.boolean,
	turn: nullable(Types.number),
	step: nullable(Types.number),
	isError: nullable(Types.boolean),
	target: nullable(Types.string),
	startedAt: nullable(Types.number),
	endedAt: nullable(Types.number),
	error: nullable(errorDetailSchema.parse)
});

/** One retained task item, as the task panel lists it. */
const todoItemSchema = objectOf({
	content: Types.string,
	status: enumOf(TODO_STATUS_VALUES)
});

/** Fold state: every call seen, the latest change seq per turn, and the task snapshot per turn. */
const operationLogStateSchema = objectOf({
	calls: recordOf(callRecordSchema.parse),
	fileChangeSeqByTurn: recordOf(Types.number),
	todoByTurn: recordOf(arrayOf(todoItemSchema.parse)),
	currentTurn: nullable(Types.number),
	errorQueue: arrayOf(Types.string)
});

/** One call as served to the Client. */
const callViewSchema = objectOf({
	callId: Types.string,
	name: Types.string,
	source: enumOf(SOURCE_VALUES),
	kind: enumOf(KIND_VALUES),
	kindConfidence: enumOf(CONFIDENCE_VALUES),
	nested: Types.boolean,
	step: nullable(Types.number),
	isError: nullable(Types.boolean),
	target: nullable(Types.string),
	durationMs: nullable(Types.number),
	error: nullable(errorDetailSchema.parse)
});

/** One turn's breakdown as served to the Client. */
const turnViewSchema = objectOf({
	turn: Types.number,
	skillCalls: Types.number,
	mcpCalls: Types.number,
	otherCalls: Types.number,
	errorCalls: Types.number,
	pendingResultCalls: Types.number,
	calls: arrayOf(callViewSchema.parse),
	fileChangeSeq: nullable(Types.number),
	todos: arrayOf(todoItemSchema.parse),
	todoUpdated: Types.boolean
});

/** The Client-visible view: per-turn breakdown plus PTC calls whose root turn/step could not be resolved. */
const operationLogViewSchema = objectOf({
	turns: arrayOf(turnViewSchema.parse),
	unattributed: arrayOf(callViewSchema.parse)
});

/**
 * Build the view's per-call shape from one fold record.
 * @param callId - the record's key.
 * @param record - the fold record.
 * @returns the Client-visible call.
 */
function toCallView(callId, record) {
	const durationMs = record.startedAt !== null && record.endedAt !== null && record.endedAt >= record.startedAt ? record.endedAt - record.startedAt : null;
	return {
		callId,
		name: record.name,
		source: record.source,
		kind: record.kind,
		kindConfidence: record.kindConfidence,
		nested: record.nested,
		step: record.step,
		isError: record.isError,
		target: record.target,
		durationMs,
		error: record.error
	};
}

/**
 * Store one finished call record, maintaining the bounded FIFO of retained
 * error excerpts: past the cap the oldest excerpt text is released while its
 * structured code stays, so the state cannot grow without limit.
 * @param state - the current fold state.
 * @param callId - the record's key.
 * @param record - the record to store.
 * @returns the next state.
 */
function commitCall(state, callId, record) {
	const calls = { ...state.calls, [callId]: record };
	const queue = Array.isArray(state.errorQueue) ? state.errorQueue : [];
	if (record.error === null || record.error.text.length === 0) return { ...state, calls, errorQueue: queue };
	const errorQueue = [...queue, callId];
	while (errorQueue.length > MAX_ERROR_EXCERPTS) {
		const dropped = errorQueue.shift();
		const prior = calls[dropped];
		if (prior !== void 0 && prior.error !== null && prior.error.text.length > 0) {
			calls[dropped] = { ...prior, error: { ...prior.error, text: "", truncated: true } };
		}
	}
	return { ...state, calls, errorQueue };
}

/** Single-entry memo backing `view()`'s reference-stability contract. */
let lastViewedState = void 0;
/** The view produced for {@link lastViewedState}. */
let lastView = void 0;

/** The `operationLog` unit registered on `ctx.sessionProjections`. */
const operationLogProjectionDefinition = {
	key: "operationLog",
	stateVersion: 2,
	stateSchema: operationLogStateSchema,
	init: () => ({
		calls: {},
		fileChangeSeqByTurn: {},
		todoByTurn: {},
		currentTurn: null,
		errorQueue: []
	}),
	apply: (state, event) => {
		// Every case guards its own inputs: `apply` is pure and must never throw,
		// because a throw here would break this Session's whole projection
		// pipeline. A malformed or unexpected event is ignored, not guessed at.
		switch (event.type) {
			case "turn/start": {
				const turn = asOrdinal(event.data?.turn);
				if (turn === null || state.currentTurn === turn) return state;
				return { ...state, currentTurn: turn };
			}
			case "todo/write": {
				if (state.currentTurn === null) return state;
				const todos = normalizeTodos(event.data?.todos);
				if (todos === null) return state;
				return {
					...state,
					todoByTurn: {
						...state.todoByTurn,
						[String(state.currentTurn)]: todos
					}
				};
			}
			case "tool/call": {
				const data = event.data;
				if (typeof data?.callId !== "string" || typeof data.name !== "string") return state;
				const tag = classify(data.name);
				return commitCall(state, data.callId, {
					name: data.name,
					source: tag.source,
					kind: tag.kind,
					kindConfidence: tag.kindConfidence,
					excluded: tag.excluded,
					nested: false,
					turn: asOrdinal(data.turn),
					step: asOrdinal(data.step),
					isError: null,
					target: subjectOf(data.name, data.arguments),
					startedAt: Number.isSafeInteger(event.time) ? event.time : null,
					endedAt: null,
					error: null
				});
			}
			case "tool/result": {
				// ToolResultMessage carries both the direct `toolCallId` and the
				// provenance `source.callId`; either names the same call, so read the
				// direct field first and fall back to the source.
				const message = event.data?.message;
				const callId = message?.toolCallId ?? message?.source?.callId;
				if (typeof callId !== "string") return state;
				const existing = Object.hasOwn(state.calls, callId) ? state.calls[callId] : void 0;
				if (existing === void 0) return state;
				const isError = message.isError === true;
				return commitCall(state, callId, {
					...existing,
					isError,
					endedAt: Number.isSafeInteger(event.time) ? event.time : null,
					error: isError ? errorDetailFrom(event.data?.error, message.content) : null
				});
			}
			case "tool/ptc-dispatch-start": {
				const data = event.data;
				if (typeof data?.subCallId !== "string" || typeof data.name !== "string") return state;
				const root = typeof data.rootCallId === "string" && Object.hasOwn(state.calls, data.rootCallId) ? state.calls[data.rootCallId] : void 0;
				const tag = classify(data.name);
				return commitCall(state, data.subCallId, {
					name: data.name,
					source: tag.source,
					kind: tag.kind,
					kindConfidence: tag.kindConfidence,
					excluded: tag.excluded,
					nested: true,
					turn: root?.turn ?? null,
					step: root?.step ?? null,
					isError: null,
					target: subjectOf(data.name, data.arguments),
					startedAt: Number.isSafeInteger(event.time) ? event.time : null,
					endedAt: null,
					error: null
				});
			}
			case "tool/ptc-dispatch": {
				const data = event.data;
				if (typeof data?.subCallId !== "string") return state;
				const existing = Object.hasOwn(state.calls, data.subCallId) ? state.calls[data.subCallId] : void 0;
				const isError = data.isError === true;
				if (existing !== void 0) {
					return commitCall(state, data.subCallId, {
						...existing,
						isError,
						endedAt: Number.isSafeInteger(event.time) ? event.time : null,
						error: isError ? errorDetailFrom(data.error, data.content) : null
					});
				}
				if (typeof data.name !== "string") return state;
				const root = typeof data.rootCallId === "string" && Object.hasOwn(state.calls, data.rootCallId) ? state.calls[data.rootCallId] : void 0;
				const tag = classify(data.name);
				return commitCall(state, data.subCallId, {
					name: data.name,
					source: tag.source,
					kind: tag.kind,
					kindConfidence: tag.kindConfidence,
					excluded: tag.excluded,
					nested: true,
					turn: root?.turn ?? null,
					step: root?.step ?? null,
					isError,
					target: subjectOf(data.name, data.arguments),
					startedAt: null,
					endedAt: Number.isSafeInteger(event.time) ? event.time : null,
					error: isError ? errorDetailFrom(data.error, data.content) : null
				});
			}
			case "workspace/changes": {
				const turn = event.data?.turn;
				if (!Number.isSafeInteger(turn) || !Number.isSafeInteger(event.seq)) return state;
				const key = String(turn);
				if (state.fileChangeSeqByTurn[key] === event.seq) return state;
				return {
					...state,
					fileChangeSeqByTurn: {
						...state.fileChangeSeqByTurn,
						[key]: event.seq
					}
				};
			}
			default:
				return state;
		}
	},
	wire: {
		viewSchema: operationLogViewSchema,
		view: (state) => {
			// The registry publishes on reference change, so an unchanged state
			// reference must yield the identical view object. Distinct Sessions
			// hold distinct state objects, so a single-entry memo cannot collide.
			if (state === lastViewedState) return lastView;
			const byTurn = new Map();
			const unattributed = [];
			for (const [callId, record] of Object.entries(state.calls)) {
				if (record.excluded) continue;
				if (record.turn === null) {
					unattributed.push(toCallView(callId, record));
					continue;
				}
				let bucket = byTurn.get(record.turn);
				if (bucket === void 0) {
					bucket = [];
					byTurn.set(record.turn, bucket);
				}
				bucket.push([callId, record]);
			}
			// The task list carries forward: a turn that wrote no todos ran under
			// the last list that was written, which is what the task panel showed.
			let carriedTodos = [];
			const turns = [...byTurn.keys()].sort((a, b) => a - b).map((turn) => {
				const records = byTurn.get(turn);
				let skillCalls = 0;
				let mcpCalls = 0;
				let otherCalls = 0;
				let errorCalls = 0;
				let pendingResultCalls = 0;
				for (const [, record] of records) {
					if (record.source === "skill") skillCalls += 1;
					else if (record.source === "mcp") mcpCalls += 1;
					else otherCalls += 1;
					if (record.isError === true) errorCalls += 1;
					else if (record.isError === null) pendingResultCalls += 1;
				}
				const key = String(turn);
				const todoUpdated = Object.hasOwn(state.todoByTurn, key);
				if (todoUpdated) carriedTodos = state.todoByTurn[key];
				const fileChangeSeq = Object.hasOwn(state.fileChangeSeqByTurn, key) ? state.fileChangeSeqByTurn[key] : null;
				return {
					turn,
					skillCalls,
					mcpCalls,
					otherCalls,
					errorCalls,
					pendingResultCalls,
					calls: records.map(([callId, record]) => toCallView(callId, record)),
					fileChangeSeq,
					todos: carriedTodos,
					todoUpdated
				};
			});
			const view = { turns, unattributed };
			lastViewedState = state;
			lastView = view;
			return view;
		}
	}
};

/** Authenticated GET route: `git status --porcelain` for one Session's cwd. */
const GIT_STATUS_PATH = "/api/operation-log.git-status";
/** Authenticated GET route: `git diff` for one path inside one Session's cwd. */
const GIT_DIFF_PATH = "/api/operation-log.git-diff";
/** Authenticated POST route: whether each named workspace file still exists. */
const FILES_EXIST_PATH = "/api/operation-log.files-exist";

/** Cap on paths one existence probe may carry. */
const MAX_EXISTENCE_PATHS = 200;

/**
 * Validate a workspace-relative path argument: no shell metacharacters that
 * could break out of the quoted `git diff -- "<path>"` argument.
 * @param path - the raw query parameter.
 * @returns the path, or undefined when it looks unsafe or absent.
 */
function safeRelativePath(path) {
	if (path === null || path.length === 0) return void 0;
	if (/["`$\\]/.test(path)) return void 0;
	return path;
}

/**
 * Register one Fetch route as a disposed effect, so disabling or reloading the
 * plugin releases its path instead of colliding on re-enable.
 * @param ctx - the context owning the route's lifetime.
 * @param label - the effect label.
 * @param route - the route to register.
 */
function registerRoute(ctx, label, route) {
	ctx.effect(() => {
		const dispose = ctx.connection.fetch.register(route);
		return () => {
			void dispose();
		};
	}, label);
}

/**
 * Register the Git-section routes inside Connection's authentication fence.
 * Both routes resolve, never reject, for ordinary git failures (not-a-repo, no
 * such path): the Client reads `exitCode`/`timedOut` to render an honest
 * "非 Git 仓库" / "未知" state instead of a generic error.
 * @param ctx - context carrying `connection` and `shell`.
 */
function registerGitRoutes(ctx) {
	registerRoute(ctx, "operation-log: git-status route", {
		path: GIT_STATUS_PATH,
		methods: ["GET"],
		requestBody: "buffered",
		fetch: async (request) => {
			const cwd = new URL(request.url).searchParams.get("cwd");
			if (cwd === null || cwd.length === 0) return new Response("Missing cwd.", { status: 400 });
			const spec = ctx.shell.resolve({
				command: "git status --porcelain=v1 -z",
				workdir: cwd,
				timeoutMs: 10000,
				onExpiry: "kill"
			});
			const execution = await ctx.shell.execute(spec);
			const result = await execution.result();
			if (result.timedOut || result.aborted) return Response.json({ status: "unknown", reason: result.timedOut ? "timeout" : "aborted" }, { headers: { "cache-control": "no-store" } });
			if (result.exitCode !== 0) return Response.json({ status: "not-a-repo" }, { headers: { "cache-control": "no-store" } });
			const entries = result.stdout.text.split("\0").filter((entry) => entry.length > 0).map((entry) => ({
				code: entry.slice(0, 2),
				path: entry.slice(3)
			}));
			return Response.json({
				status: "ok",
				truncated: result.stdout.truncated,
				entries
			}, { headers: { "cache-control": "no-store" } });
		}
	});
	registerRoute(ctx, "operation-log: git-diff route", {
		path: GIT_DIFF_PATH,
		methods: ["GET"],
		requestBody: "buffered",
		fetch: async (request) => {
			const query = new URL(request.url).searchParams;
			const cwd = query.get("cwd");
			const path = safeRelativePath(query.get("path"));
			if (cwd === null || cwd.length === 0 || path === void 0) return new Response("Missing or unsafe cwd/path.", { status: 400 });
			const spec = ctx.shell.resolve({
				command: `git diff -- "${path}"`,
				workdir: cwd,
				timeoutMs: 10000,
				onExpiry: "kill"
			});
			const execution = await ctx.shell.execute(spec);
			const result = await execution.result();
			if (result.timedOut || result.aborted) return Response.json({ status: "unknown", reason: result.timedOut ? "timeout" : "aborted" }, { headers: { "cache-control": "no-store" } });
			if (result.exitCode !== 0) return Response.json({ status: "not-a-repo" }, { headers: { "cache-control": "no-store" } });
			return Response.json({
				status: "ok",
				truncated: result.stdout.truncated,
				diff: result.stdout.text
			}, { headers: { "cache-control": "no-store" } });
		}
	});
}

/**
 * Register the file-existence probe. A path resolves to `present`, `missing`,
 * or `unknown`: a failed resolve/stat is NOT proof of deletion, so it stays
 * unknown rather than being reported as removed.
 * @param ctx - context carrying `connection` and `fs`.
 */
function registerFileRoutes(ctx) {
	registerRoute(ctx, "operation-log: files-exist route", {
		path: FILES_EXIST_PATH,
		methods: ["POST"],
		requestBody: "buffered",
		fetch: async (request) => {
			let body;
			try {
				body = await request.json();
			} catch {
				return new Response("Bad JSON body.", { status: 400 });
			}
			const cwd = typeof body?.cwd === "string" && body.cwd.length > 0 ? body.cwd : null;
			const requested = Array.isArray(body?.paths) ? body.paths : [];
			const paths = [...new Set(requested.filter((path) => typeof path === "string" && path.length > 0))].slice(0, MAX_EXISTENCE_PATHS);
			const results = {};
			if (cwd !== null) {
				for (const path of paths) {
					try {
						const target = await ctx.fs.resolve(path, { cwd });
						const info = await ctx.fs.stat(target);
						results[path] = info === undefined ? "missing" : "present";
					} catch {
						results[path] = "unknown";
					}
				}
			} else {
				for (const path of paths) results[path] = "unknown";
			}
			return Response.json({ checkedAt: Date.now(), results }, { headers: { "cache-control": "no-store" } });
		}
	});
}

/**
 * Register the `operationLog` projection unit, plus each optional route group
 * when its services are present in this profile.
 * @param ctx - registrant context carrying the projection registry.
 */
export function apply(ctx) {
	ctx.sessionProjections.register(operationLogProjectionDefinition);
	ctx.inject(["connection", "shell"], (scoped) => {
		registerGitRoutes(scoped);
	});
	ctx.inject(["connection", "fs"], (scoped) => {
		registerFileRoutes(scoped);
	});
}
