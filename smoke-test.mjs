import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const PROJECT_SETTINGS_FILE = path.join(PROJECT_ROOT, ".pi/settings.json");
const TOKEN = "grill-web-smoke-token";

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

async function assertRejects(promise, pattern, message) {
	try {
		await promise;
	} catch (error) {
		assert(pattern.test(String(error?.message || error)), message);
		return;
	}
	throw new Error(message);
}

async function writeTodo(todoDir, id, { title, tags = [], status = "open", body = "", created_at = "2026-01-01T00:00:00.000Z" }) {
	const frontMatter = JSON.stringify({ id, title, tags, status, created_at }, null, 2);
	await fs.writeFile(path.join(todoDir, `${id}.md`), `${frontMatter}\n\n${body}\n`, "utf8");
}

function requestJson(port, route, options = {}) {
	return new Promise((resolve, reject) => {
		const body = options.body === undefined ? undefined : JSON.stringify(options.body);
		const req = http.request(
			{
				host: "127.0.0.1",
				port,
				path: route,
				method: options.method || "GET",
				headers: {
					accept: "application/json",
					...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}),
					...(options.token ? { "x-grill-web-token": TOKEN } : {}),
				},
			},
			(res) => {
				let raw = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => {
					raw += chunk;
				});
				res.on("end", () => {
					let parsed = {};
					try {
						parsed = raw ? JSON.parse(raw) : {};
					} catch (error) {
						reject(new Error(`Invalid JSON response from ${route}: ${error.message}\n${raw}`));
						return;
					}
					if (res.statusCode < 200 || res.statusCode >= 300) {
						reject(new Error(parsed.error || `HTTP ${res.statusCode} for ${route}`));
						return;
					}
					resolve(parsed);
				});
			},
		);
		req.on("error", reject);
		if (body) req.write(body);
		req.end();
	});
}

function requestSse(port, route, body, options = {}) {
	return new Promise((resolve, reject) => {
		const rawBody = JSON.stringify(body || {});
		const events = [];
		const headers = {
			accept: "text/event-stream",
			"content-type": "application/json",
			"content-length": Buffer.byteLength(rawBody),
		};
		if (options.token !== false) headers["x-grill-web-token"] = TOKEN;
		const req = http.request(
			{
				host: "127.0.0.1",
				port,
				path: route,
				method: "POST",
				headers,
			},
			(res) => {
				let raw = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => {
					raw += chunk;
				});
				res.on("end", () => {
					if (res.statusCode < 200 || res.statusCode >= 300) {
						try {
							const parsed = JSON.parse(raw);
							reject(new Error(parsed.error || `HTTP ${res.statusCode} for ${route}`));
						} catch {
							reject(new Error(`HTTP ${res.statusCode} for ${route}: ${raw}`));
						}
						return;
					}
					for (const block of raw.split(/\n\n/)) {
						const data = block
							.split(/\r?\n/)
							.filter((line) => line.startsWith("data:"))
							.map((line) => line.slice(5).trimStart())
							.join("\n");
						if (data) events.push(JSON.parse(data));
					}
					resolve(events);
				});
			},
		);
		req.on("error", reject);
		req.write(rawBody);
		req.end();
	});
}

async function waitForServer(port) {
	let lastError;
	for (let attempt = 0; attempt < 80; attempt += 1) {
		try {
			await requestJson(port, "/api/health");
			return;
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	throw lastError || new Error("Server did not start.");
}

async function makeFakePi(binDir, sessionDir, callsFile) {
	const fakePi = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const callsFile = process.env.SMOKE_PI_CALLS_FILE;
const sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
fs.appendFileSync(callsFile, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
const sessionIndex = args.indexOf('--session');
const nameIndex = args.indexOf('--name');
const name = nameIndex >= 0 ? args[nameIndex + 1] : 'grill TODO-aaaaaaaa existing';
const prompt = args[args.length - 1] || '';
function emit(event) { console.log(JSON.stringify(event)); }
if (sessionIndex < 0) {
  const id = 'smoke-start-session';
  const file = path.join(sessionDir, id + '.jsonl');
  fs.mkdirSync(sessionDir, { recursive: true });
  const firstQuestion = 'What is the first constraint?';
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'session', id, timestamp: new Date().toISOString(), cwd: process.cwd() }),
    JSON.stringify({ type: 'model_change', timestamp: new Date().toISOString(), provider: 'openai-codex', modelId: 'gpt-5.5' }),
    JSON.stringify({ type: 'session_info', name }),
    JSON.stringify({ type: 'message', timestamp: new Date().toISOString(), message: { role: 'user', content: prompt } }),
    JSON.stringify({ type: 'message', timestamp: new Date().toISOString(), message: { role: 'assistant', provider: 'openai-codex', model: 'gpt-5.5', content: [{ type: 'text', text: firstQuestion }], usage: { input: 1000, output: 234, cacheRead: 0, cacheWrite: 0, totalTokens: 1234, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }),
  ].join('\\n') + '\\n');
  emit({ type: 'session', id, cwd: process.cwd() });
  emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: firstQuestion }] } });
} else if (prompt.includes('Required JSON shape')) {
  emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ title: 'Final implementation todo', tags: ['epic:grill-web', 'qa', 'refinement:grill'], body: '## Scope\\nImplement the reviewed plan.' }) }] } });
} else {
  emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Follow-up question from matched session.' }] } });
}
`;
	const file = path.join(binDir, "pi");
	await fs.writeFile(file, fakePi, "utf8");
	await fs.chmod(file, 0o755);
}

async function runServer(port, todoDir, sessionDir, binDir, extraEnv = {}) {
	const server = spawn(process.execPath, [path.join(__dirname, "server.mjs")], {
		cwd: __dirname,
		env: {
			...process.env,
			PORT: String(port),
			GRILL_WEB_TOKEN: TOKEN,
			PI_TODO_PATH: todoDir,
			PI_CODING_AGENT_SESSION_DIR: sessionDir,
			PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
			SMOKE_PI_CALLS_FILE: extraEnv.SMOKE_PI_CALLS_FILE,
			...extraEnv,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stderr = "";
	server.stderr.setEncoding("utf8");
	server.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	await waitForServer(port);
	return { server, stderrRef: () => stderr };
}

async function stopServer(server) {
	server.kill("SIGTERM");
	await new Promise((resolve) => server.once("exit", resolve));
}

async function run() {
	const originalSettings = await fs.readFile(PROJECT_SETTINGS_FILE, "utf8").catch(() => null);
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "grill-web-smoke-"));
	const todoDir = path.join(tmp, "todos");
	const sessionDir = path.join(tmp, "sessions");
	const binDir = path.join(tmp, "bin");
	const callsFile = path.join(tmp, "pi-calls.jsonl");
	await fs.mkdir(todoDir, { recursive: true });
	await fs.mkdir(sessionDir, { recursive: true });
	await fs.mkdir(binDir, { recursive: true });
	await makeFakePi(binDir, sessionDir, callsFile);

	await writeTodo(todoDir, "aaaaaaaa", { title: "Draft", tags: ["epic:grill-web"], body: "Draft body" });
	await writeTodo(todoDir, "bbbbbbbb", { title: "Grill", tags: ["refinement:grill"], body: "Grill body" });
	await writeTodo(todoDir, "cccccccc", { title: "Ready", tags: ["refinement:ready"], body: "Ready body" });
	await writeTodo(todoDir, "dddddddd", { title: "Closed", tags: ["refinement:ready"], status: "closed", body: "Closed body" });

	let serverHandle;
	try {
		await fs.writeFile(PROJECT_SETTINGS_FILE, `${JSON.stringify({ packages: ["grill-web"] }, null, 2)}\n`, "utf8");
		const port = 19000 + Math.floor(Math.random() * 1000);
		serverHandle = await runServer(port, todoDir, sessionDir, binDir, { SMOKE_PI_CALLS_FILE: callsFile });

		const board = await requestJson(port, "/api/todos");
		const health = await requestJson(port, "/api/health");
		const byId = Object.fromEntries(board.todos.map((todo) => [todo.id, todo]));
		assert(health.todoDir === todoDir, "Health should report the PI_TODO_PATH todo directory.");
		assert(health.ok === true, "Health should be green when all prerequisites are present.");
		assert(health.activeTodoPath === todoDir, "Health should report the active todo path.");
		assert(health.checks.every((check) => check.ok), "Healthy setup should not report failing checks.");
		assert(byId.aaaaaaaa.column === "draft", "Draft todo should appear in Problem Draft.");
		assert(byId.bbbbbbbb.column === "grill", "Grill todo should appear in In Grill-Me.");
		assert(byId.cccccccc.column === "ready", "Ready todo should appear in Ready for Implementation.");
		assert(byId.dddddddd.column === "done", "Closed todo should always appear in Done.");

		const draftBeforeStart = await requestJson(port, "/api/todos/aaaaaaaa");
		await assertRejects(
			requestJson(port, "/api/todos/aaaaaaaa/status", {
				method: "PATCH",
				body: { expectedHash: draftBeforeStart.todo.hash, status: "blocked" },
			}),
			/Invalid or missing write token/,
			"Write endpoints should require x-grill-web-token.",
		);
		await assertRejects(
			requestSse(
				port,
				"/api/todos/aaaaaaaa/grill/start",
				{ expectedHash: draftBeforeStart.todo.hash, context: "Smoke context" },
				{ token: false },
			),
			/Invalid or missing write token/,
			"Grill-Me actions should require x-grill-web-token.",
		);
		const startEvents = await requestSse(port, "/api/todos/aaaaaaaa/grill/start", {
			expectedHash: draftBeforeStart.todo.hash,
			context: "Smoke context",
		});
		assert(startEvents.some((event) => event.type === "done" && event.exitCode === 0), "Start Grill-Me should finish successfully.");
		const draftAfterStart = await requestJson(port, "/api/todos/aaaaaaaa");
		assert(draftAfterStart.todo.tags.includes("refinement:grill"), "Starting Grill-Me should set refinement:grill.");
		assert(draftAfterStart.todo.column === "grill", "Started todo should move to Grill column.");

		const startDone = startEvents.find((event) => event.type === "done");
		const piCalls = (await fs.readFile(callsFile, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
		const startCall = piCalls.find((call) => call.args.includes("--skill"));
		assert(startCall?.cwd === PROJECT_ROOT, "Grill-Me should spawn pi from the project root.");
		assert(startCall?.args.includes(path.join(__dirname, "skills/grill-me/SKILL.md")), "Grill-Me should use the package-local grill-me skill.");
		assert(startDone.sessionPath, "Start SSE should expose the created session path.");
		assert(startDone.contextStatus?.model?.id === "gpt-5.5", "Start SSE should expose the Pi model.");
		assert(startDone.contextStatus?.context?.tokens >= 1234, "Start SSE should expose context token usage.");
		assert(startDone.contextStatus?.context?.freeTokens > 0, "Start SSE should expose remaining context tokens.");
		const continueEvents = await requestSse(port, "/api/todos/aaaaaaaa/grill/continue", {
			answer: "Smoke answer",
			sessionPath: startDone.sessionPath,
		});
		assert(continueEvents.some((event) => event.type === "done" && event.exitCode === 0), "Continue Grill-Me should finish successfully.");
		const callsAfterContinue = (await fs.readFile(callsFile, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
		assert(
			callsAfterContinue.some((call) => call.cwd === PROJECT_ROOT && call.args.includes("--session") && call.args.includes(startDone.sessionPath)),
			"Continue should invoke pi with the matched session path.",
		);
		const branchEvents = await requestSse(port, "/api/todos/aaaaaaaa/grill/continue", {
			answer: "Alternative first answer",
			sessionPath: startDone.sessionPath,
			branchFromAssistantOrdinal: 0,
		});
		const branchDone = branchEvents.find((event) => event.type === "done");
		assert(branchDone?.sessionPath && branchDone.sessionPath !== startDone.sessionPath, "Branch continue should run on a copied session path.");

		const finalEvents = await requestSse(port, "/api/todos/aaaaaaaa/grill/finalize", { sessionPath: startDone.sessionPath });
		const finalMessage = finalEvents.find((event) => event.type === "assistant_message");
		assert(finalMessage?.text, "Finalize should return assistant JSON for human review.");
		const proposed = JSON.parse(finalMessage.text);
		const finalBeforeWrite = await requestJson(port, "/api/todos/aaaaaaaa");
		const finalWrite = await requestJson(port, "/api/todos/aaaaaaaa/final-rewrite", {
			method: "PUT",
			token: true,
			body: {
				...proposed,
				expectedHash: finalBeforeWrite.todo.hash,
				refinementStage: "ready",
			},
		});
		assert(finalWrite.todo.title === "Final implementation todo", "Final review should write the reviewed title.");
		assert(finalWrite.todo.body.includes("Implement the reviewed plan."), "Final review should write the reviewed body.");
		assert(finalWrite.todo.tags.includes("refinement:ready"), "Final review should set refinement:ready.");
		assert(!finalWrite.todo.tags.includes("refinement:grill"), "Final review should remove old refinement tags.");
		assert(finalWrite.todo.status === "open", "Final review should preserve technical status.");

		await stopServer(serverHandle.server);
		const stderr = serverHandle.stderrRef();
		if (stderr.trim()) process.stderr.write(stderr);
		serverHandle = null;

		await fs.writeFile(PROJECT_SETTINGS_FILE, `${JSON.stringify({ theme: "nightowl" }, null, 2)}\n`, "utf8");
		const failingPort = port + 1;
		serverHandle = await runServer(failingPort, todoDir, sessionDir, binDir, { SMOKE_PI_CALLS_FILE: callsFile });
		const failingHealth = await requestJson(failingPort, "/api/health");
		assert(failingHealth.ok === false, "Health should stay non-blocking and report failures.");
		const packageCheck = failingHealth.checks.find((check) => check.id === "package-registration");
		assert(packageCheck && !packageCheck.ok, "Health should report missing package registration.");
		assert(/pi install -l \.pi\/grill-web/.test(packageCheck.fix || ""), "Health should provide the package registration fix.");
		await assertRejects(
			requestSse(failingPort, "/api/todos/aaaaaaaa/grill/start", {
				expectedHash: draftAfterStart.todo.hash,
				context: "Smoke context",
			}),
			/Grill-Me prerequisites failed[\s\S]*pi install -l \.pi\/grill-web/,
			"Grill-Me actions should fail with an actionable package registration error.",
		);

		console.log("Smoke tests passed: health diagnostics, non-blocking startup, actionable Grill-Me prerequisite failures, auth, spawn cwd/skill, board columns, final review, Done precedence.");
	} finally {
		if (serverHandle?.server) {
			const stderr = serverHandle.stderrRef();
			await stopServer(serverHandle.server);
			if (stderr.trim()) process.stderr.write(stderr);
		}
		if (originalSettings === null) await fs.rm(PROJECT_SETTINGS_FILE, { force: true });
		else await fs.writeFile(PROJECT_SETTINGS_FILE, originalSettings, "utf8");
		await fs.rm(tmp, { recursive: true, force: true });
	}
}

run().catch((error) => {
	console.error(error.stack || error.message);
	process.exit(1);
});
