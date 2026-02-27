import SimfinityClient from '../src/SimfinityClient.js';

const ENDPOINT = process.env.GRAPHQL_ENDPOINT || 'http://localhost:3000/graphql';
const client = new SimfinityClient(ENDPOINT);

const log = (label, data) => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(label);
  console.log('='.repeat(60));
  console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
};

(async () => {
  // -----------------------------------------------------------------------
  // 1. Initialization
  // -----------------------------------------------------------------------
  await client.init();
  log('1. Schema Discovery', {
    types: Object.keys(client.getTypes()).filter(t => client.getTypes()[t].kind === 'OBJECT'),
    queries: Object.keys(client.getQueries()),
    mutations: Object.keys(client.getMutations()),
  });

  // -----------------------------------------------------------------------
  // 2. find() -- auto-selected fields
  // -----------------------------------------------------------------------
  const allSeries = await client.find('serie').exec();
  log('2. find("serie") -- auto-selected scalar fields', allSeries);

  // -----------------------------------------------------------------------
  // 3. find() -- where scalar filter
  // -----------------------------------------------------------------------
  const dramas = await client.find('serie')
    .where('categories', 'EQ', 'Drama')
    .fields('id name categories')
    .exec();
  log('3. find("serie") -- where categories = Drama', dramas);

  // -----------------------------------------------------------------------
  // 4. find() -- where + joinObject
  // -----------------------------------------------------------------------
  const withDirector = await client.find('serie')
    .where('name', 'EQ', 'Breaking Bad')
    .joinObject('director', 'name country')
    .fields('id name')
    .exec();
  log('4. find("serie") -- where name = Breaking Bad + joinObject director', withDirector);

  // -----------------------------------------------------------------------
  // 5. find() -- joinCollection
  // -----------------------------------------------------------------------
  const withSeasons = await client.find('serie')
    .where('name', 'EQ', 'Breaking Bad')
    .joinCollection('seasons', 'number year state')
    .fields('id name')
    .exec();
  log('5. find("serie") -- joinCollection seasons', withSeasons);

  // -----------------------------------------------------------------------
  // 6. find() -- nested joinCollection (seasons.episodes)
  // -----------------------------------------------------------------------
  const withEpisodes = await client.find('serie')
    .where('name', 'EQ', 'Game of Thrones')
    .joinCollection('seasons', 'number year')
    .joinCollection('seasons.episodes', 'number name')
    .fields('id name')
    .page(1, 1)
    .exec();
  log('6. find("serie") -- nested joinCollection seasons.episodes (page 1, size 1)', withEpisodes);

  // -----------------------------------------------------------------------
  // 7. find() -- where collection filter (terms)
  // -----------------------------------------------------------------------
  const seriesWithPilot = await client.find('serie')
    .where('seasons', [
      { path: 'episodes.name', operator: 'EQ', value: 'Pilot' },
    ])
    .fields('id name')
    .exec();
  log('7. find("serie") -- where seasons.episodes.name = Pilot', seriesWithPilot);

  // -----------------------------------------------------------------------
  // 8. find() -- pagination + sort
  // -----------------------------------------------------------------------
  const sortedStars = await client.find('star')
    .sort('name', 'ASC')
    .page(1, 5)
    .fields('id name')
    .exec();
  log('8. find("star") -- sorted ASC, page 1 size 5', sortedStars);

  // -----------------------------------------------------------------------
  // 9. getById()
  // -----------------------------------------------------------------------
  if (allSeries.length > 0) {
    const serie = await client.getById('serie', allSeries[0].id,
      'id name categories');
    log('9. getById("serie") -- ' + allSeries[0].id, serie);
  }

  // -----------------------------------------------------------------------
  // 10. add() + update() + delete() -- full CRUD cycle
  // -----------------------------------------------------------------------
  const demoName = `Demo Actor ${Date.now()}`;
  log('10. CRUD cycle -- add / update / delete star', '--- Starting ---');

  const newStar = await client.add('star', { name: demoName }, 'id name');
  console.log('  Added:', newStar);

  const updated = await client.update('star', newStar.id,
    { name: demoName + ' Updated' }, 'id name');
  console.log('  Updated:', updated);

  const deleted = await client.delete('star', newStar.id, 'id name');
  console.log('  Deleted:', deleted);

  // -----------------------------------------------------------------------
  // 11. transition() -- state machine
  // -----------------------------------------------------------------------
  const scheduledSeasons = await client.find('season')
    .where('state', 'EQ', 'SCHEDULED')
    .fields('id number state')
    .page(1, 1)
    .exec();

  if (scheduledSeasons.length > 0) {
    const seasonId = scheduledSeasons[0].id;
    log('11. State machine -- activate then finalize season ' + seasonId, '');

    const activated = await client.transition('season', 'activate', seasonId, 'id number state');
    console.log('  Activated:', activated);

    const finalized = await client.transition('season', 'finalize', seasonId, 'id number state');
    console.log('  Finalized:', finalized);
  } else {
    log('11. State machine -- skipped (no SCHEDULED seasons)', '');
  }

  // -----------------------------------------------------------------------
  // 12. execute() -- raw GraphQL
  // -----------------------------------------------------------------------
  const raw = await client.execute('{ stars(pagination: { page: 1, size: 2 }) { id name } }');
  log('12. execute() -- raw GraphQL query', raw.data);

  // -----------------------------------------------------------------------
  // 13. Full builder example -- all features combined
  // -----------------------------------------------------------------------
  const full = await client.find('serie')
    .where('categories', 'EQ', 'Drama')
    .joinObject('director', 'name country')
    .joinCollection('seasons', 'number year state')
    .joinCollection('seasons.episodes', 'number name')
    .page(1, 2)
    .sort('name', 'ASC')
    .fields('id name categories')
    .exec();
  log('13. Full builder -- filters + joins + pagination + sort', full);

  // -----------------------------------------------------------------------
  // 14. aggregate() -- count seasons per serie
  // -----------------------------------------------------------------------
  const aggBasic = await client.aggregate('season')
    .groupBy('serie')
    .fact('COUNT', 'seasonCount', 'id')
    .exec();
  log('14. aggregate("season") -- count seasons per serie', aggBasic);

  // -----------------------------------------------------------------------
  // 15. aggregate() -- multiple facts
  // -----------------------------------------------------------------------
  const aggMulti = await client.aggregate('season')
    .groupBy('serie')
    .fact('COUNT', 'seasonCount', 'id')
    .fact('AVG', 'avgYear', 'year')
    .fact('MIN', 'minYear', 'year')
    .fact('MAX', 'maxYear', 'year')
    .exec();
  log('15. aggregate("season") -- COUNT + AVG + MIN + MAX year', aggMulti);

  // -----------------------------------------------------------------------
  // 16. aggregate() -- with pagination and sort
  // -----------------------------------------------------------------------
  const aggPaged = await client.aggregate('season')
    .groupBy('serie')
    .fact('COUNT', 'seasonCount', 'id')
    .page(1, 3)
    .sort('serie', 'ASC')
    .exec();
  log('16. aggregate("season") -- with page(1,3) + sort', aggPaged);

  // -----------------------------------------------------------------------
  // 17. aggregate() -- episodes with filter
  // -----------------------------------------------------------------------
  const aggFiltered = await client.aggregate('episode')
    .groupBy('season')
    .fact('COUNT', 'episodeCount', 'id')
    .page(1, 5)
    .exec();
  log('17. aggregate("episode") -- count episodes per season', aggFiltered);

  console.log('\n' + '='.repeat(60));
  console.log('Demo complete.');
  console.log('='.repeat(60));
})();
