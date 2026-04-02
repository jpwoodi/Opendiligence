function readOptional(name: string) {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function readInteger(name: string, fallback: number) {
  const value = process.env[name]?.trim();
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readPersistenceMode() {
  const value = process.env.REPORT_PERSISTENCE_MODE?.trim().toLowerCase();
  if (value === "sqlite" || value === "memory") {
    return value;
  }

  return "auto";
}

export const env = {
  companiesHouseApiKey: readOptional("COMPANIES_HOUSE_API_KEY"),
  openSanctionsApiKey: readOptional("OPENSANCTIONS_API_KEY"),
  braveSearchApiKey: readOptional("BRAVE_SEARCH_API_KEY"),
  openAiApiKey: readOptional("OPENAI_API_KEY"),
  openAiModel: readOptional("OPENAI_MODEL") || "gpt-4.1-mini",
  appAccessKey: readOptional("APP_ACCESS_KEY"),
  rateLimitPostPerMinute: readInteger("APP_RATE_LIMIT_POST_PER_MINUTE", 12),
  rateLimitGetPerMinute: readInteger("APP_RATE_LIMIT_GET_PER_MINUTE", 90),
  reportPersistenceMode: readPersistenceMode(),
};

export function hasCompaniesHouseConfig() {
  return Boolean(env.companiesHouseApiKey);
}

export function hasOpenSanctionsConfig() {
  return Boolean(env.openSanctionsApiKey);
}

export function hasBraveSearchConfig() {
  return Boolean(env.braveSearchApiKey);
}

export function hasOpenAiConfig() {
  return Boolean(env.openAiApiKey);
}

export function hasAppAccessKey() {
  return Boolean(env.appAccessKey);
}

export function getReportPersistenceMode() {
  if (env.reportPersistenceMode === "sqlite" || env.reportPersistenceMode === "memory") {
    return env.reportPersistenceMode;
  }

  return process.env.VERCEL ? "memory" : "sqlite";
}
