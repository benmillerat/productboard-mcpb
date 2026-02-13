#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const SERVER_NAME = "productboard-connector";
const SERVER_VERSION = "2.0.0";
const PRODUCTBOARD_BASE_URL = "https://api.productboard.com";
const PRODUCTBOARD_API_VERSION = "1";
const DEFAULT_LIMIT = 100;
const MAX_PAGE_SIZE = 100;

class ProductboardApiError extends Error {
  constructor(message, { status, details, retryAfter } = {}) {
    super(message);
    this.name = "ProductboardApiError";
    this.status = status;
    this.details = details;
    this.retryAfter = retryAfter;
  }
}

function logError(message, err) {
  if (err) {
    console.error(`[${SERVER_NAME}] ${message}`, err);
  } else {
    console.error(`[${SERVER_NAME}] ${message}`);
  }
}

function getApiToken() {
  const token = process.env.PRODUCTBOARD_API_TOKEN;
  if (!token || !token.trim()) {
    throw new ProductboardApiError(
      "Missing Productboard API token. Set PRODUCTBOARD_API_TOKEN in server environment.",
      { status: 401 },
    );
  }
  return token.trim();
}

function toObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeLimit(inputLimit, fallback = DEFAULT_LIMIT) {
  const limit = Number(inputLimit ?? fallback);
  if (!Number.isFinite(limit) || limit <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(limit), 1000);
}

function flattenFilters(value, prefix = "") {
  const out = {};
  const input = toObject(value);

  for (const [key, raw] of Object.entries(input)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (raw === undefined || raw === null) continue;

    if (Array.isArray(raw)) {
      out[nextKey] = raw.join(",");
      continue;
    }

    if (typeof raw === "object") {
      Object.assign(out, flattenFilters(raw, nextKey));
      continue;
    }

    out[nextKey] = raw;
  }

  return out;
}

function applyQueryParams(url, query = {}) {
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
}

function extractErrorMessage(payload, fallbackMessage) {
  if (!payload || typeof payload !== "object") return fallbackMessage;

  if (typeof payload.message === "string" && payload.message.trim()) {
    return payload.message;
  }

  if (payload.error && typeof payload.error.message === "string") {
    return payload.error.message;
  }

  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const first = payload.errors[0];
    if (typeof first === "string") return first;
    if (first && typeof first.message === "string") return first.message;
    if (first && typeof first.detail === "string") return first.detail;
  }

  return fallbackMessage;
}

function buildApiError(response, payload, fallbackText) {
  const status = response.status;
  const retryAfterHeader = response.headers.get("retry-after");
  const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : undefined;

  let message = extractErrorMessage(
    payload,
    fallbackText || `Productboard API returned HTTP ${status}.`,
  );

  if (status === 401) {
    message = "Authentication failed. Check your Productboard API token.";
  } else if (status === 403) {
    message = "Access denied by Productboard API. Verify token permissions.";
  } else if (status === 404) {
    message = "Requested Productboard resource was not found.";
  } else if (status === 429) {
    message = "Productboard API rate limit reached. Please retry shortly.";
  }

  return new ProductboardApiError(message, {
    status,
    details: payload ?? fallbackText,
    retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined,
  });
}

async function apiRequest(method, path, { query, body, absoluteUrl } = {}) {
  const token = getApiToken();
  const url = absoluteUrl
    ? new URL(absoluteUrl)
    : new URL(path, PRODUCTBOARD_BASE_URL);

  if (!absoluteUrl && query) {
    applyQueryParams(url, query);
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    "X-Version": PRODUCTBOARD_API_VERSION,
    Accept: "application/json",
  };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    throw new ProductboardApiError(
      "Network error while contacting Productboard API.",
      {
        details: error instanceof Error ? error.message : String(error),
      },
    );
  }

  const rawText = await response.text();
  let payload;

  if (rawText) {
    try {
      payload = JSON.parse(rawText);
    } catch {
      payload = undefined;
    }
  }

  if (!response.ok) {
    throw buildApiError(response, payload, rawText || undefined);
  }

  return payload ?? {};
}

async function listWithLinks(path, { query = {}, limit = DEFAULT_LIMIT, pageSizeParam } = {}) {
  const maxItems = normalizeLimit(limit);
  const items = [];
  let nextUrl = null;

  let firstQuery = { ...query };
  if (pageSizeParam && firstQuery[pageSizeParam] == null) {
    firstQuery[pageSizeParam] = Math.min(MAX_PAGE_SIZE, maxItems);
  }

  while (items.length < maxItems) {
    const payload = nextUrl
      ? await apiRequest("GET", null, { absoluteUrl: nextUrl })
      : await apiRequest("GET", path, { query: firstQuery });

    const pageItems = Array.isArray(payload?.data) ? payload.data : [];
    const remaining = maxItems - items.length;
    items.push(...pageItems.slice(0, remaining));

    const candidateNext = payload?.links?.next;
    if (!candidateNext || items.length >= maxItems) {
      return {
        items,
        count: items.length,
        has_more: Boolean(candidateNext) && items.length >= maxItems,
        next: candidateNext ?? null,
      };
    }

    nextUrl = candidateNext.startsWith("http")
      ? candidateNext
      : new URL(candidateNext, PRODUCTBOARD_BASE_URL).toString();

    firstQuery = {};
  }

  return {
    items,
    count: items.length,
    has_more: false,
    next: null,
  };
}

async function listNotes({ query = {}, limit = DEFAULT_LIMIT } = {}) {
  const maxItems = normalizeLimit(limit);
  const items = [];
  let cursor = query.pageCursor;

  while (items.length < maxItems) {
    const remaining = maxItems - items.length;
    const pageLimit = Math.min(MAX_PAGE_SIZE, remaining);

    const pageQuery = {
      ...query,
      pageLimit,
    };

    if (cursor) {
      pageQuery.pageCursor = cursor;
    } else {
      delete pageQuery.pageCursor;
    }

    const payload = await apiRequest("GET", "/notes", { query: pageQuery });
    const pageItems = Array.isArray(payload?.data) ? payload.data : [];

    items.push(...pageItems.slice(0, remaining));

    cursor = payload?.pageCursor;
    if (!cursor || items.length >= maxItems) {
      return {
        items,
        count: items.length,
        has_more: Boolean(cursor) && items.length >= maxItems,
        next_cursor: cursor ?? null,
      };
    }
  }

  return {
    items,
    count: items.length,
    has_more: false,
    next_cursor: null,
  };
}

function normalizeStatusInput(rawStatus) {
  if (rawStatus === undefined || rawStatus === null) return undefined;

  if (typeof rawStatus === "string") {
    return { name: rawStatus };
  }

  const status = toObject(rawStatus);
  if (status.id && status.name) {
    throw new ProductboardApiError(
      "Provide either status.id or status.name, not both.",
      { status: 400 },
    );
  }

  if (status.id || status.name) {
    return {
      ...(status.id ? { id: status.id } : {}),
      ...(status.name ? { name: status.name } : {}),
    };
  }

  return undefined;
}

function resolveStatusFromArgs(rawArgs) {
  const args = toObject(rawArgs);
  const inlineStatus = normalizeStatusInput(args.status);

  if (inlineStatus && (args.status_id || args.status_name)) {
    throw new ProductboardApiError(
      "Provide status either as status object/string OR as status_id/status_name fields.",
      { status: 400 },
    );
  }

  if (args.status_id && args.status_name) {
    throw new ProductboardApiError(
      "Provide either status_id or status_name, not both.",
      { status: 400 },
    );
  }

  if (inlineStatus) return inlineStatus;
  if (args.status_id) return { id: args.status_id };
  if (args.status_name) return { name: args.status_name };

  return undefined;
}

function normalizeParentInput(args, { required = false } = {}) {
  const input = toObject(args);
  const explicitParent = toObject(input.parent);

  // Nested format support: { product: { id: "..." } }, etc.
  const productId =
    explicitParent.product?.id ??
    input.product?.id ??
    input["product.id"] ??
    input.product_id;

  const componentId =
    explicitParent.component?.id ??
    input.component?.id ??
    input["component.id"] ??
    input.component_id;

  const featureId =
    explicitParent.feature?.id ??
    input.feature?.id ??
    input["feature.id"] ??
    input.parent_feature_id;

  const candidates = [
    productId ? { product: { id: productId } } : null,
    componentId ? { component: { id: componentId } } : null,
    featureId ? { feature: { id: featureId } } : null,
  ].filter(Boolean);

  if (candidates.length > 1) {
    throw new ProductboardApiError(
      "Provide only one parent type: product, component, or feature.",
      { status: 400 },
    );
  }

  if (candidates.length === 1) {
    return candidates[0];
  }

  if (required) {
    throw new ProductboardApiError(
      "Missing feature parent. Provide product.id, component.id, or parent_feature_id.",
      { status: 400 },
    );
  }

  return undefined;
}

function buildTimeframeInput(input) {
  if (input === undefined || input === null) return undefined;

  if (typeof input === "object") {
    const value = {};
    if (input.start !== undefined) value.start = input.start;
    if (input.end !== undefined) value.end = input.end;
    return Object.keys(value).length > 0 ? value : undefined;
  }

  return undefined;
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return undefined;
}

function toBooleanInput(value, fieldName) {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;

  throw new ProductboardApiError(`Invalid boolean for ${fieldName}.`, { status: 400 });
}

function toOptionalNumber(value, fieldName) {
  if (value === undefined || value === null || value === "") return undefined;

  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new ProductboardApiError(`Invalid number for ${fieldName}.`, { status: 400 });
  }

  return number;
}

function buildDateTimeframeInput(input, overrides = {}) {
  const value = toObject(input);
  const startDate = overrides.startDate ?? value.startDate ?? value.start;
  const endDate = overrides.endDate ?? value.endDate ?? value.end;
  const granularity = overrides.granularity ?? value.granularity;

  const hasStartDate = startDate !== undefined && startDate !== null && startDate !== "";
  const hasEndDate = endDate !== undefined && endDate !== null && endDate !== "";
  const hasGranularity =
    granularity !== undefined && granularity !== null && granularity !== "";

  if (!hasStartDate && !hasEndDate && !hasGranularity) {
    return undefined;
  }

  if (hasStartDate !== hasEndDate) {
    throw new ProductboardApiError(
      "Timeframe requires both startDate and endDate when provided.",
      { status: 400 },
    );
  }

  return {
    ...(hasStartDate ? { startDate } : {}),
    ...(hasEndDate ? { endDate } : {}),
    ...(hasGranularity ? { granularity } : {}),
  };
}

function buildProgressInput(rawArgs) {
  const args = toObject(rawArgs);
  const progressInput = toObject(args.progress);
  const scalarProgress =
    typeof args.progress === "number" || typeof args.progress === "string"
      ? args.progress
      : undefined;

  const startValue = toOptionalNumber(
    progressInput.startValue ?? args.start_value ?? args.startValue,
    "progress.startValue",
  );
  const targetValue = toOptionalNumber(
    progressInput.targetValue ?? args.target_value ?? args.targetValue,
    "progress.targetValue",
  );
  const currentValue = toOptionalNumber(
    progressInput.currentValue ?? args.current_value ?? args.currentValue,
    "progress.currentValue",
  );
  const progress = toOptionalNumber(
    progressInput.progress ?? args.progress_value ?? args.progressPercent ?? scalarProgress,
    "progress.progress",
  );

  if (
    startValue === undefined &&
    targetValue === undefined &&
    currentValue === undefined &&
    progress === undefined
  ) {
    return undefined;
  }

  return {
    ...(startValue !== undefined ? { startValue } : {}),
    ...(targetValue !== undefined ? { targetValue } : {}),
    ...(currentValue !== undefined ? { currentValue } : {}),
    ...(progress !== undefined ? { progress } : {}),
  };
}

function asJsonResult(data) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function asErrorResult(error) {
  const status = error?.status;
  const payload = {
    error: {
      message: error instanceof Error ? error.message : String(error),
      ...(status ? { status } : {}),
      ...(error?.retryAfter ? { retry_after_seconds: error.retryAfter } : {}),
      ...(error?.details ? { details: error.details } : {}),
    },
  };

  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

async function pbFeaturesList(rawArgs) {
  const args = toObject(rawArgs);
  const limit = normalizeLimit(args.limit);

  const filterMap = {
    ...(args.status_id ? { "status.id": args.status_id } : {}),
    ...(args.status_name ? { "status.name": args.status_name } : {}),
    ...(args.parent_id ? { "parent.id": args.parent_id } : {}),
    ...(args.owner_email ? { "owner.email": args.owner_email } : {}),
    ...(args.note_id ? { "note.id": args.note_id } : {}),
    ...(args.archived !== undefined ? { archived: args.archived } : {}),
  };

  // Productboard features list uses parent.id filter. Accept product.id as convenience.
  if (args.product_id || args["product.id"] || args.product?.id) {
    filterMap["parent.id"] = args.product_id ?? args["product.id"] ?? args.product.id;
  }

  Object.assign(filterMap, flattenFilters(args.filters));

  const result = await listWithLinks("/features", { query: filterMap, limit });

  return {
    endpoint: "/features",
    ...result,
  };
}

async function pbFeatureGet(rawArgs) {
  const args = toObject(rawArgs);
  if (!args.id) {
    throw new ProductboardApiError("Missing required parameter: id", { status: 400 });
  }

  const payload = await apiRequest("GET", `/features/${encodeURIComponent(args.id)}`);
  return payload?.data ?? null;
}

async function pbFeatureCreate(rawArgs) {
  const args = toObject(rawArgs);

  if (!args.name || !args.description) {
    throw new ProductboardApiError(
      "Missing required parameters: name and description.",
      { status: 400 },
    );
  }

  const status = resolveStatusFromArgs(args);
  if (!status) {
    throw new ProductboardApiError(
      "Missing required status. Provide status.name, status.id, status_name, or status_id.",
      { status: 400 },
    );
  }

  const parent = normalizeParentInput(args, { required: true });
  const timeframe = buildTimeframeInput(args.timeframe);

  const body = {
    data: {
      name: args.name,
      description: args.description,
      type: args.type ?? (parent.feature ? "subfeature" : "feature"),
      status,
      parent,
      ...(args.archived !== undefined ? { archived: Boolean(args.archived) } : {}),
      ...(args.owner_email ? { owner: { email: args.owner_email } } : {}),
      ...(timeframe ? { timeframe } : {}),
    },
  };

  const payload = await apiRequest("POST", "/features", { body });
  return payload?.data ?? null;
}

async function pbFeatureUpdate(rawArgs) {
  const args = toObject(rawArgs);
  if (!args.id) {
    throw new ProductboardApiError("Missing required parameter: id", { status: 400 });
  }

  const status = resolveStatusFromArgs(args);
  const parent = normalizeParentInput(args);
  const timeframe = buildTimeframeInput(args.timeframe);

  const data = {
    ...(args.name !== undefined ? { name: args.name } : {}),
    ...(args.description !== undefined ? { description: args.description } : {}),
    ...(args.archived !== undefined ? { archived: Boolean(args.archived) } : {}),
    ...(status ? { status } : {}),
    ...(parent ? { parent } : {}),
    ...(args.owner_email !== undefined
      ? { owner: args.owner_email ? { email: args.owner_email } : null }
      : {}),
    ...(timeframe ? { timeframe } : {}),
  };

  if (Object.keys(data).length === 0) {
    throw new ProductboardApiError("No update fields provided.", { status: 400 });
  }

  const payload = await apiRequest("PATCH", `/features/${encodeURIComponent(args.id)}`, {
    body: { data },
  });

  return payload?.data ?? null;
}

async function pbNotesList(rawArgs) {
  const args = toObject(rawArgs);
  const limit = normalizeLimit(args.limit);

  const query = {
    ...(args.term ? { term: args.term } : {}),
    ...(args.featureId ? { featureId: args.featureId } : {}),
    ...(args.companyId ? { companyId: args.companyId } : {}),
    ...(args.ownerEmail ? { ownerEmail: args.ownerEmail } : {}),
    ...(args.source ? { source: args.source } : {}),
    ...(args.anyTag ? { anyTag: args.anyTag } : {}),
    ...(args.allTags ? { allTags: args.allTags } : {}),
    ...(args.dateFrom ? { dateFrom: args.dateFrom } : {}),
    ...(args.dateTo ? { dateTo: args.dateTo } : {}),
    ...(args.createdFrom ? { createdFrom: args.createdFrom } : {}),
    ...(args.createdTo ? { createdTo: args.createdTo } : {}),
    ...(args.updatedFrom ? { updatedFrom: args.updatedFrom } : {}),
    ...(args.updatedTo ? { updatedTo: args.updatedTo } : {}),
    ...(args.last ? { last: args.last } : {}),
    ...(args.pageCursor ? { pageCursor: args.pageCursor } : {}),
    ...flattenFilters(args.filters),
  };

  const result = await listNotes({ query, limit });

  return {
    endpoint: "/notes",
    ...result,
  };
}

async function pbNoteCreate(rawArgs) {
  const args = toObject(rawArgs);

  if (!args.title || !args.content) {
    throw new ProductboardApiError(
      "Missing required parameters: title and content.",
      { status: 400 },
    );
  }

  const tags = Array.isArray(args.tags)
    ? args.tags
    : typeof args.tags === "string"
      ? args.tags
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      : undefined;

  const body = {
    title: args.title,
    content: args.content,
    ...(tags ? { tags } : {}),
    ...(args.user_email ? { user: { email: args.user_email } } : {}),
  };

  const payload = await apiRequest("POST", "/notes", { body });
  return {
    id: payload?.data?.id ?? null,
    links: payload?.links ?? null,
  };
}

async function pbProductsList(rawArgs) {
  const args = toObject(rawArgs);
  const limit = normalizeLimit(args.limit);
  const result = await listWithLinks("/products", { limit });

  return {
    endpoint: "/products",
    ...result,
  };
}

async function pbReleasesList(rawArgs) {
  const args = toObject(rawArgs);
  const limit = normalizeLimit(args.limit);

  const query = {
    ...(args.release_group_id ? { "releaseGroup.id": args.release_group_id } : {}),
    ...flattenFilters(args.filters),
  };

  const result = await listWithLinks("/releases", { query, limit });
  return {
    endpoint: "/releases",
    ...result,
  };
}

async function pbReleaseGet(rawArgs) {
  const args = toObject(rawArgs);
  if (!args.id) {
    throw new ProductboardApiError("Missing required parameter: id", { status: 400 });
  }

  const payload = await apiRequest("GET", `/releases/${encodeURIComponent(args.id)}`);
  return payload?.data ?? null;
}

async function pbCompaniesList(rawArgs) {
  const args = toObject(rawArgs);
  const limit = normalizeLimit(args.limit);

  const query = {
    ...(args.term ? { term: args.term } : {}),
    ...(args.hasNotes !== undefined ? { hasNotes: args.hasNotes } : {}),
    ...(args.featureId ? { featureId: args.featureId } : {}),
    ...(args.pageCursor ? { pageCursor: args.pageCursor } : {}),
    ...flattenFilters(args.filters),
  };

  const result = await listWithLinks("/companies", {
    query,
    limit,
    pageSizeParam: "pageLimit",
  });

  return {
    endpoint: "/companies",
    ...result,
  };
}

async function pbUserCurrent() {
  try {
    const payload = await apiRequest("GET", "/user");
    return payload?.data ?? payload;
  } catch (error) {
    if (error instanceof ProductboardApiError && error.status === 404) {
      const usersPayload = await apiRequest("GET", "/users");
      const users = Array.isArray(usersPayload?.data) ? usersPayload.data : [];
      return {
        warning: "GET /user is unavailable in this Productboard API version; using GET /users for connectivity check.",
        users_count: users.length,
        first_user: users[0] ?? null,
      };
    }
    throw error;
  }
}

async function pbFeatureDelete(rawArgs) {
  const args = toObject(rawArgs);
  if (!args.id) {
    throw new ProductboardApiError("Missing required parameter: id", { status: 400 });
  }

  await apiRequest("DELETE", `/features/${encodeURIComponent(args.id)}`);

  return {
    id: args.id,
    deleted: true,
  };
}

async function pbFeatureStatuses(rawArgs) {
  const args = toObject(rawArgs);
  const limit = normalizeLimit(args.limit);

  const result = await listWithLinks("/feature-statuses", { limit });

  return {
    endpoint: "/feature-statuses",
    ...result,
  };
}

async function pbComponentsList(rawArgs) {
  const args = toObject(rawArgs);
  const limit = normalizeLimit(args.limit);

  const result = await listWithLinks("/components", { limit });

  return {
    endpoint: "/components",
    ...result,
  };
}

async function pbNoteGet(rawArgs) {
  const args = toObject(rawArgs);
  if (!args.id) {
    throw new ProductboardApiError("Missing required parameter: id", { status: 400 });
  }

  const payload = await apiRequest("GET", `/notes/${encodeURIComponent(args.id)}`);
  return payload?.data ?? null;
}

async function pbNoteUpdate(rawArgs) {
  const args = toObject(rawArgs);
  if (!args.id) {
    throw new ProductboardApiError("Missing required parameter: id", { status: 400 });
  }

  const tags = normalizeStringArray(args.tags);

  const data = {
    ...(args.title !== undefined ? { title: args.title } : {}),
    ...(args.content !== undefined ? { content: args.content } : {}),
    ...(tags ? { tags } : {}),
  };

  if (Object.keys(data).length === 0) {
    throw new ProductboardApiError("No update fields provided.", { status: 400 });
  }

  const payload = await apiRequest("PATCH", `/notes/${encodeURIComponent(args.id)}`, {
    body: { data },
  });

  return {
    id: payload?.data?.id ?? args.id,
    links: payload?.links ?? null,
  };
}

async function pbNoteLink(rawArgs) {
  const args = toObject(rawArgs);
  const noteId = args.note_id ?? args.noteId;
  const entityId = args.entity_id ?? args.entityId;

  if (!noteId) {
    throw new ProductboardApiError("Missing required parameter: note_id", { status: 400 });
  }

  if (!entityId) {
    throw new ProductboardApiError("Missing required parameter: entity_id", { status: 400 });
  }

  await apiRequest(
    "POST",
    `/notes/${encodeURIComponent(noteId)}/links/${encodeURIComponent(entityId)}`,
  );

  return {
    note_id: noteId,
    entity_id: entityId,
    linked: true,
  };
}

async function pbObjectivesList(rawArgs) {
  const args = toObject(rawArgs);
  const limit = normalizeLimit(args.limit);

  const query = {
    ...(args.archived !== undefined ? { archived: args.archived } : {}),
    ...(args.owner_email ? { "owner.email": args.owner_email } : {}),
    ...(args.parent_id ? { "parent.id": args.parent_id } : {}),
    ...(args.status_id ? { "status.id": args.status_id } : {}),
    ...(args.status_name ? { "status.name": args.status_name } : {}),
    ...flattenFilters(args.filters),
  };

  const result = await listWithLinks("/objectives", { query, limit });

  return {
    endpoint: "/objectives",
    ...result,
  };
}

async function pbObjectiveGet(rawArgs) {
  const args = toObject(rawArgs);
  if (!args.id) {
    throw new ProductboardApiError("Missing required parameter: id", { status: 400 });
  }

  const payload = await apiRequest("GET", `/objectives/${encodeURIComponent(args.id)}`);
  return payload?.data ?? null;
}

async function pbObjectiveCreate(rawArgs) {
  const args = toObject(rawArgs);

  if (!args.name) {
    throw new ProductboardApiError("Missing required parameter: name", { status: 400 });
  }

  const status = resolveStatusFromArgs(args);
  const parentId = args.parent?.id ?? args["parent.id"] ?? args.parent_id;
  const timeframe = buildDateTimeframeInput(args.timeframe, {
    startDate: args.start_date ?? args.startDate,
    endDate: args.end_date ?? args.endDate,
    granularity: args.granularity,
  });

  const data = {
    name: args.name,
    ...(args.description !== undefined ? { description: args.description } : {}),
    ...(status ? { status } : {}),
    ...(parentId ? { parent: { id: parentId } } : {}),
    ...(args.owner_email ? { owner: { email: args.owner_email } } : {}),
    ...(timeframe ? { timeframe } : {}),
  };

  const payload = await apiRequest("POST", "/objectives", {
    body: { data },
  });

  return payload?.data ?? payload ?? null;
}

async function pbObjectiveUpdate(rawArgs) {
  const args = toObject(rawArgs);
  if (!args.id) {
    throw new ProductboardApiError("Missing required parameter: id", { status: 400 });
  }

  const status = resolveStatusFromArgs(args);
  const parentId = args.parent?.id ?? args["parent.id"] ?? args.parent_id;
  const timeframe = buildDateTimeframeInput(args.timeframe, {
    startDate: args.start_date ?? args.startDate,
    endDate: args.end_date ?? args.endDate,
    granularity: args.granularity,
  });

  const data = {
    ...(args.name !== undefined ? { name: args.name } : {}),
    ...(args.description !== undefined ? { description: args.description } : {}),
    ...(status ? { status } : {}),
    ...(parentId ? { parent: { id: parentId } } : {}),
    ...(args.owner_email !== undefined
      ? { owner: args.owner_email ? { email: args.owner_email } : null }
      : {}),
    ...(timeframe ? { timeframe } : {}),
    ...(args.archived !== undefined ? { archived: Boolean(args.archived) } : {}),
  };

  if (Object.keys(data).length === 0) {
    throw new ProductboardApiError("No update fields provided.", { status: 400 });
  }

  const payload = await apiRequest("PATCH", `/objectives/${encodeURIComponent(args.id)}`, {
    body: { data },
  });

  return payload?.data ?? payload ?? null;
}

async function pbKeyResultsList(rawArgs) {
  const args = toObject(rawArgs);
  const limit = normalizeLimit(args.limit);

  const parentId =
    args.parent?.id ??
    args["parent.id"] ??
    args.parent_id ??
    args.objective_id ??
    args.objectiveId;

  const query = {
    ...(parentId ? { "parent.id": parentId } : {}),
    ...(args.status_id ? { "status.id": args.status_id } : {}),
    ...(args.status_name ? { "status.name": args.status_name } : {}),
    ...(args.archived !== undefined ? { archived: args.archived } : {}),
    ...(args.owner_email ? { "owner.email": args.owner_email } : {}),
    ...flattenFilters(args.filters),
  };

  const result = await listWithLinks("/key-results", { query, limit });

  return {
    endpoint: "/key-results",
    ...result,
  };
}

async function pbKeyResultGet(rawArgs) {
  const args = toObject(rawArgs);
  if (!args.id) {
    throw new ProductboardApiError("Missing required parameter: id", { status: 400 });
  }

  const payload = await apiRequest("GET", `/key-results/${encodeURIComponent(args.id)}`);
  return payload?.data ?? null;
}

async function pbKeyResultCreate(rawArgs) {
  const args = toObject(rawArgs);
  const parentId =
    args.parent?.id ??
    args["parent.id"] ??
    args.parent_id ??
    args.objective_id ??
    args.objectiveId;

  if (!parentId || !args.name) {
    throw new ProductboardApiError(
      "Missing required parameters: objective_id (or parent_id) and name.",
      { status: 400 },
    );
  }

  const status = resolveStatusFromArgs(args);
  const timeframe = buildDateTimeframeInput(args.timeframe, {
    startDate: args.start_date ?? args.startDate,
    endDate: args.end_date ?? args.endDate,
    granularity: args.granularity,
  });
  const progress = buildProgressInput(args);

  const data = {
    name: args.name,
    parent: { id: parentId },
    ...(args.description !== undefined ? { description: args.description } : {}),
    ...(args.owner_email ? { owner: { email: args.owner_email } } : {}),
    ...(status ? { status } : {}),
    ...(progress ? { progress } : {}),
    ...(timeframe ? { timeframe } : {}),
  };

  const payload = await apiRequest("POST", "/key-results", {
    body: { data },
  });

  return payload?.data ?? payload ?? null;
}

async function pbKeyResultUpdate(rawArgs) {
  const args = toObject(rawArgs);
  if (!args.id) {
    throw new ProductboardApiError("Missing required parameter: id", { status: 400 });
  }

  const parentId =
    args.parent?.id ??
    args["parent.id"] ??
    args.parent_id ??
    args.objective_id ??
    args.objectiveId;

  const status = resolveStatusFromArgs(args);
  const timeframe = buildDateTimeframeInput(args.timeframe, {
    startDate: args.start_date ?? args.startDate,
    endDate: args.end_date ?? args.endDate,
    granularity: args.granularity,
  });
  const progress = buildProgressInput(args);

  const data = {
    ...(args.name !== undefined ? { name: args.name } : {}),
    ...(args.description !== undefined ? { description: args.description } : {}),
    ...(args.owner_email !== undefined
      ? { owner: args.owner_email ? { email: args.owner_email } : null }
      : {}),
    ...(status ? { status } : {}),
    ...(parentId ? { parent: { id: parentId } } : {}),
    ...(progress ? { progress } : {}),
    ...(timeframe ? { timeframe } : {}),
    ...(args.archived !== undefined ? { archived: Boolean(args.archived) } : {}),
  };

  if (Object.keys(data).length === 0) {
    throw new ProductboardApiError("No update fields provided.", { status: 400 });
  }

  const payload = await apiRequest("PATCH", `/key-results/${encodeURIComponent(args.id)}`, {
    body: { data },
  });

  return payload?.data ?? payload ?? null;
}

async function pbInitiativesList(rawArgs) {
  const args = toObject(rawArgs);
  const limit = normalizeLimit(args.limit);

  const query = {
    ...(args.archived !== undefined ? { archived: args.archived } : {}),
    ...(args.owner_email ? { "owner.email": args.owner_email } : {}),
    ...(args.status_id ? { "status.id": args.status_id } : {}),
    ...(args.status_name ? { "status.name": args.status_name } : {}),
    ...flattenFilters(args.filters),
  };

  const result = await listWithLinks("/initiatives", { query, limit });

  return {
    endpoint: "/initiatives",
    ...result,
  };
}

async function pbInitiativeGet(rawArgs) {
  const args = toObject(rawArgs);
  if (!args.id) {
    throw new ProductboardApiError("Missing required parameter: id", { status: 400 });
  }

  const payload = await apiRequest("GET", `/initiatives/${encodeURIComponent(args.id)}`);
  return payload?.data ?? null;
}

async function pbInitiativeCreate(rawArgs) {
  const args = toObject(rawArgs);

  if (!args.name) {
    throw new ProductboardApiError("Missing required parameter: name", { status: 400 });
  }

  const status = resolveStatusFromArgs(args);
  const timeframe = buildDateTimeframeInput(args.timeframe, {
    startDate: args.start_date ?? args.startDate,
    endDate: args.end_date ?? args.endDate,
    granularity: args.granularity,
  });

  const data = {
    name: args.name,
    ...(args.description !== undefined ? { description: args.description } : {}),
    ...(status ? { status } : {}),
    ...(args.owner_email ? { owner: { email: args.owner_email } } : {}),
    ...(timeframe ? { timeframe } : {}),
  };

  const payload = await apiRequest("POST", "/initiatives", {
    body: { data },
  });

  return payload?.data ?? payload ?? null;
}

async function pbInitiativeUpdate(rawArgs) {
  const args = toObject(rawArgs);
  if (!args.id) {
    throw new ProductboardApiError("Missing required parameter: id", { status: 400 });
  }

  const status = resolveStatusFromArgs(args);
  const timeframe = buildDateTimeframeInput(args.timeframe, {
    startDate: args.start_date ?? args.startDate,
    endDate: args.end_date ?? args.endDate,
    granularity: args.granularity,
  });

  const data = {
    ...(args.name !== undefined ? { name: args.name } : {}),
    ...(args.description !== undefined ? { description: args.description } : {}),
    ...(status ? { status } : {}),
    ...(args.owner_email !== undefined
      ? { owner: args.owner_email ? { email: args.owner_email } : null }
      : {}),
    ...(timeframe ? { timeframe } : {}),
    ...(args.archived !== undefined ? { archived: Boolean(args.archived) } : {}),
  };

  if (Object.keys(data).length === 0) {
    throw new ProductboardApiError("No update fields provided.", { status: 400 });
  }

  const payload = await apiRequest("PATCH", `/initiatives/${encodeURIComponent(args.id)}`, {
    body: { data },
  });

  return payload?.data ?? payload ?? null;
}

async function pbReleaseCreate(rawArgs) {
  const args = toObject(rawArgs);

  if (!args.name || !args.description) {
    throw new ProductboardApiError(
      "Missing required parameters: name and description.",
      { status: 400 },
    );
  }

  const releaseGroupId =
    args.release_group_id ?? args.releaseGroup?.id ?? args["releaseGroup.id"];

  if (!releaseGroupId) {
    throw new ProductboardApiError("Missing required parameter: release_group_id", {
      status: 400,
    });
  }

  const timeframe = buildDateTimeframeInput(args.timeframe, {
    startDate: args.start_date ?? args.startDate,
    endDate: args.end_date ?? args.endDate,
    granularity: args.granularity,
  });

  const data = {
    name: args.name,
    description: args.description,
    releaseGroup: { id: releaseGroupId },
    ...(args.state ? { state: args.state } : {}),
    ...(timeframe ? { timeframe } : {}),
  };

  const payload = await apiRequest("POST", "/releases", {
    body: { data },
  });

  return payload?.data ?? null;
}

async function pbReleaseUpdate(rawArgs) {
  const args = toObject(rawArgs);
  if (!args.id) {
    throw new ProductboardApiError("Missing required parameter: id", { status: 400 });
  }

  const releaseGroupId =
    args.release_group_id ?? args.releaseGroup?.id ?? args["releaseGroup.id"];

  const timeframe = buildDateTimeframeInput(args.timeframe, {
    startDate: args.start_date ?? args.startDate,
    endDate: args.end_date ?? args.endDate,
    granularity: args.granularity,
  });

  const data = {
    ...(args.name !== undefined ? { name: args.name } : {}),
    ...(args.description !== undefined ? { description: args.description } : {}),
    ...(args.archived !== undefined ? { archived: Boolean(args.archived) } : {}),
    ...(releaseGroupId ? { releaseGroup: { id: releaseGroupId } } : {}),
    ...(args.state ? { state: args.state } : {}),
    ...(timeframe ? { timeframe } : {}),
  };

  if (Object.keys(data).length === 0) {
    throw new ProductboardApiError("No update fields provided.", { status: 400 });
  }

  const payload = await apiRequest("PATCH", `/releases/${encodeURIComponent(args.id)}`, {
    body: { data },
  });

  return payload?.data ?? null;
}

async function pbReleaseGroupsList(rawArgs) {
  const args = toObject(rawArgs);
  const limit = normalizeLimit(args.limit);

  const result = await listWithLinks("/release-groups", { limit });

  return {
    endpoint: "/release-groups",
    ...result,
  };
}

async function pbFeatureReleaseList(rawArgs) {
  const args = toObject(rawArgs);
  const limit = normalizeLimit(args.limit);

  const featureId = args.feature_id ?? args.feature?.id ?? args["feature.id"];
  const releaseId = args.release_id ?? args.release?.id ?? args["release.id"];

  const query = {
    ...(featureId ? { "feature.id": featureId } : {}),
    ...(releaseId ? { "release.id": releaseId } : {}),
    ...(args.release_state ? { "release.state": args.release_state } : {}),
    ...(args.end_date_from ? { "release.timeframe.endDate.from": args.end_date_from } : {}),
    ...(args.end_date_to ? { "release.timeframe.endDate.to": args.end_date_to } : {}),
    ...flattenFilters(args.filters),
  };

  const result = await listWithLinks("/feature-release-assignments", { query, limit });

  return {
    endpoint: "/feature-release-assignments",
    ...result,
  };
}

async function pbFeatureReleaseAssign(rawArgs) {
  const args = toObject(rawArgs);

  const featureId = args.feature_id ?? args.feature?.id ?? args["feature.id"];
  const releaseId = args.release_id ?? args.release?.id ?? args["release.id"];

  if (!featureId) {
    throw new ProductboardApiError("Missing required parameter: feature_id", {
      status: 400,
    });
  }

  if (!releaseId) {
    throw new ProductboardApiError("Missing required parameter: release_id", {
      status: 400,
    });
  }

  if (args.assigned === undefined) {
    throw new ProductboardApiError("Missing required parameter: assigned", {
      status: 400,
    });
  }

  const assigned = toBooleanInput(args.assigned, "assigned");

  const payload = await apiRequest("PUT", "/feature-release-assignments/assignment", {
    query: {
      "feature.id": featureId,
      "release.id": releaseId,
    },
    body: {
      data: {
        assigned,
      },
    },
  });

  return payload?.data ?? {
    feature: { id: featureId },
    release: { id: releaseId },
    assigned,
  };
}

async function pbFeatureObjectives(rawArgs) {
  const args = toObject(rawArgs);
  if (!args.id) {
    throw new ProductboardApiError("Missing required parameter: id", { status: 400 });
  }

  const limit = normalizeLimit(args.limit);

  const result = await listWithLinks(
    `/features/${encodeURIComponent(args.id)}/links/objectives`,
    { limit },
  );

  return {
    endpoint: `/features/${args.id}/links/objectives`,
    ...result,
  };
}

async function pbFeatureLinkObjective(rawArgs) {
  const args = toObject(rawArgs);
  const featureId = args.id ?? args.feature_id;
  const objectiveId = args.objective_id ?? args.objectiveId;

  if (!featureId) {
    throw new ProductboardApiError("Missing required parameter: id (feature ID)", {
      status: 400,
    });
  }

  if (!objectiveId) {
    throw new ProductboardApiError("Missing required parameter: objective_id", {
      status: 400,
    });
  }

  await apiRequest(
    "POST",
    `/features/${encodeURIComponent(featureId)}/links/objectives/${encodeURIComponent(objectiveId)}`,
  );

  return {
    feature_id: featureId,
    objective_id: objectiveId,
    linked: true,
  };
}

async function pbFeatureLinkInitiative(rawArgs) {
  const args = toObject(rawArgs);
  const featureId = args.id ?? args.feature_id;
  const initiativeId = args.initiative_id ?? args.initiativeId;

  if (!featureId) {
    throw new ProductboardApiError("Missing required parameter: id (feature ID)", {
      status: 400,
    });
  }

  if (!initiativeId) {
    throw new ProductboardApiError("Missing required parameter: initiative_id", {
      status: 400,
    });
  }

  await apiRequest(
    "POST",
    `/features/${encodeURIComponent(featureId)}/links/initiatives/${encodeURIComponent(initiativeId)}`,
  );

  return {
    feature_id: featureId,
    initiative_id: initiativeId,
    linked: true,
  };
}

async function pbUsersList(rawArgs) {
  const args = toObject(rawArgs);
  const limit = normalizeLimit(args.limit);

  const result = await listWithLinks("/users", { limit });

  return {
    endpoint: "/users",
    ...result,
  };
}

async function pbCustomFieldsList(rawArgs) {
  const args = toObject(rawArgs);
  const limit = normalizeLimit(args.limit);

  const types = normalizeStringArray(args.type);
  if (!types || types.length === 0) {
    throw new ProductboardApiError(
      "Missing required parameter: type (one or more custom field types).",
      { status: 400 },
    );
  }

  const allowedTypes = new Set([
    "text",
    "custom-description",
    "number",
    "dropdown",
    "multi-dropdown",
    "member",
  ]);

  const invalidTypes = types.filter((type) => !allowedTypes.has(type));
  if (invalidTypes.length > 0) {
    throw new ProductboardApiError(
      `Invalid custom field type(s): ${invalidTypes.join(", ")}`,
      { status: 400 },
    );
  }

  const result = await listWithLinks("/hierarchy-entities/custom-fields", {
    query: { type: types.join(",") },
    limit,
  });

  return {
    endpoint: "/hierarchy-entities/custom-fields",
    type: types,
    ...result,
  };
}

async function pbCustomFieldValueGet(rawArgs) {
  const args = toObject(rawArgs);
  const customFieldId =
    args.custom_field_id ?? args.customField?.id ?? args["customField.id"];
  const hierarchyEntityId =
    args.hierarchy_entity_id ??
    args.hierarchyEntity?.id ??
    args["hierarchyEntity.id"];

  if (!customFieldId) {
    throw new ProductboardApiError("Missing required parameter: custom_field_id", {
      status: 400,
    });
  }

  if (!hierarchyEntityId) {
    throw new ProductboardApiError(
      "Missing required parameter: hierarchy_entity_id",
      { status: 400 },
    );
  }

  const payload = await apiRequest(
    "GET",
    "/hierarchy-entities/custom-fields-values/value",
    {
      query: {
        "customField.id": customFieldId,
        "hierarchyEntity.id": hierarchyEntityId,
      },
    },
  );

  return payload?.data ?? null;
}


const tools = [
  {
    name: "pb_features_list",
    description: "List Productboard features with optional filters and pagination.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of items to return.",
          minimum: 1,
          maximum: 1000,
        },
        status_id: { type: "string", description: "Filter by status ID." },
        status_name: { type: "string", description: "Filter by status name." },
        parent_id: { type: "string", description: "Filter by parent feature ID." },
        product_id: { type: "string", description: "Filter by product ID." },
        owner_email: { type: "string", description: "Filter by owner email." },
        note_id: { type: "string", description: "Filter by linked note ID." },
        archived: { type: "boolean", description: "Include archived features." },
        filters: {
          type: "object",
          description: "Additional raw Productboard filters.",
          additionalProperties: true,
        },
      },
      additionalProperties: true,
    },
  },
  {
    name: "pb_feature_get",
    description: "Get details for a Productboard feature by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Feature ID." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "pb_feature_create",
    description: "Create a Productboard feature.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Feature name." },
        description: { type: "string", description: "Feature description (HTML supported)." },
        type: { type: "string", enum: ["feature", "subfeature"], description: "Feature type." },
        status: {
          description: "Feature status by name or id.",
          oneOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
              },
              additionalProperties: false,
            },
          ],
        },
        status_id: { type: "string", description: "Feature status ID." },
        status_name: { type: "string", description: "Feature status name." },
        product_id: { type: "string", description: "Parent product ID." },
        component_id: { type: "string", description: "Parent component ID." },
        parent_feature_id: { type: "string", description: "Parent feature ID for subfeature." },
        owner_email: { type: "string", description: "Owner email." },
        archived: { type: "boolean", description: "Archived flag." },
        timeframe: {
          type: "object",
          description: "Feature timeframe.",
          properties: {
            start: { type: "string" },
            end: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      required: ["name", "description"],
      additionalProperties: true,
    },
  },
  {
    name: "pb_feature_update",
    description: "Update a Productboard feature by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Feature ID." },
        name: { type: "string", description: "Feature name." },
        description: { type: "string", description: "Feature description." },
        status: {
          description: "Feature status by name or id.",
          oneOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
              },
              additionalProperties: false,
            },
          ],
        },
        status_id: { type: "string", description: "Feature status ID." },
        status_name: { type: "string", description: "Feature status name." },
        product_id: { type: "string", description: "Parent product ID." },
        component_id: { type: "string", description: "Parent component ID." },
        parent_feature_id: { type: "string", description: "Parent feature ID." },
        owner_email: { type: "string", description: "Owner email (empty to clear)." },
        archived: { type: "boolean", description: "Archived flag." },
        timeframe: {
          type: "object",
          description: "Feature timeframe.",
          properties: {
            start: { type: "string" },
            end: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      required: ["id"],
      additionalProperties: true,
    },
  },
  {
    name: "pb_feature_delete",
    description: "Delete a Productboard feature by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Feature ID." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "pb_feature_statuses",
    description: "List available Productboard feature statuses.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of items to return.",
          minimum: 1,
          maximum: 1000,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "pb_components_list",
    description: "List Productboard components.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of items to return.",
          minimum: 1,
          maximum: 1000,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "pb_notes_list",
    description: "List Productboard notes with optional filters and pagination.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of items to return.",
          minimum: 1,
          maximum: 1000,
        },
        term: { type: "string", description: "Search term." },
        featureId: { type: "string", description: "Filter by feature ID." },
        companyId: { type: "string", description: "Filter by company ID." },
        ownerEmail: { type: "string", description: "Filter by owner email." },
        source: { type: "string", description: "Filter by source." },
        anyTag: { type: "string", description: "Match any of these tags." },
        allTags: { type: "string", description: "Match all of these tags." },
        dateFrom: { type: "string", description: "Interaction date from (ISO 8601)." },
        dateTo: { type: "string", description: "Interaction date to (ISO 8601)." },
        createdFrom: { type: "string", description: "Created from (ISO 8601)." },
        createdTo: { type: "string", description: "Created to (ISO 8601)." },
        updatedFrom: { type: "string", description: "Updated from (ISO 8601)." },
        updatedTo: { type: "string", description: "Updated to (ISO 8601)." },
        pageCursor: { type: "string", description: "Page cursor for pagination." },
        filters: {
          type: "object",
          description: "Additional raw Productboard filters.",
          additionalProperties: true,
        },
      },
      additionalProperties: true,
    },
  },
  {
    name: "pb_note_get",
    description: "Get details for a Productboard note by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Note ID." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "pb_note_create",
    description: "Create a Productboard note.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Note title." },
        content: { type: "string", description: "Note content." },
        tags: {
          description: "Tags as comma-separated string or array.",
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        },
        user_email: { type: "string", description: "Creator user email." },
      },
      required: ["title", "content"],
      additionalProperties: true,
    },
  },
  {
    name: "pb_note_update",
    description: "Update a Productboard note by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Note ID." },
        title: { type: "string", description: "Updated title." },
        content: { type: "string", description: "Updated content." },
        tags: {
          description: "Updated tags as comma-separated string or array.",
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "pb_note_link",
    description: "Link a note to an entity (feature, company, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        note_id: { type: "string", description: "Note ID." },
        entity_id: { type: "string", description: "Entity ID to link." },
        noteId: { type: "string", description: "Alias for note_id." },
        entityId: { type: "string", description: "Alias for entity_id." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "pb_products_list",
    description: "List Productboard products.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of items to return.",
          minimum: 1,
          maximum: 1000,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "pb_objectives_list",
    description: "List Productboard objectives with optional filters.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of items to return.",
          minimum: 1,
          maximum: 1000,
        },
        archived: { type: "boolean", description: "Filter archived objectives." },
        owner_email: { type: "string", description: "Filter by owner email." },
        parent_id: { type: "string", description: "Filter by parent objective ID." },
        status_id: { type: "string", description: "Filter by status ID." },
        status_name: { type: "string", description: "Filter by status name." },
        filters: {
          type: "object",
          description: "Additional raw Productboard filters.",
          additionalProperties: true,
        },
      },
      additionalProperties: true,
    },
  },
  {
    name: "pb_objective_get",
    description: "Get details for a Productboard objective by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Objective ID." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "pb_objective_create",
    description: "Create a Productboard objective.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Objective name." },
        description: { type: "string", description: "Objective description." },
        owner_email: { type: "string", description: "Owner email." },
        parent_id: { type: "string", description: "Parent objective ID." },
        status: {
          description: "Status by name or id.",
          oneOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
              },
              additionalProperties: false,
            },
          ],
        },
        status_id: { type: "string", description: "Status ID." },
        status_name: { type: "string", description: "Status name." },
        timeframe: {
          type: "object",
          description: "Objective timeframe.",
          properties: {
            startDate: { type: "string" },
            endDate: { type: "string" },
            granularity: {
              type: "string",
              enum: ["year", "quarter", "month", "day"],
            },
          },
          additionalProperties: false,
        },
        start_date: { type: "string", description: "Alias for timeframe.startDate." },
        end_date: { type: "string", description: "Alias for timeframe.endDate." },
        granularity: {
          type: "string",
          description: "Alias for timeframe.granularity.",
          enum: ["year", "quarter", "month", "day"],
        },
      },
      required: ["name"],
      additionalProperties: true,
    },
  },
  {
    name: "pb_objective_update",
    description: "Update a Productboard objective by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Objective ID." },
        name: { type: "string", description: "Objective name." },
        description: { type: "string", description: "Objective description." },
        owner_email: { type: "string", description: "Owner email (empty to clear)." },
        parent_id: { type: "string", description: "Parent objective ID." },
        status: {
          description: "Status by name or id.",
          oneOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
              },
              additionalProperties: false,
            },
          ],
        },
        status_id: { type: "string", description: "Status ID." },
        status_name: { type: "string", description: "Status name." },
        archived: { type: "boolean", description: "Archived flag." },
        timeframe: {
          type: "object",
          description: "Objective timeframe.",
          properties: {
            startDate: { type: "string" },
            endDate: { type: "string" },
            granularity: {
              type: "string",
              enum: ["year", "quarter", "month", "day"],
            },
          },
          additionalProperties: false,
        },
        start_date: { type: "string", description: "Alias for timeframe.startDate." },
        end_date: { type: "string", description: "Alias for timeframe.endDate." },
        granularity: {
          type: "string",
          description: "Alias for timeframe.granularity.",
          enum: ["year", "quarter", "month", "day"],
        },
      },
      required: ["id"],
      additionalProperties: true,
    },
  },
  {
    name: "pb_key_results_list",
    description: "List Productboard key results with optional filters.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of items to return.",
          minimum: 1,
          maximum: 1000,
        },
        objective_id: { type: "string", description: "Filter by objective ID (maps to parent.id)." },
        parent_id: { type: "string", description: "Filter by parent objective ID." },
        status_id: { type: "string", description: "Filter by status ID." },
        status_name: { type: "string", description: "Filter by status name." },
        owner_email: { type: "string", description: "Filter by owner email." },
        archived: { type: "boolean", description: "Filter archived key results." },
        filters: {
          type: "object",
          description: "Additional raw Productboard filters.",
          additionalProperties: true,
        },
      },
      additionalProperties: true,
    },
  },
  {
    name: "pb_key_result_get",
    description: "Get details for a Productboard key result by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Key result ID." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "pb_key_result_create",
    description: "Create a Productboard key result.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Key result name." },
        objective_id: { type: "string", description: "Objective ID (parent.id)." },
        parent_id: { type: "string", description: "Alias for objective_id." },
        description: { type: "string", description: "Key result description." },
        owner_email: { type: "string", description: "Owner email." },
        status: {
          description: "Status by name or id.",
          oneOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
              },
              additionalProperties: false,
            },
          ],
        },
        status_id: { type: "string", description: "Status ID." },
        status_name: { type: "string", description: "Status name." },
        progress: {
          type: "object",
          description: "Progress values.",
          properties: {
            startValue: { type: "number" },
            targetValue: { type: "number" },
            currentValue: { type: "number" },
            progress: { type: "number" },
          },
          additionalProperties: false,
        },
        start_value: { type: "number", description: "Progress start value." },
        target_value: { type: "number", description: "Progress target value." },
        current_value: { type: "number", description: "Progress current value." },
        progress_value: { type: "number", description: "Progress percentage/value." },
        timeframe: {
          type: "object",
          description: "Key result timeframe.",
          properties: {
            startDate: { type: "string" },
            endDate: { type: "string" },
            granularity: {
              type: "string",
              enum: ["year", "quarter", "month", "day"],
            },
          },
          additionalProperties: false,
        },
        start_date: { type: "string", description: "Alias for timeframe.startDate." },
        end_date: { type: "string", description: "Alias for timeframe.endDate." },
        granularity: {
          type: "string",
          description: "Alias for timeframe.granularity.",
          enum: ["year", "quarter", "month", "day"],
        },
      },
      required: ["name"],
      additionalProperties: true,
    },
  },
  {
    name: "pb_key_result_update",
    description: "Update a Productboard key result by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Key result ID." },
        name: { type: "string", description: "Key result name." },
        objective_id: { type: "string", description: "Objective ID (parent.id)." },
        parent_id: { type: "string", description: "Alias for objective_id." },
        description: { type: "string", description: "Key result description." },
        owner_email: { type: "string", description: "Owner email (empty to clear)." },
        status: {
          description: "Status by name or id.",
          oneOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
              },
              additionalProperties: false,
            },
          ],
        },
        status_id: { type: "string", description: "Status ID." },
        status_name: { type: "string", description: "Status name." },
        archived: { type: "boolean", description: "Archived flag." },
        progress: {
          type: "object",
          description: "Progress values.",
          properties: {
            startValue: { type: "number" },
            targetValue: { type: "number" },
            currentValue: { type: "number" },
            progress: { type: "number" },
          },
          additionalProperties: false,
        },
        start_value: { type: "number", description: "Progress start value." },
        target_value: { type: "number", description: "Progress target value." },
        current_value: { type: "number", description: "Progress current value." },
        progress_value: { type: "number", description: "Progress percentage/value." },
        timeframe: {
          type: "object",
          description: "Key result timeframe.",
          properties: {
            startDate: { type: "string" },
            endDate: { type: "string" },
            granularity: {
              type: "string",
              enum: ["year", "quarter", "month", "day"],
            },
          },
          additionalProperties: false,
        },
        start_date: { type: "string", description: "Alias for timeframe.startDate." },
        end_date: { type: "string", description: "Alias for timeframe.endDate." },
        granularity: {
          type: "string",
          description: "Alias for timeframe.granularity.",
          enum: ["year", "quarter", "month", "day"],
        },
      },
      required: ["id"],
      additionalProperties: true,
    },
  },
  {
    name: "pb_initiatives_list",
    description: "List Productboard initiatives with optional filters.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of items to return.",
          minimum: 1,
          maximum: 1000,
        },
        archived: { type: "boolean", description: "Filter archived initiatives." },
        owner_email: { type: "string", description: "Filter by owner email." },
        status_id: { type: "string", description: "Filter by status ID." },
        status_name: { type: "string", description: "Filter by status name." },
        filters: {
          type: "object",
          description: "Additional raw Productboard filters.",
          additionalProperties: true,
        },
      },
      additionalProperties: true,
    },
  },
  {
    name: "pb_initiative_get",
    description: "Get details for a Productboard initiative by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Initiative ID." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "pb_initiative_create",
    description: "Create a Productboard initiative.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Initiative name." },
        description: { type: "string", description: "Initiative description." },
        owner_email: { type: "string", description: "Owner email." },
        status: {
          description: "Status by name or id.",
          oneOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
              },
              additionalProperties: false,
            },
          ],
        },
        status_id: { type: "string", description: "Status ID." },
        status_name: { type: "string", description: "Status name." },
        timeframe: {
          type: "object",
          description: "Initiative timeframe.",
          properties: {
            startDate: { type: "string" },
            endDate: { type: "string" },
            granularity: {
              type: "string",
              enum: ["year", "quarter", "month", "day"],
            },
          },
          additionalProperties: false,
        },
        start_date: { type: "string", description: "Alias for timeframe.startDate." },
        end_date: { type: "string", description: "Alias for timeframe.endDate." },
        granularity: {
          type: "string",
          description: "Alias for timeframe.granularity.",
          enum: ["year", "quarter", "month", "day"],
        },
      },
      required: ["name"],
      additionalProperties: true,
    },
  },
  {
    name: "pb_initiative_update",
    description: "Update a Productboard initiative by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Initiative ID." },
        name: { type: "string", description: "Initiative name." },
        description: { type: "string", description: "Initiative description." },
        owner_email: { type: "string", description: "Owner email (empty to clear)." },
        status: {
          description: "Status by name or id.",
          oneOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
              },
              additionalProperties: false,
            },
          ],
        },
        status_id: { type: "string", description: "Status ID." },
        status_name: { type: "string", description: "Status name." },
        archived: { type: "boolean", description: "Archived flag." },
        timeframe: {
          type: "object",
          description: "Initiative timeframe.",
          properties: {
            startDate: { type: "string" },
            endDate: { type: "string" },
            granularity: {
              type: "string",
              enum: ["year", "quarter", "month", "day"],
            },
          },
          additionalProperties: false,
        },
        start_date: { type: "string", description: "Alias for timeframe.startDate." },
        end_date: { type: "string", description: "Alias for timeframe.endDate." },
        granularity: {
          type: "string",
          description: "Alias for timeframe.granularity.",
          enum: ["year", "quarter", "month", "day"],
        },
      },
      required: ["id"],
      additionalProperties: true,
    },
  },
  {
    name: "pb_releases_list",
    description: "List Productboard releases.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of items to return.",
          minimum: 1,
          maximum: 1000,
        },
        release_group_id: { type: "string", description: "Filter by release group ID." },
        filters: {
          type: "object",
          description: "Additional raw Productboard filters.",
          additionalProperties: true,
        },
      },
      additionalProperties: true,
    },
  },
  {
    name: "pb_release_get",
    description: "Get details for a Productboard release by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Release ID." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "pb_release_create",
    description: "Create a Productboard release.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Release name." },
        description: { type: "string", description: "Release description." },
        release_group_id: { type: "string", description: "Release group ID." },
        state: {
          type: "string",
          description: "Release state.",
          enum: ["upcoming", "in-progress", "completed"],
        },
        timeframe: {
          type: "object",
          description: "Release timeframe.",
          properties: {
            startDate: { type: "string" },
            endDate: { type: "string" },
            granularity: {
              type: "string",
              enum: ["year", "quarter", "month", "day"],
            },
          },
          additionalProperties: false,
        },
        start_date: { type: "string", description: "Alias for timeframe.startDate." },
        end_date: { type: "string", description: "Alias for timeframe.endDate." },
        granularity: {
          type: "string",
          description: "Alias for timeframe.granularity.",
          enum: ["year", "quarter", "month", "day"],
        },
      },
      required: ["name", "description", "release_group_id"],
      additionalProperties: true,
    },
  },
  {
    name: "pb_release_update",
    description: "Update a Productboard release by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Release ID." },
        name: { type: "string", description: "Release name." },
        description: { type: "string", description: "Release description." },
        release_group_id: { type: "string", description: "Release group ID." },
        archived: { type: "boolean", description: "Archived flag." },
        state: {
          type: "string",
          description: "Release state.",
          enum: ["upcoming", "in-progress", "completed"],
        },
        timeframe: {
          type: "object",
          description: "Release timeframe.",
          properties: {
            startDate: { type: "string" },
            endDate: { type: "string" },
            granularity: {
              type: "string",
              enum: ["year", "quarter", "month", "day"],
            },
          },
          additionalProperties: false,
        },
        start_date: { type: "string", description: "Alias for timeframe.startDate." },
        end_date: { type: "string", description: "Alias for timeframe.endDate." },
        granularity: {
          type: "string",
          description: "Alias for timeframe.granularity.",
          enum: ["year", "quarter", "month", "day"],
        },
      },
      required: ["id"],
      additionalProperties: true,
    },
  },
  {
    name: "pb_release_groups_list",
    description: "List Productboard release groups.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of items to return.",
          minimum: 1,
          maximum: 1000,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "pb_feature_release_list",
    description: "List Productboard feature-release assignments.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of items to return.",
          minimum: 1,
          maximum: 1000,
        },
        feature_id: { type: "string", description: "Filter by feature ID." },
        release_id: { type: "string", description: "Filter by release ID." },
        release_state: {
          type: "string",
          description: "Filter by release state.",
          enum: ["upcoming", "in-progress", "completed"],
        },
        end_date_from: { type: "string", description: "Filter release endDate from." },
        end_date_to: { type: "string", description: "Filter release endDate to." },
        filters: {
          type: "object",
          description: "Additional raw Productboard filters.",
          additionalProperties: true,
        },
      },
      additionalProperties: true,
    },
  },
  {
    name: "pb_feature_release_assign",
    description: "Assign or unassign a feature to a release.",
    inputSchema: {
      type: "object",
      properties: {
        feature_id: { type: "string", description: "Feature ID." },
        release_id: { type: "string", description: "Release ID." },
        assigned: { type: "boolean", description: "True to assign, false to unassign." },
      },
      required: ["feature_id", "release_id", "assigned"],
      additionalProperties: true,
    },
  },
  {
    name: "pb_feature_objectives",
    description: "List objectives linked to a feature.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Feature ID." },
        limit: {
          type: "number",
          description: "Maximum number of items to return.",
          minimum: 1,
          maximum: 1000,
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "pb_feature_link_objective",
    description: "Link a feature to an objective.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Feature ID." },
        objective_id: { type: "string", description: "Objective ID." },
      },
      required: ["id", "objective_id"],
      additionalProperties: true,
    },
  },
  {
    name: "pb_feature_link_initiative",
    description: "Link a feature to an initiative.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Feature ID." },
        initiative_id: { type: "string", description: "Initiative ID." },
      },
      required: ["id", "initiative_id"],
      additionalProperties: true,
    },
  },
  {
    name: "pb_companies_list",
    description: "List Productboard companies.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of items to return.",
          minimum: 1,
          maximum: 1000,
        },
        term: { type: "string", description: "Search term." },
        hasNotes: { type: "string", description: "Filter companies with notes." },
        featureId: { type: "string", description: "Filter by feature ID." },
        pageCursor: { type: "string", description: "Page cursor." },
        filters: {
          type: "object",
          description: "Additional raw Productboard filters.",
          additionalProperties: true,
        },
      },
      additionalProperties: true,
    },
  },
  {
    name: "pb_users_list",
    description: "List Productboard users.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of items to return.",
          minimum: 1,
          maximum: 1000,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "pb_custom_fields_list",
    description: "List custom fields for hierarchy entities.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          description: "Custom field type(s): text, custom-description, number, dropdown, multi-dropdown, member.",
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" }, minItems: 1 },
          ],
        },
        limit: {
          type: "number",
          description: "Maximum number of items to return.",
          minimum: 1,
          maximum: 1000,
        },
      },
      required: ["type"],
      additionalProperties: false,
    },
  },
  {
    name: "pb_custom_field_value_get",
    description: "Get the value of a custom field for a hierarchy entity.",
    inputSchema: {
      type: "object",
      properties: {
        custom_field_id: { type: "string", description: "Custom field ID." },
        hierarchy_entity_id: { type: "string", description: "Hierarchy entity ID." },
      },
      required: ["custom_field_id", "hierarchy_entity_id"],
      additionalProperties: true,
    },
  },
  {
    name: "pb_user_current",
    description: "Verify Productboard connection by fetching the current user.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

const toolHandlers = {
  pb_features_list: pbFeaturesList,
  pb_feature_get: pbFeatureGet,
  pb_feature_create: pbFeatureCreate,
  pb_feature_update: pbFeatureUpdate,
  pb_feature_delete: pbFeatureDelete,
  pb_feature_statuses: pbFeatureStatuses,
  pb_components_list: pbComponentsList,
  pb_notes_list: pbNotesList,
  pb_note_get: pbNoteGet,
  pb_note_create: pbNoteCreate,
  pb_note_update: pbNoteUpdate,
  pb_note_link: pbNoteLink,
  pb_products_list: pbProductsList,
  pb_objectives_list: pbObjectivesList,
  pb_objective_get: pbObjectiveGet,
  pb_objective_create: pbObjectiveCreate,
  pb_objective_update: pbObjectiveUpdate,
  pb_key_results_list: pbKeyResultsList,
  pb_key_result_get: pbKeyResultGet,
  pb_key_result_create: pbKeyResultCreate,
  pb_key_result_update: pbKeyResultUpdate,
  pb_initiatives_list: pbInitiativesList,
  pb_initiative_get: pbInitiativeGet,
  pb_initiative_create: pbInitiativeCreate,
  pb_initiative_update: pbInitiativeUpdate,
  pb_releases_list: pbReleasesList,
  pb_release_get: pbReleaseGet,
  pb_release_create: pbReleaseCreate,
  pb_release_update: pbReleaseUpdate,
  pb_release_groups_list: pbReleaseGroupsList,
  pb_feature_release_list: pbFeatureReleaseList,
  pb_feature_release_assign: pbFeatureReleaseAssign,
  pb_feature_objectives: pbFeatureObjectives,
  pb_feature_link_objective: pbFeatureLinkObjective,
  pb_feature_link_initiative: pbFeatureLinkInitiative,
  pb_companies_list: pbCompaniesList,
  pb_users_list: pbUsersList,
  pb_custom_fields_list: pbCustomFieldsList,
  pb_custom_field_value_get: pbCustomFieldValueGet,
  pb_user_current: pbUserCurrent,
};

const server = new Server(
  {
    name: SERVER_NAME,
    version: SERVER_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request?.params?.name;
  const toolArgs = request?.params?.arguments ?? {};

  const handler = toolHandlers[toolName];
  if (!handler) {
    return asErrorResult(new ProductboardApiError(`Unknown tool: ${toolName}`, { status: 400 }));
  }

  try {
    const result = await handler(toolArgs);
    return asJsonResult(result);
  } catch (error) {
    logError(`Tool execution failed: ${toolName}`, error);
    return asErrorResult(error);
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[${SERVER_NAME}] MCP server running.`);
}

main().catch((error) => {
  logError("Fatal startup error", error);
  process.exit(1);
});
