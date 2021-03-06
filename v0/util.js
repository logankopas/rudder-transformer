/* eslint-disable radix */
const fs = require("fs");
const path = require("path");
const _ = require("lodash");
const set = require("set-value");
const get = require("get-value");

const fixIP = (payload, message, key) => {
  payload[key] = message.context
    ? message.context.ip
      ? message.context.ip
      : message.request_ip
    : message.request_ip;
};

const getMappingConfig = (config, dir) => {
  const mappingConfig = {};
  const categoryKeys = Object.keys(config);
  categoryKeys.forEach(categoryKey => {
    const category = config[categoryKey];
    mappingConfig[category.name] = JSON.parse(
      fs.readFileSync(path.resolve(dir, `./data/${category.name}.json`))
    );
  });
  return mappingConfig;
};

const isDefined = x => !_.isUndefined(x);
const isNotNull = x => x != null;
const isDefinedAndNotNull = x => isDefined(x) && isNotNull(x);

const toStringValues = obj => {
  Object.keys(obj).forEach(key => {
    if (typeof obj[key] === "object") {
      return toString(obj[key]);
    }

    obj[key] = "" + obj[key];
  });

  return obj;
};

const getDateInFormat = date => {
  var x = new Date(date);
  var y = x.getFullYear().toString();
  var m = (x.getMonth() + 1).toString();
  var d = x.getDate().toString();
  d.length == 1 && (d = "0" + d);
  m.length == 1 && (m = "0" + m);
  var yyyymmdd = y + m + d;
  return yyyymmdd;
};

const removeUndefinedValues = obj => _.pickBy(obj, isDefined);
const removeNullValues = obj => _.pickBy(obj, isNotNull);
const removeUndefinedAndNullValues = obj => _.pickBy(obj, isDefinedAndNotNull);

const updatePayload = (currentKey, eventMappingArr, value, payload) => {
  eventMappingArr.map(obj => {
    if (obj.rudderKey === currentKey) {
      set(payload, obj.expectedKey, value);
    }
  });
  return payload;
};

const toSnakeCase = str => {
  if (!str) return "";
  return String(str)
    .replace(/^[^A-Za-z0-9]*|[^A-Za-z0-9]*$/g, "")
    .replace(/([a-z])([A-Z])/g, (m, a, b) => a + "_" + b.toLowerCase())
    .replace(/[^A-Za-z0-9]+|_+/g, "_")
    .toLowerCase();
};

const isObject = value => {
  var type = typeof value;
  return value != null && (type == "object" || type == "function");
};

const defaultGetRequestConfig = {
  requestFormat: "PARAMS",
  requestMethod: "GET"
};

const defaultPostRequestConfig = {
  requestFormat: "JSON",
  requestMethod: "POST"
};

const defaultDeleteRequestConfig = {
  requestFormat: "JSON",
  requestMethod: "DELETE"
};
const defaultPutRequestConfig = {
  requestFormat: "JSON",
  requestMethod: "PUT"
};

const defaultRequestConfig = () => {
  return {
    version: "1",
    type: "REST",
    method: "POST",
    endpoint: "",
    headers: {},
    params: {},
    body: {
      JSON: {},
      XML: {},
      FORM: {}
    },
    files: {}
  };
};

// Start of warehouse specific utils

const toSafeDBString = str => {
  if (parseInt(str[0]) > 0) str = `_${str}`;
  str = str.replace(/[^a-zA-Z0-9_]+/g, "");
  return str.substr(0, 127);
};

// https://www.myintervals.com/blog/2009/05/20/iso-8601-date-validation-that-doesnt-suck/
// make sure to disable prettier for regex expression
// prettier-ignore
const timestampRegex = new RegExp(
  // eslint-disable-next-line no-useless-escape
  /^([\+-]?\d{4})((-)((0[1-9]|1[0-2])(-([12]\d|0[1-9]|3[01])))([T\s]((([01]\d|2[0-3])((:)[0-5]\d))([\:]\d+)?)?(:[0-5]\d([\.]\d+)?)?([zZ]|([\+-])([01]\d|2[0-3]):?([0-5]\d)?)?)?)$/
);

function validTimestamp(input) {
  return timestampRegex.test(input);
}

// // older implementation with fallback to new Date()
// function validTimestamp(input) {
//   // eslint-disable-next-line no-restricted-globals
//   if (!isNaN(input)) return false;
//   return new Date(input).getTime() > 0;
// }

const getDataType = val => {
  const type = typeof val;
  switch (type) {
    case "number":
      return Number.isInteger(val) ? "int" : "float";
    case "boolean":
      return "boolean";
    default:
      break;
  }
  if (validTimestamp(val)) {
    return "datetime";
  }
  return "string";
};

function setFromConfig(resp, input, configJson, columnTypes) {
  Object.keys(configJson).forEach(key => {
    let val = get(input, key);
    if (val !== undefined) {
      datatype = getDataType(val);
      if (datatype === "datetime") {
        val = new Date(val).toISOString();
      }
      const prop = configJson[key];
      resp[prop] = val;
      columnTypes[prop] = datatype;
    }
  });
}

function setFromProperties(resp, input, columnTypes, prefix = "") {
  if (!input) return;
  Object.keys(input).forEach(key => {
    if (isObject(input[key])) {
      setFromProperties(resp, input[key], columnTypes, `${prefix + key}_`);
    } else {
      let val = input[key];
      datatype = getDataType(val);
      if (datatype === "datetime") {
        val = new Date(val).toISOString();
      }
      const safeKey = toSafeDBString(prefix + key);
      resp[safeKey] = val;
      columnTypes[safeKey] = datatype;
    }
  });
}

function getColumns(obj, columnTypes) {
  const columns = { uuid_ts: "datetime" };
  Object.keys(obj).forEach(key => {
    columns[toSafeDBString(key)] =
      columnTypes[obj[key]] || getDataType(obj[key]);
  });
  return columns;
}

function processWarehouseMessage(
  message,
  whDefaultConfigJson,
  whTrackConfigJson
) {
  const responses = [];
  const eventType = message.type.toLowerCase();
  // store columnTypes as each column is set, so as not to call getDataType again
  const columnTypes = {};
  switch (eventType) {
    case "track": {
      tracksEvent = {};
      setFromConfig(tracksEvent, message, whDefaultConfigJson, columnTypes);
      setFromProperties(tracksEvent, message.context, columnTypes, "context_");
      setFromConfig(tracksEvent, message, whTrackConfigJson, columnTypes);

      tracksEvent.event = toSnakeCase(tracksEvent.event_text);
      columnTypes.event = "string";

      trackEvent = { ...tracksEvent };
      setFromProperties(trackEvent, message.properties, columnTypes, "");
      setFromProperties(trackEvent, message.userProperties, columnTypes, "");

      const tracksMetadata = {
        table: "tracks",
        columns: getColumns(tracksEvent, columnTypes)
      };
      responses.push({ metadata: tracksMetadata, data: tracksEvent });

      const trackEventMetadata = {
        table: toSafeDBString(trackEvent.event),
        columns: getColumns(trackEvent, columnTypes)
      };
      responses.push({ metadata: trackEventMetadata, data: trackEvent });
      break;
    }
    case "identify": {
      const event = {};
      setFromProperties(event, message.context.traits, columnTypes, "");
      setFromProperties(event, message.context, columnTypes, "context_");
      const usersEvent = { ...event };
      const identifiesEvent = { ...event };

      usersEvent.id = message.userId;
      usersEvent.received_at = message.receivedAt;
      setFromConfig(identifiesEvent, message, whDefaultConfigJson, columnTypes);

      const identifiesMetadata = {
        table: "identifies",
        columns: getColumns(identifiesEvent, columnTypes)
      };
      responses.push({ metadata: identifiesMetadata, data: identifiesEvent });

      const usersMetadata = {
        table: "users",
        columns: getColumns(usersEvent, columnTypes)
      };
      responses.push({ metadata: usersMetadata, data: usersEvent });
      break;
    }
    case "page":
    case "screen": {
      const event = {};
      setFromConfig(event, message, whDefaultConfigJson, columnTypes);
      setFromProperties(event, message.context, columnTypes, "context_");
      setFromProperties(event, message.properties, columnTypes, columnTypes);
      const metadata = {
        table: `${eventType}s`,
        columns: getColumns(event, columnTypes)
      };
      responses.push({ metadata, data: event });
      break;
    }
    default:
      throw new Error("Unknown event type", eventType);
  }
  return responses;
}

// End of warehouse specific utils

module.exports = {
  getMappingConfig,
  toStringValues,
  getDateInFormat,
  removeUndefinedValues,
  removeNullValues,
  removeUndefinedAndNullValues,
  isObject,
  toSnakeCase,
  setFromConfig,
  setFromProperties,
  getColumns,
  toSafeDBString,
  validTimestamp,
  getDataType,
  processWarehouseMessage,
  defaultGetRequestConfig,
  defaultPostRequestConfig,
  defaultDeleteRequestConfig,
  defaultPutRequestConfig,
  updatePayload,
  defaultRequestConfig,
  fixIP
};
