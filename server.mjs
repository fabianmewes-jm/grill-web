import http from "node:http";
import fs from "node:fs/promises";
import { existsSync, constants as FS_CONSTANTS } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveOptional(specifier) {
	try {
		return require.resolve(specifier);
	} catch {
		return null;
	}
}

const HOST = "127.0.0.1";
const PORT = Number.parseInt(process.env.PORT || "8787", 10);
const TOKEN = process.env.GRILL_WEB_TOKEN || crypto.randomBytes(18).toString("base64url");
const LOCK_TTL_MS = 30 * 60 * 1000;
const TODO_ID_PATTERN = /^[a-f0-9]{8}$/i;
const TODO_REF_PATTERN = /\bTODO-([a-f0-9]{8})\b/gi;
const REFINEMENT_TAG_PREFIX = "refinement:";
const REFINEMENT_STAGES = new Set(["draft", "grill", "ready"]);
const PROJECT_PI_DIR = path.resolve(__dirname, "..");
const PROJECT_ROOT = path.resolve(PROJECT_PI_DIR, "..");
const TODO_DIR = process.env.PI_TODO_PATH
	? path.resolve(process.cwd(), process.env.PI_TODO_PATH)
	: path.resolve(__dirname, "../todos");
const PUBLIC_DIR = path.resolve(__dirname, "public");
const EXTENSION_FILE = path.resolve(__dirname, "extensions/todos.ts");
const SKILL_FILE = path.resolve(__dirname, "skills/grill-me/SKILL.md");
const PROJECT_SETTINGS_FILE = path.join(PROJECT_PI_DIR, "settings.json");
const MARKED_ESM = path.resolve(__dirname, "node_modules/marked/lib/marked.esm.js");
const PI_AI_PACKAGE = resolveOptional("@earendil-works/pi-ai/package.json");
const PI_CODING_AGENT_PACKAGE = resolveOptional("@earendil-works/pi-coding-agent/package.json");
const PI_AI_MODELS_CANDIDATES = [
	process.env.PI_AI_MODELS_PATH,
	path.resolve(__dirname, "node_modules/@earendil-works/pi-ai/dist/models.generated.js"),
	PI_AI_PACKAGE ? path.resolve(path.dirname(PI_AI_PACKAGE), "dist/models.generated.js") : null,
	PI_CODING_AGENT_PACKAGE
		? path.resolve(path.dirname(PI_CODING_AGENT_PACKAGE), "node_modules/@earendil-works/pi-ai/dist/models.generated.js")
		: null,
].filter(Boolean);

function json(res, status, payload) {
	const body = JSON.stringify(payload, null, 2);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
	});
	res.end(body);
}

function text(res, status, body, contentType = "text/plain; charset=utf-8") {
	res.writeHead(status, {
		"content-type": contentType,
		"cache-control": "no-store",
	});
	res.end(body);
}

function escapeHtml(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}

function validateTodoId(id) {
	const normalized = String(id || "").replace(/^TODO-/i, "").trim().toLowerCase();
	return TODO_ID_PATTERN.test(normalized) ? normalized : null;
}

function todoPath(id) {
	return path.join(TODO_DIR, `${id}.md`);
}

function lockPath(id) {
	return path.join(TODO_DIR, `${id}.lock`);
}

function hashContent(content) {
	return crypto.createHash("sha256").update(content).digest("hex");
}

function findJsonObjectEnd(content) {
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = 0; i < content.length; i += 1) {
		const char = content[i];

		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === '"') inString = false;
			continue;
		}

		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "{") {
			depth += 1;
			continue;
		}
		if (char === "}") {
			depth -= 1;
			if (depth === 0) return i;
		}
	}

	return -1;
}

function splitFrontMatter(content) {
	if (!content.startsWith("{")) return { frontMatter: "", body: content };
	const endIndex = findJsonObjectEnd(content);
	if (endIndex === -1) return { frontMatter: "", body: content };
	return {
		frontMatter: content.slice(0, endIndex + 1),
		body: content.slice(endIndex + 1).replace(/^\r?\n+/, ""),
	};
}

function parseFrontMatter(text, idFallback) {
	const data = {
		id: idFallback,
		title: "",
		tags: [],
		status: "open",
		created_at: "",
		assigned_to_session: undefined,
	};

	try {
		const parsed = JSON.parse(text.trim());
		if (!parsed || typeof parsed !== "object") return data;
		if (typeof parsed.id === "string" && parsed.id) data.id = parsed.id;
		if (typeof parsed.title === "string") data.title = parsed.title;
		if (Array.isArray(parsed.tags)) data.tags = parsed.tags.filter((tag) => typeof tag === "string");
		if (typeof parsed.status === "string" && parsed.status) data.status = parsed.status;
		if (typeof parsed.created_at === "string") data.created_at = parsed.created_at;
		if (typeof parsed.assigned_to_session === "string" && parsed.assigned_to_session.trim()) {
			data.assigned_to_session = parsed.assigned_to_session;
		}
	} catch {
		return data;
	}

	return data;
}

function parseTodoContent(content, idFallback) {
	const { frontMatter, body } = splitFrontMatter(content);
	const parsed = parseFrontMatter(frontMatter, idFallback);
	return {
		id: idFallback,
		title: parsed.title,
		tags: parsed.tags || [],
		status: parsed.status || "open",
		created_at: parsed.created_at || "",
		assigned_to_session: parsed.assigned_to_session,
		body: body || "",
	};
}

function serializeTodo(todo) {
	const frontMatter = JSON.stringify(
		{
			id: todo.id,
			title: todo.title,
			tags: todo.tags || [],
			status: todo.status,
			created_at: todo.created_at,
			assigned_to_session: todo.assigned_to_session || undefined,
		},
		null,
		2,
	);
	const trimmedBody = String(todo.body || "").replace(/^\n+/, "").replace(/\s+$/, "");
	return trimmedBody ? `${frontMatter}\n\n${trimmedBody}\n` : `${frontMatter}\n`;
}

function isClosedStatus(status) {
	return ["closed", "done"].includes(String(status || "").toLowerCase());
}

function validateRefinementStage(stage) {
	const value = String(stage || "").trim().toLowerCase();
	if (!REFINEMENT_STAGES.has(value)) {
		const error = new Error("Unsupported refinement stage. Use draft, grill, or ready.");
		error.status = 400;
		throw error;
	}
	return value;
}

function refinementStageFromTags(tags) {
	const stages = normalizeTags(tags)
		.filter((tag) => tag.toLowerCase().startsWith(REFINEMENT_TAG_PREFIX))
		.map((tag) => tag.slice(REFINEMENT_TAG_PREFIX.length).toLowerCase())
		.filter((stage) => REFINEMENT_STAGES.has(stage));
	return stages[0] || null;
}

function tagsWithResolvedRefinementStage(tags, fallbackStage = "draft") {
	const normalizedTags = normalizeTags(tags);
	const normalizedStage = refinementStageFromTags(normalizedTags) || validateRefinementStage(fallbackStage || "draft");
	return [
		...normalizedTags.filter((tag) => !tag.toLowerCase().startsWith(REFINEMENT_TAG_PREFIX)),
		`${REFINEMENT_TAG_PREFIX}${normalizedStage}`,
	];
}

function tagsWithRefinementStage(tags, stage) {
	const normalizedStage = validateRefinementStage(stage);
	return tagsWithResolvedRefinementStage(
		[
			...normalizeTags(tags).filter((tag) => !tag.toLowerCase().startsWith(REFINEMENT_TAG_PREFIX)),
			`${REFINEMENT_TAG_PREFIX}${normalizedStage}`,
		],
		normalizedStage,
	);
}

function columnForTodo(todo) {
	if (isClosedStatus(todo.status)) return "done";
	return refinementStageFromTags(todo.tags) || "draft";
}

function isGrillRefinementTodo(todo) {
	return refinementStageFromTags(todo.tags) === "grill";
}

function expandHome(input) {
	const value = String(input || "").trim();
	if (value === "~") return os.homedir();
	if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
		return path.join(os.homedir(), value.slice(2));
	}
	return value;
}

function resolveConfiguredPath(value, baseDir) {
	const expanded = expandHome(value);
	if (!expanded) return null;
	return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(baseDir, expanded);
}

async function readSessionDirFromSettings(filePath, baseDir) {
	try {
		const raw = await fs.readFile(filePath, "utf8");
		const parsed = JSON.parse(raw);
		if (typeof parsed?.sessionDir !== "string" || !parsed.sessionDir.trim()) return null;
		return resolveConfiguredPath(parsed.sessionDir, baseDir);
	} catch {
		return null;
	}
}

async function resolvePiSessionDir() {
	if (process.env.PI_CODING_AGENT_SESSION_DIR?.trim()) {
		return {
			path: resolveConfiguredPath(process.env.PI_CODING_AGENT_SESSION_DIR, process.cwd()),
			source: "PI_CODING_AGENT_SESSION_DIR",
		};
	}

	const projectSessionDir = await readSessionDirFromSettings(PROJECT_SETTINGS_FILE, PROJECT_ROOT);
	if (projectSessionDir) return { path: projectSessionDir, source: PROJECT_SETTINGS_FILE };

	const globalSettings = path.join(os.homedir(), ".pi/agent/settings.json");
	const globalSessionDir = await readSessionDirFromSettings(globalSettings, os.homedir());
	if (globalSessionDir) return { path: globalSessionDir, source: globalSettings };

	return { path: path.join(os.homedir(), ".pi/agent/sessions"), source: "default" };
}

async function listSessionFiles(rootDir) {
	const files = [];
	const stack = [rootDir];
	while (stack.length) {
		const dir = stack.pop();
		let entries = [];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				stack.push(fullPath);
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				files.push(fullPath);
			}
		}
	}
	return files;
}

function extractTextContent(message) {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (typeof part === "string") return part;
			if (part?.type === "text" && typeof part.text === "string") return part.text;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function todoRefsInText(text) {
	const ids = new Set();
	const value = String(text || "");
	TODO_REF_PATTERN.lastIndex = 0;
	for (const match of value.matchAll(TODO_REF_PATTERN)) ids.add(match[1].toLowerCase());
	return ids;
}

function sessionLabel(session) {
	return session.name || session.initialPromptSnippet || session.id || path.basename(session.path);
}

function isLikelyGrillSession(name, initialPrompt) {
	return /grill(?:[-\s]?me)?/i.test(`${name || ""} ${initialPrompt || ""}`);
}

async function readPiSessionSummary(filePath, sessionRoot) {
	try {
		const [content, stat] = await Promise.all([fs.readFile(filePath, "utf8"), fs.stat(filePath)]);
		const lines = content.split(/\r?\n/);
		let header = null;
		let name;
		let initialPrompt = "";
		for (const line of lines) {
			if (!line.trim()) continue;
			if (!header) {
				try {
					header = JSON.parse(line);
				} catch {
					return null;
				}
				if (header?.type !== "session") return null;
				continue;
			}
			if (line.includes('"type":"session_info"') || line.includes('"type": "session_info"')) {
				try {
					const entry = JSON.parse(line);
					if (entry.type === "session_info") name = entry.name?.trim() || undefined;
				} catch {
					// ignore malformed metadata lines
				}
				continue;
			}
			if (!initialPrompt && (line.includes('"role":"user"') || line.includes('"role": "user"'))) {
				try {
					const entry = JSON.parse(line);
					if (entry.type === "message" && entry.message?.role === "user") initialPrompt = extractTextContent(entry.message);
				} catch {
					// ignore malformed message lines
				}
			}
		}
		if (!header) return null;
		const initialPromptSnippet = initialPrompt.replace(/\s+/g, " ").trim().slice(0, 140);
		const todoRefs = [...new Set([...todoRefsInText(name), ...todoRefsInText(initialPrompt)])];
		const isGrillSession = isLikelyGrillSession(name, initialPrompt);
		return {
			path: filePath,
			relativePath: path.relative(sessionRoot, filePath) || path.basename(filePath),
			id: typeof header.id === "string" ? header.id : undefined,
			cwd: typeof header.cwd === "string" ? header.cwd : undefined,
			name,
			created: typeof header.timestamp === "string" ? header.timestamp : undefined,
			modified: stat.mtime.toISOString(),
			initialPromptSnippet,
			isGrillSession,
			todoRefs,
		};
	} catch {
		return null;
	}
}

async function scanPiSessionsForTodos(todoIds) {
	const sessionDir = await resolvePiSessionDir();
	const wanted = new Set(todoIds.map((id) => String(id).toLowerCase()).filter(Boolean));
	const matches = new Map([...wanted].map((id) => [id, []]));
	if (!wanted.size) return { sessionDir, scanned: 0, matched: 0, matches };

	const files = await listSessionFiles(sessionDir.path);
	let scanned = 0;
	for (const file of files) {
		const session = await readPiSessionSummary(file, sessionDir.path);
		if (!session) continue;
		scanned += 1;
		if (!session.isGrillSession) continue;
		for (const id of session.todoRefs || []) {
			if (wanted.has(id)) matches.get(id).push(session);
		}
	}

	let matched = 0;
	for (const sessions of matches.values()) {
		sessions.sort((a, b) => (Date.parse(b.modified) || 0) - (Date.parse(a.modified) || 0));
		if (sessions.length) matched += 1;
	}
	return { sessionDir, scanned, matched, matches };
}

function attachPiSession(todo, sessionScan) {
	const sessions = sessionScan?.matches?.get(todo.id) || [];
	if (!sessions.length) return todo;
	const selected = sessions[0];
	const { todoRefs, isGrillSession, ...publicSession } = selected;
	return {
		...todo,
		grillSession: {
			...publicSession,
			displayName: sessionLabel(selected),
			matchCount: sessions.length,
			sessionDir: sessionScan.sessionDir.path,
			sessionDirSource: sessionScan.sessionDir.source,
		},
	};
}

async function attachPiSessionsForGrillTodos(todos) {
	const grillTodos = todos.filter(isGrillRefinementTodo);
	if (!grillTodos.length) return { todos, sessionScan: null };
	const sessionScan = await scanPiSessionsForTodos(grillTodos.map((todo) => todo.id));
	return {
		todos: todos.map((todo) => (isGrillRefinementTodo(todo) ? attachPiSession(todo, sessionScan) : todo)),
		sessionScan: {
			sessionDir: sessionScan.sessionDir.path,
			sessionDirSource: sessionScan.sessionDir.source,
			scanned: sessionScan.scanned,
			matched: sessionScan.matched,
		},
	};
}

function sortTodos(todos) {
	return [...todos].sort((a, b) => {
		const aTime = Date.parse(a.created_at || "") || 0;
		const bTime = Date.parse(b.created_at || "") || 0;
		if (aTime !== bTime) return aTime - bTime;
		return a.title.localeCompare(b.title);
	});
}

async function readLock(id) {
	const file = lockPath(id);
	try {
		const stat = await fs.stat(file);
		const ageMs = Date.now() - stat.mtimeMs;
		let info = null;
		try {
			info = JSON.parse(await fs.readFile(file, "utf8"));
		} catch {
			// ignore malformed lock info
		}
		return { exists: true, active: ageMs <= LOCK_TTL_MS, stale: ageMs > LOCK_TTL_MS, ageMs, info };
	} catch {
		return { exists: false, active: false, stale: false, ageMs: 0, info: null };
	}
}

async function acquireLock(id) {
	const file = lockPath(id);
	const current = await readLock(id);
	if (current.active) {
		const owner = current.info?.session ? ` by ${current.info.session}` : "";
		const error = new Error(`Todo is locked${owner}. Try again later.`);
		error.status = 423;
		throw error;
	}
	if (current.stale) await fs.unlink(file).catch(() => undefined);

	try {
		const handle = await fs.open(file, "wx");
		await handle.writeFile(
			JSON.stringify(
				{
					id,
					pid: process.pid,
					session: "grill-web",
					created_at: new Date().toISOString(),
				},
				null,
				2,
			),
			"utf8",
		);
		await handle.close();
	} catch (error) {
		if (error?.code === "EEXIST") {
			error.status = 423;
			error.message = "Todo is locked. Try again later.";
		}
		throw error;
	}

	return async () => {
		await fs.unlink(file).catch(() => undefined);
	};
}

async function withLock(id, fn) {
	const release = await acquireLock(id);
	try {
		return await fn();
	} finally {
		await release();
	}
}

async function readTodo(id) {
	const file = todoPath(id);
	const content = await fs.readFile(file, "utf8");
	const todo = parseTodoContent(content, id);
	const lock = await readLock(id);
	const detailedTodo = {
		...todo,
		hash: hashContent(content),
		refinementStage: refinementStageFromTags(todo.tags),
		column: columnForTodo(todo),
		lock: lock.exists ? lock : undefined,
		readOnly: Boolean(todo.assigned_to_session || lock.active),
		readOnlyReasons: [
			todo.assigned_to_session ? `Assigned to ${todo.assigned_to_session}` : null,
			lock.active ? "Locked by another writer" : null,
		].filter(Boolean),
	};
	if (!isGrillRefinementTodo(detailedTodo)) return detailedTodo;
	const { todos } = await attachPiSessionsForGrillTodos([detailedTodo]);
	return todos[0];
}

async function listTodos() {
	let entries = [];
	try {
		entries = await fs.readdir(TODO_DIR);
	} catch {
		return { todos: [], sessionScan: null };
	}
	const todos = [];
	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		const id = validateTodoId(entry.slice(0, -3));
		if (!id) continue;
		try {
			const file = todoPath(id);
			const content = await fs.readFile(file, "utf8");
			const todo = parseTodoContent(content, id);
			const lock = await readLock(id);
			todos.push({
				id,
				title: todo.title,
				tags: todo.tags,
				status: todo.status,
				created_at: todo.created_at,
				assigned_to_session: todo.assigned_to_session,
				hash: hashContent(content),
				refinementStage: refinementStageFromTags(todo.tags),
				column: columnForTodo(todo),
				locked: lock.active,
				readOnly: Boolean(todo.assigned_to_session || lock.active),
			});
		} catch {
			// Ignore unreadable todo files to match the TUI extension behavior.
		}
	}
	const enriched = await attachPiSessionsForGrillTodos(sortTodos(todos));
	return enriched;
}

function requireWriteToken(req) {
	const headerToken = req.headers["x-grill-web-token"];
	const token = Array.isArray(headerToken) ? headerToken[0] : headerToken;
	if (token !== TOKEN) {
		const error = new Error("Invalid or missing write token.");
		error.status = 403;
		throw error;
	}
}

async function readJsonBody(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	const raw = Buffer.concat(chunks).toString("utf8");
	if (!raw.trim()) return {};
	try {
		return JSON.parse(raw);
	} catch {
		const error = new Error("Invalid JSON body.");
		error.status = 400;
		throw error;
	}
}

function normalizeTags(tags) {
	if (!Array.isArray(tags)) return [];
	const seen = new Set();
	const normalized = [];
	for (const tag of tags) {
		const value = String(tag || "").trim();
		if (!value || seen.has(value)) continue;
		seen.add(value);
		normalized.push(value);
	}
	return normalized;
}

function validateWebStatus(status) {
	const value = String(status || "").trim().toLowerCase();
	if (!["open", "blocked", "review", "waiting", "closed"].includes(value)) {
		const error = new Error("Unsupported status for web UI.");
		error.status = 400;
		throw error;
	}
	return value;
}

function assertExpectedHash(payload, currentHash) {
	if (payload.expectedHash && payload.expectedHash !== currentHash) {
		const error = new Error("Todo changed externally. Reload before saving.");
		error.status = 409;
		throw error;
	}
}

function assertTodoWritableInWeb(todo) {
	if (todo.assigned_to_session) {
		const error = new Error(`Todo is assigned to ${todo.assigned_to_session} and is read-only in Grill Web.`);
		error.status = 423;
		throw error;
	}
}

function todoWriteResponse(todo, serialized) {
	return {
		...todo,
		hash: hashContent(serialized),
		refinementStage: refinementStageFromTags(todo.tags),
		column: columnForTodo(todo),
		readOnly: false,
		readOnlyReasons: [],
	};
}

async function updateTodo(id, payload, mode) {
	return withLock(id, async () => {
		const file = todoPath(id);
		const content = await fs.readFile(file, "utf8");
		const currentHash = hashContent(content);
		assertExpectedHash(payload, currentHash);

		const todo = parseTodoContent(content, id);
		assertTodoWritableInWeb(todo);

		if (mode === "status") {
			todo.status = validateWebStatus(payload.status);
			if (isClosedStatus(todo.status)) todo.assigned_to_session = undefined;
		} else {
			if (typeof payload.title !== "string" || !payload.title.trim()) {
				const error = new Error("Title is required.");
				error.status = 400;
				throw error;
			}
			todo.title = payload.title.trim();
			todo.status = validateWebStatus(payload.status);
			todo.tags = tagsWithResolvedRefinementStage(payload.tags, refinementStageFromTags(todo.tags) || "draft");
			todo.body = typeof payload.body === "string" ? payload.body : "";
			if (isClosedStatus(todo.status)) todo.assigned_to_session = undefined;
		}

		const serialized = serializeTodo(todo);
		await fs.writeFile(file, serialized, "utf8");
		return todoWriteResponse(todo, serialized);
	});
}

async function updateRefinementStage(id, payload) {
	return withLock(id, async () => {
		const file = todoPath(id);
		const content = await fs.readFile(file, "utf8");
		assertExpectedHash(payload, hashContent(content));

		const todo = parseTodoContent(content, id);
		assertTodoWritableInWeb(todo);
		todo.tags = tagsWithRefinementStage(todo.tags, payload.stage);

		const serialized = serializeTodo(todo);
		await fs.writeFile(file, serialized, "utf8");
		return todoWriteResponse(todo, serialized);
	});
}

async function rewriteTodo(id, payload) {
	return withLock(id, async () => {
		const file = todoPath(id);
		const content = await fs.readFile(file, "utf8");
		assertExpectedHash(payload, hashContent(content));

		const todo = parseTodoContent(content, id);
		assertTodoWritableInWeb(todo);
		if (typeof payload.title !== "string" || !payload.title.trim()) {
			const error = new Error("Title is required.");
			error.status = 400;
			throw error;
		}
		if (!Array.isArray(payload.tags)) {
			const error = new Error("Tags must be an array.");
			error.status = 400;
			throw error;
		}
		if (typeof payload.body !== "string") {
			const error = new Error("Body must be a markdown string.");
			error.status = 400;
			throw error;
		}

		todo.title = payload.title.trim();
		todo.tags = payload.refinementStage
			? tagsWithRefinementStage(payload.tags, payload.refinementStage)
			: tagsWithResolvedRefinementStage(payload.tags, refinementStageFromTags(todo.tags) || "draft");
		todo.body = payload.body;
		if (!todo.created_at) todo.created_at = new Date().toISOString();

		const serialized = serializeTodo(todo);
		await fs.writeFile(file, serialized, "utf8");
		return todoWriteResponse(todo, serialized);
	});
}

function expandTilde(value) {
	const textValue = String(value || "");
	if (textValue === "~") return os.homedir();
	if (textValue.startsWith("~/")) return path.join(os.homedir(), textValue.slice(2));
	return textValue;
}

function defaultAgentDir() {
	return path.resolve(expandTilde(process.env.PI_CODING_AGENT_DIR || "~/.pi/agent"));
}

function defaultSessionDir(cwd = PROJECT_ROOT) {
	const resolvedCwd = path.resolve(cwd);
	const safePath = `--${resolvedCwd.replace(/^[\\/]/, "").replace(/[\\/:]/g, "-")}--`;
	return path.join(defaultAgentDir(), "sessions", safePath);
}

function piSessionDir() {
	const fromEnv = process.env.PI_CODING_AGENT_SESSION_DIR;
	if (fromEnv) return path.resolve(PROJECT_ROOT, expandTilde(fromEnv));
	return defaultSessionDir(PROJECT_ROOT);
}

async function listGrillSessionFiles() {
	const configured = await resolvePiSessionDir();
	const roots = [...new Set([piSessionDir(), configured.path].filter(Boolean))];
	const seen = new Set();
	const files = [];
	for (const root of roots) {
		for (const sessionPath of await listSessionFiles(root)) {
			if (seen.has(sessionPath)) continue;
			seen.add(sessionPath);
			try {
				const stat = await fs.stat(sessionPath);
				files.push({ path: sessionPath, modified: stat.mtimeMs });
			} catch {
				// Ignore sessions removed during scanning.
			}
		}
	}
	return files.sort((a, b) => b.modified - a.modified);
}

async function readSessionSummary(sessionPath) {
	const content = await fs.readFile(sessionPath, "utf8");
	const lines = content.trim().split(/\r?\n/).filter(Boolean);
	let header = null;
	let name = "";
	for (const line of lines) {
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type === "session") header = entry;
		if (entry.type === "session_info" && typeof entry.name === "string") name = entry.name;
	}
	return { path: sessionPath, id: header?.id, cwd: header?.cwd, name };
}

async function findSessionById(sessionId) {
	if (!sessionId) return null;
	for (const file of await listGrillSessionFiles()) {
		if (path.basename(file.path).includes(sessionId)) return file.path;
		try {
			const summary = await readSessionSummary(file.path);
			if (summary.id === sessionId) return file.path;
		} catch {
			// Ignore malformed session files.
		}
	}
	return null;
}

async function findSessionByIdWithRetry(sessionId) {
	for (let attempt = 0; attempt < 12; attempt += 1) {
		const sessionPath = await findSessionById(sessionId);
		if (sessionPath) return sessionPath;
		await new Promise((resolve) => setTimeout(resolve, 80));
	}
	return null;
}

async function findLatestGrillSession(id) {
	const needle = `grill TODO-${id}`.toLowerCase();
	for (const file of await listGrillSessionFiles()) {
		try {
			const summary = await readSessionSummary(file.path);
			if (summary.cwd && path.resolve(summary.cwd) !== PROJECT_ROOT) continue;
			if (String(summary.name || "").toLowerCase().startsWith(needle)) {
				return { ...summary, path: file.path, modified: file.modified };
			}
		} catch {
			// Ignore malformed session files.
		}
	}
	return null;
}

function assistantText(message) {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

function contentCharEstimate(content) {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const part of content) {
		if (typeof part === "string") chars += part.length;
		else if (part?.type === "text" && typeof part.text === "string") chars += part.text.length;
		else if (part?.type === "thinking" && typeof part.thinking === "string") chars += part.thinking.length;
		else if (part?.type === "toolCall") chars += String(part.name || "").length + JSON.stringify(part.arguments || {}).length;
		else if (part?.type === "image") chars += 4800;
	}
	return chars;
}

function estimateMessageTokens(message) {
	const role = message?.role;
	if (role === "bashExecution") return Math.ceil((String(message.command || "").length + String(message.output || "").length) / 4);
	if (role === "branchSummary" || role === "compactionSummary") return Math.ceil(String(message.summary || "").length / 4);
	return Math.ceil(contentCharEstimate(message?.content) / 4);
}

function usageTokenCount(usage) {
	if (!usage) return 0;
	return Number(usage.totalTokens) || Number(usage.input || 0) + Number(usage.output || 0) + Number(usage.cacheRead || 0) + Number(usage.cacheWrite || 0);
}

function entryToContextMessage(entry) {
	if (entry.type === "message") return entry.message;
	if (entry.type === "custom_message") return { role: "custom", content: [{ type: "text", text: entry.content || "" }], timestamp: entry.timestamp };
	if (entry.type === "branch_summary") return { role: "branchSummary", summary: entry.summary || "", timestamp: entry.timestamp };
	if (entry.type === "compaction") return { role: "compactionSummary", summary: entry.summary || "", timestamp: entry.timestamp };
	return null;
}

function estimateContextTokensFromEntries(entries) {
	const messages = entries.map(entryToContextMessage).filter(Boolean);
	let lastUsageIndex = -1;
	let usageTokens = 0;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== "assistant" || message.stopReason === "aborted" || message.stopReason === "error") continue;
		const tokens = usageTokenCount(message.usage);
		if (!tokens) continue;
		lastUsageIndex = index;
		usageTokens = tokens;
		break;
	}
	let trailingTokens = 0;
	const startIndex = lastUsageIndex >= 0 ? lastUsageIndex + 1 : 0;
	for (let index = startIndex; index < messages.length; index += 1) trailingTokens += estimateMessageTokens(messages[index]);
	return {
		tokens: usageTokens + trailingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex: lastUsageIndex >= 0 ? lastUsageIndex : null,
		estimated: lastUsageIndex < 0 || trailingTokens > 0,
	};
}

let piModelsPromise;
async function loadPiModels() {
	if (!piModelsPromise) {
		piModelsPromise = (async () => {
			for (const candidate of PI_AI_MODELS_CANDIDATES) {
				try {
					if (!candidate || !existsSync(candidate)) continue;
					const module = await import(pathToFileURL(candidate).href);
					if (module?.MODELS) return module.MODELS;
				} catch {
					// Try the next known installation path.
				}
			}
			return null;
		})();
	}
	return piModelsPromise;
}

function fallbackContextWindow(provider, modelId) {
	const id = String(modelId || "").toLowerCase();
	const providerId = String(provider || "").toLowerCase();
	if (!id) return 0;
	if (providerId === "openai-codex" && /^gpt-5\.[45]/.test(id)) return 272000;
	if (id.includes("gpt-5.3-codex-spark")) return 128000;
	if (id.includes("gpt-5") && id.includes("codex")) return 400000;
	if (id.includes("gpt-5.4") || id.includes("gpt-5.5")) return providerId === "github-copilot" ? 400000 : 272000;
	if (id.includes("claude") || id.includes("gemini")) return 200000;
	if (id.includes("gpt-4")) return 128000;
	return 0;
}

async function contextWindowForModel(provider, modelId) {
	const models = await loadPiModels();
	const direct = models?.[provider]?.[modelId]?.contextWindow;
	if (direct) return direct;
	if (models && modelId) {
		for (const providerModels of Object.values(models)) {
			const contextWindow = providerModels?.[modelId]?.contextWindow;
			if (contextWindow) return contextWindow;
		}
	}
	return fallbackContextWindow(provider, modelId);
}

function latestModelFromEntries(entries) {
	let model = null;
	for (const entry of entries) {
		if (entry.type === "model_change") {
			model = { provider: entry.provider || "", id: entry.modelId || "" };
		} else if (entry.type === "message" && entry.message?.role === "assistant") {
			if (entry.message.provider || entry.message.model) {
				model = { provider: entry.message.provider || model?.provider || "", id: entry.message.model || model?.id || "" };
			}
		}
	}
	return model;
}

async function readPiSessionRuntimeStatus(sessionPath) {
	const content = await fs.readFile(sessionPath, "utf8");
	const entries = content
		.split(/\r?\n/)
		.filter((line) => line.trim())
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return null;
			}
		})
		.filter(Boolean);
	const model = latestModelFromEntries(entries) || { provider: "", id: "" };
	const usage = estimateContextTokensFromEntries(entries);
	const contextWindow = await contextWindowForModel(model.provider, model.id);
	const freeTokens = contextWindow ? Math.max(0, contextWindow - usage.tokens) : null;
	const percent = contextWindow ? Math.min(999, (usage.tokens / contextWindow) * 100) : null;
	return {
		model: {
			provider: model.provider || null,
			id: model.id || null,
			displayName: [model.provider, model.id].filter(Boolean).join(" / ") || null,
		},
		context: {
			tokens: usage.tokens,
			contextWindow: contextWindow || null,
			freeTokens,
			percent,
			estimated: usage.estimated,
		},
	};
}

function sendSse(res, payload) {
	res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sseHeaders(res) {
	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-store, no-transform",
		connection: "keep-alive",
	});
}

function buildGrillPrompt(todo, extraContext) {
	return `Use the grill-me skill to refine this todo through iterative, focused questions. Do not implement the todo and do not edit files. Ask one concise question at a time, wait for the user's answers, and keep drilling until the implementation plan is clear.

Todo:
- id: TODO-${todo.id}
- title: ${todo.title || "Untitled todo"}
- status: ${todo.status || "open"}
- tags: ${(todo.tags || []).join(", ") || "(none)"}

Todo body:
${todo.body?.trim() || "(empty)"}

User's additional context / initial plan:
${String(extraContext || "").trim() || "(none provided)"}`;
}

function buildFinalTodoPrompt(todo) {
	return `Based on the entire Grill-Me session so far, reformulate the existing todo into a final actionable implementation todo.

Output only parseable JSON. Do not include prose before or after the JSON. Do not ask another question.

Required JSON shape:
{
  "title": "short actionable title",
  "tags": ["tag", "epic:example"],
  "body": "Markdown implementation todo body"
}

Rules:
- Do not include any refinement:* tags.
- Preserve relevant epic:* tags unless the refined plan clearly moved to a different epic.
- Do not include or change technical status.
- Make the Markdown body directly useful for implementation: scope, decisions, acceptance criteria, important constraints, and notable open risks only if they still matter.

Current todo metadata for reference:
- id: TODO-${todo.id}
- title: ${todo.title || "Untitled todo"}
- status: ${todo.status || "open"}
- tags: ${(todo.tags || []).join(", ") || "(none)"}

Current todo body:
${todo.body?.trim() || "(empty)"}`;
}

function isPathInside(candidatePath, rootPath) {
	const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function allowedSessionRoots() {
	const configured = await resolvePiSessionDir();
	return [...new Set([piSessionDir(), configured.path].filter(Boolean).map((root) => path.resolve(root)))];
}

async function validateGrillSessionPathInput(value, id) {
	const raw = String(value || "").trim();
	if (!raw) return null;
	const resolved = path.resolve(PROJECT_ROOT, expandTilde(raw));
	const roots = await allowedSessionRoots();
	const matchingRoot = roots.find((root) => isPathInside(resolved, root));
	if (!matchingRoot || !resolved.endsWith(".jsonl") || !existsSync(resolved)) {
		const error = new Error("Session path is invalid or outside the Pi session directory.");
		error.status = 400;
		throw error;
	}

	const summary = await readPiSessionSummary(resolved, matchingRoot);
	const todoRefs = new Set((summary?.todoRefs || []).map((todoId) => todoId.toLowerCase()));
	const expectedName = `grill TODO-${id}`.toLowerCase();
	if (summary?.cwd && path.resolve(summary.cwd) !== PROJECT_ROOT) {
		const error = new Error("Session belongs to a different project.");
		error.status = 403;
		throw error;
	}
	if (!summary || (!todoRefs.has(id) && !String(summary.name || "").toLowerCase().startsWith(expectedName))) {
		const error = new Error(`Session does not belong to TODO-${id}.`);
		error.status = 403;
		throw error;
	}
	return resolved;
}

async function pathAccessStatus(targetPath, mode = FS_CONSTANTS.F_OK) {
	try {
		await fs.access(targetPath, mode);
		return true;
	} catch {
		return false;
	}
}

async function findExecutable(name) {
	const envPath = String(process.env.PATH || "");
	const pathEntries = envPath.split(path.delimiter).filter(Boolean);
	const extensions = process.platform === "win32"
		? String(process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
		: [""];
	for (const entry of pathEntries) {
		for (const extension of extensions) {
			const candidate = path.join(entry, process.platform === "win32" ? `${name}${extension}` : name);
			if (!existsSync(candidate)) continue;
			if (await pathAccessStatus(candidate, FS_CONSTANTS.X_OK)) return candidate;
		}
	}
	return null;
}

async function readProjectSettings() {
	try {
		const raw = await fs.readFile(PROJECT_SETTINGS_FILE, "utf8");
		return { file: PROJECT_SETTINGS_FILE, raw, parsed: JSON.parse(raw), exists: true };
	} catch (error) {
		return { file: PROJECT_SETTINGS_FILE, raw: "", parsed: null, exists: error?.code !== "ENOENT", error };
	}
}

function healthCheck(id, ok, message, extras = {}) {
	return { id, ok, message, ...extras };
}

async function collectHealthChecks() {
	const [piPath, sessionDir, settings, todoDirReadable, todoDirWritable, extensionExists, skillExists] = await Promise.all([
		findExecutable("pi"),
		resolvePiSessionDir().catch(() => null),
		readProjectSettings(),
		pathAccessStatus(TODO_DIR, FS_CONSTANTS.R_OK),
		pathAccessStatus(TODO_DIR, FS_CONSTANTS.W_OK),
		pathAccessStatus(EXTENSION_FILE),
		pathAccessStatus(SKILL_FILE),
	]);
	const packageEntries = Array.isArray(settings.parsed?.packages) ? settings.parsed.packages.filter((value) => typeof value === "string") : [];
	const packageRegistered = packageEntries.some((value) => value === "grill-web" || value === ".pi/grill-web" || value.endsWith("/grill-web") || value.endsWith("\\grill-web"));
	const todoDirExists = existsSync(TODO_DIR);
	const checks = [
		healthCheck("active-todo-path", true, `Using todo path ${TODO_DIR}.`, { path: TODO_DIR }),
		healthCheck(
			"pi-cli",
			Boolean(piPath),
			piPath ? `pi CLI found at ${piPath}.` : "pi CLI is not available on PATH.",
			piPath ? { path: piPath } : { fix: "Install Pi and ensure the `pi` command is available on PATH." },
		),
		healthCheck(
			"todo-directory",
			Boolean(todoDirExists && todoDirReadable && todoDirWritable),
			todoDirExists && todoDirReadable && todoDirWritable
				? `Todo directory is readable and writable: ${TODO_DIR}.`
				: `Todo directory must exist and be readable/writable: ${TODO_DIR}.`,
			{ path: TODO_DIR, fix: "Create the todo directory and grant read/write access, or set PI_TODO_PATH correctly." },
		),
		healthCheck(
			"todos-extension",
			Boolean(extensionExists),
			extensionExists ? `Todo extension found at ${EXTENSION_FILE}.` : `Missing required file: ${EXTENSION_FILE}.`,
			{ path: EXTENSION_FILE, fix: "Restore `.pi/grill-web/extensions/todos.ts`." },
		),
		healthCheck(
			"grill-skill",
			Boolean(skillExists),
			skillExists ? `Grill-Me skill found at ${SKILL_FILE}.` : `Missing required file: ${SKILL_FILE}.`,
			{ path: SKILL_FILE, fix: "Restore `.pi/grill-web/skills/grill-me/SKILL.md`." },
		),
		healthCheck(
			"package-registration",
			Boolean(packageRegistered),
			packageRegistered
				? `Project settings register grill-web in ${PROJECT_SETTINGS_FILE}.`
				: `Project settings do not register the local grill-web package in ${PROJECT_SETTINGS_FILE}.`,
			{ path: PROJECT_SETTINGS_FILE, fix: "cd ../.. && pi install -l .pi/grill-web" },
		),
		healthCheck(
			"session-directory",
			Boolean(sessionDir?.path),
			sessionDir?.path
				? `Session directory resolves to ${sessionDir.path} (${sessionDir.source}).`
				: "Session directory could not be resolved.",
			sessionDir?.path
				? { path: sessionDir.path, source: sessionDir.source, exists: existsSync(sessionDir.path) }
				: { fix: "Set PI_CODING_AGENT_SESSION_DIR or configure sessionDir in `.pi/settings.json`." },
		),
	];
	return {
		ok: checks.every((check) => check.ok),
		checks,
		todoDir: TODO_DIR,
		sessionDir: sessionDir?.path || null,
		sessionDirSource: sessionDir?.source || null,
		activeTodoPath: TODO_DIR,
		piPath,
	};
}

async function assertGrillActionReady() {
	const health = await collectHealthChecks();
	const required = ["pi-cli", "todo-directory", "todos-extension", "grill-skill", "package-registration", "session-directory"];
	const failing = health.checks.filter((check) => required.includes(check.id) && !check.ok);
	if (!failing.length) return health;
	const details = failing.map((check) => `${check.message}${check.fix ? ` Fix: ${check.fix}` : ""}`).join(" ");
	const error = new Error(`Grill-Me prerequisites failed. ${details}`);
	error.status = 503;
	error.health = health;
	throw error;
}

function streamPiJsonToSse(res, args) {
	sseHeaders(res);
	const sessionArgIndex = args.indexOf("--session");
	let sessionPath = sessionArgIndex >= 0 ? args[sessionArgIndex + 1] : null;
	let stdoutBuffer = "";
	let stderrBuffer = "";
	let childClosed = false;
	const pendingSessionLookups = [];
	const child = spawn("pi", args, {
		cwd: PROJECT_ROOT,
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	res.on("close", () => {
		if (!childClosed) child.kill("SIGTERM");
	});

	child.on("error", (error) => {
		sendSse(res, { type: "error", message: error.message || "Failed to start pi." });
		res.end();
	});

	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderrBuffer += chunk;
		const lines = stderrBuffer.split(/\r?\n/);
		stderrBuffer = lines.pop() || "";
		for (const line of lines) {
			if (line.trim()) sendSse(res, { type: "diagnostic", message: line });
		}
	});

	const handleLine = (line) => {
		if (!line.trim()) return;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			sendSse(res, { type: "diagnostic", message: line });
			return;
		}
		sendSse(res, { type: "pi", event });
		if (event.type === "session") {
			const lookup = findSessionByIdWithRetry(event.id).then((foundPath) => {
				if (foundPath) sessionPath = foundPath;
				if (!res.writableEnded) sendSse(res, { type: "session", id: event.id, cwd: event.cwd, sessionPath: foundPath });
			});
			pendingSessionLookups.push(lookup);
		}
		if (event.type === "message_update" && event.message?.role === "assistant") {
			const assistantEvent = event.assistantMessageEvent || {};
			if (assistantEvent.type === "text_delta" && typeof assistantEvent.delta === "string") {
				sendSse(res, { type: "assistant_delta", delta: assistantEvent.delta });
			}
		}
		if (event.type === "message_end" && event.message?.role === "assistant") {
			const text = assistantText(event.message);
			if (text.trim()) sendSse(res, { type: "assistant_message", text });
		}
	};

	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdoutBuffer += chunk;
		const lines = stdoutBuffer.split(/\r?\n/);
		stdoutBuffer = lines.pop() || "";
		for (const line of lines) handleLine(line);
	});

	child.on("close", async (code) => {
		childClosed = true;
		if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
		if (stderrBuffer.trim()) sendSse(res, { type: "diagnostic", message: stderrBuffer.trim() });
		await Promise.allSettled(pendingSessionLookups);
		const contextStatus = sessionPath ? await readPiSessionRuntimeStatus(sessionPath).catch(() => null) : null;
		if (code !== 0) sendSse(res, { type: "error", message: `pi exited with code ${code}.` });
		sendSse(res, { type: "done", exitCode: code, sessionPath, contextStatus });
		res.end();
	});
}

async function startGrillSession(req, res, id) {
	requireWriteToken(req);
	const payload = await readJsonBody(req);
	await assertGrillActionReady();
	const updatedTodo = await updateRefinementStage(id, { expectedHash: payload.expectedHash, stage: "grill" });
	const prompt = buildGrillPrompt(updatedTodo, payload.context);
	const name = `grill TODO-${id} ${updatedTodo.title || "Untitled todo"}`;
	streamPiJsonToSse(res, [
		"--mode",
		"json",
		"--name",
		name,
		"--skill",
		path.join(__dirname, "skills/grill-me/SKILL.md"),
		"--tools",
		"read,grep,find,ls",
		prompt,
	]);
}

async function createBranchSession(sessionPath, id, assistantOrdinal) {
	const ordinal = Number.parseInt(String(assistantOrdinal), 10);
	if (!Number.isInteger(ordinal) || ordinal < 0) {
		const error = new Error("Invalid branch question.");
		error.status = 400;
		throw error;
	}
	const content = await fs.readFile(sessionPath, "utf8");
	const { lines, messages, skippedLineIndexes } = parseGrillTranscriptContent(content, id);
	const target = messages.find((message) => message.role === "assistant" && message.assistantOrdinal === ordinal);
	if (!target) {
		const error = new Error("Branch question was not found in this Grill-Me session.");
		error.status = 400;
		throw error;
	}
	const branchLines = lines
		.slice(0, target.lineIndex + 1)
		.filter((_, lineIndex) => !skippedLineIndexes.has(lineIndex));
	const branchPath = path.join(
		path.dirname(sessionPath),
		`${new Date().toISOString().replace(/[:.]/g, "-")}_branch-TODO-${id}-${crypto.randomBytes(4).toString("hex")}.jsonl`,
	);
	await fs.writeFile(branchPath, `${branchLines.join("\n").replace(/\n*$/, "")}\n`, "utf8");
	return branchPath;
}

async function continueGrillSession(req, res, id) {
	requireWriteToken(req);
	const payload = await readJsonBody(req);
	await assertGrillActionReady();
	const answer = String(payload.answer || "").trim();
	if (!answer) {
		const error = new Error("Answer is required.");
		error.status = 400;
		throw error;
	}
	const baseSessionPath = (await validateGrillSessionPathInput(payload.sessionPath, id)) || (await findLatestGrillSession(id))?.path;
	if (!baseSessionPath) {
		const error = new Error(`No Grill-Me session found for TODO-${id}. Start one first.`);
		error.status = 404;
		throw error;
	}
	const sessionPath = payload.branchFromAssistantOrdinal === undefined || payload.branchFromAssistantOrdinal === null
		? baseSessionPath
		: await createBranchSession(baseSessionPath, id, payload.branchFromAssistantOrdinal);
	streamPiJsonToSse(res, ["--mode", "json", "--session", sessionPath, answer]);
}

async function finalizeGrillSession(req, res, id) {
	requireWriteToken(req);
	await assertGrillActionReady();
	const payload = await readJsonBody(req);
	const sessionPath = (await validateGrillSessionPathInput(payload.sessionPath, id)) || (await findLatestGrillSession(id))?.path;
	if (!sessionPath) {
		const error = new Error(`No Grill-Me session found for TODO-${id}. Start one first.`);
		error.status = 404;
		throw error;
	}
	const todo = await readTodo(id);
	streamPiJsonToSse(res, ["--mode", "json", "--session", sessionPath, buildFinalTodoPrompt(todo)]);
}

function isInitialGrillPrompt(message, todoId) {
	return message?.role === "user" && message.text.includes(`TODO-${todoId}`) && message.text.includes("Use the grill-me skill");
}

function isFinalTodoPrompt(text) {
	const value = String(text || "");
	return value.includes("Based on the entire Grill-Me session so far") && value.includes("Required JSON shape");
}

function parseGrillTranscriptContent(content, todoId) {
	const lines = content.split(/\r?\n/);
	const records = [];
	for (const [lineIndex, line] of lines.entries()) {
		if (!line.trim()) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type !== "message" || !["user", "assistant"].includes(entry.message?.role)) continue;
		const textContent = extractTextContent(entry.message).trim();
		if (!textContent) continue;
		records.push({
			role: entry.message.role,
			text: textContent,
			timestamp: entry.timestamp || entry.message?.timestamp,
			lineIndex,
		});
	}

	const skippedLineIndexes = new Set();
	let visible = records;
	if (isInitialGrillPrompt(visible[0], todoId)) {
		skippedLineIndexes.add(visible[0].lineIndex);
		visible = visible.slice(1);
	}

	const withoutFinalization = [];
	for (let index = 0; index < visible.length; index += 1) {
		const record = visible[index];
		if (record.role === "user" && isFinalTodoPrompt(record.text)) {
			skippedLineIndexes.add(record.lineIndex);
			if (visible[index + 1]?.role === "assistant") {
				skippedLineIndexes.add(visible[index + 1].lineIndex);
				index += 1;
			}
			continue;
		}
		withoutFinalization.push(record);
	}

	let assistantOrdinal = 0;
	const messages = withoutFinalization.map((record) => {
		const message = { ...record };
		if (message.role === "assistant") {
			message.assistantOrdinal = assistantOrdinal;
			assistantOrdinal += 1;
		}
		return message;
	});
	return { lines, messages, skippedLineIndexes };
}

async function readGrillTranscript(sessionPath, todoId) {
	const content = await fs.readFile(sessionPath, "utf8");
	return parseGrillTranscriptContent(content, todoId).messages.map(({ lineIndex, ...message }) => message);
}

async function grillHistory(id, sessionPathInput) {
	const sessionPath = (await validateGrillSessionPathInput(sessionPathInput, id)) || (await findLatestGrillSession(id))?.path;
	if (!sessionPath) return { session: null, messages: [], contextStatus: null };
	const summary = await readSessionSummary(sessionPath).catch(() => ({ path: sessionPath }));
	const roots = await allowedSessionRoots();
	const relativeRoot = roots.find((root) => isPathInside(sessionPath, root)) || path.dirname(sessionPath);
	return {
		session: {
			...summary,
			path: sessionPath,
			relativePath: path.relative(relativeRoot, sessionPath) || path.basename(sessionPath),
			displayName: sessionLabel(summary),
		},
		messages: await readGrillTranscript(sessionPath, id),
		contextStatus: await readPiSessionRuntimeStatus(sessionPath).catch(() => null),
	};
}

const MIME = new Map([
	[".html", "text/html; charset=utf-8"],
	[".js", "text/javascript; charset=utf-8"],
	[".css", "text/css; charset=utf-8"],
	[".svg", "image/svg+xml"],
	[".json", "application/json; charset=utf-8"],
]);

async function serveFile(res, requestPath) {
	const decodedPath = decodeURIComponent(requestPath === "/" ? "/index.html" : requestPath);
	let filePath;
	if (decodedPath === "/vendor/marked.esm.js") {
		filePath = MARKED_ESM;
	} else {
		filePath = path.resolve(PUBLIC_DIR, `.${decodedPath}`);
		if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, "index.html")) {
			return text(res, 403, "Forbidden");
		}
	}
	try {
		const body = await fs.readFile(filePath);
		const type = MIME.get(path.extname(filePath)) || "application/octet-stream";
		res.writeHead(200, { "content-type": type });
		res.end(body);
	} catch {
		text(res, 404, "Not found");
	}
}

async function route(req, res) {
	const url = new URL(req.url, `http://${req.headers.host}`);
	const pathname = url.pathname;

	try {
		if (pathname === "/api/health") {
			return json(res, 200, await collectHealthChecks());
		}
		if (pathname === "/api/todos" && req.method === "GET") {
			const { todos, sessionScan } = await listTodos();
			return json(res, 200, { todos, sessionScan });
		}
		const detailMatch = pathname.match(/^\/api\/todos\/([a-fA-F0-9]{8})$/);
		const statusMatch = pathname.match(/^\/api\/todos\/([a-fA-F0-9]{8})\/status$/);
		const refinementMatch = pathname.match(/^\/api\/todos\/([a-fA-F0-9]{8})\/(?:refinement|refinement-stage)$/);
		const rewriteMatch = pathname.match(/^\/api\/todos\/([a-fA-F0-9]{8})\/(?:rewrite|final-rewrite)$/);
		const grillStartMatch = pathname.match(/^\/api\/todos\/([a-fA-F0-9]{8})\/grill\/start$/);
		const grillContinueMatch = pathname.match(/^\/api\/todos\/([a-fA-F0-9]{8})\/grill\/continue$/);
		const grillFinalizeMatch = pathname.match(/^\/api\/todos\/([a-fA-F0-9]{8})\/grill\/finalize$/);
		const grillHistoryMatch = pathname.match(/^\/api\/todos\/([a-fA-F0-9]{8})\/grill\/history$/);
		if (detailMatch && req.method === "GET") {
			const id = validateTodoId(detailMatch[1]);
			if (!id || !existsSync(todoPath(id))) return json(res, 404, { error: "Todo not found." });
			return json(res, 200, { todo: await readTodo(id) });
		}
		if (detailMatch && req.method === "PUT") {
			requireWriteToken(req);
			const id = validateTodoId(detailMatch[1]);
			if (!id || !existsSync(todoPath(id))) return json(res, 404, { error: "Todo not found." });
			const payload = await readJsonBody(req);
			return json(res, 200, { todo: await updateTodo(id, payload, "full") });
		}
		if (statusMatch && req.method === "PATCH") {
			requireWriteToken(req);
			const id = validateTodoId(statusMatch[1]);
			if (!id || !existsSync(todoPath(id))) return json(res, 404, { error: "Todo not found." });
			const payload = await readJsonBody(req);
			return json(res, 200, { todo: await updateTodo(id, payload, "status") });
		}
		if (refinementMatch && req.method === "PATCH") {
			requireWriteToken(req);
			const id = validateTodoId(refinementMatch[1]);
			if (!id || !existsSync(todoPath(id))) return json(res, 404, { error: "Todo not found." });
			const payload = await readJsonBody(req);
			return json(res, 200, { todo: await updateRefinementStage(id, payload) });
		}
		if (rewriteMatch && req.method === "PUT") {
			requireWriteToken(req);
			const id = validateTodoId(rewriteMatch[1]);
			if (!id || !existsSync(todoPath(id))) return json(res, 404, { error: "Todo not found." });
			const payload = await readJsonBody(req);
			return json(res, 200, { todo: await rewriteTodo(id, payload) });
		}
		if (grillStartMatch && req.method === "POST") {
			const id = validateTodoId(grillStartMatch[1]);
			if (!id || !existsSync(todoPath(id))) return json(res, 404, { error: "Todo not found." });
			return await startGrillSession(req, res, id);
		}
		if (grillContinueMatch && req.method === "POST") {
			const id = validateTodoId(grillContinueMatch[1]);
			if (!id || !existsSync(todoPath(id))) return json(res, 404, { error: "Todo not found." });
			return await continueGrillSession(req, res, id);
		}
		if (grillFinalizeMatch && req.method === "POST") {
			const id = validateTodoId(grillFinalizeMatch[1]);
			if (!id || !existsSync(todoPath(id))) return json(res, 404, { error: "Todo not found." });
			return await finalizeGrillSession(req, res, id);
		}
		if (grillHistoryMatch && req.method === "GET") {
			const id = validateTodoId(grillHistoryMatch[1]);
			if (!id || !existsSync(todoPath(id))) return json(res, 404, { error: "Todo not found." });
			return json(res, 200, await grillHistory(id, url.searchParams.get("sessionPath")));
		}
		if (pathname.startsWith("/api/")) return json(res, 404, { error: "API route not found." });
		if (pathname.match(/^\/grill\/(?:TODO-)?[a-fA-F0-9]{8}$/)) return serveFile(res, "/");
		return serveFile(res, pathname);
	} catch (error) {
		const status = error.status || 500;
		return json(res, status, { error: error.message || "Internal server error." });
	}
}

const server = http.createServer((req, res) => {
	route(req, res).catch((error) => json(res, 500, { error: error.message || "Internal server error." }));
});

server.listen(PORT, HOST, () => {
	const url = `http://${HOST}:${PORT}/?token=${encodeURIComponent(TOKEN)}`;
	console.log(`grill-web running at ${url}`);
	console.log("Mode: board overview with status updates");
	console.log(`Todo directory: ${TODO_DIR}`);
	if (process.env.OPEN_BROWSER === "1") openBrowser(url);
});

function openBrowser(url) {
	const platform = process.platform;
	const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
	const args = platform === "win32" ? ["/c", "start", "", url] : [url];
	spawn(command, args, { detached: true, stdio: "ignore" }).unref();
}
