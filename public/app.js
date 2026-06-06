import { marked } from "/vendor/marked.esm.js";

const COLUMN_ICONS = {
	draft: "✏️",
	grill: "🔥",
	ready: "🚀",
	done: "✅",
};

const COLUMNS = [
	{ id: "draft", title: "Problem Draft", icon: COLUMN_ICONS.draft },
	{ id: "grill", title: "In Grill-Me", icon: COLUMN_ICONS.grill },
	{ id: "ready", title: "Ready for Implementation", icon: COLUMN_ICONS.ready },
	{ id: "done", title: "Done", icon: COLUMN_ICONS.done },
];
const THEME_KEY = "grillWebTheme";
const TOKEN_KEY = "grillWebToken";
const WEB_STATUSES = ["open", "blocked", "review", "waiting", "closed"];

const state = {
	todos: [],
	sessionScan: null,
	epic: "all",
	search: "",
	modalTodo: null,
	grill: null,
	finalReview: null,
	pendingGrillStart: null,
	health: null,
	routeToken: 0,
};

const $ = (selector) => document.querySelector(selector);
const appShell = $("#app");
const boardToolbar = $("#boardToolbar");
const boardView = $("#boardView");
const grillView = $("#grillView");
const board = $("#board");
const epicFilters = $("#epicFilters");
const searchInput = $("#searchInput");
const toast = $("#toast");
const syncStatus = $("#syncStatus");
const healthBanner = $("#healthBanner");
const healthBannerSummary = $("#healthBannerSummary");
const healthBannerIssues = $("#healthBannerIssues");
const modalBackdrop = $("#modalBackdrop");
const modalTitle = $("#modalTitle");
const modalMeta = $("#modalMeta");
const modalBadges = $("#modalBadges");
const sessionPanel = $("#sessionPanel");
const previewPane = $("#previewPane");
const statusForm = $("#statusForm");
const statusField = $("#statusField");
const saveStatusButton = $("#saveStatusButton");
const openGrillButton = $("#openGrillButton");
const grillStartBackdrop = $("#grillStartBackdrop");
const grillStartForm = $("#grillStartForm");
const grillContextField = $("#grillContextField");
const confirmGrillStartButton = $("#confirmGrillStartButton");
const grillBackButton = $("#grillBackButton");
const grillPauseButton = $("#grillPauseButton");
const grillFinalizeButton = $("#grillFinalizeButton");
const grillViewTitle = $("#grillViewTitle");
const grillTodoMeta = $("#grillTodoMeta");
const grillTodoTitle = $("#grillTodoTitle");
const grillTodoBadges = $("#grillTodoBadges");
const grillTodoPreview = $("#grillTodoPreview");
const grillSessionLine = $("#grillSessionLine");
const currentQuestionCard = $(".current-question-card");
const grillCurrentQuestion = $("#grillCurrentQuestion");
const grillPrevQuestionButton = $("#grillPrevQuestionButton");
const grillNextQuestionButton = $("#grillNextQuestionButton");
const grillQuestionPosition = $("#grillQuestionPosition");
const grillHistory = $("#grillHistory");
const grillRunStatus = $("#grillRunStatus");
const grillDiagnostics = $("#grillDiagnostics");
const grillContextMeter = $("#grillContextMeter");
const grillForm = $("#grillForm");
const grillAnswer = $("#grillAnswer");
const grillSendButton = $("#grillSendButton");
const finalReviewBackdrop = $("#finalReviewBackdrop");
const closeFinalReviewButton = $("#closeFinalReviewButton");
const finalParsePanel = $("#finalParsePanel");
const finalRawField = $("#finalRawField");
const finalParseError = $("#finalParseError");
const finalRetryButton = $("#finalRetryButton");
const finalParseButton = $("#finalParseButton");
const finalReviewForm = $("#finalReviewForm");
const finalTitleField = $("#finalTitleField");
const finalTagsField = $("#finalTagsField");
const finalBodyField = $("#finalBodyField");
const finalPreviewPane = $("#finalPreviewPane");
const cancelFinalReviewButton = $("#cancelFinalReviewButton");
const confirmFinalReviewButton = $("#confirmFinalReviewButton");

marked.setOptions({ gfm: true, breaks: false });
marked.use({
	renderer: {
		html(token) {
			return escapeHtml(token.raw ?? token.text ?? "");
		},
	},
});

init();

function init() {
	captureToken();
	applyTheme(localStorage.getItem(THEME_KEY) || "system");
	bindEvents();
	loadTodos();
	handleRoute();
}

function captureToken() {
	const url = new URL(window.location.href);
	const token = url.searchParams.get("token");
	if (!token) return;
	localStorage.setItem(TOKEN_KEY, token);
	url.searchParams.delete("token");
	window.history.replaceState({}, "", url.toString());
}

function writeToken() {
	return localStorage.getItem(TOKEN_KEY) || "";
}

function bindEvents() {
	$("#refreshButton").addEventListener("click", () => loadTodos());
	searchInput.addEventListener("input", () => {
		state.search = searchInput.value.trim().toLowerCase();
		render();
	});
	$("#themeToggle").addEventListener("click", cycleTheme);
	$("#closeModalButton").addEventListener("click", closeModal);
	statusForm.addEventListener("submit", saveStatus);
	openGrillButton.addEventListener("click", () => {
		if (!state.modalTodo) return;
		if (state.modalTodo.grillSession) {
			const id = state.modalTodo.id;
			closeModal();
			openGrillRoute(id);
			return;
		}
		openGrillStartModal();
	});
	$("#cancelGrillStartButton").addEventListener("click", closeGrillStartModal);
	grillStartForm.addEventListener("submit", submitGrillStart);
	grillStartBackdrop.addEventListener("click", (event) => {
		if (event.target === grillStartBackdrop) closeGrillStartModal();
	});
	grillBackButton.addEventListener("click", pauseGrillView);
	grillPauseButton.addEventListener("click", pauseGrillView);
	grillFinalizeButton.addEventListener("click", () => startFinalPlanReview());
	grillPrevQuestionButton.addEventListener("click", () => navigateGrillQuestion(-1));
	grillNextQuestionButton.addEventListener("click", () => navigateGrillQuestion(1));
	grillForm.addEventListener("submit", sendGrillAnswer);
	grillAnswer.addEventListener("keydown", submitGrillAnswerShortcut);
	grillAnswer.addEventListener("input", renderGrillInterview);
	closeFinalReviewButton.addEventListener("click", closeFinalReviewModal);
	cancelFinalReviewButton.addEventListener("click", closeFinalReviewModal);
	finalReviewBackdrop.addEventListener("click", (event) => {
		if (event.target === finalReviewBackdrop) closeFinalReviewModal();
	});
	finalRawField.addEventListener("input", () => {
		finalParseError.textContent = "";
	});
	finalParseButton.addEventListener("click", parseFinalRawJson);
	finalRetryButton.addEventListener("click", () => {
		closeFinalReviewModal();
		startFinalPlanReview();
	});
	finalReviewForm.addEventListener("submit", confirmFinalReview);
	finalBodyField.addEventListener("input", renderFinalPreview);
	modalBackdrop.addEventListener("click", (event) => {
		if (event.target === modalBackdrop) closeModal();
	});
	document.addEventListener("keydown", (event) => {
		if (event.key !== "Escape") return;
		if (!finalReviewBackdrop.hidden) closeFinalReviewModal();
		else if (!grillStartBackdrop.hidden) closeGrillStartModal();
		else if (!modalBackdrop.hidden) closeModal();
	});
	window.addEventListener("popstate", handleRoute);
	window.addEventListener("hashchange", handleRoute);
}

async function loadTodos(options = {}) {
	try {
		const [todosResult, healthResult] = await Promise.allSettled([api("/api/todos"), api("/api/health")]);
		if (todosResult.status !== "fulfilled") throw todosResult.reason;
		const data = todosResult.value;
		state.todos = data.todos || [];
		state.sessionScan = data.sessionScan || null;
		if (healthResult.status === "fulfilled") state.health = healthResult.value;
		else if (!options.keepHealth) state.health = null;
		const sessionText = state.sessionScan
			? ` · Pi sessions ${state.sessionScan.matched}/${state.sessionScan.scanned}`
			: "";
		syncStatus.textContent = `Manual refresh · synced ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${state.todos.length} todos${sessionText}`;
		render();
		if (healthResult.status === "rejected" && !options.silent) showToast(`Health check failed: ${healthResult.reason.message}`);
	} catch (error) {
		if (!options.silent) showToast(error.message);
		syncStatus.textContent = "Could not sync todos";
		renderHealthBanner();
	}
}

async function api(path, options = {}) {
	const headers = { accept: "application/json", ...(options.headers || {}) };
	if (options.body !== undefined) headers["content-type"] = "application/json";
	if (["PUT", "PATCH", "POST", "DELETE"].includes(options.method)) headers["x-grill-web-token"] = writeToken();
	const response = await fetch(path, { ...options, headers });
	const payload = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
	return payload;
}

function render() {
	renderHealthBanner();
	renderEpicFilters();
	renderBoard();
}

function renderHealthBanner() {
	const failing = (state.health?.checks || []).filter((check) => !check.ok);
	if (!failing.length) {
		healthBanner.hidden = true;
		healthBannerSummary.textContent = "";
		healthBannerIssues.innerHTML = "";
		return;
	}
	healthBanner.hidden = false;
	healthBannerSummary.textContent = `${failing.length} setup check${failing.length === 1 ? "" : "s"} failed. Grill-Me actions will fail until these are fixed.`;
	healthBannerIssues.innerHTML = failing.map((check) => `
		<article class="health-issue">
			<div class="health-issue-title">${escapeHtml(titleForHealthCheck(check))}</div>
			<div class="health-issue-message">${escapeHtml(check.message || "Setup check failed.")}</div>
			${check.fix ? `<pre class="health-issue-fix">${escapeHtml(check.fix)}</pre>` : ""}
		</article>
	`).join("");
}

function titleForHealthCheck(check) {
	return ({
		"pi-cli": "Pi CLI",
		"todo-directory": "Todo directory",
		"todos-extension": "Todo extension",
		"grill-skill": "Grill-Me skill",
		"package-registration": "Package registration",
		"session-directory": "Session directory",
		"active-todo-path": "Active todo path",
	})[check?.id] || check?.id || "Health check";
}

function filteredTodos() {
	return state.todos.filter((todo) => {
		if (state.epic === "none" && epicTags(todo).length) return false;
		if (state.epic !== "all" && state.epic !== "none" && !todo.tags.includes(state.epic)) return false;
		if (!state.search) return true;
		const haystack = `${todo.title} ${(todo.tags || []).join(" ")} ${todo.grillSession?.displayName || ""}`.toLowerCase();
		return haystack.includes(state.search);
	});
}

function renderEpicFilters() {
	const epics = [...new Set(state.todos.flatMap((todo) => epicTags(todo)))].sort((a, b) => a.localeCompare(b));
	const countFor = (filter) => state.todos.filter((todo) => {
		if (todo.column === "done") return false;
		if (filter === "all") return true;
		if (filter === "none") return epicTags(todo).length === 0;
		return todo.tags.includes(filter);
	}).length;
	const filters = [
		{ id: "all", label: "All" },
		{ id: "none", label: "No Epic" },
		...epics.map((epic) => ({ id: epic, label: displayTag(epic) })),
	];
	epicFilters.innerHTML = filters.map((filter) => `
		<button type="button" class="epic-button ${state.epic === filter.id ? "active" : ""}" data-epic="${escapeAttr(filter.id)}">
			${escapeHtml(filter.label)} <span>${countFor(filter.id)}</span>
		</button>
	`).join("");
	epicFilters.querySelectorAll("button").forEach((button) => {
		button.addEventListener("click", () => {
			state.epic = button.dataset.epic;
			render();
		});
	});
}

function renderBoard() {
	const todos = filteredTodos();
	board.innerHTML = COLUMNS.map((column) => {
		const columnTodos = todos.filter((todo) => todo.column === column.id);
		return `
			<section class="column ${column.id === "done" ? "done-column" : ""}" aria-labelledby="${column.id}-title">
				<header class="column-header">
					<div><span id="${column.id}-title">${column.title}</span><span class="count">${columnTodos.length}</span></div>
					<span class="column-icon" aria-hidden="true">${column.icon}</span>
				</header>
				<div class="column-body" data-column="${column.id}">
					${columnTodos.length ? columnTodos.map(renderCard).join("") : `<div class="empty-state">No ${column.title.toLowerCase()} todos</div>`}
				</div>
			</section>
		`;
	}).join("");
	bindCards();
}

function renderCard(todo) {
	const tags = epicTags(todo).map((tag) => `<span class="tag epic">${escapeHtml(displayTag(tag))}</span>`).join("");
	const sessionBadge = todo.grillSession
		? `<span class="session-badge" title="${escapeAttr(todo.grillSession.relativePath || todo.grillSession.path || "")}">Using ${escapeHtml(todo.grillSession.displayName)}</span>`
		: "";
	return `
		<article class="todo-card ${todo.column === "done" ? "done" : ""}" data-id="${escapeAttr(todo.id)}" tabindex="0">
			<h3 class="card-title"><span class="check-ring">${todo.column === "done" ? "✓" : ""}</span><span>${escapeHtml(todo.title || "Untitled todo")}</span></h3>
			${tags ? `<div class="tag-row">${tags}</div>` : ""}
			${sessionBadge ? `<div class="badge-row">${sessionBadge}</div>` : ""}
		</article>
	`;
}

function bindCards() {
	board.querySelectorAll(".todo-card").forEach((card) => {
		const id = card.dataset.id;
		card.addEventListener("click", () => openTodo(id));
		card.addEventListener("keydown", (event) => {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				openTodo(id);
			}
		});
	});
}

async function openTodo(id) {
	try {
		const data = await api(`/api/todos/${id}`);
		populateModal(data.todo);
		modalBackdrop.hidden = false;
	} catch (error) {
		showToast(error.message);
	}
}

function populateModal(todo) {
	state.modalTodo = todo;
	modalTitle.textContent = todo.title || "Untitled todo";
	modalMeta.textContent = `TODO-${todo.id} · ${todo.created_at ? new Date(todo.created_at).toLocaleString() : "no date"}`;
	modalBadges.innerHTML = [
		`<span class="status-badge ${escapeAttr(todo.status.toLowerCase())}">${escapeHtml(todo.status)}</span>`,
		...(todo.tags || []).map((tag) => `<span class="tag ${tag.startsWith("epic:") ? "epic" : ""}">${escapeHtml(displayTag(tag))}</span>`),
		...(todo.assigned_to_session ? [`<span class="readonly-badge">Assigned</span>`] : []),
		...(todo.grillSession ? [`<span class="session-badge">Grill session linked</span>`] : []),
	].join("");
	populateSessionPanel(todo.grillSession);
	openGrillButton.textContent = todo.grillSession ? "Continue Grill-Me" : "Start Grill-Me";
	openGrillButton.disabled = Boolean(todo.readOnly && !todo.grillSession);
	statusField.innerHTML = [
		...(WEB_STATUSES.includes(todo.status) ? [] : [todo.status]),
		...WEB_STATUSES,
	].map((status) => `<option value="${escapeAttr(status)}">${escapeHtml(status)}</option>`).join("");
	statusField.value = todo.status;
	const readOnly = Boolean(todo.readOnly || todo.assigned_to_session || todo.lock?.active);
	statusField.disabled = readOnly;
	saveStatusButton.disabled = readOnly;
	statusForm.classList.toggle("read-only", readOnly);
	const body = todo.body?.trim() ? todo.body : "_No body._";
	previewPane.innerHTML = sanitizeHtml(marked.parse(body, { async: false }));
}

async function saveStatus(event) {
	event.preventDefault();
	if (!state.modalTodo) return;
	try {
		saveStatusButton.disabled = true;
		const data = await api(`/api/todos/${state.modalTodo.id}/status`, {
			method: "PATCH",
			body: JSON.stringify({ status: statusField.value, expectedHash: state.modalTodo.hash }),
		});
		state.modalTodo = data.todo;
		state.todos = state.todos.map((todo) => todo.id === data.todo.id ? summarizeTodo(data.todo) : todo);
		populateModal(data.todo);
		render();
		showToast(`Status: ${data.todo.status}`);
	} catch (error) {
		showToast(error.message);
	} finally {
		saveStatusButton.disabled = Boolean(state.modalTodo?.readOnly);
	}
}

function summarizeTodo(todo) {
	return {
		id: todo.id,
		title: todo.title,
		tags: todo.tags || [],
		status: todo.status,
		created_at: todo.created_at,
		assigned_to_session: todo.assigned_to_session,
		hash: todo.hash,
		refinementStage: todo.refinementStage,
		column: todo.column,
		locked: Boolean(todo.lock?.active),
		readOnly: Boolean(todo.readOnly),
		grillSession: todo.grillSession,
	};
}

function populateSessionPanel(session) {
	if (!sessionPanel) return;
	if (!session) {
		sessionPanel.hidden = true;
		sessionPanel.innerHTML = "";
		return;
	}
	const matchText = session.matchCount > 1 ? ` · newest of ${session.matchCount} matches` : "";
	const modified = session.modified ? ` · ${new Date(session.modified).toLocaleString()}` : "";
	sessionPanel.hidden = false;
	sessionPanel.innerHTML = `
		<div class="session-panel-title">Using Grill-Me session${matchText}</div>
		<div class="session-panel-name">${escapeHtml(session.displayName)}</div>
		<div class="session-panel-path">${escapeHtml(session.relativePath || session.path || "")}${escapeHtml(modified)}</div>
	`;
}

function currentGrillIdFromLocation() {
	const pathMatch = window.location.pathname.match(/^\/grill\/(?:TODO-)?([a-f0-9]{8})$/i);
	if (pathMatch) return pathMatch[1].toLowerCase();
	const hashMatch = window.location.hash.match(/^#\/grill\/(?:TODO-)?([a-f0-9]{8})$/i);
	return hashMatch ? hashMatch[1].toLowerCase() : null;
}

function openGrillStartModal() {
	if (!state.modalTodo) return;
	grillContextField.value = "";
	confirmGrillStartButton.disabled = false;
	grillStartBackdrop.hidden = false;
	grillContextField.focus();
}

function closeGrillStartModal() {
	grillStartBackdrop.hidden = true;
}

function submitGrillStart(event) {
	event.preventDefault();
	if (!state.modalTodo) return;
	const id = state.modalTodo.id;
	state.pendingGrillStart = { id, context: grillContextField.value };
	confirmGrillStartButton.disabled = true;
	closeGrillStartModal();
	closeModal();
	openGrillRoute(id);
}

function openGrillRoute(id) {
	window.history.pushState({}, "", `/grill/${validateClientTodoId(id)}`);
	handleRoute();
}

function openBoardRoute() {
	window.history.pushState({}, "", "/");
	handleRoute();
}

function handleRoute() {
	const id = currentGrillIdFromLocation();
	if (!id) {
		showBoardView();
		return;
	}
	showGrillView(id);
}

function showBoardView() {
	appShell.classList.remove("grill-active");
	boardToolbar.hidden = false;
	boardView.hidden = false;
	grillView.hidden = true;
	state.routeToken += 1;
}

async function showGrillView(id) {
	const routeToken = ++state.routeToken;
	appShell.classList.add("grill-active");
	boardToolbar.hidden = true;
	boardView.hidden = true;
	grillView.hidden = false;
	resetGrillView(id);
	try {
		const data = await api(`/api/todos/${id}`);
		if (routeToken !== state.routeToken) return;
		const todo = data.todo;
		state.grill.todo = todo;
		state.grill.sessionPath = todo.grillSession?.path || null;
		renderGrillTodo(todo);
		if (state.grill.sessionPath) await loadGrillHistory(id, state.grill.sessionPath, routeToken);
		if (routeToken !== state.routeToken) return;
		if (!state.grill.sessionPath && !state.grill.messages.length) {
			const initialContext = state.pendingGrillStart?.id === id ? state.pendingGrillStart.context : "";
			state.pendingGrillStart = null;
			await startGrillInterview(routeToken, initialContext);
		} else {
			renderGrillInterview();
		}
	} catch (error) {
		showToast(error.message);
		grillRunStatus.textContent = error.message;
	}
}

function resetGrillView(id) {
	abortCurrentGrillRun();
	state.grill = {
		id,
		todo: null,
		messages: [],
		diagnostics: [],
		sessionPath: null,
		running: false,
		finalizing: false,
		abortController: null,
		failed: false,
		selectedAssistantIndex: null,
		contextStatus: null,
	};
	grillViewTitle.textContent = "Loading todo…";
	grillTodoMeta.textContent = `TODO-${id}`;
	grillTodoTitle.textContent = "Loading todo…";
	grillTodoBadges.innerHTML = "";
	grillTodoPreview.innerHTML = "";
	grillSessionLine.textContent = "Preparing Grill-Me workspace";
	grillRunStatus.textContent = "Loading…";
	grillDiagnostics.innerHTML = "";
	renderGrillInterview();
}

function renderGrillTodo(todo) {
	const title = todo.title || "Untitled todo";
	grillViewTitle.textContent = title;
	grillTodoMeta.textContent = `TODO-${todo.id} · ${todo.status || "open"} · ${todo.created_at ? new Date(todo.created_at).toLocaleString() : "no date"}`;
	grillTodoTitle.textContent = title;
	grillTodoBadges.innerHTML = epicTags(todo).map((tag) => `<span class="tag epic">${escapeHtml(displayTag(tag))}</span>`).join("");
	grillTodoPreview.innerHTML = sanitizeHtml(marked.parse(todo.body?.trim() ? todo.body : "_No body._", { async: false }));
	grillSessionLine.textContent = todo.grillSession
		? `Continuing ${todo.grillSession.displayName}`
		: "Starting a new Grill-Me interview";
}

async function loadGrillHistory(id, sessionPath, routeToken) {
	const query = sessionPath ? `?sessionPath=${encodeURIComponent(sessionPath)}` : "";
	const data = await api(`/api/todos/${id}/grill/history${query}`);
	if (routeToken !== state.routeToken) return;
	state.grill.sessionPath = data.session?.path || sessionPath || state.grill.sessionPath;
	state.grill.messages = (data.messages || []).map((message) => ({
		role: message.role,
		text: message.text || "",
		timestamp: message.timestamp,
		assistantOrdinal: message.assistantOrdinal,
	}));
	state.grill.contextStatus = data.contextStatus || null;
	state.grill.selectedAssistantIndex = findLatestAssistantIndex(state.grill.messages);
	if (data.session?.displayName) grillSessionLine.textContent = `Continuing ${data.session.displayName}`;
	grillRunStatus.textContent = state.grill.messages.length ? "Idle · answer the latest question" : "Idle · no previous Q/A found";
	renderGrillInterview();
}

async function startGrillInterview(routeToken = state.routeToken, context = "") {
	const todo = state.grill?.todo;
	if (!todo) return;
	await streamGrill(`/api/todos/${todo.id}/grill/start`, {
		expectedHash: todo.hash,
		context,
	}, routeToken);
	await loadTodos({ silent: true });
	if (routeToken === state.routeToken && state.grill) {
		const data = await api(`/api/todos/${todo.id}`).catch(() => null);
		if (data?.todo) {
			state.grill.todo = data.todo;
			state.grill.sessionPath = data.todo.grillSession?.path || state.grill.sessionPath;
			renderGrillTodo(data.todo);
			renderGrillInterview();
		}
	}
}

function submitGrillAnswerShortcut(event) {
	if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
	event.preventDefault();
	if (!grillSendButton.disabled) grillForm.requestSubmit();
}

async function sendGrillAnswer(event) {
	event.preventDefault();
	const grill = state.grill;
	if (!grill || grill.running) return;
	const answer = grillAnswer.value.trim();
	if (!answer) return;
	const assistantIndexes = assistantMessageIndexes(grill.messages);
	const latestAssistantIndex = assistantIndexes.at(-1) ?? -1;
	const selectedAssistantIndex = assistantIndexes.includes(grill.selectedAssistantIndex) ? grill.selectedAssistantIndex : latestAssistantIndex;
	const selectedAssistant = selectedAssistantIndex >= 0 ? grill.messages[selectedAssistantIndex] : null;
	const branchFromAssistantOrdinal = selectedAssistantIndex >= 0 && selectedAssistantIndex !== latestAssistantIndex
		? selectedAssistant?.assistantOrdinal ?? assistantIndexes.indexOf(selectedAssistantIndex)
		: null;
	if (branchFromAssistantOrdinal !== null) {
		grill.messages = grill.messages.slice(0, selectedAssistantIndex + 1);
	}
	grill.messages.push({ role: "user", text: answer, timestamp: new Date().toISOString() });
	grillAnswer.value = "";
	renderGrillInterview();
	await streamGrill(`/api/todos/${grill.id}/grill/continue`, {
		answer,
		sessionPath: grill.sessionPath,
		...(branchFromAssistantOrdinal !== null ? { branchFromAssistantOrdinal } : {}),
	}, state.routeToken);
}

async function startFinalPlanReview() {
	const grill = state.grill;
	if (!grill || grill.running) return;
	if (!grill.todo) {
		showToast("Todo is not loaded yet.");
		return;
	}
	if (!grill.sessionPath) {
		showToast("No Grill-Me session found for this todo.");
		return;
	}
	const assistantMessage = await streamGrill(`/api/todos/${grill.id}/grill/finalize`, {
		sessionPath: grill.sessionPath,
	}, state.routeToken, {
		finalizing: true,
		runningStatus: "Finalizing · waiting for todo JSON",
		idleStatus: "Final JSON received · review before saving",
	});
	if (!assistantMessage || state.routeToken === 0 || !state.grill) return;
	openFinalReviewModal(assistantMessage.text || "");
}

function openFinalReviewModal(rawText) {
	state.finalReview = { rawText, parsed: null };
	finalRawField.value = rawText;
	try {
		showParsedFinalReview(parseFinalTodoJson(rawText, state.grill?.todo));
	} catch (error) {
		showFinalParseError(error.message);
	}
	finalReviewBackdrop.hidden = false;
}

function closeFinalReviewModal() {
	finalReviewBackdrop.hidden = true;
	state.finalReview = null;
	confirmFinalReviewButton.disabled = false;
}

function showFinalParseError(message) {
	finalParsePanel.hidden = false;
	finalReviewForm.hidden = true;
	finalParseError.textContent = message;
}

function showParsedFinalReview(parsed) {
	state.finalReview = { ...(state.finalReview || {}), parsed };
	finalParsePanel.hidden = true;
	finalReviewForm.hidden = false;
	finalTitleField.value = parsed.title;
	finalTagsField.value = parsed.tags.join("\n");
	finalBodyField.value = parsed.body;
	renderFinalPreview();
	window.setTimeout(() => finalTitleField.focus(), 0);
}

function parseFinalRawJson() {
	try {
		showParsedFinalReview(parseFinalTodoJson(finalRawField.value, state.grill?.todo));
	} catch (error) {
		showFinalParseError(error.message);
	}
}

async function confirmFinalReview(event) {
	event.preventDefault();
	const grill = state.grill;
	if (!grill?.todo) return;
	const title = finalTitleField.value.trim();
	const tags = parseTagInput(finalTagsField.value).filter((tag) => !tag.toLowerCase().startsWith("refinement:"));
	const body = finalBodyField.value;
	if (!title) {
		showToast("Title is required.");
		return;
	}
	try {
		confirmFinalReviewButton.disabled = true;
		const data = await api(`/api/todos/${grill.todo.id}/final-rewrite`, {
			method: "PUT",
			body: JSON.stringify({
				title,
				tags,
				body,
				expectedHash: grill.todo.hash,
				refinementStage: "ready",
			}),
		});
		grill.todo = data.todo;
		renderGrillTodo(data.todo);
		grillSessionLine.textContent = "Final todo saved · ready for implementation";
		await loadTodos({ silent: true });
		closeFinalReviewModal();
		showToast("Todo final überarbeitet");
	} catch (error) {
		showToast(error.message);
	} finally {
		confirmFinalReviewButton.disabled = false;
	}
}

function renderFinalPreview() {
	finalPreviewPane.innerHTML = sanitizeHtml(marked.parse(finalBodyField.value.trim() || "_No body._", { async: false }));
}

function parseFinalTodoJson(text, currentTodo) {
	const candidates = jsonCandidates(text);
	let lastError = "No JSON object found.";
	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON must be an object.");
			if (typeof parsed.title !== "string" || !parsed.title.trim()) throw new Error("JSON title must be a non-empty string.");
			if (!Array.isArray(parsed.tags) || parsed.tags.some((tag) => typeof tag !== "string")) throw new Error("JSON tags must be a string array.");
			if (typeof parsed.body !== "string") throw new Error("JSON body must be a Markdown string.");
			return {
				title: parsed.title.trim(),
				tags: mergePreservedEpicTags(
					normalizeClientTags(parsed.tags).filter((tag) => !tag.toLowerCase().startsWith("refinement:")),
					currentTodo,
				),
				body: parsed.body,
			};
		} catch (error) {
			lastError = error.message;
		}
	}
	throw new Error(`Could not parse final todo JSON. ${lastError}`);
}

function jsonCandidates(text) {
	const value = String(text || "").trim();
	const candidates = [];
	for (const match of value.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
		if (match[1]?.trim()) candidates.push(match[1].trim());
	}
	if (value) candidates.push(value);
	const objectCandidate = firstBalancedJsonObject(value);
	if (objectCandidate) candidates.push(objectCandidate);
	return [...new Set(candidates)];
}

function firstBalancedJsonObject(text) {
	const value = String(text || "");
	const start = value.indexOf("{");
	if (start < 0) return "";
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < value.length; index += 1) {
		const char = value[index];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth === 0) return value.slice(start, index + 1);
		}
	}
	return "";
}

function normalizeClientTags(tags) {
	const seen = new Set();
	const normalized = [];
	for (const tag of tags || []) {
		const value = String(tag || "").trim();
		if (!value || seen.has(value)) continue;
		seen.add(value);
		normalized.push(value);
	}
	return normalized;
}

function mergePreservedEpicTags(tags, currentTodo) {
	const merged = [...tags];
	for (const tag of epicTags(currentTodo || {})) {
		if (!merged.includes(tag)) merged.unshift(tag);
	}
	return normalizeClientTags(merged);
}

function parseTagInput(value) {
	return normalizeClientTags(String(value || "").split(/[\n,]/));
}

async function streamGrill(path, body, routeToken, options = {}) {
	const grill = state.grill;
	if (!grill) return null;
	abortCurrentGrillRun();
	const assistantMessage = { role: "assistant", text: "", pending: true, timestamp: new Date().toISOString() };
	grill.messages.push(assistantMessage);
	grill.selectedAssistantIndex = grill.messages.length - 1;
	grill.running = true;
	grill.finalizing = Boolean(options.finalizing);
	grill.failed = false;
	grill.abortController = new AbortController();
	grillRunStatus.textContent = options.runningStatus || "Running · waiting for Grill-Me";
	renderGrillInterview();
	try {
		await fetchSse(path, body, grill.abortController.signal, (event) => {
			if (routeToken !== state.routeToken || !state.grill) return;
			handleGrillEvent(event, assistantMessage);
		});
		if (routeToken !== state.routeToken || !state.grill) return null;
		if (assistantMessage.text.trim()) assistantMessage.pending = false;
		grill.running = false;
		grill.finalizing = false;
		grill.failed = false;
		grill.abortController = null;
		grillRunStatus.textContent = options.idleStatus || "Idle · answer the latest question";
		renderGrillInterview();
		return assistantMessage;
	} catch (error) {
		if (error.name === "AbortError") {
			grillRunStatus.textContent = "Run aborted";
		} else {
			assistantMessage.pending = false;
			grillRunStatus.textContent = error.message;
			showToast(error.message);
		}
		grill.running = false;
		grill.finalizing = false;
		grill.failed = error.name !== "AbortError";
		grill.abortController = null;
		renderGrillInterview();
		return null;
	}
}

function handleGrillEvent(event, assistantMessage) {
	const grill = state.grill;
	if (!grill) return;
	if (event.type === "assistant_delta") {
		assistantMessage.text += event.delta || "";
		grillRunStatus.textContent = "Running · question streaming";
	} else if (event.type === "assistant_message") {
		const text = event.text || "";
		if (text.trim()) assistantMessage.text = text;
		if (assistantMessage.text.trim()) assistantMessage.pending = false;
	} else if (event.type === "session") {
		grill.sessionPath = event.sessionPath || grill.sessionPath;
		grillSessionLine.textContent = event.sessionPath ? `Session: ${event.sessionPath}` : "Session started";
	} else if (event.type === "diagnostic") {
		grill.diagnostics.push(event.message);
	} else if (event.type === "error") {
		grill.diagnostics.push(event.message);
		grillRunStatus.textContent = event.message;
	} else if (event.type === "done") {
		grill.sessionPath = event.sessionPath || grill.sessionPath;
		grill.contextStatus = event.contextStatus || grill.contextStatus;
		if (assistantMessage.text.trim()) assistantMessage.pending = false;
	}
	renderGrillInterview();
}

async function fetchSse(path, body, signal, onEvent) {
	const response = await fetch(path, {
		method: "POST",
		headers: {
			accept: "text/event-stream",
			"content-type": "application/json",
			"x-grill-web-token": writeToken(),
		},
		body: JSON.stringify(body || {}),
		signal,
	});
	if (!response.ok) {
		const payload = await response.json().catch(() => ({}));
		throw new Error(payload.error || `Request failed (${response.status})`);
	}
	if (!response.body) throw new Error("Streaming is not supported by this browser.");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let terminalError = null;
	const consumeBlock = (block) => {
		const event = parseSseBlock(block);
		if (!event) return;
		onEvent(event);
		if (event.type === "error") terminalError = new Error(event.message || "Pi run failed.");
		if (!terminalError && event.type === "done" && event.exitCode !== 0) {
			terminalError = new Error(event.message || `Pi exited with code ${event.exitCode}.`);
		}
	};
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const blocks = buffer.split(/\n\n/);
		buffer = blocks.pop() || "";
		for (const block of blocks) consumeBlock(block);
	}
	if (buffer.trim()) consumeBlock(buffer);
	if (terminalError) throw terminalError;
}

function parseSseBlock(block) {
	const data = block
		.split(/\r?\n/)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trimStart())
		.join("\n");
	return data ? JSON.parse(data) : null;
}

function renderGrillInterview() {
	const grill = state.grill;
	if (!grill) return;
	const assistantIndexes = assistantMessageIndexes(grill.messages);
	const latestAssistantIndex = assistantIndexes.at(-1) ?? -1;
	if (latestAssistantIndex >= 0 && !assistantIndexes.includes(grill.selectedAssistantIndex)) {
		grill.selectedAssistantIndex = latestAssistantIndex;
	}
	const selectedAssistantIndex = grill.selectedAssistantIndex ?? latestAssistantIndex;
	const selectedAssistant = selectedAssistantIndex >= 0 ? grill.messages[selectedAssistantIndex] : null;
	const selectedPosition = assistantIndexes.indexOf(selectedAssistantIndex);
	const viewingLatest = selectedAssistantIndex === latestAssistantIndex;
	if (selectedAssistant) {
		const questionText = selectedAssistant.text?.trim() || (selectedAssistant.pending ? "_The next question is being prepared…_" : "_No question text received._");
		let html = sanitizeHtml(marked.parse(questionText, { async: false }));
		if (!viewingLatest) {
			const answer = findUserAnswerAfter(grill.messages, selectedAssistantIndex);
			html += answer?.text?.trim()
				? `<section class="previous-answer"><p class="previous-answer-label">Bisherige Antwort · neue Antwort startet hier einen Branch</p>${sanitizeHtml(marked.parse(answer.text, { async: false }))}</section>`
				: `<section class="previous-answer"><p class="previous-answer-label">Neue Antwort startet hier einen Branch</p></section>`;
		}
		grillCurrentQuestion.innerHTML = html;
	} else {
		grillCurrentQuestion.innerHTML = `<p class="muted-copy">Grill-Me will ask the first question here.</p>`;
	}
	grillQuestionPosition.textContent = assistantIndexes.length
		? `Frage ${selectedPosition + 1} / ${assistantIndexes.length}`
		: "Frage 0 / 0";
	grillPrevQuestionButton.disabled = selectedPosition <= 0;
	grillNextQuestionButton.disabled = selectedPosition < 0 || selectedPosition >= assistantIndexes.length - 1;
	const previousMessages = grill.messages.filter((_, index) => index !== latestAssistantIndex);
	grillHistory.innerHTML = previousMessages.length
		? previousMessages.map(renderHistoryMessage).join("")
		: `<div class="empty-state">No previous Q/A yet</div>`;
	const canAnswer = Boolean(selectedAssistant?.text?.trim()) && !selectedAssistant.pending && !grill.running && !grill.failed && !grill.finalizing;
	const canFinalize = Boolean(grill.todo && grill.sessionPath) && !grill.running && grill.todo.refinementStage !== "ready";
	currentQuestionCard.classList.toggle("history-mode", !viewingLatest);
	grillForm.hidden = selectedAssistantIndex < 0;
	grillAnswer.disabled = !canAnswer;
	grillSendButton.disabled = !canAnswer || !grillAnswer.value.trim();
	grillFinalizeButton.disabled = !canFinalize;
	grillFinalizeButton.textContent = grill.finalizing ? "…" : "✓";
	grillAnswer.placeholder = canAnswer
		? (viewingLatest ? "Answer only the latest question…" : "Answer from this point to start a new branch…")
		: "Waiting for the latest Grill-Me question…";
	grillForm.classList.toggle("running", grill.running);
	const sendLabel = grillSendButton.querySelector(".send-label");
	if (sendLabel) sendLabel.textContent = grill.running ? "" : "↗";
	grillDiagnostics.innerHTML = grill.diagnostics.length
		? grill.diagnostics.slice(-4).map((message) => `<div>${escapeHtml(message)}</div>`).join("")
		: "";
	renderContextMeter(grill);
}

function renderContextMeter(grill) {
	if (!grillContextMeter) return;
	const status = grill?.contextStatus;
	const modelLabel = status?.model?.displayName || status?.model?.id || "Model wird erkannt…";
	const context = status?.context || {};
	const percent = typeof context.percent === "number" ? Math.max(0, context.percent) : null;
	const usedTokens = Number.isFinite(context.tokens) ? context.tokens : null;
	const freeTokens = Number.isFinite(context.freeTokens) ? context.freeTokens : null;
	const windowTokens = Number.isFinite(context.contextWindow) ? context.contextWindow : null;
	const percentLabel = percent === null ? "?" : `${percent.toFixed(1)}%`;
	const freeLabel = freeTokens === null ? "unbekannt" : formatTokens(freeTokens);
	const usedLabel = usedTokens === null ? "noch keine Messung" : `${formatTokens(usedTokens)} belegt`;
	const windowLabel = windowTokens === null ? "Context unbekannt" : `von ${formatTokens(windowTokens)}`;
	const estimateLabel = context.estimated ? " · geschätzt" : "";
	grillContextMeter.classList.toggle("warn", percent !== null && percent >= 70 && percent < 90);
	grillContextMeter.classList.toggle("danger", percent !== null && percent >= 90);
	grillContextMeter.style.setProperty("--context-fill", `${Math.min(100, percent || 0)}%`);
	grillContextMeter.innerHTML = `
		<div class="context-meter-main">
			<span class="context-meter-label">${escapeHtml(modelLabel)}</span>
			<span class="context-meter-context">Context ${escapeHtml(percentLabel)} · ${escapeHtml(freeLabel)}</span>
		</div>
		<div class="context-meter-bar" aria-hidden="true"><span></span></div>
		<div class="context-meter-sub">${escapeHtml(usedLabel)} ${escapeHtml(windowLabel)}${escapeHtml(estimateLabel)}</div>
	`;
}

function formatTokens(count) {
	const value = Number(count) || 0;
	if (value < 1000) return String(Math.round(value));
	if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
	if (value < 1000000) return `${Math.round(value / 1000)}k`;
	if (value < 10000000) return `${(value / 1000000).toFixed(1)}M`;
	return `${Math.round(value / 1000000)}M`;
}

function navigateGrillQuestion(direction) {
	const grill = state.grill;
	if (!grill) return;
	const indexes = assistantMessageIndexes(grill.messages);
	if (!indexes.length) return;
	const latest = indexes[indexes.length - 1];
	const current = indexes.includes(grill.selectedAssistantIndex) ? grill.selectedAssistantIndex : latest;
	const currentPosition = indexes.indexOf(current);
	const nextPosition = Math.max(0, Math.min(indexes.length - 1, currentPosition + direction));
	grill.selectedAssistantIndex = indexes[nextPosition];
	renderGrillInterview();
}

function assistantMessageIndexes(messages) {
	return messages.reduce((indexes, message, index) => {
		if (message.role === "assistant") indexes.push(index);
		return indexes;
	}, []);
}

function findUserAnswerAfter(messages, assistantIndex) {
	for (let index = assistantIndex + 1; index < messages.length; index += 1) {
		if (messages[index].role === "assistant") return null;
		if (messages[index].role === "user") return messages[index];
	}
	return null;
}

function renderHistoryMessage(message) {
	const label = message.role === "assistant" ? "Grill-Me" : "You";
	return `
		<article class="history-message ${escapeAttr(message.role)}">
			<div class="history-label">${label}</div>
			<div class="history-body">${sanitizeHtml(marked.parse(message.text || "_empty_", { async: false }))}</div>
		</article>
	`;
}

function findLatestAssistantIndex(messages) {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index].role === "assistant") return index;
	}
	return -1;
}

function pauseGrillView() {
	const grill = state.grill;
	if (grill?.running) {
		const abort = window.confirm("Grill-Me is still running. Abort this run and return to the board?");
		if (!abort) return;
		abortCurrentGrillRun();
	}
	openBoardRoute();
}

function abortCurrentGrillRun() {
	if (state.grill?.abortController) {
		state.grill.abortController.abort();
		state.grill.abortController = null;
	}
	if (state.grill) state.grill.running = false;
}

function closeModal() {
	modalBackdrop.hidden = true;
}

function sanitizeHtml(html) {
	const template = document.createElement("template");
	template.innerHTML = html;
	const allowedTags = new Set(["A", "P", "BR", "STRONG", "EM", "DEL", "CODE", "PRE", "BLOCKQUOTE", "UL", "OL", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "HR", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD"]);
	const allowedAttrs = new Map([
		["A", new Set(["href", "title"])],
		["TH", new Set(["align"])],
		["TD", new Set(["align"])],
	]);
	const dangerousDrop = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "SVG", "MATH", "LINK", "META"]);
	const walk = (node) => {
		[...node.children].forEach((child) => {
			if (dangerousDrop.has(child.tagName)) {
				child.remove();
				return;
			}
			if (!allowedTags.has(child.tagName)) {
				child.replaceWith(document.createTextNode(child.textContent || ""));
				return;
			}
			[...child.attributes].forEach((attr) => {
				const allowed = allowedAttrs.get(child.tagName)?.has(attr.name.toLowerCase());
				if (!allowed) child.removeAttribute(attr.name);
			});
			if (child.tagName === "A") {
				const href = child.getAttribute("href") || "";
				if (!/^(https?:|mailto:|#|\/)/i.test(href)) child.removeAttribute("href");
				child.setAttribute("rel", "noreferrer noopener");
				child.setAttribute("target", "_blank");
			}
			walk(child);
		});
	};
	walk(template.content);
	return template.innerHTML;
}

function epicTags(todo) {
	return (todo.tags || []).filter((tag) => tag.startsWith("epic:"));
}

function displayTag(tag) {
	return String(tag || "").startsWith("epic:") ? String(tag).slice("epic:".length) : tag;
}

function validateClientTodoId(id) {
	const value = String(id || "").replace(/^TODO-/i, "").trim().toLowerCase();
	if (!/^[a-f0-9]{8}$/.test(value)) throw new Error("Invalid todo id.");
	return value;
}

let toastTimer = null;
function showToast(message) {
	window.clearTimeout(toastTimer);
	toast.textContent = message;
	toast.classList.add("show");
	toastTimer = window.setTimeout(() => toast.classList.remove("show"), 2800);
}

function cycleTheme() {
	const current = localStorage.getItem(THEME_KEY) || "system";
	const next = current === "system" ? "dark" : current === "dark" ? "light" : "system";
	applyTheme(next);
	localStorage.setItem(THEME_KEY, next);
	showToast(`Theme: ${next}`);
}

function applyTheme(theme) {
	if (theme === "system") document.documentElement.removeAttribute("data-theme");
	else document.documentElement.setAttribute("data-theme", theme);
}

function escapeHtml(value) {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}

function escapeAttr(value) {
	return escapeHtml(value).replaceAll("`", "&#096;");
}
