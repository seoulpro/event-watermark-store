"use strict";

const {
  CorruptStateError,
  OperationIdConflictError,
  ProviderContractError,
} = require("./core.cjs");
const {
  createOperationFingerprint,
  stableJsonEncode,
} = require("./fingerprint.cjs");
const {
  requireKey,
  requireWellFormedUnicode,
} = require("./key.cjs");

const REDIS_SCHEMA_VERSION = "2";
const REDIS_TRANSITION_PROTOCOL = "event-watermark-store:transition:2";
const REDIS_READ_PROTOCOL = "event-watermark-store:read:2";

const REDIS_TRANSITION_SCRIPT = `
local protocol = "event-watermark-store:transition:2"
local schema = "2"
local record_key = KEYS[1]
local requested_kind = ARGV[1]
local requested_time_raw = ARGV[2]
local requested_time = tonumber(requested_time_raw)
local received_at_raw = ARGV[3]
local received_at = tonumber(received_at_raw)
local state_ttl = tonumber(ARGV[4])
local terminal_ttl = tonumber(ARGV[5])
local operation_present = ARGV[6]
local operation_id = ARGV[7]
local operation_fingerprint = ARGV[8]
local value_present = ARGV[9]
local encoded_value = ARGV[10]
local reason_present = ARGV[11]
local reason = ARGV[12]

local function type_name(reply)
  if type(reply) == "table" then
    return reply["ok"]
  end
  return reply
end

local function corrupt(detail)
  return {protocol, "corrupt", detail, "", "", ""}
end

local function finite_number(value)
  if value == nil or value ~= value
    or value == math.huge or value == -math.huge then
    return false
  end
  return true
end

if requested_kind ~= "upsert" and requested_kind ~= "terminal" then
  return redis.error_reply("invalid transition kind")
end
if not finite_number(requested_time) or not finite_number(received_at) then
  return redis.error_reply("invalid transition time")
end
if not finite_number(state_ttl) or state_ttl < 0 or math.floor(state_ttl) ~= state_ttl then
  return redis.error_reply("invalid state ttl")
end
if not finite_number(terminal_ttl) or terminal_ttl < 0 or math.floor(terminal_ttl) ~= terminal_ttl then
  return redis.error_reply("invalid terminal ttl")
end
if operation_present ~= "0" and operation_present ~= "1" then
  return redis.error_reply("invalid operation flag")
end
if operation_present == "1" then
  if operation_id == "" or string.len(operation_fingerprint) ~= 64
    or string.match(operation_fingerprint, "^[0-9a-f]+$") == nil then
    return redis.error_reply("invalid operation identity")
  end
elseif operation_id ~= "" or operation_fingerprint ~= "" then
  return redis.error_reply("unexpected operation identity")
end
if value_present ~= "0" and value_present ~= "1" then
  return redis.error_reply("invalid value flag")
end
if value_present == "0" and encoded_value ~= "" then
  return redis.error_reply("unexpected value")
end
if requested_kind == "terminal" and value_present ~= "0" then
  return redis.error_reply("terminal transition cannot carry a value")
end
if reason_present ~= "0" and reason_present ~= "1" then
  return redis.error_reply("invalid reason flag")
end
if reason_present == "0" and reason ~= "" then
  return redis.error_reply("unexpected reason")
end

local current_type = type_name(redis.call("TYPE", record_key))
if current_type ~= "none" and current_type ~= "hash" then
  return corrupt("wrong-type")
end

local exists = current_type == "hash"
local current_kind = ""
local current_time_raw = ""
local current_time = nil
local current_operation_present = "0"
local current_operation_id = ""
local current_operation_fingerprint = ""

if exists then
  local current_schema = redis.call("HGET", record_key, "schema")
  current_kind = redis.call("HGET", record_key, "kind") or ""
  current_time_raw = redis.call("HGET", record_key, "event_time") or ""
  local current_received_raw = redis.call("HGET", record_key, "received_at") or ""
  current_operation_present = redis.call("HGET", record_key, "operation_present") or ""
  current_operation_id = redis.call("HGET", record_key, "operation_id") or ""
  current_operation_fingerprint = redis.call("HGET", record_key, "operation_fingerprint") or ""
  local current_value_present = redis.call("HGET", record_key, "value_present") or ""
  local current_encoded_value = redis.call("HGET", record_key, "value") or ""
  local current_reason_present = redis.call("HGET", record_key, "reason_present") or ""
  local current_reason = redis.call("HGET", record_key, "reason") or ""
  current_time = tonumber(current_time_raw)
  local current_received = tonumber(current_received_raw)

  if current_schema ~= schema then
    return corrupt("schema")
  end
  if current_kind ~= "upsert" and current_kind ~= "terminal" then
    return corrupt("kind")
  end
  if not finite_number(current_time) or not finite_number(current_received) then
    return corrupt("time")
  end
  if current_operation_present ~= "0" and current_operation_present ~= "1" then
    return corrupt("operation-flag")
  end
  if current_operation_present == "1" and current_operation_id == "" then
    return corrupt("operation-id")
  end
  if current_operation_present == "1" then
    if string.len(current_operation_fingerprint) ~= 64
      or string.match(current_operation_fingerprint, "^[0-9a-f]+$") == nil then
      return corrupt("operation-fingerprint")
    end
  elseif current_operation_id ~= "" or current_operation_fingerprint ~= "" then
    return corrupt("unexpected-operation-identity")
  end
  if current_value_present ~= "0" and current_value_present ~= "1" then
    return corrupt("value-flag")
  end
  if current_kind == "terminal" and current_value_present ~= "0" then
    return corrupt("terminal-value")
  end
  if current_value_present == "0" and current_encoded_value ~= "" then
    return corrupt("unexpected-value")
  end
  if current_reason_present ~= "0" and current_reason_present ~= "1" then
    return corrupt("reason-flag")
  end
  if current_reason_present == "0" and current_reason ~= "" then
    return corrupt("unexpected-reason")
  end
end

if exists and operation_present == "1" and current_operation_present == "1"
  and operation_id == current_operation_id then
  if operation_fingerprint ~= current_operation_fingerprint
    or requested_kind ~= current_kind or requested_time ~= current_time then
    return {protocol, "operation-conflict", current_kind, current_time_raw, current_kind, current_time_raw}
  end
  return {protocol, "replayed", current_kind, current_time_raw, current_kind, current_time_raw}
end

if exists and current_kind == "terminal" and requested_time <= current_time then
  return {protocol, "blocked-by-terminal", current_kind, current_time_raw, current_kind, current_time_raw}
end
if exists and requested_time < current_time then
  return {protocol, "stale", current_kind, current_time_raw, current_kind, current_time_raw}
end

local outcome = "applied"
if exists and current_kind == "upsert" and requested_kind == "upsert"
  and requested_time == current_time then
  outcome = "refreshed"
end

local before_kind = current_kind
local before_time_raw = current_time_raw
redis.call("DEL", record_key)
redis.call(
  "HSET",
  record_key,
  "schema", schema,
  "kind", requested_kind,
  "event_time", requested_time_raw,
  "received_at", received_at_raw,
  "operation_present", operation_present,
  "operation_id", operation_id,
  "operation_fingerprint", operation_fingerprint,
  "value_present", value_present,
  "value", encoded_value,
  "reason_present", reason_present,
  "reason", reason
)

local ttl = state_ttl
if requested_kind == "terminal" then
  ttl = terminal_ttl
end
if ttl == 0 then
  redis.call("PERSIST", record_key)
else
  redis.call("EXPIRE", record_key, ttl)
end

return {protocol, outcome, before_kind, before_time_raw, requested_kind, requested_time_raw}
`;

const REDIS_READ_SCRIPT = `
local protocol = "event-watermark-store:read:2"
local schema = "2"
local record_key = KEYS[1]

local function type_name(reply)
  if type(reply) == "table" then
    return reply["ok"]
  end
  return reply
end

local function corrupt(detail)
  return {protocol, "corrupt", detail}
end

local function finite_number(value)
  if value == nil or value ~= value
    or value == math.huge or value == -math.huge then
    return false
  end
  return true
end

local current_type = type_name(redis.call("TYPE", record_key))
if current_type == "none" then
  return {protocol, "missing"}
end
if current_type ~= "hash" then
  return corrupt("wrong-type")
end

local current_schema = redis.call("HGET", record_key, "schema")
local kind = redis.call("HGET", record_key, "kind") or ""
local event_time_raw = redis.call("HGET", record_key, "event_time") or ""
local received_at_raw = redis.call("HGET", record_key, "received_at") or ""
local operation_present = redis.call("HGET", record_key, "operation_present") or ""
local operation_id = redis.call("HGET", record_key, "operation_id") or ""
local operation_fingerprint = redis.call("HGET", record_key, "operation_fingerprint") or ""
local value_present = redis.call("HGET", record_key, "value_present") or ""
local encoded_value = redis.call("HGET", record_key, "value") or ""
local reason_present = redis.call("HGET", record_key, "reason_present") or ""
local reason = redis.call("HGET", record_key, "reason") or ""

if current_schema ~= schema then
  return corrupt("schema")
end
if kind ~= "upsert" and kind ~= "terminal" then
  return corrupt("kind")
end
local event_time = tonumber(event_time_raw)
local received_at = tonumber(received_at_raw)
if not finite_number(event_time) or not finite_number(received_at) then
  return corrupt("time")
end
if operation_present ~= "0" and operation_present ~= "1" then
  return corrupt("operation-flag")
end
if operation_present == "1" and operation_id == "" then
  return corrupt("operation-id")
end
if operation_present == "1" then
  if string.len(operation_fingerprint) ~= 64
    or string.match(operation_fingerprint, "^[0-9a-f]+$") == nil then
    return corrupt("operation-fingerprint")
  end
elseif operation_id ~= "" or operation_fingerprint ~= "" then
  return corrupt("unexpected-operation-identity")
end
if value_present ~= "0" and value_present ~= "1" then
  return corrupt("value-flag")
end
if kind == "terminal" and value_present ~= "0" then
  return corrupt("terminal-value")
end
if value_present == "0" and encoded_value ~= "" then
  return corrupt("unexpected-value")
end
if reason_present ~= "0" and reason_present ~= "1" then
  return corrupt("reason-flag")
end
if reason_present == "0" and reason ~= "" then
  return corrupt("unexpected-reason")
end

return {
  protocol,
  "ok",
  kind,
  event_time_raw,
  received_at_raw,
  operation_present,
  operation_id,
  value_present,
  encoded_value,
  reason_present,
  reason
}
`;

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const normalizeTtlSeconds = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
};

const requireExecutor = (execute) => {
  if (typeof execute !== "function") throw new TypeError("execute must be a function");
  return execute;
};

const requirePrefix = (prefix) => {
  if (typeof prefix !== "string") throw new TypeError("prefix must be a string");
  requireWellFormedUnicode(prefix, "prefix");
  if (prefix.includes("{") || prefix.includes("}")) {
    throw new TypeError("prefix cannot contain Redis hash-tag braces");
  }
  return prefix;
};

const toText = (value, label) => {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString("utf8");
  }
  throw new ProviderContractError(`${label} must be a Redis string reply`);
};

const toArray = (value, label) => {
  if (!Array.isArray(value)) throw new ProviderContractError(`${label} must be an array reply`);
  return value;
};

const parseFinite = (value, label) => {
  const text = toText(value, label);
  if (text.length === 0) throw new ProviderContractError(`${label} cannot be empty`);
  const number = Number(text);
  if (!Number.isFinite(number)) throw new ProviderContractError(`${label} must be finite`);
  return number;
};

const parseWatermark = (kindValue, timeValue, label) => {
  const kind = toText(kindValue, `${label}.kind`);
  const timeText = toText(timeValue, `${label}.eventTime`);
  if (kind === "" && timeText === "") return null;
  if (kind !== "upsert" && kind !== "terminal") {
    throw new ProviderContractError(`${label}.kind is invalid`);
  }
  return Object.freeze({ kind, eventTime: parseFinite(timeText, `${label}.eventTime`) });
};

const defaultEncode = (value) => {
  const encoded = stableJsonEncode(value);
  if (typeof encoded !== "string") {
    throw new TypeError("value must be JSON-encodable or a custom encode function must be provided");
  }
  return encoded;
};

const defaultDecode = (value) => JSON.parse(value);

const createIoRedisExecutor = (client) => {
  if (!client || typeof client.eval !== "function") {
    throw new TypeError("client.eval must be a function");
  }
  return async ({ script, keys, arguments: args }) =>
    client.eval(script, keys.length, ...keys, ...args);
};

const createNodeRedisExecutor = (client) => {
  if (!client || typeof client.eval !== "function") {
    throw new TypeError("client.eval must be a function");
  }
  return async ({ script, keys, arguments: args }) =>
    client.eval(script, { keys: [...keys], arguments: [...args] });
};

const createRedisEventWatermarkProvider = ({
  execute,
  prefix = "event-watermark:",
  stateTtlSeconds = 300,
  terminalTtlSeconds = 7 * 24 * 60 * 60,
  encode = defaultEncode,
  decode = defaultDecode,
} = {}) => {
  const run = requireExecutor(execute);
  const normalizedPrefix = requirePrefix(prefix);
  const stateTtl = normalizeTtlSeconds(stateTtlSeconds, "stateTtlSeconds");
  const terminalTtl = normalizeTtlSeconds(terminalTtlSeconds, "terminalTtlSeconds");
  if (typeof encode !== "function") throw new TypeError("encode must be a function");
  if (typeof decode !== "function") throw new TypeError("decode must be a function");

  const keyFor = (key) => {
    const encodedKey = Buffer.from(requireKey(key), "utf8").toString("base64url");
    return `${normalizedPrefix}{${encodedKey}}:record`;
  };

  const transition = async (command) => {
    if (command.operationId !== undefined) {
      requireWellFormedUnicode(command.operationId, "operationId");
    }
    if (command.reason !== undefined) {
      requireWellFormedUnicode(command.reason, "reason");
    }
    let encodedValue = "";
    if (command.kind === "upsert" && command.valuePresent) {
      encodedValue = encode(command.value);
      if (typeof encodedValue !== "string") {
        throw new TypeError("encode must return a string");
      }
      requireWellFormedUnicode(encodedValue, "encode result");
    }
    const operationFingerprint =
      command.operationId === undefined
        ? ""
        : createOperationFingerprint(command, encodedValue);

    const response = toArray(
      await run({
        script: REDIS_TRANSITION_SCRIPT,
        keys: [keyFor(command.key)],
        arguments: [
          command.kind,
          String(command.eventTime),
          String(command.receivedAt),
          String(stateTtl),
          String(terminalTtl),
          command.operationId === undefined ? "0" : "1",
          command.operationId ?? "",
          operationFingerprint,
          command.kind === "upsert" && command.valuePresent ? "1" : "0",
          encodedValue,
          command.reason === undefined ? "0" : "1",
          command.reason ?? "",
        ],
      }),
      "transition response"
    );

    if (toText(response[0], "transition protocol") !== REDIS_TRANSITION_PROTOCOL) {
      throw new ProviderContractError("Unsupported Redis transition protocol");
    }
    const status = toText(response[1], "transition status");
    if (status === "corrupt") {
      throw new CorruptStateError(command.key, toText(response[2], "corruption detail"));
    }
    if (status === "operation-conflict") {
      throw new OperationIdConflictError(command.key, command.operationId);
    }
    if (
      status !== "applied" &&
      status !== "refreshed" &&
      status !== "replayed" &&
      status !== "stale" &&
      status !== "blocked-by-terminal"
    ) {
      throw new ProviderContractError(`Unsupported Redis transition status: ${status}`);
    }

    const previous = parseWatermark(response[2], response[3], "previous");
    const current = parseWatermark(response[4], response[5], "current");
    if (current === null) throw new ProviderContractError("Redis transition omitted current watermark");
    const accepted = status === "applied" || status === "refreshed" || status === "replayed";
    const changed = status === "applied" || status === "refreshed";
    return Object.freeze({ status, accepted, changed, previous, current });
  };

  const get = async (key) => {
    const response = toArray(
      await run({
        script: REDIS_READ_SCRIPT,
        keys: [keyFor(key)],
        arguments: [],
      }),
      "read response"
    );
    if (toText(response[0], "read protocol") !== REDIS_READ_PROTOCOL) {
      throw new ProviderContractError("Unsupported Redis read protocol");
    }
    const status = toText(response[1], "read status");
    if (status === "missing") return null;
    if (status === "corrupt") {
      throw new CorruptStateError(key, toText(response[2], "corruption detail"));
    }
    if (status !== "ok") throw new ProviderContractError(`Unsupported Redis read status: ${status}`);

    const kind = toText(response[2], "record.kind");
    if (kind !== "upsert" && kind !== "terminal") {
      throw new ProviderContractError("record.kind is invalid");
    }
    const record = {
      kind,
      eventTime: parseFinite(response[3], "record.eventTime"),
      receivedAt: parseFinite(response[4], "record.receivedAt"),
    };

    const operationPresent = toText(response[5], "record.operationPresent");
    const operationId = requireWellFormedUnicode(
      toText(response[6], "record.operationId"),
      "record.operationId",
    );
    if (operationPresent === "1") {
      if (!operationId) throw new ProviderContractError("record.operationId cannot be empty");
      record.operationId = operationId;
    } else if (operationPresent !== "0") {
      throw new ProviderContractError("record.operationPresent is invalid");
    } else if (operationId !== "") {
      throw new ProviderContractError("record.operationId must be empty when absent");
    }

    const valuePresent = toText(response[7], "record.valuePresent");
    const encodedValue = toText(response[8], "record.value");
    if (valuePresent === "1") {
      if (kind === "terminal") throw new ProviderContractError("terminal record cannot carry a value");
      record.value = decode(encodedValue);
    } else if (valuePresent !== "0") {
      throw new ProviderContractError("record.valuePresent is invalid");
    } else if (encodedValue !== "") {
      throw new ProviderContractError("record.value must be empty when absent");
    }

    const reasonPresent = toText(response[9], "record.reasonPresent");
    const reason = requireWellFormedUnicode(
      toText(response[10], "record.reason"),
      "record.reason",
    );
    if (reasonPresent === "1") {
      record.reason = reason;
    } else if (reasonPresent !== "0") {
      throw new ProviderContractError("record.reasonPresent is invalid");
    } else if (reason !== "") {
      throw new ProviderContractError("record.reason must be empty when absent");
    }
    return Object.freeze(record);
  };

  return Object.freeze({ transition, get, keyFor });
};

module.exports = {
  REDIS_SCHEMA_VERSION,
  REDIS_TRANSITION_PROTOCOL,
  REDIS_READ_PROTOCOL,
  REDIS_TRANSITION_SCRIPT,
  REDIS_READ_SCRIPT,
  createIoRedisExecutor,
  createNodeRedisExecutor,
  createRedisEventWatermarkProvider,
};
