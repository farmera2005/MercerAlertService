import { parseArgs } from 'node:util';
import { startMockSwis } from './server';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: process.env.MOCK_SWIS_PORT ?? '17774' },
    host: { type: 'string', default: process.env.MOCK_SWIS_HOST ?? '0.0.0.0' },
    user: { type: 'string', default: process.env.MOCK_SWIS_USER ?? 'mas' },
    password: { type: 'string', default: process.env.MOCK_SWIS_PASSWORD ?? 'mas' },
    'tls-cert': { type: 'string', default: process.env.MOCK_SWIS_TLS_CERT },
    'tls-key': { type: 'string', default: process.env.MOCK_SWIS_TLS_KEY },
    'drop-field': {
      type: 'string',
      multiple: true,
      default: (process.env.MOCK_SWIS_DROP_FIELDS ?? '').split(',').filter(Boolean),
    },
    replay: { type: 'string', default: process.env.MOCK_SWIS_REPLAY_DIR },
    scenario: { type: 'string', default: process.env.MOCK_SWIS_SCENARIO },
    speed: { type: 'string', default: process.env.MOCK_SWIS_SPEED ?? '1' },
  },
});

const mock = await startMockSwis({
  port: Number(values.port),
  host: values.host,
  username: values.user,
  password: values.password,
  tlsCert: values['tls-cert'],
  tlsKey: values['tls-key'],
  dropFields: values['drop-field'],
  replayDir: values.replay,
  speed: Number(values.speed),
  log: (m) =>
    console.log(
      JSON.stringify({
        level: 'info',
        time: new Date().toISOString(),
        component: 'mock-swis',
        msg: m,
      }),
    ),
});
console.log(
  JSON.stringify({
    level: 'info',
    component: 'mock-swis',
    msg: `mock SWIS listening on ${mock.url}`,
    nodes: mock.world.nodes.length,
    interfaces: mock.world.interfaces.length,
    activeAlerts: mock.world.alertActive.length,
    controlApi: `${mock.url}/__mock/state`,
  }),
);
if (values.scenario) mock.runScenario(values.scenario);

const stop = async () => {
  await mock.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
