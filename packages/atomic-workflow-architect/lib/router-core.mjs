const DEFAULTS = Object.freeze({
  enabled: true,
  minimumScore: 3,
  forcePrefixes: ["atomic:", "workflow:"],
  bypassPrefixes: ["direct:", "inline:", "no-workflow:"],
  projectKeywords: ["ovalo", "signal ledger", "ai workflow watch"],
});

const ACTION_AT_START = /^(?:please\s+|can\s+you\s+|could\s+you\s+|would\s+you\s+|i\s+want\s+(?:you\s+)?to\s+|i(?:'d|\s+would)\s+like\s+(?:you\s+)?to\s+|let(?:'s|\s+us)\s+)?(?:build|implement|create|add|fix|debug|diagnose|repair|migrate|refactor|redesign|design|plan|research|investigate|analy[sz]e|audit|review|evaluate|compare|ship|develop|set\s*up|prototype|integrate|automate|convert|turn|update|change|remove|rename|optimize|secure|look\s*up)\b/i;
const ACTION_ANYWHERE = /\b(?:build|implement|create|add|fix|debug|diagnose|repair|migrate|refactor|redesign|design|plan|research|investigate|analy[sz]e|audit|review|evaluate|compare|ship|develop|set\s*up|prototype|integrate|automate|convert|update|change|remove|rename|optimize|secure)\b/i;
const SOFTWARE_OBJECT = /\b(?:feature|project|idea|bug|issue|migration|refactor|architecture|workflow|implementation|prototype|adapter|integration|dashboard|app|service|pipeline|agent|skill|repository|repo|github|git|linear|hermes|atomic|codex|claude\s*code|api|schema|database|ui|component|test|release|deploy|pr|pull request|code|codebase|package|cli|sdk|mcp|runtime|memory system|roadmap)\b/i;
const REQUEST_CUE = /\b(?:can you|could you|please|i want|i'd like|i would like|we need|let's|help me|what about building)\b/i;
const IDEA_CUE = /\b(?:i have an idea|here(?:'|’)s an idea|new idea|product idea|project idea|feature idea|idea for|what if we|could we build|could we add|should have|might be useful to)\b/i;
const HARD_WORKFLOW_SIGNAL = /\b(?:until (?:it|the|all)|keep (?:trying|going)|approval|evidence|verify|verification|regression|migration|release|deploy|pull request|\bpr\b|background|resumable|parallel|multiple agents|worktree|sandbox|fresh reviewer|human in the loop)\b/i;
const INFORMATION_ONLY = /^(?:please\s+)?(?:explain|summarize|translate|define|describe|teach me|what is|what are|why is|why are|how does|how do)\b/i;
const GREETING = /^(?:hi|hello|hey|thanks|thank you|ok|okay|great|sounds good)[.!\s]*$/i;

function stripPrefix(text, prefixes) {
  const lower = text.toLowerCase();
  for (const prefix of prefixes) {
    if (lower.startsWith(String(prefix).toLowerCase())) {
      return { matched: prefix, rest: text.slice(String(prefix).length).trim() };
    }
  }
  return null;
}

function projectKeywordMatch(text, keywords) {
  const lower = text.toLowerCase();
  return (keywords ?? []).some((value) => {
    const keyword = String(value ?? "").trim().toLowerCase();
    return keyword.length > 0 && lower.includes(keyword);
  });
}

export function scorePrompt(input, userConfig = {}) {
  const config = { ...DEFAULTS, ...userConfig };
  const text = String(input ?? "").trim();
  const reasons = [];
  let score = 0;

  const hasSoftwareObject = SOFTWARE_OBJECT.test(text);
  const hasProjectKeyword = projectKeywordMatch(text, config.projectKeywords);
  const hasDomainSignal = hasSoftwareObject || hasProjectKeyword;

  if (ACTION_AT_START.test(text)) {
    score += 3;
    reasons.push("action-at-start");
  } else if (ACTION_ANYWHERE.test(text)) {
    score += 2;
    reasons.push("action-verb");
  }
  if (hasSoftwareObject) {
    score += 1;
    reasons.push("software-object");
  }
  if (hasProjectKeyword) {
    score += 2;
    reasons.push("project-keyword");
  }
  if (REQUEST_CUE.test(text)) {
    score += 1;
    reasons.push("request-cue");
  }
  if (IDEA_CUE.test(text)) {
    score += 2;
    reasons.push("idea-cue");
  }
  if (HARD_WORKFLOW_SIGNAL.test(text)) {
    score += 2;
    reasons.push("hard-workflow-signal");
  }
  if (!hasDomainSignal && !IDEA_CUE.test(text)) {
    score -= 4;
    reasons.push("no-engineering-domain");
  }
  if (INFORMATION_ONLY.test(text) && !ACTION_ANYWHERE.test(text.replace(INFORMATION_ONLY, ""))) {
    score -= 4;
    reasons.push("information-only");
  }

  return { score, reasons };
}

export function routePrompt(input, userConfig = {}) {
  const config = { ...DEFAULTS, ...userConfig };
  const text = String(input ?? "").trim();

  if (!text || GREETING.test(text)) return { mode: "continue", text, score: 0, reasons: ["empty-or-greeting"] };
  if (/^[!/]/.test(text)) return { mode: "continue", text, score: 0, reasons: ["explicit-command"] };

  const bypass = stripPrefix(text, config.bypassPrefixes ?? DEFAULTS.bypassPrefixes);
  if (bypass) return { mode: "bypass", text: bypass.rest, score: 0, reasons: [`bypass:${bypass.matched}`] };

  const forced = stripPrefix(text, config.forcePrefixes ?? DEFAULTS.forcePrefixes);
  if (forced) return { mode: "route", text: forced.rest, score: 99, reasons: [`force:${forced.matched}`] };

  if (!config.enabled) return { mode: "continue", text, score: 0, reasons: ["disabled"] };

  const { score, reasons } = scorePrompt(text, config);
  return score >= Number(config.minimumScore ?? DEFAULTS.minimumScore)
    ? { mode: "route", text, score, reasons }
    : { mode: "continue", text, score, reasons };
}

export const DEFAULT_ROUTER_CONFIG = DEFAULTS;
