# @simtlix/simfinity-js-client

Introspection-driven GraphQL client for [simfinity-js](https://github.com/simtlix/simfinity.js) APIs. It discovers your schema at runtime via introspection and exposes a chainable query builder, CRUD helpers, aggregate queries, and state-machine transitions — no code generation required.

## Installation

```bash
npm install @simtlix/simfinity-js-client
```

## Quick Start

```js
import SimfinityClient from '@simtlix/simfinity-js-client';

const client = new SimfinityClient('http://localhost:3000/graphql');
await client.init();

const series = await client.find('serie').exec();
console.log(series);
```

## API Reference

### `new SimfinityClient(endpoint)`

Creates a new client instance pointing at the given GraphQL endpoint.

### `client.init()`

Runs an introspection query against the endpoint and builds internal registries of types, queries, and mutations. **Must be called before any other method.**

### Schema Inspection

| Method | Returns |
|---|---|
| `client.getTypes()` | All discovered types (objects, enums, scalars, inputs) |
| `client.getQueries()` | All root query fields |
| `client.getMutations()` | All root mutation fields |

---

### Query Builder — `client.find(typeName)`

Returns a chainable `QueryBuilder`. Call `.exec()` to execute.

```js
const results = await client.find('serie')
  .where('categories', 'EQ', 'Drama')
  .joinObject('director', 'name country')
  .joinCollection('seasons', 'number year state')
  .joinCollection('seasons.episodes', 'number name')
  .fields('id name categories')
  .page(1, 10)
  .sort('name', 'ASC')
  .exec();
```

#### `.where(field, operator, value [, value2])`

Filter by a scalar field. Supported operators depend on the server schema (e.g. `EQ`, `NE`, `GT`, `LT`, `GTE`, `LTE`, `BETWEEN`, `LIKE`).

#### `.where(field, terms)`

Filter by a collection field using an array of term objects:

```js
.where('seasons', [
  { path: 'episodes.name', operator: 'EQ', value: 'Pilot' }
])
```

#### `.joinObject(path, fields)`

Include a related object's fields in the selection.

#### `.joinCollection(path, fields [, filter])`

Include a related collection's fields. Supports dot-notation for nested joins (e.g. `'seasons.episodes'`). An optional `filter` array of terms can be passed.

#### `.fields(selectionString)`

Space-separated list of scalar fields to select on the root type. If omitted, all scalar and enum fields are selected automatically.

#### `.page(page, size [, count])`

Paginate results. `page` is 1-based.

#### `.sort(field, order)`

Sort results. `order` is `'ASC'` or `'DESC'`. Can be called multiple times for multi-field sorting.

---

### Aggregate Builder — `client.aggregate(typeName)`

Returns a chainable `AggregateBuilder`. Call `.exec()` to execute.

```js
const results = await client.aggregate('season')
  .groupBy('serie')
  .fact('COUNT', 'seasonCount', 'id')
  .fact('AVG', 'avgYear', 'year')
  .page(1, 5)
  .sort('serie', 'ASC')
  .exec();
```

#### `.groupBy(field)`

**Required.** The field to group by.

#### `.fact(operation, factName, path)`

Add an aggregation fact. `operation` can be `COUNT`, `SUM`, `AVG`, `MIN`, `MAX`, etc.

#### `.where()`, `.page()`, `.sort()`

Same API as the Query Builder.

---

### Get by ID

```js
const serie = await client.getById('serie', '507f1f77bcf86cd799439011', 'id name categories');
```

If `fields` is omitted, all scalar fields are returned.

---

### CRUD Mutations

```js
const created = await client.add('star', { name: 'John Doe' }, 'id name');

const updated = await client.update('star', createdId, { name: 'Jane Doe' }, 'id name');

const deleted = await client.delete('star', createdId, 'id name');
```

---

### State Machine Transitions

```js
const activated = await client.transition('season', 'activate', seasonId, 'id number state');
```

Optionally pass extra input fields:

```js
await client.transition('season', 'activate', seasonId, { extraField: 'value' }, 'id number state');
```

---

### Custom Mutations

```js
const result = await client.customMutation('myCustomMutation', { arg1: 'value' }, 'id status');
```

---

### Raw GraphQL Execution

```js
const response = await client.execute(
  '{ stars(pagination: { page: 1, size: 2 }) { id name } }'
);
console.log(response.data);
```

---

## Examples

See [`examples/demo.js`](examples/demo.js) for a comprehensive walkthrough covering all features: schema discovery, filtering, joins, pagination, sorting, CRUD, state machine transitions, aggregates, and raw queries.

```bash
GRAPHQL_ENDPOINT=http://localhost:3000/graphql npm run demo
```

## License

[Apache-2.0](LICENSE)
