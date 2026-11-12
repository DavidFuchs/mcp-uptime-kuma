import { defineScenario, expectThat, PREFIX } from '../scenario.js';
import { findMonitor } from '../kuma.js';

const NAME = `${PREFIX}Sensor feed`;

export default defineScenario({
  id: 'mqtt-monitor',
  description: 'MQTT monitor with credentials, expecting a message',
  tags: ['monitors', 'uncommon-types'],
  prompt:
    `Create an MQTT monitor "${NAME}" for the broker mqtt://broker.example.com on port 1883. It should watch the topic ` +
    'sensors/+/status, log in as "probe" with password "mq-Pass1", and be up only when a message contains "online".',
  async check(ctx) {
    const m = await findMonitor(ctx, NAME);
    if (!m) return [expectThat(`monitor "${NAME}" exists`, false)];
    return [
      expectThat('type is mqtt', m.type === 'mqtt', `type=${m.type}`),
      expectThat('broker host', String(m.hostname ?? '').includes('broker.example.com'), `hostname=${m.hostname}`),
      expectThat('port 1883', m.port === 1883, `port=${m.port}`),
      expectThat('topic', m.mqttTopic === 'sensors/+/status', `mqttTopic=${m.mqttTopic}`),
      expectThat('username', m.mqttUsername === 'probe', `mqttUsername=${m.mqttUsername}`),
      expectThat('password', m.mqttPassword === 'mq-Pass1', `mqttPassword=${m.mqttPassword}`),
      expectThat('keyword check', (m.mqttCheckType ?? 'keyword') === 'keyword', `mqttCheckType=${m.mqttCheckType}`),
      expectThat('expects "online"', m.mqttSuccessMessage === 'online', `mqttSuccessMessage=${m.mqttSuccessMessage}`),
    ];
  },
  budget: { maxToolCalls: 6, maxToolErrors: 1 },
});
