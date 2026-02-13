#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const SERVER_NAME = "productboard-connector";
const SERVER_VERSION = "1.0.0";
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

const tools = [
  {
    name: "pb_features_list",
    description: "List Productboard features with optional filters and pagination.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", minimum: 1, maximum: 1000 },
        status_id: { type: "string" },
        status_name: { type: "string" },
        parent_id: { type: "string" },
        product_id: { type: "string" },
        owner_email: { type: "string" },
        note_id: { type: "string" },
        archived: { type: "boolean" },
        filters: { type: "object", additionalProperties: true },
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
        id: { type: "string", description: "Feature ID" },
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
        name: { type: "string" },
        description: { type: "string" },
        type: { type: "string", enum: ["feature", "subfeature"] },
        status: {
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
        status_id: { type: "string" },
        status_name: { type: "string" },
        product_id: { type: "string" },
        component_id: { type: "string" },
        parent_feature_id: { type: "string" },
        owner_email: { type: "string" },
        archived: { type: "boolean" },
        timeframe: {
          type: "object",
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
        id: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        status: {
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
        status_id: { type: "string" },
        status_name: { type: "string" },
        product_id: { type: "string" },
        component_id: { type: "string" },
        parent_feature_id: { type: "string" },
        owner_email: { type: "string" },
        archived: { type: "boolean" },
        timeframe: {
          type: "object",
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
    name: "pb_notes_list",
    description: "List Productboard notes with optional filters and pagination.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", minimum: 1, maximum: 1000 },
        term: { type: "string" },
        featureId: { type: "string" },
        companyId: { type: "string" },
        ownerEmail: { type: "string" },
        source: { type: "string" },
        anyTag: { type: "string" },
        allTags: { type: "string" },
        dateFrom: { type: "string" },
        dateTo: { type: "string" },
        createdFrom: { type: "string" },
        createdTo: { type: "string" },
        updatedFrom: { type: "string" },
        updatedTo: { type: "string" },
        pageCursor: { type: "string" },
        filters: { type: "object", additionalProperties: true },
      },
      additionalProperties: true,
    },
  },
  {
    name: "pb_note_create",
    description: "Create a Productboard note.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        content: { type: "string" },
        tags: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
        user_email: { type: "string" },
      },
      required: ["title", "content"],
      additionalProperties: true,
    },
  },
  {
    name: "pb_products_list",
    description: "List Productboard products.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", minimum: 1, maximum: 1000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "pb_releases_list",
    description: "List Productboard releases.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", minimum: 1, maximum: 1000 },
        release_group_id: { type: "string" },
        filters: { type: "object", additionalProperties: true },
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
        id: { type: "string" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "pb_companies_list",
    description: "List Productboard companies.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", minimum: 1, maximum: 1000 },
        term: { type: "string" },
        hasNotes: { type: "string" },
        featureId: { type: "string" },
        pageCursor: { type: "string" },
        filters: { type: "object", additionalProperties: true },
      },
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
  pb_notes_list: pbNotesList,
  pb_note_create: pbNoteCreate,
  pb_products_list: pbProductsList,
  pb_releases_list: pbReleasesList,
  pb_release_get: pbReleaseGet,
  pb_companies_list: pbCompaniesList,
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
