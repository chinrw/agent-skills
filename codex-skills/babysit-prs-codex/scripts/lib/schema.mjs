/**
 * Dependency-free JSON Schema validator (draft-07 subset).
 *
 * The skill runs from `~/.claude/skills` with no `node_modules`, so this
 * implements exactly the keywords the babysit-prs schemas use. Anything a
 * schema asks for that is not implemented here raises, rather than silently
 * passing — an unenforced constraint is worse than a loud one.
 */

const SUPPORTED = new Set([
  "$schema",
  "$id",
  "$ref",
  "$comment",
  "title",
  "description",
  "definitions",
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "multipleOf",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "examples"
]);

export function validate(schema, value) {
  const errors = [];
  walk(schema, value, "$", schema, errors);
  return errors;
}

export function assertValid(schema, value, label = "value") {
  const errors = validate(schema, value);
  if (errors.length > 0) {
    const detail = errors.slice(0, 8).join("; ");
    throw new Error(`${label} failed schema validation: ${detail}`);
  }
}

function walk(schema, value, pointer, root, errors) {
  if (schema === true) {
    return;
  }
  if (schema === false) {
    errors.push(`${pointer}: schema forbids any value`);
    return;
  }
  if (!schema || typeof schema !== "object") {
    throw new Error(`Invalid schema at ${pointer}`);
  }

  for (const key of Object.keys(schema)) {
    if (!SUPPORTED.has(key)) {
      throw new Error(`Unsupported schema keyword "${key}" at ${pointer}`);
    }
  }

  if (schema.$ref) {
    walk(resolveRef(root, schema.$ref), value, pointer, root, errors);
    return;
  }

  if (schema.type !== undefined && !matchesType(schema.type, value)) {
    errors.push(`${pointer}: expected type ${JSON.stringify(schema.type)}, got ${typeName(value)}`);
    return;
  }

  if (schema.const !== undefined && !deepEqual(schema.const, value)) {
    errors.push(`${pointer}: expected const ${JSON.stringify(schema.const)}`);
  }

  if (schema.enum !== undefined && !schema.enum.some((entry) => deepEqual(entry, value))) {
    errors.push(`${pointer}: value ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }

  if (typeof value === "string") {
    checkString(schema, value, pointer, errors);
  }

  if (typeof value === "number") {
    checkNumber(schema, value, pointer, errors);
  }

  if (Array.isArray(value)) {
    checkArray(schema, value, pointer, root, errors);
  } else if (isPlainObject(value)) {
    checkObject(schema, value, pointer, root, errors);
  }

  checkCombinators(schema, value, pointer, root, errors);
}

function checkString(schema, value, pointer, errors) {
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push(`${pointer}: shorter than minLength ${schema.minLength}`);
  }
  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    errors.push(`${pointer}: longer than maxLength ${schema.maxLength}`);
  }
  if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {
    errors.push(`${pointer}: does not match pattern ${schema.pattern}`);
  }
}

function checkNumber(schema, value, pointer, errors) {
  if (schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${pointer}: below minimum ${schema.minimum}`);
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    errors.push(`${pointer}: above maximum ${schema.maximum}`);
  }
  if (schema.multipleOf !== undefined && value % schema.multipleOf !== 0) {
    errors.push(`${pointer}: not a multiple of ${schema.multipleOf}`);
  }
}

function checkArray(schema, value, pointer, root, errors) {
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    errors.push(`${pointer}: fewer than minItems ${schema.minItems}`);
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    errors.push(`${pointer}: more than maxItems ${schema.maxItems}`);
  }
  if (schema.uniqueItems === true) {
    const seen = new Set(value.map((entry) => JSON.stringify(entry)));
    if (seen.size !== value.length) {
      errors.push(`${pointer}: items are not unique`);
    }
  }
  if (schema.items !== undefined) {
    value.forEach((entry, index) => {
      walk(schema.items, entry, `${pointer}[${index}]`, root, errors);
    });
  }
}

function checkObject(schema, value, pointer, root, errors) {
  const properties = schema.properties ?? {};

  for (const name of schema.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(value, name)) {
      errors.push(`${pointer}: missing required property "${name}"`);
    }
  }

  for (const [name, child] of Object.entries(value)) {
    if (Object.prototype.hasOwnProperty.call(properties, name)) {
      walk(properties[name], child, `${pointer}.${name}`, root, errors);
      continue;
    }
    if (schema.additionalProperties === false) {
      errors.push(`${pointer}: unexpected property "${name}"`);
    } else if (isPlainObject(schema.additionalProperties)) {
      walk(schema.additionalProperties, child, `${pointer}.${name}`, root, errors);
    }
  }
}

function checkCombinators(schema, value, pointer, root, errors) {
  if (schema.allOf) {
    schema.allOf.forEach((sub, index) => walk(sub, value, `${pointer}/allOf[${index}]`, root, errors));
  }

  if (schema.anyOf) {
    const passed = schema.anyOf.some((sub) => validateSub(sub, value, root));
    if (!passed) {
      errors.push(`${pointer}: does not match any anyOf branch`);
    }
  }

  if (schema.oneOf) {
    const matches = schema.oneOf.filter((sub) => validateSub(sub, value, root)).length;
    if (matches !== 1) {
      errors.push(`${pointer}: matched ${matches} oneOf branches, expected exactly 1`);
    }
  }

  if (schema.not && validateSub(schema.not, value, root)) {
    errors.push(`${pointer}: matched a forbidden "not" schema`);
  }
}

function validateSub(schema, value, root) {
  const sub = [];
  walk(schema, value, "$", root, sub);
  return sub.length === 0;
}

function resolveRef(root, ref) {
  if (!ref.startsWith("#/")) {
    throw new Error(`Only local JSON pointers are supported, got "${ref}"`);
  }
  let node = root;
  for (const rawSegment of ref.slice(2).split("/")) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    node = node?.[segment];
    if (node === undefined) {
      throw new Error(`Unresolvable $ref "${ref}"`);
    }
  }
  return node;
}

function matchesType(type, value) {
  const types = Array.isArray(type) ? type : [type];
  return types.some((entry) => matchesSingleType(entry, value));
}

function matchesSingleType(type, value) {
  switch (type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return isPlainObject(value);
    default:
      throw new Error(`Unknown schema type "${type}"`);
  }
}

function typeName(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(a, b) {
  return JSON.stringify(normalizeForCompare(a)) === JSON.stringify(normalizeForCompare(b));
}

function normalizeForCompare(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeForCompare);
  }
  if (isPlainObject(value)) {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = normalizeForCompare(value[key]);
        return acc;
      }, {});
  }
  return value;
}
