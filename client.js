/**
 * Client half of the operation-log plugin.
 *
 * Renders the per-session "操作日志" view as a `sidebar.right.pane.tab`
 * (session-scoped, consistent with every other per-session detail), opened from
 * a `conversation.session.header.utilities` button. The tab reads the Host
 * `operationLog` session projection through `useProjection` and the Session's
 * working directory through `useSessions` — the two readings the shipped
 * pane-tab bodies use.
 *
 * The visual language follows Abu's structure (warm-neutral surface hierarchy,
 * hairline dividers, soft tinted chips, tinted icon tiles, icon + count +
 * chevron section headers, grid-row expand/collapse), while every colour
 * resolves through the Harness theme tokens so light/dark and third-party
 * themes stay correct. The soft badge backgrounds come from `color-mix` over a
 * token rather than a hardcoded palette.
 *
 * Every field read from the Host view is treated as optional: a Host running an
 * older unit version publishes a narrower view, and that skew must degrade to
 * missing detail rather than a blank pane.
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-operation-log",
	factory(require) {
		const react = require("react");
		const { useState, useEffect, useCallback, useMemo } = react;

		const TAB_ID = "dsh-plugin-operation-log/tab";
		const TAB_KIND = "operationLogTab";
		const NS = "operation-log";

		/** Rows one turn renders before it offers "expand the rest". */
		const MAX_ROWS_PER_TURN = 12;
		/** Turns the activity list renders before it offers "show earlier turns". */
		const INITIAL_TURNS = 10;
		/** Turns one "show earlier" step adds. */
		const TURN_PAGE = 20;
		/** Distinct file paths one existence probe carries. */
		const MAX_PROBE_PATHS = 200;
		/** Characters the Host keeps per retained error excerpt. */
		const ERROR_EXCERPT_CHARS = 2048;

		const zh = {
			"panel.title": "操作日志",
			"header.button": "操作日志",
			"tab.title": "操作日志",
			"overview.title": "概览",
			"overview.errors": "{errors} 出错",
			"overview.filterAll": "全部",
			"overview.filterSkill": "Skill",
			"overview.filterMcp": "MCP",
			"overview.filterOther": "其他工具",
			"overview.filterError": "出错",
			"overview.filterHint": "点数字可筛选",
			"tasks.title": "任务",
			"tasks.count": "{done}/{total} 完成",
			"tasks.updated": "本轮更新",
			"tasks.none": "本会话没有任务清单记录",
			"tasks.noNumber": "任务栏本身不编号，这里按文本对应",
			"activity.title": "活动日志",
			"activity.count": "{calls} 次调用",
			"activity.empty": "本会话暂无记录",
			"activity.more": "展开其余 {count} 条",
			"activity.less": "收起",
			"activity.earlier": "显示更早的 {count} 轮",
			"activity.turn": "第 {turn} 轮",
			"activity.unattributed": "归属未知的子调用",
			"activity.unattributedHint": "以下调用未能定位到具体轮次或步骤，可能发生在跨会话委派链路中（归属未知）。",
			"filter.title": "筛选结果",
			"filter.byTool": "按工具聚合",
			"filter.bySkill": "按 Skill 聚合",
			"filter.byFile": "按文件聚合",
			"filter.turns": "涉及轮次",
			"filter.clear": "清除筛选",
			"filter.none": "没有符合条件的调用",
			"files.title": "文件",
			"files.summary": "{files} 个文件 · {missing} 个已删除",
			"files.empty": "本会话没有文件读写记录",
			"files.reads": "读 {count}",
			"files.writes": "写 {count}",
			"files.lastTurn": "第 {turn} 轮",
			"files.deleted": "已删除",
			"files.probed": "存在性检测于 {time}",
			"files.probeFailed": "存在性未知（检测未完成）",
			"changes.title": "会话变化",
			"changes.empty": "本会话没有文件变化记录",
			"changes.turn": "第 {turn} 轮",
			"changes.loading": "正在读取",
			"changes.unknown": "文件变化状态未知（快照已失效或未记录）",
			"changes.binary": "二进制",
			"changes.oversized": "过大",
			"git.title": "Git 变化",
			"git.loading": "正在读取 git 状态",
			"git.notRepo": "当前工作目录不是 Git 仓库",
			"git.unknown": "Git 状态未知（{reason}）",
			"git.empty": "工作区无未提交变化",
			"git.diffLoading": "正在读取 diff",
			"git.diffUnavailable": "diff 不可用",
			"error.title": "错误详情",
			"error.name": "类型",
			"error.code": "代码",
			"error.text": "报错内容",
			"error.truncated": "已截断（仅保留前 {chars} 字符）",
			"error.dropped": "较早的报错正文已释放，仅保留错误码",
			"error.none": "该调用未记录错误正文",
			"error.copy": "复制",
			"error.copied": "已复制",
			"kind.file-read": "读文件",
			"kind.file-write": "改文件",
			"kind.file-create": "新建文件",
			"kind.command": "命令",
			"kind.search": "搜索",
			"kind.skill": "Skill",
			"kind.mcp": "MCP",
			"kind.tool": "工具",
			"heuristic.badge": "推测",
			"nested.badge": "嵌套",
			"status.pending": "待结果",
			"status.ok": "完成"
		};
		const en = {
			"panel.title": "Operation Log",
			"header.button": "Operation Log",
			"tab.title": "Operation Log",
			"overview.title": "Overview",
			"overview.errors": "{errors} errors",
			"overview.filterAll": "All",
			"overview.filterSkill": "Skill",
			"overview.filterMcp": "MCP",
			"overview.filterOther": "Other",
			"overview.filterError": "Errors",
			"overview.filterHint": "click a count to filter",
			"tasks.title": "Tasks",
			"tasks.count": "{done}/{total} done",
			"tasks.updated": "updated this turn",
			"tasks.none": "No task list recorded in this session",
			"tasks.noNumber": "The task panel numbers nothing; tasks match by text",
			"activity.title": "Activity",
			"activity.count": "{calls} calls",
			"activity.empty": "No records in this session yet",
			"activity.more": "Show the other {count}",
			"activity.less": "Collapse",
			"activity.earlier": "Show {count} earlier turns",
			"activity.turn": "Turn {turn}",
			"activity.unattributed": "Calls with unknown attribution",
			"activity.unattributedHint": "These calls could not be matched to a specific turn or step, likely from a cross-session delegation chain (attribution unknown).",
			"filter.title": "Filtered",
			"filter.byTool": "By tool",
			"filter.bySkill": "By skill",
			"filter.byFile": "By file",
			"filter.turns": "turns",
			"filter.clear": "Clear filter",
			"filter.none": "No calls match this filter",
			"files.title": "Files",
			"files.summary": "{files} files · {missing} deleted",
			"files.empty": "No file reads or writes recorded",
			"files.reads": "{count} reads",
			"files.writes": "{count} writes",
			"files.lastTurn": "turn {turn}",
			"files.deleted": "deleted",
			"files.probed": "existence checked at {time}",
			"files.probeFailed": "existence unknown (check did not complete)",
			"changes.title": "Session changes",
			"changes.empty": "No file-change records in this session",
			"changes.turn": "Turn {turn}",
			"changes.loading": "Loading",
			"changes.unknown": "File-change status unknown (snapshot expired or not recorded)",
			"changes.binary": "binary",
			"changes.oversized": "oversized",
			"git.title": "Git changes",
			"git.loading": "Reading git status",
			"git.notRepo": "Current working directory is not a Git repository",
			"git.unknown": "Git status unknown ({reason})",
			"git.empty": "No uncommitted changes",
			"git.diffLoading": "Loading diff",
			"git.diffUnavailable": "Diff unavailable",
			"error.title": "Error detail",
			"error.name": "Type",
			"error.code": "Code",
			"error.text": "Message",
			"error.truncated": "truncated (first {chars} characters kept)",
			"error.dropped": "an older excerpt was released; only the code is kept",
			"error.none": "No error text was recorded for this call",
			"error.copy": "Copy",
			"error.copied": "Copied",
			"kind.file-read": "Read file",
			"kind.file-write": "Edit file",
			"kind.file-create": "Create file",
			"kind.command": "Command",
			"kind.search": "Search",
			"kind.skill": "Skill",
			"kind.mcp": "MCP",
			"kind.tool": "Tool",
			"heuristic.badge": "guessed",
			"nested.badge": "nested",
			"status.pending": "pending",
			"status.ok": "ok"
		};

		const GIT_STATUS_ROUTE = "api/operation-log.git-status";
		const GIT_DIFF_ROUTE = "api/operation-log.git-diff";
		const FILES_EXIST_ROUTE = "api/operation-log.files-exist";
		const CHANGES_SUMMARY_ROUTE = "api/changes.summary";

		/** Inline outline icons: one shared 16-box geometry, stroke from currentColor. */
		const GLYPHS = {
			"file-read": ["M4 2.5h5l3 3v8h-8z", "M9 2.5v3h3"],
			"file-write": ["M4 2.5h5l3 3v8h-8z", "M9 2.5v3h3", "M6 10.5h4"],
			"file-create": ["M4 2.5h5l3 3v8h-8z", "M9 2.5v3h3", "M8 9.5v3", "M6.5 11h3"],
			command: ["M5 5.5l-2.5 2.5L5 10.5", "M11 5.5l2.5 2.5L11 10.5"],
			search: ["M7.2 12a4.8 4.8 0 1 0 0-9.6 4.8 4.8 0 0 0 0 9.6z", "M10.8 10.8L14 14"],
			skill: ["M8 2.2l1.7 3.4 3.8.5-2.8 2.6.7 3.7L8 10.6l-3.4 1.8.7-3.7L2.5 6.1l3.8-.5z"],
			mcp: ["M3 4.5h4v4H3z", "M9 7.5h4v4H9z", "M7 6.5h2", "M5 8.5v2"],
			tool: ["M9.5 3.5l3 3-4.2 4.2-3-3z", "M5.3 7.7L3 10v3h3l2.3-2.3"],
			error: ["M8 3v6", "M8 11.4v.2"],
			chevron: ["M6 4l4 4-4 4"],
			check: ["M3.5 8.5l3 3 6-6.5"],
			dot: ["M8 8h.01"],
			clock: ["M8 4v4l2.5 1.5", "M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z"],
			copy: ["M6 6h6.5v6.5H6z", "M10 6V3.5H3.5V10H6"],
			filter: ["M3 5h10", "M5.5 8h5", "M7.5 11h1"]
		};

		/**
		 * Render one inline outline glyph.
		 * @param props - `name` selects the geometry; `size` its box in px.
		 * @returns the svg element.
		 */
		function Glyph({ name, size }) {
			const paths = GLYPHS[name] ?? GLYPHS.tool;
			return react.createElement(
				"svg",
				{
					viewBox: "0 0 16 16",
					width: size ?? 14,
					height: size ?? 14,
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.4,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": true,
					style: { flex: "none", display: "block" }
				},
				paths.map((d, index) => react.createElement("path", { key: index, d }))
			);
		}

		/** Soft translucent tint of one theme token: the Abu badge technique, theme-native. */
		function tint(token, percent) {
			return `color-mix(in srgb, var(${token}) ${percent}%, transparent)`;
		}

		/** The token backing each semantic tone. */
		const TONE_TOKENS = {
			brand: "--dsw-alias-brand-primary",
			error: "--dsw-alias-state-error-primary",
			warn: "--dsw-alias-state-warn-primary",
			success: "--dsw-alias-state-success-primary",
			idle: "--dsw-alias-state-idle-primary"
		};

		/** The tone backing each call kind's icon tile. */
		const KIND_TONES = {
			"file-read": "brand",
			"file-write": "warn",
			"file-create": "success",
			command: "idle",
			search: "brand",
			skill: "brand",
			mcp: "brand",
			tool: "idle"
		};

		/**
		 * The tone one kind's chip uses.
		 * @param kind - the call kind.
		 * @returns the tone key.
		 */
		function toneOfKind(kind) {
			return KIND_TONES[kind] ?? "idle";
		}

		/**
		 * Format a duration for a row's muted meta column.
		 * @param ms - the duration in milliseconds, or null.
		 * @returns the label, or an empty string when unknown.
		 */
		function formatDuration(ms) {
			if (ms === null || ms === void 0) return "";
			if (ms < 1000) return `${ms} ms`;
			if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
			return `${Math.round(ms / 60000)} min`;
		}

		/**
		 * The last path segment, for a chip that must stay narrow.
		 * @param path - the full workspace path.
		 * @returns the basename.
		 */
		function basename(path) {
			const parts = String(path).split(/[\\/]/).filter((part) => part.length > 0);
			return parts.length === 0 ? String(path) : parts[parts.length - 1];
		}

		/**
		 * Format an epoch-ms stamp as a short local clock time.
		 * @param ms - epoch milliseconds.
		 * @returns the clock label.
		 */
		function formatClock(ms) {
			try {
				return new Date(ms).toLocaleTimeString();
			} catch {
				return String(ms);
			}
		}

		/** One tinted rounded-square icon tile: Abu's file/folder mark. */
		function IconTile({ name, tone, size }) {
			const token = TONE_TOKENS[tone ?? "idle"] ?? TONE_TOKENS.idle;
			const box = size ?? 22;
			return react.createElement(
				"span",
				{
					style: {
						width: box,
						height: box,
						borderRadius: 7,
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						background: tint(token, 12),
						color: `var(${token})`,
						flex: "none"
					}
				},
				react.createElement(Glyph, { name, size: box - 8 })
			);
		}

		/** A pill chip: soft tint when active, hairline when not. */
		function Chip({ label, value, tone, active, onClick, title }) {
			const token = TONE_TOKENS[tone ?? "idle"] ?? TONE_TOKENS.idle;
			const clickable = typeof onClick === "function";
			return react.createElement(
				"button",
				{
					type: "button",
					onClick,
					title,
					disabled: !clickable,
					style: {
						display: "inline-flex",
						alignItems: "center",
						gap: 6,
						padding: "3px 9px",
						borderRadius: 999,
						fontSize: 12,
						lineHeight: "18px",
						cursor: clickable ? "pointer" : "default",
						border: `1px solid ${active === true ? `var(${token})` : "var(--dsw-alias-border-l1)"}`,
						background: active === true ? tint(token, 14) : "transparent",
						color: active === true ? `var(${token})` : "var(--dsw-alias-label-secondary)",
						transition: "background-color 150ms ease-out, border-color 150ms ease-out",
						fontVariantNumeric: "tabular-nums"
					}
				},
				label === void 0 || label === null ? null : react.createElement("span", null, label),
				value === void 0 || value === null ? null : react.createElement("strong", { style: { fontWeight: 600, color: active === true ? `var(${token})` : "var(--dsw-alias-label-primary)" } }, String(value))
			);
		}

		/** A muted meta label. */
		function Meta({ children, tone }) {
			const token = tone === void 0 || tone === null ? null : TONE_TOKENS[tone] ?? TONE_TOKENS.idle;
			return react.createElement(
				"span",
				{ style: { fontSize: 11, lineHeight: "16px", color: token === null ? "var(--dsw-alias-label-secondary)" : `var(${token})`, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" } },
				children
			);
		}

		/**
		 * A section with the Abu header: icon + title + muted count + chevron, and
		 * a grid-row height transition on the body. Without `onToggle` the header
		 * is static (no chevron), for sections that are always open.
		 */
		function Section({ icon, title, count, tone, open, onToggle, children }) {
			const interactive = typeof onToggle === "function";
			const header = [
				react.createElement(IconTile, { key: "icon", name: icon, tone, size: 22 }),
				react.createElement("span", { key: "title", style: { fontSize: 13, lineHeight: "20px", fontWeight: 600, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, title),
				count === void 0 || count === null ? null : react.createElement(Meta, { key: "count" }, count),
				interactive
					? react.createElement("span", { key: "chevron", style: { color: "var(--dsw-alias-label-secondary)", transform: open === true ? "rotate(90deg)" : "none", transition: "transform 180ms ease-out", display: "flex" } }, react.createElement(Glyph, { name: "chevron", size: 12 }))
					: null
			];
			const headerStyle = { display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "9px 10px", color: "var(--dsw-alias-label-primary)" };
			return react.createElement(
				"section",
				{ style: { border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 12, background: "var(--dsw-alias-bg-layer-1)", overflow: "hidden", flex: "none" } },
				interactive
					? react.createElement("button", { type: "button", onClick: onToggle, "aria-expanded": open === true, style: { ...headerStyle, background: "none", border: "none", cursor: "pointer", textAlign: "left" } }, header)
					: react.createElement("div", { style: headerStyle }, header),
				react.createElement(
					"div",
					{ style: { display: "grid", gridTemplateRows: open === false ? "0fr" : "1fr", transition: "grid-template-rows 200ms ease-out" } },
					react.createElement(
						"div",
						{ style: { minHeight: 0, overflow: "hidden" } },
						react.createElement("div", { style: { borderTop: "1px solid var(--dsw-alias-border-l1)" } }, children)
					)
				)
			);
		}

		/** A hairline-divided list row. */
		function Row({ children, last, onClick, active, title }) {
			const clickable = typeof onClick === "function";
			return react.createElement(
				"div",
				{
					onClick,
					title,
					role: clickable ? "button" : void 0,
					tabIndex: clickable ? 0 : void 0,
					style: {
						display: "flex",
						alignItems: "center",
						gap: 8,
						padding: "7px 10px",
						borderBottom: last === true ? "none" : "1px solid var(--dsw-alias-border-l1)",
						background: active === true ? "var(--dsw-alias-bg-layer-2)" : "transparent",
						cursor: clickable ? "pointer" : "default"
					}
				},
				children
			);
		}

		/** Empty-state line: a dot glyph plus one sentence. */
		function Empty({ text }) {
			return react.createElement(
				"div",
				{ style: { display: "flex", alignItems: "center", gap: 8, padding: "12px 10px", color: "var(--dsw-alias-label-secondary)", fontSize: 12, lineHeight: "18px" } },
				react.createElement(Glyph, { name: "dot", size: 12 }),
				text
			);
		}

		/**
		 * The plain text a copy action carries for one failed call.
		 * @param call - the call view.
		 * @returns the text block.
		 */
		function detailText(call) {
			const detail = call.error ?? null;
			const target = call.target ?? null;
			const lines = [`${call.name}${target === null ? "" : ` (${target})`}`];
			if (detail !== null) {
				if (detail.name !== null) lines.push(`name: ${detail.name}`);
				if (detail.code !== null) lines.push(`code: ${detail.code}`);
				if (detail.reason !== null) lines.push(`reason: ${detail.reason}`);
				if (detail.text.length > 0) lines.push("", detail.text);
			}
			return lines.join("\n");
		}

		/** The bounded error detail of one failed call, revealed under its row. */
		function ErrorDetail({ call, t, open }) {
			const [copied, setCopied] = useState(false);
			const detail = call.error ?? null;
			const copy = useCallback(() => {
				try {
					const pending = navigator.clipboard?.writeText(detailText(call));
					if (pending !== void 0) pending.then(() => setCopied(true), () => setCopied(false));
				} catch {
					setCopied(false);
				}
			}, [call]);
			const rows = [];
			if (detail !== null && detail.name !== null) rows.push(`${t("error.name")} ${detail.name}`);
			if (detail !== null && detail.code !== null) rows.push(`${t("error.code")} ${detail.code}`);
			return react.createElement(
				"div",
				{ style: { display: "grid", gridTemplateRows: open === true ? "1fr" : "0fr", transition: "grid-template-rows 200ms ease-out" } },
				react.createElement(
					"div",
					{ style: { minHeight: 0, overflow: "hidden" } },
					react.createElement(
						"div",
						{ style: { padding: "8px 10px 10px 40px", background: tint("--dsw-alias-state-error-primary", 6) } },
						react.createElement(
							"div",
							{ style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" } },
							react.createElement(Meta, { tone: "error" }, t("error.title")),
							rows.map((row) => react.createElement(Meta, { key: row }, row)),
							react.createElement("span", { style: { flex: 1 } }),
							react.createElement(
								"button",
								{ type: "button", onClick: copy, style: { display: "inline-flex", alignItems: "center", gap: 4, background: "none", border: "none", cursor: "pointer", color: "var(--dsw-alias-label-secondary)", fontSize: 11, padding: 0 } },
								react.createElement(Glyph, { name: "copy", size: 11 }),
								copied ? t("error.copied") : t("error.copy")
							)
						),
						detail === null
							? react.createElement("div", { style: { fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" } }, t("error.none"))
							: detail.text.length === 0
								? react.createElement("div", { style: { fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" } }, t("error.dropped"))
								: react.createElement(
									"pre",
									{ style: { margin: 0, padding: 8, borderRadius: 8, background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-primary)", fontSize: 11, lineHeight: "16px", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 220, overflow: "auto" } },
									detail.text
								),
						detail !== null && detail.truncated === true
							? react.createElement("div", { style: { marginTop: 4 } }, react.createElement(Meta, { tone: "warn" }, t("error.truncated", { chars: ERROR_EXCERPT_CHARS })))
							: null
					)
				)
			);
		}

		/**
		 * One call row: kind tile, tool name, optional file chip, muted duration,
		 * status mark. A failed row is clickable and expands its error detail.
		 */
		function CallRow({ call, t, last, expanded, onToggle }) {
			const failed = call.isError === true;
			const pending = call.isError === null;
			const isSkill = call.source === "skill";
			const tone = failed ? "error" : toneOfKind(call.kind);
			// A file tool's subject is a path (show its last segment); a skill call's
			// subject is the skill's own name, shown whole.
			const subject = call.target ?? null;
			const subjectToken = isSkill ? "--dsw-alias-brand-primary" : "--dsw-alias-brand-primary";
			const error = call.error ?? null;
			const duration = formatDuration(call.durationMs);
			const clickable = failed || error !== null;
			return react.createElement(
				"div",
				{ style: { borderBottom: last === true ? "none" : "1px solid var(--dsw-alias-border-l1)" } },
				react.createElement(
					"div",
					{
						onClick: clickable ? onToggle : void 0,
						role: clickable ? "button" : void 0,
						tabIndex: clickable ? 0 : void 0,
						title: subject ?? void 0,
						style: { display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", cursor: clickable ? "pointer" : "default" }
					},
					react.createElement(IconTile, { name: call.kind, tone, size: 22 }),
					react.createElement("span", { style: { fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-primary)", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", flex: "none", maxWidth: "50%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, call.name),
					subject === null
						? null
						: react.createElement(
							"span",
							{ title: subject, style: { display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 7px", borderRadius: 6, background: tint(subjectToken, isSkill ? 14 : 10), color: isSkill ? `var(${subjectToken})` : "var(--dsw-alias-label-primary)", fontSize: 11, lineHeight: "16px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: isSkill ? 600 : 400 } },
							react.createElement(Glyph, { name: isSkill ? "skill" : "file-read", size: 11 }),
							isSkill ? subject : basename(subject)
						),
					react.createElement("span", { style: { flex: 1, minWidth: 8 } }),
					call.kindConfidence === "heuristic" ? react.createElement(Meta, { tone: "warn" }, t("heuristic.badge")) : null,
					call.nested === true ? react.createElement(Meta, null, t("nested.badge")) : null,
					duration.length === 0 ? null : react.createElement(Meta, null, duration),
					failed
						? react.createElement("span", { style: { color: "var(--dsw-alias-state-error-primary)", display: "flex" } }, react.createElement(Glyph, { name: "error", size: 13 }))
						: pending
							? react.createElement(Meta, null, t("status.pending"))
							: react.createElement("span", { style: { color: "var(--dsw-alias-state-success-primary)", display: "flex" } }, react.createElement(Glyph, { name: "check", size: 13 }))
				),
				failed ? react.createElement(ErrorDetail, { call, t, open: expanded === true }) : null
			);
		}

		/** One task row: status ring plus text, matching the task panel's own reading. */
		function TaskRow({ todo, last }) {
			const tone = todo.status === "completed" ? "success" : todo.status === "in_progress" ? "warn" : "idle";
			const token = TONE_TOKENS[tone];
			return react.createElement(
				"div",
				{ style: { display: "flex", alignItems: "flex-start", gap: 8, padding: "6px 10px", borderBottom: last === true ? "none" : "1px solid var(--dsw-alias-border-l1)" } },
				react.createElement("span", { style: { width: 12, height: 12, marginTop: 3, borderRadius: 999, border: `1.5px solid var(${token})`, background: todo.status === "pending" ? "transparent" : `var(${token})`, flex: "none" } }),
				react.createElement("span", { style: { fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-primary)", textDecoration: todo.status === "completed" ? "line-through" : "none", opacity: todo.status === "completed" ? 0.7 : 1 } }, todo.content)
			);
		}

		/**
		 * The filter panel: one aggregate table, clickable to narrow further.
		 *
		 * Rows aggregate by the call's SUBJECT when it has one — a skill's name, or
		 * a file's path — because a bare "skill"/"read" row hides exactly the
		 * detail a reader is looking for. Only subject-less calls fall back to the
		 * tool name. Both the subject and the tool name can be picked, so a skill
		 * row reads "which skill" rather than "skill, N times".
		 */
		function FilterPanel({ filter, rows, t, onPickTool, onClear }) {
			const entries = useMemo(() => {
				const map = new Map();
				for (const row of rows) {
					const subject = row.call.target ?? null;
					const key = subject === null ? `tool:${row.call.name}` : `subject:${subject}`;
					const entry = map.get(key) ?? {
						key,
						label: subject === null ? row.call.name : subject,
						tool: row.call.name,
						subject,
						count: 0,
						turns: new Set(),
						kind: row.call.kind
					};
					entry.count += 1;
					entry.turns.add(row.turn);
					map.set(key, entry);
				}
				return [...map.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
			}, [rows]);
			const groupTitle = filter.source === "skill" ? t("filter.bySkill") : filter.path === null ? t("filter.byTool") : t("filter.byFile");
			return react.createElement(
				"div",
				null,
				react.createElement(
					"div",
					{ style: { display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderBottom: "1px solid var(--dsw-alias-border-l1)" } },
					react.createElement(Meta, null, `${groupTitle} · ${entries.length}`),
					react.createElement("span", { style: { flex: 1 } }),
					react.createElement(
						"button",
						{ type: "button", onClick: onClear, style: { display: "inline-flex", alignItems: "center", gap: 4, background: "none", border: "none", cursor: "pointer", color: "var(--dsw-alias-label-secondary)", fontSize: 11, padding: 0 } },
						react.createElement(Glyph, { name: "filter", size: 11 }),
						t("filter.clear")
					)
				),
				entries.length === 0 ? react.createElement(Empty, { text: t("filter.none") }) : null,
				entries.map((entry, index) => react.createElement(
					Row,
					{ key: entry.key, last: index === entries.length - 1, active: filter.tool === entry.tool && (entry.subject === null || filter.path === entry.subject), onClick: () => onPickTool(entry) },
					react.createElement(IconTile, { name: entry.kind, tone: toneOfKind(entry.kind), size: 22 }),
					react.createElement(
						"span",
						{ style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column" } },
						react.createElement("span", { style: { fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-primary)", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, entry.label),
						entry.subject === null ? null : react.createElement(Meta, null, entry.tool)
					),
					react.createElement(Meta, null, `${entry.turns.size} ${t("filter.turns")}`),
					react.createElement(Chip, { value: entry.count, tone: toneOfKind(entry.kind) })
				))
			);
		}

		/** One turn card: header with counts, then its calls. */
		function TurnCard({ turn, t, expandedCall, onToggleCall, rowsExpanded, onToggleRows, collapsed, onToggleCollapse }) {
			const calls = turn.calls ?? [];
			const shown = rowsExpanded === true ? calls : calls.slice(0, MAX_ROWS_PER_TURN);
			const hidden = calls.length - shown.length;
			return react.createElement(
				"div",
				{ style: { border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 10, background: "var(--dsw-alias-bg-layer-1)", overflow: "hidden" } },
				react.createElement(
					"button",
					{ type: "button", onClick: onToggleCollapse, "aria-expanded": collapsed !== true, style: { display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 10px", background: "none", border: "none", cursor: "pointer", textAlign: "left", flexWrap: "wrap" } },
					react.createElement("span", { style: { color: "var(--dsw-alias-label-secondary)", transform: collapsed === true ? "none" : "rotate(90deg)", transition: "transform 180ms ease-out", display: "flex" } }, react.createElement(Glyph, { name: "chevron", size: 12 })),
					react.createElement("span", { style: { fontSize: 12, lineHeight: "18px", fontWeight: 600, color: "var(--dsw-alias-label-primary)" } }, t("activity.turn", { turn: turn.turn })),
					react.createElement("span", { style: { flex: 1, minWidth: 4 } }),
					turn.skillCalls > 0 ? react.createElement(Chip, { label: "Skill", value: turn.skillCalls, tone: "brand" }) : null,
					turn.mcpCalls > 0 ? react.createElement(Chip, { label: "MCP", value: turn.mcpCalls, tone: "brand" }) : null,
					turn.otherCalls > 0 ? react.createElement(Chip, { label: t("overview.filterOther"), value: turn.otherCalls }) : null,
					turn.errorCalls > 0 ? react.createElement(Chip, { label: t("overview.filterError"), value: turn.errorCalls, tone: "error" }) : null,
					turn.todoUpdated === true ? react.createElement(Meta, { tone: "warn" }, t("tasks.updated")) : null
				),
				react.createElement(
					"div",
					{ style: { display: "grid", gridTemplateRows: collapsed === true ? "0fr" : "1fr", transition: "grid-template-rows 200ms ease-out" } },
					react.createElement(
						"div",
						{ style: { minHeight: 0, overflow: "hidden" } },
						react.createElement(
							"div",
							{ style: { borderTop: "1px solid var(--dsw-alias-border-l1)" } },
							shown.map((call, index) => react.createElement(CallRow, {
								key: call.callId,
								call,
								t,
								last: index === shown.length - 1 && hidden <= 0,
								expanded: expandedCall === call.callId,
								onToggle: () => onToggleCall(call.callId)
							})),
							hidden > 0
								? react.createElement("button", { type: "button", onClick: onToggleRows, style: { display: "block", width: "100%", padding: "6px 10px", background: "none", border: "none", cursor: "pointer", color: "var(--dsw-alias-label-secondary)", fontSize: 11, textAlign: "left" } }, t("activity.more", { count: hidden }))
								: rowsExpanded === true && calls.length > MAX_ROWS_PER_TURN
									? react.createElement("button", { type: "button", onClick: onToggleRows, style: { display: "block", width: "100%", padding: "6px 10px", background: "none", border: "none", cursor: "pointer", color: "var(--dsw-alias-label-secondary)", fontSize: 11, textAlign: "left" } }, t("activity.less"))
									: null
						)
					)
				)
			);
		}

		/** The session-changes body for one turn: the summary its recorded seq announced. */
		function ChangesTurn({ turn, sessionId, t }) {
			const seq = turn.fileChangeSeq;
			const [state, setState] = useState({ kind: "loading", summary: null });
			useEffect(() => {
				const controller = new AbortController();
				const url = `${CHANGES_SUMMARY_ROUTE}?${new URLSearchParams({ sessionId, seq: String(seq) }).toString()}`;
				fetch(url, { signal: controller.signal }).then(async (response) => {
					if (!response.ok) {
						setState({ kind: "loaded", summary: null });
						return;
					}
					setState({ kind: "loaded", summary: await response.json() });
				}).catch(() => {
					if (controller.signal.aborted) return;
					setState({ kind: "loaded", summary: null });
				});
				return () => controller.abort();
			}, [sessionId, seq]);
			if (state.kind === "loading") return react.createElement(Empty, { text: t("changes.loading") });
			if (state.summary === null) return react.createElement(Empty, { text: t("changes.unknown") });
			const changed = state.summary.files ?? [];
			if (changed.length === 0) return react.createElement(Empty, { text: t("changes.empty") });
			return react.createElement(
				"div",
				null,
				changed.map((file, index) => react.createElement(
					Row,
					{ key: file.path, last: index === changed.length - 1 },
					react.createElement(IconTile, { name: "file-write", tone: "warn", size: 22 }),
					react.createElement("span", { title: file.path, style: { fontSize: 12, lineHeight: "18px", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, file.display),
					react.createElement(Meta, { tone: "success" }, `+${file.added}`),
					react.createElement(Meta, { tone: "error" }, `-${file.deleted}`),
					file.binary === true ? react.createElement(Meta, null, t("changes.binary")) : null,
					file.oversized === true ? react.createElement(Meta, { tone: "warn" }, t("changes.oversized")) : null
				))
			);
		}

		/** The Git section body: status fetched once for the Session's directory. */
		function GitBody({ cwd, t }) {
			const [state, setState] = useState({ kind: "loading", payload: null });
			const [openPath, setOpenPath] = useState(null);
			const [diffState, setDiffState] = useState(null);
			useEffect(() => {
				if (cwd === void 0) {
					setState({ kind: "loaded", payload: { status: "unknown", reason: "no-cwd" } });
					return;
				}
				const controller = new AbortController();
				setState({ kind: "loading", payload: null });
				fetch(`${GIT_STATUS_ROUTE}?${new URLSearchParams({ cwd }).toString()}`, { signal: controller.signal }).then(async (response) => {
					if (!response.ok) {
						setState({ kind: "loaded", payload: { status: "unknown", reason: `http-${response.status}` } });
						return;
					}
					setState({ kind: "loaded", payload: await response.json() });
				}).catch((error) => {
					if (controller.signal.aborted) return;
					setState({ kind: "loaded", payload: { status: "unknown", reason: String(error?.message ?? error) } });
				});
				return () => controller.abort();
			}, [cwd]);
			const openDiff = useCallback((path) => {
				if (cwd === void 0) return;
				setOpenPath(path);
				setDiffState({ kind: "loading", payload: null });
				const controller = new AbortController();
				fetch(`${GIT_DIFF_ROUTE}?${new URLSearchParams({ cwd, path }).toString()}`, { signal: controller.signal }).then(async (response) => {
					if (!response.ok) {
						setDiffState({ kind: "loaded", payload: { status: "unknown", reason: `http-${response.status}` } });
						return;
					}
					setDiffState({ kind: "loaded", payload: await response.json() });
				}).catch((error) => {
					if (controller.signal.aborted) return;
					setDiffState({ kind: "loaded", payload: { status: "unknown", reason: String(error?.message ?? error) } });
				});
			}, [cwd]);
			if (state.kind === "loading") return react.createElement(Empty, { text: t("git.loading") });
			const payload = state.payload;
			if (payload.status === "not-a-repo") return react.createElement(Empty, { text: t("git.notRepo") });
			if (payload.status === "unknown") return react.createElement(Empty, { text: t("git.unknown", { reason: payload.reason ?? "?" }) });
			const entries = payload.entries ?? [];
			if (entries.length === 0) return react.createElement(Empty, { text: t("git.empty") });
			return react.createElement(
				"div",
				null,
				entries.map((entry, index) => react.createElement(
					"div",
					{ key: entry.path },
					react.createElement(
						Row,
						{ last: index === entries.length - 1, onClick: () => openDiff(entry.path), active: openPath === entry.path },
						react.createElement(IconTile, { name: "file-write", tone: "warn", size: 22 }),
						react.createElement("span", { style: { fontSize: 12, lineHeight: "18px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", flex: "none", color: "var(--dsw-alias-label-secondary)" } }, entry.code),
						react.createElement("span", { style: { fontSize: 12, lineHeight: "18px", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, entry.path)
					),
					openPath === entry.path && diffState !== null
						? react.createElement("pre", { style: { margin: 0, padding: 8, background: "var(--dsw-alias-bg-layer-2)", fontSize: 11, lineHeight: "16px", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 240, overflow: "auto" } }, diffState.kind === "loading" ? t("git.diffLoading") : diffState.payload.status === "ok" ? diffState.payload.diff : t("git.diffUnavailable"))
						: null
				))
			);
		}

		/**
		 * Flatten the view into filterable rows.
		 * @param turns - the view's turns.
		 * @returns one entry per call with its turn.
		 */
		function flattenRows(turns) {
			const rows = [];
			for (const turn of turns) {
				for (const call of turn.calls ?? []) rows.push({ turn: turn.turn, call });
			}
			return rows;
		}

		/**
		 * Aggregate file targets across every turn.
		 * @param turns - the view's turns.
		 * @returns one entry per distinct path, most recent first.
		 */
		function aggregateFiles(turns) {
			const map = new Map();
			for (const turn of turns) {
				for (const call of turn.calls ?? []) {
					const target = call.target ?? null;
					if (target === null) continue;
					if (call.kind !== "file-read" && call.kind !== "file-write" && call.kind !== "file-create") continue;
					const entry = map.get(target) ?? { path: target, reads: 0, writes: 0, lastTurn: turn.turn };
					if (call.kind === "file-read") entry.reads += 1;
					else entry.writes += 1;
					entry.lastTurn = Math.max(entry.lastTurn, turn.turn);
					map.set(target, entry);
				}
			}
			return [...map.values()].sort((a, b) => b.lastTurn - a.lastTurn || a.path.localeCompare(b.path));
		}

		/** The no-filter value, so every clear path resets the same shape. */
		function emptyFilter() {
			return { source: null, kind: null, tool: null, turn: null, path: null, errorsOnly: false };
		}

		/**
		 * The tab body: the Host `operationLog` projection rendered as Abu-style
		 * sections, with client-side filtering, file existence, and error detail.
		 */
		function OperationLogBody({ sessionId, useSessions, useProjection, t }) {
			const view = useProjection("operationLog");
			const cwd = useSessions((sessions) => sessions.byId[sessionId]?.cwd);

			const [open, setOpen] = useState({ overview: true, tasks: true, activity: true, files: false, changes: false, git: false });
			const [filter, setFilter] = useState(emptyFilter);
			const [expandedCall, setExpandedCall] = useState(null);
			const [rowsExpanded, setRowsExpanded] = useState({});
			const [collapsedTurns, setCollapsedTurns] = useState({});
			const [visibleTurns, setVisibleTurns] = useState(INITIAL_TURNS);
			const [existence, setExistence] = useState({ checkedAt: null, results: null, failed: false });

			const turns = view === void 0 ? [] : view.turns ?? [];
			const files = useMemo(() => aggregateFiles(turns), [turns]);
			const allRows = useMemo(() => flattenRows(turns), [turns]);

			const filterActive = filter.source !== null || filter.kind !== null || filter.tool !== null || filter.turn !== null || filter.path !== null || filter.errorsOnly;
			const filtered = useMemo(() => {
				if (!filterActive) return allRows;
				return allRows.filter(({ turn, call }) => {
					if (filter.errorsOnly && call.isError !== true) return false;
					if (filter.source !== null && call.source !== filter.source) return false;
					if (filter.kind !== null && call.kind !== filter.kind) return false;
					if (filter.tool !== null && call.name !== filter.tool) return false;
					if (filter.turn !== null && turn !== filter.turn) return false;
					if (filter.path !== null && call.target !== filter.path) return false;
					return true;
				});
			}, [allRows, filter, filterActive]);
			const filteredIds = useMemo(() => new Set(filtered.map((row) => row.call.callId)), [filtered]);

			// Probe existence for the file targets the projection carries. The result
			// is tri-state, so an unreachable path is never reported as deleted.
			const probePaths = useMemo(() => files.map((file) => file.path).slice(0, MAX_PROBE_PATHS), [files]);
			const probeKey = probePaths.join("\n");
			useEffect(() => {
				if (cwd === void 0 || probePaths.length === 0) return;
				const controller = new AbortController();
				fetch(FILES_EXIST_ROUTE, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ cwd, paths: probePaths }),
					signal: controller.signal
				}).then(async (response) => {
					if (!response.ok) {
						setExistence({ checkedAt: null, results: null, failed: true });
						return;
					}
					const payload = await response.json();
					setExistence({ checkedAt: payload.checkedAt ?? null, results: payload.results ?? null, failed: false });
				}).catch(() => {
					if (controller.signal.aborted) return;
					setExistence({ checkedAt: null, results: null, failed: true });
				});
				return () => controller.abort();
			}, [cwd, probeKey, probePaths]);

			const toggleSection = useCallback((name) => {
				setOpen((current) => ({ ...current, [name]: !current[name] }));
			}, []);
			const toggleCall = useCallback((callId) => {
				setExpandedCall((current) => (current === callId ? null : callId));
			}, []);
			const toggleRows = useCallback((turn) => {
				setRowsExpanded((current) => ({ ...current, [turn]: !current[turn] }));
			}, []);
			const toggleCollapse = useCallback((turn) => {
				setCollapsedTurns((current) => ({ ...current, [turn]: !current[turn] }));
			}, []);
			const clearFilter = useCallback(() => {
				setFilter(emptyFilter());
			}, []);
			const pickSource = useCallback((source) => {
				setFilter({ ...emptyFilter(), source });
			}, []);
			const pickErrors = useCallback(() => {
				setFilter({ ...emptyFilter(), errorsOnly: true });
			}, []);
			const pickPath = useCallback((path) => {
				setFilter((current) => ({ ...emptyFilter(), path: current.path === path ? null : path }));
			}, []);

			if (view === void 0) {
				return react.createElement("div", { style: { padding: 16, color: "var(--dsw-alias-label-secondary)", fontSize: 12 } }, t("activity.empty"));
			}

			const totalCalls = allRows.length;
			const totalErrors = allRows.filter((row) => row.call.isError === true).length;
			const skillCount = allRows.filter((row) => row.call.source === "skill").length;
			const mcpCount = allRows.filter((row) => row.call.source === "mcp").length;
			const otherCount = totalCalls - skillCount - mcpCount;
			const latestTodos = turns.length === 0 ? [] : turns[turns.length - 1].todos ?? [];
			const doneTodos = latestTodos.filter((todo) => todo.status === "completed").length;
			const unattributed = view.unattributed ?? [];
			const missingFiles = existence.results === null ? 0 : files.filter((file) => existence.results[file.path] === "missing").length;
			const changesTurns = turns.filter((turn) => turn.fileChangeSeq !== null && turn.fileChangeSeq !== void 0).slice().reverse();
			const shownTurns = filterActive
				? turns.filter((turn) => filtered.some((row) => row.turn === turn.turn)).slice().reverse()
				: turns.slice(-visibleTurns).reverse();

			return react.createElement(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: 10, padding: 10, overflow: "auto", height: "100%", boxSizing: "border-box" } },
				react.createElement(
					Section,
					{ icon: "tool", title: t("overview.title"), tone: "brand", count: `${turns.length} · ${totalErrors > 0 ? t("overview.errors", { errors: totalErrors }) : t("status.ok")}`, open: open.overview, onToggle: () => toggleSection("overview") },
					react.createElement(
						"div",
						{ style: { padding: 10, display: "flex", flexDirection: "column", gap: 8 } },
						react.createElement(
							"div",
							{ style: { display: "flex", flexWrap: "wrap", gap: 6 } },
							react.createElement(Chip, { label: t("overview.filterAll"), value: totalCalls, active: !filterActive, onClick: clearFilter }),
							react.createElement(Chip, { label: t("overview.filterSkill"), value: skillCount, tone: "brand", active: filter.source === "skill", onClick: () => pickSource("skill") }),
							react.createElement(Chip, { label: t("overview.filterMcp"), value: mcpCount, tone: "brand", active: filter.source === "mcp", onClick: () => pickSource("mcp") }),
							react.createElement(Chip, { label: t("overview.filterOther"), value: otherCount, active: filter.source === "agent", onClick: () => pickSource("agent") }),
							react.createElement(Chip, { label: t("overview.filterError"), value: totalErrors, tone: "error", active: filter.errorsOnly, onClick: pickErrors })
						),
						react.createElement(Meta, null, t("overview.filterHint"))
					)
				),
				filterActive
					? react.createElement(
						Section,
						{ icon: "filter", title: t("filter.title"), tone: "warn", count: filtered.length },
						react.createElement(FilterPanel, {
							filter,
							rows: filtered,
							t,
							onPickTool: (entry) => setFilter((current) => {
								const same = current.tool === entry.tool && (entry.subject === null ? current.path === null : current.path === entry.subject);
								if (same) return { ...current, tool: null, path: null };
								return { ...current, tool: entry.tool, path: entry.subject };
							}),
							onClear: clearFilter
						})
					)
					: null,
				react.createElement(
					Section,
					{ icon: "check", title: t("tasks.title"), tone: "success", count: latestTodos.length === 0 ? null : t("tasks.count", { done: doneTodos, total: latestTodos.length }), open: open.tasks, onToggle: () => toggleSection("tasks") },
					latestTodos.length === 0
						? react.createElement(Empty, { text: t("tasks.none") })
						: react.createElement(
							"div",
							null,
							latestTodos.map((todo, index) => react.createElement(TaskRow, { key: `${index}:${todo.content}`, todo, last: index === latestTodos.length - 1 })),
							react.createElement("div", { style: { padding: "6px 10px" } }, react.createElement(Meta, null, t("tasks.noNumber")))
						)
				),
				react.createElement(
					Section,
					{ icon: "clock", title: t("activity.title"), count: t("activity.count", { calls: filterActive ? filtered.length : totalCalls }), open: open.activity, onToggle: () => toggleSection("activity") },
					react.createElement(
						"div",
						{ style: { padding: 8, display: "flex", flexDirection: "column", gap: 8 } },
						shownTurns.length === 0
							? react.createElement(Empty, { text: filterActive ? t("filter.none") : t("activity.empty") })
							: shownTurns.map((turn) => react.createElement(TurnCard, {
								key: turn.turn,
								turn: filterActive ? { ...turn, calls: (turn.calls ?? []).filter((call) => filteredIds.has(call.callId)) } : turn,
								t,
								expandedCall,
								onToggleCall: toggleCall,
								rowsExpanded: rowsExpanded[turn.turn] === true,
								onToggleRows: () => toggleRows(turn.turn),
								collapsed: collapsedTurns[turn.turn] === true,
								onToggleCollapse: () => toggleCollapse(turn.turn)
							})),
						!filterActive && turns.length > shownTurns.length
							? react.createElement(
								"button",
								{ type: "button", onClick: () => setVisibleTurns((current) => current + TURN_PAGE), style: { padding: "6px 10px", background: "none", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 8, cursor: "pointer", color: "var(--dsw-alias-label-secondary)", fontSize: 11 } },
								t("activity.earlier", { count: Math.min(TURN_PAGE, turns.length - shownTurns.length) })
							)
							: null,
						unattributed.length > 0
							? react.createElement(
								"div",
								{ style: { border: "1px dashed var(--dsw-alias-border-l2)", borderRadius: 10, padding: 8 } },
								react.createElement(Meta, { tone: "warn" }, t("activity.unattributed")),
								react.createElement("div", { style: { marginTop: 4 } }, react.createElement(Meta, null, t("activity.unattributedHint"))),
								unattributed.map((call) => react.createElement(CallRow, { key: call.callId, call, t, expanded: expandedCall === call.callId, onToggle: () => toggleCall(call.callId) }))
							)
							: null
					)
				),
				react.createElement(
					Section,
					{ icon: "file-read", title: t("files.title"), tone: "warn", count: files.length === 0 ? null : t("files.summary", { files: files.length, missing: missingFiles }), open: open.files, onToggle: () => toggleSection("files") },
					files.length === 0
						? react.createElement(Empty, { text: t("files.empty") })
						: react.createElement(
							"div",
							null,
							files.map((file, index) => {
								const probe = existence.results === null ? null : existence.results[file.path] ?? null;
								const gone = probe === "missing";
								return react.createElement(
									Row,
									{ key: file.path, last: index === files.length - 1, active: filter.path === file.path, title: file.path, onClick: () => pickPath(file.path) },
									react.createElement(IconTile, { name: "file-read", tone: gone ? "idle" : "brand", size: 22 }),
									react.createElement(
										"span",
										{ style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column" } },
										react.createElement("span", { style: { fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-primary)", textDecoration: gone ? "line-through" : "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, basename(file.path)),
										react.createElement(Meta, null, file.path)
									),
									file.reads > 0 ? react.createElement(Meta, null, t("files.reads", { count: file.reads })) : null,
									file.writes > 0 ? react.createElement(Meta, null, t("files.writes", { count: file.writes })) : null,
									react.createElement(Meta, null, t("files.lastTurn", { turn: file.lastTurn })),
									gone ? react.createElement(Meta, { tone: "warn" }, t("files.deleted")) : null
								);
							}),
							react.createElement("div", { style: { padding: "6px 10px" } }, react.createElement(Meta, { tone: existence.failed ? "warn" : null }, existence.checkedAt === null ? t("files.probeFailed") : t("files.probed", { time: formatClock(existence.checkedAt) })))
						)
				),
				react.createElement(
					Section,
					{ icon: "file-write", title: t("changes.title"), tone: "warn", count: changesTurns.length === 0 ? null : changesTurns.length, open: open.changes, onToggle: () => toggleSection("changes") },
					changesTurns.length === 0
						? react.createElement(Empty, { text: t("changes.empty") })
						: react.createElement(
							"div",
							null,
							changesTurns.map((turn, index) => react.createElement(
								"div",
								{ key: turn.turn },
								react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderBottom: index === changesTurns.length - 1 ? "none" : "1px solid var(--dsw-alias-border-l1)" } }, react.createElement(Meta, null, t("changes.turn", { turn: turn.turn }))),
								react.createElement(ChangesTurn, { turn, sessionId, t })
							))
						)
				),
				react.createElement(
					Section,
					{ icon: "command", title: t("git.title"), open: open.git, onToggle: () => toggleSection("git") },
					react.createElement(GitBody, { cwd, t })
				)
			);
		}

		/**
		 * Containment boundary for the tab body. A slot entry that throws renders
		 * an empty pane and tells the user nothing, so every failure inside the
		 * body is caught here and reported in place.
		 */
		class OperationLogBoundary extends react.Component {
			constructor(props) {
				super(props);
				this.state = { error: null };
			}
			static getDerivedStateFromError(error) {
				return { error };
			}
			componentDidCatch(error) {
				// Keep the original error in the console for a real diagnosis.
				console.error("operation-log: tab body failed", error);
			}
			render() {
				if (this.state.error === null) return this.props.children;
				return react.createElement(
					"div",
					{ style: { padding: 16, fontSize: 12, lineHeight: 1.6, whiteSpace: "pre-wrap", color: "var(--dsw-alias-state-error-primary)" } },
					this.props.label + "\n" + String(this.state.error?.message ?? this.state.error) + "\n\n" + String(this.state.error?.stack ?? "").split("\n").slice(0, 6).join("\n")
				);
			}
		}

		/** The tab entry point: the containment boundary wrapped around the real body. */
		function OperationLogTab(props) {
			return react.createElement(
				OperationLogBoundary,
				{ label: "operation-log: body failed" },
				react.createElement(OperationLogBody, {
					sessionId: props.sessionId,
					useSessions: props.useSessions,
					useProjection: props.useProjection,
					t: props.t
				})
			);
		}

		/** The tab's chip title. */
		function OperationLogTabTitle({ t }) {
			return react.createElement("span", null, t("tab.title"));
		}

		/** The header button that opens this Session's operation-log tab. */
		function OperationLogHeaderButton({ sessionId, ctx, t }) {
			const open = useCallback(() => {
				ctx.sidebarRight.openTab(TAB_KIND, {});
			}, [sessionId]);
			return react.createElement(
				"button",
				{
					type: "button",
					onClick: open,
					"aria-label": t("header.button"),
					style: { background: "none", border: "none", cursor: "pointer", color: "var(--dsw-alias-label-secondary)", fontSize: 13, padding: "4px 8px" }
				},
				t("header.button")
			);
		}

		return {
			inject: ["slots", "locale", "sidebarRight", "sidebarRightTabs"],
			apply(ctx) {
				const t = ctx.locale.bind(NS);
				ctx.effect(() => ctx.locale.register(NS, { zh, en }), "operation-log: dictionaries");
				ctx.effect(() => ctx.sidebarRightTabs.register({
					id: TAB_ID,
					kind: TAB_KIND,
					priority: "extension",
					title: () => t("tab.title")
				}), "operation-log: tab type");
				ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
					name: "sidebar.right.pane.tab",
					key: TAB_ID,
					locale: NS,
					inject: () => ({})
				}, OperationLogTab));
				ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({
					name: "sidebar.right.pane.tab.title",
					key: TAB_ID,
					locale: NS,
					inject: () => ({})
				}, OperationLogTabTitle));
				ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
					name: "conversation.session.header.utilities",
					id: "operation-log-open",
					order: 15,
					locale: NS,
					inject: () => ({ ctx })
				}, OperationLogHeaderButton));
			}
		};
	}
});
