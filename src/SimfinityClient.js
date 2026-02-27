import fetch from 'node-fetch';

const INTROSPECTION_QUERY = `
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
            name kind
            ofType {
              name kind
              ofType {
                name kind
                ofType { name kind }
              }
            }
          }
          args {
            name
            type {
              name kind
              ofType {
                name kind
                ofType {
                  name kind
                  ofType { name kind }
                }
              }
            }
          }
        }
        enumValues { name }
      }
    }
  }
`;

function unwrapType(typeRef) {
  let isList = false;
  let isNonNull = false;
  let current = typeRef;
  while (current && (current.kind === 'NON_NULL' || current.kind === 'LIST')) {
    if (current.kind === 'NON_NULL') isNonNull = true;
    if (current.kind === 'LIST') isList = true;
    current = current.ofType;
  }
  return { name: current?.name, kind: current?.kind, isList, isNonNull };
}

function typeRefToString(typeRef) {
  if (!typeRef) return '';
  if (typeRef.kind === 'NON_NULL') return typeRefToString(typeRef.ofType) + '!';
  if (typeRef.kind === 'LIST') return '[' + typeRefToString(typeRef.ofType) + ']';
  return typeRef.name || '';
}

// ---------------------------------------------------------------------------
// SelectionTree -- accumulates nested field selections and serializes them
// into a GraphQL selection set string.
// ---------------------------------------------------------------------------

class SelectionTree {
  constructor() {
    this.scalars = new Set();
    this.children = new Map();
  }

  addScalars(fieldNames) {
    for (const name of fieldNames.trim().split(/\s+/)) {
      if (name) this.scalars.add(name);
    }
  }

  addNested(dottedPath, fieldNames) {
    const segments = dottedPath.split('.');
    let node = this;
    for (const segment of segments) {
      if (!node.children.has(segment)) {
        node.children.set(segment, new SelectionTree());
      }
      node = node.children.get(segment);
    }
    node.addScalars(fieldNames);
  }

  serialize() {
    const parts = [...this.scalars];
    for (const [name, child] of this.children) {
      const childStr = child.serialize();
      if (childStr) parts.push(`${name} { ${childStr} }`);
    }
    return parts.join(' ');
  }

  isEmpty() {
    return this.scalars.size === 0 && this.children.size === 0;
  }
}

// ---------------------------------------------------------------------------
// QueryBuilder -- chainable builder returned by SimfinityClient.find()
// ---------------------------------------------------------------------------

class QueryBuilder {
  constructor(client, typeName) {
    this._client = client;
    this._typeName = typeName;
    this._variables = {};
    this._selectionTree = new SelectionTree();
    this._sortTerms = [];
    this._hasExplicitFields = false;
  }

  // -- Filtering -----------------------------------------------------------

  where(field, operatorOrTerms, value, value2) {
    if (Array.isArray(operatorOrTerms)) {
      if (this._variables[field]?.terms) {
        this._variables[field].terms.push(...operatorOrTerms);
      } else {
        this._variables[field] = { terms: operatorOrTerms };
      }
    } else {
      const filter = { operator: operatorOrTerms, value };
      if (value2 !== undefined) filter.value2 = value2;
      this._variables[field] = filter;
    }
    return this;
  }

  // -- Relation Field Selection --------------------------------------------

  joinCollection(path, fields, filter) {
    this._selectionTree.addNested(path, fields);
    if (filter) {
      const rootField = path.split('.')[0];
      if (this._variables[rootField]?.terms) {
        this._variables[rootField].terms.push(...filter);
      } else {
        this._variables[rootField] = { terms: filter };
      }
    }
    return this;
  }

  joinObject(path, fields) {
    this._selectionTree.addNested(path, fields);
    return this;
  }

  // -- Result Shaping ------------------------------------------------------

  fields(selectionString) {
    this._selectionTree.addScalars(selectionString);
    this._hasExplicitFields = true;
    return this;
  }

  page(page, size, count) {
    const pagination = { page, size };
    if (count !== undefined) pagination.count = count;
    this._variables.pagination = pagination;
    return this;
  }

  sort(field, order) {
    this._sortTerms.push({ field, order });
    this._variables.sort = { terms: this._sortTerms };
    return this;
  }

  // -- Execution -----------------------------------------------------------

  async exec() {
    const queryInfo = this._client._findPluralQuery(this._typeName);
    if (!queryInfo) {
      throw new Error(`No plural query found for type '${this._typeName}'`);
    }

    if (!this._hasExplicitFields) {
      const autoFields = this._client._getScalarFields(this._typeName);
      this._selectionTree.addScalars(autoFields);
    }

    const selectionSet = this._selectionTree.serialize();
    if (!selectionSet) {
      throw new Error(`No fields to select for type '${this._typeName}'`);
    }

    const varDefs = [];
    const variables = {};
    const argMappings = [];

    for (const [key, val] of Object.entries(this._variables)) {
      const arg = queryInfo.args.find(a => a.name === key);
      if (arg) {
        varDefs.push(`$${key}: ${typeRefToString(arg.type)}`);
        variables[key] = val;
        argMappings.push(`${key}: $${key}`);
      }
    }

    const varDefsStr = varDefs.length > 0 ? `(${varDefs.join(', ')})` : '';
    const argsBlock = argMappings.length > 0 ? `(${argMappings.join(', ')})` : '';
    const query = `query${varDefsStr} { ${queryInfo.name}${argsBlock} { ${selectionSet} } }`;

    const response = await this._client._sendRequest(query, variables);
    if (response.errors) {
      const error = new Error(`GraphQL errors: ${JSON.stringify(response.errors)}`);
      error.graphQLErrors = response.errors;
      throw error;
    }
    return response.data[queryInfo.name];
  }
}

// ---------------------------------------------------------------------------
// AggregateBuilder -- chainable builder returned by SimfinityClient.aggregate()
// ---------------------------------------------------------------------------

class AggregateBuilder {
  constructor(client, typeName) {
    this._client = client;
    this._typeName = typeName;
    this._groupId = null;
    this._facts = [];
    this._variables = {};
    this._sortTerms = [];
  }

  groupBy(field) {
    this._groupId = field;
    return this;
  }

  fact(operation, factName, path) {
    this._facts.push({ operation, factName, path });
    return this;
  }

  where(field, operatorOrTerms, value, value2) {
    if (Array.isArray(operatorOrTerms)) {
      if (this._variables[field]?.terms) {
        this._variables[field].terms.push(...operatorOrTerms);
      } else {
        this._variables[field] = { terms: operatorOrTerms };
      }
    } else {
      const filter = { operator: operatorOrTerms, value };
      if (value2 !== undefined) filter.value2 = value2;
      this._variables[field] = filter;
    }
    return this;
  }

  page(page, size, count) {
    const pagination = { page, size };
    if (count !== undefined) pagination.count = count;
    this._variables.pagination = pagination;
    return this;
  }

  sort(field, order) {
    this._sortTerms.push({ field, order });
    this._variables.sort = { terms: this._sortTerms };
    return this;
  }

  async exec() {
    if (!this._groupId) {
      throw new Error('groupBy() is required for aggregate queries');
    }
    if (this._facts.length === 0) {
      throw new Error('At least one fact() is required for aggregate queries');
    }

    const queryInfo = this._client._findAggregateQuery(this._typeName);
    if (!queryInfo) {
      throw new Error(`No aggregate query found for type '${this._typeName}'`);
    }

    this._variables.aggregation = {
      groupId: this._groupId,
      facts: this._facts,
    };

    const varDefs = [];
    const variables = {};
    const argMappings = [];

    for (const [key, val] of Object.entries(this._variables)) {
      const arg = queryInfo.args.find(a => a.name === key);
      if (arg) {
        varDefs.push(`$${key}: ${typeRefToString(arg.type)}`);
        variables[key] = val;
        argMappings.push(`${key}: $${key}`);
      }
    }

    const varDefsStr = varDefs.length > 0 ? `(${varDefs.join(', ')})` : '';
    const argsBlock = argMappings.length > 0 ? `(${argMappings.join(', ')})` : '';
    const query = `query${varDefsStr} { ${queryInfo.name}${argsBlock} { groupId facts } }`;

    const response = await this._client._sendRequest(query, variables);
    if (response.errors) {
      const error = new Error(`GraphQL errors: ${JSON.stringify(response.errors)}`);
      error.graphQLErrors = response.errors;
      throw error;
    }
    return response.data[queryInfo.name];
  }
}

// ---------------------------------------------------------------------------
// SimfinityClient -- introspection-driven GraphQL client
// ---------------------------------------------------------------------------

export default class SimfinityClient {
  constructor(endpoint) {
    this._endpoint = endpoint;
    this._types = new Map();
    this._queries = new Map();
    this._mutations = new Map();
    this._typeNameToPlural = new Map();
    this._typeNameToSingular = new Map();
    this._typeNameToAggregate = new Map();
    this._initialized = false;
  }

  // -- Initialization ------------------------------------------------------

  async init() {
    const response = await this._sendRequest(INTROSPECTION_QUERY);
    if (response.errors) {
      throw new Error(`Introspection failed: ${JSON.stringify(response.errors)}`);
    }
    this._parseIntrospection(response.data.__schema);
    this._initialized = true;
  }

  _parseIntrospection(schema) {
    const queryTypeName = schema.queryType?.name;
    const mutationTypeName = schema.mutationType?.name;

    this._buildTypesRegistry(schema.types);
    this._buildQueriesRegistry(schema.types, queryTypeName);
    this._buildMutationsRegistry(schema.types, mutationTypeName);
  }

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
        })),
        enumValues: (type.enumValues || []).map(v => v.name),
      };
      this._types.set(type.name, typeInfo);
    }
  }

  _buildQueriesRegistry(types, queryTypeName) {
    const queryType = types.find(t => t.name === queryTypeName);
    if (!queryType?.fields) return;

    for (const field of queryType.fields) {
      const returnType = unwrapType(field.type);
      const queryInfo = {
        name: field.name,
        args: (field.args || []).map(a => ({ name: a.name, type: a.type })),
        returnType,
        rawReturnType: field.type,
      };
      this._queries.set(field.name, queryInfo);

      if (!returnType.name) continue;
      if (returnType.isList) {
        this._typeNameToPlural.set(returnType.name, field.name);
      } else if (queryInfo.args.some(a => a.name === 'id')) {
        this._typeNameToSingular.set(returnType.name, field.name);
      }
    }

    for (const [typeName, pluralName] of this._typeNameToPlural) {
      const aggName = `${pluralName}_aggregate`;
      if (this._queries.has(aggName)) {
        this._typeNameToAggregate.set(typeName, aggName);
      }
    }
  }

  _buildMutationsRegistry(types, mutationTypeName) {
    const mutationType = types.find(t => t.name === mutationTypeName);
    if (!mutationType?.fields) return;

    const knownTypeNames = [...this._typeNameToSingular.keys()];

    for (const field of mutationType.fields) {
      const returnType = unwrapType(field.type);
      const mutationInfo = {
        name: field.name,
        args: (field.args || []).map(a => ({ name: a.name, type: a.type })),
        returnType,
        rawReturnType: field.type,
        category: 'custom',
        typeName: returnType.name,
      };

      this._classifyMutation(mutationInfo, knownTypeNames);
      this._mutations.set(field.name, mutationInfo);
    }
  }

  _classifyMutation(mutationInfo, knownTypeNames) {
    const name = mutationInfo.name;
    for (const typeName of knownTypeNames) {
      if (name === `add${typeName}`) {
        Object.assign(mutationInfo, { category: 'add', typeName });
        return;
      }
      if (name === `update${typeName}`) {
        Object.assign(mutationInfo, { category: 'update', typeName });
        return;
      }
      if (name === `delete${typeName}`) {
        Object.assign(mutationInfo, { category: 'delete', typeName });
        return;
      }
      if (name.endsWith(typeName)) {
        let prefix = name.slice(0, -typeName.length);
        if (prefix.endsWith('_')) prefix = prefix.slice(0, -1);
        if (prefix) {
          Object.assign(mutationInfo, {
            category: 'stateTransition',
            typeName,
            action: prefix,
          });
          return;
        }
      }
    }
  }

  // -- Field Auto-Selection ------------------------------------------------

  _getScalarFields(typeName) {
    const typeInfo = this._types.get(typeName);
    if (!typeInfo) return 'id';
    const scalars = typeInfo.fields
      .filter(f => f.type.kind === 'SCALAR' || f.type.kind === 'ENUM')
      .map(f => f.name);
    return scalars.length > 0 ? scalars.join(' ') : 'id';
  }

  _resolveFields(typeName, fields) {
    return fields || this._getScalarFields(typeName);
  }

  // -- Query Lookup --------------------------------------------------------

  _findPluralQuery(typeName) {
    const queryName = this._typeNameToPlural.get(typeName);
    return queryName ? this._queries.get(queryName) : null;
  }

  _findSingularQuery(typeName) {
    const queryName = this._typeNameToSingular.get(typeName);
    return queryName ? this._queries.get(queryName) : null;
  }

  _findAggregateQuery(typeName) {
    const queryName = this._typeNameToAggregate.get(typeName);
    return queryName ? this._queries.get(queryName) : null;
  }

  // -- HTTP ----------------------------------------------------------------

  async _sendRequest(query, variables) {
    const body = { query };
    if (variables && Object.keys(variables).length > 0) {
      body.variables = variables;
    }
    const response = await fetch(this._endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response.json();
  }

  // -- Query Methods -------------------------------------------------------

  find(typeName) {
    this._ensureInitialized();
    return new QueryBuilder(this, typeName);
  }

  aggregate(typeName) {
    this._ensureInitialized();
    return new AggregateBuilder(this, typeName);
  }

  async getById(typeName, id, fields) {
    this._ensureInitialized();
    const queryInfo = this._findSingularQuery(typeName);
    if (!queryInfo) {
      throw new Error(`No singular query found for type '${typeName}'`);
    }

    const selectionSet = this._resolveFields(typeName, fields);
    const idArg = queryInfo.args.find(a => a.name === 'id');
    const idType = idArg ? typeRefToString(idArg.type) : 'ID!';

    const query = `query($id: ${idType}) { ${queryInfo.name}(id: $id) { ${selectionSet} } }`;
    const response = await this._sendRequest(query, { id });

    if (response.errors) {
      const error = new Error(`GraphQL errors: ${JSON.stringify(response.errors)}`);
      error.graphQLErrors = response.errors;
      throw error;
    }
    return response.data[queryInfo.name];
  }

  // -- CRUD Mutation Methods -----------------------------------------------

  async add(typeName, input, fields) {
    this._ensureInitialized();
    return this._executeMutation(`add${typeName}`, typeName, { input }, fields);
  }

  async update(typeName, id, input, fields) {
    this._ensureInitialized();
    return this._executeMutation(`update${typeName}`, typeName, { input: { id, ...input } }, fields);
  }

  async delete(typeName, id, fields) {
    this._ensureInitialized();
    return this._executeMutation(`delete${typeName}`, typeName, { id }, fields);
  }

  // -- State Machine -------------------------------------------------------

  async transition(typeName, action, id, inputOrFields, fields) {
    this._ensureInitialized();
    const mutationInfo = this._findTransitionMutation(typeName, action);
    if (!mutationInfo) {
      throw new Error(`No state machine transition '${action}' found for type '${typeName}'`);
    }

    let input, resolvedFields;
    if (typeof inputOrFields === 'object' && inputOrFields !== null) {
      input = inputOrFields;
      resolvedFields = fields;
    } else {
      input = {};
      resolvedFields = inputOrFields;
    }

    return this._executeMutation(
      mutationInfo.name, typeName, { input: { id, ...input } }, resolvedFields,
    );
  }

  _findTransitionMutation(typeName, action) {
    for (const info of this._mutations.values()) {
      if (info.category === 'stateTransition' && info.typeName === typeName && info.action === action) {
        return info;
      }
    }
    return null;
  }

  // -- Custom Mutations ----------------------------------------------------

  async customMutation(mutationName, args, fields) {
    this._ensureInitialized();
    const mutationInfo = this._mutations.get(mutationName);
    if (!mutationInfo) {
      throw new Error(`Mutation '${mutationName}' not found`);
    }
    return this._executeMutation(
      mutationName,
      mutationInfo.returnType.name,
      args || {},
      fields,
    );
  }

  // -- Raw Execution -------------------------------------------------------

  async execute(query, variables) {
    return this._sendRequest(query, variables);
  }

  // -- Shared Mutation Executor --------------------------------------------

  async _executeMutation(mutationName, typeName, providedArgs, fields) {
    const mutationInfo = this._mutations.get(mutationName);
    if (!mutationInfo) {
      throw new Error(`Mutation '${mutationName}' not found`);
    }

    const selectionSet = this._resolveFields(typeName, fields);
    const varDefs = [];
    const variables = {};
    const argMappings = [];

    for (const arg of mutationInfo.args) {
      if (providedArgs[arg.name] !== undefined) {
        varDefs.push(`$${arg.name}: ${typeRefToString(arg.type)}`);
        variables[arg.name] = providedArgs[arg.name];
        argMappings.push(`${arg.name}: $${arg.name}`);
      }
    }

    const varDefsStr = varDefs.length > 0 ? `(${varDefs.join(', ')})` : '';
    const argsBlock = argMappings.length > 0 ? `(${argMappings.join(', ')})` : '';
    const query = `mutation${varDefsStr} { ${mutationName}${argsBlock} { ${selectionSet} } }`;

    const response = await this._sendRequest(query, variables);
    if (response.errors) {
      const error = new Error(`GraphQL errors: ${JSON.stringify(response.errors)}`);
      error.graphQLErrors = response.errors;
      throw error;
    }
    return response.data[mutationName];
  }

  // -- Schema Getters ------------------------------------------------------

  getTypes() {
    return Object.fromEntries(this._types);
  }

  getQueries() {
    return Object.fromEntries(this._queries);
  }

  getMutations() {
    return Object.fromEntries(this._mutations);
  }

  // -- Guard ---------------------------------------------------------------

  _ensureInitialized() {
    if (!this._initialized) {
      throw new Error('Client not initialized. Call init() first.');
    }
  }
}
