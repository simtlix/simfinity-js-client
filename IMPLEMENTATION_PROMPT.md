# Implementation Prompt: Missing Features in simfinity-js-client

This document is a detailed, actionable implementation prompt for adding the missing features to `@simtlix/simfinity-js-client` so it can fully replace the direct introspection, query building, mutation construction, and data transformation logic currently embedded in `simfinity-fe-package`.

All changes target `src/SimfinityClient.js`. The current file is 665 lines.

---

## Table of Contents

1. [Feature 1: Simfinity Extensions in Introspection](#feature-1-simfinity-extensions-in-introspection)
2. [Feature 2: Validated Scalar Type Utilities](#feature-2-validated-scalar-type-utilities)
3. [Feature 3: Schema Metadata Access API](#feature-3-schema-metadata-access-api)
4. [Feature 4: Automatic Selection Set Building](#feature-4-automatic-selection-set-building)
5. [Feature 5: Entity & Query Name Resolution](#feature-5-entity--query-name-resolution)
6. [Feature 6: Mutation Input Transformation](#feature-6-mutation-input-transformation)
7. [Feature 7: Collection Delta Mutations](#feature-7-collection-delta-mutations)
8. [Feature 8: Collection Item Queries (findByParent)](#feature-8-collection-item-queries-findbyparent)
9. [Feature 9: FK/Relation Search Queries](#feature-9-fkrelation-search-queries)
10. [Feature 10: State Machine Metadata](#feature-10-state-machine-metadata)
11. [Feature 11: Response Extensions (Pagination Count)](#feature-11-response-extensions-pagination-count)
12. [Summary of New Public API Methods](#summary-of-new-public-api-methods)

---

## Feature 1: Simfinity Extensions in Introspection

### What to change

The `INTROSPECTION_QUERY` constant (lines 3-41) must be updated to fetch Simfinity-specific field extensions and support deeper type nesting.

### Current introspection query (problematic parts)

```graphql
fields {
  name
  type {
    name kind
    ofType {
      name kind
      ofType {
        name kind
        ofType { name kind }           # Only 3 levels deep
      }
    }
  }
  args { ... }
  # NO extensions block
}
```

### Required introspection query

Replace the entire `INTROSPECTION_QUERY` with:

```graphql
query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    types {
      name
      kind
      fields {
        name
        type {
          kind name
          ofType {
            kind name
            ofType {
              kind name
              ofType {
                kind name
                ofType {              # 4th level added
                  kind name
                }
              }
            }
          }
        }
        args {
          name
          type {
            kind name
            ofType {
              kind name
              ofType {
                kind name
                ofType {
                  kind name
                  ofType {            # 4th level added for args too
                    kind name
                  }
                }
              }
            }
          }
        }
        extensions {
          relation {
            displayField
            embedded
            connectionField
          }
          stateMachine
          readOnly
        }
      }
      enumValues { name }
    }
  }
}
```

### Changes to `_buildTypesRegistry` (lines 355-374)

Update the field mapping to include extension data:

```javascript
_buildTypesRegistry(types) {
  for (const type of types) {
    if (type.name.startsWith('__')) continue;
    const validKinds = ['OBJECT', 'ENUM', 'SCALAR', 'INPUT_OBJECT'];
    if (!validKinds.includes(type.kind)) continue;

    const typeInfo = {
      name: type.name,
      kind: type.kind,
      fields: (type.fields || []).map(f => ({
        name: f.name,
        type: unwrapType(f.type),
        rawType: f.type,
        args: (f.args || []).map(a => ({ name: a.name, type: a.type })),
        extensions: f.extensions || null,          // NEW: store extensions
      })),
      enumValues: (type.enumValues || []).map(v => v.name),
    };
    this._types.set(type.name, typeInfo);
  }
}
```

Each field's `extensions` object has this shape:

```javascript
{
  relation: {
    displayField: string | null,   // e.g. "name", "title"
    embedded: boolean | null,      // true = inline object, false/null = FK reference
    connectionField: string | null // e.g. "serie" (back-reference field in child)
  } | null,
  stateMachine: boolean | null,    // true = field is state-machine managed
  readOnly: boolean | null         // true = field cannot be modified
}
```

---

## Feature 2: Validated Scalar Type Utilities

### Context

Simfinity uses validated scalar names with a convention like `SeasonNumber_Int`, `EpisodeDate_Date`, `StartDate_DateTime`. The suffix after the last `_` indicates the base GraphQL scalar type. All type-detection utilities must strip this prefix before checking.

### New utility functions (add at module level, near `unwrapType`)

```javascript
function getActualScalarType(name) {
  if (!name) return null;
  return name.includes('_') ? name.split('_').pop() || name : name;
}

function isNumericScalar(name) {
  if (!name) return false;
  const actual = getActualScalarType(name);
  if (!actual) return false;
  const n = actual.toLowerCase();
  return n === 'int' || n === 'float' || n === 'idnumber';
}

function isBooleanScalar(name) {
  if (!name) return false;
  const actual = getActualScalarType(name);
  if (!actual) return false;
  return actual.toLowerCase() === 'boolean';
}

function isDateTimeScalar(name) {
  if (!name) return false;
  const actual = getActualScalarType(name);
  if (!actual) return false;
  const n = actual.toLowerCase();
  return n === 'date' || n === 'datetime' || n === 'timestamp'
    || n === 'isodate' || n === 'graphqldate' || n === 'graphqldatetime';
}

function isScalarOrEnum(kind) {
  return kind === 'SCALAR' || kind === 'ENUM';
}

function isListType(rawType) {
  let current = rawType;
  while (current) {
    if (current.kind === 'LIST') return true;
    current = current.ofType || null;
  }
  return false;
}
```

### Public API on SimfinityClient

Expose as instance methods that delegate to the module-level functions:

```javascript
getActualScalarType(scalarName) { return getActualScalarType(scalarName); }
isNumericScalar(scalarName) { return isNumericScalar(scalarName); }
isBooleanScalar(scalarName) { return isBooleanScalar(scalarName); }
isDateTimeScalar(scalarName) { return isDateTimeScalar(scalarName); }
```

---

## Feature 3: Schema Metadata Access API

### New public methods on `SimfinityClient`

Each method uses `this._types` and `this._ensureInitialized()`.

```javascript
getFieldExtensions(typeName, fieldName) {
  this._ensureInitialized();
  const typeInfo = this._types.get(typeName);
  if (!typeInfo) return null;
  const field = typeInfo.fields.find(f => f.name === fieldName);
  return field?.extensions || null;
}

getDisplayField(typeName, fieldName) {
  this._ensureInitialized();
  const ext = this.getFieldExtensions(typeName, fieldName);
  const displayField = ext?.relation?.displayField;
  if (displayField) return displayField;

  // Fallback: get the field's object type, look for 'name', then first scalar
  const typeInfo = this._types.get(typeName);
  const field = typeInfo?.fields.find(f => f.name === fieldName);
  if (!field || field.type.kind !== 'OBJECT') return null;

  const objectType = this._types.get(field.type.name);
  if (!objectType?.fields) return null;

  const objFieldNames = objectType.fields.map(f => f.name);
  if (objFieldNames.includes('name')) return 'name';

  const firstScalar = objectType.fields.find(f =>
    isScalarOrEnum(f.type.kind) && !f.type.isList
  );
  return firstScalar?.name || null;
}

isEmbeddedField(typeName, fieldName) {
  this._ensureInitialized();
  const ext = this.getFieldExtensions(typeName, fieldName);
  return ext?.relation?.embedded === true;
}

getConnectionField(typeName, fieldName) {
  this._ensureInitialized();
  const ext = this.getFieldExtensions(typeName, fieldName);
  return ext?.relation?.connectionField || null;
}

isStateMachineField(typeName, fieldName) {
  this._ensureInitialized();
  const ext = this.getFieldExtensions(typeName, fieldName);
  return ext?.stateMachine === true;
}

isReadOnlyField(typeName, fieldName) {
  this._ensureInitialized();
  const ext = this.getFieldExtensions(typeName, fieldName);
  return ext?.readOnly === true;
}

getEnumValues(typeName) {
  this._ensureInitialized();
  const typeInfo = this._types.get(typeName);
  if (!typeInfo || typeInfo.kind !== 'ENUM') return [];
  return typeInfo.enumValues || [];
}

getFieldsOfType(typeName) {
  this._ensureInitialized();
  const typeInfo = this._types.get(typeName);
  if (!typeInfo) return [];
  return typeInfo.fields;
}

getDescriptionFieldType(typeName, descriptionField) {
  this._ensureInitialized();
  const typeInfo = this._types.get(typeName);
  if (!typeInfo?.fields) return 'String';
  const field = typeInfo.fields.find(f => f.name === descriptionField);
  if (!field) return 'String';
  return field.type.name || 'String';
}
```

---

## Feature 4: Automatic Selection Set Building

### Context

The FE package's `buildSelectionSetForObjectType()` in `src/lib/introspection.ts` (lines 190-311) builds a complete GraphQL selection set string plus metadata (columns, sort mappings, field type info) by walking the schema fields of an object type. The client needs an equivalent.

### New public method: `buildSelectionSet(typeName)`

```javascript
buildSelectionSet(typeName) {
  this._ensureInitialized();
  const typeInfo = this._types.get(typeName);
  if (!typeInfo?.fields) {
    return { selection: 'id', columns: ['id'], sortFieldByColumn: {}, fieldTypeByColumn: {} };
  }

  const columns = [];
  const sortFieldByColumn = {};
  const fieldTypeByColumn = {};
  const fieldSelections = [];

  for (const field of typeInfo.fields) {
    const { name, type: unwrapped, rawType, extensions } = field;

    // Skip list fields (collections are handled separately)
    if (isListType(rawType)) continue;

    if (isScalarOrEnum(unwrapped.kind)) {
      fieldSelections.push(name);
      if (name !== 'id') columns.push(name);
      sortFieldByColumn[name] = name;
      fieldTypeByColumn[name] = unwrapped.name || unwrapped.kind || 'SCALAR';
    } else if (unwrapped.kind === 'OBJECT' && unwrapped.name) {
      const objType = this._types.get(unwrapped.name);
      const objFields = objType?.fields || [];
      const objFieldNames = new Set(objFields.map(f => f.name));
      const isEmbedded = extensions?.relation?.embedded === true;

      // Determine display field with fallback chain
      let chosenDisplay = null;
      const extDisplay = extensions?.relation?.displayField;
      if (extDisplay && objFieldNames.has(extDisplay)) {
        chosenDisplay = extDisplay;
      } else if (objFieldNames.has('name')) {
        chosenDisplay = 'name';
      } else {
        const firstScalar = objFields.find(f =>
          isScalarOrEnum(f.type.kind) && !f.type.isList
        );
        chosenDisplay = firstScalar?.name || null;
      }

      // Build sub-selection
      const subFields = new Set();
      if (chosenDisplay) subFields.add(chosenDisplay);
      if (!isEmbedded && objFieldNames.has('id')) subFields.add('id');
      if (subFields.size === 0) {
        if (objFieldNames.has('id') && !isEmbedded) subFields.add('id');
        else if (objFieldNames.has('name')) subFields.add('name');
        else if (objFields[0]) subFields.add(objFields[0].name);
      }

      const subSelection = [...subFields].join(' ');
      fieldSelections.push(`${name} { ${subSelection} }`);
      columns.push(name);

      if (chosenDisplay) {
        sortFieldByColumn[name] = `${name}.${chosenDisplay}`;
        const displayFieldInfo = objFields.find(f => f.name === chosenDisplay);
        fieldTypeByColumn[name] = displayFieldInfo?.type?.name || 'OBJECT';
      } else {
        sortFieldByColumn[name] = name;
        fieldTypeByColumn[name] = 'OBJECT';
      }
    }
  }

  // Ensure id is always in selection
  const hasId = typeInfo.fields.some(f => f.name === 'id');
  if (hasId && !fieldSelections.includes('id')) {
    fieldSelections.unshift('id');
  }

  return {
    selection: fieldSelections.join('\n'),
    columns,
    sortFieldByColumn,
    fieldTypeByColumn,
  };
}
```

### Impact on existing auto-field selection

The existing `_getScalarFields()` method remains as-is for backward compatibility. The new `buildSelectionSet()` provides the full metadata-aware alternative.

When `QueryBuilder` has no explicit `.fields()` call, it could optionally use `buildSelectionSet()` instead of `_getScalarFields()`. Add an opt-in flag:

```javascript
// In QueryBuilder, add:
autoSelect() {
  const result = this._client.buildSelectionSet(this._typeName);
  this._selectionTree.addScalars(result.selection);
  this._hasExplicitFields = true;
  this._selectionMeta = result; // store metadata for callers
  return this;
}
```

---

## Feature 5: Entity & Query Name Resolution

### Context

The FE frequently resolves between list query names (`"series"`) and type names (`"Serie"`). The client stores `typeName -> queryName` but not the reverse. Also, some internal lookups need to become public.

### New public methods

```javascript
getTypeNameForQuery(queryName) {
  this._ensureInitialized();
  const queryInfo = this._queries.get(queryName);
  return queryInfo?.returnType?.name || null;
}

getPluralQueryName(typeName) {
  this._ensureInitialized();
  return this._typeNameToPlural.get(typeName) || null;
}

getSingularQueryName(typeName) {
  this._ensureInitialized();
  return this._typeNameToSingular.get(typeName) || null;
}

getListEntityNames() {
  this._ensureInitialized();
  const names = [];
  for (const [queryName, queryInfo] of this._queries) {
    if (queryInfo.returnType.isList && !queryName.endsWith('_aggregate')) {
      names.push(queryName);
    }
  }
  return names.sort();
}

getListEntityNamesOfType(typeName) {
  this._ensureInitialized();
  const names = [];
  for (const [queryName, queryInfo] of this._queries) {
    if (queryInfo.returnType.isList
      && queryInfo.returnType.name === typeName
      && !queryName.endsWith('_aggregate')) {
      names.push(queryName);
    }
  }
  return names.sort();
}

getQueryNamesForType(typeName) {
  this._ensureInitialized();
  return {
    pluralQueryName: this._typeNameToPlural.get(typeName) || null,
    singularQueryName: this._typeNameToSingular.get(typeName) || null,
    aggregateQueryName: this._typeNameToAggregate.get(typeName) || null,
  };
}
```

### New reverse-lookup registry

Add to `_buildQueriesRegistry()`:

```javascript
// After the existing loop, build the reverse map
this._queryNameToType = new Map();
for (const [typeName, queryName] of this._typeNameToPlural) {
  this._queryNameToType.set(queryName, typeName);
}
for (const [typeName, queryName] of this._typeNameToSingular) {
  this._queryNameToType.set(queryName, typeName);
}
```

Add `this._queryNameToType = new Map();` to the constructor.

---

## Feature 6: Mutation Input Transformation

### Context

The FE's `transformFormDataForMutation` (EntityForm.tsx lines 1139-1256) performs schema-aware data cleaning before sending mutation input. The client should offer this as a utility so consumers don't replicate this logic.

### New public method: `transformInput(typeName, rawInput, options?)`

```javascript
transformInput(typeName, rawInput, options = {}) {
  this._ensureInitialized();
  const { skipFields = [], transientFields = [], mode = 'create' } = options;
  const typeInfo = this._types.get(typeName);
  if (!typeInfo) return { ...rawInput };

  const transformed = {};

  for (const field of typeInfo.fields) {
    const { name, type: unwrapped, rawType, extensions } = field;

    // Skip fields not in input
    if (rawInput[name] === undefined) continue;

    // Skip id field (handled separately by add/update)
    if (name === 'id') continue;

    // Skip explicitly excluded fields
    if (skipFields.includes(name) || transientFields.includes(name)) continue;

    // Skip state machine fields
    if (extensions?.stateMachine === true) continue;

    // Skip read-only fields
    if (extensions?.readOnly === true) continue;

    // Skip collection fields (handled by transformCollectionDelta)
    if (isListType(rawType) && unwrapped.kind === 'OBJECT') continue;

    let value = rawInput[name];

    // Handle embedded objects
    if (unwrapped.kind === 'OBJECT' && extensions?.relation?.embedded === true) {
      value = this._transformEmbeddedInput(unwrapped.name, value, options);
    }
    // Handle FK reference objects (non-embedded)
    else if (unwrapped.kind === 'OBJECT' && !extensions?.relation?.embedded) {
      value = this._cleanObjectFieldForMutation(value);
    }
    // Type coercion for scalars
    else {
      value = this._coerceScalarValue(value, unwrapped.name);
    }

    if (value !== undefined && value !== null && value !== '') {
      transformed[name] = value;
    }
  }

  // Deep-clean __typename from all levels
  return this._deepRemoveTypename(transformed);
}
```

### Private helper: `_transformEmbeddedInput(objectTypeName, value, options)`

```javascript
_transformEmbeddedInput(objectTypeName, value, options = {}) {
  if (!value || typeof value !== 'object') return value;
  const typeInfo = this._types.get(objectTypeName);
  if (!typeInfo?.fields) return value;

  const cleaned = {};
  for (const field of typeInfo.fields) {
    const { name, type: unwrapped, extensions } = field;
    if (value[name] === undefined) continue;
    if (extensions?.readOnly === true) continue;

    let fieldValue = value[name];
    fieldValue = this._coerceScalarValue(fieldValue, unwrapped.name);

    if (fieldValue !== undefined && fieldValue !== null && fieldValue !== '') {
      cleaned[name] = fieldValue;
    }
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}
```

### Private helper: `_cleanObjectFieldForMutation(value)`

```javascript
_cleanObjectFieldForMutation(value) {
  if (!value) return value;
  // String ID: wrap in { id }
  if (typeof value === 'string') return { id: value };
  // Object with id: extract only id
  if (typeof value === 'object' && value.id) return { id: value.id };
  return value;
}
```

### Private helper: `_coerceScalarValue(value, scalarTypeName)`

```javascript
_coerceScalarValue(value, scalarTypeName) {
  if (value === null || value === undefined) return value;

  // Numeric coercion
  if (isNumericScalar(scalarTypeName) && typeof value === 'string') {
    return Number(value);
  }

  // Date coercion: YYYY-MM-DD -> ISO DateTime
  if (isDateTimeScalar(scalarTypeName) && typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return `${value}T00:00:00.000Z`;
    }
  }

  return value;
}
```

### Private helper: `_deepRemoveTypename(obj)`

```javascript
_deepRemoveTypename(obj) {
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(item => this._deepRemoveTypename(item));

  const cleaned = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === '__typename') continue;
    cleaned[key] = this._deepRemoveTypename(value);
  }
  return cleaned;
}
```

### Integration with existing `add()` and `update()` methods

Add an optional `{ transform: true }` options parameter:

```javascript
async add(typeName, input, fields, options = {}) {
  this._ensureInitialized();
  const transformedInput = options.transform
    ? this.transformInput(typeName, input, { mode: 'create', ...options })
    : input;
  return this._executeMutation(`add${typeName}`, typeName, { input: transformedInput }, fields);
}

async update(typeName, id, input, fields, options = {}) {
  this._ensureInitialized();
  const transformedInput = options.transform
    ? this.transformInput(typeName, input, { mode: 'update', ...options })
    : input;
  return this._executeMutation(
    `update${typeName}`, typeName,
    { input: { id, ...transformedInput } },
    fields,
  );
}
```

---

## Feature 7: Collection Delta Mutations

### Context

The FE's `transformCollectionDataForMutation` (EntityForm.tsx lines 1027-1123) builds the `{ added: [...], updated: [...], deleted: [...] }` structure for collection field mutations. Each item goes through type coercion, object field cleanup, metadata stripping, and `__typename` removal.

### New public method: `transformCollectionDelta(collectionTypeName, delta, options?)`

```javascript
transformCollectionDelta(collectionTypeName, delta, options = {}) {
  this._ensureInitialized();
  const { connectionField = null } = options;
  const result = {};

  if (delta.added && delta.added.length > 0) {
    result.added = delta.added.map(item => {
      let clean = { ...item };

      // Remove metadata
      delete clean.__status;
      delete clean.__originalData;

      // Remove connection field
      if (connectionField && clean[connectionField] !== undefined) {
        delete clean[connectionField];
      }

      // Remove temporary IDs
      if (clean.id && typeof clean.id === 'string' && clean.id.startsWith('temp_')) {
        delete clean.id;
      }

      // Type coercion and object field cleanup
      clean = this._cleanCollectionItem(collectionTypeName, clean);
      clean = this._deepRemoveTypename(clean);
      return clean;
    });
  }

  if (delta.updated && delta.updated.length > 0) {
    result.updated = delta.updated.map(item => {
      let clean = { ...item };

      // Remove metadata
      delete clean.__status;
      delete clean.__originalData;

      // Remove connection field
      if (connectionField && clean[connectionField] !== undefined) {
        delete clean[connectionField];
      }

      // Type coercion and object field cleanup (keep real ID)
      clean = this._cleanCollectionItem(collectionTypeName, clean);
      clean = this._deepRemoveTypename(clean);
      return clean;
    });
  }

  if (delta.deleted && delta.deleted.length > 0) {
    result.deleted = delta.deleted.map(item => {
      if (typeof item === 'string') return item;
      if (typeof item === 'object' && item.id) return item.id;
      return item;
    });
  }

  return result;
}
```

### Private helper: `_cleanCollectionItem(collectionTypeName, item)`

```javascript
_cleanCollectionItem(collectionTypeName, item) {
  const typeInfo = this._types.get(collectionTypeName);
  if (!typeInfo?.fields) return item;

  const cleaned = { ...item };

  for (const field of typeInfo.fields) {
    const { name, type: unwrapped, rawType, extensions } = field;
    if (cleaned[name] === undefined) continue;

    // Remove state machine fields
    if (extensions?.stateMachine === true) {
      delete cleaned[name];
      continue;
    }

    // Clean non-embedded object fields: extract { id } only
    if (unwrapped.kind === 'OBJECT' && !extensions?.relation?.embedded) {
      const val = cleaned[name];
      if (val && typeof val === 'object' && 'id' in val) {
        cleaned[name] = { id: val.id };
      }
      continue;
    }

    // Type coercion for scalars
    if (isNumericScalar(unwrapped.name) && typeof cleaned[name] === 'string') {
      cleaned[name] = Number(cleaned[name]);
    }
    if (isDateTimeScalar(unwrapped.name) && typeof cleaned[name] === 'string') {
      if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned[name])) {
        cleaned[name] = `${cleaned[name]}T00:00:00.000Z`;
      }
    }
  }

  return cleaned;
}
```

### Usage pattern (how the FE would use this)

```javascript
const collectionChanges = {
  seasons: {
    added: [{ number: '3', year: '2025', serie: { id: 'abc' } }],
    updated: [{ id: 'real-id', number: '2', year: '2024' }],
    deleted: [{ id: 'del-id' }]
  }
};

// For each collection field:
for (const [fieldName, delta] of Object.entries(collectionChanges)) {
  const connectionField = client.getConnectionField('Serie', fieldName);
  const collectionTypeName = /* resolve from schema */ 'Season';
  updateInput[fieldName] = client.transformCollectionDelta(collectionTypeName, delta, {
    connectionField,
  });
}
```

---

## Feature 8: Collection Item Queries (findByParent)

### Context

The FE's `CollectionFieldGrid` (lines 196-260 of `CollectionFieldGrid.tsx`) builds queries to fetch collection items filtered by their parent entity. The filter uses the `connectionField` with `terms: { path: "id", operator: EQ, value: parentId }` pattern.

### New public method: `findByParent(typeName, connectionField, parentId)`

```javascript
findByParent(typeName, connectionField, parentId) {
  this._ensureInitialized();
  const builder = new QueryBuilder(this, typeName);
  // Apply the connection field filter using the terms pattern
  builder.where(connectionField, [{ path: 'id', operator: 'EQ', value: parentId }]);
  // Default sort by id ASC
  builder.sort('id', 'ASC');
  return builder;
}
```

### Usage pattern

```javascript
const seasons = await client
  .findByParent('Season', 'serie', serieId)
  .page(1, 10, true)
  .where('id', 'NIN', ['modified-id-1', 'deleted-id-2'])  // exclude modified/deleted
  .fields('id number year state')
  .exec();
```

The existing `QueryBuilder.where()` already handles `NIN` and other operators, so the chain works naturally.

---

## Feature 9: FK/Relation Search Queries

### Context

The FE's `ObjectFieldSelector` (lines 102-130 of `ObjectFieldSelector.tsx`) builds search-as-you-type queries for FK reference fields. It uses the `displayField` to determine which field to search, selects `LIKE` for strings and `EQ` for other types, and casts the search term to the appropriate type.

### New public method: `search(typeName, searchTerm, options?)`

```javascript
async search(typeName, searchTerm, options = {}) {
  this._ensureInitialized();
  const { page = 1, size = 10, displayField = null } = options;

  // Resolve the display field for this type
  // The displayField here refers to the field on the target type to search by.
  // The caller can provide it, or we try to resolve it from the type's fields.
  let searchField = displayField;
  if (!searchField) {
    // Try to find a reasonable display field from the type itself
    const typeInfo = this._types.get(typeName);
    if (typeInfo?.fields) {
      const nameField = typeInfo.fields.find(f => f.name === 'name');
      if (nameField) {
        searchField = 'name';
      } else {
        const firstScalar = typeInfo.fields.find(f =>
          isScalarOrEnum(f.type.kind) && f.name !== 'id'
        );
        searchField = firstScalar?.name || 'id';
      }
    }
  }

  // Determine search field type for operator selection and term casting
  const typeInfo = this._types.get(typeName);
  const fieldInfo = typeInfo?.fields.find(f => f.name === searchField);
  const fieldTypeName = fieldInfo?.type?.name || 'String';

  // Select operator: LIKE for strings, EQ for others
  const isString = !isNumericScalar(fieldTypeName) && !isBooleanScalar(fieldTypeName);
  const operator = isString ? 'LIKE' : 'EQ';

  // Cast search term to proper type
  let castedTerm = searchTerm;
  if (isNumericScalar(fieldTypeName)) {
    const actualType = getActualScalarType(fieldTypeName);
    if (actualType?.toLowerCase() === 'int') {
      const parsed = parseInt(searchTerm, 10);
      if (!isNaN(parsed)) castedTerm = parsed;
    } else {
      const parsed = parseFloat(searchTerm);
      if (!isNaN(parsed)) castedTerm = parsed;
    }
  } else if (isBooleanScalar(fieldTypeName)) {
    if (searchTerm.toLowerCase() === 'true') castedTerm = true;
    else if (searchTerm.toLowerCase() === 'false') castedTerm = false;
  }

  // Build and execute the query
  const builder = this.find(typeName)
    .fields(`id ${searchField}`)
    .page(page, size, false)
    .where(searchField, operator, castedTerm);

  return builder.exec();
}
```

### Usage pattern

```javascript
// Search for genres by name
const results = await client.search('Genre', 'com', {
  displayField: 'name',
  page: 1,
  size: 10,
});
// returns: [{ id: '1', name: 'Comedy' }, { id: '2', name: 'Romantic Comedy' }]
```

---

## Feature 10: State Machine Metadata

### Context

The client already classifies mutations as `stateTransition` in `_classifyMutation()` (lines 428-456). However, it doesn't expose which fields are state machine managed (from extensions) or which transitions are available per type.

### New public methods

```javascript
getStateMachineFields(typeName) {
  this._ensureInitialized();
  const typeInfo = this._types.get(typeName);
  if (!typeInfo?.fields) return [];
  return typeInfo.fields
    .filter(f => f.extensions?.stateMachine === true)
    .map(f => f.name);
}

getAvailableTransitions(typeName) {
  this._ensureInitialized();
  const transitions = [];
  for (const info of this._mutations.values()) {
    if (info.category === 'stateTransition' && info.typeName === typeName) {
      transitions.push({
        action: info.action,
        mutationName: info.name,
      });
    }
  }
  return transitions;
}
```

### Usage pattern

```javascript
// Check which fields are state machine managed
const smFields = client.getStateMachineFields('Season');
// returns: ['state']

// Get available transitions
const transitions = client.getAvailableTransitions('Season');
// returns: [{ action: 'activate', mutationName: 'activateSeason' }, ...]
```

---

## Feature 11: Response Extensions (Pagination Count)

### Context

The FE extracts pagination count from `result.extensions.count`. The client currently discards response extensions. Both `QueryBuilder.exec()` and `_sendRequest()` need to preserve them.

### Changes to `QueryBuilder.exec()` (lines 179-219)

Change the return value to include extensions:

```javascript
async exec() {
  // ... existing query building code ...

  const response = await this._client._sendRequest(query, variables);
  if (response.errors) {
    const error = new Error(`GraphQL errors: ${JSON.stringify(response.errors)}`);
    error.graphQLErrors = response.errors;
    throw error;
  }

  const result = response.data[queryInfo.name];

  // Attach extensions if present (especially pagination count)
  if (response.extensions) {
    result.__extensions = response.extensions;
  }

  return result;
}
```

### Alternative: return a wrapper object

For a cleaner API, the builder could have a `.execWithMeta()` variant:

```javascript
async execWithMeta() {
  // ... same query building ...
  const response = await this._client._sendRequest(query, variables);
  if (response.errors) {
    const error = new Error(`GraphQL errors: ${JSON.stringify(response.errors)}`);
    error.graphQLErrors = response.errors;
    throw error;
  }
  return {
    data: response.data[queryInfo.name],
    extensions: response.extensions || null,
  };
}
```

### Usage pattern

```javascript
const { data: series, extensions } = await client
  .find('Serie')
  .page(1, 10, true)
  .execWithMeta();

const totalCount = extensions?.count;
```

---

## Summary of New Public API Methods

### Schema Metadata (Feature 1 + 2 + 3)

| Method | Signature | Description |
|--------|-----------|-------------|
| `getFieldExtensions` | `(typeName, fieldName) => extensions \| null` | Returns `{ relation, stateMachine, readOnly }` |
| `getDisplayField` | `(typeName, fieldName) => string \| null` | Display field with fallback chain |
| `isEmbeddedField` | `(typeName, fieldName) => boolean` | Is field an embedded object? |
| `getConnectionField` | `(typeName, fieldName) => string \| null` | Back-reference field for collections |
| `isStateMachineField` | `(typeName, fieldName) => boolean` | Is field state-machine managed? |
| `isReadOnlyField` | `(typeName, fieldName) => boolean` | Is field read-only? |
| `getEnumValues` | `(typeName) => string[]` | Enum values for an enum type |
| `getFieldsOfType` | `(typeName) => fieldInfo[]` | All fields with full metadata |
| `getDescriptionFieldType` | `(typeName, descField) => string` | Scalar type of a display field |
| `getActualScalarType` | `(scalarName) => string \| null` | Strip validated scalar prefix |
| `isNumericScalar` | `(scalarName) => boolean` | Detect Int/Float |
| `isBooleanScalar` | `(scalarName) => boolean` | Detect Boolean |
| `isDateTimeScalar` | `(scalarName) => boolean` | Detect Date/DateTime/Timestamp |

### Selection Set Building (Feature 4)

| Method | Signature | Description |
|--------|-----------|-------------|
| `buildSelectionSet` | `(typeName) => { selection, columns, sortFieldByColumn, fieldTypeByColumn }` | Full auto selection set |

### Entity Resolution (Feature 5)

| Method | Signature | Description |
|--------|-----------|-------------|
| `getTypeNameForQuery` | `(queryName) => string \| null` | Reverse: query name -> type name |
| `getPluralQueryName` | `(typeName) => string \| null` | Type -> plural query name |
| `getSingularQueryName` | `(typeName) => string \| null` | Type -> singular query name |
| `getListEntityNames` | `() => string[]` | All list entity query names |
| `getListEntityNamesOfType` | `(typeName) => string[]` | List queries returning a type |
| `getQueryNamesForType` | `(typeName) => { plural, singular, aggregate }` | All query names for a type |

### Data Transformation (Feature 6 + 7)

| Method | Signature | Description |
|--------|-----------|-------------|
| `transformInput` | `(typeName, rawInput, options?) => cleaned` | Schema-aware mutation input transform |
| `transformCollectionDelta` | `(typeName, { added, updated, deleted }, options?) => delta` | Collection mutation delta builder |

### Querying (Feature 8 + 9)

| Method | Signature | Description |
|--------|-----------|-------------|
| `findByParent` | `(typeName, connectionField, parentId) => QueryBuilder` | Pre-filtered collection query |
| `search` | `(typeName, searchTerm, options?) => results` | FK field search-as-you-type |

### State Machine (Feature 10)

| Method | Signature | Description |
|--------|-----------|-------------|
| `getStateMachineFields` | `(typeName) => string[]` | Fields managed by state machine |
| `getAvailableTransitions` | `(typeName) => { action, mutationName }[]` | Available state transitions |

### Response (Feature 11)

| Method | Signature | Description |
|--------|-----------|-------------|
| `execWithMeta` | `(on QueryBuilder) => { data, extensions }` | Query execution with response metadata |

---

## Implementation Order

Implement in this order (each depends on the previous):

1. **Feature 1** - Introspection extensions (foundational)
2. **Feature 2** - Scalar type utilities (used by everything below)
3. **Feature 3** - Schema metadata API (used by Features 4-10)
4. **Feature 4** - Auto selection set building
5. **Feature 5** - Entity/query name resolution
6. **Feature 6** - Mutation input transformation
7. **Feature 7** - Collection delta mutations
8. **Feature 8** - Collection item queries
9. **Feature 9** - FK search queries
10. **Feature 10** - State machine metadata
11. **Feature 11** - Response extensions

---

## Testing Guidance

For each feature, test against a running Simfinity backend. Key scenarios:

1. **Introspection**: Verify `extensions` data is populated for fields that have relations, state machines, or read-only flags.
2. **Scalar utilities**: Test `SeasonNumber_Int` -> `Int`, `StartDate_Date` -> `Date`, etc.
3. **Selection set**: Compare generated selection strings against what the FE currently builds in `buildSelectionSetForObjectType()`.
4. **Transform**: Submit `add`/`update` mutations with `transform: true` and verify the backend accepts the cleaned input.
5. **Collection delta**: Create parent entity update with collection changes and verify `added`/`updated`/`deleted` structure.
6. **findByParent**: Query collection items filtered by parent ID and verify connection field filtering works.
7. **search**: Search FK reference entities and verify `LIKE`/`EQ` operator selection and term casting.

---

## Backward Compatibility Notes

- All new methods are additive; no existing methods are removed or have their signatures changed (except optional trailing `options` params on `add`/`update`).
- The `transform` option on `add()`/`update()` defaults to `false`, so existing callers are unaffected.
- The `execWithMeta()` method is new and separate from `exec()`, preserving the existing return format.
- The `QueryBuilder.autoSelect()` method is opt-in; existing `.fields()` behavior is unchanged.
