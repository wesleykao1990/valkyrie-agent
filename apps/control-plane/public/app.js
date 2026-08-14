const $ = (id) => document.getElementById(id);
let portfolio = null;

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { "content-type": "application/json", ...(options.headers || {}) } : options.headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
}

async function refresh() {
  portfolio = await api("/api/portfolio");
  $("updated").textContent = `Updated ${new Date(portfolio.generatedAt).toLocaleTimeString()}`;
  renderProjects();
  renderRuns();
  renderApprovals();
  renderMemory();
  populateProjectSelects();
}

function populateProjectSelects() {
  for (const id of ["idea-project", "run-project"]) {
    const select = $(id);
    const current = select.value;
    select.innerHTML = portfolio.projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
    if (current) select.value = current;
  }
}

function renderProjects() {
  $("projects").innerHTML = portfolio.projects.map((p) => `
    <article class="card">
      <span class="health ${esc(p.health)}">${esc(p.health.replace("_", " "))}</span>
      <h3>${esc(p.name)}</h3>
      <p>${esc(p.currentMilestone)}</p>
      <div class="metric-row">
        <div class="metric"><b>${p.taskCounts.ideas}</b><span>ideas</span></div>
        <div class="metric"><b>${p.taskCounts.planned}</b><span>planned</span></div>
        <div class="metric"><b>${p.taskCounts.inProgress}</b><span>active</span></div>
      </div>
    </article>`).join("");
}

function renderRuns() {
  const runs = portfolio.recentRuns;
  if (!runs.length) { $("runs").innerHTML = `<div class="empty">No runs yet.</div>`; return; }
  $("runs").innerHTML = `<table><thead><tr><th>Run</th><th>Project</th><th>Runtime</th><th>Comparison</th><th>Stage</th><th>Status</th><th>Cost</th><th></th></tr></thead><tbody>${runs.map((r) => `
    <tr><td><code>${esc(r.id.slice(0,18))}…</code></td><td>${esc(r.projectId)}</td><td>${esc(r.rootRuntime)}</td><td>${r.metadata?.comparisonId ? `<code>${esc(String(r.metadata.comparisonId).slice(0,14))}…</code>` : "—"}</td><td>${esc(r.stage || "queued")}</td><td><span class="status ${esc(r.status)}">${esc(r.status.replaceAll("_"," "))}</span></td><td>$${Number(r.costUsd).toFixed(2)} / $${Number(r.budgetUsd).toFixed(2)}</td><td><button class="small secondary" data-run="${esc(r.id)}">Inspect</button></td></tr>`).join("")}</tbody></table>`;
  document.querySelectorAll("[data-run]").forEach((b) => b.addEventListener("click", () => openRun(b.dataset.run)));
}

function renderApprovals() {
  const items = portfolio.needsWesley.approvals;
  if (!items.length) { $("approvals").innerHTML = `<div class="empty">Nothing requires approval.</div>`; return; }
  $("approvals").innerHTML = items.map((a) => `
    <div class="attention"><h4>${esc(a.action.replaceAll("_"," "))}</h4><p>${esc(a.exactEffect)}</p><p>${a.evidence.map(esc).join(" · ")}</p><div class="actions"><button class="small" data-approval="${esc(a.id)}" data-decision="approve">Approve</button><button class="small secondary" data-approval="${esc(a.id)}" data-decision="request_changes">Request changes</button><button class="small danger" data-approval="${esc(a.id)}" data-decision="deny">Deny</button></div></div>`).join("");
  document.querySelectorAll("[data-approval]").forEach((b) => b.addEventListener("click", async () => {
    await api(`/api/approvals/${b.dataset.approval}/resolve`, { method: "POST", body: { decision: b.dataset.decision } });
    await refresh();
  }));
}

function renderMemory() {
  const items = portfolio.needsWesley.memoryProposals;
  if (!items.length) { $("memory").innerHTML = `<div class="empty">No proposed knowledge changes.</div>`; return; }
  $("memory").innerHTML = items.map((m) => `
    <div class="attention"><h4>${esc(m.projectId)}</h4><p>${esc(m.claim)}</p><div class="actions"><button class="small" data-memory="${esc(m.id)}" data-decision="promote">Review &amp; promote</button><button class="small danger" data-memory="${esc(m.id)}" data-decision="reject">Reject</button></div></div>`).join("");
  document.querySelectorAll("[data-memory]").forEach((b) => b.addEventListener("click", async () => {
    try {
      if (b.dataset.decision === "reject") {
        await api(`/api/memory/proposals/${b.dataset.memory}/resolve`, { method: "POST", body: { decision: "reject" } });
        await refresh();
        return;
      }
      const preview = await api(`/api/memory/proposals/${b.dataset.memory}/preview`);
      const confirmed = window.confirm([
        "Review the exact canonical Project Brain change.",
        `TARGET\n${preview.target}`,
        `CONTENT\n${preview.content}`,
        "Select OK only if this exact target and content should become accepted canonical memory.",
      ].join("\n\n"));
      if (!confirmed) return;
      await api(`/api/memory/proposals/${b.dataset.memory}/resolve`, {
        method: "POST",
        body: { decision: "promote", preview },
      });
      await refresh();
    } catch (error) {
      window.alert(error.message);
    }
  }));
}

async function openRun(id) {
  const detail = await api(`/api/runs/${id}`);
  $("run-detail").innerHTML = `
    <div class="eyebrow">${esc(detail.run.rootRuntime)} · ${esc(detail.run.status)}</div>
    <h2>${esc(detail.task?.title || detail.run.metadata.requestedObjective || detail.run.id)}</h2>
    <p><b>Stage:</b> ${esc(detail.run.stage)} · <b>Cost:</b> $${Number(detail.run.costUsd).toFixed(2)} · <b>Workspace:</b> ${esc(detail.run.workspaceId)}</p>
    <h3>Evidence and artifacts</h3>
    ${detail.artifacts.length ? `<ul>${detail.artifacts.map((a) => `<li>${esc(a.kind)} — <code>${esc(a.checksum.slice(0,16))}…</code></li>`).join("")}</ul>` : `<p class="empty">No artifacts yet.</p>`}
    <h3>Timeline</h3>
    ${detail.events.map((e) => `<div class="event"><b>${esc(e.type)}</b> — ${esc(e.message)}<br><small>${new Date(e.createdAt).toLocaleTimeString()}</small></div>`).join("")}
    ${!["completed","failed","cancelled"].includes(detail.run.status) ? `<div class="stack"><label>Steer this run<textarea id="steer-message" placeholder="Focus on the failing test and preserve the public API."></textarea></label><div class="actions"><button id="steer-run" class="secondary">Send steering instruction</button><button id="cancel-run" class="danger">Cancel run</button></div></div>` : ""}`;
  $("run-dialog").showModal();
  $("steer-run")?.addEventListener("click", async () => { const message = $("steer-message").value.trim(); if (!message) return; await api(`/api/runs/${id}/steer`, { method: "POST", body: { message } }); await openRun(id); });
  $("cancel-run")?.addEventListener("click", async () => { await api(`/api/runs/${id}/cancel`, { method: "POST" }); $("run-dialog").close(); await refresh(); });
}

$("close-dialog").addEventListener("click", () => $("run-dialog").close());
$("idea-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const out = $("idea-result");
  try {
    const result = await api("/api/ideas", { method: "POST", body: { projectId: $("idea-project").value, title: $("idea-title").value } });
    out.style.display = "block"; out.textContent = JSON.stringify(result, null, 2); await refresh();
  } catch (error) { out.style.display = "block"; out.textContent = error.message; }
});
$("run-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const out = $("run-result");
  try {
    const result = await api("/api/runs", { method: "POST", body: { projectId: $("run-project").value, objective: $("run-objective").value, runtime: $("runtime").value, maxCostUsd: Number($("budget").value) } });
    out.style.display = "block"; out.textContent = JSON.stringify(result.route, null, 2); await refresh();
  } catch (error) { out.style.display = "block"; out.textContent = error.message; }
});

$("compare-run").addEventListener("click", async () => {
  const out = $("run-result");
  try {
    const result = await api("/api/runs/compare", {
      method: "POST",
      body: {
        projectId: $("run-project").value,
        objective: $("run-objective").value,
        runtimes: ["atomic", "codex", "claude"],
        perRunMaxCostUsd: Number($("budget").value)
      }
    });
    out.style.display = "block";
    out.textContent = JSON.stringify({ comparisonId: result.comparisonId, runIds: result.runs.map((run) => run.id) }, null, 2);
    await refresh();
  } catch (error) {
    out.style.display = "block";
    out.textContent = error.message;
  }
});

$("reset").addEventListener("click", async () => { await api("/api/demo/reset", { method: "POST" }); await refresh(); });

await refresh();
setInterval(refresh, 1500);
